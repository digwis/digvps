import type { DigwisApi } from "../../../shared/vps"

export function getDesktopApi(): DigwisApi {
  if (!window.digwis?.vps || !window.digwis?.projects) {
    throw new Error("桌面能力尚未注入，请确认当前是通过 Electron 桌面应用启动。")
  }

  return window.digwis
}
