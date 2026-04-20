import { Client, type ClientChannel, type ConnectConfig } from "ssh2"
import type {
  DependencyInstallResult,
  DependencyServiceAction,
  VpsConnectionInput,
} from "../../shared/vps"
import { attachKeyboardInteractiveFallback, resolveSshConnectConfig } from "./ssh-auth"

type ExecResult = {
  stdout: string
  stderr: string
  code: number | undefined
}

async function runRemoteCommand(
  payload: VpsConnectionInput,
  config: ConnectConfig,
  command: string,
  options: { timeoutMs: number },
): Promise<ExecResult> {
  const connection = attachKeyboardInteractiveFallback(new Client(), payload)

  return new Promise<ExecResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.end()
      reject(new Error("服务操作超时"))
    }, options.timeoutMs)

    const finish = (callback: () => void) => {
      clearTimeout(timeout)
      callback()
    }

    connection
      .on("ready", () => {
        connection.exec(command, (error: Error | undefined, stream: ClientChannel) => {
          if (error) {
            connection.end()
            finish(() => reject(error))
            return
          }

          let stdout = ""
          let stderr = ""

          stream
            .on("close", (code: number | undefined) => {
              connection.end()
              finish(() => resolve({ stdout, stderr, code }))
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
        readyTimeout: 10_000,
        keepaliveInterval: 5_000,
      })
  })
}

function tailText(text: string, max = 6000): string {
  if (text.length <= max) {
    return text
  }
  return text.slice(-max)
}

function bashSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildServiceActionScript(
  dependencyId: string,
  action: DependencyServiceAction,
  systemdUnit?: string,
): string {
  if (dependencyId === "nodejs" || dependencyId === "python3") {
    return `printf '%s\\n' "runtime_only" >&2; exit 2`
  }

  if (dependencyId === "pm2") {
    return `
set -e
case "${action}" in
  restart)
    command -v pm2 >/dev/null 2>&1 || { echo "pm2 未安装" >&2; exit 3; }
    pm2 update
    ;;
  stop)
    command -v pm2 >/dev/null 2>&1 || { echo "pm2 未安装" >&2; exit 3; }
    pm2 kill
    ;;
  start)
    command -v pm2 >/dev/null 2>&1 || { echo "pm2 未安装" >&2; exit 3; }
    pm2 ping >/dev/null 2>&1 || pm2 resurrect || true
    ;;
esac
printf '%s\\n' DIGWIS_SVC_OK
`
  }

  const unitFromClient = systemdUnit?.trim()
  if (dependencyId === "postgresql" && !unitFromClient) {
    return `
set -e
sudo -n true
PGU=""
for x in postgresql postgresql@16-main postgresql@15-main postgresql@14-main postgresql@17-main; do
  if systemctl cat "$x" >/dev/null 2>&1; then PGU="$x"; break; fi
done
[ -n "$PGU" ] || { echo "未找到 PostgreSQL systemd 单元" >&2; exit 3; }
sudo -n systemctl ${action} "$PGU"
printf '%s\\n' DIGWIS_SVC_OK
`
  }

  const defaultUnits: Record<string, string> = {
    nginx: "nginx",
    docker: "docker",
    postgresql: "postgresql",
  }
  const unit = unitFromClient || defaultUnits[dependencyId]
  if (!unit) {
    return `printf '%s\\n' "unknown_unit" >&2; exit 2`
  }
  const uq = bashSingleQuoted(unit)
  return `
set -e
sudo -n true
sudo -n systemctl ${action} ${uq}
printf '%s\\n' DIGWIS_SVC_OK
`
}

const MANAGED = new Set(["docker", "nodejs", "nginx", "pm2", "python3", "postgresql"])

export async function runDependencyServiceAction(
  payload: VpsConnectionInput,
  options: {
    dependencyId: string
    action: DependencyServiceAction
    systemdUnit?: string
  },
): Promise<DependencyInstallResult> {
  const { dependencyId, action, systemdUnit } = options
  if (!MANAGED.has(dependencyId)) {
    return { ok: false, message: "不支持的依赖", stdout: "" }
  }

  const script = buildServiceActionScript(dependencyId, action, systemdUnit)

  try {
    const result = await runRemoteCommand(payload, resolveSshConnectConfig(payload), script, {
      timeoutMs: 180_000,
    })
    const combined = `${result.stdout}\n${result.stderr}`
    if (combined.includes("runtime_only")) {
      return {
        ok: false,
        message: "Node / Python 为运行环境，无 systemd 服务，请使用各项目自己的启动方式。",
        stdout: "",
      }
    }
    const sawOk = combined.includes("DIGWIS_SVC_OK")
    if (result.code !== 0 || !sawOk) {
      const hint = result.stderr.trim() || result.stdout.trim()
      return {
        ok: false,
        message: hint.slice(0, 500) || `操作未完成，退出码 ${result.code ?? "unknown"}`,
        stdout: tailText(combined),
      }
    }
    return {
      ok: true,
      message: "操作已完成",
      stdout: tailText(combined),
    }
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      message: error instanceof Error ? error.message : "远程执行失败",
    }
  }
}
