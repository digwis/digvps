import fs from "node:fs"
import path from "node:path"
import type { ProjectActionKind } from "../../shared/projects"

type ActionState = {
  at: string
  marker?: string
}

type StoredProjectState = {
  actions?: Partial<Record<ProjectActionKind, string | ActionState>>
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

