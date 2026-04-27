import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import type { ProjectDeployResult } from "../../shared/projects"

const SCRIPT_TIMEOUT_MS = 45 * 60 * 1000

/** 从 Finder / Electron 启动时 PATH 往往缺 Homebrew 等路径，导致 rsync、sshpass 等「终端里能用、面板里找不到」 */
const EXTRA_PATH_PREFIX = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"]

function envForCliScripts(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return process.env
  }
  const sep = ":"
  const existing = (process.env.PATH ?? "")
    .split(sep)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const segment of [...EXTRA_PATH_PREFIX, ...existing]) {
    if (!seen.has(segment)) {
      seen.add(segment)
      merged.push(segment)
    }
  }
  return { ...process.env, PATH: merged.join(sep) }
}

function bashSingleQuotedPath(p: string) {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

export function readPackageJsonScriptNames(projectRoot: string): string[] {
  const pkgPath = path.join(projectRoot, "package.json")
  if (!fs.existsSync(pkgPath)) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> }
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || !("scripts" in parsed)) {
    return []
  }
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts
  if (!scripts || typeof scripts !== "object") {
    return []
  }
  return Object.keys(scripts).sort((a, b) => a.localeCompare(b))
}

export async function runLocalNpmScript(
  projectRoot: string,
  scriptName: string,
  options?: {
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void
  },
): Promise<ProjectDeployResult> {
  const names = readPackageJsonScriptNames(projectRoot)
  if (!names.includes(scriptName)) {
    return {
      ok: false,
      message: `package.json 中不存在脚本：${scriptName}`,
      durationMs: 0,
      kind: "local-npm-script",
    }
  }

  const start = Date.now()

  return await new Promise((resolve) => {
    const env = {
      ...envForCliScripts(),
      ...(options?.env ?? {}),
    }
    // macOS/Linux：用登录 shell 执行，尽量与「本机终端」PATH/工具链一致（nvm、brew 等）
    const child =
      process.platform === "win32"
        ? spawn("npm.cmd", ["run", scriptName], {
            cwd: projectRoot,
            env,
          })
        : spawn("/bin/bash", [
            "-lc",
            `cd ${bashSingleQuotedPath(path.resolve(projectRoot))} && npm run ${bashSingleQuotedPath(scriptName)}`,
          ],
            {
              env,
              // 无单独 cwd：cd 已在 -lc 里完成
            },
          )

    let combined = ""
    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = chunk.toString()
      combined += text
      if (combined.length > 32_000) {
        combined = combined.slice(-24_000)
      }
      options?.onOutput?.(text, stream)
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        ok: false,
        message: `脚本执行超时（${Math.round((options?.timeoutMs ?? SCRIPT_TIMEOUT_MS) / 60000)} 分钟）`,
        durationMs: Date.now() - start,
        kind: "local-npm-script",
      })
    }, options?.timeoutMs ?? SCRIPT_TIMEOUT_MS)

    const finish = (result: ProjectDeployResult) => {
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on("data", (chunk) => append(chunk, "stdout"))
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"))

    child.on("error", (error) => {
      finish({
        ok: false,
        message: error instanceof Error ? error.message : "无法启动 npm",
        durationMs: Date.now() - start,
        kind: "local-npm-script",
      })
    })

    child.on("close", (code) => {
      const tail = combined.trim()
      const detail = tail.length > 900 ? `…${tail.slice(-900)}` : tail
      if (code === 0) {
        finish({
          ok: true,
          message: detail
            ? `本地脚本「${scriptName}」已完成。\n${detail}`
            : `本地脚本「${scriptName}」已完成。`,
          durationMs: Date.now() - start,
          kind: "local-npm-script",
        })
      } else {
        finish({
          ok: false,
          message: `本地脚本「${scriptName}」失败（退出码 ${code ?? "unknown"}）${detail ? `：${detail}` : ""}`,
          durationMs: Date.now() - start,
          kind: "local-npm-script",
        })
      }
    })
  })
}
