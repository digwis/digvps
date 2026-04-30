import { } from "electron"
import {
  createAndInstallSshKey,
} from "../services/ssh-key-setup"
import {
  browseRemoteFiles,
  changeRemotePermissions,
  createRemoteDirectory,
  deleteRemoteEntry,
  downloadRemoteEntry,
  listRemoteTrash,
  pickAndUploadRemoteEntries,
  purgeRemoteTrashEntry,
  readRemoteTextFile,
  renameRemoteEntry,
  restoreRemoteTrashEntry,
  statRemoteEntry,
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
import { registerIpcHandle } from "./ipc-error"
import {
  connectionIdSchema,
  dependencyServiceSchema,
  forceRefreshOptionsSchema,
  parseOrThrow,
  rawSshConfigSaveSchema,
  remoteBrowseSchema,
  remoteCreateDirectorySchema,
  remoteDownloadSchema,
  remotePermissionSchema,
  remoteReadSchema,
  remoteRenameSchema,
  remoteTrashEntrySchema,
  remoteUploadSchema,
  remoteWriteSchema,
  sshConfigDeleteSchema,
  sshConfigMutationSchema,
  upgradeApplySchema,
  vpsConnectionInputSchema,
} from "./schemas"
import { requireResolvedConnection, requireSenderWindow, runConnectionHealthTracked } from "./vps-runtime"
import type { DependencyServiceAction, SshConfigMutationInput, VpsConnectionInput } from "../../shared/vps"

export function registerVpsHandlers() {
  registerIpcHandle("vps:list", async () => {
    return listConnections()
  })

  registerIpcHandle("vps:import-local", async () => {
    return importDiscoveredConnections(discoverLocalConnections())
  })

  registerIpcHandle("vps:list-ssh-config-candidates", async () => {
    return listSshConfigCandidates()
  })

  registerIpcHandle("vps:get-raw-ssh-config", async () => {
    return getRawSshConfig()
  })

  registerIpcHandle("vps:save-raw-ssh-config", async (_event, payload: { content: string }) => {
    payload = parseOrThrow(rawSshConfigSaveSchema, payload)
    return saveRawSshConfig(payload.content)
  })

  registerIpcHandle("vps:create-ssh-config-candidate", async (_event, payload: SshConfigMutationInput) => {
    return createSshConfigCandidate(parseOrThrow(sshConfigMutationSchema, payload))
  })

  registerIpcHandle("vps:update-ssh-config-candidate", async (_event, payload: SshConfigMutationInput) => {
    return updateSshConfigCandidate(parseOrThrow(sshConfigMutationSchema, payload))
  })

  registerIpcHandle(
    "vps:delete-ssh-config-candidate",
    async (_event, payload: { configPath: string; originalName: string }) => {
      return deleteSshConfigCandidate(parseOrThrow(sshConfigDeleteSchema, payload))
    },
  )

  registerIpcHandle("vps:discover-hosts", async () => {
    const connections = listConnections()
    return discoverKnownHosts(
      connections.map((item) => ({
        host: item.host,
        port: item.port,
      })),
    )
  })

  registerIpcHandle("vps:save", async (_event, payload: VpsConnectionInput) => {
    return saveConnection(ensureSavedPayload(parseOrThrow(vpsConnectionInputSchema, payload)))
  })

  registerIpcHandle("vps:create-and-install-ssh-key", async (_event, payload: VpsConnectionInput) => {
    return await createAndInstallSshKey(ensureSavedPayload(parseOrThrow(vpsConnectionInputSchema, payload)))
  })

  registerIpcHandle("vps:files:browse", async (_event, payload: { connectionId: string; path?: string; forceRefresh?: boolean }) => {
    payload = parseOrThrow(remoteBrowseSchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await browseRemoteFiles(connection, payload.path, {
      forceRefresh: payload.forceRefresh,
    })
  })

  registerIpcHandle("vps:files:read-text", async (_event, payload: { connectionId: string; path: string }) => {
    payload = parseOrThrow(remoteReadSchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await readRemoteTextFile(connection, payload.path)
  })

  registerIpcHandle("vps:files:stat", async (_event, payload: { connectionId: string; path: string }) => {
    payload = parseOrThrow(remoteReadSchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await statRemoteEntry(connection, payload.path)
  })

  registerIpcHandle(
    "vps:files:write-text",
    async (_event, payload: { connectionId: string; path: string; content: string }) => {
      payload = parseOrThrow(remoteWriteSchema, payload)
      const connection = requireResolvedConnection(payload.connectionId)
      return await writeRemoteTextFile(connection, payload.path, payload.content)
    },
  )

  registerIpcHandle(
    "vps:files:create-directory",
    async (_event, payload: { connectionId: string; parentPath: string; directoryName: string }) => {
      payload = parseOrThrow(remoteCreateDirectorySchema, payload)
      const connection = requireResolvedConnection(payload.connectionId)
      return await createRemoteDirectory(connection, payload.parentPath, payload.directoryName)
    },
  )

  registerIpcHandle(
    "vps:files:rename",
    async (_event, payload: { connectionId: string; path: string; nextName: string }) => {
      payload = parseOrThrow(remoteRenameSchema, payload)
      const connection = requireResolvedConnection(payload.connectionId)
      return await renameRemoteEntry(connection, payload.path, payload.nextName)
    },
  )

  registerIpcHandle(
    "vps:files:chmod",
    async (_event, payload: { connectionId: string; path: string; mode: string; recursive?: boolean }) => {
      payload = parseOrThrow(remotePermissionSchema, payload)
      const connection = requireResolvedConnection(payload.connectionId)
      return await changeRemotePermissions(connection, payload.path, payload.mode, payload.recursive)
    },
  )

  registerIpcHandle("vps:files:delete", async (_event, payload: { connectionId: string; path: string }) => {
    payload = parseOrThrow(remoteReadSchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await deleteRemoteEntry(connection, payload.path)
  })

  registerIpcHandle("vps:files:trash:list", async (_event, payload: { connectionId: string }) => {
    const connectionId = parseOrThrow(connectionIdSchema, payload.connectionId)
    const connection = requireResolvedConnection(connectionId)
    return await listRemoteTrash(connection)
  })

  registerIpcHandle("vps:files:trash:restore", async (_event, payload: { connectionId: string; trashId: string }) => {
    payload = parseOrThrow(remoteTrashEntrySchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await restoreRemoteTrashEntry(connection, payload.trashId)
  })

  registerIpcHandle("vps:files:trash:purge", async (_event, payload: { connectionId: string; trashId: string }) => {
    payload = parseOrThrow(remoteTrashEntrySchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    return await purgeRemoteTrashEntry(connection, payload.trashId)
  })

  registerIpcHandle("vps:files:upload", async (event, payload: { connectionId: string; remotePath: string }) => {
    payload = parseOrThrow(remoteUploadSchema, payload)
    const connection = requireResolvedConnection(payload.connectionId)
    const window = requireSenderWindow(event.sender)
    return await pickAndUploadRemoteEntries(window, connection, payload.remotePath)
  })

  registerIpcHandle(
    "vps:files:download",
    async (
      event,
      payload: { connectionId: string; path: string; name: string; type: "file" | "directory" | "symlink" },
    ) => {
      payload = parseOrThrow(remoteDownloadSchema, payload)
      const connection = requireResolvedConnection(payload.connectionId)
      const window = requireSenderWindow(event.sender)
      return await downloadRemoteEntry(window, connection, payload)
    },
  )

  registerIpcHandle("vps:test", async (_event, payload: VpsConnectionInput) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    return await runConnectionHealthTracked(payload, testConnection, "未知错误")
  })

  registerIpcHandle("vps:install-dependency", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    dependencyId = parseOrThrow(connectionIdSchema, dependencyId)
    return installRemoteDependency(resolveStoredPayload(payload), dependencyId)
  })

  registerIpcHandle("vps:inspect-dependency-usage", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    dependencyId = parseOrThrow(connectionIdSchema, dependencyId)
    return inspectDependencyUsage(resolveStoredPayload(payload), dependencyId)
  })

  registerIpcHandle("vps:uninstall-dependency", async (_event, payload: VpsConnectionInput, dependencyId: string) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    dependencyId = parseOrThrow(connectionIdSchema, dependencyId)
    return uninstallRemoteDependency(resolveStoredPayload(payload), dependencyId)
  })

  registerIpcHandle(
    "vps:dependency-service",
    async (
      _event,
      payload: VpsConnectionInput,
      options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
    ) => {
      payload = parseOrThrow(vpsConnectionInputSchema, payload)
      options = parseOrThrow(dependencyServiceSchema, options)
      return runDependencyServiceAction(resolveStoredPayload(payload), options)
    },
  )

  registerIpcHandle("vps:inspect", async (_event, payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    options = parseOrThrow(forceRefreshOptionsSchema, options)
    return await runConnectionHealthTracked(
      payload,
      async (connection) => await inspectConnection(connection, options),
      "环境检测失败",
    )
  })

  registerIpcHandle("vps:upgrade-check", async (_event, payload: VpsConnectionInput) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    return checkSystemUpgrades(resolveStoredPayload(payload))
  })

  registerIpcHandle("vps:upgrade-apply", async (_event, payload: VpsConnectionInput, options: { reboot: boolean }) => {
    payload = parseOrThrow(vpsConnectionInputSchema, payload)
    options = parseOrThrow(upgradeApplySchema, options)
    return applySystemUpgrade(resolveStoredPayload(payload), options)
  })

  registerIpcHandle("vps:delete", async (_event, id: string) => {
    id = parseOrThrow(connectionIdSchema, id)
    deleteConnection(id)
    return { success: true as const }
  })
}
