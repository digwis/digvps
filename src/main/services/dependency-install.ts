import { Client, type ClientChannel, type ConnectConfig } from "ssh2"
import type { DependencyInstallResult, VpsConnectionInput } from "../../shared/vps"
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
      reject(new Error("远程安装命令超时"))
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

const VALID_DEPENDENCY_IDS = new Set([
  "docker",
  "nodejs",
  "nginx",
  "pm2",
  "python3",
  "postgresql",
])

function bashSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildInstallScript(dependencyId: string): string {
  const dep = bashSingleQuoted(dependencyId)
  return `
set -e
sudo -n true
DEP=${dep}
export DEBIAN_FRONTEND=noninteractive
PM=unknown
if command -v apt-get >/dev/null 2>&1; then PM=apt-get
elif command -v apt >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v pacman >/dev/null 2>&1; then PM=pacman
fi
if [ "$PM" = unknown ]; then
  printf '%s\\n' "未检测到支持的包管理器（apt/yum/dnf/apk/pacman）" >&2
  exit 2
fi

maybe_apt_update() {
  case "$PM" in
    apt-get|apt) sudo -n apt-get update -qq ;;
  esac
}

case "$DEP" in
  docker)
    maybe_apt_update
    case "$PM" in
      apt-get|apt) sudo -n apt-get install -y docker.io ;;
      dnf) sudo -n dnf install -y docker ;;
      yum) sudo -n yum install -y docker ;;
      apk) sudo -n apk add --no-cache docker ;;
      pacman) sudo -n pacman -Sy --noconfirm docker ;;
    esac
    ;;
  nodejs)
    maybe_apt_update
    case "$PM" in
      apt-get|apt) sudo -n apt-get install -y nodejs npm ;;
      dnf) sudo -n dnf install -y nodejs npm ;;
      yum) sudo -n yum install -y nodejs npm ;;
      apk) sudo -n apk add --no-cache nodejs npm ;;
      pacman) sudo -n pacman -Sy --noconfirm nodejs npm ;;
    esac
    ;;
  nginx)
    maybe_apt_update
    case "$PM" in
      apt-get|apt) sudo -n apt-get install -y nginx ;;
      dnf) sudo -n dnf install -y nginx ;;
      yum) sudo -n yum install -y nginx ;;
      apk) sudo -n apk add --no-cache nginx ;;
      pacman) sudo -n pacman -Sy --noconfirm nginx ;;
    esac
    ;;
  pm2)
    if ! command -v npm >/dev/null 2>&1; then
      printf '%s\\n' "未找到 npm，请先安装 Node.js（nodejs 依赖）" >&2
      exit 3
    fi
    sudo -n env NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false npm install -g pm2
    ;;
  python3)
    maybe_apt_update
    case "$PM" in
      apt-get|apt) sudo -n apt-get install -y python3 python3-pip python3-venv ;;
      dnf) sudo -n dnf install -y python3 python3-pip ;;
      yum) sudo -n yum install -y python3 python3-pip ;;
      apk) sudo -n apk add --no-cache python3 py3-pip ;;
      pacman) sudo -n pacman -Sy --noconfirm python python-pip ;;
    esac
    ;;
  postgresql)
    maybe_apt_update
    case "$PM" in
      apt-get|apt) sudo -n apt-get install -y postgresql postgresql-contrib ;;
      dnf) sudo -n dnf install -y postgresql-server postgresql-contrib
         if command -v postgresql-setup >/dev/null 2>&1; then
           sudo -n postgresql-setup --initdb || true
         fi
         ;;
      yum) sudo -n yum install -y postgresql-server postgresql-contrib
         if command -v postgresql-setup >/dev/null 2>&1; then
           sudo -n postgresql-setup initdb || true
         fi
         ;;
      apk) sudo -n apk add --no-cache postgresql postgresql-contrib ;;
      pacman) sudo -n pacman -Sy --noconfirm postgresql ;;
    esac
    ;;
  *)
    printf '%s\\n' "未知依赖: $DEP" >&2
    exit 2
    ;;
esac
printf '%s\\n' DIGWIS_DEP_OK
`
}

function buildUninstallScript(dependencyId: string): string {
  const dep = bashSingleQuoted(dependencyId)
  return `
set -e
sudo -n true
DEP=${dep}
export DEBIAN_FRONTEND=noninteractive
PM=unknown
if command -v apt-get >/dev/null 2>&1; then PM=apt-get
elif command -v apt >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v pacman >/dev/null 2>&1; then PM=pacman
fi
if [ "$PM" = unknown ]; then
  printf '%s\\n' "未检测到支持的包管理器（apt/yum/dnf/apk/pacman）" >&2
  exit 2
fi

case "$DEP" in
  docker)
    sudo -n systemctl stop docker >/dev/null 2>&1 || true
    case "$PM" in
      apt-get|apt) sudo -n apt-get remove -y docker.io ;;
      dnf) sudo -n dnf remove -y docker ;;
      yum) sudo -n yum remove -y docker ;;
      apk) sudo -n apk del docker ;;
      pacman) sudo -n pacman -Rns --noconfirm docker ;;
    esac
    ;;
  nodejs)
    sudo -n npm uninstall -g pm2 >/dev/null 2>&1 || true
    case "$PM" in
      apt-get|apt) sudo -n apt-get remove -y nodejs npm ;;
      dnf) sudo -n dnf remove -y nodejs npm ;;
      yum) sudo -n yum remove -y nodejs npm ;;
      apk) sudo -n apk del nodejs npm ;;
      pacman) sudo -n pacman -Rns --noconfirm nodejs npm ;;
    esac
    ;;
  nginx)
    sudo -n systemctl stop nginx >/dev/null 2>&1 || true
    case "$PM" in
      apt-get|apt) sudo -n apt-get remove -y nginx ;;
      dnf) sudo -n dnf remove -y nginx ;;
      yum) sudo -n yum remove -y nginx ;;
      apk) sudo -n apk del nginx ;;
      pacman) sudo -n pacman -Rns --noconfirm nginx ;;
    esac
    ;;
  pm2)
    if ! command -v npm >/dev/null 2>&1; then
      printf '%s\\n' "未找到 npm，无法卸载 pm2" >&2
      exit 3
    fi
    pm2 kill >/dev/null 2>&1 || true
    sudo -n env NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false npm uninstall -g pm2
    ;;
  python3)
    case "$PM" in
      apt-get|apt) sudo -n apt-get remove -y python3 python3-pip python3-venv ;;
      dnf) sudo -n dnf remove -y python3 python3-pip ;;
      yum) sudo -n yum remove -y python3 python3-pip ;;
      apk) sudo -n apk del python3 py3-pip ;;
      pacman) sudo -n pacman -Rns --noconfirm python python-pip ;;
    esac
    ;;
  postgresql)
    sudo -n systemctl stop postgresql >/dev/null 2>&1 || true
    sudo -n systemctl stop postgresql@16-main >/dev/null 2>&1 || true
    sudo -n systemctl stop postgresql@15-main >/dev/null 2>&1 || true
    sudo -n systemctl stop postgresql@14-main >/dev/null 2>&1 || true
    sudo -n systemctl stop postgresql@17-main >/dev/null 2>&1 || true
    case "$PM" in
      apt-get|apt) sudo -n apt-get remove -y postgresql postgresql-contrib ;;
      dnf) sudo -n dnf remove -y postgresql-server postgresql-contrib ;;
      yum) sudo -n yum remove -y postgresql-server postgresql-contrib ;;
      apk) sudo -n apk del postgresql postgresql-contrib ;;
      pacman) sudo -n pacman -Rns --noconfirm postgresql ;;
    esac
    ;;
  *)
    printf '%s\\n' "未知依赖: $DEP" >&2
    exit 2
    ;;
esac
printf '%s\\n' DIGWIS_DEP_OK
`
}

export async function installRemoteDependency(
  payload: VpsConnectionInput,
  dependencyId: string,
): Promise<DependencyInstallResult> {
  if (!VALID_DEPENDENCY_IDS.has(dependencyId)) {
    return { ok: false, message: "未知的依赖标识", stdout: "" }
  }

  const script = buildInstallScript(dependencyId)

  try {
    const result = await runRemoteCommand(payload, resolveSshConnectConfig(payload), script, { timeoutMs: 900_000 })
    const combined = `${result.stdout}\n${result.stderr}`
    const sawOk = combined.includes("DIGWIS_DEP_OK")

    if (result.code !== 0 || !sawOk) {
      const hint = result.stderr.trim() || result.stdout.trim()
      return {
        ok: false,
        message:
          hint.slice(0, 500) ||
          (result.code !== undefined ? `安装未完成，退出码 ${result.code}` : "安装未完成"),
        stdout: tailText(combined),
      }
    }

    return {
      ok: true,
      message: "安装已完成，正在刷新依赖状态…",
      stdout: tailText(combined),
    }
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      message: error instanceof Error ? error.message : "远程安装失败",
    }
  }
}

export async function uninstallRemoteDependency(
  payload: VpsConnectionInput,
  dependencyId: string,
): Promise<DependencyInstallResult> {
  if (!VALID_DEPENDENCY_IDS.has(dependencyId)) {
    return { ok: false, message: "未知的依赖标识", stdout: "" }
  }

  const script = buildUninstallScript(dependencyId)

  try {
    const result = await runRemoteCommand(payload, resolveSshConnectConfig(payload), script, { timeoutMs: 900_000 })
    const combined = `${result.stdout}\n${result.stderr}`
    const sawOk = combined.includes("DIGWIS_DEP_OK")

    if (result.code !== 0 || !sawOk) {
      const hint = result.stderr.trim() || result.stdout.trim()
      return {
        ok: false,
        message:
          hint.slice(0, 500) ||
          (result.code !== undefined ? `卸载未完成，退出码 ${result.code}` : "卸载未完成"),
        stdout: tailText(combined),
      }
    }

    return {
      ok: true,
      message: "卸载已完成，正在刷新依赖状态…",
      stdout: tailText(combined),
    }
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      message: error instanceof Error ? error.message : "远程卸载失败",
    }
  }
}
