import { contextBridge, ipcRenderer } from "./electron-shim"
import type {
  DependencyServiceAction,
  DigwisApi,
  SshConfigMutationInput,
  VpsConnectionInput,
} from "../shared/vps"
import type {
  ProjectBackupSchedule,
  LocalProjectInput,
  ProjectDeployInput,
  ProjectDeployLogEvent,
  ProjectEnvInput,
  ProjectOperationLogAppendInput,
  ProjectScaffoldProgressEvent,
  ProjectRuntimeModulesUpdateInput,
  ProjectMigrationInput,
  ProjectLocalPathUpdateInput,
  ProjectRemoteDetailsInput,
  ProjectEnvUpdateInput,
  ProjectInitializeInput,
  ProjectDeleteInput,
  ProjectClientAppInput,
  ProjectRemoteStateInput,
  ProjectScaffoldInput,
  ProjectSiteSettingsInput,
} from "../shared/projects"

const api: DigwisApi = {
  projects: {
    listProjects: () => ipcRenderer.invoke("projects:list"),
    addProjectFromPath: (payload: LocalProjectInput) => ipcRenderer.invoke("projects:add", payload),
    createProjectScaffold: (payload: ProjectScaffoldInput) => ipcRenderer.invoke("projects:create-scaffold", payload),
    scanRemoteProjects: (payload) => ipcRenderer.invoke("projects:scan-remote", payload),
    listOpenClawInstances: (connectionId: string) => ipcRenderer.invoke("openclaw:list", connectionId),
    precheckOpenClawInstall: (payload) => ipcRenderer.invoke("openclaw:precheck", payload),
    installOpenClaw: (payload) => ipcRenderer.invoke("openclaw:install", payload),
    uninstallOpenClaw: (payload) => ipcRenderer.invoke("openclaw:uninstall", payload),
    restartOpenClaw: (payload) => ipcRenderer.invoke("openclaw:restart", payload),
    fetchOpenClawLogs: (payload) => ipcRenderer.invoke("openclaw:logs", payload),
    onScaffoldProgress: (handler: (event: ProjectScaffoldProgressEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectScaffoldProgressEvent) => {
        handler(payload)
      }
      ipcRenderer.on("projects:scaffold-progress", listener)
      return () => {
        ipcRenderer.removeListener("projects:scaffold-progress", listener)
      }
    },
    updateProjectLocalPath: (payload: ProjectLocalPathUpdateInput) =>
      ipcRenderer.invoke("projects:update-local-path", payload),
    getProjectConfig: (projectId: string) => ipcRenderer.invoke("projects:get-config", projectId),
    setProjectRuntimeModules: (payload: ProjectRuntimeModulesUpdateInput) =>
      ipcRenderer.invoke("projects:set-runtime-modules", payload),
    deleteProject: (payload: ProjectDeleteInput) => ipcRenderer.invoke("projects:delete", payload),
    pickProjectDirectory: () => ipcRenderer.invoke("projects:pick-directory"),
    listNpmScripts: (projectId: string) => ipcRenderer.invoke("projects:list-npm-scripts", projectId),
    getProjectLocalPreview: (projectId: string) => ipcRenderer.invoke("projects:get-local-preview", projectId),
    openProjectLocalPreview: (projectId: string) => ipcRenderer.invoke("projects:open-local-preview", projectId),
    openProjectLocalAdmin: (projectId: string) => ipcRenderer.invoke("projects:open-local-admin", projectId),
    startProjectLocalDev: (projectId: string) => ipcRenderer.invoke("projects:start-local-dev", projectId),
    startProjectLocalAdminService: (projectId: string) => ipcRenderer.invoke("projects:start-local-admin-service", projectId),
    checkProjectUrlReachable: (url: string) => ipcRenderer.invoke("projects:check-url-reachable", url),
    openProjectClientAppPath: (payload: ProjectClientAppInput) => ipcRenderer.invoke("projects:open-client-app-path", payload),
    startProjectClientApp: (payload: ProjectClientAppInput) => ipcRenderer.invoke("projects:start-client-app", payload),
    openProjectClientAppIde: (payload: ProjectClientAppInput) => ipcRenderer.invoke("projects:open-client-app-ide", payload),
    getDeployProfile: (projectId: string) => ipcRenderer.invoke("projects:get-deploy-profile", projectId),
    getProjectRemoteState: (payload: ProjectRemoteStateInput) => ipcRenderer.invoke("projects:get-remote-state", payload),
    getProjectRemoteDetails: (payload: ProjectRemoteDetailsInput) =>
      ipcRenderer.invoke("projects:get-remote-details", payload),
    getProjectEnv: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:get-env", payload),
    saveProjectEnv: (payload: ProjectEnvUpdateInput) => ipcRenderer.invoke("projects:save-env", payload),
    rotateProjectSecret: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:rotate-secret", payload),
    restartProjectService: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:restart-service", payload),
    stopProjectService: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:stop-service", payload),
    saveProjectSiteSettings: (payload: ProjectSiteSettingsInput) => ipcRenderer.invoke("projects:save-site-settings", payload),
    initializeProject: (payload: ProjectInitializeInput) => ipcRenderer.invoke("projects:initialize", payload),
    deployProject: (payload: ProjectDeployInput) => ipcRenderer.invoke("projects:deploy", payload),
    getProjectActionHints: (projectId: string) => ipcRenderer.invoke("projects:get-action-hints", projectId),
    getProjectBackupSchedule: (projectId: string) =>
      ipcRenderer.invoke("projects:get-backup-schedule", projectId),
    setProjectBackupSchedule: (payload: { projectId: string; schedule: ProjectBackupSchedule }) =>
      ipcRenderer.invoke("projects:set-backup-schedule", payload),
    runProjectBackup: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:run-backup", payload),
    migrateProject: (payload: ProjectMigrationInput) => ipcRenderer.invoke("projects:migrate", payload),
    listOperationLogs: (payload?: { limit?: number }) =>
      ipcRenderer.invoke("projects:list-operation-logs", payload),
    appendProjectOperationLog: (payload: ProjectOperationLogAppendInput) =>
      ipcRenderer.invoke("projects:append-operation-log", payload),
    onDeployLog: (handler: (event: ProjectDeployLogEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectDeployLogEvent) => {
        handler(payload)
      }
      ipcRenderer.on("projects:deploy-log", listener)
      return () => {
        ipcRenderer.removeListener("projects:deploy-log", listener)
      }
    },
  },
  vps: {
    listConnections: () => ipcRenderer.invoke("vps:list"),
    saveConnection: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:save", payload),
    testConnection: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:test", payload),
    inspectConnection: (payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) =>
      ipcRenderer.invoke("vps:inspect", payload, options),
    installDependency: (payload: VpsConnectionInput, dependencyId: string) =>
      ipcRenderer.invoke("vps:install-dependency", payload, dependencyId),
    inspectDependencyUsage: (payload: VpsConnectionInput, dependencyId: string) =>
      ipcRenderer.invoke("vps:inspect-dependency-usage", payload, dependencyId),
    uninstallDependency: (payload: VpsConnectionInput, dependencyId: string) =>
      ipcRenderer.invoke("vps:uninstall-dependency", payload, dependencyId),
    dependencyServiceAction: (
      payload: VpsConnectionInput,
      options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
    ) => ipcRenderer.invoke("vps:dependency-service", payload, options),
    checkSystemUpgrades: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:upgrade-check", payload),
    applySystemUpgrade: (payload: VpsConnectionInput, options: { reboot: boolean }) =>
      ipcRenderer.invoke("vps:upgrade-apply", payload, options),
    importLocalConnections: () => ipcRenderer.invoke("vps:import-local"),
    listSshConfigCandidates: () => ipcRenderer.invoke("vps:list-ssh-config-candidates"),
    getRawSshConfig: () => ipcRenderer.invoke("vps:get-raw-ssh-config"),
    saveRawSshConfig: (payload: { content: string }) => ipcRenderer.invoke("vps:save-raw-ssh-config", payload),
    createSshConfigCandidate: (payload: SshConfigMutationInput) =>
      ipcRenderer.invoke("vps:create-ssh-config-candidate", payload),
    updateSshConfigCandidate: (payload: SshConfigMutationInput) =>
      ipcRenderer.invoke("vps:update-ssh-config-candidate", payload),
    deleteSshConfigCandidate: (payload: { configPath: string; originalName: string }) =>
      ipcRenderer.invoke("vps:delete-ssh-config-candidate", payload),
    listDiscoveredHosts: () => ipcRenderer.invoke("vps:discover-hosts"),
    deleteConnection: (id: string) => ipcRenderer.invoke("vps:delete", id),
    createAndInstallSshKey: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:create-and-install-ssh-key", payload),
    browseRemoteFiles: (payload: { connectionId: string; path?: string; forceRefresh?: boolean }) =>
      ipcRenderer.invoke("vps:files:browse", payload),
    statRemoteEntry: (payload: { connectionId: string; path: string }) =>
      ipcRenderer.invoke("vps:files:stat", payload),
    readRemoteTextFile: (payload: { connectionId: string; path: string }) =>
      ipcRenderer.invoke("vps:files:read-text", payload),
    writeRemoteTextFile: (payload: { connectionId: string; path: string; content: string }) =>
      ipcRenderer.invoke("vps:files:write-text", payload),
    createRemoteDirectory: (payload: { connectionId: string; parentPath: string; directoryName: string }) =>
      ipcRenderer.invoke("vps:files:create-directory", payload),
    renameRemoteEntry: (payload: { connectionId: string; path: string; nextName: string }) =>
      ipcRenderer.invoke("vps:files:rename", payload),
    changeRemotePermissions: (payload: { connectionId: string; path: string; mode: string; recursive?: boolean }) =>
      ipcRenderer.invoke("vps:files:chmod", payload),
    deleteRemoteEntry: (payload: { connectionId: string; path: string }) =>
      ipcRenderer.invoke("vps:files:delete", payload),
    listRemoteTrash: (payload: { connectionId: string }) =>
      ipcRenderer.invoke("vps:files:trash:list", payload),
    restoreRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) =>
      ipcRenderer.invoke("vps:files:trash:restore", payload),
    purgeRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) =>
      ipcRenderer.invoke("vps:files:trash:purge", payload),
    uploadRemoteEntries: (payload: { connectionId: string; remotePath: string }) =>
      ipcRenderer.invoke("vps:files:upload", payload),
    downloadRemoteEntry: (payload: { connectionId: string; path: string; name: string; type: "file" | "directory" | "symlink" }) =>
      ipcRenderer.invoke("vps:files:download", payload),
  },
  bitcoin: {
    getPrice: () => ipcRenderer.invoke("bitcoin:get-price"),
  },
}

contextBridge.exposeInMainWorld("digwis", api)
