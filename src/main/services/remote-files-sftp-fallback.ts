import fs from "node:fs/promises"
import path from "node:path"
import type {
  RemoteFileBrowseResult,
  RemoteFileDownloadInput,
  RemoteFileEntry,
  RemoteFileMutationResult,
  RemoteFileReadResult,
  RemoteFileType,
  RemoteFileUploadResult,
  VpsConnectionInput,
} from "../../shared/vps"
import type { BrowserWindow } from "electron"
import { dialog, type OpenDialogOptions, type SaveDialogOptions } from "electron"
import { connectSftpClient } from "./ssh-runtime"

type SftpLike = any
const DEFAULT_REMOTE_BROWSE_PATH = "/var/www"

export function toRemotePath(rawPath: string) {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"))
  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

export function joinRemotePath(parentPath: string, childName: string) {
  return toRemotePath(path.posix.join(parentPath, childName))
}

function basenameRemote(remotePath: string) {
  const normalized = toRemotePath(remotePath)
  return path.posix.basename(normalized) || "download"
}

function assertSimpleName(name: string, label: string) {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error(`${label}不能为空`)
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`${label}不能包含路径分隔符`)
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`${label}无效`)
  }
  return trimmed
}

function asIsoTime(rawValue: unknown) {
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue <= 0) {
    return undefined
  }
  const millis = rawValue > 1_000_000_000_000 ? rawValue : rawValue * 1000
  return new Date(millis).toISOString()
}

export function mapRemoteType(
  type: unknown,
  longname?: unknown,
  statLike?: {
    isDirectory?: boolean
    isSymbolicLink?: boolean
    isFile?: boolean
    mode?: number
  },
): RemoteFileType {
  if (
    statLike?.isDirectory === true ||
    type === "d" ||
    (typeof longname === "string" && longname.startsWith("d"))
  ) {
    return "directory"
  }
  if (
    statLike?.isSymbolicLink === true ||
    type === "l" ||
    (typeof longname === "string" && longname.startsWith("l"))
  ) {
    return "symlink"
  }
  if (statLike?.isFile === true) {
    return "file"
  }
  if (typeof statLike?.mode === "number") {
    const mode = statLike.mode & 0o170000
    if (mode === 0o040000) {
      return "directory"
    }
    if (mode === 0o120000) {
      return "symlink"
    }
  }
  return "file"
}

async function withSftp<T>(connection: VpsConnectionInput, callback: (sftp: SftpLike) => Promise<T>) {
  const sftp = await connectSftpClient(connection, { readyTimeout: 20_000 })
  try {
    return await callback(sftp)
  } finally {
    await sftp.end().catch(() => undefined)
  }
}

export async function resolveBrowsePath(sftp: SftpLike, requestedPath?: string) {
  if (!requestedPath?.trim()) {
    return toRemotePath(DEFAULT_REMOTE_BROWSE_PATH)
  }
  const next = requestedPath.trim()
  if (next.startsWith("/")) {
    return toRemotePath(next)
  }
  const cwd = toRemotePath(await sftp.cwd())
  return joinRemotePath(cwd, next)
}

async function getPathType(sftp: SftpLike, remotePath: string): Promise<RemoteFileType | null> {
  try {
    const stat = await sftp.stat(remotePath)
    return mapRemoteType(
      (stat as { type?: string }).type,
      (stat as { longname?: string }).longname,
      stat as {
        isDirectory?: boolean
        isSymbolicLink?: boolean
        isFile?: boolean
        mode?: number
      },
    )
  } catch {
    return null
  }
}

async function getRealRemotePath(sftp: SftpLike, remotePath: string): Promise<string | null> {
  try {
    const resolved = await sftp.realPath(remotePath)
    if (!resolved) {
      return null
    }
    const normalized = toRemotePath(String(resolved))
    return normalized === "." ? null : normalized
  } catch {
    return null
  }
}

async function resolveDirectoryPath(
  sftp: SftpLike,
  requestedPath?: string,
  options?: { allowParentFallback?: boolean },
) {
  const allowParentFallback = options?.allowParentFallback ?? false
  const initialPath = await resolveBrowsePath(sftp, requestedPath)
  const queue = [initialPath]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const candidate = toRemotePath(queue.shift()!)
    if (visited.has(candidate)) {
      continue
    }
    visited.add(candidate)

    const candidateType = await getPathType(sftp, candidate)
    if (candidateType === "directory") {
      return candidate
    }

    const realPath = await getRealRemotePath(sftp, candidate)
    if (realPath && !visited.has(realPath)) {
      const realPathType = await getPathType(sftp, realPath)
      if (realPathType === "directory") {
        return realPath
      }
      queue.push(realPath)
    }

    if (!allowParentFallback) {
      continue
    }

    const parentPath = path.posix.dirname(candidate) || "/"
    if (parentPath !== candidate && !visited.has(parentPath)) {
      queue.push(parentPath)
    }
    if (realPath) {
      const realParentPath = path.posix.dirname(realPath) || "/"
      if (realParentPath !== realPath && !visited.has(realParentPath)) {
        queue.push(realParentPath)
      }
    }
  }

  throw new Error("当前路径不是目录")
}

async function resolveBrowseTarget(
  sftp: SftpLike,
  requestedPath?: string,
): Promise<{ currentPath: string; focusedPath?: string | null; focusedType?: RemoteFileType | null }> {
  const allowParentFallback = !requestedPath?.trim()
  const initialPath = await resolveBrowsePath(sftp, requestedPath)
  const initialType = await getPathType(sftp, initialPath)

  if (!requestedPath?.trim() || initialType === "directory") {
    return {
      currentPath: await resolveDirectoryPath(sftp, requestedPath, { allowParentFallback }),
      focusedPath: null,
      focusedType: null,
    }
  }

  if (initialType === "file" || initialType === "symlink") {
    const realPath = await getRealRemotePath(sftp, initialPath)
    const realType = realPath ? await getPathType(sftp, realPath) : null

    if (realType === "directory") {
      return {
        currentPath: realPath!,
        focusedPath: null,
        focusedType: null,
      }
    }

    const focusedPath =
      realType === "file" || realType === "symlink"
        ? realPath!
        : initialPath
    const focusedType =
      realType === "file" || realType === "symlink"
        ? realType
        : initialType
    const parentPath = path.posix.dirname(focusedPath) || "/"

    return {
      currentPath: await resolveDirectoryPath(sftp, parentPath, { allowParentFallback: true }),
      focusedPath,
      focusedType,
    }
  }

  return {
    currentPath: await resolveDirectoryPath(sftp, requestedPath, { allowParentFallback }),
    focusedPath: null,
    focusedType: null,
  }
}

function buildBrowseResult(
  currentPath: string,
  entries: RemoteFileEntry[],
  rootPath: string,
  options?: { focusedPath?: string | null; focusedType?: RemoteFileType | null },
): RemoteFileBrowseResult {
  const normalized = toRemotePath(currentPath)
  return {
    currentPath: normalized,
    parentPath: normalized === "/" ? null : path.posix.dirname(normalized) || "/",
    rootPath: toRemotePath(rootPath),
    focusedPath: options?.focusedPath ? toRemotePath(options.focusedPath) : null,
    focusedType: options?.focusedType ?? null,
    transport: "sftp",
    entries,
  }
}

export async function browseRemoteFilesViaSftp(
  connection: VpsConnectionInput,
  requestedPath?: string,
): Promise<RemoteFileBrowseResult> {
  return await withSftp(connection, async (sftp) => {
    const browseTarget = await resolveBrowseTarget(sftp, requestedPath)
    const currentPath = browseTarget.currentPath

    const rawEntries = await sftp.list(currentPath)
    const entries = rawEntries
      .filter((entry: { name?: string }) => entry.name && entry.name !== "." && entry.name !== "..")
      .map((entry: { name: string; type?: string; longname?: string; size?: number; modifyTime?: number }) => ({
        name: entry.name,
        path: joinRemotePath(currentPath, entry.name),
        type: mapRemoteType(entry.type, entry.longname),
        size: Number(entry.size ?? 0),
        modifiedAt: asIsoTime(entry.modifyTime),
      }))
      .sort((left: RemoteFileEntry, right: RemoteFileEntry) => {
        if (left.type === "directory" && right.type !== "directory") {
          return -1
        }
        if (right.type === "directory" && left.type !== "directory") {
          return 1
        }
        return left.name.localeCompare(right.name, "zh-Hans-CN", { sensitivity: "base" })
      })

    const rootPath = await resolveDirectoryPath(sftp, undefined, { allowParentFallback: true })
    return buildBrowseResult(currentPath, entries, rootPath, {
      focusedPath: browseTarget.focusedPath,
      focusedType: browseTarget.focusedType,
    })
  })
}

export async function readRemoteTextFileViaSftp(
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileReadResult> {
  return await withSftp(connection, async (sftp) => {
    const resolvedPath = await resolveBrowsePath(sftp, remotePath)
    const stat = await sftp.stat(resolvedPath)
    const type = mapRemoteType(
      (stat as { type?: string }).type,
      (stat as { longname?: string }).longname,
      stat as {
        isDirectory?: boolean
        isSymbolicLink?: boolean
        isFile?: boolean
        mode?: number
      },
    )
    if (type === "directory") {
      throw new Error("目录不能直接作为文本文件打开")
    }
    const size = Number((stat as { size?: number }).size ?? 0)
    if (size > 1024 * 1024) {
      throw new Error("暂只支持打开 1 MB 以内的文本文件")
    }
    const buffer = (await sftp.get(resolvedPath)) as Buffer | string
    const content = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer)
    if (content.includes("\u0000")) {
      throw new Error("该文件看起来是二进制内容，暂不支持在面板里直接编辑")
    }
    return {
      path: resolvedPath,
      content,
      size,
      modifiedAt: asIsoTime((stat as { modifyTime?: number }).modifyTime),
    }
  })
}

export async function writeRemoteTextFileViaSftp(
  connection: VpsConnectionInput,
  remotePath: string,
  content: string,
): Promise<RemoteFileMutationResult> {
  return await withSftp(connection, async (sftp) => {
    const resolvedPath = await resolveBrowsePath(sftp, remotePath)
    const parentPath = path.posix.dirname(resolvedPath)
    const parentType = await sftp.exists(parentPath)
    if (!parentType) {
      throw new Error("目标目录不存在")
    }
    if (parentType !== "d") {
      throw new Error("目标父路径不是目录")
    }
    await sftp.put(Buffer.from(content, "utf8"), resolvedPath)
    return {
      ok: true,
      path: resolvedPath,
      message: "文件已保存",
    }
  })
}

export async function createRemoteDirectoryViaSftp(
  connection: VpsConnectionInput,
  parentPath: string,
  directoryName: string,
): Promise<RemoteFileMutationResult> {
  const name = assertSimpleName(directoryName, "目录名")
  return await withSftp(connection, async (sftp) => {
    const resolvedParent = await resolveBrowsePath(sftp, parentPath)
    const targetPath = joinRemotePath(resolvedParent, name)
    await sftp.mkdir(targetPath, false)
    return {
      ok: true,
      path: targetPath,
      message: "目录已创建",
    }
  })
}

export async function renameRemoteEntryViaSftp(
  connection: VpsConnectionInput,
  remotePath: string,
  nextName: string,
): Promise<RemoteFileMutationResult> {
  const safeName = assertSimpleName(nextName, "名称")
  return await withSftp(connection, async (sftp) => {
    const resolvedPath = await resolveBrowsePath(sftp, remotePath)
    const nextPath = joinRemotePath(path.posix.dirname(resolvedPath), safeName)
    await sftp.rename(resolvedPath, nextPath)
    return {
      ok: true,
      path: nextPath,
      message: "名称已更新",
    }
  })
}

export async function deleteRemoteEntryViaSftp(
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileMutationResult> {
  return await withSftp(connection, async (sftp) => {
    const resolvedPath = await resolveBrowsePath(sftp, remotePath)
    const stat = await sftp.stat(resolvedPath)
    const type = mapRemoteType(
      (stat as { type?: string }).type,
      (stat as { longname?: string }).longname,
      stat as {
        isDirectory?: boolean
        isSymbolicLink?: boolean
        isFile?: boolean
        mode?: number
      },
    )
    if (type === "directory") {
      await sftp.rmdir(resolvedPath, true)
    } else {
      await sftp.delete(resolvedPath)
    }
    return {
      ok: true,
      path: resolvedPath,
      message: type === "directory" ? "目录已删除" : "文件已删除",
    }
  })
}

async function askOpenPaths(window: BrowserWindow | null) {
  const options: OpenDialogOptions = {
    title: "选择要上传到服务器的文件或目录",
    properties: ["openFile", "openDirectory", "multiSelections"],
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled) {
    return []
  }
  return result.filePaths
}

export async function pickAndUploadRemoteEntriesViaSftp(
  window: BrowserWindow | null,
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileUploadResult> {
  const localPaths = await askOpenPaths(window)
  if (localPaths.length === 0) {
    return {
      ok: true,
      uploadedCount: 0,
      message: "已取消上传",
    }
  }

  return await withSftp(connection, async (sftp) => {
    const targetDirectory = await resolveBrowsePath(sftp, remotePath)
    const targetType = await sftp.exists(targetDirectory)
    if (targetType !== "d") {
      throw new Error("上传目标不是目录")
    }

    let uploadedCount = 0
    for (const localPath of localPaths) {
      const stats = await fs.stat(localPath)
      const targetPath = joinRemotePath(targetDirectory, path.basename(localPath))
      if (stats.isDirectory()) {
        await sftp.mkdir(targetPath, true)
        await sftp.uploadDir(localPath, targetPath)
      } else {
        await sftp.fastPut(localPath, targetPath)
      }
      uploadedCount += 1
    }

    return {
      ok: true,
      uploadedCount,
      message: `已上传 ${uploadedCount} 个项目`,
    }
  })
}

async function askDownloadTarget(
  window: BrowserWindow | null,
  input: RemoteFileDownloadInput,
) {
  if (input.type === "directory") {
    const options: OpenDialogOptions = {
      title: `选择 ${input.name} 的下载位置`,
      properties: ["openDirectory", "createDirectory"],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return path.join(result.filePaths[0]!, input.name)
  }

  const options: SaveDialogOptions = {
    title: `下载 ${input.name}`,
    defaultPath: input.name,
  }
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return null
  }
  return result.filePath
}

export async function downloadRemoteEntryViaSftp(
  window: BrowserWindow | null,
  connection: VpsConnectionInput,
  input: RemoteFileDownloadInput,
): Promise<RemoteFileMutationResult> {
  const localTargetPath = await askDownloadTarget(window, input)
  if (!localTargetPath) {
    return {
      ok: true,
      path: input.path,
      message: "已取消下载",
    }
  }

  return await withSftp(connection, async (sftp) => {
    const resolvedPath = await resolveBrowsePath(sftp, input.path)
    if (input.type === "directory") {
      await fs.mkdir(localTargetPath, { recursive: true })
      await sftp.downloadDir(resolvedPath, localTargetPath)
    } else {
      await sftp.fastGet(resolvedPath, localTargetPath)
    }
    return {
      ok: true,
      path: localTargetPath,
      message: `${input.type === "directory" ? "目录" : "文件"}已下载到 ${localTargetPath}`,
    }
  })
}

export function getRemoteEntryBaseName(remotePath: string) {
  return basenameRemote(remotePath)
}
