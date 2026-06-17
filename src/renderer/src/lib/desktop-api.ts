import type { DigwisApi, DigwisIpcError } from "../../../shared/vps"

function requireMethod<T extends (...args: any[]) => any>(
  method: T | undefined,
  featureName: string,
): T {
  if (typeof method !== "function") {
    throw new Error(`当前桌面进程还未加载${featureName}，请重启 Digwis Panel 后重试。`)
  }
  return method
}

function parseDigwisError(error: unknown): DigwisIpcError | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const prefix = "DIGWIS_IPC_ERROR:"
  const start = message.indexOf(prefix)
  if (start < 0) {
    return null
  }
  try {
    return JSON.parse(message.slice(start + prefix.length)) as DigwisIpcError
  } catch {
    return null
  }
}

async function wrapInvoke<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    const parsed = parseDigwisError(error)
    if (!parsed) {
      throw error
    }
    const next = new Error(parsed.message) as Error & DigwisIpcError
    next.code = parsed.code
    next.details = parsed.details
    throw next
  }
}

let cachedApi: DigwisApi | null = null

function createWrappedApi(api: DigwisApi): DigwisApi {
  return {
    projects: {
      listProjects: () => wrapInvoke(() => api.projects.listProjects()),
      addProjectFromPath: (payload) => wrapInvoke(() => api.projects.addProjectFromPath(payload)),
      createProjectScaffold: (payload) => wrapInvoke(() => api.projects.createProjectScaffold(payload)),
      onScaffoldProgress: (handler) => api.projects.onScaffoldProgress(handler),
      scanRemoteProjects: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.scanRemoteProjects, "远程项目扫描接口")(payload)),
      getProjectConfig: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.getProjectConfig, "项目配置读取接口")(projectId)),
      setProjectRuntimeModules: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.setProjectRuntimeModules, "项目模块切换接口")(payload)),
      updateProjectLocalPath: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.updateProjectLocalPath, "新版本地目录重新匹配接口")(payload)),
      deleteProject: (payload) => wrapInvoke(() => api.projects.deleteProject(payload)),
      pickProjectDirectory: () => wrapInvoke(() => api.projects.pickProjectDirectory()),
      listNpmScripts: (projectId) => wrapInvoke(() => api.projects.listNpmScripts(projectId)),
      getProjectLocalPreview: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.getProjectLocalPreview, "本地预览地址接口")(projectId)),
      openProjectLocalPreview: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectLocalPreview, "打开本地预览接口")(projectId)),
      openProjectLocalAdmin: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectLocalAdmin, "打开本地管理端接口")(projectId)),
      startProjectLocalDev: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectLocalDev, "启动本地开发接口")(projectId)),
      startProjectLocalAdminService: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectLocalAdminService, "启动本地管理服务接口")(projectId)),
      checkProjectUrlReachable: (url) =>
        wrapInvoke(() => requireMethod(api.projects.checkProjectUrlReachable, "本地地址探活接口")(url)),
      openProjectClientAppPath: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectClientAppPath, "打开客户端目录接口")(payload)),
      startProjectClientApp: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectClientApp, "启动客户端接口")(payload)),
      openProjectClientAppIde: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectClientAppIde, "打开客户端 IDE 接口")(payload)),
      getDeployProfile: (projectId) => wrapInvoke(() => api.projects.getDeployProfile(projectId)),
      getProjectRemoteState: (payload) => wrapInvoke(() => api.projects.getProjectRemoteState(payload)),
      getProjectRemoteDetails: (payload) => wrapInvoke(() => api.projects.getProjectRemoteDetails(payload)),
      getProjectEnv: (payload) => wrapInvoke(() => api.projects.getProjectEnv(payload)),
      saveProjectEnv: (payload) => wrapInvoke(() => api.projects.saveProjectEnv(payload)),
      rotateProjectSecret: (payload) => wrapInvoke(() => api.projects.rotateProjectSecret(payload)),
      restartProjectService: (payload) => wrapInvoke(() => api.projects.restartProjectService(payload)),
      stopProjectService: (payload) => wrapInvoke(() => api.projects.stopProjectService(payload)),
      saveProjectSiteSettings: (payload) => wrapInvoke(() => api.projects.saveProjectSiteSettings(payload)),
      initializeProject: (payload) => wrapInvoke(() => api.projects.initializeProject(payload)),
      deployProject: (payload) => wrapInvoke(() => api.projects.deployProject(payload)),
      getProjectActionHints: (projectId) => wrapInvoke(() => api.projects.getProjectActionHints(projectId)),
      getProjectBackupSchedule: (projectId) => wrapInvoke(() => api.projects.getProjectBackupSchedule(projectId)),
      setProjectBackupSchedule: (payload) => wrapInvoke(() => api.projects.setProjectBackupSchedule(payload)),
      runProjectBackup: (payload) => wrapInvoke(() => api.projects.runProjectBackup(payload)),
      migrateProject: (payload) => wrapInvoke(() => api.projects.migrateProject(payload)),
      listOperationLogs: (payload) => wrapInvoke(() => api.projects.listOperationLogs(payload)),
      appendProjectOperationLog: (payload) => wrapInvoke(() => api.projects.appendProjectOperationLog(payload)),
      onDeployLog: (handler) => api.projects.onDeployLog(handler),
      listOpenClawInstances: (connectionId) => wrapInvoke(() => api.projects.listOpenClawInstances(connectionId)),
      precheckOpenClawInstall: (payload) => wrapInvoke(() => api.projects.precheckOpenClawInstall(payload)),
      installOpenClaw: (payload) => wrapInvoke(() => api.projects.installOpenClaw(payload)),
      uninstallOpenClaw: (payload) => wrapInvoke(() => api.projects.uninstallOpenClaw(payload)),
      restartOpenClaw: (payload) => wrapInvoke(() => api.projects.restartOpenClaw(payload)),
      fetchOpenClawLogs: (payload) => wrapInvoke(() => api.projects.fetchOpenClawLogs(payload)),
    },
    vps: {
      listConnections: () => wrapInvoke(() => api.vps.listConnections()),
      saveConnection: (payload) => wrapInvoke(() => api.vps.saveConnection(payload)),
      testConnection: (payload) => wrapInvoke(() => api.vps.testConnection(payload)),
      inspectConnection: (payload, options) => wrapInvoke(() => api.vps.inspectConnection(payload, options)),
      installDependency: (payload, dependencyId) => wrapInvoke(() => api.vps.installDependency(payload, dependencyId)),
      inspectDependencyUsage: (payload, dependencyId) =>
        wrapInvoke(() => api.vps.inspectDependencyUsage(payload, dependencyId)),
      uninstallDependency: (payload, dependencyId) =>
        wrapInvoke(() => api.vps.uninstallDependency(payload, dependencyId)),
      dependencyServiceAction: (payload, options) =>
        wrapInvoke(() => api.vps.dependencyServiceAction(payload, options)),
      checkSystemUpgrades: (payload) => wrapInvoke(() => api.vps.checkSystemUpgrades(payload)),
      applySystemUpgrade: (payload, options) => wrapInvoke(() => api.vps.applySystemUpgrade(payload, options)),
      importLocalConnections: () => wrapInvoke(() => api.vps.importLocalConnections()),
      listSshConfigCandidates: () => wrapInvoke(() => api.vps.listSshConfigCandidates()),
      getRawSshConfig: () => wrapInvoke(() => api.vps.getRawSshConfig()),
      saveRawSshConfig: (payload) => wrapInvoke(() => api.vps.saveRawSshConfig(payload)),
      createSshConfigCandidate: (payload) => wrapInvoke(() => api.vps.createSshConfigCandidate(payload)),
      updateSshConfigCandidate: (payload) => wrapInvoke(() => api.vps.updateSshConfigCandidate(payload)),
      deleteSshConfigCandidate: (payload) => wrapInvoke(() => api.vps.deleteSshConfigCandidate(payload)),
      listDiscoveredHosts: () => wrapInvoke(() => api.vps.listDiscoveredHosts()),
      deleteConnection: (id) => wrapInvoke(() => api.vps.deleteConnection(id)),
      createAndInstallSshKey: (payload) => wrapInvoke(() => api.vps.createAndInstallSshKey(payload)),
      browseRemoteFiles: (payload) => wrapInvoke(() => api.vps.browseRemoteFiles(payload)),
      statRemoteEntry: (payload) =>
        wrapInvoke(() => requireMethod(api.vps.statRemoteEntry, "新版文件权限读取接口")(payload)),
      readRemoteTextFile: (payload) => wrapInvoke(() => api.vps.readRemoteTextFile(payload)),
      writeRemoteTextFile: (payload) => wrapInvoke(() => api.vps.writeRemoteTextFile(payload)),
      createRemoteDirectory: (payload) => wrapInvoke(() => api.vps.createRemoteDirectory(payload)),
      renameRemoteEntry: (payload) => wrapInvoke(() => api.vps.renameRemoteEntry(payload)),
      changeRemotePermissions: (payload) =>
        wrapInvoke(() => requireMethod(api.vps.changeRemotePermissions, "新版文件权限修改接口")(payload)),
      deleteRemoteEntry: (payload) => wrapInvoke(() => api.vps.deleteRemoteEntry(payload)),
      listRemoteTrash: (payload) => wrapInvoke(() => api.vps.listRemoteTrash(payload)),
      restoreRemoteTrashEntry: (payload) => wrapInvoke(() => api.vps.restoreRemoteTrashEntry(payload)),
      purgeRemoteTrashEntry: (payload) => wrapInvoke(() => api.vps.purgeRemoteTrashEntry(payload)),
      uploadRemoteEntries: (payload) => wrapInvoke(() => api.vps.uploadRemoteEntries(payload)),
      downloadRemoteEntry: (payload) => wrapInvoke(() => api.vps.downloadRemoteEntry(payload)),
    },
    bitcoin: {
      getPrice: () => wrapInvoke(() => api.bitcoin.getPrice()),
    },
  }
}

export function getDesktopApi(): DigwisApi {
  if (!window.digwis?.vps || !window.digwis?.projects) {
    throw new Error("桌面能力尚未注入，请确认当前是通过 Electron 桌面应用启动。")
  }

  if (!cachedApi) {
    cachedApi = createWrappedApi(window.digwis)
  }
  return cachedApi
}
