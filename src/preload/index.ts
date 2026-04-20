import { contextBridge, ipcRenderer } from "electron"
import type { DependencyServiceAction, DigwisApi, VpsConnectionInput } from "../shared/vps"
import type {
  LocalProjectInput,
  ProjectDeployInput,
  ProjectEnvInput,
  ProjectRemoteDetailsInput,
  ProjectEnvUpdateInput,
  ProjectInitializeInput,
  ProjectRemoteStateInput,
  ProjectSiteSettingsInput,
} from "../shared/projects"

const api: DigwisApi = {
  projects: {
    listProjects: () => ipcRenderer.invoke("projects:list"),
    addProjectFromPath: (payload: LocalProjectInput) => ipcRenderer.invoke("projects:add", payload),
    deleteProject: (id: string) => ipcRenderer.invoke("projects:delete", id),
    pickProjectDirectory: () => ipcRenderer.invoke("projects:pick-directory"),
    listNpmScripts: (projectId: string) => ipcRenderer.invoke("projects:list-npm-scripts", projectId),
    getDeployProfile: (projectId: string) => ipcRenderer.invoke("projects:get-deploy-profile", projectId),
    getProjectRemoteState: (payload: ProjectRemoteStateInput) => ipcRenderer.invoke("projects:get-remote-state", payload),
    getProjectRemoteDetails: (payload: ProjectRemoteDetailsInput) =>
      ipcRenderer.invoke("projects:get-remote-details", payload),
    getProjectEnv: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:get-env", payload),
    saveProjectEnv: (payload: ProjectEnvUpdateInput) => ipcRenderer.invoke("projects:save-env", payload),
    rotateProjectSecret: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:rotate-secret", payload),
    restartProjectService: (payload: ProjectEnvInput) => ipcRenderer.invoke("projects:restart-service", payload),
    saveProjectSiteSettings: (payload: ProjectSiteSettingsInput) => ipcRenderer.invoke("projects:save-site-settings", payload),
    initializeProject: (payload: ProjectInitializeInput) => ipcRenderer.invoke("projects:initialize", payload),
    deployProject: (payload: ProjectDeployInput) => ipcRenderer.invoke("projects:deploy", payload),
  },
  vps: {
    listConnections: () => ipcRenderer.invoke("vps:list"),
    saveConnection: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:save", payload),
    testConnection: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:test", payload),
    inspectConnection: (payload: VpsConnectionInput) =>
      ipcRenderer.invoke("vps:inspect", payload),
    installDependency: (payload: VpsConnectionInput, dependencyId: string) =>
      ipcRenderer.invoke("vps:install-dependency", payload, dependencyId),
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
    listDiscoveredHosts: () => ipcRenderer.invoke("vps:discover-hosts"),
    deleteConnection: (id: string) => ipcRenderer.invoke("vps:delete", id),
  },
  bitcoin: {
    getPrice: () => ipcRenderer.invoke("bitcoin:get-price"),
  },
}

contextBridge.exposeInMainWorld("digwis", api)
