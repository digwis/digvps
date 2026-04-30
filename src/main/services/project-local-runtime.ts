import fs from "node:fs"
import path from "node:path"

type ProjectLocalRuntimeState = {
  previewUrl?: string
  adminUrl?: string
  pid?: number
  logPath?: string
  updatedAt: string
}

function runtimeFilePath(projectPath: string) {
  return path.join(projectPath, ".digwis-panel", "local-runtime.json")
}

export function readProjectLocalRuntime(projectPath: string): ProjectLocalRuntimeState | null {
  const filePath = runtimeFilePath(projectPath)
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProjectLocalRuntimeState
  } catch {
    return null
  }
}

export function writeProjectLocalRuntime(projectPath: string, runtime: Omit<ProjectLocalRuntimeState, "updatedAt">) {
  const filePath = runtimeFilePath(projectPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const next: ProjectLocalRuntimeState = {
    ...runtime,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

