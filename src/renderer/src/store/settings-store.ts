import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"

const DEFAULT_REMOTE_DIRECTORY = "/var/www"

type SettingsState = {
  defaultRemoteDirectory: string
  initialized: boolean
  setDefaultRemoteDirectory: (value: string) => Promise<void>
  loadSettings: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  defaultRemoteDirectory: DEFAULT_REMOTE_DIRECTORY,
  initialized: false,
  setDefaultRemoteDirectory: async (value) => {
    const api = getDesktopApi()
    const next = await api.settings.setDefaultRemoteDirectory(value)
    set({ defaultRemoteDirectory: next, initialized: true })
  },
  loadSettings: async () => {
    const api = getDesktopApi()
    const next = await api.settings.getDefaultRemoteDirectory()
    set({ defaultRemoteDirectory: next || DEFAULT_REMOTE_DIRECTORY, initialized: true })
  },
}))

if (typeof window !== "undefined") {
  void useSettingsStore.getState().loadSettings()
}
