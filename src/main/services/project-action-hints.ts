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

async function scanDirLatest(dirPath: string, options?: { exclude?: Set<string>; after?: number }): Promise<DirSnapshot> {
  try {
    await fs.promises.access(dirPath)
  } catch {
    return { latestIso: null, hasFiles: false }
  }

  let latest = 0
  let hasFiles = false

  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (options?.exclude?.has(entry.name)) {
          continue
        }
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      hasFiles = true
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(fullPath)
      } catch {
        continue
      }
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

  await walk(dirPath)
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

  const git = await getGitDirtySnapshot(project.localPath)
  const codeLocal = git ?? await scanDirLatest(project.localPath, { exclude: CODE_EXCLUDE_DIRS })
  const currentLsn = await readLocalPostgresLsn(project.localPath)
  const uploadsDir = (await fs.promises.access(path.join(project.localPath, "storage", "uploads")).then(() => true).catch(() => false))
    ? path.join(project.localPath, "storage", "uploads")
    : path.join(project.localPath, "uploads")
  const uploadsLocal = await scanDirLatest(uploadsDir)

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
      missingReason: "未检测到上传文件目录",
      changedReason: "检测到上传文件有新增或修改",
    }),
  ]

  return {
    projectId: project.id,
    checkedAt: new Date().toISOString(),
    hints,
  }
}
