import {
  getDefaultRemoteDirectory,
  setDefaultRemoteDirectory,
} from "../services/settings"
import { registerIpcHandle } from "./ipc-error"

export function registerSettingsHandlers() {
  registerIpcHandle("settings:get-default-remote-directory", async () => {
    return getDefaultRemoteDirectory()
  })

  registerIpcHandle("settings:set-default-remote-directory", async (_event, value: string) => {
    setDefaultRemoteDirectory(value)
    return getDefaultRemoteDirectory()
  })
}
