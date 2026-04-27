import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { ProjectOperationLogEntry } from "../../shared/projects"

const MAX_LOG_LINES = 5000
const DEFAULT_LIST_LIMIT = 300

let logFilePath = ""

export function initializeProjectOperationLog(userDataPath: string) {
  logFilePath = path.join(userDataPath, "project-operation-log.ndjson")
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, "", "utf-8")
  }
}

function parseLines(raw: string): ProjectOperationLogEntry[] {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
  const items: ProjectOperationLogEntry[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ProjectOperationLogEntry
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.projectId === "string" &&
        typeof parsed.stream === "string" &&
        typeof parsed.chunk === "string" &&
        typeof parsed.at === "string"
      ) {
        items.push(parsed)
      }
    } catch {
      // skip bad lines
    }
  }
  return items
}

function readAll(): ProjectOperationLogEntry[] {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return []
  }
  try {
    const raw = fs.readFileSync(logFilePath, "utf-8")
    return parseLines(raw)
  } catch {
    return []
  }
}

function rewriteAll(items: ProjectOperationLogEntry[]) {
  if (!logFilePath) {
    return
  }
  const content = items.map((item) => JSON.stringify(item)).join("\n")
  fs.writeFileSync(logFilePath, content ? `${content}\n` : "", "utf-8")
}

export function appendOperationLog(input: Omit<ProjectOperationLogEntry, "id" | "at"> & { at?: string }) {
  const entry: ProjectOperationLogEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    stream: input.stream,
    chunk: input.chunk,
    at: input.at ?? new Date().toISOString(),
  }
  const all = readAll()
  all.push(entry)
  const trimmed = all.length > MAX_LOG_LINES ? all.slice(all.length - MAX_LOG_LINES) : all
  rewriteAll(trimmed)
  return entry
}

export function listOperationLogs(limit?: number): ProjectOperationLogEntry[] {
  const safeLimit = Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, 2000))
  const all = readAll()
  return all.slice(Math.max(0, all.length - safeLimit))
}
