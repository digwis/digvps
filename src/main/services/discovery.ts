import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  DiscoveredHostCandidate,
  SshConfigCandidate,
  VpsConnectionInput,
} from "../../shared/vps"

type HostEntry = {
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
}

function expandHome(value: string) {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function parseConfigFile(filePath: string, visited = new Set<string>()) {
  const resolved = expandHome(filePath)
  if (!fs.existsSync(resolved) || visited.has(resolved)) {
    return [] as HostEntry[]
  }

  visited.add(resolved)
  const content = fs.readFileSync(resolved, "utf8")
  const lines = content.split(/\r?\n/)
  const hosts: HostEntry[] = []
  let current: HostEntry | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const [keyword, ...rest] = line.split(/\s+/)
    const value = rest.join(" ").trim()
    const lowerKeyword = keyword.toLowerCase()

    if (lowerKeyword === "include") {
      for (const includeItem of value.split(/\s+/)) {
        hosts.push(...parseConfigFile(includeItem, visited))
      }
      continue
    }

    if (lowerKeyword === "host") {
      const aliases = value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item && !item.includes("*") && !item.includes("?"))
      current = aliases.length > 0 ? { aliases } : null
      if (current) {
        hosts.push(current)
      }
      continue
    }

    if (!current) {
      continue
    }

    if (lowerKeyword === "hostname") {
      current.hostName = value
    }

    if (lowerKeyword === "user") {
      current.user = value
    }

    if (lowerKeyword === "port") {
      const port = Number(value)
      current.port = Number.isFinite(port) ? port : undefined
    }

    if (lowerKeyword === "identityfile") {
      current.identityFile = expandHome(value)
    }
  }

  return hosts
}

function readPrivateKey(filePath?: string) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined
  }

  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
}

export function discoverLocalConnections(): Array<VpsConnectionInput & { source: "ssh-config" }> {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config")
  const hosts = parseConfigFile(sshConfigPath)
  const discovered: Array<(VpsConnectionInput & { source: "ssh-config" }) | null> = hosts.map(
    (entry) => {
      const host = entry.hostName ?? entry.aliases[0]
      const username = entry.user?.split("@")[0] ?? "root"
      const privateKey = readPrivateKey(entry.identityFile)
      const alias = entry.aliases[0]

      if (!host || !username) {
        return null
      }

      return {
        name: alias || `${username}@${host}`,
        host,
        port: entry.port ?? 22,
        username,
        authType: privateKey ? ("privateKey" as const) : ("password" as const),
        privateKey,
        source: "ssh-config" as const,
      }
    },
  )

  return discovered.filter(
    (item): item is VpsConnectionInput & { source: "ssh-config" } => item !== null,
  )
}

export function listSshConfigCandidates(): SshConfigCandidate[] {
  return discoverLocalConnections().map((item) => ({
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    authType: item.authType,
    source: "ssh-config",
  }))
}

export function discoverKnownHosts(
  existingHosts: Array<{ host: string; port: number }>,
): DiscoveredHostCandidate[] {
  const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts")
  if (!fs.existsSync(knownHostsPath)) {
    return []
  }

  const knownHosts = fs.readFileSync(knownHostsPath, "utf8").split(/\r?\n/)
  const existing = new Set(existingHosts.map((item) => `${item.host}:${item.port}`))
  const discovered = new Map<string, DiscoveredHostCandidate>()

  for (const line of knownHosts) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("|")) {
      continue
    }

    const [hostField] = trimmed.split(/\s+/)
    for (const rawHost of hostField.split(",")) {
      if (!rawHost || rawHost.includes("*") || rawHost.includes("?")) {
        continue
      }

      let host = rawHost
      let port = 22
      const bracketMatch = rawHost.match(/^\[([^\]]+)\]:(\d+)$/)
      if (bracketMatch) {
        host = bracketMatch[1]
        port = Number(bracketMatch[2])
      }

      if (existing.has(`${host}:${port}`) || discovered.has(`${host}:${port}`)) {
        continue
      }

      discovered.set(`${host}:${port}`, {
        name: host,
        host,
        port,
        source: "known-hosts",
      })
    }
  }

  return Array.from(discovered.values()).sort((left, right) => left.host.localeCompare(right.host))
}
