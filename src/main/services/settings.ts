import { getAppSetting, setAppSetting } from "./db"

export const DEFAULT_REMOTE_DIRECTORY = "/var/www"
const DEFAULT_REMOTE_DIRECTORY_KEY = "defaultRemoteDirectory"

export function getDefaultRemoteDirectory(): string {
  const value = getAppSetting(DEFAULT_REMOTE_DIRECTORY_KEY, DEFAULT_REMOTE_DIRECTORY)
  const trimmed = value?.trim()
  if (!trimmed) {
    return DEFAULT_REMOTE_DIRECTORY
  }
  return trimmed
}

export function setDefaultRemoteDirectory(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error("默认远程目录不能为空")
  }
  if (!trimmed.startsWith("/")) {
    throw new Error("默认远程目录必须是绝对路径（以 / 开头）")
  }
  setAppSetting(DEFAULT_REMOTE_DIRECTORY_KEY, trimmed)
}

