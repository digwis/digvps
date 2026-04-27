import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { VpsConnectionInput } from "../../shared/vps"
import { runSshCommand } from "./remote-command"

async function runRemoteShellCommandViaLocalSsh(
  payload: VpsConnectionInput,
  command: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (payload.authType !== "password" || !payload.password) {
    throw new Error("SSH 本地回退仅支持密码认证")
  }
  const password = payload.password

  return await new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      "sshpass",
      [
        "-p",
        password,
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        String(payload.port),
        `${payload.username.trim()}@${payload.host.trim()}`,
        "bash",
        "-s",
      ],
      { stdio: "pipe" },
    )

    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error("远程命令执行超时"))
    }, timeoutMs)

    const finish = (fn: () => void) => {
      clearTimeout(timeout)
      fn()
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on("error", (error: Error) => {
      finish(() => reject(error))
    })
    child.on("close", (code: number | null) => {
      finish(() =>
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        }),
      )
    })
    child.stdin.write(command)
    child.stdin.end()
  })
}

export async function runRemoteShellCommand(
  payload: VpsConnectionInput,
  command: string,
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? 120_000

  try {
    const result = await runSshCommand(payload, command, {
      timeoutMs,
      timeoutMessage: "远程命令执行超时",
    })
    return {
      code: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (
      payload.authType === "password" &&
      message.includes("All configured authentication methods failed")
    ) {
      return await runRemoteShellCommandViaLocalSsh(payload, command, timeoutMs)
    }
    throw error
  }
}
