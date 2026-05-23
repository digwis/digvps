import { ipcMain } from "../electron-shim"
import type { IpcMainInvokeEvent } from "electron"

export const IPC_ERROR_PREFIX = "DIGWIS_IPC_ERROR:"

export type DigwisIpcError = {
  code: string
  message: string
  details?: unknown
}

export function toDigwisIpcError(error: unknown): DigwisIpcError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        details: candidate.details,
      }
    }
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: "未知错误",
  }
}

export function serializeIpcError(error: unknown): string {
  return `${IPC_ERROR_PREFIX}${JSON.stringify(toDigwisIpcError(error))}`
}

export function registerIpcHandle<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as Args))
    } catch (error) {
      throw new Error(serializeIpcError(error))
    }
  })
}
