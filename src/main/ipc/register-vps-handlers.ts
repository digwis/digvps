import { ipcMain } from "electron"
import {
  createAndInstallSshKey,
} from "../services/ssh-key-setup"
import {
  browseRemoteFiles,
  createRemoteDirectory,
  deleteRemoteEntry,
  downloadRemoteEntry,
  pickAndUploadRemoteEntries,
  readRemoteTextFile,
  renameRemoteEntry,
  writeRemoteTextFile,
} from "../services/remote-files"
import {
  deleteConnection,
  importDiscoveredConnections,
  listConnections,
  saveConnection,
} from "../services/db"
import {
  createSshConfigCandidate,
  deleteSshConfigCandidate,
  discoverKnownHosts,
  discoverLocalConnections,
  getRawSshConfig,
  listSshConfigCandidates,
  saveRawSshConfig,
  updateSshConfigCandidate,
} from "../services/discovery"
import { testConnection } from "../services/ssh"
import { installRemoteDependency, uninstallRemoteDependency } from "../services/dependency-install"
import { inspectDependencyUsage } from "../services/dependency-usage"
import { runDependencyServiceAction } from "../services/service-control"
import { inspectConnection } from "../services/inspection"
import { applySystemUpgrade, checkSystemUpgrades } from "../services/system-upgrade"
import { ensureSavedPayload, resolveStoredPayload } from "./helpers"
import { requireResolvedConnection, requireSenderWindow, runConnectionHealthTracked } from "./vps-runtime"
import type { DependencyServiceAction, SshConfigMutationInput, VpsConnectionInput } from "../../shared/vps"

export function registerVpsHandlers() {
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
    return saveConnection(ensureSavedPayload(payload))
  })

  ipcMain.handle("vps:create-and-install-ssh-key", async (_event, payload: VpsConnectionInput) => {
    return await createAndInstallSshKey(ensureSavedPayload(payload))
  })

  ipcMain.handle("vps:files:browse", async (_event, payload: { connectionId: string; path?: string; forceRefresh?: boolean }) => {
    const connection = requireResolvedConnection(payload.connectionId)
    return await browseRemoteFiles(connection, payload.path, {
      forceRefresh: payload.forceRefresh,
    })
  })

  ipcMain.handle("vps:files:read-text", async (_event, payload: { connectionId: string; path: string }) => {
    const connection = requireResolvedConnection(payload.connectionId)
    return await readRemoteTextFile(connection, payload.path)
  })

  ipcMain.handle(
    "vps:files:write-text",
    async (_event, payload: { connectionId: string; path: string; content: string }) => {
      const connection = requireResolvedConnection(payload.connectionId)
      return await writeRemoteTextFile(connection, payload.path, payload.content)
    },
  )

  ipcMain.handle(
    "vps:files:create-directory",
    async (_event, payload: { connectionId: string; parentPath: string; directoryName: string }) => {
      const connection = requireResolvedConnection(payload.connectionId)
      return await createRemoteDirectory(connection, payload.parentPath, payload.directoryName)
    },
  )

  ipcMain.handle(
    "vps:files:rename",
    async (_event, payload: { connectionId: string; path: string; nextName: string }) => {
      const connection = requireResolvedConnection(payload.connectionId)
      return await renameRemoteEntry(connection, payload.path, payload.nextName)
    },
  )

  ipcMain.handle("vps:files:delete", async (_event, payload: { connectionId: string; path: string }) => {
    const connection = requireResolvedConnection(payload.connectionId)
    return await deleteRemoteEntry(connection, payload.path)
  })

  ipcMain.handle("vps:files:upload", async (event, payload: { connectionId: string; remotePath: string }) => {
    const connection = requireResolvedConnection(payload.connectionId)
    const window = requireSenderWindow(event.sender)
    return await pickAndUploadRemoteEntries(window, connection, payload.remotePath)
  })

  ipcMain.handle(
    "vps:files:download",
    async (
      event,
      payload: { connectionId: string; path: string; name: string; type: "file" | "directory" | "symlink" },
    ) => {
      const connection = requireResolvedConnection(payload.connectionId)
      const window = requireSenderWindow(event.sender)
      return await downloadRemoteEntry(window, connection, payload)
    },
  )

  ipcMain.handle("vps:test", async (_event, payload: VpsConnectionInput) => {
    return await runConnectionHealthTracked(payload, testConnection, "未知错误")
  })

  ipcMain.handle("vps:install-dependency", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    return installRemoteDependency(resolveStoredPayload(payload), dependencyId)
  })

  ipcMain.handle("vps:inspect-dependency-usage", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    return inspectDependencyUsage(resolveStoredPayload(payload), dependencyId)
  })

  ipcMain.handle("vps:uninstall-dependency", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    return uninstallRemoteDependency(resolveStoredPayload(payload), dependencyId)
  })

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
    return await runConnectionHealthTracked(
      payload,
      async (connection) => await inspectConnection(connection, options),
      "环境检测失败",
    )
  })

  ipcMain.handle("vps:upgrade-check", async (_event, payload: VpsConnectionInput) => {
    return checkSystemUpgrades(resolveStoredPayload(payload))
  })

  ipcMain.handle("vps:upgrade-apply", async (_event, payload: VpsConnectionInput, options: { reboot: boolean }) => {
    return applySystemUpgrade(resolveStoredPayload(payload), options)
  })

  ipcMain.handle("vps:delete", async (_event, id: string) => {
    deleteConnection(id)
    return { success: true as const }
  })
}
