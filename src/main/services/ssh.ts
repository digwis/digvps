import type { ConnectConfig } from "ssh2"
import { createHash } from "node:crypto"
import type { ConnectionTestResult, VpsConnectionInput } from "../../shared/vps"
import { resolveSshConnectConfig } from "./ssh-auth"
import { connectSftpClient, connectSshClient, execOnClient } from "./ssh-runtime"

async function executeProbe(payload: VpsConnectionInput, config: ConnectConfig) {
  const start = Date.now()
  let fingerprint = ""
  let workingDirectory = ""
  const timeoutMs = 15_000
  const connection = await connectSshClient(payload, {
    config,
    readyTimeout: 10_000,
    onHostVerifier: (keyHash) => {
      fingerprint = createHash("sha256").update(keyHash).digest("base64")
      return true
    },
  })

  const pwdResult = await execOnClient(connection, "pwd", {
    timeoutMs,
    timeoutMessage: "连接测试超时，请检查 SSH 配置或网络状态",
  })
  if (pwdResult.code !== 0 && pwdResult.stderr.trim()) {
    connection.end()
    throw new Error(pwdResult.stderr.trim())
  }
  workingDirectory = pwdResult.stdout.trim()

  const sftp = await connectSftpClient(payload, { readyTimeout: 10_000 })
  try {
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
