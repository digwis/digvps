import { BrowserWindow } from "../electron-shim"
import type { WebContents } from "electron"
import { getVpsConnectionInput, updateConnectionHealth } from "../services/db"
import { resolveStoredPayload } from "./helpers"
import type { VpsConnectionInput } from "../../shared/vps"

export function requireResolvedConnection(connectionId: string): VpsConnectionInput {
  const connection = getVpsConnectionInput(connectionId)
  if (!connection) {
    throw new Error("VPS 连接不存在")
  }
  return resolveStoredPayload(connection)
}

export function requireSenderWindow(sender: WebContents) {
  return BrowserWindow.fromWebContents(sender)
}

export async function runConnectionHealthTracked<T>(
  payload: VpsConnectionInput,
  action: (connection: VpsConnectionInput) => Promise<T>,
  failedMessage: string,
): Promise<T> {
  const connection = resolveStoredPayload(payload)
  try {
    const result = await action(connection)
    if (payload.id) {
      updateConnectionHealth(payload.id, {
        status: "connected",
        lastError: null,
      })
    }
    return result
  } catch (error) {
    if (payload.id) {
      updateConnectionHealth(payload.id, {
        status: "failed",
        lastError: error instanceof Error ? error.message : failedMessage,
      })
    }
    throw error
  }
}
