import { randomUUID } from "node:crypto"
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