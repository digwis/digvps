import type {
  SystemUpgradeApplyResult,
  SystemUpgradeCheckResult,
  VpsConnectionInput,
} from "../../shared/vps"
import { runSshCommand } from "./remote-command"

const upgradeCheckScript = `
set +e
status=unsupported
reason=
manager=none
upgradable_count=0
index_refreshed=0

if [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
else
  run_privileged() { sudo -n "$@"; }
fi

if command -v apt >/dev/null 2>&1; then
  manager=apt
elif command -v apt-get >/dev/null 2>&1; then
  manager=apt-get
fi

if [ "$manager" = "none" ]; then
  printf 'status=unsupported\\n'
  printf 'reason=no_apt\\n'
  printf 'manager=none\\n'
  printf 'upgradable_count=0\\n'
  printf 'index_refreshed=0\\n'
  exit 0
fi

if run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>/dev/null; then
  index_refreshed=1
fi

if [ "$manager" = "apt" ]; then
  upgradable_count=$(apt list --upgradable 2>/dev/null | grep -cF '[upgradable from:' || true)
else
  upgradable_count=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
fi
case "$upgradable_count" in ''|*[!0-9]*) upgradable_count=0 ;; esac

printf 'status=supported\\n'
printf 'manager=%s\\n' "$manager"
printf 'upgradable_count=%s\\n' "$upgradable_count"
printf 'index_refreshed=%s\\n' "$index_refreshed"
exit 0
`

export function parseCheckOutput(raw: string): SystemUpgradeCheckResult {
  const map = new Map<string, string>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.includes("=")) {
      continue
    }
    const idx = trimmed.indexOf("=")
    map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1))
  }

  const status = map.get("status")
  const supported = status === "supported"
  const countRaw = map.get("upgradable_count") ?? "0"
  const upgradableCount = Number.parseInt(countRaw, 10)
  const indexRefreshed = map.get("index_refreshed") === "1"
  const manager = (map.get("manager") ?? "none") as SystemUpgradeCheckResult["manager"]
  const reason = map.get("reason")

  return {
    supported,
    manager: manager === "apt" || manager === "apt-get" || manager === "none" ? manager : "none",
    upgradableCount: Number.isFinite(upgradableCount) ? Math.max(0, upgradableCount) : 0,
    indexRefreshed,
    reason: reason || undefined,
  }
}

export async function checkSystemUpgrades(payload: VpsConnectionInput): Promise<SystemUpgradeCheckResult> {
  const raw = await runSshCommand(payload, upgradeCheckScript, {
    timeoutMs: 120_000,
    timeoutMessage: "远程命令执行超时",
  })
  if (raw.code !== 0 && raw.stderr.trim()) {
    return {
      supported: false,
      manager: "none",
      upgradableCount: 0,
      indexRefreshed: false,
      reason: "exec_error",
      hint: raw.stderr.trim().slice(0, 400),
    }
  }
  return parseCheckOutput(raw.stdout)
}

function buildApplyScript(reboot: boolean): string {
  const rebootLine = reboot
    ? `run_privileged env DEBIAN_FRONTEND=noninteractive shutdown -r +0 "digwis-panel maintenance reboot" || true\n`
    : ""
  return `
set -e
export DEBIAN_FRONTEND=noninteractive
if [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
else
  run_privileged() { sudo -n "$@"; }
fi
run_privileged apt-get update -qq
run_privileged apt-get full-upgrade -y
run_privileged apt-get autoremove -y
printf '%s\\n' "DIGWIS_UPGRADE_DONE"
${rebootLine}`
}

function tailText(text: string, max = 4000): string {
  if (text.length <= max) {
    return text
  }
  return text.slice(-max)
}

/** 判断错误是否属于 SSH 连接在执行期间被中断（socket 重置 / 对端关闭）。 */
function isConnectionInterruption(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  const msg = error.message.toLowerCase()
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    msg.includes("econnreset") ||
    msg.includes("connection closed") ||
    msg.includes("socket hang up") ||
    msg.includes("disconnected")
  )
}

export async function applySystemUpgrade(
  payload: VpsConnectionInput,
  options: { reboot: boolean },
): Promise<SystemUpgradeApplyResult> {
  const script = buildApplyScript(options.reboot)
  try {
    const result = await runSshCommand(payload, script, {
      timeoutMs: 900_000,
      timeoutMessage: "远程命令执行超时",
    })
    const combined = `${result.stdout}\n${result.stderr}`
    const sawDoneMarker = combined.includes("DIGWIS_UPGRADE_DONE")
    const ok = result.code === 0 || (options.reboot && sawDoneMarker)

    if (!ok && result.stderr.trim()) {
      return {
        ok: false,
        stdout: tailText(combined),
        message: result.stderr.trim().slice(0, 500) || "升级命令未成功完成",
      }
    }

    if (!ok) {
      return {
        ok: false,
        stdout: tailText(combined),
        message: `命令退出码: ${result.code ?? "unknown"}`,
      }
    }

    return {
      ok: true,
      likelyRebooting: options.reboot,
      stdout: tailText(combined),
      message: options.reboot
        ? "升级已完成，主机正在或即将重启，请稍后重新连接。"
        : "升级与清理已完成。若内核有更新，请在服务器上自行执行重启以生效。",
    }
  } catch (error) {
    // 连接在升级期间中断（如 apt 升级 openssh-server 触发 sshd 重启）。
    // 此时升级可能已成功或仍在进行，不能当作硬失败，应触发重新检测。
    if (isConnectionInterruption(error)) {
      if (options.reboot) {
        return {
          ok: true,
          likelyRebooting: true,
          stdout: "",
          message: "连接已中断，主机可能正在重启。请稍后重新检测或重新连接。",
        }
      }
      return {
        ok: false,
        likelyInterrupted: true,
        stdout: "",
        message:
          "升级期间 SSH 连接被中断，远程升级可能已成功或仍在进行。请稍后重新检测软件更新以确认结果。",
      }
    }
    return {
      ok: false,
      stdout: "",
      message: error instanceof Error ? error.message : "升级执行失败",
    }
  }
}
