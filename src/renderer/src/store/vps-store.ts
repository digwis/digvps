import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  ConnectionTestResult,
  DependencyUsageReport,
  DependencyInstallResult,
  DependencyServiceAction,
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

const LAST_SELECTED_CONNECTION_KEY = "digwis:last-selected-connection-id"
const INSPECTION_CACHE_KEY = "digwis:inspection-cache"
const INSPECTION_CACHE_TTL_MS = 30 * 60_000
const INSPECTION_TELEMETRY_FRESH_MS = 20_000

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

function stripStaleTelemetry(inspection: VpsInspection) {
  const checkedAt = new Date(inspection.checkedAt).getTime()
  if (!Number.isFinite(checkedAt)) {
    return inspection
  }
  if (Date.now() - checkedAt <= INSPECTION_TELEMETRY_FRESH_MS) {
    return inspection
  }
  return {
    ...inspection,
    telemetry: undefined,
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
  return cached ? stripStaleTelemetry(cached) : undefined
}

function appendOperationLog(
  items: VpsOperationLogEntry[],
  entry: VpsOperationLogEntry,
) {
  return [...items, entry].slice(-60)
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
  isInstallingDependency: boolean
  installingDependencyId?: string
  isDependencyServicePending: boolean
  dependencyServicePendingKey?: string
  upgradePrompt?: SystemUpgradeCheckResult
  upgradePromptForConnectionId?: string
  upgradeStatusMap: Record<string, SystemUpgradeCheckResult>
  operationLogs: VpsOperationLogEntry[]
  info?: string
  lastTestResult?: ConnectionTestResult
  error?: string
  loadConnections: () => Promise<void>
  loadDiscoveredHosts: () => Promise<void>
  loadSshConfigCandidates: () => Promise<void>
  loadRawSshConfig: () => Promise<RawSshConfigFile | undefined>
  saveRawSshConfig: (payload: { content: string }) => Promise<RawSshConfigFile>
  createSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
  updateSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
  deleteSshConfigCandidate: (payload: { configPath: string; originalName: string }) => Promise<SshConfigCandidate[]>
  saveConnection: (payload: VpsConnectionInput) => Promise<VpsConnectionRecord>
  testConnection: (payload: VpsConnectionInput) => Promise<ConnectionTestResult>
  inspectConnection: (payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) => Promise<VpsInspection>
  installDependency: (
    payload: VpsConnectionInput,
    dependencyId: string,
  ) => Promise<DependencyInstallResult>
  inspectDependencyUsage: (
    payload: VpsConnectionInput,
    dependencyId: string,
  ) => Promise<DependencyUsageReport>
  uninstallDependency: (
    payload: VpsConnectionInput,
    dependencyId: string,
  ) => Promise<DependencyInstallResult>
  dependencyServiceAction: (
    payload: VpsConnectionInput,
    options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
  ) => Promise<DependencyInstallResult>
  checkSystemUpgradesAfterInspect: (payload: VpsConnectionInput) => Promise<void>
  checkAllConnectionsUpgrades: () => Promise<void>
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
  isInstallingDependency: false,
  installingDependencyId: undefined,
  isDependencyServicePending: false,
  dependencyServicePendingKey: undefined,
  upgradePrompt: undefined,
  upgradePromptForConnectionId: undefined,
  upgradeStatusMap: {},
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
        error: error instanceof Error ? error.message : "连接列表加载失败",
      })
    }
  },
  loadDiscoveredHosts: async () => {
    set({ isDiscoveringHosts: true, error: undefined })
    try {
      const discoveredHosts = await getDesktopApi().vps.listDiscoveredHosts()
      set({ discoveredHosts, isDiscoveringHosts: false })
    } catch (error) {
      set({
        isDiscoveringHosts: false,
        error: error instanceof Error ? error.message : "历史主机加载失败",
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
        error: error instanceof Error ? error.message : "SSH 配置读取失败",
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
        info: "本机 SSH 配置已保存",
      })
      return rawSshConfig
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSH 配置保存失败"
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
        info: "本机 SSH 配置已新增",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSH 配置新增失败"
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
        info: "本机 SSH 配置已更新",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSH 配置更新失败"
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
        info: "本机 SSH 配置项已删除",
      })
      return sshConfigCandidates
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSH 配置删除失败"
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
      const message = error instanceof Error ? error.message : "保存失败"
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
      const message = error instanceof Error ? error.message : "测试连接失败"
      set({ isTesting: false, error: message })
      if (payload.id) {
        await get().loadConnections()
      }
      throw error
    }
  },
  inspectConnection: async (payload, options) => {
    set({
      isInspecting: true,
      error: undefined,
      info: undefined,
      upgradePrompt: undefined,
      upgradePromptForConnectionId: undefined,
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
      const message = error instanceof Error ? error.message : "环境检测失败"
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
  installDependency: async (payload, dependencyId) => {
    set({
      isInstallingDependency: true,
      installingDependencyId: dependencyId,
      error: undefined,
      info: undefined,
    })
    try {
      const result = await getDesktopApi().vps.installDependency(payload, dependencyId)
      if (!result.ok) {
        set({
          isInstallingDependency: false,
          installingDependencyId: undefined,
          operationLogs: appendOperationLog(get().operationLogs, {
            id: `${dependencyId}-${Date.now()}`,
            at: new Date().toISOString(),
            level: "error",
            title: `安装 ${dependencyId} 失败`,
            detail: result.message,
          }),
          error: result.message,
        })
        return result
      }
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${dependencyId}-${Date.now()}`,
          at: new Date().toISOString(),
          level: "info",
          title: `安装 ${dependencyId} 完成`,
          detail: result.message,
        }),
      })
      await get().inspectConnection(payload, { forceRefresh: true })
      set({ info: "依赖安装已完成，巡检已更新。" })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "依赖安装失败"
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${dependencyId}-${Date.now()}`,
          at: new Date().toISOString(),
          level: "error",
          title: `安装 ${dependencyId} 失败`,
          detail: message,
        }),
        error: message,
      })
      throw error
    }
  },
  inspectDependencyUsage: async (payload, dependencyId) => {
    return await getDesktopApi().vps.inspectDependencyUsage(payload, dependencyId)
  },
  uninstallDependency: async (payload, dependencyId) => {
    set({
      isInstallingDependency: true,
      installingDependencyId: dependencyId,
      error: undefined,
      info: undefined,
    })
    try {
      const result = await getDesktopApi().vps.uninstallDependency(payload, dependencyId)
      if (!result.ok) {
        set({
          isInstallingDependency: false,
          installingDependencyId: undefined,
          operationLogs: appendOperationLog(get().operationLogs, {
            id: `${dependencyId}-uninstall-${Date.now()}`,
            at: new Date().toISOString(),
            level: "error",
            title: `卸载 ${dependencyId} 失败`,
            detail: result.message,
          }),
          error: result.message,
        })
        return result
      }
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${dependencyId}-uninstall-${Date.now()}`,
          at: new Date().toISOString(),
          level: "info",
          title: `卸载 ${dependencyId} 完成`,
          detail: result.message,
        }),
      })
      await get().inspectConnection(payload, { forceRefresh: true })
      set({ info: "依赖卸载已完成，巡检已更新。" })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "依赖卸载失败"
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${dependencyId}-uninstall-${Date.now()}`,
          at: new Date().toISOString(),
          level: "error",
          title: `卸载 ${dependencyId} 失败`,
          detail: message,
        }),
        error: message,
      })
      throw error
    }
  },
  dependencyServiceAction: async (payload, options) => {
    const pendingKey = `${options.dependencyId}-${options.action}`
    set({
      isDependencyServicePending: true,
      dependencyServicePendingKey: pendingKey,
      error: undefined,
      info: undefined,
    })
    try {
      const result = await getDesktopApi().vps.dependencyServiceAction(payload, options)
      if (!result.ok) {
        set({
          isDependencyServicePending: false,
          dependencyServicePendingKey: undefined,
          operationLogs: appendOperationLog(get().operationLogs, {
            id: `${pendingKey}-${Date.now()}`,
            at: new Date().toISOString(),
            level: "error",
            title: `${options.dependencyId} ${options.action} 失败`,
            detail: result.message,
          }),
          error: result.message,
        })
        return result
      }
      set({
        isDependencyServicePending: false,
        dependencyServicePendingKey: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${pendingKey}-${Date.now()}`,
          at: new Date().toISOString(),
          level: "info",
          title: `${options.dependencyId} ${options.action} 完成`,
          detail: result.message,
        }),
      })
      await get().inspectConnection(payload, { forceRefresh: true })
      set({ info: "服务状态已刷新。" })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务操作失败"
      set({
        isDependencyServicePending: false,
        dependencyServicePendingKey: undefined,
        operationLogs: appendOperationLog(get().operationLogs, {
          id: `${pendingKey}-${Date.now()}`,
          at: new Date().toISOString(),
          level: "error",
          title: `${options.dependencyId} ${options.action} 失败`,
          detail: message,
        }),
        error: message,
      })
      throw error
    }
  },
  checkSystemUpgradesAfterInspect: async (payload) => {
    if (!payload.id) {
      return
    }
    set({ isCheckingUpgrade: true })
    try {
      const result = await getDesktopApi().vps.checkSystemUpgrades(payload)
      set((state) => ({
        upgradeStatusMap: {
          ...state.upgradeStatusMap,
          [payload.id!]: result,
        },
      }))
      if (payload.id !== get().selectedConnectionId) {
        return
      }
      if (result.supported && result.upgradableCount > 0) {
        set({
          upgradePrompt: result,
          upgradePromptForConnectionId: payload.id,
        })
      } else {
        set({
          upgradePrompt: undefined,
          upgradePromptForConnectionId: undefined,
        })
      }
    } catch {
      set({
        upgradePrompt: undefined,
        upgradePromptForConnectionId: undefined,
      })
    } finally {
      set({ isCheckingUpgrade: false })
    }
  },
  checkAllConnectionsUpgrades: async () => {
    const connections = get().connections
    if (connections.length === 0) {
      return
    }
    set({ isCheckingAllUpgrades: true })
    const newMap: Record<string, SystemUpgradeCheckResult> = {}
    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          const result = await getDesktopApi().vps.checkSystemUpgrades(conn as VpsConnectionInput)
          newMap[conn.id] = result
          set({ upgradeStatusMap: { ...get().upgradeStatusMap, ...newMap } })
        } catch {
          // 单个连接检查失败不影响其他连接
        }
      }),
    )
    set({ upgradeStatusMap: { ...get().upgradeStatusMap, ...newMap }, isCheckingAllUpgrades: false })
  },
  dismissUpgradePrompt: () =>
    set({ upgradePrompt: undefined, upgradePromptForConnectionId: undefined }),
  applyRemoteSystemUpgrade: async (payload, options) => {
    set({ isApplyingUpgrade: true, error: undefined, info: undefined })
    try {
      const result = await getDesktopApi().vps.applySystemUpgrade(payload, options)
      if (!result.ok) {
        set({ isApplyingUpgrade: false, error: result.message })
        return result
      }
      set({
        isApplyingUpgrade: false,
        upgradePrompt: undefined,
        upgradePromptForConnectionId: undefined,
        upgradeStatusMap: {
          ...get().upgradeStatusMap,
          [payload.id ?? ""]: { supported: true, manager: "none", upgradableCount: 0, indexRefreshed: false },
        },
        info: result.message,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "系统升级失败"
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
            ? `已从本机 SSH 配置导入 ${addedCount} 个连接`
            : "本机 SSH 配置已同步，没有发现新的可导入连接",
      })
    } catch (error) {
      set({
        isImportingLocal: false,
        error: error instanceof Error ? error.message : "本地 SSH 连接导入失败",
      })
      throw error
    }
  },
  deleteConnection: async (id) => {
    await getDesktopApi().vps.deleteConnection(id)
    const rest = get().connections.filter((item) => item.id !== id)
    const clearUpgrade =
      get().upgradePromptForConnectionId === id
        ? { upgradePrompt: undefined, upgradePromptForConnectionId: undefined }
        : {}
    const { [id]: _removed, ...restStatusMap } = get().upgradeStatusMap
    set({
      connections: rest,
      selectedConnectionId:
        get().selectedConnectionId === id ? rest[0]?.id : get().selectedConnectionId,
      inspection: get().inspection?.connectionId === id ? undefined : get().inspection,
      upgradeStatusMap: restStatusMap,
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
    })
  },
  clearOperationLogs: () => set({ operationLogs: [] }),
  clearFeedback: () => set({ error: undefined, info: undefined, lastTestResult: undefined }),
}))
