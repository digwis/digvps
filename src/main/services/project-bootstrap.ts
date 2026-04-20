import { randomBytes } from "node:crypto"
import type { ProjectDeployResult, ProjectPanelDeployConfig } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function heredocToFile(
  label: string,
  body: string,
  targetPath: string,
  options?: { shellExpression?: boolean },
) {
  const resolvedTarget = options?.shellExpression ? targetPath : shellSingleQuote(targetPath)
  return `cat >${resolvedTarget} <<'${label}'\n${body}\n${label}\n`
}

function tailText(text: string, max = 1800) {
  const trimmed = text.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  return `…${trimmed.slice(-max)}`
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

function randomSecret(size = 24) {
  return randomBytes(size).toString("base64url")
}

function materializeEnvTemplate(template?: string) {
  if (!template) {
    return undefined
  }

  const replacements = new Map<string, string>()
  const getReplacement = (key: string, factory: () => string) => {
    const existing = replacements.get(key)
    if (existing) {
      return existing
    }
    const value = factory()
    replacements.set(key, value)
    return value
  }

  return template
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("SESSION_SECRET=") && line.includes("CHANGE_ME")) {
        return `SESSION_SECRET=${getReplacement("SESSION_SECRET", () => randomSecret(32))}`
      }
      if (line.startsWith("DATABASE_URL=") && line.includes("CHANGE_ME")) {
        try {
          const raw = line.slice("DATABASE_URL=".length)
          const parsed = new URL(raw)
          if (parsed.password.includes("CHANGE_ME")) {
            parsed.password = getReplacement("DATABASE_PASSWORD", () => randomSecret(18))
            return `DATABASE_URL=${parsed.toString()}`
          }
        } catch {
          return line
        }
      }
      return line
    })
    .join("\n")
}

function buildBootstrapScript(config: ProjectPanelDeployConfig) {
  const remoteAppDir = config.deploy?.remoteAppDir?.trim()
  const remoteService = config.deploy?.remoteService?.trim()
  const envTemplate = materializeEnvTemplate(config.init?.envTemplate?.trim())
  const systemdUnit = config.init?.systemdUnit?.trim()
  const envValues = extractEnvFromTemplate(envTemplate)
  const remotePackages = Array.from(
    new Set(
      (config.init?.remotePackages ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )

  if (!remoteAppDir) {
    throw new Error("部署配置缺少 deploy.remoteAppDir，无法初始化远端。")
  }

  let postgresBlock = `echo "[2/5] No PostgreSQL bootstrap requested; skipping..."`
  const databaseUrl = envValues.DATABASE_URL?.trim()
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl)
      const databaseName = parsed.pathname.replace(/^\//, "").trim()
      const databaseUser = decodeURIComponent(parsed.username || "").trim()
      const databasePassword = decodeURIComponent(parsed.password || "").trim()
      const databaseHost = parsed.hostname.trim()
      if (databaseName && databaseUser && databasePassword && ["127.0.0.1", "localhost"].includes(databaseHost)) {
        postgresBlock = `
echo "[2/5] Provisioning PostgreSQL..."
if command -v systemctl >/dev/null 2>&1; then
  as_root systemctl enable --now postgresql || true
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found after package installation" >&2
  exit 3
fi
run_as_postgres "psql -tAc ${shellSingleQuote(
          `SELECT 1 FROM pg_roles WHERE rolname='${databaseUser.replace(/'/g, "''")}'`,
        )} | grep -q 1 || psql -c ${shellSingleQuote(
          `CREATE ROLE "${databaseUser.replace(/"/g, "\"\"")}" LOGIN;`,
        )}"
run_as_postgres "psql -c ${shellSingleQuote(
          `ALTER ROLE "${databaseUser.replace(/"/g, "\"\"")}" WITH LOGIN PASSWORD '${databasePassword.replace(/'/g, "''")}';`,
        )}"
run_as_postgres "psql -tAc ${shellSingleQuote(
          `SELECT 1 FROM pg_database WHERE datname='${databaseName.replace(/'/g, "''")}'`,
        )} | grep -q 1 || psql -c ${shellSingleQuote(
          `CREATE DATABASE "${databaseName.replace(/"/g, "\"\"")}" OWNER "${databaseUser.replace(/"/g, "\"\"")}";`,
        )}"
`
      }
    } catch {
      postgresBlock = `echo "[2/5] DATABASE_URL could not be parsed; skipping PostgreSQL bootstrap..."`
    }
  }

  const packageInstallBlock =
    remotePackages.length > 0
      ? `
echo "[1/4] Installing remote packages..."
PM=unknown
if command -v apt-get >/dev/null 2>&1; then PM=apt-get
elif command -v apt >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v pacman >/dev/null 2>&1; then PM=pacman
fi
if [ "$PM" = unknown ]; then
  echo "Unsupported package manager" >&2
  exit 2
fi
case "$PM" in
  apt-get|apt)
    as_root apt-get update -qq
    as_root apt-get install -y ${remotePackages.map(shellSingleQuote).join(" ")}
    ;;
  dnf)
    as_root dnf install -y ${remotePackages.map(shellSingleQuote).join(" ")}
    ;;
  yum)
    as_root yum install -y ${remotePackages.map(shellSingleQuote).join(" ")}
    ;;
  apk)
    as_root apk add --no-cache ${remotePackages.map(shellSingleQuote).join(" ")}
    ;;
  pacman)
    as_root pacman -Sy --noconfirm ${remotePackages.map(shellSingleQuote).join(" ")}
    ;;
esac
`
      : `echo "[1/4] No remote packages requested; skipping..."`

  const envBlock = envTemplate
    ? `
echo "[4/5] Ensuring .env exists..."
if [ ! -f "$REMOTE_APP_DIR/.env" ]; then
  ${heredocToFile("DIGWIS_PANEL_ENV", envTemplate, '"$REMOTE_APP_DIR/.env"', { shellExpression: true })}
  echo "Created $REMOTE_APP_DIR/.env from template."
else
  echo "$REMOTE_APP_DIR/.env already exists; keeping current file."
fi
`
    : `echo "[4/5] No env template configured; skipping .env bootstrap..."`

  const serviceBlock =
    remoteService && systemdUnit
      ? `
echo "[5/5] Writing systemd service..."
${heredocToFile("DIGWIS_PANEL_SERVICE", systemdUnit, `/tmp/${remoteService}`)}
as_root install -m 0644 "/tmp/${remoteService}" "/etc/systemd/system/${remoteService}"
rm -f "/tmp/${remoteService}"
as_root systemctl daemon-reload
as_root systemctl enable ${shellSingleQuote(remoteService)}
as_root systemctl restart ${shellSingleQuote(remoteService)} || true
as_root systemctl is-active ${shellSingleQuote(remoteService)} || true
`
      : `echo "[5/5] No systemd unit configured; skipping service bootstrap..."`

  return `
set -Eeuo pipefail

REMOTE_APP_DIR=${shellSingleQuote(remoteAppDir)}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

${packageInstallBlock}

run_as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    su - postgres -c "$1"
  else
    sudo -n -u postgres bash -lc "$1"
  fi
}

${postgresBlock}

echo "[3/5] Ensuring remote directories..."
as_root mkdir -p "$REMOTE_APP_DIR"
as_root chown -R $(id -un):$(id -gn) "$REMOTE_APP_DIR"

${envBlock}

${serviceBlock}

printf '%s\\n' DIGWIS_PROJECT_BOOTSTRAP_OK
`
}

export async function initializeProjectOnVps(options: {
  connection: VpsConnectionInput
  config: ProjectPanelDeployConfig
}): Promise<ProjectDeployResult> {
  const start = Date.now()

  try {
    const script = buildBootstrapScript(options.config)
    const result = await runRemoteShellCommand(options.connection, script, { timeoutMs: 900_000 })
    const combined = `${result.stdout}\n${result.stderr}`
    const ok = result.code === 0 && combined.includes("DIGWIS_PROJECT_BOOTSTRAP_OK")
    const detail = tailText(combined)
    return {
      ok,
      durationMs: Date.now() - start,
      kind: options.config.deploy?.strategy ?? "local-npm-script",
      message: ok
        ? detail
          ? `远端初始化已完成。\n${detail}`
          : "远端初始化已完成。"
        : detail || `远端初始化失败（退出码 ${result.code}）`,
      remotePath: options.config.deploy?.remoteAppDir?.trim() || undefined,
    }
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      kind: options.config.deploy?.strategy ?? "local-npm-script",
      message: error instanceof Error ? error.message : "远端初始化失败",
      remotePath: options.config.deploy?.remoteAppDir?.trim() || undefined,
    }
  }
}
