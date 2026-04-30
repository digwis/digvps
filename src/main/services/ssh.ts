import type { ConnectConfig } from "ssh2"
import { createHash } from "node:crypto"
import type { ConnectionTestResult, VpsConnectionInput } from "../../shared/vps"
import { resolveSshConnectConfig } from "./ssh-auth"
import { connectSftpClient, connectSshClient, execOnClient } from "./ssh-runtime"

function humanizeConnectionTestError(payload: VpsConnectionInput, error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "未知错误")

  if (message.includes("All configured authentication methods failed")) {
    const accountHint =
      payload.username.trim() === "root"
        ? "当前填写的是 root，很多云主机会默认禁用 root 密码登录。"
        : "当前账号或认证方式没有被服务器接受。"

    return new Error(
      `SSH 认证失败。${accountHint} 请检查密码是否正确、服务器是否关闭了 PasswordAuthentication，或是否只允许私钥登录。`,
    )
  }

  if (
    message.includes("Timed out while waiting for handshake") ||
    message.includes("connect ETIMEDOUT") ||
    message.includes("Connection timed out")
  ) {
    return new Error(`无法连接到 ${payload.host}:${payload.port}，请检查服务器是否在线、防火墙/安全组是否已放行 SSH 端口。`)
  }

  if (message.includes("connect ECONNREFUSED")) {
    return new Error(`目标 ${payload.host}:${payload.port} 拒绝连接，请检查 SSH 服务是否已启动，或端口是否填错。`)
  }

  return error instanceof Error ? error : new Error(message)
}

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
  let result: Awaited<ReturnType<typeof executeProbe>>
  try {
    result = await executeProbe(payload, resolveSshConnectConfig(payload))
  } catch (error) {
    throw humanizeConnectionTestError(payload, error)
  }

  return {
    success: true,
    message: "SSH 与 SFTP 握手成功",
    latencyMs: result.latencyMs,
    serverFingerprint: result.fingerprint,
    workingDirectory: result.workingDirectory,
  }
}
