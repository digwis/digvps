import type { VpsConnectionInput } from "../../shared/vps"
import type { ConnectConfig } from "ssh2"
import { connectSshClient, execOnClient } from "./ssh-runtime"

export type RemoteExecResult = {
  stdout: string
  stderr: string
  code: number | undefined
}

export async function runSshCommand(
  payload: VpsConnectionInput,
  command: string,
  options: {
    timeoutMs: number
    timeoutMessage: string
    config?: ConnectConfig
  },
): Promise<RemoteExecResult> {
  const connection = await connectSshClient(payload, {
    config: options.config,
    readyTimeout: 10_000,
  })

  try {
    return await execOnClient(connection, command, {
      timeoutMs: options.timeoutMs,
      timeoutMessage: options.timeoutMessage,
    })
  } catch (error) {
    connection.end()
    throw error
  } finally {
    connection.end()
  }
}
