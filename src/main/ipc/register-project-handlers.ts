import { BrowserWindow, dialog, shell, type OpenDialogOptions } from "electron"
import fs from "node:fs"
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
import {
  getProjectBackupSchedule,
  markProjectActionRun,
  markProjectBackupRun,
  setProjectBackupSchedule,
} from "../services/project-action-state"
import { appendOperationLog, listOperationLogs } from "../services/project-operation-log"
import { repairProjectNativeModules } from "../services/project-native-module-fix"
import { readProjectLocalRuntime, writeProjectLocalRuntime } from "../services/project-local-runtime"
import { runProjectRemoteBackup } from "../services/project-backup"
import { migrateProjectBetweenServers } from "../services/project-migration"
import { createProjectScaffold, getProjectConfig, setProjectRuntimeModules } from "../services/project-scaffold"
import { buildProjectScriptEnv, resolveActionKindFromScript, resolveStoredPayload } from "./helpers"
import { registerIpcHandle } from "./ipc-error"
import {
  localProjectInputSchema,
  operationLogAppendSchema,
  operationLogsQuerySchema,
  parseOrThrow,
  projectBackupScheduleSchema,
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
} from "./schemas"
import type {
  DigwisProjectConfig,
  LocalProjectInput,
  ProjectDeleteInput,
  ProjectBackupSchedule,
  ProjectDeployInput,
  ProjectLocalPathUpdateInput,
  ProjectMigrationInput,
  ProjectRemoteDetailsInput,
  ProjectRuntimeModulesUpdateInput,
  ProjectScaffoldInput,
  ProjectSiteSettingsInput,
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

function resolveProjectLocalPreview(projectPath: string) {
  const fallback = {
    url: "http://localhost:3000",
    webPath: path.join(projectPath, "apps", "web"),
    adminUrl: "http://localhost:3000/admin",
  }
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
    return {
      url: runtime?.previewUrl?.trim() || previewUrl,
      webPath,
      adminUrl: runtime?.adminUrl?.trim() || parsed.panel?.adminUrl?.trim() || fallback.adminUrl,
    }
  } catch {
    return fallback
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
  ]
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf8")
      for (const pattern of patterns) {
        const match = raw.match(pattern)
        if (match?.[1]) {
          return match[1].replace("http://[::1]:", "http://localhost:")
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return null
}

function runInProjectDetached(projectPath: string, command: string) {
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", command], {
          cwd: projectPath,
          detached: true,
          stdio: "ignore",
        })
      : spawn("/bin/bash", ["-lc", `cd "${projectPath.replace(/"/g, '\\"')}" && ${command}`], {
          detached: true,
          stdio: "ignore",
        })
  child.unref()
  return child.pid ?? undefined
}

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
    const directusCompose = path.join(project.localPath, "services", "directus", "docker-compose.yml")
    if (!fs.existsSync(directusCompose)) {
      return {
        ok: true,
        message: "当前项目没有独立 CMS sidecar，跳过后台管理服务启动。",
        adminUrl: preview.adminUrl || `${preview.url.replace(/\/$/, "")}/admin`,
      }
    }
    runInProjectDetached(project.localPath, "npm run directus:up")
    return {
      ok: true,
      message: "已在后台启动 CMS 管理服务",
      adminUrl: preview.adminUrl || "http://127.0.0.1:8055/admin",
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
      throw new Error("项目缺少 digwis-panel.deploy.json")
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
      throw new Error("该项目未配置远端初始化模板（缺少 digwis-panel.deploy.json 中的 init 段）")
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

  registerIpcHandle("projects:get-backup-schedule", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = requireProject(projectId)
    return getProjectBackupSchedule(project.id)
  })

  registerIpcHandle(
    "projects:set-backup-schedule",
    async (_event, payload: { projectId: string; schedule: ProjectBackupSchedule }) => {
      payload = parseOrThrow(projectBackupScheduleSchema, payload)
      const project = requireProject(payload.projectId)
      const next = setProjectBackupSchedule(project.id, payload.schedule)
      appendOperationLog({
        projectId: project.id,
        stream: "system",
        chunk: `[backup-schedule] ${payload.schedule}\n`,
      })
      return next
    },
  )

  registerIpcHandle("projects:run-backup", async (_event, payload: { projectId: string; connectionId: string }) => {
    payload = parseOrThrow(projectConnectionSchema, payload)
    const project = requireProject(payload.projectId)
    const connection = requireConnection(payload.connectionId)
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = project.lastRemotePath || config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录")
    }
    appendOperationLog({
      projectId: project.id,
      stream: "system",
      chunk: "[start] remote backup\n",
    })
    const result = await runProjectRemoteBackup({
      connection: resolveStoredPayload(connection),
      projectId: project.id,
      remoteAppDir,
    })
    appendOperationLog({
      projectId: project.id,
      stream: result.ok ? "system" : "stderr",
      chunk: `[finish] ${result.ok ? "success" : "failed"} (${Math.round(result.durationMs / 1000)}s)\n${result.message}\n`,
    })
    if (result.ok) {
      markProjectActionRun(project.id, "backup")
      markProjectBackupRun(project.id)
    }
    return result
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
