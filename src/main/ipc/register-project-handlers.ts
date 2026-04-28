import { BrowserWindow, dialog, type OpenDialogOptions } from "electron"
import {
  addLocalProjectFromPath,
  deleteLocalProject,
  getLocalProject,
  getVpsConnectionInput,
  listLocalProjects,
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
import { runProjectRemoteBackup } from "../services/project-backup"
import { migrateProjectBetweenServers } from "../services/project-migration"
import { buildProjectScriptEnv, resolveActionKindFromScript, resolveStoredPayload } from "./helpers"
import { registerIpcHandle } from "./ipc-error"
import {
  localProjectInputSchema,
  operationLogsQuerySchema,
  parseOrThrow,
  projectBackupScheduleSchema,
  projectConnectionSchema,
  projectDeploySchema,
  projectEnvUpdateSchema,
  projectIdSchema,
  projectMigrationSchema,
  projectRemoteDetailsSchema,
  projectSiteSettingsSchema,
} from "./schemas"
import type {
  LocalProjectInput,
  ProjectBackupSchedule,
  ProjectDeployInput,
  ProjectMigrationInput,
  ProjectRemoteDetailsInput,
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

export function registerProjectHandlers() {
  registerIpcHandle("projects:list", async () => {
    return listLocalProjects()
  })

  registerIpcHandle("projects:add", async (_event, payload: LocalProjectInput) => {
    return addLocalProjectFromPath(parseOrThrow(localProjectInputSchema, payload))
  })

  registerIpcHandle("projects:delete", async (_event, id: string) => {
    id = parseOrThrow(projectIdSchema, id)
    deleteLocalProject(id)
    return { success: true as const }
  })

  registerIpcHandle("projects:list-npm-scripts", async (_event, projectId: string) => {
    projectId = parseOrThrow(projectIdSchema, projectId)
    const project = getLocalProject(projectId)
    if (!project) {
      return []
    }
    return readPackageJsonScriptNames(project.localPath)
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
}
