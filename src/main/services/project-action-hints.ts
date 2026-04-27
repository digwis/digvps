import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { LocalProjectRecord, ProjectActionHints, ProjectActionKind } from "../../shared/projects"
import { getProjectActionMarker, getProjectActionRunAt } from "./project-action-state"
import { readLocalPostgresLsn } from "./project-db-marker"

const execFileAsync = promisify(execFile)

const CODE_EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "uploads",
  "data",
  "backups",
])

type DirSnapshot = {
  latestIso: string | null
  hasFiles: boolean
}

async function getGitDirtySnapshot(projectPath: string): Promise<DirSnapshot | null> {
  try {
    await execFileAsync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], {
      timeout: 5000,
    })
  } catch {
    return null
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "status", "--porcelain", "--untracked-files=normal"],
      { timeout: 10_000 },
    )
    if (!stdout.trim()) {
      return {
        latestIso: null,
        hasFiles: false,
      }
    }
    return {
      latestIso: new Date().toISOString(),
      hasFiles: true,
    }
  } catch {
    return null
  }
}

function scanDirLatest(dirPath: string, options?: { exclude?: Set<string>; after?: number }): DirSnapshot {
  if (!fs.existsSync(dirPath)) {
    return { latestIso: null, hasFiles: false }
  }

  let latest = 0
  let hasFiles = false

  const walk = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (options?.exclude?.has(entry.name)) {
          continue
        }
        walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      hasFiles = true
      const stat = fs.statSync(fullPath)
      const m = stat.mtimeMs
      if (m > latest) {
        latest = m
      }
      if (options?.after && m > options.after) {
        latest = m
        return
      }
    }
  }

  walk(dirPath)
  return {
    latestIso: latest > 0 ? new Date(latest).toISOString() : null,
    hasFiles,
  }
}

function buildHint(args: {
  action: ProjectActionKind
  runAt: string | null
  local: DirSnapshot
  missingReason: string
  changedReason: string
}): ProjectActionHints["hints"][number] {
  const { action, runAt, local, missingReason, changedReason } = args
  if (!local.hasFiles) {
    return {
      action,
      needsAttention: false,
      reason: missingReason,
      lastRunAt: runAt,
      localChangedAt: local.latestIso,
    }
  }
  if (!runAt) {
    return {
      action,
      needsAttention: true,
      reason: "尚未执行过",
      lastRunAt: null,
      localChangedAt: local.latestIso,
    }
  }
  if (local.latestIso && new Date(local.latestIso).getTime() > new Date(runAt).getTime()) {
    return {
      action,
      needsAttention: true,
      reason: changedReason,
      lastRunAt: runAt,
      localChangedAt: local.latestIso,
    }
  }
  return {
    action,
    needsAttention: false,
    reason: "已是最新",
    lastRunAt: runAt,
    localChangedAt: local.latestIso,
  }
}

export async function inspectProjectActionHints(project: LocalProjectRecord): Promise<ProjectActionHints> {
  const codeRunAt = getProjectActionRunAt(project.id, "code")
  const dataRunAt = getProjectActionRunAt(project.id, "data")
  const dataMarker = getProjectActionMarker(project.id, "data")
  const uploadsRunAt = getProjectActionRunAt(project.id, "uploads")
  const backupRunAt = getProjectActionRunAt(project.id, "backup")

  const git = await getGitDirtySnapshot(project.localPath)
  const codeLocal = git ?? scanDirLatest(project.localPath, { exclude: CODE_EXCLUDE_DIRS })
  const currentLsn = await readLocalPostgresLsn(project.localPath)
  const uploadsLocal = scanDirLatest(path.join(project.localPath, "uploads"))

  const hints: ProjectActionHints["hints"] = [
    buildHint({
      action: "code",
      runAt: codeRunAt,
      local: codeLocal,
      missingReason: "未检测到本地代码变更",
      changedReason: "检测到本地代码更新",
    }),
    {
      action: "data",
      needsAttention: !dataRunAt || (Boolean(currentLsn) && Boolean(dataMarker) ? currentLsn !== dataMarker : false),
      reason: !dataRunAt
        ? "尚未执行过"
        : !currentLsn
          ? "无法读取本地 PG 变更状态"
          : !dataMarker
            ? "缺少上次数据同步标记"
            : currentLsn !== dataMarker
              ? "检测到本地 PG 数据有新增或修改"
              : "已是最新",
      lastRunAt: dataRunAt,
      localChangedAt: null,
    },
    buildHint({
      action: "uploads",
      runAt: uploadsRunAt,
      local: uploadsLocal,
      missingReason: "未检测到 uploads 文件",
      changedReason: "检测到 uploads 有新增或修改",
    }),
    {
      action: "backup",
      needsAttention:
        !backupRunAt || Date.now() - new Date(backupRunAt).getTime() > 7 * 24 * 60 * 60 * 1000,
      reason: backupRunAt ? "距离上次备份已超过 7 天" : "尚未执行过备份",
      lastRunAt: backupRunAt,
      localChangedAt: null,
    },
  ]

  return {
    projectId: project.id,
    checkedAt: new Date().toISOString(),
    hints,
  }
}
