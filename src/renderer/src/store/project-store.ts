import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  OpenClawInstance,
  OpenClawInstallInput,
  OpenClawPrecheck,
  RemoteManagedProjectScanResult,
} from "../../../shared/projects"

type ProjectStoreState = {
  scanResult?: RemoteManagedProjectScanResult
  isScanning: boolean
  scanError?: string
  openclawInstances: OpenClawInstance[]
  openclawLoading: boolean
  openclawError?: string
  scanForConnection: (connectionId: string) => Promise<void>
  clearScan: () => void
  loadOpenClawInstances: (connectionId: string) => Promise<void>
  precheckOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawPrecheck>
  installOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawInstance>
  uninstallOpenClaw: (instanceId: string, connectionId: string) => Promise<void>
  restartOpenClaw: (instanceId: string, connectionId: string) => Promise<void>
  fetchOpenClawLogs: (instanceId: string, connectionId: string, lines?: number) => Promise<string>
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  scanResult: undefined,
  isScanning: false,
  scanError: undefined,
  openclawInstances: [],
  openclawLoading: false,
  openclawError: undefined,
  scanForConnection: async (connectionId) => {
    set({ isScanning: true, scanError: undefined })
    try {
      const result = await getDesktopApi().projects.scanRemoteProjects({ connectionId })
      set({ scanResult: result, isScanning: false })
    } catch (error) {
      set({ isScanning: false, scanError: error instanceof Error ? error.message : "远程项目扫描失败" })
    }
  },
  clearScan: () => set({ scanResult: undefined, scanError: undefined }),
  loadOpenClawInstances: async (connectionId) => {
    set({ openclawLoading: true, openclawError: undefined })
    try {
      const instances = await getDesktopApi().projects.listOpenClawInstances(connectionId)
      set({ openclawInstances: instances, openclawLoading: false })
    } catch (error) {
      set({ openclawLoading: false, openclawError: error instanceof Error ? error.message : "加载 OpenClaw 实例失败" })
    }
  },
  precheckOpenClaw: async (payload) => getDesktopApi().projects.precheckOpenClawInstall(payload),
  installOpenClaw: async (payload) => {
    const inst = await getDesktopApi().projects.installOpenClaw(payload)
    set((state) => ({ openclawInstances: [...state.openclawInstances, inst] }))
    return inst
  },
  uninstallOpenClaw: async (instanceId, connectionId) => {
    await getDesktopApi().projects.uninstallOpenClaw({ connectionId, instanceId })
    set((state) => ({ openclawInstances: state.openclawInstances.filter((i) => i.id !== instanceId) }))
  },
  restartOpenClaw: async (instanceId, connectionId) => {
    await getDesktopApi().projects.restartOpenClaw({ connectionId, instanceId })
  },
  fetchOpenClawLogs: async (instanceId, connectionId, lines = 50) =>
    getDesktopApi().projects.fetchOpenClawLogs({ connectionId, instanceId, lines }),
}))