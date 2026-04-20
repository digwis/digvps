import type { ProjectPanelDeployConfig, ProjectRemoteState } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function extractEnvFromTemplate(template?: string) {
  const values: Record<string, string> = {}
  for (const line of (template ?? "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const idx = trimmed.indexOf("=")
    if (idx <= 0) {
      continue
    }
    values[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  return values
}

function buildInspectScript(config: ProjectPanelDeployConfig) {
  const remoteAppDir = config.deploy?.remoteAppDir?.trim()
  if (!remoteAppDir) {
    throw new Error("项目未配置 deploy.remoteAppDir")
  }

  const systemdUnit = config.init?.systemdUnit?.trim()
  const remoteService = config.deploy?.remoteService?.trim()
  const envValues = extractEnvFromTemplate(config.init?.envTemplate?.trim())
  const databaseUrl = envValues.DATABASE_URL?.trim()

  let databaseRoleBlock = `echo "DB_ROLE=1"\necho "DB_NAME=1"\n`
  let databaseServerBlock = `echo "DB_SERVER=1"\n`

  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl)
      const databaseName = parsed.pathname.replace(/^\//, "").trim()
      const databaseUser = decodeURIComponent(parsed.username || "").trim()
      const databaseHost = parsed.hostname.trim()

      if (databaseName && databaseUser && ["127.0.0.1", "localhost"].includes(databaseHost)) {
        databaseServerBlock = `
if command -v psql >/dev/null 2>&1; then
  echo "DB_SERVER=1"
else
  echo "DB_SERVER=0"
fi
`
        databaseRoleBlock = `
if command -v psql >/dev/null 2>&1; then
  run_as_postgres "psql -tAc ${shellSingleQuote(
    `SELECT 1 FROM pg_roles WHERE rolname='${databaseUser.replace(/'/g, "''")}'`,
  )} | grep -q 1" && echo "DB_ROLE=1" || echo "DB_ROLE=0"
  run_as_postgres "psql -tAc ${shellSingleQuote(
    `SELECT 1 FROM pg_database WHERE datname='${databaseName.replace(/'/g, "''")}'`,
  )} | grep -q 1" && echo "DB_NAME=1" || echo "DB_NAME=0"
else
  echo "DB_ROLE=0"
  echo "DB_NAME=0"
fi
`
      }
    } catch {
      databaseServerBlock = `echo "DB_SERVER=1"\n`
      databaseRoleBlock = `echo "DB_ROLE=1"\necho "DB_NAME=1"\n`
    }
  }

  const envFileCheck = config.init?.envTemplate?.trim()
    ? `[ -f "$REMOTE_APP_DIR/.env" ] && echo "ENV_FILE=1" || echo "ENV_FILE=0"`
    : `echo "ENV_FILE=1"`

  const serviceUnitCheck =
    remoteService && systemdUnit
      ? `
if as_root test -f ${shellSingleQuote(`/etc/systemd/system/${remoteService}`)}; then
  echo "SERVICE_UNIT=1"
else
  echo "SERVICE_UNIT=0"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ${shellSingleQuote(remoteService)}; then
  echo "SERVICE_ACTIVE=1"
else
  echo "SERVICE_ACTIVE=0"
fi
`
      : `echo "SERVICE_UNIT=1"\necho "SERVICE_ACTIVE=1"\n`

  return `
set -e

REMOTE_APP_DIR=${shellSingleQuote(remoteAppDir)}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

run_as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    su - postgres -c "$1"
  else
    sudo -n -u postgres bash -lc "$1"
  fi
}

[ -d "$REMOTE_APP_DIR" ] && echo "APP_DIR=1" || echo "APP_DIR=0"
${envFileCheck}
${serviceUnitCheck}
${databaseServerBlock}
${databaseRoleBlock}
`
}

function parseMarker(output: string, key: string) {
  const match = output.match(new RegExp(`^${key}=(\\d+)`, "m"))
  return match?.[1] === "1"
}

export async function inspectProjectRemoteState(options: {
  connection: VpsConnectionInput
  config: ProjectPanelDeployConfig
}): Promise<ProjectRemoteState> {
  if (!options.config.init) {
    return {
      canInitialize: false,
      ready: true,
      missingItems: [],
      runtimeIssues: [],
      checkedAt: new Date().toISOString(),
    }
  }

  const result = await runRemoteShellCommand(options.connection, buildInspectScript(options.config), {
    timeoutMs: 120_000,
  })

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "远端状态检查失败")
  }

  const combined = `${result.stdout}\n${result.stderr}`
  const missingItems: string[] = []
  const runtimeIssues: string[] = []

  if (!parseMarker(combined, "APP_DIR")) {
    missingItems.push("远端目录")
  }
  if (!parseMarker(combined, "ENV_FILE")) {
    missingItems.push(".env 配置")
  }
  if (!parseMarker(combined, "SERVICE_UNIT")) {
    missingItems.push("systemd 服务")
  } else if (!parseMarker(combined, "SERVICE_ACTIVE")) {
    runtimeIssues.push("服务未启动")
  }
  if (!parseMarker(combined, "DB_SERVER")) {
    missingItems.push("PostgreSQL")
  }
  if (!parseMarker(combined, "DB_ROLE")) {
    missingItems.push("数据库用户")
  }
  if (!parseMarker(combined, "DB_NAME")) {
    missingItems.push("数据库")
  }

  return {
    canInitialize: true,
    ready: missingItems.length === 0,
    missingItems,
    runtimeIssues,
    checkedAt: new Date().toISOString(),
  }
}
