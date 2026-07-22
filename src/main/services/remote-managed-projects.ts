import type {
  RemoteManagedProject,
  RemoteManagedProjectPathSource,
  RemoteManagedProjectScanResult,
} from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"
import { getDefaultRemoteDirectory } from "./settings"

const NGINX_CONFIG_PATHS = [
  "/etc/nginx/conf.d",
  "/etc/nginx/sites-enabled",
  "/etc/nginx/sites-available",
] as const

const FALLBACK_PROBE_DIRS = [
  "/srv/www",
  "/opt",
] as const

const HEURISTIC_PROBE_LIMIT = 6

function getHeuristicProbeDirs(): string[] {
  const defaultDir = getDefaultRemoteDirectory()
  const dirs = [defaultDir]
  for (const dir of FALLBACK_PROBE_DIRS) {
    if (!dirs.includes(dir)) {
      dirs.push(dir)
    }
  }
  return dirs
}

const SHELL_QUOTE = (() => {
  const charsToEscape = new Set(["$", "`", "\\", "\"", "!", "\n"])
  return (value: string) =>
    "'" +
    value.replace(/'/g, "'\\''") +
    "'"
})()

function shellQuote(value: string): string {
  // simple defensive wrapper, real implementation lives in shared helpers when needed
  if (!/[^\w./-]/.test(value)) {
    return value
  }
  return SHELL_QUOTE(value)
}

export function parseNginxProxyServers(
  configPath: string,
  content: string,
): RemoteManagedProject[] {
  const blocks = content.match(/server\s*\{[\s\S]*?\}/g) ?? []
  const projects: RemoteManagedProject[] = []
  for (const [index, block] of blocks.entries()) {
    const serverName = block
      .match(/server_name\s+([^;]+);/)?.[1]
      ?.trim()
      .split(/\s+/)[0]
    const proxyPass = block.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim()
    if (!serverName || !proxyPass) {
      continue
    }
    projects.push({
      id: `${configPath}#${index}#${serverName}`,
      connectionId: "",
      domain: serverName,
      nginxConfigPath: configPath,
      proxyTarget: proxyPass,
      pathSource: "unknown",
      runtimeType: "unknown",
      status: "unknown",
      statusText: "已识别反向代理站点，尚未推断项目路径",
    })
  }
  return projects
}

export function chooseProjectPath(paths: {
  systemdPath?: string
  pm2Path?: string
  dockerPath?: string
  heuristicPath?: string
}): { projectPath?: string; pathSource: RemoteManagedProjectPathSource } {
  if (paths.systemdPath) {
    return { projectPath: paths.systemdPath, pathSource: "systemd" }
  }
  if (paths.pm2Path) {
    return { projectPath: paths.pm2Path, pathSource: "pm2" }
  }
  if (paths.dockerPath) {
    return { projectPath: paths.dockerPath, pathSource: "docker" }
  }
  if (paths.heuristicPath) {
    return { projectPath: paths.heuristicPath, pathSource: "heuristic" }
  }
  return { pathSource: "unknown" }
}

function applyPathChoice(
  project: RemoteManagedProject,
  choice: { projectPath?: string; pathSource: RemoteManagedProjectPathSource },
) {
  return {
    ...project,
    projectPath: choice.projectPath,
    pathSource: choice.pathSource,
    status: choice.projectPath ? ("ok" as const) : ("unknown" as const),
    statusText: choice.projectPath
      ? `项目路径来源：${choice.pathSource}`
      : "反向代理站点已识别，尚未推断项目目录",
  }
}

function extractListenPort(proxyTarget: string): number | null {
  const match = proxyTarget.match(/(?:\/|:)(\d{2,5})\b/)
  if (!match) {
    return null
  }
  const port = Number(match[1])
  return Number.isFinite(port) ? port : null
}

async function scanDirectory(project: RemoteManagedProject, dir: string) {
  const { code, stdout, stderr } = await runRemoteShellCommand(
    {} as VpsConnectionInput,
    `test -d ${shellQuote(dir)} && echo OK || echo MISSING`,
    { timeoutMs: 5_000 },
  )
  if (code !== 0 || stdout.trim() !== "OK") {
    return null
  }
  return dir
}

async function probeHeuristicPath(
  payload: VpsConnectionInput,
  project: RemoteManagedProject,
): Promise<string | undefined> {
  for (const base of getHeuristicProbeDirs()) {
    const result = await runRemoteShellCommand(
      payload,
      [
        "if [ -d",
        shellQuote(base),
        "]; then ls -1",
        shellQuote(base),
        `| head -n ${HEURISTIC_PROBE_LIMIT}`,
        "| sed 's#^#${base}/#'",
        "; fi",
      ].join(" "),
      { timeoutMs: 5_000 },
    )
    if (result.code !== 0) {
      continue
    }
    const entries = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const tokens = project.domain.split(".").slice(0, 2).join(".")
    const matched = entries.find((entry) => entry.endsWith(`${base}/${tokens}`))
    if (matched) {
      return matched
    }
    const fallback = entries.find((entry) => /\/(app|web|server)$/.test(entry))
    if (fallback) {
      return fallback
    }
  }
  return undefined
}

async function inferPathFromProcessManager(
  payload: VpsConnectionInput,
  project: RemoteManagedProject,
): Promise<{ projectPath?: string; serviceName?: string; runtimeType?: RemoteManagedProject["runtimeType"]; pathSource: RemoteManagedProjectPathSource }> {
  const port = extractListenPort(project.proxyTarget)
  if (!port) {
    return { pathSource: "unknown" }
  }
  const probeCommand = [
    "for unit in $(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}'); do",
    `  if systemctl show -p WorkingDirectory "$unit" 2>/dev/null | grep -q WorkingDirectory=; then`,
    `    cwd=$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null);`,
    `    if ss -ltnp 2>/dev/null | grep -q ":${port} "; then`,
    `      echo "$unit|$cwd";`,
    "    fi;",
    "  fi;",
    "done",
  ].join(" ")
  const systemdResult = await runRemoteShellCommand(payload, probeCommand, {
    timeoutMs: 8_000,
  })
  if (systemdResult.code === 0) {
    const first = systemdResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
    if (first) {
      const [unit, cwd] = first.split("|")
      if (cwd) {
        return {
          projectPath: cwd,
          serviceName: unit,
          runtimeType: "node",
          pathSource: "systemd",
        }
      }
    }
  }
  const pm2Result = await runRemoteShellCommand(
    payload,
    `command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | head -c 4096 || true`,
    { timeoutMs: 5_000 },
  )
  if (pm2Result.code === 0 && pm2Result.stdout.trim()) {
    try {
      const list = JSON.parse(pm2Result.stdout) as Array<{
        name?: string
        pm2_env?: { pm_cwd?: string; status?: string }
      }>
      const matched = list.find((entry) =>
        typeof entry?.pm2_env?.pm_cwd === "string",
      )
      if (matched?.pm2_env?.pm_cwd) {
        return {
          projectPath: matched.pm2_env.pm_cwd,
          serviceName: matched.name,
          runtimeType: "pm2",
          pathSource: "pm2",
        }
      }
    } catch {
      // pm2 jlist not JSON, ignore
    }
  }
  const dockerResult = await runRemoteShellCommand(
    payload,
    `command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}|{{.Ports}}|{{.Mounts}}' || true`,
    { timeoutMs: 5_000 },
  )
  if (dockerResult.code === 0 && dockerResult.stdout.trim()) {
    const line = dockerResult.stdout
      .split("\n")
      .map((row) => row.trim())
      .find((row) => row.includes(`:${port}->`))
    if (line) {
      const mountMatch = line.match(/^[^|]+\|[^|]+\|(.+)$/)
      if (mountMatch) {
        const mounts = mountMatch[1].split(",").map((entry) => entry.trim())
        const bind = mounts.find((entry) => entry.includes("bind"))
        if (bind) {
          const host = bind.split(":")[0]
          return {
            projectPath: host,
            runtimeType: "docker",
            pathSource: "docker",
          }
        }
      }
    }
  }
  const heuristic = await probeHeuristicPath(payload, project)
  if (heuristic) {
    return { projectPath: heuristic, pathSource: "heuristic" }
  }
  return { pathSource: "unknown" }
}

async function readNginxFiles(
  payload: VpsConnectionInput,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const listCommand = [
    "for dir in",
    NGINX_CONFIG_PATHS.map(shellQuote).join(" "),
    "; do",
    "  if [ -d \"$dir\" ]; then",
    "    find \"$dir\" -maxdepth 1 -type f \\( -name '*.conf' -o -name 'sites-*' \\) 2>/dev/null;",
    "  fi;",
    "done",
  ].join(" ")
  const listResult = await runRemoteShellCommand(payload, listCommand, {
    timeoutMs: 8_000,
  })
  if (listResult.code !== 0) {
    return result
  }
  const files = listResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (const file of files) {
    const readResult = await runRemoteShellCommand(
      payload,
      `cat ${shellQuote(file)} 2>/dev/null || true`,
      { timeoutMs: 5_000 },
    )
    if (readResult.code === 0 && readResult.stdout.trim()) {
      result.set(file, readResult.stdout)
    }
  }
  return result
}

export async function scanRemoteManagedProjects(
  payload: VpsConnectionInput,
): Promise<RemoteManagedProjectScanResult> {
  const scannedAt = new Date().toISOString()
  const files = await readNginxFiles(payload)
  const allProjects: RemoteManagedProject[] = []
  for (const [path, content] of files.entries()) {
    for (const project of parseNginxProxyServers(path, content)) {
      allProjects.push({ ...project, connectionId: payload.id ?? "" })
    }
  }
  const enriched: RemoteManagedProject[] = []
  for (const project of allProjects) {
    const inferred = await inferPathFromProcessManager(payload, project)
    const choice = chooseProjectPath({
      systemdPath: inferred.pathSource === "systemd" ? inferred.projectPath : undefined,
      pm2Path: inferred.pathSource === "pm2" ? inferred.projectPath : undefined,
      dockerPath: inferred.pathSource === "docker" ? inferred.projectPath : undefined,
      heuristicPath: inferred.pathSource === "heuristic" ? inferred.projectPath : undefined,
    })
    enriched.push({
      ...applyPathChoice(project, choice),
      serviceName: inferred.serviceName,
      runtimeType: inferred.runtimeType,
    })
  }
  return {
    connectionId: payload.id ?? "",
    projects: enriched,
    scannedAt,
  }
}

// Exported for unit tests that want to assert scan shape without going through scanDirectory.
export const __testing = {
  extractListenPort,
  applyPathChoice,
  scanDirectory,
}