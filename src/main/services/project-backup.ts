import path from "node:path"
import type { ProjectOperationResult } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function tailText(text: string, max = 1600) {
  const trimmed = text.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  return `…${trimmed.slice(-max)}`
}

export async function runProjectRemoteBackup(options: {
  connection: VpsConnectionInput
  projectId: string
  remoteAppDir: string
}): Promise<ProjectOperationResult> {
  const startedAt = Date.now()
  const remoteAppDir = options.remoteAppDir.replace(/\/$/, "")
  const remoteParentDir = path.posix.dirname(remoteAppDir)
  const remoteBaseName = path.posix.basename(remoteAppDir)

  const script = `
set -Eeuo pipefail

REMOTE_APP_DIR=${shellSingleQuote(remoteAppDir)}
REMOTE_PARENT_DIR=${shellSingleQuote(remoteParentDir)}
REMOTE_BASE_NAME=${shellSingleQuote(remoteBaseName)}
PROJECT_ID=${shellSingleQuote(options.projectId)}
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$REMOTE_PARENT_DIR/.digwis-panel-backups/$PROJECT_ID"
ARCHIVE_PATH="$BACKUP_ROOT/$STAMP.tar.gz"

[ -d "$REMOTE_APP_DIR" ] || { echo "远端项目目录不存在：$REMOTE_APP_DIR" >&2; exit 2; }
mkdir -p "$BACKUP_ROOT"
tar -C "$REMOTE_PARENT_DIR" -czf "$ARCHIVE_PATH" "$REMOTE_BASE_NAME"
if [ ! -f "$ARCHIVE_PATH" ]; then
  sudo -n tar -C "$REMOTE_PARENT_DIR" -czf "$ARCHIVE_PATH" "$REMOTE_BASE_NAME"
fi
echo "DIGWIS_BACKUP_OK=1"
echo "BACKUP_PATH=$ARCHIVE_PATH"
du -h "$ARCHIVE_PATH" | awk '{print "BACKUP_SIZE="$1}'
`

  const result = await runRemoteShellCommand(options.connection, script, { timeoutMs: 30 * 60 * 1000 })
  const combined = `${result.stdout}\n${result.stderr}`
  const ok = result.code === 0 && combined.includes("DIGWIS_BACKUP_OK=1")
  const backupPath = combined.match(/^BACKUP_PATH=(.*)$/m)?.[1]?.trim()
  const backupSize = combined.match(/^BACKUP_SIZE=(.*)$/m)?.[1]?.trim()
  const detail = tailText(combined.replace(/^DIGWIS_BACKUP_OK=.*$/m, "").trim())

  return {
    ok,
    durationMs: Date.now() - startedAt,
    message: ok
      ? `备份已完成${backupPath ? `：${backupPath}` : ""}${backupSize ? ` (${backupSize})` : ""}${detail ? `\n${detail}` : ""}`
      : detail || "远端备份失败",
  }
}
