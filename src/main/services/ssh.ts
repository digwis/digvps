import { Client, type ConnectConfig, type ClientChannel } from "ssh2"
import SftpClient from "ssh2-sftp-client"
import { createHash } from "node:crypto"
import type { ConnectionTestResult, VpsConnectionInput } from "../../shared/vps"
import { attachKeyboardInteractiveFallback, resolveSshConnectConfig } from "./ssh-auth"

async function executeProbe(payload: VpsConnectionInput, config: ConnectConfig) {
  const start = Date.now()
  const connection = attachKeyboardInteractiveFallback(new Client(), payload)
  let fingerprint = ""
  let workingDirectory = ""
  const timeoutMs = 15_000

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.end()
      reject(new Error("连接测试超时，请检查 SSH 配置或网络状态"))
    }, timeoutMs)

    const finish = (callback: () => void) => {
      clearTimeout(timeout)
      callback()
    }

    connection
      .on("ready", () => {
        connection.exec("pwd", (error: Error | undefined, stream: ClientChannel) => {
          if (error) {
            finish(() => reject(error))
            return
          }

          let stdout = ""
          let stderr = ""

          stream
            .on("close", (code: number | undefined) => {
              if (code !== 0 && stderr) {
                finish(() => reject(new Error(stderr.trim())))
                return
              }

              workingDirectory = stdout.trim()
              finish(() => resolve())
            })
            .on("data", (chunk: Buffer | string) => {
              stdout += chunk.toString()
            })

          stream.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString()
          })
        })
      })
      .on("error", (error) => {
        finish(() => reject(error))
      })
      .connect({
        ...config,
        hostVerifier: (keyHash: string | Buffer) => {
          fingerprint = createHash("sha256").update(keyHash).digest("base64")
          return true
        },
        readyTimeout: 10_000,
        keepaliveInterval: 5_000,
      })
  })

  const sftp = new SftpClient()
  try {
    await sftp.connect({
      ...config,
      readyTimeout: 10_000,
      tryKeyboard: payload.authType === "password",
    })
    workingDirectory = workingDirectory || (await sftp.cwd())
  } finally {
    await sftp.end().catch(() => undefined)
    connection.end()
  }

  return {
    latencyMs: Date.now() - start,
    fingerprint,
    workingDirectory,
  }
}

export async function testConnection(
  payload: VpsConnectionInput,
): Promise<ConnectionTestResult> {
  const result = await executeProbe(payload, resolveSshConnectConfig(payload))

  return {
    success: true,
    message: "SSH 与 SFTP 握手成功",
    latencyMs: result.latencyMs,
    serverFingerprint: result.fingerprint,
    workingDirectory: result.workingDirectory,
  }
}
