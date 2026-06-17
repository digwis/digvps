import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import type { Client, ClientChannel } from "ssh2"
import type {
  TerminalCloseInput,
  TerminalCreateResult,
  TerminalResizeInput,
  TerminalWriteInput,
  VpsConnectionInput,
} from "../../shared/vps"
import { connectSshClient } from "./ssh-runtime"

type SessionRecord = {
  client: Client
  stream: ClientChannel
}

const sessions = new Map<string, SessionRecord>()

export async function createTerminalSession(
  payload: VpsConnectionInput,
  webContents?: WebContents,
): Promise<TerminalCreateResult> {
  const client = await connectSshClient(payload, { readyTimeout: 10_000 })
  const sessionId = randomUUID()

  await new Promise<void>((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (error, stream) => {
      if (error || !stream) {
        client.end()
        reject(error ?? new Error("无法创建远程终端"))
        return
      }

      sessions.set(sessionId, { client, stream })

      stream.on("data", (chunk: Buffer | string) => {
        webContents?.send("terminal:data", { sessionId, data: chunk.toString() })
      })
      stream.stderr.on("data", (chunk: Buffer | string) => {
        webContents?.send("terminal:data", { sessionId, data: chunk.toString() })
      })
      stream.on("close", (code?: number, signal?: string) => {
        sessions.delete(sessionId)
        webContents?.send("terminal:exit", { sessionId, code, signal })
        client.end()
      })
      resolve()
    })
  })

  return { sessionId }
}

export async function writeTerminalInput(payload: TerminalWriteInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) {
    throw new Error("终端会话不存在")
  }
  session.stream.write(payload.data)
}

export async function resizeTerminalSession(payload: TerminalResizeInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) {
    throw new Error("终端会话不存在")
  }
  session.stream.setWindow(payload.rows, payload.cols, 0, 0)
}

export async function closeTerminalSession(payload: TerminalCloseInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) {
    return
  }
  sessions.delete(payload.sessionId)
  session.stream.close()
  session.client.end()
}

export async function closeAllTerminalSessions(): Promise<void> {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map((sessionId) => closeTerminalSession({ sessionId })))
}
