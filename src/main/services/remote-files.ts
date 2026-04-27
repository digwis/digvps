import type {
  RemoteFileBrowseResult,
  RemoteFileDownloadInput,
  RemoteFileMutationResult,
  RemoteFileReadResult,
  RemoteFileUploadResult,
  VpsConnectionInput,
} from "../../shared/vps"
import type { BrowserWindow } from "electron"
import {
  browseViaRemoteHelper,
  deleteViaRemoteHelper,
  disposeAllRemoteFileSessions,
  invalidatePath,
  mkdirViaRemoteHelper,
  readTextViaRemoteHelper,
  renameViaRemoteHelper,
  writeTextViaRemoteHelper,
} from "./remote-file-session-manager"
import {
  browseRemoteFilesViaSftp,
  deleteRemoteEntryViaSftp,
  downloadRemoteEntryViaSftp,
  pickAndUploadRemoteEntriesViaSftp,
  readRemoteTextFileViaSftp,
  writeRemoteTextFileViaSftp,
  renameRemoteEntryViaSftp,
  createRemoteDirectoryViaSftp as mkdirViaSftp,
} from "./remote-files-sftp-fallback"

export async function browseRemoteFiles(
  connection: VpsConnectionInput,
  requestedPath?: string,
  options?: { forceRefresh?: boolean },
): Promise<RemoteFileBrowseResult> {
  try {
    return await browseViaRemoteHelper(connection, requestedPath, options)
  } catch {
    return await browseRemoteFilesViaSftp(connection, requestedPath)
  }
}

export async function readRemoteTextFile(
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileReadResult> {
  try {
    return await readTextViaRemoteHelper(connection, remotePath)
  } catch {
    return await readRemoteTextFileViaSftp(connection, remotePath)
  }
}

export async function writeRemoteTextFile(
  connection: VpsConnectionInput,
  remotePath: string,
  content: string,
): Promise<RemoteFileMutationResult> {
  try {
    const result = await writeTextViaRemoteHelper(connection, remotePath, content)
    return result
  } catch {
    const result = await writeRemoteTextFileViaSftp(connection, remotePath, content)
    if (connection.id) {
      await invalidatePath(connection.id, result.path)
    }
    return result
  }
}

export async function createRemoteDirectory(
  connection: VpsConnectionInput,
  parentPath: string,
  directoryName: string,
): Promise<RemoteFileMutationResult> {
  try {
    return await mkdirViaRemoteHelper(connection, parentPath, directoryName)
  } catch {
    const result = await mkdirViaSftp(connection, parentPath, directoryName)
    if (connection.id) {
      await invalidatePath(connection.id, parentPath)
    }
    return result
  }
}

export async function renameRemoteEntry(
  connection: VpsConnectionInput,
  remotePath: string,
  nextName: string,
): Promise<RemoteFileMutationResult> {
  try {
    return await renameViaRemoteHelper(connection, remotePath, nextName)
  } catch {
    const result = await renameRemoteEntryViaSftp(connection, remotePath, nextName)
    if (connection.id) {
      await invalidatePath(connection.id, remotePath)
      await invalidatePath(connection.id, result.path)
    }
    return result
  }
}

export async function deleteRemoteEntry(
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileMutationResult> {
  try {
    return await deleteViaRemoteHelper(connection, remotePath)
  } catch {
    const result = await deleteRemoteEntryViaSftp(connection, remotePath)
    if (connection.id) {
      await invalidatePath(connection.id, remotePath)
    }
    return result
  }
}

export async function pickAndUploadRemoteEntries(
  window: BrowserWindow | null,
  connection: VpsConnectionInput,
  remotePath: string,
): Promise<RemoteFileUploadResult> {
  const result = await pickAndUploadRemoteEntriesViaSftp(window, connection, remotePath)
  if (connection.id && result.uploadedCount > 0) {
    await invalidatePath(connection.id, remotePath)
  }
  return result
}

export async function downloadRemoteEntry(
  window: BrowserWindow | null,
  connection: VpsConnectionInput,
  input: RemoteFileDownloadInput,
): Promise<RemoteFileMutationResult> {
  return await downloadRemoteEntryViaSftp(window, connection, input)
}

export { disposeAllRemoteFileSessions }
