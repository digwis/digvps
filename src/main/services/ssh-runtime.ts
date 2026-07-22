import { Client, type ClientChannel, type ConnectConfig } from "ssh2"
import SftpClient from "ssh2-sftp-client"
import type { VpsConnectionInput } from "../../shared/vps"
import { attachKeyboardInteractiveFallback, resolveSshConnectConfig } from "./ssh-auth"
import type { RemoteExecResult } from "./remote-command"

export async function connectSshClient(
  payload: VpsConnectionInput,
  options?: {
    config?: ConnectConfig
    readyTimeout?: number
    onHostVerifier?: (keyHash: string | Buffer) => boolean
  },
): Promise<Client> {
  const client = attachKeyboardInteractiveFallback(new Client(), payload)
  const config = options?.config ?? resolveSshConnectConfig(payload)

  await new Promise<void>((resolve, reject) => {
    client
      .on("ready", () => resolve())
      .on("error", (error) => reject(error))
      .connect({
        ...config,
        hostVerifier: options?.onHostVerifier,
        readyTimeout: options?.readyTimeout ?? 10_000,
        keepaliveInterval: 5_000,
      })
  })

  return client
}

export async function execOnClient(
  client: Client,
  command: string,
  options?: { timeoutMs?: number; timeoutMessage?: string },
): Promise<RemoteExecResult> {
  return await new Promise<RemoteExecResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(options?.timeoutMessage ?? "远程命令执行超时"))
    }, options?.timeoutMs ?? 20_000)

    const finish = (callback: () => void) => {
      clearTimeout(timeout)
      callback()
    }

    client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
      if (error) {
        finish(() => reject(error))
        return
      }

      let stdout = ""
      let stderr = ""
      stream
        .on("error", (streamError: Error) => {
          // 连接在命令执行期间被重置（如 apt 升级 openssh-server 触发 sshd 重启）
          // 时，ssh2 会通过 stream 的 'error' 事件上报。不接的话会变成 Node 的
          // unhandled error，最终以原始 code/message 漏到 IPC 层。
          finish(() => reject(streamError))
        })
        .on("close", (code?: number) => {
          finish(() => {
            resolve({
              code: code ?? -1,
              stdout,
              stderr,
            })
          })
        })
        .on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString()
        })
      stream.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
    })
  })
}

export async function connectSftpClient(
  payload: VpsConnectionInput,
  options?: { readyTimeout?: number },
): Promise<any> {
  const sftp = new SftpClient()
  try {
    if (payload.authType === "password" && payload.password) {
      sftp.client.on(
        "keyboard-interactive",
        (
          _name: string,
          _instructions: string,
          _lang: string,
          prompts: Array<unknown>,
          finish: (answers: string[]) => void,
        ) => {
          finish(prompts.map(() => payload.password!))
        },
      )
    }

    const connectConfig =
      payload.authType === "password"
        ? {
            ...resolveSshConnectConfig(payload),
            readyTimeout: options?.readyTimeout ?? 20_000,
            authHandler: ["password", "keyboard-interactive"],
          }
        : {
            ...resolveSshConnectConfig(payload),
            readyTimeout: options?.readyTimeout ?? 20_000,
          }

    await sftp.connect(connectConfig)
    return sftp
  } catch (error) {
    await sftp.end().catch(() => undefined)
    throw error
  }
}
