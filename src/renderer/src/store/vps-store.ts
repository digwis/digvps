import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  ConnectionTestResult,
  DependencyInstallResult,
  DependencyServiceAction,
  DiscoveredHostCandidate,
  SshConfigCandidate,
  SystemUpgradeApplyResult,
  SystemUpgradeCheckResult,
  VpsInspection,
  VpsConnectionInput,
  VpsConnectionRecord,
} from "../../../shared/vps"

const LAST_SELECTED_CONNECTION_KEY = "digwis:last-selected-connection-id"

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

type VpsState = {
  connections: VpsConnectionRecord[]
  discoveredHosts: DiscoveredHostCandidate[]
  sshConfigCandidates: SshConfigCandidate[]
  selectedConnectionId?: string
  inspection?: VpsInspection
  isLoading: boolean
  isSaving: boolean
  isTesting: boolean
  isInspecting: boolean
  isImportingLocal: boolean
  isDiscoveringHosts: boolean
  isLoadingSshConfigCandidates: boolean
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
  info?: string
  lastTestResult?: ConnectionTestResult
  error?: string
  loadConnections: () => Promise<void>
  loadDiscoveredHosts: () => Promise<void>
  loadSshConfigCandidates: () => Promise<void>
  saveConnection: (payload: VpsConnectionInput) => Promise<VpsConnectionRecord>
  testConnection: (payload: VpsConnectionInput) => Promise<ConnectionTestResult>
  inspectConnection: (payload: VpsConnectionInput) => Promise<VpsInspection>
  installDependency: (
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
  clearFeedback: () => void
}

export const useVpsStore = create<VpsState>((set, get) => ({
  connections: [],
  discoveredHosts: [],
  sshConfigCandidates: [],
  selectedConnectionId: readLastSelectedConnectionId(),
  inspection: undefined,
  isLoading: false,
  isSaving: false,
  isTesting: false,
  isInspecting: false,
  isImportingLocal: false,
  isDiscoveringHosts: false,
  isLoadingSshConfigCandidates: false,
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
  info: undefined,
  error: undefined,
  lastTestResult: undefined,
  loadConnections: async () => {
    set({ isLoading: true, error: undefined })
    try {
      const connections = await getDesktopApi().vps.listConnections()
      const selectedConnectionId =
        get().selectedConnectionId && connections.some((item) => item.id === get().selectedConnectionId)
          ? get().selectedConnectionId
          : connections[0]?.id
      writeLastSelectedConnectionId(selectedConnectionId)
      set({ connections, isLoading: false, selectedConnectionId })
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
    } catch (error) {
      set({
        isLoadingSshConfigCandidates: false,
        error: error instanceof Error ? error.message : "SSH 配置读取失败",
      })
    }
  },
  saveConnection: async (payload) => {
    set({ isSaving: true, error: undefined, info: undefined })
    try {
      const connection = await getDesktopApi().vps.saveConnection(payload)
      const current = get().connections.filter((item) => item.id !== connection.id)
      set({
        connections: [connection, ...current],
        selectedConnectionId: connection.id,
        isSaving: false,
      })
      writeLastSelectedConnectionId(connection.id)
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
  inspectConnection: async (payload) => {
    set({
      isInspecting: true,
      error: undefined,
      info: undefined,
      upgradePrompt: undefined,
      upgradePromptForConnectionId: undefined,
    })
    try {
      const inspection = await getDesktopApi().vps.inspectConnection(payload)
      set({ isInspecting: false, inspection })
      if (payload.id) {
        await get().loadConnections()
      }
      return inspection
    } catch (error) {
      const message = error instanceof Error ? error.message : "环境检测失败"
      set({ isInspecting: false, error: message })
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
          error: result.message,
        })
        return result
      }
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
      })
      await get().inspectConnection(payload)
      set({ info: "依赖安装已完成，巡检已更新。" })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "依赖安装失败"
      set({
        isInstallingDependency: false,
        installingDependencyId: undefined,
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
          error: result.message,
        })
        return result
      }
      set({
        isDependencyServicePending: false,
        dependencyServicePendingKey: undefined,
      })
      await get().inspectConnection(payload)
      set({ info: "服务状态已刷新。" })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务操作失败"
      set({
        isDependencyServicePending: false,
        dependencyServicePendingKey: undefined,
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
      const connections = await getDesktopApi().vps.importLocalConnections()
      await get().loadDiscoveredHosts()
      const selectedConnectionId =
        get().selectedConnectionId && connections.some((item) => item.id === get().selectedConnectionId)
          ? get().selectedConnectionId
          : connections[0]?.id
      const addedCount = Math.max(connections.length - previousCount, 0)
      writeLastSelectedConnectionId(selectedConnectionId)
      set({ connections, selectedConnectionId, isImportingLocal: false })
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
      inspection: undefined,
      upgradePrompt: undefined,
      upgradePromptForConnectionId: undefined,
    })
  },
  clearFeedback: () => set({ error: undefined, info: undefined, lastTestResult: undefined }),
}))
