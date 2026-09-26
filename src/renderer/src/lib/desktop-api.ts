import type { DigwisApi, DigwisIpcError } from "../../../shared/vps"
import { createTauriApi } from "./tauri-api"

function requireMethod<T extends (...args: any[]) => any>(
  method: T | undefined,
  featureName: string,
): T {
  if (typeof method !== "function") {
    throw new Error(`Desktop API for ${featureName} is not loaded. Please restart Digwis Panel.`)
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
    settings: {
      getDefaultRemoteDirectory: () => wrapInvoke(() => api.settings.getDefaultRemoteDirectory()),
      setDefaultRemoteDirectory: (value) => wrapInvoke(() => api.settings.setDefaultRemoteDirectory(value)),
    },
    projects: {
      listProjects: () => wrapInvoke(() => api.projects.listProjects()),
      addProjectFromPath: (payload) => wrapInvoke(() => api.projects.addProjectFromPath(payload)),
      createProjectScaffold: (payload) => wrapInvoke(() => api.projects.createProjectScaffold(payload)),
      onScaffoldProgress: (handler) => api.projects.onScaffoldProgress(handler),
      scanRemoteProjects: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.scanRemoteProjects, "scanRemoteProjects")(payload)),
      getProjectConfig: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.getProjectConfig, "getProjectConfig")(projectId)),
      setProjectRuntimeModules: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.setProjectRuntimeModules, "setRuntimeModules")(payload)),
      updateProjectLocalPath: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.updateProjectLocalPath, "updateLocalPath")(payload)),
      deleteProject: (payload) => wrapInvoke(() => api.projects.deleteProject(payload)),
      pickProjectDirectory: () => wrapInvoke(() => api.projects.pickProjectDirectory()),
      listNpmScripts: (projectId) => wrapInvoke(() => api.projects.listNpmScripts(projectId)),
      getProjectLocalPreview: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.getProjectLocalPreview, "getProjectLocalPreview")(projectId)),
      openProjectLocalPreview: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectLocalPreview, "openProjectLocalPreview")(projectId)),
      openProjectLocalAdmin: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectLocalAdmin, "openProjectLocalAdmin")(projectId)),
      startProjectLocalDev: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectLocalDev, "startProjectLocalDev")(projectId)),
      startProjectLocalAdminService: (projectId) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectLocalAdminService, "startProjectLocalAdminService")(projectId)),
      checkProjectUrlReachable: (url) =>
        wrapInvoke(() => requireMethod(api.projects.checkProjectUrlReachable, "checkProjectUrlReachable")(url)),
      openProjectClientAppPath: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectClientAppPath, "openProjectClientAppPath")(payload)),
      startProjectClientApp: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.startProjectClientApp, "startProjectClientApp")(payload)),
      openProjectClientAppIde: (payload) =>
        wrapInvoke(() => requireMethod(api.projects.openProjectClientAppIde, "openProjectClientAppIde")(payload)),
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
migrateProject: (payload) => wrapInvoke(() => api.projects.migrateProject(payload)),
      listOperationLogs: (payload) => wrapInvoke(() => api.projects.listOperationLogs(payload)),
      appendProjectOperationLog: (payload) => wrapInvoke(() => api.projects.appendProjectOperationLog(payload)),
      onDeployLog: (handler) => api.projects.onDeployLog(handler),
    },
    terminal: {
      createSession: (payload) => wrapInvoke(() => api.terminal.createSession(payload)),
      writeInput: (payload) => wrapInvoke(() => api.terminal.writeInput(payload)),
      resize: (payload) => wrapInvoke(() => api.terminal.resize(payload)),
      closeSession: (payload) => wrapInvoke(() => api.terminal.closeSession(payload)),
      onData: (handler) => api.terminal.onData(handler),
      onExit: (handler) => api.terminal.onExit(handler),
      onError: (handler) => api.terminal.onError(handler),
    },
    vps: {
      listConnections: () => wrapInvoke(() => api.vps.listConnections()),
      saveConnection: (payload) => wrapInvoke(() => api.vps.saveConnection(payload)),
      testConnection: (payload) => wrapInvoke(() => api.vps.testConnection(payload)),
      inspectConnection: (payload, options) => wrapInvoke(() => api.vps.inspectConnection(payload, options)),
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
        wrapInvoke(() => requireMethod(api.vps.statRemoteEntry, "statRemoteEntry")(payload)),
      readRemoteTextFile: (payload) => wrapInvoke(() => api.vps.readRemoteTextFile(payload)),
      writeRemoteTextFile: (payload) => wrapInvoke(() => api.vps.writeRemoteTextFile(payload)),
      createRemoteDirectory: (payload) => wrapInvoke(() => api.vps.createRemoteDirectory(payload)),
      renameRemoteEntry: (payload) => wrapInvoke(() => api.vps.renameRemoteEntry(payload)),
      changeRemotePermissions: (payload) =>
        wrapInvoke(() => requireMethod(api.vps.changeRemotePermissions, "changeRemotePermissions")(payload)),
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
  if (!cachedApi) {
    if (window.digwis?.vps && window.digwis?.projects && window.digwis?.terminal) {
      // Legacy Electron preload bridge (kept for compatibility during migration).
      cachedApi = createWrappedApi(window.digwis)
    } else {
      cachedApi = createWrappedApi(createTauriApi())
    }
  }
  return cachedApi
}
