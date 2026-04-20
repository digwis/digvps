import path from "node:path"
import type {
  ProjectRemoteDetails,
  ProjectRemoteFileEntry,
  ProjectSiteSettingsResult,
} from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function heredocToFile(label: string, body: string, targetPath: string, options?: { shellExpression?: boolean }) {
  const resolvedTarget = options?.shellExpression ? targetPath : shellSingleQuote(targetPath)
  return `cat >${resolvedTarget} <<'${label}'\n${body}\n${label}\n`
}

function normalizeRemoteChildPath(root: string, candidate?: string) {
  const normalizedRoot = path.posix.normalize(root.replace(/\\/g, "/"))
  const normalizedCandidate = path.posix.normalize((candidate || normalizedRoot).replace(/\\/g, "/"))
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error("只能浏览部署目录及其子目录")
  }
  return normalizedCandidate
}

function managedNginxConfigPath(projectId: string) {
  return `/etc/nginx/conf.d/digwis-panel-${projectId}.conf`
}

function parseMarker(output: string, key: string) {
  const match = output.match(new RegExp(`^${key}=(.*)$`, "m"))
  return match?.[1]?.trim() ?? ""
}

function parseBooleanMarker(output: string, key: string) {
  return parseMarker(output, key) === "1"
}

function parseIntegerMarker(output: string, key: string) {
  const raw = parseMarker(output, key)
  if (!raw) {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parseFiles(output: string): ProjectRemoteFileEntry[] {
  const entries: ProjectRemoteFileEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("FILE\t")) {
      continue
    }
    const [, type, sizeRaw, modifiedAt, name, fullPath] = line.split("\t")
    if (!name || !fullPath) {
      continue
    }
    const size = Number(sizeRaw)
    entries.push({
      name,
      path: fullPath,
      type: type === "directory" || type === "symlink" ? type : "file",
      size: Number.isFinite(size) ? size : 0,
      modifiedAt: modifiedAt || undefined,
    })
  }
  return entries.sort((left, right) => {
    if (left.type === right.type) {
      return left.name.localeCompare(right.name)
    }
    if (left.type === "directory") {
      return -1
    }
    if (right.type === "directory") {
      return 1
    }
    return left.name.localeCompare(right.name)
  })
}

function buildRemoteDetailsScript(options: {
  projectId: string
  remoteAppDir: string
  browsePath: string
  remoteService?: string
}) {
  const configPath = managedNginxConfigPath(options.projectId)
  const fallbackConfigPath = managedNginxConfigPath(path.posix.basename(options.remoteAppDir))
  const remoteService = options.remoteService?.trim()

  const serviceBlock = remoteService
    ? `
echo "SERVICE_CONFIGURED=1"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet ${shellSingleQuote(remoteService)} && echo "SERVICE_ACTIVE=1" || echo "SERVICE_ACTIVE=0"
  systemctl is-enabled --quiet ${shellSingleQuote(remoteService)} && echo "SERVICE_ENABLED=1" || echo "SERVICE_ENABLED=0"
  echo "SERVICE_STATUS=$(systemctl status ${shellSingleQuote(remoteService)} --no-pager 2>/dev/null | sed -n '1,3p' | tr '\\n' ' ' | sed 's/[[:space:]]\\+/ /g')"
else
  echo "SERVICE_ACTIVE=0"
  echo "SERVICE_ENABLED=0"
  echo "SERVICE_STATUS=systemctl unavailable"
fi
`
    : `
echo "SERVICE_CONFIGURED=0"
echo "SERVICE_ACTIVE=0"
echo "SERVICE_ENABLED=0"
echo "SERVICE_STATUS=未配置远端服务"
`

  return `
set -e

REMOTE_APP_DIR=${shellSingleQuote(options.remoteAppDir)}
BROWSE_PATH=${shellSingleQuote(options.browsePath)}
MANAGED_NGINX_CONF=${shellSingleQuote(configPath)}
FALLBACK_NGINX_CONF=${shellSingleQuote(fallbackConfigPath)}

read_marker_file_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  sudo -n sh -c "grep '^# $key=' '$file' 2>/dev/null | tail -n1 | cut -d= -f2-"
}

echo "REMOTE_APP_DIR=$REMOTE_APP_DIR"
echo "CURRENT_PATH=$BROWSE_PATH"
[ -d "$REMOTE_APP_DIR" ] && echo "PATH_EXISTS=1" || echo "PATH_EXISTS=0"

APP_PORT=""
if [ -f "$REMOTE_APP_DIR/.env" ]; then
  APP_PORT="$(grep -E '^PORT=' "$REMOTE_APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\\r' | tr -d '\"' | tr -d \"'\")"
fi
[ -n "$APP_PORT" ] || APP_PORT=5000
echo "APP_PORT=$APP_PORT"

${serviceBlock}

if command -v nginx >/dev/null 2>&1; then
  echo "NGINX_INSTALLED=1"
else
  echo "NGINX_INSTALLED=0"
fi

if command -v certbot >/dev/null 2>&1; then
  echo "CERTBOT_INSTALLED=1"
else
  echo "CERTBOT_INSTALLED=0"
fi

ACTIVE_NGINX_CONF=""
if sudo -n test -f "$MANAGED_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$MANAGED_NGINX_CONF"
elif [ "$FALLBACK_NGINX_CONF" != "$MANAGED_NGINX_CONF" ] && sudo -n test -f "$FALLBACK_NGINX_CONF"; then
  ACTIVE_NGINX_CONF="$FALLBACK_NGINX_CONF"
fi

if [ -n "$ACTIVE_NGINX_CONF" ]; then
  echo "SITE_CONFIG_PATH=$ACTIVE_NGINX_CONF"
  SITE_DOMAIN="$(read_marker_file_value "$ACTIVE_NGINX_CONF" DIGWIS_PANEL_DOMAIN)"
  PREVIEW_PORT="$(read_marker_file_value "$ACTIVE_NGINX_CONF" DIGWIS_PANEL_PREVIEW_PORT)"
  SSL_MODE="$(read_marker_file_value "$ACTIVE_NGINX_CONF" DIGWIS_PANEL_SSL_MODE)"
else
  echo "SITE_CONFIG_PATH="
  SITE_DOMAIN=""
  PREVIEW_PORT=""
  SSL_MODE=""
fi

echo "SITE_DOMAIN=$SITE_DOMAIN"
echo "SITE_PREVIEW_PORT=$PREVIEW_PORT"
echo "SITE_SSL_MODE=$SSL_MODE"

CUSTOM_CERT_PATH=""
CUSTOM_KEY_PATH=""
if sudo -n test -f "/etc/ssl/digwis-panel/${options.projectId}/origin.crt"; then
  CUSTOM_CERT_PATH="/etc/ssl/digwis-panel/${options.projectId}/origin.crt"
  CUSTOM_KEY_PATH="/etc/ssl/digwis-panel/${options.projectId}/origin.key"
elif sudo -n test -f "/etc/ssl/digwis-panel/${path.posix.basename(options.remoteAppDir)}/origin.crt"; then
  CUSTOM_CERT_PATH="/etc/ssl/digwis-panel/${path.posix.basename(options.remoteAppDir)}/origin.crt"
  CUSTOM_KEY_PATH="/etc/ssl/digwis-panel/${path.posix.basename(options.remoteAppDir)}/origin.key"
fi

if [ "$SSL_MODE" = "custom" ] && [ -n "$CUSTOM_CERT_PATH" ] && sudo -n test -f "$CUSTOM_CERT_PATH" && sudo -n test -f "$CUSTOM_KEY_PATH"; then
  echo "SITE_CUSTOM_CERT=1"
  echo "SITE_SSL_ENABLED=1"
  echo "SITE_CERT_PEM_B64=$(sudo -n cat "$CUSTOM_CERT_PATH" | base64 | tr -d '\n')"
elif [ -n "$SITE_DOMAIN" ] && sudo -n test -f "/etc/letsencrypt/live/$SITE_DOMAIN/fullchain.pem"; then
  echo "SITE_CUSTOM_CERT=0"
  echo "SITE_SSL_ENABLED=1"
  echo "SITE_CERT_PEM_B64="
else
  echo "SITE_CUSTOM_CERT=0"
  echo "SITE_SSL_ENABLED=0"
  echo "SITE_CERT_PEM_B64="
fi

if [ -d "$BROWSE_PATH" ]; then
  find "$BROWSE_PATH" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%TY-%Tm-%Td %TH:%TM\\t%f\\t%p\\n' \
    | while IFS=$'\\t' read -r kind size modified name fullPath; do
        if [ "$kind" = "d" ]; then fileType="directory";
        elif [ "$kind" = "l" ]; then fileType="symlink";
        else fileType="file"; fi
        printf 'FILE\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$fileType" "$size" "$modified" "$name" "$fullPath"
      done
fi
`
}

export async function getProjectRemoteDetails(options: {
  projectId: string
  connection: VpsConnectionInput
  remoteAppDir: string
  remoteService?: string
  browsePath?: string
}): Promise<ProjectRemoteDetails> {
  const browsePath = normalizeRemoteChildPath(options.remoteAppDir, options.browsePath)
  const result = await runRemoteShellCommand(
    options.connection,
    buildRemoteDetailsScript({
      projectId: options.projectId,
      remoteAppDir: options.remoteAppDir,
      browsePath,
      remoteService: options.remoteService,
    }),
    { timeoutMs: 120_000 },
  )

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "读取远端项目详情失败")
  }

  const combined = `${result.stdout}\n${result.stderr}`
  const domain = parseMarker(combined, "SITE_DOMAIN") || null
  const previewPort = parseIntegerMarker(combined, "SITE_PREVIEW_PORT")
  const sslEnabled = parseBooleanMarker(combined, "SITE_SSL_ENABLED")
  const sslMode = (parseMarker(combined, "SITE_SSL_MODE") || "none") as "none" | "letsencrypt" | "custom"
  const certificatePemBase64 = parseMarker(combined, "SITE_CERT_PEM_B64")
  const previewUrl = !domain && previewPort ? `http://${options.connection.host}:${previewPort}` : null
  const publicUrl = domain ? `${sslEnabled ? "https" : "http"}://${domain}` : previewUrl

  return {
    remoteAppDir: parseMarker(combined, "REMOTE_APP_DIR") || options.remoteAppDir,
    currentPath: parseMarker(combined, "CURRENT_PATH") || browsePath,
    pathExists: parseBooleanMarker(combined, "PATH_EXISTS"),
    appPort: parseIntegerMarker(combined, "APP_PORT"),
    previewUrl,
    publicUrl,
    files: parseFiles(combined),
    service: {
      configured: parseBooleanMarker(combined, "SERVICE_CONFIGURED"),
      unit: options.remoteService?.trim() || null,
      active: parseBooleanMarker(combined, "SERVICE_ACTIVE"),
      enabled: parseBooleanMarker(combined, "SERVICE_ENABLED"),
      statusText: parseMarker(combined, "SERVICE_STATUS") || "未知",
    },
    site: {
      mode: domain ? "domain" : previewPort ? "port" : "none",
      domain,
      previewPort,
      sslEnabled,
      sslMode,
      customCertificateConfigured: parseBooleanMarker(combined, "SITE_CUSTOM_CERT"),
      certificatePem: certificatePemBase64 ? Buffer.from(certificatePemBase64, "base64").toString("utf8") : null,
      nginxInstalled: parseBooleanMarker(combined, "NGINX_INSTALLED"),
      certbotInstalled: parseBooleanMarker(combined, "CERTBOT_INSTALLED"),
      configPath: parseMarker(combined, "SITE_CONFIG_PATH") || null,
    },
    checkedAt: new Date().toISOString(),
  }
}

function buildApplySiteSettingsScript(options: {
  projectId: string
  remoteAppDir: string
  appPort?: number | null
  domain?: string
  sslEmail?: string
  certificatePem?: string
  privateKeyPem?: string
}) {
  const configPath = managedNginxConfigPath(options.projectId)
  const domain = options.domain?.trim() || ""
  const sslEmail = options.sslEmail?.trim() || ""
  const certificatePem = options.certificatePem?.trim() || ""
  const privateKeyPem = options.privateKeyPem?.trim() || ""
  const appPort = options.appPort && options.appPort > 0 ? options.appPort : 5000
  const certDir = `/etc/ssl/digwis-panel/${options.projectId}`
  const certPath = `${certDir}/origin.crt`
  const keyPath = `${certDir}/origin.key`
  const customSslInstallBlock =
    domain && certificatePem && privateKeyPem
      ? `
HAS_CUSTOM_SSL=1
sudo -n mkdir -p "$CERT_DIR"
tmp_cert="$(mktemp)"
tmp_key="$(mktemp)"
${heredocToFile("DIGWIS_PANEL_CERT", certificatePem, '"$tmp_cert"', { shellExpression: true })}
${heredocToFile("DIGWIS_PANEL_KEY", privateKeyPem, '"$tmp_key"', { shellExpression: true })}
sudo -n install -m 0644 "$tmp_cert" "$CERT_PATH"
sudo -n install -m 0600 "$tmp_key" "$KEY_PATH"
rm -f "$tmp_cert" "$tmp_key"
`
      : `HAS_CUSTOM_SSL=0`

  return `
set -e

PROJECT_ID=${shellSingleQuote(options.projectId)}
REMOTE_APP_DIR=${shellSingleQuote(options.remoteAppDir)}
APP_PORT=${shellSingleQuote(String(appPort))}
DOMAIN=${shellSingleQuote(domain)}
SSL_EMAIL=${shellSingleQuote(sslEmail)}
MANAGED_NGINX_CONF=${shellSingleQuote(configPath)}
CERT_DIR=${shellSingleQuote(certDir)}
CERT_PATH=${shellSingleQuote(certPath)}
KEY_PATH=${shellSingleQuote(keyPath)}

sudo -n true
command -v nginx >/dev/null 2>&1 || { echo "缺少 nginx，请先安装 nginx" >&2; exit 2; }
sudo -n mkdir -p /etc/nginx/conf.d

existing_port=""
if sudo -n test -f "$MANAGED_NGINX_CONF"; then
  existing_port="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_PREVIEW_PORT=' '$MANAGED_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
fi

allocate_port() {
  local used port candidate
  used="$(
    if command -v ss >/dev/null 2>&1; then
      ss -ltnH | awk '{print $4}' | sed 's/.*://'
    elif command -v netstat >/dev/null 2>&1; then
      netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}' | sed 's/.*://'
    fi
  )"
  for _ in $(seq 1 80); do
    candidate=$(( (RANDOM % 20000) + 20000 ))
    if ! printf '%s\n' "$used" | grep -qx "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  echo 28080
}

PREVIEW_PORT="$existing_port"
if [ -z "$DOMAIN" ]; then
  if [ -z "$PREVIEW_PORT" ]; then
    PREVIEW_PORT="$(allocate_port)"
  fi
else
  PREVIEW_PORT=""
fi

${customSslInstallBlock}

tmp_conf="$(mktemp)"
if [ -n "$DOMAIN" ]; then
if [ "$HAS_CUSTOM_SSL" = "1" ]; then
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=$DOMAIN
# DIGWIS_PANEL_PREVIEW_PORT=
# DIGWIS_PANEL_SSL_MODE=custom
server {
  listen 80;
  server_name $DOMAIN;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name $DOMAIN;
  ssl_certificate $CERT_PATH;
  ssl_certificate_key $KEY_PATH;

  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
else
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=$DOMAIN
# DIGWIS_PANEL_PREVIEW_PORT=
# DIGWIS_PANEL_SSL_MODE=none
server {
  listen 80;
  server_name $DOMAIN;

  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
fi
else
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=
# DIGWIS_PANEL_PREVIEW_PORT=$PREVIEW_PORT
# DIGWIS_PANEL_SSL_MODE=none
server {
  listen $PREVIEW_PORT;
  server_name _;

  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
fi

sudo -n install -m 0644 "$tmp_conf" "$MANAGED_NGINX_CONF"
rm -f "$tmp_conf"
sudo -n nginx -t
sudo -n systemctl enable --now nginx >/dev/null 2>&1 || true
sudo -n systemctl reload nginx

SSL_ENABLED=0
if [ "$HAS_CUSTOM_SSL" = "1" ]; then
  SSL_ENABLED=1
elif [ -n "$DOMAIN" ] && [ -n "$SSL_EMAIL" ] && command -v certbot >/dev/null 2>&1; then
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect; then
    SSL_ENABLED=1
  fi
fi

echo "DIGWIS_SITE_OK=1"
echo "DOMAIN=$DOMAIN"
echo "PREVIEW_PORT=$PREVIEW_PORT"
echo "SSL_ENABLED=$SSL_ENABLED"
`
}

export async function applyProjectSiteSettings(options: {
  projectId: string
  connection: VpsConnectionInput
  remoteAppDir: string
  appPort?: number | null
  domain?: string
  sslEmail?: string
  certificatePem?: string
  privateKeyPem?: string
}): Promise<ProjectSiteSettingsResult> {
  const result = await runRemoteShellCommand(
    options.connection,
    buildApplySiteSettingsScript(options),
    { timeoutMs: 240_000 },
  )

  if (result.code !== 0 || !parseBooleanMarker(`${result.stdout}\n${result.stderr}`, "DIGWIS_SITE_OK")) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim() || "应用站点设置失败",
      previewUrl: null,
      publicUrl: null,
    }
  }

  const combined = `${result.stdout}\n${result.stderr}`
  const domain = parseMarker(combined, "DOMAIN")
  const previewPort = parseIntegerMarker(combined, "PREVIEW_PORT")
  const sslEnabled = parseBooleanMarker(combined, "SSL_ENABLED")

  return {
    ok: true,
    message: domain
      ? sslEnabled
        ? `域名已生效，并已启用 HTTPS：${domain}`
        : `域名已生效：${domain}${options.sslEmail ? "；SSL 申请未完成，请稍后重试或检查 DNS。" : ""}`
      : `预览地址已生成：http://${options.connection.host}:${previewPort}`,
    previewUrl: !domain && previewPort ? `http://${options.connection.host}:${previewPort}` : null,
    publicUrl: domain ? `${sslEnabled ? "https" : "http"}://${domain}` : null,
  }
}
