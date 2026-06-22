import { z } from "zod"
import { BrowserWindow, dialog, shell } from "../electron-shim"
import type { OpenDialogOptions } from "electron"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import {
  addLocalProjectFromPath,
  deleteLocalProject,
  getLocalProject,
  getVpsConnectionInput,
  listLocalProjects,
  updateLocalProjectPath,
  updateLocalProjectDeployResult,
} from "../services/db"
import { readProjectDeployConfig, readProjectDeployProfile } from "../services/project-deploy-profile"
import { inspectProjectRemoteState } from "../services/project-remote-state"
import { getProjectRemoteDetails, applyProjectSiteSettings } from "../services/project-remote-management"
import {
  readProjectEnvFile,
  restartProjectRemoteService,
  rotateProjectSessionSecret,
  saveProjectEnvFile,
  stopProjectRemoteService,
} from "../services/project-env"
import { initializeProjectOnVps } from "../services/project-bootstrap"
import { readPackageJsonScriptNames, runLocalNpmScript } from "../services/project-local-npm"
import { deployLocalProjectToVps, resolveRemoteDeployPathForProject } from "../services/project-deploy"
import { readLocalPostgresLsn } from "../services/project-db-marker"
import { inspectProjectActionHints } from "../services/project-action-hints"
import { scanRemoteManagedProjects } from "../services/remote-managed-projects"
import {
  closeTerminalSession,
  createTerminalSession,
  resizeTerminalSession,
  writeTerminalInput,
} from "../services/remote-terminal"
import { markProjectActionRun } from "../services/project-action-state"
import { appendOperationLog, listOperationLogs } from "../services/project-operation-log"
import { repairProjectNativeModules } from "../services/project-native-module-fix"
import { readProjectLocalRuntime, writeProjectLocalRuntime } from "../services/project-local-runtime"

import { migrateProjectBetweenServers } from "../services/project-migration"
import { createProjectScaffold, getProjectConfig, setProjectRuntimeModules } from "../services/project-scaffold"
import { buildProjectScriptEnv, resolveActionKindFromScript, resolveStoredPayload } from "./helpers"
import { registerIpcHandle } from "./ipc-error"
import {
  localProjectInputSchema,
  operationLogAppendSchema,
  operationLogsQuerySchema,
  parseOrThrow,
  projectClientAppSchema,
  projectConnectionSchema,
  projectDeleteSchema,
  projectDeploySchema,
  projectEnvUpdateSchema,
  projectIdSchema,
  projectLocalPathUpdateSchema,
  projectRuntimeModulesUpdateSchema,
  projectScaffoldSchema,
  projectMigrationSchema,
  projectRemoteDetailsSchema,
  projectSiteSettingsSchema,
  remoteManagedProjectScanSchema,
} from "./schemas"
import {
  DIRECTUS_LOCAL_ADMIN_URL,
  resolveProjectPanelAdminUrl,
} from "../../shared/projects"
import type {
  DigwisProjectConfig,
  LocalProjectInput,
  ProjectClientAppInput,
  ProjectDeleteInput,
  ProjectDeployInput,
  ProjectLocalPathUpdateInput,
  ProjectMigrationInput,
  ProjectRemoteDetailsInput,
  ProjectRuntimeModulesUpdateInput,
  ProjectScaffoldInput,
  ProjectSiteSettingsInput,
  ProjectUrlReachabilityResult,
} from "../../shared/projects"

function requireProject(projectId: string) {
  const project = getLocalProject(projectId)
  if (!project) {
    throw new Error("项目不存在或已被删除")
  }
  return project
}

function requireConnection(connectionId: string) {
  const connection = getVpsConnectionInput(connectionId)
  if (!connection) {
    throw new Error("VPS 连接不存在")
  }
  return connection
}

function readRootPackageJson(projectPath: string): {
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} | null {
  const packagePath = path.join(projectPath, "package.json")
  if (!fs.existsSync(packagePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      packageManager?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
  } catch {
    return null
  }
}

function parseLocalPortFromScripts(pkg: ReturnType<typeof readRootPackageJson>) {
  const candidates = [
    pkg?.scripts?.dev,
    pkg?.scripts?.["dev:webpack"],
    pkg?.scripts?.start,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  for (const script of candidates) {
    const match = script.match(/--port(?:=|\s+)(\d{2,5})/)
    if (match?.[1]) {
      return Number(match[1])
    }
  }
  return null
}

function inferLocalPreviewFallback(projectPath: string) {
  const pkg = readRootPackageJson(projectPath)
  const hasStandaloneNextLayout =
    fs.existsSync(path.join(projectPath, "src", "app")) ||
    fs.existsSync(path.join(projectPath, "app")) ||
    fs.existsSync(path.join(projectPath, "src", "pages")) ||
    fs.existsSync(path.join(projectPath, "pages"))
  const usesNext = Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next)
  const webPath = hasStandaloneNextLayout || usesNext ? projectPath : path.join(projectPath, "apps", "web")
  const port = parseLocalPortFromScripts(pkg) ?? 3000
  return {
    url: `http://localhost:${port}`,
    webPath,
    adminUrl: `http://localhost:${port}/admin`,
  }
}

function resolveProjectLocalPreview(projectPath: string) {
  const fallback = inferLocalPreviewFallback(projectPath)
  const contractPath = path.join(projectPath, "digwis-project.json")
  if (!fs.existsSync(contractPath)) {
    return fallback
  }
  try {
    const raw = fs.readFileSync(contractPath, "utf8")
    const parsed = JSON.parse(raw) as DigwisProjectConfig
    const previewUrl = parsed.panel?.previewUrl?.trim() || fallback.url
    const runtime = readProjectLocalRuntime(projectPath)
    const webPath = parsed.apps?.web?.path
      ? path.join(projectPath, parsed.apps.web.path)
      : fallback.webPath
    const contractAdminUrl = resolveProjectPanelAdminUrl(
      parsed,
      runtime?.adminUrl?.trim() || parsed.panel?.adminUrl?.trim() || fallback.adminUrl,
    )
    return {
      url: runtime?.previewUrl?.trim() || previewUrl,
      webPath,
      adminUrl: contractAdminUrl,
    }
  } catch {
    return fallback
  }
}

function checkUrlReachable(url: string, redirectCount = 0): Promise<ProjectUrlReachabilityResult> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (error) {
      resolve({
        ok: false,
        detail: error instanceof Error ? error.message : "invalid url",
      })
      return
    }

    const transport = parsed.protocol === "https:" ? https : http
    const request = transport.request(
      parsed,
      {
        method: "GET",
        timeout: 2500,
        headers: {
          "user-agent": "CloudRoost/1.0",
          accept: "*/*",
        },
      },
      (response) => {
        response.resume()
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (location && status >= 300 && status < 400 && redirectCount < 3) {
          const nextUrl = new URL(location, parsed).toString()
          resolve(checkUrlReachable(nextUrl, redirectCount + 1))
          return
        }
        resolve({
          ok: status >= 200 && status < 400,
          detail: `HTTP ${status}`,
          status,
          finalUrl: parsed.toString(),
        })
      },
    )

    request.on("timeout", () => {
      request.destroy(new Error("timeout"))
    })
    request.on("error", (error) => {
      resolve({
        ok: false,
        detail: error.message,
        finalUrl: parsed.toString(),
      })
    })
    request.end()
  })
}

function resolveProjectClientApp(projectPath: string, target: ProjectClientAppInput["target"]) {
  const contract = getProjectConfig(projectPath)
  if (!contract) {
    throw new Error("项目缺少 digwis-project.json，暂时无法解析客户端目录")
  }
  const app =
    target === "electron"
      ? contract.apps.desktop
      : target === "ios-native"
        ? contract.apps.mobileIos
        : contract.apps.mobileAndroid
  if (!app?.path) {
    throw new Error("当前项目没有启用这个客户端目标")
  }
  return {
    app,
    absolutePath: path.join(projectPath, app.path),
  }
}

function envWithExtraPath(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return process.env
  }
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
  const existing = (process.env.PATH ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean)
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [...extra, ...existing]) {
    if (!seen.has(entry)) {
      seen.add(entry)
      merged.push(entry)
    }
  }
  return { ...process.env, PATH: merged.join(":") }
}

function resolveDetachedDevCommand(projectPath: string) {
  const contractPath = path.join(projectPath, "digwis-project.json")
  if (fs.existsSync(contractPath)) {
    try {
      const raw = fs.readFileSync(contractPath, "utf8")
      const parsed = JSON.parse(raw) as DigwisProjectConfig
      if (parsed.projectType === "next-platform") {
        return "npm run dev"
      }
    } catch {
      // ignore and fall back to the generic dev command
    }
  }
  const pkg = readRootPackageJson(projectPath)
  if (pkg?.packageManager?.startsWith("bun@")) {
    return "bun run dev"
  }
  return "npm run dev"
}

function startLocalDevDetached(projectPath: string, webPath: string) {
  const runtimeDir = path.join(projectPath, ".digwis-panel")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const logPath = path.join(runtimeDir, "local-dev.log")
  const logFd = fs.openSync(logPath, "a")
  const devCommand = resolveDetachedDevCommand(projectPath)
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", devCommand], {
          cwd: webPath,
          detached: true,
          env: envWithExtraPath(),
          stdio: ["ignore", logFd, logFd],
        })
      : spawn("/bin/bash", ["-lc", `cd "${webPath.replace(/"/g, '\\"')}" && ${devCommand}`], {
          env: envWithExtraPath(),
          detached: true,
          stdio: ["ignore", logFd, logFd],
        })
  fs.closeSync(logFd)
  child.unref()
  return {
    pid: child.pid ?? undefined,
    logPath,
  }
}

function resolveAdminUrlFromPreview(previewUrl: string, fallbackAdminUrl?: string) {
  if (!fallbackAdminUrl) {
    return `${previewUrl.replace(/\/$/, "")}/admin`
  }
  try {
    const preview = new URL(previewUrl)
    const admin = new URL(fallbackAdminUrl)
    if (admin.port === "8055") {
      return fallbackAdminUrl
    }
    admin.protocol = preview.protocol
    admin.hostname = preview.hostname
    admin.port = preview.port
    return admin.toString().replace(/\/$/, "")
  } catch {
    return fallbackAdminUrl
  }
}

function stopLocalRuntimeIfPresent(projectPath: string) {
  const runtime = readProjectLocalRuntime(projectPath)
  const pid = runtime?.pid
  if (!pid || pid <= 0) {
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // ignore stale pid or already exited process
    }
  }
}

function removeLocalDirectoryStrict(localPath: string) {
  if (!fs.existsSync(localPath)) {
    return false
  }

  try {
    fs.rmSync(localPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    if (process.platform !== "win32") {
      try {
        execFileSync("/bin/rm", ["-rf", localPath], {
          stdio: "ignore",
        })
      } catch {
        throw error
      }
    } else {
      throw error
    }
  }

  if (fs.existsSync(localPath)) {
    throw new Error(`本地目录删除失败，目录仍然存在：${localPath}`)
  }

  return true
}

async function waitForPreviewUrlFromLog(logPath: string, timeoutMs: number) {
  const startedAt = Date.now()
  const patterns = [
    /Local:\s+(http:\/\/localhost:\d+)/i,
    /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/i,
    /Local:\s+(http:\/\/\[::1\]:\d+)/i,
    /Local:\s+(http:\/\/0\.0\.0\.0:\d+)/i,
  ]
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf8")
      for (const pattern of patterns) {
        const match = raw.match(pattern)
        if (match?.[1]) {
          return match[1]
            .replace("http://[::1]:", "http://localhost:")
            .replace("http://0.0.0.0:", "http://localhost:")
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return null
}

function ensureDirectusDatabase(envPath: string) {
  if (!fs.existsSync(envPath)) {
    return
  }
  const content = fs.readFileSync(envPath, "utf8")
  const dbClient = content.match(/^DB_CLIENT=(.+)$/m)?.[1]?.trim()
  if (dbClient !== "pg") {
    return
  }
  const connectionString = content.match(/^DB_CONNECTION_STRING=(.+)$/m)?.[1]?.trim()
  if (!connectionString) {
    return
  }
  try {
    const normalized = connectionString.replace(/^postgres(ql)?:/, "postgres:")
    const url = new URL(normalized)
    const dbName = url.pathname.replace(/^\//, "")
    if (!dbName) {
      return
    }
    execFileSync(
      "createdb",
      ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), dbName],
      {
        env: {
          ...process.env,
          ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
        },
        stdio: "ignore",
      },
    )
  } catch {
    // database may already exist or createdb is unavailable
  }
}

function bootstrapDirectusIfNeeded(directusSidecarDir: string) {
  const envPath = path.join(directusSidecarDir, ".env")
  if (!fs.existsSync(envPath)) {
    return
  }
  try {
    execFileSync("/bin/bash", ["-lc", "npx directus bootstrap"], {
      cwd: directusSidecarDir,
      env: {
        ...envWithExtraPath(),
        NAPI_RS_FORCE_WASI: "1",
      },
      stdio: "ignore",
      timeout: 120_000,
    })
  } catch {
    // bootstrap is only required on first run; ignore if tables already exist
  }
}

function runInProjectDetached(projectPath: string, command: string, options?: { logName?: string }) {
  const env = envWithExtraPath()
  if (command.includes("directus")) {
    env.NAPI_RS_FORCE_WASI = "1"
  }
  let stdio: "ignore" | ["ignore", number, number] = "ignore"
  if (options?.logName) {
    const runtimeDir = path.join(projectPath, ".digwis-panel")
    fs.mkdirSync(runtimeDir, { recursive: true })
    const logPath = path.join(runtimeDir, options.logName)
    const logFd = fs.openSync(logPath, "a")
    stdio = ["ignore", logFd, logFd]
  }
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", command], {
          cwd: projectPath,
          detached: true,
          env,
          stdio,
        })
      : spawn("/bin/bash", ["-lc", `cd "${projectPath.replace(/"/g, '\\"')}" && ${command}`], {
          detached: true,
          env,
          stdio,
        })
  child.unref()
  return child.pid ?? undefined
}

function startClientAppDetached(projectPath: string, target: ProjectClientAppInput["target"], cwd: string, command: string) {
  const runtimeDir = path.join(projectPath, ".digwis-panel")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const suffix = target === "electron" ? "desktop" : target === "ios-native" ? "ios" : "android"
  const logPath = path.join(runtimeDir, `${suffix}.log`)
  const logFd = fs.openSync(logPath, "a")
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", command], {
          cwd,
          detached: true,
          env: envWithExtraPath(),
          stdio: ["ignore", logFd, logFd],
        })
      : spawn("/bin/bash", ["-lc", `cd "${cwd.replace(/"/g, '\\"')}" && ${command}`], {
          cwd,
          detached: true,
          env: envWithExtraPath(),
          stdio: ["ignore", logFd, logFd],
        })
  fs.closeSync(logFd)
  child.unref()
  return {
    pid: child.pid ?? undefined,
    logPath,
  }
}

function findIosIdePath(clientRoot: string) {
  const entries = fs.readdirSync(clientRoot, { withFileTypes: true })
  const workspace = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"))
  if (workspace) {
    return path.join(clientRoot, workspace.name)
  }
  const project = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"))
  if (project) {
    return path.join(clientRoot, project.name)
  }
  return clientRoot
}

function ensureIosIdeProject(clientRoot: string) {
  const existing = findIosIdePath(clientRoot)
  if (existing !== clientRoot) {
    return existing
  }
  const projectYml = path.join(clientRoot, "project.yml")
  if (!fs.existsSync(projectYml)) {
    return clientRoot
  }
  try {
    execFileSync("/usr/bin/env", ["xcodegen", "generate"], {
      cwd: clientRoot,
      stdio: "ignore",
      env: envWithExtraPath(),
    })
  } catch {
    throw new Error("未检测到可用的 xcodegen。请先安装 xcodegen，或手动在 Xcode 中创建工程。")
  }
  return findIosIdePath(clientRoot)
}

async function openPathInApplication(application: "Xcode" | "Android Studio", targetPath: string) {
  if (process.platform !== "darwin") {
    throw new Error(`${application} 一键打开目前只支持 macOS`)
  }
  return await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", application, targetPath], {
      detached: true,
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

const connectionIdSchemaSafe = z.string().trim().min(1, "connectionId不能为空")
const terminalCreateSchema = z.object({
  connectionId: connectionIdSchemaSafe,
})
const terminalWriteSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId不能为空"),
  data: z.string(),
})
const terminalResizeSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId不能为空"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})
const terminalCloseSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId不能为空"),
})

export function registerProjectHandlers() {
  registerIpcHandle("projects:list", async () => {
    return listLocalProjects()
  })

  registerIpcHandle("projects:add", async (_event, payload: LocalProjectInput) => {
    return addLocalProjectFromPath(parseOrThrow(localProjectInputSchema, payload))
  })

  registerIpcHandle("projects:create-scaffold", async (_event, payload: ProjectScaffoldInput) => {
    const parsed = parseOrThrow(projectScaffoldSchema, payload)
    return createProjectScaffold(parsed, {
      onProgress: (progress) => {
        _event.sender.send("projects:scaffold-progress", progress)
      },
    })
  })

  registerIpcHandle("projects:scan-remote", async (_event, payload: unknown) => {
    const parsed = parseOrThrow(remoteManagedProjectScanSchema, payload)
    const connection = requireConnection(parsed.connectionId)
    return scanRemoteManagedProjects(resolveStoredPayload(connection))
  })

  registerIpcHandle("terminal:create", async (event, payload: unknown) => {
    const parsed = parseOrThrow(terminalCreateSchema, payload)
    const connection = requireConnection(parsed.connectionId)
    return createTerminalSession(resolveStoredPayload(connection), event.sender)
  })

  registerIpcHandle("terminal:write", async (_event, payload: unknown) => {
    const parsed = parseOrThrow(terminalWriteSchema, payload)
    return writeTerminalInput(parsed)
  })

  registerIpcHandle("terminal:resize", async (_event, payload: unknown) => {
    const parsed = parseOrThrow(terminalResizeSchema, payload)
    return resizeTerminalSession(parsed)
  })

  registerIpcHandle("terminal:close", async (_event, payload: unknown) => {
    const parsed = parseOrThrow(terminalCloseSchema, payload)
    return closeTerminalSession(parsed)
  })

  registerIpcHandle("projects:get-config", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    return getProjectConfig(project.localPath)
  })

  registerIpcHandle("projects:set-runtime-modules", async (_event, payload: ProjectRuntimeModulesUpdateInput) => {
    const parsed = parseOrThrow(projectRuntimeModulesUpdateSchema, payload)
    const project = requireProject(parsed.projectId)
    return setProjectRuntimeModules(project.localPath, parsed.runtimeModules)
  })

  registerIpcHandle("projects:update-local-path", async (_event, payload: ProjectLocalPathUpdateInput) => {
    return updateLocalProjectPath(parseOrThrow(projectLocalPathUpdateSchema, payload))
  })

  registerIpcHandle("projects:delete", async (_event, payload: ProjectDeleteInput) => {
    const parsed = parseOrThrow(projectDeleteSchema, payload)
    const project = requireProject(parsed.projectId)
    const localPath = project.localPath
    let removedLocalDirectory = false
    if (parsed.removeLocalDirectory) {
      stopLocalRuntimeIfPresent(localPath)
      removedLocalDirectory = removeLocalDirectoryStrict(localPath)
    }
    deleteLocalProject(parsed.projectId)
    return {
      success: true as const,
      removedLocalDirectory,
      localPath,
    }
  })

  registerIpcHandle("projects:list-npm-scripts", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = getLocalProject(projectId)
    if (!project) {
      return []
    }
    return readPackageJsonScriptNames(project.localPath)
  })

  registerIpcHandle("projects:get-local-preview", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    return resolveProjectLocalPreview(project.localPath)
  })

  registerIpcHandle("projects:open-local-preview", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    const preview = resolveProjectLocalPreview(project.localPath)
    await shell.openExternal(preview.url)
    return preview
  })

  registerIpcHandle("projects:open-local-admin", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    const preview = resolveProjectLocalPreview(project.localPath)
    await shell.openExternal(preview.adminUrl || `${preview.url.replace(/\/$/, "")}/admin`)
    return preview
  })

  registerIpcHandle("projects:start-local-dev", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    const preview = resolveProjectLocalPreview(project.localPath)
    if (!fs.existsSync(preview.webPath)) {
      throw new Error(`本地 Web 目录不存在：${preview.webPath}`)
    }
    repairProjectNativeModules(project.localPath)
    const started = startLocalDevDetached(project.localPath, preview.webPath)
    const detectedPreviewUrl = await waitForPreviewUrlFromLog(started.logPath, 20_000)
    const nextPreviewUrl = detectedPreviewUrl || preview.url
    const nextAdminUrl = resolveAdminUrlFromPreview(nextPreviewUrl, preview.adminUrl)
    writeProjectLocalRuntime(project.localPath, {
      previewUrl: nextPreviewUrl,
      adminUrl: nextAdminUrl,
      pid: started.pid,
      logPath: started.logPath,
    })
    return {
      ok: true,
      message: "已在后台启动本地开发服务",
      pid: started.pid,
      previewUrl: nextPreviewUrl,
    }
  })

  registerIpcHandle("projects:start-local-admin-service", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    const preview = resolveProjectLocalPreview(project.localPath)
    const adminUrl = preview.adminUrl || DIRECTUS_LOCAL_ADMIN_URL
    const directusCompose = path.join(project.localPath, "services", "directus", "docker-compose.yml")
    const directusSidecarDir = path.join(project.localPath, "services", "directus")
    const directusPackage = path.join(directusSidecarDir, "package.json")
    const rootPackage = path.join(project.localPath, "package.json")

    if (fs.existsSync(directusCompose)) {
      runInProjectDetached(project.localPath, "npm run directus:up")
      return {
        ok: true,
        message: "已在后台启动 CMS 管理服务（Docker）",
        adminUrl,
      }
    }

    if (!fs.existsSync(directusPackage)) {
      return {
        ok: true,
        message: "当前项目没有独立 CMS sidecar，跳过后台管理服务启动。",
        adminUrl,
      }
    }

    repairProjectNativeModules(project.localPath)

    const envPath = path.join(directusSidecarDir, ".env")
    const envExample = path.join(directusSidecarDir, ".env.example")
    if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
      fs.copyFileSync(envExample, envPath)
    }
    ensureDirectusDatabase(envPath)
    bootstrapDirectusIfNeeded(directusSidecarDir)

    let startCommand = "npm run directus:dev"
    if (fs.existsSync(rootPackage)) {
      try {
        const rootScripts = (JSON.parse(fs.readFileSync(rootPackage, "utf8")) as { scripts?: Record<string, string> })
          .scripts
        if (rootScripts?.["directus:dev"]) {
          startCommand = "npm run directus:dev"
        } else if (rootScripts?.["directus:start"]) {
          startCommand = "npm run directus:start"
        }
      } catch {
        // keep default
      }
    } else {
      startCommand = "npm run dev"
    }

    runInProjectDetached(project.localPath, startCommand, { logName: "directus.log" })
    return {
      ok: true,
      message: "已在后台启动 Directus 开发服务",
      adminUrl,
    }
  })

  registerIpcHandle("projects:check-url-reachable", async (_event, url: string) => {
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new Error("URL 不能为空")
    }
    return checkUrlReachable(url.trim())
  })

  registerIpcHandle("projects:open-client-app-path", async (_event, payload: ProjectClientAppInput) => {
    const parsed = parseOrThrow(projectClientAppSchema, payload)
    const project = requireProject(parsed.projectId)
    const resolved = resolveProjectClientApp(project.localPath, parsed.target)
    if (!fs.existsSync(resolved.absolutePath)) {
      throw new Error(`客户端目录不存在：${resolved.absolutePath}`)
    }
    const openResult = await shell.openPath(resolved.absolutePath)
    if (openResult) {
      throw new Error(openResult)
    }
    return {
      ok: true as const,
      target: parsed.target,
      path: resolved.absolutePath,
    }
  })

  registerIpcHandle("projects:start-client-app", async (_event, payload: ProjectClientAppInput) => {
    const parsed = parseOrThrow(projectClientAppSchema, payload)
    const project = requireProject(parsed.projectId)
    const resolved = resolveProjectClientApp(project.localPath, parsed.target)
    if (!fs.existsSync(resolved.absolutePath)) {
      throw new Error(`客户端目录不存在：${resolved.absolutePath}`)
    }
    if (!resolved.app.devCommand?.trim()) {
      throw new Error("当前客户端骨架没有可直接启动的 dev 命令")
    }
    const started = startClientAppDetached(project.localPath, parsed.target, resolved.absolutePath, resolved.app.devCommand)
    return {
      ok: true as const,
      message: "已在后台启动客户端",
      target: parsed.target,
      path: resolved.absolutePath,
      pid: started.pid,
    }
  })

  registerIpcHandle("projects:open-client-app-ide", async (_event, payload: ProjectClientAppInput) => {
    const parsed = parseOrThrow(projectClientAppSchema, payload)
    const project = requireProject(parsed.projectId)
    const resolved = resolveProjectClientApp(project.localPath, parsed.target)
    if (!fs.existsSync(resolved.absolutePath)) {
      throw new Error(`客户端目录不存在：${resolved.absolutePath}`)
    }
    if (parsed.target === "electron") {
      throw new Error("Electron 客户端没有专用原生 IDE，请直接使用启动或打开目录。")
    }
    const application = parsed.target === "ios-native" ? "Xcode" : "Android Studio"
    const ideTargetPath = parsed.target === "ios-native" ? ensureIosIdeProject(resolved.absolutePath) : resolved.absolutePath
    await openPathInApplication(application, ideTargetPath)
    return {
      ok: true as const,
      target: parsed.target,
      path: ideTargetPath,
      application,
    }
  })

  registerIpcHandle("projects:get-deploy-profile", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = getLocalProject(projectId)
    if (!project) {
      return {
        npmScripts: [],
        recommendedStrategy: "sftp" as const,
        canInitialize: false,
        configPath: null,
        configError: "项目不存在或已被删除",
      }
    }
    return readProjectDeployProfile(project.localPath)
  })

  registerIpcHandle("projects:get-remote-state", async (_event, payload: { projectId: string; connectionId: string }) => {
    payload = parseOrThrow(projectConnectionSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    if (!config) {
      throw new Error("项目缺少 cloudroost.deploy.json")
    }
    return await inspectProjectRemoteState({
      connection: resolveStoredPayload(connection),
      config,
    })
  })

  registerIpcHandle("projects:get-remote-details", async (_event, payload: ProjectRemoteDetailsInput) => {
    payload = parseOrThrow(projectRemoteDetailsSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = project.lastRemotePath || config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录")
    }
    return await getProjectRemoteDetails(
      {
        projectId: project.id,
        connection: resolveStoredPayload(connection),
        remoteAppDir,
        remoteService: config?.deploy?.remoteService?.trim() || undefined,
        browsePath: payload.browsePath,
      },
      { forceRefresh: payload.forceRefresh },
    )
  })

  registerIpcHandle("projects:get-env", async (_event, payload: { projectId: string; connectionId: string }) => {
    payload = parseOrThrow(projectConnectionSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir")
    }
    return await readProjectEnvFile(resolveStoredPayload(connection), remoteAppDir)
  })

  registerIpcHandle(
    "projects:save-env",
    async (_event, payload: { projectId: string; connectionId: string; content: string }) => {
      payload = parseOrThrow(projectEnvUpdateSchema, payload)
      const project = requireProject(payload.projectId)
      const connection = requireConnection(payload.connectionId)
      const config = readProjectDeployConfig(project.localPath)
      const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
      if (!remoteAppDir) {
        throw new Error("项目未配置 deploy.remoteAppDir")
      }
      return await saveProjectEnvFile(resolveStoredPayload(connection), remoteAppDir, payload.content)
    },
  )

  registerIpcHandle("projects:rotate-secret", async (_event, payload: { projectId: string; connectionId: string }) => {
    payload = parseOrThrow(projectConnectionSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir")
    }
    return await rotateProjectSessionSecret(resolveStoredPayload(connection), remoteAppDir)
  })

  registerIpcHandle(
    "projects:restart-service",
    async (_event, payload: { projectId: string; connectionId: string }) => {
      payload = parseOrThrow(projectConnectionSchema, payload)
      const project = requireProject(payload.projectId)
      const connection = requireConnection(payload.connectionId)
      const config = readProjectDeployConfig(project.localPath)
      const remoteService = config?.deploy?.remoteService?.trim()
      if (!remoteService) {
        throw new Error("项目未配置 deploy.remoteService")
      }
      return await restartProjectRemoteService(resolveStoredPayload(connection), remoteService)
    },
  )

  registerIpcHandle(
    "projects:stop-service",
    async (_event, payload: { projectId: string; connectionId: string }) => {
      payload = parseOrThrow(projectConnectionSchema, payload)
      const project = requireProject(payload.projectId)
      const connection = requireConnection(payload.connectionId)
      const config = readProjectDeployConfig(project.localPath)
      const remoteService = config?.deploy?.remoteService?.trim()
      if (!remoteService) {
        throw new Error("项目未配置 deploy.remoteService")
      }
      return await stopProjectRemoteService(resolveStoredPayload(connection), remoteService)
    },
  )

  registerIpcHandle("projects:save-site-settings", async (_event, payload: ProjectSiteSettingsInput) => {
    payload = parseOrThrow(projectSiteSettingsSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = project.lastRemotePath || config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录")
    }
    const details = await getProjectRemoteDetails(
      {
        projectId: project.id,
        connection: resolveStoredPayload(connection),
        remoteAppDir,
        remoteService: config?.deploy?.remoteService?.trim() || undefined,
      },
      { forceRefresh: true },
    )
    return await applyProjectSiteSettings({
      projectId: project.id,
      connection: resolveStoredPayload(connection),
      remoteAppDir,
      appPort: details.appPort,
      domain: payload.domain,
      sslEmail: payload.sslEmail,
    })
  })

  registerIpcHandle("projects:initialize", async (_event, payload: { projectId: string; connectionId: string }) => {
    payload = parseOrThrow(projectConnectionSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    if (!config?.init) {
      throw new Error("该项目未配置远端初始化模板（缺少 cloudroost.deploy.json 中的 init 段）")
    }

    appendOperationLog({
      projectId: project.id,
      stream: "system",
      chunk: "[start] initialize remote project\n",
    })
    const result = await initializeProjectOnVps({
      connection: resolveStoredPayload(connection),
      config,
    })
    appendOperationLog({
      projectId: project.id,
      stream: result.ok ? "system" : "stderr",
      chunk: `[finish] initialize ${result.ok ? "success" : "failed"} (${Math.round(result.durationMs / 1000)}s)\n${result.message}\n`,
    })
    updateLocalProjectDeployResult(project.id, {
      connectionId: connection.id!,
      remotePath: result.remotePath,
      status: result.ok ? "success" : "failed",
      message: result.message,
      deployKind: "local-npm-script",
    })
    return result
  })

  registerIpcHandle("projects:pick-directory", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title: "选择本地项目根目录",
    }
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0] ?? null
  })

  registerIpcHandle("projects:deploy", async (event, payload: ProjectDeployInput) => {
    payload = parseOrThrow(projectDeploySchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const strategy = payload.strategy ?? "sftp"
    const pushDeployLog = (entry: { script?: string; stream: "stdout" | "stderr" | "system"; chunk: string }) => {
      const payload = {
        projectId: project.id,
        script: entry.script,
        stream: entry.stream,
        chunk: entry.chunk,
        at: new Date().toISOString(),
      }
      appendOperationLog({
        projectId: payload.projectId,
        stream: payload.stream,
        chunk: payload.chunk,
        at: payload.at,
      })
      event.sender.send("projects:deploy-log", payload)
    }

    if (strategy === "local-npm-script") {
      const profile = readProjectDeployProfile(project.localPath)
      const config = readProjectDeployConfig(project.localPath)
      const script = payload.npmScript?.trim() || profile.recommendedNpmScript?.trim()
      if (!script) {
        throw new Error("请选择要运行的 npm 脚本")
      }
      pushDeployLog({
        script,
        stream: "system",
        chunk: `[start] npm run ${script}\n`,
      })
      const result = await runLocalNpmScript(project.localPath, script, {
        timeoutMs:
          script === "sync:vps:uploads" || script === "sync:uploads:vps" ? 3 * 60 * 60 * 1000 : undefined,
        onOutput: (chunk, stream) => {
          pushDeployLog({ script, stream, chunk })
        },
        env: buildProjectScriptEnv({
          projectId: project.id,
          projectPath: project.localPath,
          connection: resolveStoredPayload(connection),
          configRemoteAppDir: config?.deploy?.remoteAppDir?.trim() || undefined,
          configRemoteService: config?.deploy?.remoteService?.trim() || undefined,
          configPublicCheckUrl: config?.deploy?.publicCheckUrl?.trim() || undefined,
          configEnv: config?.deploy?.env,
        }),
      })
      pushDeployLog({
        script,
        stream: "system",
        chunk: `[finish] ${result.ok ? "success" : "failed"} (${Math.round(result.durationMs / 1000)}s)\n`,
      })
      if (result.ok) {
        const action = resolveActionKindFromScript(script)
        if (action === "data") {
          const marker = await readLocalPostgresLsn(project.localPath)
          markProjectActionRun(project.id, action, { marker: marker ?? undefined })
        } else if (action) {
          markProjectActionRun(project.id, action)
        }
      }
      updateLocalProjectDeployResult(project.id, {
        connectionId: connection.id!,
        remotePath: result.remotePath ?? (config?.deploy?.remoteAppDir?.trim() || undefined),
        status: result.ok ? "success" : "failed",
        message: result.message,
        deployKind: "local-npm-script",
      })
      return result
    }

    const resolved = resolveStoredPayload(connection)
    let remoteDeployPath = ""
    try {
      remoteDeployPath = await resolveRemoteDeployPathForProject(
        resolved,
        project.id,
        payload.remoteParentPath,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法确定远端部署路径"
      updateLocalProjectDeployResult(project.id, {
        connectionId: connection.id!,
        remotePath: undefined,
        status: "failed",
        message,
        deployKind: "sftp",
      })
      return { ok: false as const, message, durationMs: 0, kind: "sftp" as const }
    }
    const result = await deployLocalProjectToVps({
      connection: resolved,
      localRoot: project.localPath,
      remoteDeployPath,
    })
    updateLocalProjectDeployResult(project.id, {
      connectionId: connection.id!,
      remotePath: result.remotePath,
      status: result.ok ? "success" : "failed",
      message: result.message,
      deployKind: "sftp",
    })
    if (result.ok) {
      markProjectActionRun(project.id, "code")
    }
    return result
  })

  registerIpcHandle("projects:get-action-hints", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    return await inspectProjectActionHints(project)
  })

  registerIpcHandle("projects:migrate", async (_event, payload: ProjectMigrationInput) => {
    payload = parseOrThrow(projectMigrationSchema, payload)
    if (payload.sourceConnectionId === payload.targetConnectionId) {
      throw new Error("迁移目标必须是另一台服务器")
    }
    const project = requireProject(payload.projectId)
    const sourceConnection = requireConnection(payload.sourceConnectionId)
    const targetConnection = requireConnection(payload.targetConnectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = project.lastRemotePath || config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录")
    }
    appendOperationLog({
      projectId: project.id,
      stream: "system",
      chunk: `[start] migrate project to ${targetConnection.name}\n`,
    })
    const result = await migrateProjectBetweenServers({
      projectId: project.id,
      config,
      sourceConnection: resolveStoredPayload(sourceConnection),
      targetConnection: resolveStoredPayload(targetConnection),
      remoteAppDir,
    })
    appendOperationLog({
      projectId: project.id,
      stream: result.ok ? "system" : "stderr",
      chunk: `[finish] ${result.ok ? "success" : "failed"} (${Math.round(result.durationMs / 1000)}s)\n${result.message}\n`,
    })
    if (result.ok) {
      updateLocalProjectDeployResult(project.id, {
        connectionId: targetConnection.id!,
        remotePath: result.targetRemotePath ?? remoteAppDir,
        status: "success",
        message: result.message,
        deployKind: project.lastDeployKind ?? config?.deploy?.strategy ?? "local-npm-script",
      })
    }
    return result
  })

  registerIpcHandle("projects:list-operation-logs", async (_event, payload?: { limit?: number }) => {
    payload = parseOrThrow(operationLogsQuerySchema, payload)
    return listOperationLogs(payload?.limit)
  })

  registerIpcHandle(
    "projects:append-operation-log",
    async (_event, payload: { projectId: string; stream: "stdout" | "stderr" | "system"; chunk: string }) => {
      payload = parseOrThrow(operationLogAppendSchema, payload)
      requireProject(payload.projectId)
      return appendOperationLog(payload)
    },
  )
}
