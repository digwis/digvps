import { randomBytes } from "node:crypto"
import type { ProjectEnvResult } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function randomSecret(size = 32) {
  return randomBytes(size).toString("base64url")
}

export async function readProjectEnvFile(
  connection: VpsConnectionInput,
  remoteAppDir: string,
): Promise<ProjectEnvResult> {
  const envPath = `${remoteAppDir.replace(/\/$/, "")}/.env`
  const result = await runRemoteShellCommand(
    connection,
    `if [ -f ${shellSingleQuote(envPath)} ]; then cat ${shellSingleQuote(envPath)}; else touch ${shellSingleQuote(envPath)} && cat ${shellSingleQuote(envPath)}; fi`,
    { timeoutMs: 120_000 },
  )

  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim() || "读取远端 .env 失败",
    }
  }

  return {
    ok: true,
    message: "已读取远端 .env",
    content: result.stdout,
  }
}

export async function saveProjectEnvFile(
  connection: VpsConnectionInput,
  remoteAppDir: string,
  content: string,
): Promise<ProjectEnvResult> {
  const envPath = `${remoteAppDir.replace(/\/$/, "")}/.env`
  const script = `cat >${shellSingleQuote(envPath)} <<'DIGWIS_PANEL_ENV'\n${content}\nDIGWIS_PANEL_ENV\n`
  const result = await runRemoteShellCommand(connection, script, { timeoutMs: 120_000 })

  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim() || "保存远端 .env 失败",
    }
  }

  return {
    ok: true,
    message: "远端 .env 已保存",
    content,
  }
}

export async function rotateProjectSessionSecret(
  connection: VpsConnectionInput,
  remoteAppDir: string,
): Promise<ProjectEnvResult> {
  const current = await readProjectEnvFile(connection, remoteAppDir)
  if (!current.ok) {
    return current
  }

  const nextSecret = randomSecret()
  const lines = (current.content ?? "").split(/\r?\n/)
  let replaced = false
  const next = lines.map((line) => {
    if (line.startsWith("SESSION_SECRET=")) {
      replaced = true
      return `SESSION_SECRET=${nextSecret}`
    }
    return line
  })
  if (!replaced) {
    next.push(`SESSION_SECRET=${nextSecret}`)
  }

  return await saveProjectEnvFile(connection, remoteAppDir, next.join("\n").replace(/\n+$/g, "\n"))
}

export async function restartProjectRemoteService(
  connection: VpsConnectionInput,
  remoteService: string,
): Promise<ProjectEnvResult> {
  const result = await runRemoteShellCommand(
    connection,
    `sudo -n systemctl restart ${shellSingleQuote(remoteService)} && systemctl is-active ${shellSingleQuote(remoteService)}`,
    { timeoutMs: 120_000 },
  )

  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim() || "重启远端服务失败",
    }
  }

  return {
    ok: true,
    message: `服务已重启：${result.stdout.trim() || remoteService}`,
  }
}
