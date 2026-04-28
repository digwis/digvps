import type { DigwisApi, DigwisIpcError } from "../../../shared/vps"

function parseDigwisError(error: unknown): DigwisIpcError | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const prefix = "DIGWIS_IPC_ERROR:"
  if (!message.startsWith(prefix)) {
    return null
  }
  try {
    return JSON.parse(message.slice(prefix.length)) as DigwisIpcError
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
      deleteProject: (id) => wrapInvoke(() => api.projects.deleteProject(id)),
      pickProjectDirectory: () => wrapInvoke(() => api.projects.pickProjectDirectory()),
      listNpmScripts: (projectId) => wrapInvoke(() => api.projects.listNpmScripts(projectId)),
      getDeployProfile: (projectId) => wrapInvoke(() => api.projects.getDeployProfile(projectId)),
      getProjectRemoteState: (payload) => wrapInvoke(() => api.projects.getProjectRemoteState(payload)),
      getProjectRemoteDetails: (payload) => wrapInvoke(() => api.projects.getProjectRemoteDetails(payload)),
      getProjectEnv: (payload) => wrapInvoke(() => api.projects.getProjectEnv(payload)),
      saveProjectEnv: (payload) => wrapInvoke(() => api.projects.saveProjectEnv(payload)),
      rotateProjectSecret: (payload) => wrapInvoke(() => api.projects.rotateProjectSecret(payload)),
      restartProjectService: (payload) => wrapInvoke(() => api.projects.restartProjectService(payload)),
      saveProjectSiteSettings: (payload) => wrapInvoke(() => api.projects.saveProjectSiteSettings(payload)),
      initializeProject: (payload) => wrapInvoke(() => api.projects.initializeProject(payload)),
      deployProject: (payload) => wrapInvoke(() => api.projects.deployProject(payload)),
      getProjectActionHints: (projectId) => wrapInvoke(() => api.projects.getProjectActionHints(projectId)),
      getProjectBackupSchedule: (projectId) => wrapInvoke(() => api.projects.getProjectBackupSchedule(projectId)),
      setProjectBackupSchedule: (payload) => wrapInvoke(() => api.projects.setProjectBackupSchedule(payload)),
      listOperationLogs: (payload) => wrapInvoke(() => api.projects.listOperationLogs(payload)),
      onDeployLog: (handler) => api.projects.onDeployLog(handler),
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
      readRemoteTextFile: (payload) => wrapInvoke(() => api.vps.readRemoteTextFile(payload)),
      writeRemoteTextFile: (payload) => wrapInvoke(() => api.vps.writeRemoteTextFile(payload)),
      createRemoteDirectory: (payload) => wrapInvoke(() => api.vps.createRemoteDirectory(payload)),
      renameRemoteEntry: (payload) => wrapInvoke(() => api.vps.renameRemoteEntry(payload)),
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
