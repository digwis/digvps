import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  ConnectionTestResult,
  DiscoveredHostCandidate,
  RawSshConfigFile,
  SshConfigCandidate,
  SshConfigMutationInput,
  SystemUpgradeApplyResult,
  SystemUpgradeCheckResult,
  VpsInspection,
  VpsConnectionInput,
  VpsConnectionRecord,
} from "../../../shared/vps"

type VpsOperationLogEntry = {
  id: string
  at: string
  level: "info" | "error"
  title: string
  detail: string
}

const LAST_SELECTED_CONNECTION_KEY = "openvps:last-selected-connection-id"
const INSPECTION_CACHE_KEY = "openvps:inspection-cache"
const DISMISSED_UPGRADE_PROMPTS_KEY = "openvps:dismissed-upgrade-prompts"
const INSPECTION_CACHE_TTL_MS = 30 * 60_000
const UPGRADE_STATUS_TTL_MS = 24 * 60 * 60_000

function connectionDisplayKey(connection: VpsConnectionRecord) {
  return [
    connection.name.trim().toLowerCase(),
    connection.host.trim().toLowerCase(),
    String(connection.port),
    connection.username.trim().toLowerCase(),
  ].join("::")
}

function compareConnectionPriority(left: VpsConnectionRecord, right: VpsConnectionRecord) {
  if (left.authType !== right.authType) {
    return left.authType === "privateKey" ? -1 : 1
  }
  if ((left.source ?? "manual") !== (right.source ?? "manual")) {
    return left.source === "ssh-config" ? -1 : 1
  }
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
}

function mergeConnectionPresentation(
  preferred: VpsConnectionRecord,
  group: VpsConnectionRecord[],
): VpsConnectionRecord {
  const byRecency = [...group].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )
  const provider = preferred.provider?.trim() || byRecency.find((item) => item.provider?.trim())?.provider
  const locationLabel =
    preferred.locationLabel?.trim() || byRecency.find((item) => item.locationLabel?.trim())?.locationLabel
  const expiresAt =
    preferred.expiresAt?.trim() || byRecency.find((item) => item.expiresAt?.trim())?.expiresAt
  return {
    ...preferred,
    provider,
    locationLabel,
    expiresAt,
  }
}

function collapseConnections(connections: VpsConnectionRecord[]) {
  const grouped = new Map<string, VpsConnectionRecord[]>()
  for (const connection of connections) {
    const key = connectionDisplayKey(connection)
    const current = grouped.get(key) ?? []
    current.push(connection)
    grouped.set(key, current)
  }

  const hiddenIds = new Set<string>()
  const preferredByHiddenId = new Map<string, string>()

  const visibleConnections = connections.filter((connection) => {
    const group = grouped.get(connectionDisplayKey(connection)) ?? [connection]
    const preferred = [...group].sort(compareConnectionPriority)[0] ?? connection
    const hasPrivateKey = group.some((item) => item.authType === "privateKey")
    const shouldHidePassword = hasPrivateKey && connection.authType === "password" && preferred.id !== connection.id
    if (shouldHidePassword) {
      hiddenIds.add(connection.id)
      preferredByHiddenId.set(connection.id, preferred.id)
      return false
    }
    return true
  }).map((connection) => {
    const group = grouped.get(connectionDisplayKey(connection)) ?? [connection]
    return mergeConnectionPresentation(connection, group)
  })

  return { visibleConnections, preferredByHiddenId, hiddenIds }
}

function resolveSelectedConnectionId(
  connections: VpsConnectionRecord[],
  previousId?: string,
  preferredByHiddenId?: Map<string, string>,
) {
  if (previousId) {
    const remapped = preferredByHiddenId?.get(previousId) ?? previousId
    if (connections.some((item) => item.id === remapped)) {
      return remapped
    }
  }
  return connections[0]?.id
}

function readLastSelectedConnectionId() {
  try {
    return window.localStorage.getItem(LAST_SELECTED_CONNECTION_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeLastSelectedConnectionId(id?: string) {
  try {
    if (id) {
      window.localStorage.setItem(LAST_SELECTED_CONNECTION_KEY, id)
    } else {
      window.localStorage.removeItem(LAST_SELECTED_CONNECTION_KEY)
    }
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function readInspectionCache() {
  try {
    const raw = window.localStorage.getItem(INSPECTION_CACHE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, VpsInspection>
    if (!parsed || typeof parsed !== "object") {
      return {}
    }
    const now = Date.now()
    return Object.fromEntries(
      Object.entries(parsed).filter(([, inspection]) => {
        const checkedAt = new Date(inspection.checkedAt).getTime()
        return Number.isFinite(checkedAt) && now - checkedAt <= INSPECTION_CACHE_TTL_MS
      }),
    )
  } catch {
    return {}
  }
}

function writeInspectionCache(connectionId: string, inspection: VpsInspection) {
  try {
    const nextCache = readInspectionCache()
    nextCache[connectionId] = inspection
    window.localStorage.setItem(INSPECTION_CACHE_KEY, JSON.stringify(nextCache))
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function getCachedInspection(connectionId?: string) {
  if (!connectionId) {
    return undefined
  }
  const cached = readInspectionCache()[connectionId]
  return cached
}

function buildUpgradePromptSignature(status: SystemUpgradeCheckResult) {
  return [status.manager, String(status.upgradableCount), status.indexRefreshed ? "1" : "0"].join(":")
}

function readDismissedUpgradePrompts() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_UPGRADE_PROMPTS_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeDismissedUpgradePrompts(map: Record<string, string>) {
  try {
    if (Object.keys(map).length === 0) {
      window.localStorage.removeItem(DISMISSED_UPGRADE_PROMPTS_KEY)
      return
    }
    window.localStorage.setItem(DISMISSED_UPGRADE_PROMPTS_KEY, JSON.stringify(map))
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function appendOperationLog(
  items: VpsOperationLogEntry[],
  entry: VpsOperationLogEntry,
) {
  return [...items, entry].slice(-60)
}

function isUpgradeStatusFresh(checkedAt?: string) {
  if (!checkedAt) {
    return false
  }
  const checkedAtMs = new Date(checkedAt).getTime()
  return Number.isFinite(checkedAtMs) && Date.now() - checkedAtMs <= UPGRADE_STATUS_TTL_MS
}

type VpsState = {
  connections: VpsConnectionRecord[]
  discoveredHosts: DiscoveredHostCandidate[]
  sshConfigCandidates: SshConfigCandidate[]
  rawSshConfig?: RawSshConfigFile
  selectedConnectionId?: string
  inspection?: VpsInspection
  isLoading: boolean
  isSaving: boolean
  isTesting: boolean
  isInspecting: boolean
  isImportingLocal: boolean
  isDiscoveringHosts: boolean
  isLoadingSshConfigCandidates: boolean
  isUpdatingSshConfigCandidate: boolean
  isDeletingSshConfigCandidate: boolean
  isSavingRawSshConfig: boolean
  isCheckingUpgrade: boolean
  isCheckingAllUpgrades: boolean
  isApplyingUpgrade: boolean
  upgradePrompt?: SystemUpgradeCheckResult
  upgradePromptForConnectionId?: string
  upgradePromptSource?: "auto" | "manual"
  upgradeStatusMap: Record<string, SystemUpgradeCheckResult>
  upgradeStatusCheckedAtMap: Record<string, string>
  dismissedUpgradePromptMap: Record<string, string>
  operationLogs: VpsOperationLogEntry[]
  info?: string
  lastTestResult?: ConnectionTestResult
  error?: string
  loadConnections: () => Promise<void>
  prewarmInspectionCache: (connectionIds?: string[]) => Promise<void>
  loadDiscoveredHosts: () => Promise<void>
  loadSshConfigCandidates: () => Promise<void>
  loadRawSshConfig: () => Promise<RawSshConfigFile | undefined>
  saveRawSshConfig: (payload: { content: string }) => Promise<RawSshConfigFile>
  createSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
  updateSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
  deleteSshConfigCandidate: (payload: { configPath: string; originalName: string }) => Promise<SshConfigCandidate[]>
  saveConnection: (payload: VpsConnectionInput) => Promise<VpsConnectionRecord>
  testConnection: (payload: VpsConnectionInput) => Promise<ConnectionTestResult>
  inspectConnection: (
    payload: VpsConnectionInput,
    options?: { forceRefresh?: boolean; backgroundRefresh?: boolean },
  ) => Promise<VpsInspection>
  checkSystemUpgradesAfterInspect: (payload: VpsConnectionInput) => Promise<void>
  checkAllConnectionsUpgrades: () => Promise<void>
  reopenUpgradePrompt: (connectionId: string) => void
  dismissUpgradePrompt: () => void
  applyRemoteSystemUpgrade: (
    payload: VpsConnectionInput,
    options: { reboot: boolean },
  ) => Promise<SystemUpgradeApplyResult>
  importLocalConnections: () => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  selectConnection: (id: string) => void
  clearOperationLogs: () => void
  clearFeedback: () => void
}

export const useVpsStore = create<VpsState>((set, get) => ({
  connections: [],
  discoveredHosts: [],
  sshConfigCandidates: [],
  rawSshConfig: undefined,
  selectedConnectionId: readLastSelectedConnectionId(),
  inspection: undefined,
  isLoading: false,
  isSaving: false,
  isTesting: false,
  isInspecting: false,
  isImportingLocal: false,
  isDiscoveringHosts: false,
  isLoadingSshConfigCandidates: false,
  isUpdatingSshConfigCandidate: false,
  isDeletingSshConfigCandidate: false,
  isSavingRawSshConfig: false,
  isCheckingUpgrade: false,
  isCheckingAllUpgrades: false,
  isApplyingUpgrade: false,
  upgradePrompt: undefined,
  upgradePromptForConnectionId: undefined,
  upgradePromptSource: undefined,
  upgradeStatusMap: {},
  upgradeStatusCheckedAtMap: {},
  dismissedUpgradePromptMap: readDismissedUpgradePrompts(),
  operationLogs: [],
  info: undefined,
  error: undefined,
  lastTestResult: undefined,
  loadConnections: async () => {
    set({ isLoading: true, error: undefined })
    try {
      const allConnections = await getDesktopApi().vps.listConnections()
      const { visibleConnections, preferredByHiddenId } = collapseConnections(allConnections)
      const selectedConnectionId = resolveSelectedConnectionId(
        visibleConnections,
        get().selectedConnectionId,
        preferredByHiddenId,
      )
      writeLastSelectedConnectionId(selectedConnectionId)
      set({
        connections: visibleConnections,
        isLoading: false,
        selectedConnectionId,
        inspection: getCachedInspection(selectedConnectionId) ?? get().inspection,
      })
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "Failed to load connections",
      })
    }
  },
  prewarmInspectionCache: async (connectionIds) => {
    const selectedConnectionId = get().selectedConnectionId
    const targets = get().connections.filter((connection) => {
      if (connection.id === selectedConnectionId) {
        return false
      }
      if (connectionIds && connectionIds.length > 0 && !connectionIds.includes(connection.id)) {
        return false
      }
      return !getCachedInspection(connection.id)
    })

    if (targets.length === 0) {
      return
    }

    const PARALLEL_LIMIT = 4
    let cursor = 0
    const workers = Array.from({ length: Math.min(PARALLEL_LIMIT, targets.length) }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= targets.length) {
          return
        }
        const connection = targets[index]
        try {
          const inspection = await getDesktopApi().vps.inspectConnection(connection)
          writeInspectionCache(connection.id, inspection)
        } catch {
          // Ignore background prewarm errors.
        }
      }
    })
    await Promise.allSettled(workers)
  },
  loadDiscoveredHosts: async () => {
    set({ isDiscoveringHosts: true, error: undefined })
    try {
      const discoveredHosts = await getDesktopApi().vps.listDiscoveredHosts()
      set({ discoveredHosts, isDiscoveringHosts: false })
    } catch (error) {
      set({
        isDiscoveringHosts: false,
        error: error instanceof Error ? error.message : "Failed to load known hosts",
      })
    }
  },
  loadSshConfigCandidates: async () => {
    set({ isLoadingSshConfigCandidates: true, error: undefined })
    try {
      const sshConfigCandidates = await getDesktopApi().vps.listSshConfigCandidates()
      set({ sshConfigCandidates, isLoadingSshConfigCandidates: false })
      return
    } catch (error) {
      set({
        isLoadingSshConfigCandidates: false,
        error: error instanceof Error ? error.message : "Failed to read SSH config",
      })
    }
  },
  loadRawSshConfig: async () => {
    set({ error: undefined })
    try {
      const rawSshConfig = await getDesktopApi().vps.getRawSshConfig()
      set({ rawSshConfig })
      return rawSshConfig
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "SSH 配置读取失败",
      })
      return undefined
    }
  },
  saveRawSshConfig: async (payload) => {
    set({ isSavingRawSshConfig: true, error: undefined, info: undefined })
    try {
      const rawSshConfig = await getDesktopApi().vps.saveRawSshConfig(payload)
      const sshConfigCandidates = await getDesktopApi().vps.listSshConfigCandidates()
      set({
        rawSshConfig,
        sshConfigCandidates,
        isSavingRawSshConfig: false,
        info: "Local SSH config saved",
      })
      return rawSshConfig
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save SSH config"
      set({ isSavingRawSshConfig: false, error: message })
      throw error
    }
  },
  createSshConfigCandidate: async (payload) => {
    set({ isUpdatingSshConfigCandidate: true, error: undefined, info: undefined })
    try {
      const sshConfigCandidates = await getDesktopApi().vps.createSshConfigCandidate(payload)
      set({
        sshConfigCandidates,
        isUpdatingSshConfigCandidate: false,
        info: "Local SSH config entry added",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add SSH config entry"
      set({ isUpdatingSshConfigCandidate: false, error: message })
      throw error
    }
  },
  updateSshConfigCandidate: async (payload) => {
    set({ isUpdatingSshConfigCandidate: true, error: undefined, info: undefined })
    try {
      const sshConfigCandidates = await getDesktopApi().vps.updateSshConfigCandidate(payload)
      set({
        sshConfigCandidates,
        isUpdatingSshConfigCandidate: false,
        info: "Local SSH config updated",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update SSH config"
      set({ isUpdatingSshConfigCandidate: false, error: message })
      throw error
    }
  },
  deleteSshConfigCandidate: async (payload) => {
    set({ isDeletingSshConfigCandidate: true, error: undefined, info: undefined })
    try {
      const sshConfigCandidates = await getDesktopApi().vps.deleteSshConfigCandidate(payload)
      set({
        sshConfigCandidates,
        isDeletingSshConfigCandidate: false,
        info: "Local SSH config entry removed",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete SSH config"
      set({ isDeletingSshConfigCandidate: false, error: message })
      throw error
    }
  },
  saveConnection: async (payload) => {
    set({ isSaving: true, error: undefined, info: undefined })
    try {
      const connection = await getDesktopApi().vps.saveConnection(payload)
      const current = get().connections.filter((item) => item.id !== connection.id)
      const { visibleConnections, preferredByHiddenId, hiddenIds } = collapseConnections([connection, ...current])
      const selectedConnectionId = hiddenIds.has(connection.id)
        ? preferredByHiddenId.get(connection.id) ?? connection.id
        : connection.id
      set({
        connections: visibleConnections,
        selectedConnectionId,
        isSaving: false,
      })
      writeLastSelectedConnectionId(selectedConnectionId)
      return connection
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed"
      set({ isSaving: false, error: message })
      throw error
    }
  },
  testConnection: async (payload) => {
    set({ isTesting: true, error: undefined, info: undefined, lastTestResult: undefined })
    try {
      const result = await getDesktopApi().vps.testConnection(payload)
      set({ isTesting: false, lastTestResult: result })
      if (payload.id) {
        await get().loadConnections()
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed"
      set({ isTesting: false, error: message })
      if (payload.id) {
        await get().loadConnections()
      }
      throw error
    }
  },
  inspectConnection: async (payload, options) => {
    const cachedInspection =
      options?.backgroundRefresh && payload.id ? getCachedInspection(payload.id) : undefined
    if (cachedInspection && cachedInspection.connectionId === payload.id) {
      set({
        isInspecting: false,
        error: undefined,
        info: undefined,
        inspection: cachedInspection,
      })
      void (async () => {
        try {
          const inspection = await getDesktopApi().vps.inspectConnection(payload, { forceRefresh: true })
          if (payload.id) {
            writeInspectionCache(payload.id, inspection)
          }
          if (get().selectedConnectionId === payload.id) {
            set({ inspection })
          }
          if (payload.id) {
            await get().loadConnections()
          }
        } catch {
          // Keep showing the cached inspection when silent revalidation fails.
        }
      })()
      return cachedInspection
    }

    set({
      isInspecting: true,
      error: undefined,
      info: undefined,
    })
    try {
      const inspection = await getDesktopApi().vps.inspectConnection(payload, options)
      if (payload.id) {
        writeInspectionCache(payload.id, inspection)
      }
      set({ isInspecting: false, inspection })
      if (payload.id) {
        await get().loadConnections()
      }
      return inspection
    } catch (error) {
      const message = error instanceof Error ? error.message : "Inspection failed"
      const cachedInspection = getCachedInspection(payload.id)
      set({
        isInspecting: false,
        error: message,
        inspection:
          cachedInspection && cachedInspection.connectionId === (payload.id ?? "")
            ? cachedInspection
            : get().inspection,
      })
      if (payload.id) {
        await get().loadConnections()
      }
      throw error
    }
  },
  checkSystemUpgradesAfterInspect: async (payload) => {
    if (!payload.id) {
      return
    }
    const shouldShowPrompt = (status: SystemUpgradeCheckResult) =>
      status.supported &&
      status.upgradableCount > 0 &&
      get().dismissedUpgradePromptMap[payload.id!] !== buildUpgradePromptSignature(status)
    const preserveManualPrompt =
      get().upgradePromptSource === "manual" && get().upgradePromptForConnectionId === payload.id

    const cachedStatus = get().upgradeStatusMap[payload.id]
    const cachedCheckedAt = get().upgradeStatusCheckedAtMap[payload.id]
    if (cachedStatus && isUpgradeStatusFresh(cachedCheckedAt)) {
      if (payload.id === get().selectedConnectionId) {
        if (shouldShowPrompt(cachedStatus)) {
          set({
            upgradePrompt: cachedStatus,
            upgradePromptForConnectionId: payload.id,
            upgradePromptSource: "auto",
          })
        } else if (!preserveManualPrompt) {
          set({
            upgradePrompt: undefined,
            upgradePromptForConnectionId: undefined,
            upgradePromptSource: undefined,
          })
        }
      }
      return
    }
    set({ isCheckingUpgrade: true })
    try {
      const result = await getDesktopApi().vps.checkSystemUpgrades(payload)
      const checkedAt = new Date().toISOString()
      set((state) => ({
        upgradeStatusMap: {
          ...state.upgradeStatusMap,
          [payload.id!]: result,
        },
        upgradeStatusCheckedAtMap: {
          ...state.upgradeStatusCheckedAtMap,
          [payload.id!]: checkedAt,
        },
      }))
      if (payload.id !== get().selectedConnectionId) {
        return
      }
      if (shouldShowPrompt(result)) {
        set({
          upgradePrompt: result,
          upgradePromptForConnectionId: payload.id,
          upgradePromptSource: "auto",
        })
      } else if (!preserveManualPrompt) {
        set({
          upgradePrompt: undefined,
          upgradePromptForConnectionId: undefined,
          upgradePromptSource: undefined,
        })
      }
    } catch {
      if (!preserveManualPrompt) {
        set({
          upgradePrompt: undefined,
          upgradePromptForConnectionId: undefined,
          upgradePromptSource: undefined,
        })
      }
    } finally {
      set({ isCheckingUpgrade: false })
    }
  },
  checkAllConnectionsUpgrades: async () => {
    const connections = get().connections
    if (connections.length === 0) {
      return
    }
    const pendingConnections = connections.filter((conn) => !isUpgradeStatusFresh(get().upgradeStatusCheckedAtMap[conn.id]))
    if (pendingConnections.length === 0) {
      return
    }
    set({ isCheckingAllUpgrades: true })
    const newMap: Record<string, SystemUpgradeCheckResult> = {}
    const checkedAtMap: Record<string, string> = {}
    await Promise.allSettled(
      pendingConnections.map(async (conn) => {
        try {
          const result = await getDesktopApi().vps.checkSystemUpgrades(conn as VpsConnectionInput)
          newMap[conn.id] = result
          checkedAtMap[conn.id] = new Date().toISOString()
          set({
            upgradeStatusMap: { ...get().upgradeStatusMap, ...newMap },
            upgradeStatusCheckedAtMap: { ...get().upgradeStatusCheckedAtMap, ...checkedAtMap },
          })
        } catch {
          // 单个连接检查失败不影响其他连接
        }
      }),
    )
    set({
      upgradeStatusMap: { ...get().upgradeStatusMap, ...newMap },
      upgradeStatusCheckedAtMap: { ...get().upgradeStatusCheckedAtMap, ...checkedAtMap },
      isCheckingAllUpgrades: false,
    })
  },
  reopenUpgradePrompt: (connectionId) => {
    const status = get().upgradeStatusMap[connectionId]
    if (!status?.supported || status.upgradableCount <= 0) {
      return
    }
    set({
      upgradePrompt: status,
      upgradePromptForConnectionId: connectionId,
      upgradePromptSource: "manual",
    })
  },
  dismissUpgradePrompt: () =>
    set((state) => {
      const connectionId = state.upgradePromptForConnectionId
      const status = state.upgradePrompt
      if (!connectionId || !status) {
        return {
          upgradePrompt: undefined,
          upgradePromptForConnectionId: undefined,
          upgradePromptSource: undefined,
        }
      }
      if (state.upgradePromptSource === "manual") {
        return {
          upgradePrompt: undefined,
          upgradePromptForConnectionId: undefined,
          upgradePromptSource: undefined,
        }
      }
      const nextDismissedMap = {
        ...state.dismissedUpgradePromptMap,
        [connectionId]: buildUpgradePromptSignature(status),
      }
      writeDismissedUpgradePrompts(nextDismissedMap)
      return {
        upgradePrompt: undefined,
        upgradePromptForConnectionId: undefined,
        upgradePromptSource: undefined,
        dismissedUpgradePromptMap: nextDismissedMap,
      }
    }),
  applyRemoteSystemUpgrade: async (payload, options) => {
    set({ isApplyingUpgrade: true, error: undefined, info: undefined })
    try {
      const result = await getDesktopApi().vps.applySystemUpgrade(payload, options)
      if (!result.ok) {
        set({ isApplyingUpgrade: false, error: result.message })
        return result
      }
      const nextDismissedMap = { ...get().dismissedUpgradePromptMap }
      if (payload.id) {
        delete nextDismissedMap[payload.id]
        writeDismissedUpgradePrompts(nextDismissedMap)
      }
      set({
        isApplyingUpgrade: false,
        upgradePrompt: undefined,
        upgradePromptForConnectionId: undefined,
        upgradePromptSource: undefined,
        upgradeStatusMap: {
          ...get().upgradeStatusMap,
          [payload.id ?? ""]: { supported: true, manager: "none", upgradableCount: 0, indexRefreshed: false },
        },
        upgradeStatusCheckedAtMap: {
          ...get().upgradeStatusCheckedAtMap,
          [payload.id ?? ""]: new Date().toISOString(),
        },
        dismissedUpgradePromptMap: nextDismissedMap,
        info: result.message,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "System upgrade failed"
      set({ isApplyingUpgrade: false, error: message })
      throw error
    }
  },
  importLocalConnections: async () => {
    set({ isImportingLocal: true, error: undefined, info: undefined })
    try {
      const previousCount = get().connections.length
      const allConnections = await getDesktopApi().vps.importLocalConnections()
      const { visibleConnections, preferredByHiddenId } = collapseConnections(allConnections)
      await get().loadDiscoveredHosts()
      const selectedConnectionId = resolveSelectedConnectionId(
        visibleConnections,
        get().selectedConnectionId,
        preferredByHiddenId,
      )
      const addedCount = Math.max(visibleConnections.length - previousCount, 0)
      writeLastSelectedConnectionId(selectedConnectionId)
      set({ connections: visibleConnections, selectedConnectionId, isImportingLocal: false })
      set({
        info:
          addedCount > 0
            ? `Imported ${addedCount} connection(s) from local SSH config`
            : "Local SSH config synced, no new importable connections",
      })
    } catch (error) {
      set({
        isImportingLocal: false,
        error: error instanceof Error ? error.message : "Failed to import local SSH connections",
      })
      throw error
    }
  },
  deleteConnection: async (id) => {
    await getDesktopApi().vps.deleteConnection(id)
    const rest = get().connections.filter((item) => item.id !== id)
    const clearUpgrade =
      get().upgradePromptForConnectionId === id
        ? { upgradePrompt: undefined, upgradePromptForConnectionId: undefined, upgradePromptSource: undefined }
        : {}
    const { [id]: _removed, ...restStatusMap } = get().upgradeStatusMap
    const { [id]: _removedCheckedAt, ...restCheckedAtMap } = get().upgradeStatusCheckedAtMap
    const { [id]: _removedDismissed, ...restDismissedMap } = get().dismissedUpgradePromptMap
    writeDismissedUpgradePrompts(restDismissedMap)
    set({
      connections: rest,
      selectedConnectionId:
        get().selectedConnectionId === id ? rest[0]?.id : get().selectedConnectionId,
      inspection: get().inspection?.connectionId === id ? undefined : get().inspection,
      upgradeStatusMap: restStatusMap,
      upgradeStatusCheckedAtMap: restCheckedAtMap,
      dismissedUpgradePromptMap: restDismissedMap,
      ...clearUpgrade,
    })
    writeLastSelectedConnectionId(
      get().selectedConnectionId === id ? rest[0]?.id : get().selectedConnectionId,
    )
  },
  selectConnection: (id) => {
    writeLastSelectedConnectionId(id)
    set({
      selectedConnectionId: id,
      inspection: getCachedInspection(id),
      upgradePrompt: undefined,
      upgradePromptForConnectionId: undefined,
      upgradePromptSource: undefined,
    })
  },
  clearOperationLogs: () => set({ operationLogs: [] }),
  clearFeedback: () => set({ error: undefined, info: undefined, lastTestResult: undefined }),
}))
