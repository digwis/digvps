import { app, BrowserWindow, dialog, ipcMain, screen, type OpenDialogOptions } from "electron"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  addLocalProjectFromPath,
  deleteConnection,
  deleteLocalProject,
  getConnectionSecrets,
  getLocalProject,
  getVpsConnectionInput,
  importDiscoveredConnections,
  initializeDatabase,
  listConnections,
  listLocalProjects,
  saveConnection,
  updateConnectionHealth,
  updateLocalProjectDeployResult,
} from "./services/db"
import {
  createSshConfigCandidate,
  discoverKnownHosts,
  discoverLocalConnections,
  deleteSshConfigCandidate,
  getRawSshConfig,
  listSshConfigCandidates,
  saveRawSshConfig,
  updateSshConfigCandidate,
} from "./services/discovery"
import { installRemoteDependency, uninstallRemoteDependency } from "./services/dependency-install"
import { inspectDependencyUsage } from "./services/dependency-usage"
import { inspectConnection } from "./services/inspection"
import { runDependencyServiceAction } from "./services/service-control"
import { applySystemUpgrade, checkSystemUpgrades } from "./services/system-upgrade"
import { testConnection } from "./services/ssh"
import { createAndInstallSshKey } from "./services/ssh-key-setup"
import {
  browseRemoteFiles,
  createRemoteDirectory,
  deleteRemoteEntry,
  disposeAllRemoteFileSessions,
  downloadRemoteEntry,
  pickAndUploadRemoteEntries,
  readRemoteTextFile,
  renameRemoteEntry,
  writeRemoteTextFile,
} from "./services/remote-files"
import { fetchBitcoinPrice } from "./services/bitcoin"
import { deployLocalProjectToVps, resolveRemoteDeployPathForProject } from "./services/project-deploy"
import { initializeProjectOnVps } from "./services/project-bootstrap"
import {
  readProjectEnvFile,
  restartProjectRemoteService,
  rotateProjectSessionSecret,
  saveProjectEnvFile,
} from "./services/project-env"
import { inspectProjectRemoteState } from "./services/project-remote-state"
import { applyProjectSiteSettings, getProjectRemoteDetails } from "./services/project-remote-management"
import { readProjectDeployConfig, readProjectDeployProfile } from "./services/project-deploy-profile"
import { readPackageJsonScriptNames, runLocalNpmScript } from "./services/project-local-npm"
import { inspectProjectActionHints } from "./services/project-action-hints"
import {
  getProjectBackupSchedule,
  initializeProjectActionState,
  markProjectActionRun,
  markProjectBackupRun,
  setProjectBackupSchedule,
} from "./services/project-action-state"
import { readLocalPostgresLsn } from "./services/project-db-marker"
import {
  appendOperationLog,
  initializeProjectOperationLog,
  listOperationLogs,
} from "./services/project-operation-log"
import type {
  LocalProjectInput,
  ProjectActionKind,
  ProjectBackupSchedule,
  ProjectDeployInput,
  ProjectRemoteDetailsInput,
  ProjectSiteSettingsInput,
} from "../shared/projects"
import type { DependencyServiceAction, SshConfigMutationInput, VpsConnectionInput } from "../shared/vps"

const isDev = !!process.env.ELECTRON_RENDERER_URL
let backupScheduler: NodeJS.Timeout | null = null
const runningBackupProjects = new Set<string>()

function resolveActionKindFromScript(script?: string): ProjectActionKind | null {
  if (!script) {
    return null
  }
  if (script === "deploy:panel" || script === "deploy:vps:code") {
    return "code"
  }
  if (script === "sync:vps:admin-data" || script === "sync:vps:data" || script === "sync:vps") {
    return "data"
  }
  if (script === "sync:vps:uploads" || script === "sync:uploads:vps") {
    return "uploads"
  }
  if (script === "backup:vps" || script === "backup") {
    return "backup"
  }
  return null
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea

  const window = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d0f14",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details)
  })

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("Preload failed:", preloadPath, error)
  })

  window.once("ready-to-show", () => {
    window.maximize()
    window.show()
  })

  if (isDev) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL!)
    window.webContents.openDevTools({ mode: "detach" })
  } else {
    window.loadFile(path.join(__dirname, "../renderer/index.html"))
  }
}

function ensureSavedPayload(payload: VpsConnectionInput) {
  const existingSecrets = payload.id ? getConnectionSecrets(payload.id) : null
  const normalizedPassword = payload.password?.trim() ? payload.password : undefined
  const normalizedPrivateKey = payload.privateKey?.trim() ? payload.privateKey : undefined
  const normalizedPassphrase =
    payload.passphrase && payload.passphrase.length > 0 ? payload.passphrase : undefined

  return {
    ...payload,
    id: payload.id ?? randomUUID(),
    password:
      payload.authType === "password"
        ? normalizedPassword ?? existingSecrets?.password
        : undefined,
    privateKey:
      payload.authType === "privateKey"
        ? normalizedPrivateKey ?? existingSecrets?.privateKey
        : undefined,
    passphrase:
      payload.authType === "privateKey"
        ? normalizedPassphrase ?? existingSecrets?.passphrase
        : undefined,
  }
}

function resolveStoredPayload(payload: VpsConnectionInput) {
  const secrets = payload.id ? getConnectionSecrets(payload.id) : null

  return payload.id
    ? {
        ...payload,
        ...(secrets ?? {}),
      }
    : payload
}

function buildProjectScriptEnv(args: {
  projectId: string
  projectPath: string
  connection: VpsConnectionInput
  configRemoteAppDir?: string | null
  configRemoteService?: string | null
  configPublicCheckUrl?: string | null
  configEnv?: Record<string, string>
}): NodeJS.ProcessEnv {
  const { projectId, projectPath, connection, configRemoteAppDir, configRemoteService, configPublicCheckUrl, configEnv } = args
  const base: NodeJS.ProcessEnv = {
    DIGWIS_PANEL: "1",
    DIGWIS_PANEL_PROJECT_ID: projectId,
    DIGWIS_PANEL_PROJECT_PATH: projectPath,
    VPS_CONNECTION_NAME: connection.name,
    VPS_HOST: connection.host,
    VPS_PORT: String(connection.port),
    VPS_USER: connection.username,
    VPS_AUTH_TYPE: connection.authType,
    REMOTE_APP_DIR: configRemoteAppDir ?? undefined,
    REMOTE_SERVICE: configRemoteService ?? undefined,
    PUBLIC_CHECK_URL: configPublicCheckUrl ?? undefined,
  }

  if (connection.authType === "password") {
    base.VPS_PASSWORD = connection.password
  } else {
    base.VPS_PRIVATE_KEY = connection.privateKey
    base.VPS_PASSPHRASE = connection.passphrase
  }

  for (const [key, value] of Object.entries(configEnv ?? {})) {
    base[key] = value
  }

  return base
}

function backupDue(schedule: ProjectBackupSchedule, nextRunAt?: string | null) {
  if (schedule === "off" || !nextRunAt) {
    return false
  }
  return new Date(nextRunAt).getTime() <= Date.now()
}

async function runDueBackupTasks() {
  const projects = listLocalProjects()
  for (const project of projects) {
    const backup = getProjectBackupSchedule(project.id)
    if (!backupDue(backup.schedule, backup.nextRunAt)) {
      continue
    }
    if (runningBackupProjects.has(project.id)) {
      continue
    }
    runningBackupProjects.add(project.id)
    try {
      if (!project.lastConnectionId) {
        markProjectBackupRun(project.id)
        continue
      }
      const connection = getVpsConnectionInput(project.lastConnectionId)
      if (!connection) {
        markProjectBackupRun(project.id)
        continue
      }
      const config = readProjectDeployConfig(project.localPath)
      const scripts = readPackageJsonScriptNames(project.localPath)
      const backupScript = scripts.includes("backup:vps") ? "backup:vps" : scripts.includes("backup") ? "backup" : null
      if (!backupScript) {
        markProjectBackupRun(project.id)
        continue
      }
      const result = await runLocalNpmScript(project.localPath, backupScript, {
        timeoutMs: 2 * 60 * 60 * 1000,
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
      if (result.ok) {
        markProjectActionRun(project.id, "backup")
      }
      markProjectBackupRun(project.id)
    } catch {
      markProjectBackupRun(project.id)
    } finally {
      runningBackupProjects.delete(project.id)
    }
  }
}

app.whenReady().then(() => {
  const userDataPath = app.getPath("userData")
  initializeDatabase(userDataPath)
  initializeProjectActionState(userDataPath)
  initializeProjectOperationLog(userDataPath)
  void runDueBackupTasks()
  backupScheduler = setInterval(() => {
    void runDueBackupTasks()
  }, 60_000)

  ipcMain.handle("projects:list", async () => {
    return listLocalProjects()
  })

  ipcMain.handle("projects:add", async (_event, payload: LocalProjectInput) => {
    return addLocalProjectFromPath(payload)
  })

  ipcMain.handle("projects:delete", async (_event, id: string) => {
    deleteLocalProject(id)
    return { success: true as const }
  })

  ipcMain.handle("projects:list-npm-scripts", async (_event, projectId: string) => {
    const project = getLocalProject(projectId)
    if (!project) {
      return []
    }
    return readPackageJsonScriptNames(project.localPath)
  })

  ipcMain.handle("projects:get-deploy-profile", async (_event, projectId: string) => {
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

  ipcMain.handle("projects:get-remote-state", async (_event, payload: { projectId: string; connectionId: string }) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
    const config = readProjectDeployConfig(project.localPath)
    if (!config) {
      throw new Error("项目缺少 digwis-panel.deploy.json")
    }
    return await inspectProjectRemoteState({
      connection: resolveStoredPayload(connection),
      config,
    })
  })

  ipcMain.handle("projects:get-remote-details", async (_event, payload: ProjectRemoteDetailsInput) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
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

  ipcMain.handle("projects:get-env", async (_event, payload: { projectId: string; connectionId: string }) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
    const config = readProjectDeployConfig(project.localPath)
    const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
    if (!remoteAppDir) {
      throw new Error("项目未配置 deploy.remoteAppDir")
    }
    return await readProjectEnvFile(resolveStoredPayload(connection), remoteAppDir)
  })

  ipcMain.handle(
    "projects:save-env",
    async (_event, payload: { projectId: string; connectionId: string; content: string }) => {
      const project = getLocalProject(payload.projectId)
      if (!project) {
        throw new Error("项目不存在或已被删除")
      }
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      const config = readProjectDeployConfig(project.localPath)
      const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
      if (!remoteAppDir) {
        throw new Error("项目未配置 deploy.remoteAppDir")
      }
      return await saveProjectEnvFile(resolveStoredPayload(connection), remoteAppDir, payload.content)
    },
  )

  ipcMain.handle(
    "projects:rotate-secret",
    async (_event, payload: { projectId: string; connectionId: string }) => {
      const project = getLocalProject(payload.projectId)
      if (!project) {
        throw new Error("项目不存在或已被删除")
      }
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      const config = readProjectDeployConfig(project.localPath)
      const remoteAppDir = config?.deploy?.remoteAppDir?.trim()
      if (!remoteAppDir) {
        throw new Error("项目未配置 deploy.remoteAppDir")
      }
      return await rotateProjectSessionSecret(resolveStoredPayload(connection), remoteAppDir)
    },
  )

  ipcMain.handle(
    "projects:restart-service",
    async (_event, payload: { projectId: string; connectionId: string }) => {
      const project = getLocalProject(payload.projectId)
      if (!project) {
        throw new Error("项目不存在或已被删除")
      }
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      const config = readProjectDeployConfig(project.localPath)
      const remoteService = config?.deploy?.remoteService?.trim()
      if (!remoteService) {
        throw new Error("项目未配置 deploy.remoteService")
      }
      return await restartProjectRemoteService(resolveStoredPayload(connection), remoteService)
    },
  )

  ipcMain.handle("projects:save-site-settings", async (_event, payload: ProjectSiteSettingsInput) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
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

  ipcMain.handle("projects:initialize", async (_event, payload: { projectId: string; connectionId: string }) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
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

  ipcMain.handle("projects:pick-directory", async (event) => {
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

  ipcMain.handle("projects:deploy", async (event, payload: ProjectDeployInput) => {
    const project = getLocalProject(payload.projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }

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
        timeoutMs: script === "sync:vps:uploads" || script === "sync:uploads:vps" ? 3 * 60 * 60 * 1000 : undefined,
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

  ipcMain.handle("projects:get-action-hints", async (_event, projectId: string) => {
    const project = getLocalProject(projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    return await inspectProjectActionHints(project)
  })

  ipcMain.handle("projects:get-backup-schedule", async (_event, projectId: string) => {
    const project = getLocalProject(projectId)
    if (!project) {
      throw new Error("项目不存在或已被删除")
    }
    return getProjectBackupSchedule(project.id)
  })

  ipcMain.handle(
    "projects:set-backup-schedule",
    async (_event, payload: { projectId: string; schedule: ProjectBackupSchedule }) => {
      const project = getLocalProject(payload.projectId)
      if (!project) {
        throw new Error("项目不存在或已被删除")
      }
      const next = setProjectBackupSchedule(project.id, payload.schedule)
      appendOperationLog({
        projectId: project.id,
        stream: "system",
        chunk: `[backup-schedule] ${payload.schedule}\n`,
      })
      return next
    },
  )

  ipcMain.handle("projects:list-operation-logs", async (_event, payload?: { limit?: number }) => {
    return listOperationLogs(payload?.limit)
  })

  ipcMain.handle("vps:list", async () => {
    return listConnections()
  })

  ipcMain.handle("vps:import-local", async () => {
    return importDiscoveredConnections(discoverLocalConnections())
  })

  ipcMain.handle("vps:list-ssh-config-candidates", async () => {
    return listSshConfigCandidates()
  })

  ipcMain.handle("vps:get-raw-ssh-config", async () => {
    return getRawSshConfig()
  })

  ipcMain.handle("vps:save-raw-ssh-config", async (_event, payload: { content: string }) => {
    return saveRawSshConfig(payload.content)
  })

  ipcMain.handle("vps:create-ssh-config-candidate", async (_event, payload: SshConfigMutationInput) => {
    return createSshConfigCandidate(payload)
  })

  ipcMain.handle("vps:update-ssh-config-candidate", async (_event, payload: SshConfigMutationInput) => {
    return updateSshConfigCandidate(payload)
  })

  ipcMain.handle(
    "vps:delete-ssh-config-candidate",
    async (_event, payload: { configPath: string; originalName: string }) => {
      return deleteSshConfigCandidate(payload)
    },
  )

  ipcMain.handle("vps:discover-hosts", async () => {
    const connections = listConnections()
    return discoverKnownHosts(
      connections.map((item) => ({
        host: item.host,
        port: item.port,
      })),
    )
  })

  ipcMain.handle("vps:save", async (_event, payload: VpsConnectionInput) => {
    const record = saveConnection(ensureSavedPayload(payload))
    return record
  })

  ipcMain.handle("vps:create-and-install-ssh-key", async (_event, payload: VpsConnectionInput) => {
    return await createAndInstallSshKey(ensureSavedPayload(payload))
  })

  ipcMain.handle("vps:files:browse", async (_event, payload: { connectionId: string; path?: string; forceRefresh?: boolean }) => {
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
    return await browseRemoteFiles(resolveStoredPayload(connection), payload.path, {
      forceRefresh: payload.forceRefresh,
    })
  })

  ipcMain.handle("vps:files:read-text", async (_event, payload: { connectionId: string; path: string }) => {
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
    return await readRemoteTextFile(resolveStoredPayload(connection), payload.path)
  })

  ipcMain.handle(
    "vps:files:write-text",
    async (_event, payload: { connectionId: string; path: string; content: string }) => {
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      return await writeRemoteTextFile(resolveStoredPayload(connection), payload.path, payload.content)
    },
  )

  ipcMain.handle(
    "vps:files:create-directory",
    async (_event, payload: { connectionId: string; parentPath: string; directoryName: string }) => {
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      return await createRemoteDirectory(
        resolveStoredPayload(connection),
        payload.parentPath,
        payload.directoryName,
      )
    },
  )

  ipcMain.handle(
    "vps:files:rename",
    async (_event, payload: { connectionId: string; path: string; nextName: string }) => {
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      return await renameRemoteEntry(resolveStoredPayload(connection), payload.path, payload.nextName)
    },
  )

  ipcMain.handle("vps:files:delete", async (_event, payload: { connectionId: string; path: string }) => {
    const connection = getVpsConnectionInput(payload.connectionId)
    if (!connection) {
      throw new Error("VPS 连接不存在")
    }
    return await deleteRemoteEntry(resolveStoredPayload(connection), payload.path)
  })

  ipcMain.handle(
    "vps:files:upload",
    async (event, payload: { connectionId: string; remotePath: string }) => {
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      return await pickAndUploadRemoteEntries(window, resolveStoredPayload(connection), payload.remotePath)
    },
  )

  ipcMain.handle(
    "vps:files:download",
    async (
      event,
      payload: { connectionId: string; path: string; name: string; type: "file" | "directory" | "symlink" },
    ) => {
      const connection = getVpsConnectionInput(payload.connectionId)
      if (!connection) {
        throw new Error("VPS 连接不存在")
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      return await downloadRemoteEntry(window, resolveStoredPayload(connection), payload)
    },
  )

  ipcMain.handle("vps:test", async (_event, payload: VpsConnectionInput) => {
    try {
      const result = await testConnection(resolveStoredPayload(payload))
      if (payload.id) {
        updateConnectionHealth(payload.id, {
          status: "connected",
          lastError: null,
        })
      }
      return result
    } catch (error) {
      if (payload.id) {
        updateConnectionHealth(payload.id, {
          status: "failed",
          lastError: error instanceof Error ? error.message : "未知错误",
        })
      }
      throw error
    }
  })

  ipcMain.handle(
    "vps:install-dependency",
    async (_event, payload: VpsConnectionInput, dependencyId: string) => {
      return installRemoteDependency(resolveStoredPayload(payload), dependencyId)
    },
  )

  ipcMain.handle(
    "vps:inspect-dependency-usage",
    async (_event, payload: VpsConnectionInput, dependencyId: string) => {
      return inspectDependencyUsage(resolveStoredPayload(payload), dependencyId)
    },
  )

  ipcMain.handle(
    "vps:uninstall-dependency",
    async (_event, payload: VpsConnectionInput, dependencyId: string) => {
      return uninstallRemoteDependency(resolveStoredPayload(payload), dependencyId)
    },
  )

  ipcMain.handle(
    "vps:dependency-service",
    async (
      _event,
      payload: VpsConnectionInput,
      options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
    ) => {
      return runDependencyServiceAction(resolveStoredPayload(payload), options)
    },
  )

  ipcMain.handle("vps:inspect", async (_event, payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) => {
    try {
      const result = await inspectConnection(resolveStoredPayload(payload), options)
      if (payload.id) {
        updateConnectionHealth(payload.id, {
          status: "connected",
          lastError: null,
        })
      }
      return result
    } catch (error) {
      if (payload.id) {
        updateConnectionHealth(payload.id, {
          status: "failed",
          lastError: error instanceof Error ? error.message : "环境检测失败",
        })
      }
      throw error
    }
  })

  ipcMain.handle("vps:upgrade-check", async (_event, payload: VpsConnectionInput) => {
    return checkSystemUpgrades(resolveStoredPayload(payload))
  })

  ipcMain.handle(
    "vps:upgrade-apply",
    async (_event, payload: VpsConnectionInput, options: { reboot: boolean }) => {
      return applySystemUpgrade(resolveStoredPayload(payload), options)
    },
  )

  ipcMain.handle("vps:delete", async (_event, id: string) => {
    deleteConnection(id)
    return { success: true as const }
  })

  ipcMain.handle("bitcoin:get-price", async () => {
    return fetchBitcoinPrice()
  })

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  if (backupScheduler) {
    clearInterval(backupScheduler)
    backupScheduler = null
  }
  void disposeAllRemoteFileSessions()
})
