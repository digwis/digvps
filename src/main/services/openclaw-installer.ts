import { randomUUID } from "node:crypto"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"
import type {
  OpenClawInstance,
  OpenClawInstanceStatus,
  OpenClawPrecheck,
  OpenClawPrecheckReason,
} from "../../shared/projects"

export const OPENCLAW_BASE_PORT = 18789
export const OPENCLAW_MAX_INSTANCES = 4
export const OPENCLAW_MIN_MEMORY_MB = 350

export function ensurePortInRange(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`端口 ${port} 不在合法范围内`)
  }
  return port
}

export function nextAvailablePort(base: number, used: number[]): number {
  const occupied = new Set(used)
  for (let offset = 0; offset < OPENCLAW_MAX_INSTANCES; offset += 1) {
    const port = base + offset
    if (!occupied.has(port)) return port
  }
  throw new Error("已达到单 VPS 最大 OpenClaw 实例数量")
}

export function parseSystemdUnitList(stdout: string): number[] {
  const ports: number[] = []
  for (const line of stdout.split("\n")) {
    const match = line.match(/openclaw@(\d+)\.service/)
    if (match) {
      ports.push(Number(match[1]))
    }
  }
  return ports
}

export function detectStatusFromSystemctl(stdout: string): OpenClawInstanceStatus {
  const trimmed = stdout.trim()
  if (trimmed.includes("active (running)")) return "running"
  if (trimmed.includes("inactive (dead)")) return "stopped"
  if (trimmed.includes("failed")) return "failed"
  return "unknown"
}

export function buildSystemdUnit(port: number): string {
  return `[Unit]
Description=OpenClaw Gateway (port ${port})
After=network.target

[Service]
Type=simple
Environment=OPENCLAW_PORT=${port}
Environment=OPENCLAW_HOME=/root/.openclaw-${port}
ExecStart=/usr/bin/env OPENCLAW_PORT=${port} OPENCLAW_HOME=/root/.openclaw-${port} openclaw gateway --port ${port}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`
}

export function buildPrecheck(args: {
  nodeVersion?: string
  memoryAvailableMb?: number
  portInUse: boolean
  existingInstances: number
  systemdPresent: boolean
}): OpenClawPrecheck {
  const reasons: OpenClawPrecheckReason[] = []
  if (!args.nodeVersion) reasons.push("node_missing")
  else {
    const major = Number(args.nodeVersion.replace(/^v/, "").split(".")[0])
    if (Number.isFinite(major) && major < 20) reasons.push("node_too_old")
  }
  if (
    typeof args.memoryAvailableMb === "number" &&
    args.memoryAvailableMb < OPENCLAW_MIN_MEMORY_MB
  ) {
    reasons.push("memory_low")
  }
  if (args.portInUse) reasons.push("port_in_use")
  if (!args.systemdPresent) reasons.push("systemd_missing")
  if (args.existingInstances >= OPENCLAW_MAX_INSTANCES) {
    reasons.push("instance_limit_reached")
  }
  return {
    ready: reasons.length === 0,
    reasons,
    nodeVersion: args.nodeVersion,
    memoryAvailableMb: args.memoryAvailableMb,
    existingInstances: args.existingInstances,
    portInUse: args.portInUse,
  }
}

export function generateInstanceId(): string {
  return randomUUID()
}

export type { OpenClawInstance }

async function detectPackageManager(
  payload: VpsConnectionInput,
): Promise<"apt" | "dnf" | "yum" | "unknown"> {
  for (const cmd of [
    "command -v apt-get",
    "command -v dnf",
    "command -v yum",
  ]) {
    const { code, stdout } = await runRemoteShellCommand(payload, cmd, {
      timeoutMs: 5_000,
    })
    if (code === 0 && stdout.trim()) {
      if (cmd.includes("apt")) return "apt"
      if (cmd.includes("dnf")) return "dnf"
      return "yum"
    }
  }
  return "unknown"
}

export async function precheckOpenClawInstall(
  payload: VpsConnectionInput & { listenPort: number },
): Promise<OpenClawPrecheck> {
  const [node, mem, portLine, units, systemd] = await Promise.all([
    runRemoteShellCommand(payload, "node --version 2>/dev/null || true", {
      timeoutMs: 5_000,
    }),
    runRemoteShellCommand(payload, "free -m | awk '/Mem:/ {print $7}'", {
      timeoutMs: 5_000,
    }),
    runRemoteShellCommand(
      payload,
      `ss -ltn 2>/dev/null | grep -E ':${payload.listenPort} ' || true`,
      { timeoutMs: 5_000 },
    ),
    runRemoteShellCommand(
      payload,
      "systemctl list-unit-files 2>/dev/null | awk '/openclaw@/{print $1}' || true",
      { timeoutMs: 5_000 },
    ),
    runRemoteShellCommand(payload, "command -v systemctl", { timeoutMs: 5_000 }),
  ])
  const usedPorts = parseSystemdUnitList(units.stdout)
  return buildPrecheck({
    nodeVersion: node.stdout.trim() || undefined,
    memoryAvailableMb: Number(mem.stdout.trim()) || undefined,
    portInUse: portLine.stdout.trim().length > 0,
    existingInstances: usedPorts.length,
    systemdPresent: systemd.code === 0,
  })
}

export async function installOpenClaw(
  payload: VpsConnectionInput & { listenPort: number },
  onProgress?: (msg: string) => void,
): Promise<OpenClawInstance> {
  const port = ensurePortInRange(payload.listenPort)
  onProgress?.("检测包管理器…")
  const pkg = await detectPackageManager(payload)
  if (pkg === "unknown") {
    throw new Error("未识别包管理器（apt/dnf/yum），无法自动安装 Node")
  }
  onProgress?.(`检测到包管理器：${pkg}`)

  onProgress?.("检查 Node 版本…")
  const nodeCheck = await runRemoteShellCommand(
    payload,
    "node --version 2>/dev/null || true",
    { timeoutMs: 5_000 },
  )
  const major = Number(nodeCheck.stdout.trim().replace(/^v/, "").split(".")[0])
  if (!nodeCheck.stdout.trim() || (Number.isFinite(major) && major < 20)) {
    onProgress?.("安装 Node.js 20.x…")
    if (pkg === "apt") {
      await runRemoteShellCommand(
        payload,
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs",
        { timeoutMs: 240_000 },
      )
    } else {
      await runRemoteShellCommand(
        payload,
        "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && (dnf install -y nodejs || yum install -y nodejs)",
        { timeoutMs: 240_000 },
      )
    }
  }

  onProgress?.("安装 OpenClaw…")
  await runRemoteShellCommand(payload, "npm i -g openclaw@latest", {
    timeoutMs: 300_000,
  })

  const serviceName = `openclaw@${port}.service`
  const dataDir = `/root/.openclaw-${port}`
  const unit = buildSystemdUnit(port)
  onProgress?.("写入 systemd unit…")
  await runRemoteShellCommand(
    payload,
    `mkdir -p ${dataDir} && cat > /etc/systemd/system/${serviceName} <<'EOF'\n${unit}\nEOF`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(
    payload,
    `systemctl daemon-reload && systemctl enable --now ${serviceName}`,
    { timeoutMs: 30_000 },
  )

  const status = await runRemoteShellCommand(
    payload,
    `systemctl status ${serviceName} --no-pager || true`,
    { timeoutMs: 10_000 },
  )
  const version = await runRemoteShellCommand(
    payload,
    "openclaw --version 2>/dev/null || true",
    { timeoutMs: 5_000 },
  )

  return {
    id: generateInstanceId(),
    connectionId: payload.id ?? "",
    host: payload.host,
    listenPort: port,
    dataDir,
    serviceName,
    nodeVersion: nodeCheck.stdout.trim() || undefined,
    openclawVersion: version.stdout.trim() || undefined,
    status: detectStatusFromSystemctl(status.stdout),
    installedAt: new Date().toISOString(),
  }
}

export async function uninstallOpenClaw(
  payload: VpsConnectionInput & { listenPort: number; dataDir: string },
) {
  await runRemoteShellCommand(
    payload,
    `systemctl disable --now openclaw@${payload.listenPort}.service || true`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(
    payload,
    `rm -f /etc/systemd/system/openclaw@${payload.listenPort}.service && systemctl daemon-reload`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(payload, `rm -rf ${payload.dataDir}`, {
    timeoutMs: 10_000,
  })
  return { ok: true as const }
}

export async function restartOpenClaw(
  payload: VpsConnectionInput & { listenPort: number },
) {
  await runRemoteShellCommand(
    payload,
    `systemctl restart openclaw@${payload.listenPort}.service`,
    { timeoutMs: 10_000 },
  )
  return { ok: true as const }
}

export async function fetchOpenClawLogs(
  payload: VpsConnectionInput & { listenPort: number; lines: number },
) {
  const { stdout } = await runRemoteShellCommand(
    payload,
    `journalctl -u openclaw@${payload.listenPort}.service -n ${payload.lines} --no-pager 2>/dev/null || true`,
    { timeoutMs: 10_000 },
  )
  return stdout
}

export type RemoteOpenClawStatus = OpenClawInstanceStatus

export async function listOpenClawInstancesRemote(
  payload: VpsConnectionInput,
  rows: Array<{
    id: string
    connection_id: string
    listen_port: number
    data_dir: string
    service_name: string
    installed_at: string
  }>,
): Promise<OpenClawInstance[]> {
  const out: OpenClawInstance[] = []
  for (const row of rows) {
    const status = await runRemoteShellCommand(
      payload,
      `systemctl status ${row.service_name} --no-pager || true`,
      { timeoutMs: 5_000 },
    ).catch(() => ({ code: -1, stdout: "", stderr: "" }))
    out.push({
      id: row.id,
      connectionId: row.connection_id,
      host: payload.host,
      listenPort: row.listen_port,
      dataDir: row.data_dir,
      serviceName: row.service_name,
      status: detectStatusFromSystemctl(status.stdout),
      installedAt: row.installed_at,
      lastCheckedAt: new Date().toISOString(),
    })
  }
  return out
}