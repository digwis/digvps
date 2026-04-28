import path from "node:path"
import { Client, type ClientChannel } from "ssh2"
import type { VpsConnectionInput, VpsInspection } from "../../shared/vps"
import { REMOTE_INSPECTION_HELPER_SCRIPT, REMOTE_INSPECTION_HELPER_VERSION } from "./remote-inspection-helper-script"
import { connectSftpClient, connectSshClient, execOnClient } from "./ssh-runtime"

const HELPER_DIR_NAME = ".digwis-panel"
const HELPER_FILE_NAME = "remote-inspection-helper.py"
const HELPER_VERSION_FILE = "remote-inspection-helper.version"
const SESSION_IDLE_TIMEOUT_MS = 90_000

type HelperMethod = "ping" | "version" | "inspect"

type RpcEnvelope = {
  id: number | string | null
  ok: boolean
  result?: unknown
  error?: string
}

type SessionContext = {
  key: string
  connection: VpsConnectionInput
  client: Client
  channel: ClientChannel
  helperCommand: string
  helperPath: string
  helperDir: string
  nextRequestId: number
  buffer: string
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  idleTimer?: NodeJS.Timeout
  closed: boolean
}

const sessions = new Map<string, Promise<SessionContext>>()

function sessionKey(connection: VpsConnectionInput) {
  return connection.id ?? `${connection.username}@${connection.host}:${connection.port}`
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function uploadHelper(connection: VpsConnectionInput, helperPath: string, versionPath: string) {
  const sftp = await connectSftpClient(connection, { readyTimeout: 20_000 })
  try {
    await sftp.put(Buffer.from(REMOTE_INSPECTION_HELPER_SCRIPT, "utf8"), helperPath)
    await sftp.put(Buffer.from(`${REMOTE_INSPECTION_HELPER_VERSION}\n`, "utf8"), versionPath)
  } finally {
    await sftp.end().catch(() => undefined)
  }
}

async function runExec(client: Client, command: string, timeoutMs = 20_000) {
  return await execOnClient(client, command, {
    timeoutMs,
    timeoutMessage: "远端监控 helper 准备超时",
  })
}

async function ensureHelperInstalled(client: Client, connection: VpsConnectionInput) {
  const inspectCommand = [
    "set -e",
    'HOME_DIR="${HOME}"',
    'PYTHON_BIN=""',
    'if command -v python3 >/dev/null 2>&1; then PYTHON_BIN="$(command -v python3)"; elif command -v python >/dev/null 2>&1; then PYTHON_BIN="$(command -v python)"; fi',
    `HELPER_DIR="$HOME_DIR/${HELPER_DIR_NAME}"`,
    `HELPER_PATH="$HELPER_DIR/${HELPER_FILE_NAME}"`,
    `VERSION_PATH="$HELPER_DIR/${HELPER_VERSION_FILE}"`,
    'mkdir -p "$HELPER_DIR"',
    'printf "HOME=%s\\nPYTHON=%s\\nHELPER=%s\\nVERSION=%s\\n" "$HOME_DIR" "$PYTHON_BIN" "$HELPER_PATH" "$(cat "$VERSION_PATH" 2>/dev/null || true)"',
  ].join("\n")
  const result = await runExec(client, `bash -lc ${shellQuote(inspectCommand)}`)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "远端监控 helper 初始化失败")
  }
  const values = new Map<string, string>()
  for (const line of result.stdout.split("\n")) {
    const index = line.indexOf("=")
    if (index <= 0) {
      continue
    }
    values.set(line.slice(0, index), line.slice(index + 1))
  }
  const pythonBin = values.get("PYTHON")?.trim()
  const helperPath = values.get("HELPER")?.trim()
  const homeDir = values.get("HOME")?.trim()
  const currentVersion = values.get("VERSION")?.trim() || ""
  if (!pythonBin) {
    throw new Error("远端缺少 python3/python，无法启动监控 helper")
  }
  if (!helperPath || !homeDir) {
    throw new Error("远端监控 helper 路径解析失败")
  }
  const helperDir = path.posix.dirname(helperPath)
  const versionPath = path.posix.join(helperDir, HELPER_VERSION_FILE)
  if (currentVersion !== REMOTE_INSPECTION_HELPER_VERSION) {
    await uploadHelper(connection, helperPath, versionPath)
    const chmodResult = await runExec(
      client,
      `bash -lc ${shellQuote(`chmod 700 ${shellQuote(helperPath)}`)}`,
      20_000,
    )
    if (chmodResult.code !== 0) {
      throw new Error(chmodResult.stderr.trim() || "远端监控 helper 权限设置失败")
    }
  }
  return {
    helperCommand: pythonBin,
    helperPath,
    helperDir,
  }
}

function scheduleIdleDispose(session: SessionContext) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
  }
  session.idleTimer = setTimeout(() => {
    void disposeInspectionSession(session.key)
  }, SESSION_IDLE_TIMEOUT_MS)
}

function bindChannel(session: SessionContext) {
  session.channel.on("data", (chunk: Buffer | string) => {
    session.buffer += chunk.toString()
    while (true) {
      const newlineIndex = session.buffer.indexOf("\n")
      if (newlineIndex < 0) {
        break
      }
      const raw = session.buffer.slice(0, newlineIndex).trim()
      session.buffer = session.buffer.slice(newlineIndex + 1)
      if (!raw) {
        continue
      }
      let payload: RpcEnvelope | null = null
      try {
        payload = JSON.parse(raw) as RpcEnvelope
      } catch {
        continue
      }
      if (typeof payload.id !== "number") {
        continue
      }
      const pending = session.pending.get(payload.id)
      if (!pending) {
        continue
      }
      session.pending.delete(payload.id)
      if (payload.ok) {
        pending.resolve(payload.result)
      } else {
        pending.reject(new Error(payload.error || "远端监控 helper 调用失败"))
      }
    }
  })

  const onClose = () => {
    if (session.closed) {
      return
    }
    session.closed = true
    for (const pending of session.pending.values()) {
      pending.reject(new Error("远端监控 helper 连接已关闭"))
    }
    session.pending.clear()
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
    }
    session.client.end()
    sessions.delete(session.key)
  }

  session.channel.on("close", onClose)
  session.client.on("close", onClose)
  session.client.on("error", onClose)
}

async function createSession(connection: VpsConnectionInput) {
  const key = sessionKey(connection)
  const client = await connectSshClient(connection, {
    readyTimeout: 20_000,
  })

  try {
    const helper = await ensureHelperInstalled(client, connection)
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(
        `bash -lc ${shellQuote(`${shellQuote(helper.helperCommand)} -u ${shellQuote(helper.helperPath)}`)}`,
        (error, stream) => {
          if (error) {
            reject(error)
            return
          }
          resolve(stream)
        },
      )
    })
    const session: SessionContext = {
      key,
      connection,
      client,
      channel,
      helperCommand: helper.helperCommand,
      helperPath: helper.helperPath,
      helperDir: helper.helperDir,
      nextRequestId: 1,
      buffer: "",
      pending: new Map(),
      closed: false,
    }
    bindChannel(session)
    await requestRpc(session, "version", {}, { bypassRestart: true })
    scheduleIdleDispose(session)
    return session
  } catch (error) {
    client.end()
    throw error
  }
}

async function getOrCreateSession(connection: VpsConnectionInput) {
  const key = sessionKey(connection)
  const existing = sessions.get(key)
  if (existing) {
    return await existing
  }
  const next = createSession(connection).catch((error) => {
    sessions.delete(key)
    throw error
  })
  sessions.set(key, next)
  return await next
}

async function requestRpc(
  session: SessionContext,
  method: HelperMethod,
  params: Record<string, unknown>,
  options?: { bypassRestart?: boolean },
): Promise<unknown> {
  if (session.closed) {
    throw new Error("远端监控 helper 连接已关闭")
  }
  const requestId = session.nextRequestId++
  scheduleIdleDispose(session)
  const payload = JSON.stringify({
    id: requestId,
    method,
    params,
  })

  const result: unknown = await new Promise<unknown>((resolve, reject) => {
    session.pending.set(requestId, { resolve, reject })
    session.channel.write(`${payload}\n`, (error) => {
      if (!error) {
        return
      }
      session.pending.delete(requestId)
      reject(error)
    })
  }).catch(async (error) => {
    if (options?.bypassRestart) {
      throw error
    }
    await disposeInspectionSession(session.key)
    const nextSession = await getOrCreateSession(session.connection)
    return await requestRpc(nextSession, method, params, { bypassRestart: true })
  })

  return result
}

export async function inspectViaRemoteHelper(connection: VpsConnectionInput): Promise<Omit<VpsInspection, "connectionId" | "checkedAt" | "reachabilityChecks">> {
  const session = await getOrCreateSession(connection)
  return (await requestRpc(session, "inspect", {})) as Omit<VpsInspection, "connectionId" | "checkedAt" | "reachabilityChecks">
}

export async function disposeInspectionSession(key: string) {
  const sessionPromise = sessions.get(key)
  if (!sessionPromise) {
    return
  }
  sessions.delete(key)
  const session = await sessionPromise.catch(() => null)
  if (!session || session.closed) {
    return
  }
  session.closed = true
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
  }
  for (const pending of session.pending.values()) {
    pending.reject(new Error("远端监控 helper 会话已释放"))
  }
  session.pending.clear()
  session.channel.close()
  session.client.end()
}

export async function disposeAllRemoteInspectionSessions() {
  await Promise.allSettled([...sessions.keys()].map((key) => disposeInspectionSession(key)))
}
