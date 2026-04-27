import type { DigwisApi, DigwisIpcError } from "../../../shared/vps"

function parseDigwisError(error: unknown): DigwisIpcError | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const prefix = "DIGWIS_IPC_ERROR:"
  if (!message.startsWith(prefix)) {
    return null
  }
  try {
    return JSON.parse(message.slice(prefix.length)) as DigwisIpcError
  } catch {
    return null
  }
}

function wrapApi<T>(value: T): T {
  if (typeof value === "function") {
    return (async (...args: unknown[]) => {
      try {
        return await (value as (...innerArgs: unknown[]) => unknown)(...args)
      } catch (error) {
        const parsed = parseDigwisError(error)
        if (!parsed) {
          throw error
        }
        const next = new Error(parsed.message) as Error & DigwisIpcError
        next.code = parsed.code
        next.details = parsed.details
        throw next
      }
    }) as T
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      wrapApi(inner),
    ])
    return Object.fromEntries(entries) as T
  }

  return value
}

export function getDesktopApi(): DigwisApi {
  if (!window.digwis?.vps || !window.digwis?.projects) {
    throw new Error("桌面能力尚未注入，请确认当前是通过 Electron 桌面应用启动。")
  }

  return wrapApi(window.digwis)
}
