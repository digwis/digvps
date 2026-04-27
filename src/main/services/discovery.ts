import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  DiscoveredHostCandidate,
  SshConfigCandidate,
  SshConfigMutationInput,
  VpsConnectionInput,
} from "../../shared/vps"

type HostEntry = {
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  configPath: string
  startLine: number
  endLine: number
}

function getPrimarySshConfigPath() {
  return path.join(os.homedir(), ".ssh", "config")
}

export function getRawSshConfig() {
  const filePath = getPrimarySshConfigPath()
  if (!fs.existsSync(filePath)) {
    return { path: filePath, content: "" }
  }
  return { path: filePath, content: fs.readFileSync(filePath, "utf8") }
}

export function saveRawSshConfig(content: string) {
  const filePath = getPrimarySshConfigPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
  return { path: filePath, content: fs.readFileSync(filePath, "utf8") }
}

function expandHome(value: string) {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function resolveConfigPath(filePath: string, parentFilePath?: string) {
  const expanded = expandHome(filePath)
  if (path.isAbsolute(expanded)) {
    return expanded
  }
  if (parentFilePath) {
    return path.resolve(path.dirname(parentFilePath), expanded)
  }
  return expanded
}

function parseConfigFile(filePath: string, visited = new Set<string>()) {
  const resolved = resolveConfigPath(filePath)
  if (!fs.existsSync(resolved) || visited.has(resolved)) {
    return [] as HostEntry[]
  }

  visited.add(resolved)
  const content = fs.readFileSync(resolved, "utf8")
  const lines = content.split(/\r?\n/)
  const hosts: HostEntry[] = []
  let current: HostEntry | null = null

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const [keyword, ...rest] = line.split(/\s+/)
    const value = rest.join(" ").trim()
    const lowerKeyword = keyword.toLowerCase()

    if (lowerKeyword === "include") {
      for (const includeItem of value.split(/\s+/)) {
        hosts.push(...parseConfigFile(resolveConfigPath(includeItem, resolved), visited))
      }
      continue
    }

    if (lowerKeyword === "host") {
      if (current) {
        current.endLine = index
      }
      const aliases = value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item && !item.includes("*") && !item.includes("?"))
      current = aliases.length > 0 ? { aliases, configPath: resolved, startLine: index, endLine: lines.length } : null
      if (current) {
        hosts.push(current)
      }
      continue
    }

    if (!current) {
      continue
    }

    if (lowerKeyword === "hostname") current.hostName = value
    if (lowerKeyword === "user") current.user = value
    if (lowerKeyword === "port") {
      const port = Number(value)
      current.port = Number.isFinite(port) ? port : undefined
    }
    if (lowerKeyword === "identityfile") current.identityFile = resolveConfigPath(value, resolved)
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

function listHostBlocksFromFile(filePath: string) {
  return parseConfigFile(filePath, new Set()).filter((entry) => entry.configPath === resolveConfigPath(filePath))
}

function findHostBlock(filePath: string, originalName: string) {
  return listHostBlocksFromFile(filePath).find((entry) => entry.aliases.includes(originalName))
}

function findHostBlockForConnection(filePath: string, payload: {
  name: string
  host: string
  username: string
  port: number
}) {
  const resolved = resolveConfigPath(filePath)
  return listHostBlocksFromFile(resolved).find((entry) => {
    const host = entry.hostName ?? entry.aliases[0]
    const username = entry.user?.split("@")[0] ?? "root"
    const port = entry.port ?? 22
    return (
      entry.aliases.includes(payload.name) ||
      (host === payload.host && username === payload.username && port === payload.port)
    )
  })
}

function upsertDirective(lines: string[], key: string, nextValue?: string) {
  const lowerKey = key.toLowerCase()
  const index = lines.findIndex((line, lineIndex) => {
    if (lineIndex === 0) {
      return false
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      return false
    }
    const [directive] = trimmed.split(/\s+/)
    return directive.toLowerCase() === lowerKey
  })

  if (!nextValue) {
    if (index >= 0) {
      lines.splice(index, 1)
    }
    return lines
  }

  if (index >= 0) {
    const indent = lines[index].match(/^\s*/)?.[0] ?? "  "
    lines[index] = `${indent}${key} ${nextValue}`
    return lines
  }

  lines.push(`  ${key} ${nextValue}`)
  return lines
}

function writeLines(filePath: string, lines: string[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const content = `${lines.join("\n").replace(/\n+$/u, "")}\n`
  fs.writeFileSync(filePath, content, "utf8")
}

function normalizeMutation(payload: SshConfigMutationInput) {
  const nextName = payload.name.trim()
  const nextHost = payload.host.trim()
  const nextUsername = payload.username.trim()
  const nextPort = Number(payload.port)
  const nextIdentityFilePath = payload.identityFilePath?.trim() || undefined

  if (!nextName || !nextHost || !nextUsername || !Number.isFinite(nextPort) || nextPort <= 0) {
    throw new Error("SSH 配置项不完整，无法写回本机配置")
  }

  return { nextName, nextHost, nextUsername, nextPort, nextIdentityFilePath }
}

function assertNoDuplicate(nextName: string, configPath: string, originalName?: string) {
  const duplicate = listSshConfigCandidates().find(
    (item) => item.name === nextName && !(item.configPath === configPath && item.name === originalName),
  )
  if (duplicate) {
    throw new Error(`SSH 主机别名 \"${nextName}\" 已存在，请更换名称`)
  }
}

export function discoverLocalConnections(): Array<VpsConnectionInput & { source: "ssh-config" }> {
  const hosts = parseConfigFile(getPrimarySshConfigPath())
  const discovered: Array<(VpsConnectionInput & { source: "ssh-config" }) | null> = hosts.map((entry) => {
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
  })

  return discovered.filter((item): item is VpsConnectionInput & { source: "ssh-config" } => item !== null)
}

export function listSshConfigCandidates(): SshConfigCandidate[] {
  return parseConfigFile(getPrimarySshConfigPath()).flatMap((item) => {
    const host = item.hostName ?? item.aliases[0]
    const username = item.user?.split("@")[0] ?? "root"
    if (!host || !username) {
      return []
    }
    return [
      {
        name: item.aliases[0] || `${username}@${host}`,
        host,
        port: item.port ?? 22,
        username,
        authType: readPrivateKey(item.identityFile) ? ("privateKey" as const) : ("password" as const),
        source: "ssh-config" as const,
        configPath: item.configPath,
        identityFilePath: item.identityFile,
      },
    ]
  })
}

export function createSshConfigCandidate(payload: SshConfigMutationInput) {
  const filePath = resolveConfigPath(payload.configPath || getPrimarySshConfigPath())
  const { nextName, nextHost, nextUsername, nextPort, nextIdentityFilePath } = normalizeMutation(payload)
  assertNoDuplicate(nextName, filePath)

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").replace(/\n+$/u, "") : ""
  const blockLines = [
    `Host ${nextName}`,
    `  HostName ${nextHost}`,
    `  User ${nextUsername}`,
    `  Port ${nextPort}`,
    ...(nextIdentityFilePath ? [`  IdentityFile ${nextIdentityFilePath}`] : []),
  ]
  const nextContent = existing ? `${existing}\n\n${blockLines.join("\n")}\n` : `${blockLines.join("\n")}\n`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, nextContent, "utf8")
  return listSshConfigCandidates()
}

export function updateSshConfigCandidate(payload: SshConfigMutationInput) {
  if (!payload.originalName) {
    throw new Error("缺少原始 SSH 主机别名，无法更新")
  }

  const filePath = resolveConfigPath(payload.configPath)
  const { nextName, nextHost, nextUsername, nextPort, nextIdentityFilePath } = normalizeMutation(payload)
  assertNoDuplicate(nextName, filePath, payload.originalName)

  const block = findHostBlock(filePath, payload.originalName)
  if (!block) {
    throw new Error("未找到对应的 SSH 配置项，可能已被外部修改")
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/)
  const blockLines = lines.slice(block.startLine, block.endLine)
  if (blockLines.length === 0) {
    throw new Error("SSH 配置项内容为空，无法写回")
  }

  blockLines[0] = `Host ${nextName}`
  upsertDirective(blockLines, "HostName", nextHost)
  upsertDirective(blockLines, "User", nextUsername)
  upsertDirective(blockLines, "Port", String(nextPort))
  upsertDirective(blockLines, "IdentityFile", nextIdentityFilePath)

  lines.splice(block.startLine, block.endLine - block.startLine, ...blockLines)
  writeLines(filePath, lines)
  return listSshConfigCandidates()
}

export function ensureSshConfigCandidateForConnection(payload: {
  name: string
  host: string
  port: number
  username: string
  identityFilePath: string
}) {
  const filePath = resolveConfigPath(getPrimarySshConfigPath())
  const existing = findHostBlockForConnection(filePath, payload)

  if (existing) {
    updateSshConfigCandidate({
      configPath: existing.configPath,
      originalName: existing.aliases[0] || payload.name,
      name: payload.name,
      host: payload.host,
      port: payload.port,
      username: payload.username,
      identityFilePath: payload.identityFilePath,
    })
    return {
      configPath: existing.configPath,
      hostName: payload.name,
    }
  }

  createSshConfigCandidate({
    configPath: filePath,
    name: payload.name,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    identityFilePath: payload.identityFilePath,
  })
  return {
    configPath: filePath,
    hostName: payload.name,
  }
}

export function deleteSshConfigCandidate(payload: { configPath: string; originalName: string }) {
  const filePath = resolveConfigPath(payload.configPath)
  const block = findHostBlock(filePath, payload.originalName)
  if (!block) {
    throw new Error("未找到要删除的 SSH 配置项，可能已被外部修改")
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/)
  let deleteStart = block.startLine
  let deleteEnd = block.endLine

  while (deleteEnd < lines.length && !lines[deleteEnd].trim()) {
    deleteEnd += 1
  }
  if (deleteStart > 0 && !lines[deleteStart - 1].trim()) {
    deleteStart -= 1
  }

  lines.splice(deleteStart, deleteEnd - deleteStart)
  writeLines(filePath, lines)
  return listSshConfigCandidates()
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
