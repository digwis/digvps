import fs from "node:fs"
import path from "node:path"
import type { ProjectActionKind, ProjectBackupSchedule, ProjectBackupScheduleState } from "../../shared/projects"

type ActionState = {
  at: string
  marker?: string
}

type StoredProjectState = {
  actions?: Partial<Record<ProjectActionKind, string | ActionState>>
  backup?: {
    schedule?: ProjectBackupSchedule
    nextRunAt?: string | null
    lastRunAt?: string | null
  }
}

type StoredState = {
  version: 1
  projects: Record<string, StoredProjectState>
}

let stateFilePath = ""
let cachedState: StoredState | null = null

function emptyState(): StoredState {
  return {
    version: 1,
    projects: {},
  }
}

function ensureLoaded() {
  if (cachedState) {
    return cachedState
  }
  if (!stateFilePath) {
    cachedState = emptyState()
    return cachedState
  }
  try {
    if (!fs.existsSync(stateFilePath)) {
      cachedState = emptyState()
      return cachedState
    }
    const raw = fs.readFileSync(stateFilePath, "utf-8")
    const parsed = JSON.parse(raw) as StoredState
    if (parsed && parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") {
      cachedState = parsed
      return cachedState
    }
  } catch {
    // ignore broken file and recreate
  }
  cachedState = emptyState()
  return cachedState
}

function saveState() {
  if (!stateFilePath || !cachedState) {
    return
  }
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true })
  fs.writeFileSync(stateFilePath, JSON.stringify(cachedState, null, 2), "utf-8")
}

function nextRunAt(schedule: ProjectBackupSchedule, fromIso: string): string | null {
  if (schedule === "off") {
    return null
  }
  const next = new Date(fromIso)
  if (schedule === "daily") {
    next.setDate(next.getDate() + 1)
  } else if (schedule === "weekly") {
    next.setDate(next.getDate() + 7)
  } else {
    next.setMonth(next.getMonth() + 1)
  }
  return next.toISOString()
}

function projectEntry(projectId: string): StoredProjectState {
  const state = ensureLoaded()
  if (!state.projects[projectId]) {
    state.projects[projectId] = {}
  }
  return state.projects[projectId]
}

function normalizeActionState(input?: string | ActionState | null): ActionState | null {
  if (!input) {
    return null
  }
  if (typeof input === "string") {
    return { at: input }
  }
  if (typeof input === "object" && typeof input.at === "string") {
    return { at: input.at, marker: input.marker }
  }
  return null
}

export function initializeProjectActionState(userDataPath: string) {
  stateFilePath = path.join(userDataPath, "project-action-state.json")
  ensureLoaded()
}

export function getProjectActionRunAt(projectId: string, action: ProjectActionKind): string | null {
  const entry = projectEntry(projectId)
  return normalizeActionState(entry.actions?.[action])?.at ?? null
}

export function getProjectActionMarker(projectId: string, action: ProjectActionKind): string | null {
  const entry = projectEntry(projectId)
  return normalizeActionState(entry.actions?.[action])?.marker ?? null
}

export function markProjectActionRun(
  projectId: string,
  action: ProjectActionKind,
  options?: { atIso?: string; marker?: string },
) {
  const entry = projectEntry(projectId)
  if (!entry.actions) {
    entry.actions = {}
  }
  entry.actions[action] = {
    at: options?.atIso ?? new Date().toISOString(),
    marker: options?.marker,
  }
  saveState()
}

export function getProjectBackupSchedule(projectId: string): ProjectBackupScheduleState {
  const entry = projectEntry(projectId)
  const schedule = entry.backup?.schedule ?? "off"
  return {
    projectId,
    schedule,
    nextRunAt: entry.backup?.nextRunAt ?? null,
    lastRunAt: entry.backup?.lastRunAt ?? null,
  }
}

export function setProjectBackupSchedule(projectId: string, schedule: ProjectBackupSchedule): ProjectBackupScheduleState {
  const entry = projectEntry(projectId)
  if (!entry.backup) {
    entry.backup = {}
  }
  const nowIso = new Date().toISOString()
  entry.backup.schedule = schedule
  entry.backup.nextRunAt = nextRunAt(schedule, nowIso)
  saveState()
  return getProjectBackupSchedule(projectId)
}

export function markProjectBackupRun(projectId: string, atIso?: string): ProjectBackupScheduleState {
  const entry = projectEntry(projectId)
  if (!entry.backup) {
    entry.backup = {}
  }
  const runAt = atIso ?? new Date().toISOString()
  const schedule = entry.backup.schedule ?? "off"
  entry.backup.lastRunAt = runAt
  entry.backup.nextRunAt = nextRunAt(schedule, runAt)
  saveState()
  return getProjectBackupSchedule(projectId)
}
