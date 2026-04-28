import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ProjectMigrationResult, ProjectPanelDeployConfig } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { connectSftpClient } from "./ssh-runtime"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function tailText(text: string, max = 1800) {
  const trimmed = text.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  return `…${trimmed.slice(-max)}`
}

function managedNginxConfigPath(projectId: string) {
  return `/etc/nginx/conf.d/digwis-panel-${projectId}.conf`
}

function parseMarker(output: string, key: string) {
  const match = output.match(new RegExp(`^${key}=(.*)$`, "m"))
  return match?.[1]?.trim() ?? ""
}

function buildPrepareSourceBundleScript(options: {
  projectId: string
  remoteAppDir: string
  remoteService?: string
}) {
  const remoteAppDir = options.remoteAppDir.replace(/\/$/, "")
  const fallbackConfigPath = managedNginxConfigPath(path.posix.basename(remoteAppDir))

  return `
set -Eeuo pipefail

PROJECT_ID=${shellSingleQuote(options.projectId)}
REMOTE_APP_DIR=${shellSingleQuote(remoteAppDir)}
REMOTE_SERVICE=${shellSingleQuote(options.remoteService?.trim() || "")}
PRIMARY_NGINX_CONF=${shellSingleQuote(managedNginxConfigPath(options.projectId))}
FALLBACK_NGINX_CONF=${shellSingleQuote(fallbackConfigPath)}
PRIMARY_CERT_DIR=${shellSingleQuote(`/etc/ssl/digwis-panel/${options.projectId}`)}
FALLBACK_CERT_DIR=${shellSingleQuote(`/etc/ssl/digwis-panel/${path.posix.basename(remoteAppDir)}`)}
TMP_ROOT="$(mktemp -d /tmp/digwis-panel-migrate-XXXXXX)"
APP_ARCHIVE="$TMP_ROOT/app.tar.gz"
SYSTEM_ARCHIVE="$TMP_ROOT/system.tar.gz"

[ -d "$REMOTE_APP_DIR" ] || { echo "源服务器项目目录不存在：$REMOTE_APP_DIR" >&2; exit 2; }
sudo -n tar -C / -czf "$APP_ARCHIVE" "${remoteAppDir.replace(/^\//, "")}"

ACTIVE_NGINX_CONF=""
if sudo -n test -f "$PRIMARY_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$PRIMARY_NGINX_CONF"
elif [ "$FALLBACK_NGINX_CONF" != "$PRIMARY_NGINX_CONF" ] && sudo -n test -f "$FALLBACK_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$FALLBACK_NGINX_CONF"
fi

SITE_DOMAIN=""
SITE_SSL_MODE=""
SYSTEM_ITEMS=""

if [ -n "$REMOTE_SERVICE" ] && sudo -n test -f "/etc/systemd/system/$REMOTE_SERVICE"; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS etc/systemd/system/$REMOTE_SERVICE"
  echo "HAS_SERVICE=1"
else
  echo "HAS_SERVICE=0"
fi

if [ -n "$ACTIVE_NGINX_CONF" ]; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${"$"}{ACTIVE_NGINX_CONF#/}"
  SITE_DOMAIN="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_DOMAIN=' '$ACTIVE_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
  SITE_SSL_MODE="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_SSL_MODE=' '$ACTIVE_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
fi

if sudo -n test -d "$PRIMARY_CERT_DIR"; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${"$"}{PRIMARY_CERT_DIR#/}"
  echo "HAS_CUSTOM_CERT_DIR=1"
elif sudo -n test -d "$FALLBACK_CERT_DIR"; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${"$"}{FALLBACK_CERT_DIR#/}"
  echo "HAS_CUSTOM_CERT_DIR=1"
else
  echo "HAS_CUSTOM_CERT_DIR=0"
fi

if [ -n "$SITE_DOMAIN" ] && [ "$SITE_SSL_MODE" = "letsencrypt" ]; then
  for item in \
    "etc/letsencrypt/live/$SITE_DOMAIN" \
    "etc/letsencrypt/archive/$SITE_DOMAIN" \
    "etc/letsencrypt/renewal/$SITE_DOMAIN.conf"
  do
    if sudo -n test -e "/$item"; then
      SYSTEM_ITEMS="$SYSTEM_ITEMS $item"
    fi
  done
fi

if [ -n "$SYSTEM_ITEMS" ]; then
  sudo -n tar -C / -czf "$SYSTEM_ARCHIVE" $SYSTEM_ITEMS
  echo "HAS_SYSTEM_ARCHIVE=1"
else
  : > "$SYSTEM_ARCHIVE"
  echo "HAS_SYSTEM_ARCHIVE=0"
fi

echo "BUNDLE_DIR=$TMP_ROOT"
echo "APP_ARCHIVE=$APP_ARCHIVE"
echo "SYSTEM_ARCHIVE=$SYSTEM_ARCHIVE"
echo "SITE_DOMAIN=$SITE_DOMAIN"
echo "SITE_SSL_MODE=$SITE_SSL_MODE"
echo "DIGWIS_PREPARE_BUNDLE_OK=1"
`
}

function buildEnsurePackagesScript(packages: string[]) {
  const list = Array.from(new Set(packages.map((item) => item.trim()).filter(Boolean)))
  if (list.length === 0) {
    return `echo "DIGWIS_DEPS_OK=1"`
  }
  const joined = list.map(shellSingleQuote).join(" ")
  return `
set -Eeuo pipefail
sudo -n true
PM=unknown
if command -v apt-get >/dev/null 2>&1; then PM=apt-get
elif command -v apt >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v pacman >/dev/null 2>&1; then PM=pacman
fi
echo "PACKAGE_MANAGER=$PM"
case "$PM" in
  apt-get|apt)
    sudo -n apt-get update -qq
    sudo -n apt-get install -y ${joined}
    ;;
  dnf)
    sudo -n dnf install -y ${joined}
    ;;
  yum)
    sudo -n yum install -y ${joined}
    ;;
  apk)
    sudo -n apk add --no-cache ${joined}
    ;;
  pacman)
    sudo -n pacman -Sy --noconfirm ${joined}
    ;;
  *)
    echo "无法识别目标服务器包管理器" >&2
    exit 3
    ;;
esac
echo "DIGWIS_DEPS_OK=1"
`
}

function buildApplyBundleScript(options: {
  projectId: string
  remoteAppDir: string
  remoteService?: string
  targetTmpDir: string
}) {
  return `
set -Eeuo pipefail

PROJECT_ID=${shellSingleQuote(options.projectId)}
REMOTE_APP_DIR=${shellSingleQuote(options.remoteAppDir.replace(/\/$/, ""))}
REMOTE_SERVICE=${shellSingleQuote(options.remoteService?.trim() || "")}
TARGET_TMP_DIR=${shellSingleQuote(options.targetTmpDir)}
APP_ARCHIVE="$TARGET_TMP_DIR/app.tar.gz"
SYSTEM_ARCHIVE="$TARGET_TMP_DIR/system.tar.gz"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -f "$APP_ARCHIVE" ] || { echo "迁移包缺少 app.tar.gz" >&2; exit 2; }
sudo -n mkdir -p "$(dirname "$REMOTE_APP_DIR")"
if [ -d "$REMOTE_APP_DIR" ]; then
  sudo -n mv "$REMOTE_APP_DIR" "$REMOTE_APP_DIR.pre-migration-$STAMP"
fi
sudo -n tar --no-same-owner -C / -xzf "$APP_ARCHIVE"
sudo -n chown -R "$(id -un):$(id -gn)" "$REMOTE_APP_DIR" >/dev/null 2>&1 || true

if [ -s "$SYSTEM_ARCHIVE" ]; then
  sudo -n tar --no-same-owner -C / -xzf "$SYSTEM_ARCHIVE"
fi

if [ -n "$REMOTE_SERVICE" ] && sudo -n test -f "/etc/systemd/system/$REMOTE_SERVICE"; then
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable "$REMOTE_SERVICE" >/dev/null 2>&1 || true
  sudo -n systemctl restart "$REMOTE_SERVICE"
fi

if command -v nginx >/dev/null 2>&1; then
  sudo -n nginx -t >/dev/null 2>&1 && sudo -n systemctl reload nginx >/dev/null 2>&1 || true
fi

echo "DIGWIS_APPLY_BUNDLE_OK=1"
`
}

function buildDisableSourceScript(options: {
  projectId: string
  remoteAppDir: string
  remoteService?: string
}) {
  const remoteAppDir = options.remoteAppDir.replace(/\/$/, "")
  const fallbackConfigPath = managedNginxConfigPath(path.posix.basename(remoteAppDir))

  return `
set -Eeuo pipefail

REMOTE_SERVICE=${shellSingleQuote(options.remoteService?.trim() || "")}
PRIMARY_NGINX_CONF=${shellSingleQuote(managedNginxConfigPath(options.projectId))}
FALLBACK_NGINX_CONF=${shellSingleQuote(fallbackConfigPath)}
REMOTE_APP_DIR=${shellSingleQuote(remoteAppDir)}
STAMP="$(date +%Y%m%d-%H%M%S)"

ACTIVE_NGINX_CONF=""
if sudo -n test -f "$PRIMARY_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$PRIMARY_NGINX_CONF"
elif [ "$FALLBACK_NGINX_CONF" != "$PRIMARY_NGINX_CONF" ] && sudo -n test -f "$FALLBACK_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$FALLBACK_NGINX_CONF"
fi

if [ -n "$REMOTE_SERVICE" ]; then
  sudo -n systemctl disable --now "$REMOTE_SERVICE" >/dev/null 2>&1 || sudo -n systemctl stop "$REMOTE_SERVICE" >/dev/null 2>&1 || true
fi

if [ -n "$ACTIVE_NGINX_CONF" ]; then
  sudo -n mv "$ACTIVE_NGINX_CONF" "$ACTIVE_NGINX_CONF.migrated-$STAMP"
  if command -v nginx >/dev/null 2>&1; then
    sudo -n nginx -t >/dev/null 2>&1 && sudo -n systemctl reload nginx >/dev/null 2>&1 || true
  fi
fi

printf 'migrated-to-new-server at %s\n' "$(date -Is)" | sudo -n tee "$REMOTE_APP_DIR/.digwis-panel-migrated" >/dev/null
echo "DIGWIS_SOURCE_DISABLED=1"
`
}

async function removeRemotePath(connection: VpsConnectionInput, remotePath: string) {
  await runRemoteShellCommand(connection, `rm -rf ${shellSingleQuote(remotePath)}`, {
    timeoutMs: 120_000,
  }).catch(() => undefined)
}

export async function migrateProjectBetweenServers(options: {
  projectId: string
  config: ProjectPanelDeployConfig | null
  sourceConnection: VpsConnectionInput
  targetConnection: VpsConnectionInput
  remoteAppDir: string
}): Promise<ProjectMigrationResult> {
  const startedAt = Date.now()
  const remoteService = options.config?.deploy?.remoteService?.trim() || undefined
  const backupPackages = options.config?.init?.remotePackages ?? []
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "digwis-panel-migrate-"))
  const localAppArchive = path.join(tempRoot, "app.tar.gz")
  const localSystemArchive = path.join(tempRoot, "system.tar.gz")
  let sourceBundleDir = ""
  const targetTmpDir = `/tmp/digwis-panel-migrate-${options.projectId}-${Date.now()}`

  try {
    const prepared = await runRemoteShellCommand(
      options.sourceConnection,
      buildPrepareSourceBundleScript({
        projectId: options.projectId,
        remoteAppDir: options.remoteAppDir,
        remoteService,
      }),
      { timeoutMs: 30 * 60 * 1000 },
    )
    const preparedOutput = `${prepared.stdout}\n${prepared.stderr}`
    if (prepared.code !== 0 || !preparedOutput.includes("DIGWIS_PREPARE_BUNDLE_OK=1")) {
      throw new Error(tailText(preparedOutput) || "源服务器迁移打包失败")
    }

    sourceBundleDir = parseMarker(preparedOutput, "BUNDLE_DIR")
    const sourceAppArchive = parseMarker(preparedOutput, "APP_ARCHIVE")
    const sourceSystemArchive = parseMarker(preparedOutput, "SYSTEM_ARCHIVE")
    const siteDomain = parseMarker(preparedOutput, "SITE_DOMAIN")
    const siteSslMode = parseMarker(preparedOutput, "SITE_SSL_MODE")

    const requiredPackages = [...backupPackages]
    if (siteDomain) {
      requiredPackages.push("nginx")
      if (siteSslMode === "letsencrypt") {
        requiredPackages.push("certbot")
      }
    }

    const ensureDeps = await runRemoteShellCommand(
      options.targetConnection,
      buildEnsurePackagesScript(requiredPackages),
      { timeoutMs: 30 * 60 * 1000 },
    )
    const ensureOutput = `${ensureDeps.stdout}\n${ensureDeps.stderr}`
    if (ensureDeps.code !== 0 || !ensureOutput.includes("DIGWIS_DEPS_OK=1")) {
      throw new Error(tailText(ensureOutput) || "目标服务器依赖检查失败")
    }

    const sourceSftp = await connectSftpClient(options.sourceConnection, { readyTimeout: 20_000 })
    try {
      await sourceSftp.fastGet(sourceAppArchive, localAppArchive)
      if (sourceSystemArchive) {
        await sourceSftp.fastGet(sourceSystemArchive, localSystemArchive)
      }
    } finally {
      await sourceSftp.end().catch(() => undefined)
    }

    const targetSftp = await connectSftpClient(options.targetConnection, { readyTimeout: 20_000 })
    try {
      await targetSftp.mkdir(targetTmpDir, true).catch(() => undefined)
      await targetSftp.fastPut(localAppArchive, `${targetTmpDir}/app.tar.gz`)
      const hasSystemArchive = await fs
        .stat(localSystemArchive)
        .then((stat) => stat.size > 0)
        .catch(() => false)
      if (hasSystemArchive) {
        await targetSftp.fastPut(localSystemArchive, `${targetTmpDir}/system.tar.gz`)
      } else {
        await targetSftp.put(Buffer.from(""), `${targetTmpDir}/system.tar.gz`)
      }
    } finally {
      await targetSftp.end().catch(() => undefined)
    }

    const applied = await runRemoteShellCommand(
      options.targetConnection,
      buildApplyBundleScript({
        projectId: options.projectId,
        remoteAppDir: options.remoteAppDir,
        remoteService,
        targetTmpDir,
      }),
      { timeoutMs: 30 * 60 * 1000 },
    )
    const appliedOutput = `${applied.stdout}\n${applied.stderr}`
    if (applied.code !== 0 || !appliedOutput.includes("DIGWIS_APPLY_BUNDLE_OK=1")) {
      throw new Error(tailText(appliedOutput) || "目标服务器迁移落地失败")
    }

    const disabled = await runRemoteShellCommand(
      options.sourceConnection,
      buildDisableSourceScript({
        projectId: options.projectId,
        remoteAppDir: options.remoteAppDir,
        remoteService,
      }),
      { timeoutMs: 10 * 60 * 1000 },
    )
    const disabledOutput = `${disabled.stdout}\n${disabled.stderr}`
    const sourceDisabled = disabled.code === 0 && disabledOutput.includes("DIGWIS_SOURCE_DISABLED=1")

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      targetConnectionId: options.targetConnection.id,
      targetRemotePath: options.remoteAppDir,
      sourceDisabled,
      message: `项目已迁移到 ${options.targetConnection.name}，目标目录 ${options.remoteAppDir}。${sourceDisabled ? "源服务器服务与入口已停用。" : "目标已完成，但源服务器停用步骤需要手动确认。"}`
    }
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      targetConnectionId: options.targetConnection.id,
      targetRemotePath: options.remoteAppDir,
      sourceDisabled: false,
      message: error instanceof Error ? error.message : "项目迁移失败",
    }
  } finally {
    if (sourceBundleDir) {
      await removeRemotePath(options.sourceConnection, sourceBundleDir)
    }
    await removeRemotePath(options.targetConnection, targetTmpDir)
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
