import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type { RemoteManagedProjectScanResult } from "../../../shared/projects"

type ProjectStoreState = {
  scanResult?: RemoteManagedProjectScanResult
  isScanning: boolean
  scanError?: string
  scanForConnection: (connectionId: string) => Promise<void>
  clearScan: () => void
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  scanResult: undefined,
  isScanning: false,
  scanError: undefined,
  scanForConnection: async (connectionId) => {
    set({ isScanning: true, scanError: undefined })
    try {
      const result = await getDesktopApi().projects.scanRemoteProjects({ connectionId })
      set({ scanResult: result, isScanning: false })
    } catch (error) {
      set({ isScanning: false, scanError: error instanceof Error ? error.message : "Remote project scan failed" })
    }
  },
  clearScan: () => set({ scanResult: undefined, scanError: undefined }),
}))
