// Tauri implementation of the DigwisApi surface.
// Command names mirror the old Electron IPC channels (":" → "_") and every
// argument/return payload keeps the same camelCase shape the renderer expects.
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type {
  DigwisApi,
  SshConfigMutationInput,
  VpsConnectionInput,
  TerminalCreateInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalCloseInput,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
} from "../../../shared/vps"
import type {
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
} from "../../../shared/projects"

function onEvent<T>(channel: string, handler: (event: T) => void): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  const pending = listen<T>(channel, (event) => {
    handler(event.payload)
  }).then((fn) => {
    if (disposed) {
      fn()
    } else {
      unlisten = fn
    }
  })
  return () => {
    disposed = true
    if (unlisten) {
      unlisten()
    } else {
      void pending
    }
  }
}

export function createTauriApi(): DigwisApi {
  return {
    settings: {
      getDefaultRemoteDirectory: () => invoke("settings_get_default_remote_directory"),
      setDefaultRemoteDirectory: (value: string) =>
        invoke("settings_set_default_remote_directory", { value }),
    },
    projects: {
      listProjects: () => invoke("projects_list"),
      addProjectFromPath: (payload: LocalProjectInput) =>
        invoke("projects_add", { payload }),
      createProjectScaffold: (payload: ProjectScaffoldInput) =>
        invoke("projects_create_scaffold", { payload }),
      scanRemoteProjects: (payload: { connectionId: string }) =>
        invoke("projects_scan_remote", { connectionId: payload.connectionId }),
      onScaffoldProgress: (handler: (event: ProjectScaffoldProgressEvent) => void) =>
        onEvent<ProjectScaffoldProgressEvent>("projects:scaffold-progress", handler),
      updateProjectLocalPath: (payload: ProjectLocalPathUpdateInput) =>
        invoke("projects_update_local_path", { payload }),
      getProjectConfig: (projectId: string) =>
        invoke("projects_get_config", { projectId }),
      setProjectRuntimeModules: (payload: ProjectRuntimeModulesUpdateInput) =>
        invoke("projects_set_runtime_modules", { payload }),
      deleteProject: (payload: ProjectDeleteInput) =>
        invoke("projects_delete", { payload }),
      pickProjectDirectory: () => invoke("projects_pick_directory"),
      listNpmScripts: (projectId: string) =>
        invoke("projects_list_npm_scripts", { projectId }),
      getProjectLocalPreview: (projectId: string) =>
        invoke("projects_get_local_preview", { projectId }),
      openProjectLocalPreview: (projectId: string) =>
        invoke("projects_open_local_preview", { projectId }),
      openProjectLocalAdmin: (projectId: string) =>
        invoke("projects_open_local_admin", { projectId }),
      startProjectLocalDev: (projectId: string) =>
        invoke("projects_start_local_dev", { projectId }),
      startProjectLocalAdminService: (projectId: string) =>
        invoke("projects_start_local_admin_service", { projectId }),
      checkProjectUrlReachable: (url: string) =>
        invoke("projects_check_url_reachable", { url }),
      openProjectClientAppPath: (payload: ProjectClientAppInput) =>
        invoke("projects_open_client_app_path", { payload }),
      startProjectClientApp: (payload: ProjectClientAppInput) =>
        invoke("projects_start_client_app", { payload }),
      openProjectClientAppIde: (payload: ProjectClientAppInput) =>
        invoke("projects_open_client_app_ide", { payload }),
      getDeployProfile: (projectId: string) =>
        invoke("projects_get_deploy_profile", { projectId }),
      getProjectRemoteState: (payload: ProjectRemoteStateInput) =>
        invoke("projects_get_remote_state", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      getProjectRemoteDetails: (payload: ProjectRemoteDetailsInput) =>
        invoke("projects_get_remote_details", { payload }),
      getProjectEnv: (payload: ProjectEnvInput) =>
        invoke("projects_get_env", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      saveProjectEnv: (payload: ProjectEnvUpdateInput) =>
        invoke("projects_save_env", { payload }),
      rotateProjectSecret: (payload: ProjectEnvInput) =>
        invoke("projects_rotate_secret", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      restartProjectService: (payload: ProjectEnvInput) =>
        invoke("projects_restart_service", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      stopProjectService: (payload: ProjectEnvInput) =>
        invoke("projects_stop_service", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      saveProjectSiteSettings: (payload: ProjectSiteSettingsInput) =>
        invoke("projects_save_site_settings", { payload }),
      initializeProject: (payload: ProjectInitializeInput) =>
        invoke("projects_initialize", {
          projectId: payload.projectId,
          connectionId: payload.connectionId,
        }),
      deployProject: (payload: ProjectDeployInput) =>
        invoke("projects_deploy", { payload }),
      getProjectActionHints: (projectId: string) =>
        invoke("projects_get_action_hints", { projectId }),
      migrateProject: (payload: ProjectMigrationInput) =>
        invoke("projects_migrate", { payload }),
      listOperationLogs: (payload?: { limit?: number }) =>
        invoke("projects_list_operation_logs", { limit: payload?.limit }),
      appendProjectOperationLog: (payload: ProjectOperationLogAppendInput) =>
        invoke("projects_append_operation_log", { payload }),
      onDeployLog: (handler: (event: ProjectDeployLogEvent) => void) =>
        onEvent<ProjectDeployLogEvent>("projects:deploy-log", handler),
    },
    terminal: {
      createSession: (payload: TerminalCreateInput) =>
        invoke("terminal_create", { payload }),
      writeInput: (payload: TerminalWriteInput) =>
        invoke("terminal_write", { payload }),
      resize: (payload: TerminalResizeInput) =>
        invoke("terminal_resize", { payload }),
      closeSession: (payload: TerminalCloseInput) =>
        invoke("terminal_close", { payload }),
      onData: (handler: (event: TerminalDataEvent) => void) =>
        onEvent<TerminalDataEvent>("terminal:data", handler),
      onExit: (handler: (event: TerminalExitEvent) => void) =>
        onEvent<TerminalExitEvent>("terminal:exit", handler),
      onError: (handler: (event: TerminalErrorEvent) => void) =>
        onEvent<TerminalErrorEvent>("terminal:error", handler),
    },
    vps: {
      listConnections: () => invoke("vps_list"),
      saveConnection: (payload: VpsConnectionInput) =>
        invoke("vps_save", { payload }),
      testConnection: (payload: VpsConnectionInput) =>
        invoke("vps_test", { payload }),
      inspectConnection: (payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) =>
        invoke("vps_inspect", { payload, forceRefresh: options?.forceRefresh }),
      checkSystemUpgrades: (payload: VpsConnectionInput) =>
        invoke("vps_upgrade_check", { payload }),
      applySystemUpgrade: (payload: VpsConnectionInput, options: { reboot: boolean }) =>
        invoke("vps_upgrade_apply", { payload, reboot: options.reboot }),
      importLocalConnections: () => invoke("vps_import_local"),
      listSshConfigCandidates: () => invoke("vps_list_ssh_config_candidates"),
      getRawSshConfig: () => invoke("vps_get_raw_ssh_config"),
      saveRawSshConfig: (payload: { content: string }) =>
        invoke("vps_save_raw_ssh_config", { content: payload.content }),
      createSshConfigCandidate: (payload: SshConfigMutationInput) =>
        invoke("vps_create_ssh_config_candidate", { payload }),
      updateSshConfigCandidate: (payload: SshConfigMutationInput) =>
        invoke("vps_update_ssh_config_candidate", { payload }),
      deleteSshConfigCandidate: (payload: { configPath: string; originalName: string }) =>
        invoke("vps_delete_ssh_config_candidate", {
          configPath: payload.configPath,
          originalName: payload.originalName,
        }),
      listDiscoveredHosts: () => invoke("vps_discover_hosts"),
      deleteConnection: (id: string) => invoke("vps_delete", { id }),
      createAndInstallSshKey: (payload: VpsConnectionInput) =>
        invoke("vps_create_and_install_ssh_key", { payload }),
      browseRemoteFiles: (payload: { connectionId: string; path?: string; forceRefresh?: boolean }) =>
        invoke("vps_files_browse", {
          connectionId: payload.connectionId,
          path: payload.path,
          forceRefresh: payload.forceRefresh,
        }),
      statRemoteEntry: (payload: { connectionId: string; path: string }) =>
        invoke("vps_files_stat", { connectionId: payload.connectionId, path: payload.path }),
      readRemoteTextFile: (payload: { connectionId: string; path: string }) =>
        invoke("vps_files_read_text", { connectionId: payload.connectionId, path: payload.path }),
      writeRemoteTextFile: (payload: { connectionId: string; path: string; content: string }) =>
        invoke("vps_files_write_text", {
          connectionId: payload.connectionId,
          path: payload.path,
          content: payload.content,
        }),
      createRemoteDirectory: (payload: { connectionId: string; parentPath: string; directoryName: string }) =>
        invoke("vps_files_create_directory", {
          connectionId: payload.connectionId,
          parentPath: payload.parentPath,
          directoryName: payload.directoryName,
        }),
      renameRemoteEntry: (payload: { connectionId: string; path: string; nextName: string }) =>
        invoke("vps_files_rename", {
          connectionId: payload.connectionId,
          path: payload.path,
          nextName: payload.nextName,
        }),
      changeRemotePermissions: (payload: { connectionId: string; path: string; mode: string; recursive?: boolean }) =>
        invoke("vps_files_chmod", {
          connectionId: payload.connectionId,
          path: payload.path,
          mode: payload.mode,
          recursive: payload.recursive,
        }),
      deleteRemoteEntry: (payload: { connectionId: string; path: string }) =>
        invoke("vps_files_delete", { connectionId: payload.connectionId, path: payload.path }),
      listRemoteTrash: (payload: { connectionId: string }) =>
        invoke("vps_files_trash_list", { connectionId: payload.connectionId }),
      restoreRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) =>
        invoke("vps_files_trash_restore", {
          connectionId: payload.connectionId,
          trashId: payload.trashId,
        }),
      purgeRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) =>
        invoke("vps_files_trash_purge", {
          connectionId: payload.connectionId,
          trashId: payload.trashId,
        }),
      uploadRemoteEntries: (payload: { connectionId: string; remotePath: string }) =>
        invoke("vps_files_upload", {
          connectionId: payload.connectionId,
          remotePath: payload.remotePath,
        }),
      downloadRemoteEntry: (payload: { connectionId: string; path: string; name: string; type: "file" | "directory" | "symlink" }) =>
        invoke("vps_files_download", {
          connectionId: payload.connectionId,
          input: { path: payload.path, name: payload.name, type: payload.type },
        }),
    },
    bitcoin: {
      getPrice: () => invoke("bitcoin_get_price"),
    },
  }
}
