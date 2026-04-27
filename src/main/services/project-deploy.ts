import path from "node:path"
import type { VpsConnectionInput } from "../../shared/vps"
import type { ProjectDeployResult } from "../../shared/projects"
import { runRemoteShellCommand } from "./remote-exec"
import { connectSftpClient } from "./ssh-runtime"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "target",
  ".turbo",
  ".cache",
])

function defaultUploadFilter(itemPath: string, isDirectory: boolean) {
  const base = path.basename(itemPath)
  if (DEFAULT_EXCLUDED_DIR_NAMES.has(base)) {
    return false
  }
  if (!isDirectory && base === ".DS_Store") {
    return false
  }
  return true
}

const BLOCKED_REMOTE_PREFIXES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
  "/usr/bin",
  "/usr/sbin",
  "/sbin",
  "/run/systemd",
]

/** 阻止明显系统目录与路径穿越；允许 /home、/root、/var/www 等常见部署位置 */
export function assertSaneRemoteDeployPath(remotePath: string) {
  const normalized = path.posix.normalize(remotePath.replace(/\\/g, "/"))
  if (!normalized.startsWith("/")) {
    throw new Error("远端路径必须是绝对路径")
  }
  if (normalized.includes("/../") || normalized.endsWith("/..") || normalized === "..") {
    throw new Error("远端路径不能包含 ..")
  }
  for (const prefix of BLOCKED_REMOTE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      throw new Error(`不允许部署到系统目录：${prefix}`)
    }
  }
}

export async function resolveRemoteDeployPathForProject(
  connection: VpsConnectionInput,
  projectId: string,
  remoteParentPath?: string,
): Promise<string> {
  let parent: string
  if (remoteParentPath?.trim()) {
    let raw = remoteParentPath.trim().replace(/\\/g, "/")
    if (raw.startsWith("~/")) {
      const homeResult = await runRemoteShellCommand(connection, `printf %s "$HOME"`, {
        timeoutMs: 20_000,
      })
      if (homeResult.code !== 0) {
        throw new Error(
          `无法解析远端主目录（用于展开 ~）：${homeResult.stderr || homeResult.stdout || "未知错误"}`,
        )
      }
      const home = (homeResult.stdout.trim() || "/root").replace(/\\/g, "/")
      raw = path.posix.join(home, raw.slice(2))
    }
    parent = path.posix.normalize(raw)
  } else {
    const homeResult = await runRemoteShellCommand(connection, `printf %s "$HOME"`, {
      timeoutMs: 20_000,
    })
    if (homeResult.code !== 0) {
      throw new Error(
        `无法解析远端主目录：${homeResult.stderr || homeResult.stdout || "未知错误"}`,
      )
    }
    const home = (homeResult.stdout.trim() || "/root").replace(/\\/g, "/")
    parent = path.posix.join(home, "digwis-panel-projects")
  }
  assertSaneRemoteDeployPath(parent)
  const deploy = path.posix.join(parent, projectId).replace(/\\/g, "/")
  assertSaneRemoteDeployPath(deploy)
  return deploy
}

export async function deployLocalProjectToVps(options: {
  connection: VpsConnectionInput
  localRoot: string
  remoteDeployPath: string
}): Promise<ProjectDeployResult> {
  const start = Date.now()
  const { connection, localRoot, remoteDeployPath } = options

  try {
    assertSaneRemoteDeployPath(remoteDeployPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : "远端路径无效"
    return { ok: false, message, durationMs: Date.now() - start, kind: "sftp" }
  }

  const prepare = await runRemoteShellCommand(
    connection,
    `mkdir -p ${shellSingleQuote(remoteDeployPath)} && rm -rf ${shellSingleQuote(remoteDeployPath)}/*`,
    { timeoutMs: 180_000 },
  )
  if (prepare.code !== 0) {
    return {
      ok: false,
      message: `准备远端目录失败：${prepare.stderr.slice(0, 400) || prepare.stdout}`,
      durationMs: Date.now() - start,
      kind: "sftp",
    }
  }

  const sftp = await connectSftpClient(connection, { readyTimeout: 20_000 })
  try {
    await sftp.uploadDir(localRoot, remoteDeployPath, {
      useFastput: true,
      filter: defaultUploadFilter,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "SFTP 上传失败"
    return {
      ok: false,
      message,
      durationMs: Date.now() - start,
      kind: "sftp",
    }
  } finally {
    await sftp.end().catch(() => undefined)
  }

  return {
    ok: true,
    message: "项目文件已同步到 VPS",
    remotePath: remoteDeployPath,
    durationMs: Date.now() - start,
    kind: "sftp",
  }
}
