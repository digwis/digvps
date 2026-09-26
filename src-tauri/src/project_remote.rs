//! Remote-side project services: remote state inspection, remote details & site
//! settings, .env management, bootstrap, sftp deploy, server-to-server migration,
//! nginx-managed project scanning.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use crate::error::{internal_error, AppResult};
use crate::models::*;
use crate::ssh::{self, run_remote_shell_command};
use crate::settings::get_default_remote_directory;
use crate::util::*;

fn heredoc_to_file(label: &str, body: &str, target_path: &str, shell_expression: bool) -> String {
    let resolved = if shell_expression {
        target_path.to_string()
    } else {
        shell_single_quote(target_path)
    };
    format!("cat >{resolved} <<'{label}'\n{body}\n{label}\n")
}

fn tail_text(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.len() <= max {
        t.to_string()
    } else {
        format!("…{}", &t[t.len() - max..])
    }
}

fn parse_marker(output: &str, key: &str) -> String {
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{key}=")) {
            return rest.trim().to_string();
        }
    }
    String::new()
}

fn parse_bool_marker(output: &str, key: &str) -> bool {
    parse_marker(output, key) == "1"
}

fn parse_int_marker(output: &str, key: &str) -> Option<u32> {
    parse_marker(output, key).parse::<u32>().ok()
}

fn extract_env_from_template(template: Option<&str>) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in template.unwrap_or("").lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some(idx) = t.find('=') else { continue };
        if idx == 0 {
            continue;
        }
        values.insert(t[..idx].to_string(), t[idx + 1..].to_string());
    }
    values
}

fn managed_nginx_config_path(project_id: &str) -> String {
    format!("/etc/nginx/conf.d/digwis-panel-{project_id}.conf")
}

// ---------- remote state (project-remote-state) ----------

fn build_inspect_script(config: &ProjectPanelDeployConfig) -> AppResult<String> {
    let remote_app_dir = config
        .deploy
        .as_ref()
        .and_then(|d| d.remote_app_dir.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| internal_error("项目未配置 deploy.remoteAppDir"))?;

    let systemd_unit = config.init.as_ref().and_then(|i| i.systemd_unit.as_ref()).map(|s| s.trim().to_string());
    let remote_service = config.deploy.as_ref().and_then(|d| d.remote_service.as_ref()).map(|s| s.trim().to_string());
    let env_values = extract_env_from_template(
        config.init.as_ref().and_then(|i| i.env_template.as_deref()).map(str::trim),
    );
    let database_url = env_values.get("DATABASE_URL").map(|s| s.trim().to_string());

    let mut database_role_block = "echo \"DB_ROLE=1\"\necho \"DB_NAME=1\"\n".to_string();
    let mut database_server_block = "echo \"DB_SERVER=1\"\n".to_string();

    if let Some(db_url) = database_url.filter(|s| !s.is_empty()) {
        if let Ok(parsed) = url::Url::parse(&db_url) {
            let database_name = parsed.path().trim_start_matches('/').trim().to_string();
            let database_user = percent_encoding::percent_decode_str(parsed.username())
                .decode_utf8_lossy()
                .trim()
                .to_string();
            let database_host = parsed.host_str().unwrap_or("").trim().to_string();

            if !database_name.is_empty()
                && !database_user.is_empty()
                && ["127.0.0.1", "localhost"].contains(&database_host.as_str())
            {
                database_server_block = r#"
if command -v psql >/dev/null 2>&1; then
  echo "DB_SERVER=1"
else
  echo "DB_SERVER=0"
fi
"#
                .to_string();
                let role_q = format!(
                    "SELECT 1 FROM pg_roles WHERE rolname='{}'",
                    database_user.replace('\'', "''")
                );
                let db_q = format!(
                    "SELECT 1 FROM pg_database WHERE datname='{}'",
                    database_name.replace('\'', "''")
                );
                database_role_block = format!(
                    r#"
if command -v psql >/dev/null 2>&1; then
  run_as_postgres "psql -tAc {} | grep -q 1" && echo "DB_ROLE=1" || echo "DB_ROLE=0"
  run_as_postgres "psql -tAc {} | grep -q 1" && echo "DB_NAME=1" || echo "DB_NAME=0"
else
  echo "DB_ROLE=0"
  echo "DB_NAME=0"
fi
"#,
                    shell_single_quote(&role_q),
                    shell_single_quote(&db_q)
                );
            }
        }
    }

    let env_file_check = if config
        .init
        .as_ref()
        .and_then(|i| i.env_template.as_deref())
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false)
    {
        "[ -f \"$REMOTE_APP_DIR/.env\" ] && echo \"ENV_FILE=1\" || echo \"ENV_FILE=0\""
    } else {
        "echo \"ENV_FILE=1\""
    };

    let service_unit_check = match (remote_service.filter(|s| !s.is_empty()), systemd_unit.filter(|s| !s.is_empty())) {
        (Some(service), Some(_unit)) => format!(
            r#"
if as_root test -f {}; then
  echo "SERVICE_UNIT=1"
else
  echo "SERVICE_UNIT=0"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet {}; then
  echo "SERVICE_ACTIVE=1"
else
  echo "SERVICE_ACTIVE=0"
fi
"#,
            shell_single_quote(&format!("/etc/systemd/system/{service}")),
            shell_single_quote(&service)
        ),
        _ => "echo \"SERVICE_UNIT=1\"\necho \"SERVICE_ACTIVE=1\"\n".to_string(),
    };

    Ok(format!(
        r#"
set -e

REMOTE_APP_DIR={remote_app_dir}

as_root() {{
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}}

run_as_postgres() {{
  if [ "$(id -u)" -eq 0 ]; then
    su - postgres -c "$1"
  else
    sudo -n -u postgres bash -lc "$1"
  fi
}}

[ -d "$REMOTE_APP_DIR" ] && echo "APP_DIR=1" || echo "APP_DIR=0"
{env_file_check}
{service_unit_check}
{database_server_block}
{database_role_block}
"#,
        remote_app_dir = shell_single_quote(&remote_app_dir),
    ))
}

pub fn inspect_project_remote_state(
    connection: &VpsConnectionInput,
    config: &ProjectPanelDeployConfig,
) -> AppResult<ProjectRemoteState> {
    if config.init.is_none() {
        return Ok(ProjectRemoteState {
            can_initialize: false,
            ready: true,
            missing_items: vec![],
            runtime_issues: vec![],
            checked_at: now_iso(),
        });
    }

    let script = build_inspect_script(config)?;
    let result = run_remote_shell_command(connection, &script, 120_000)?;
    if result.code != 0 {
        return Err(internal_error(
            result.stderr.trim().to_string()
                + &if !result.stdout.trim().is_empty() { format!(" {}", result.stdout.trim()) } else { String::new() },
        ));
    }

    let combined = format!("{}\n{}", result.stdout, result.stderr);
    let mut missing = vec![];
    let mut issues = vec![];

    if !parse_bool_marker(&combined, "APP_DIR") {
        missing.push("远端目录".to_string());
    }
    if !parse_bool_marker(&combined, "ENV_FILE") {
        missing.push(".env 配置".to_string());
    }
    if !parse_bool_marker(&combined, "SERVICE_UNIT") {
        missing.push("systemd 服务".to_string());
    } else if !parse_bool_marker(&combined, "SERVICE_ACTIVE") {
        issues.push("服务未启动".to_string());
    }
    if !parse_bool_marker(&combined, "DB_SERVER") {
        missing.push("PostgreSQL".to_string());
    }
    if !parse_bool_marker(&combined, "DB_ROLE") {
        missing.push("数据库用户".to_string());
    }
    if !parse_bool_marker(&combined, "DB_NAME") {
        missing.push("数据库".to_string());
    }

    Ok(ProjectRemoteState {
        can_initialize: true,
        ready: missing.is_empty(),
        missing_items: missing,
        runtime_issues: issues,
        checked_at: now_iso(),
    })
}

// ---------- env management (project-env) ----------

pub fn read_project_env_file(connection: &VpsConnectionInput, remote_app_dir: &str) -> AppResult<ProjectEnvResult> {
    let env_path = format!("{}/.env", remote_app_dir.trim_end_matches('/'));
    let result = run_remote_shell_command(
        connection,
        &format!(
            "if [ -f {p} ]; then cat {p}; else touch {p} && cat {p}; fi",
            p = shell_single_quote(&env_path)
        ),
        120_000,
    )?;
    if result.code != 0 {
        return Ok(ProjectEnvResult {
            ok: false,
            message: if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                "读取远端 .env 失败".into()
            },
            content: None,
        });
    }
    Ok(ProjectEnvResult {
        ok: true,
        message: "已读取远端 .env".into(),
        content: Some(result.stdout),
    })
}

pub fn save_project_env_file(
    connection: &VpsConnectionInput,
    remote_app_dir: &str,
    content: &str,
) -> AppResult<ProjectEnvResult> {
    let env_path = format!("{}/.env", remote_app_dir.trim_end_matches('/'));
    let script = format!(
        "cat >{} <<'DIGWIS_PANEL_ENV'\n{}\nDIGWIS_PANEL_ENV\n",
        shell_single_quote(&env_path),
        content
    );
    let result = run_remote_shell_command(connection, &script, 120_000)?;
    if result.code != 0 {
        return Ok(ProjectEnvResult {
            ok: false,
            message: if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                "保存远端 .env 失败".into()
            },
            content: None,
        });
    }
    Ok(ProjectEnvResult {
        ok: true,
        message: "远端 .env 已保存".into(),
        content: Some(content.to_string()),
    })
}

pub fn rotate_project_session_secret(
    connection: &VpsConnectionInput,
    remote_app_dir: &str,
) -> AppResult<ProjectEnvResult> {
    let current = read_project_env_file(connection, remote_app_dir)?;
    if !current.ok {
        return Ok(current);
    }
    let next_secret = random_secret_urlsafe(32);
    let mut replaced = false;
    let mut next: Vec<String> = current
        .content
        .unwrap_or_default()
        .lines()
        .map(|line| {
            if line.starts_with("SESSION_SECRET=") {
                replaced = true;
                format!("SESSION_SECRET={next_secret}")
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        next.push(format!("SESSION_SECRET={next_secret}"));
    }
    let mut content = next.join("\n");
    while content.ends_with('\n') {
        content.pop();
    }
    content.push('\n');
    save_project_env_file(connection, remote_app_dir, &content)
}

pub fn control_project_remote_service(
    connection: &VpsConnectionInput,
    remote_service: &str,
    action: &str,
) -> AppResult<ProjectEnvResult> {
    let svc = shell_single_quote(remote_service);
    let cmd = if action == "restart" {
        format!("sudo -n systemctl restart {svc} && systemctl is-active {svc}")
    } else {
        format!("sudo -n systemctl stop {svc} && ! systemctl is-active {svc}")
    };
    let result = run_remote_shell_command(connection, &cmd, 120_000)?;
    if result.code != 0 {
        return Ok(ProjectEnvResult {
            ok: false,
            message: if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                format!("{}远端服务失败", if action == "restart" { "重启" } else { "停止" })
            },
            content: None,
        });
    }
    Ok(ProjectEnvResult {
        ok: true,
        message: format!(
            "服务已{}：{}",
            if action == "restart" { "重启" } else { "停止" },
            if result.stdout.trim().is_empty() { remote_service.to_string() } else { result.stdout.trim().to_string() }
        ),
        content: None,
    })
}

// ---------- remote details (project-remote-management) ----------

static DETAILS_CACHE: Mutex<Option<HashMap<String, (std::time::Instant, ProjectRemoteDetails)>>> =
    Mutex::new(None);
const DETAILS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(20);

fn normalize_remote_child_path(root: &str, candidate: Option<&str>) -> AppResult<String> {
    let normalized_root = posix_normalize(&root.replace('\\', "/"));
    let normalized_candidate = posix_normalize(&candidate.unwrap_or(&normalized_root).replace('\\', "/"));
    if normalized_candidate != normalized_root
        && !normalized_candidate.starts_with(&format!("{normalized_root}/"))
    {
        return Err(internal_error("只能浏览部署目录及其子目录"));
    }
    Ok(normalized_candidate)
}

fn parse_files(output: &str) -> Vec<ProjectRemoteFileEntry> {
    let mut entries = vec![];
    for line in output.lines() {
        if !line.starts_with("FILE\t") {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 6 {
            continue;
        }
        let kind = match parts[1] {
            "directory" => "directory",
            "symlink" => "symlink",
            _ => "file",
        };
        entries.push(ProjectRemoteFileEntry {
            name: parts[4].to_string(),
            path: parts[5].to_string(),
            entry_type: kind.to_string(),
            size: parts[2].parse().unwrap_or(0),
            modified_at: if parts[3].is_empty() { None } else { Some(parts[3].to_string()) },
        });
    }
    entries.sort_by(|a, b| {
        if a.entry_type == b.entry_type {
            a.name.cmp(&b.name)
        } else if a.entry_type == "directory" {
            std::cmp::Ordering::Less
        } else if b.entry_type == "directory" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });
    entries
}

fn build_remote_details_script(
    project_id: &str,
    remote_app_dir: &str,
    browse_path: &str,
    remote_service: Option<&str>,
) -> String {
    let config_path = managed_nginx_config_path(project_id);
    let fallback_config_path = managed_nginx_config_path(&posix_basename(remote_app_dir));
    let service = remote_service.map(str::trim).filter(|s| !s.is_empty());

    let service_block = if let Some(svc) = service {
        format!(
            r#"
echo "SERVICE_CONFIGURED=1"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet {svc} && echo "SERVICE_ACTIVE=1" || echo "SERVICE_ACTIVE=0"
  systemctl is-enabled --quiet {svc} && echo "SERVICE_ENABLED=1" || echo "SERVICE_ENABLED=0"
  echo "SERVICE_STATUS=$(systemctl status {svc} --no-pager 2>/dev/null | sed -n '1,3p' | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
else
  echo "SERVICE_ACTIVE=0"
  echo "SERVICE_ENABLED=0"
  echo "SERVICE_STATUS=systemctl unavailable"
fi
"#,
            svc = shell_single_quote(svc)
        )
    } else {
        r#"
echo "SERVICE_CONFIGURED=0"
echo "SERVICE_ACTIVE=0"
echo "SERVICE_ENABLED=0"
echo "SERVICE_STATUS=未配置远端服务"
"#
        .to_string()
    };

    format!(
        r#"
set -e

REMOTE_APP_DIR={remote_app_dir}
BROWSE_PATH={browse_path}
MANAGED_NGINX_CONF={conf}
FALLBACK_NGINX_CONF={fallback}

read_marker_file_value() {{
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  sudo -n sh -c "grep '^# $key=' '$file' 2>/dev/null | tail -n1 | cut -d= -f2-"
}}

echo "REMOTE_APP_DIR=$REMOTE_APP_DIR"
echo "CURRENT_PATH=$BROWSE_PATH"
[ -d "$REMOTE_APP_DIR" ] && echo "PATH_EXISTS=1" || echo "PATH_EXISTS=0"

APP_PORT=""
if [ -f "$REMOTE_APP_DIR/.env" ]; then
  APP_PORT="$(grep -E '^PORT=' "$REMOTE_APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\r' | tr -d '"' | tr -d "'")"
fi
[ -n "$APP_PORT" ] || APP_PORT=5000
echo "APP_PORT=$APP_PORT"

{service_block}

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
if sudo -n test -f "/etc/ssl/digwis-panel/{project_id}/origin.crt"; then
  CUSTOM_CERT_PATH="/etc/ssl/digwis-panel/{project_id}/origin.crt"
  CUSTOM_KEY_PATH="/etc/ssl/digwis-panel/{project_id}/origin.key"
elif sudo -n test -f "/etc/ssl/digwis-panel/{app_base}/origin.crt"; then
  CUSTOM_CERT_PATH="/etc/ssl/digwis-panel/{app_base}/origin.crt"
  CUSTOM_KEY_PATH="/etc/ssl/digwis-panel/{app_base}/origin.key"
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
  find "$BROWSE_PATH" -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%f\t%p\n' \
    | while IFS=$'\t' read -r kind size modified name fullPath; do
        if [ "$kind" = "d" ]; then fileType="directory";
        elif [ "$kind" = "l" ]; then fileType="symlink";
        else fileType="file"; fi
        printf 'FILE\t%s\t%s\t%s\t%s\t%s\n' "$fileType" "$size" "$modified" "$name" "$fullPath"
      done
fi
"#,
        remote_app_dir = shell_single_quote(remote_app_dir),
        browse_path = shell_single_quote(browse_path),
        conf = shell_single_quote(&config_path),
        fallback = shell_single_quote(&fallback_config_path),
        service_block = service_block,
        project_id = project_id,
        app_base = posix_basename(remote_app_dir),
    )
}

pub fn get_project_remote_details(
    project_id: &str,
    connection: &VpsConnectionInput,
    remote_app_dir: &str,
    remote_service: Option<&str>,
    browse_path: Option<&str>,
    force_refresh: bool,
) -> AppResult<ProjectRemoteDetails> {
    let browse_path = normalize_remote_child_path(remote_app_dir, browse_path)?;
    let connection_key = connection
        .id
        .clone()
        .unwrap_or_else(|| format!("{}@{}:{}", connection.username, connection.host, connection.port));
    let cache_key = format!(
        "{}::{}::{}::{}::{}",
        project_id,
        connection_key,
        remote_app_dir,
        remote_service.unwrap_or(""),
        browse_path
    );

    if !force_refresh {
        let cache = DETAILS_CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            if let Some((at, value)) = map.get(&cache_key) {
                if at.elapsed() < DETAILS_CACHE_TTL {
                    return Ok(value.clone());
                }
            }
        }
    }

    let script = build_remote_details_script(project_id, remote_app_dir, &browse_path, remote_service);
    let result = run_remote_shell_command(connection, &script, 120_000)?;
    if result.code != 0 {
        return Err(internal_error(
            result.stderr.trim().to_string()
                + &if !result.stdout.trim().is_empty() { format!(" {}", result.stdout.trim()) } else { String::new() },
        ));
    }

    let combined = format!("{}\n{}", result.stdout, result.stderr);
    let domain = {
        let d = parse_marker(&combined, "SITE_DOMAIN");
        if d.is_empty() { None } else { Some(d) }
    };
    let preview_port = parse_int_marker(&combined, "SITE_PREVIEW_PORT");
    let ssl_enabled = parse_bool_marker(&combined, "SITE_SSL_ENABLED");
    let ssl_mode = {
        let m = parse_marker(&combined, "SITE_SSL_MODE");
        if m.is_empty() { "none".to_string() } else { m }
    };
    let cert_b64 = parse_marker(&combined, "SITE_CERT_PEM_B64");
    let preview_url = if domain.is_none() && preview_port.is_some() {
        Some(format!("http://{}:{}", connection.host, preview_port.unwrap()))
    } else {
        None
    };
    let public_url = domain
        .as_ref()
        .map(|d| format!("{}://{}", if ssl_enabled { "https" } else { "http" }, d))
        .or_else(|| preview_url.clone());

    let details = ProjectRemoteDetails {
        remote_app_dir: {
            let v = parse_marker(&combined, "REMOTE_APP_DIR");
            if v.is_empty() { remote_app_dir.to_string() } else { v }
        },
        current_path: {
            let v = parse_marker(&combined, "CURRENT_PATH");
            if v.is_empty() { browse_path.clone() } else { v }
        },
        path_exists: parse_bool_marker(&combined, "PATH_EXISTS"),
        app_port: parse_int_marker(&combined, "APP_PORT"),
        preview_url,
        public_url,
        files: parse_files(&combined),
        service: ProjectRemoteServiceStatus {
            configured: parse_bool_marker(&combined, "SERVICE_CONFIGURED"),
            unit: remote_service.map(str::trim).filter(|s| !s.is_empty()).map(String::from),
            active: parse_bool_marker(&combined, "SERVICE_ACTIVE"),
            enabled: parse_bool_marker(&combined, "SERVICE_ENABLED"),
            status_text: {
                let v = parse_marker(&combined, "SERVICE_STATUS");
                if v.is_empty() { "未知".into() } else { v }
            },
        },
        site: ProjectRemoteSiteStatus {
            mode: if domain.is_some() {
                "domain"
            } else if preview_port.is_some() {
                "port"
            } else {
                "none"
            }
            .to_string(),
            domain,
            preview_port,
            ssl_enabled,
            ssl_mode: Some(ssl_mode),
            custom_certificate_configured: Some(parse_bool_marker(&combined, "SITE_CUSTOM_CERT")),
            certificate_pem: if cert_b64.is_empty() {
                None
            } else {
                base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    &cert_b64,
                )
                .ok()
                .map(|b| String::from_utf8_lossy(&b).to_string())
            },
            nginx_installed: parse_bool_marker(&combined, "NGINX_INSTALLED"),
            certbot_installed: parse_bool_marker(&combined, "CERTBOT_INSTALLED"),
            config_path: {
                let v = parse_marker(&combined, "SITE_CONFIG_PATH");
                if v.is_empty() { None } else { Some(v) }
            },
        },
        checked_at: now_iso(),
    };

    let mut cache = DETAILS_CACHE.lock().unwrap();
    cache
        .get_or_insert_with(HashMap::new)
        .insert(cache_key, (std::time::Instant::now(), details.clone()));
    Ok(details)
}

// ---------- site settings (apply) ----------

fn build_apply_site_settings_script(opts: &ApplySiteOptions) -> String {
    let config_path = managed_nginx_config_path(&opts.project_id);
    let domain = opts.domain.clone().unwrap_or_default().trim().to_string();
    let ssl_email = opts.ssl_email.clone().unwrap_or_default().trim().to_string();
    let cert_pem = opts.certificate_pem.clone().unwrap_or_default().trim().to_string();
    let key_pem = opts.private_key_pem.clone().unwrap_or_default().trim().to_string();
    let app_port = opts.app_port.filter(|p| *p > 0).unwrap_or(5000);
    let cert_dir = format!("/etc/ssl/digwis-panel/{}", opts.project_id);
    let cert_path = format!("{cert_dir}/origin.crt");
    let key_path = format!("{cert_dir}/origin.key");

    let custom_ssl_block = if !domain.is_empty() && !cert_pem.is_empty() && !key_pem.is_empty() {
        format!(
            r#"
HAS_CUSTOM_SSL=1
sudo -n mkdir -p "$CERT_DIR"
tmp_cert="$(mktemp)"
tmp_key="$(mktemp)"
{cert_heredoc}
{key_heredoc}
sudo -n install -m 0644 "$tmp_cert" "$CERT_PATH"
sudo -n install -m 0600 "$tmp_key" "$KEY_PATH"
rm -f "$tmp_cert" "$tmp_key"
"#,
            cert_heredoc = heredoc_to_file("DIGWIS_PANEL_CERT", &cert_pem, "\"$tmp_cert\"", true),
            key_heredoc = heredoc_to_file("DIGWIS_PANEL_KEY", &key_pem, "\"$tmp_key\"", true),
        )
    } else {
        "HAS_CUSTOM_SSL=0".to_string()
    };

    format!(
        r#"
set -e

PROJECT_ID={project_id}
REMOTE_APP_DIR={remote_app_dir}
APP_PORT={app_port}
DOMAIN={domain}
SSL_EMAIL={ssl_email}
MANAGED_NGINX_CONF={conf}
CERT_DIR={cert_dir}
CERT_PATH={cert_path}
KEY_PATH={key_path}

sudo -n true
command -v nginx >/dev/null 2>&1 || {{ echo "缺少 nginx，请先安装 nginx" >&2; exit 2; }}
sudo -n mkdir -p /etc/nginx/conf.d

existing_port=""
if sudo -n test -f "$MANAGED_NGINX_CONF"; then
  existing_port="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_PREVIEW_PORT=' '$MANAGED_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
fi

allocate_port() {{
  local used port candidate
  used="$(
    if command -v ss >/dev/null 2>&1; then
      ss -ltnH | awk '{{print $4}}' | sed 's/.*://'
    elif command -v netstat >/dev/null 2>&1; then
      netstat -ltn 2>/dev/null | awk 'NR>2 {{print $4}}' | sed 's/.*://'
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
}}

PREVIEW_PORT="$existing_port"
if [ -z "$DOMAIN" ]; then
  if [ -z "$PREVIEW_PORT" ]; then
    PREVIEW_PORT="$(allocate_port)"
  fi
else
  PREVIEW_PORT=""
fi

{custom_ssl_block}

tmp_conf="$(mktemp)"
if [ -n "$DOMAIN" ]; then
if [ "$HAS_CUSTOM_SSL" = "1" ]; then
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=$DOMAIN
# DIGWIS_PANEL_PREVIEW_PORT=
# DIGWIS_PANEL_SSL_MODE=custom
server {{
  listen 80;
  server_name $DOMAIN;
  return 301 https://$host$request_uri;
}}

server {{
  listen 443 ssl http2;
  server_name $DOMAIN;
  ssl_certificate $CERT_PATH;
  ssl_certificate_key $KEY_PATH;

  location / {{
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }}
}}
EOF
else
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=$DOMAIN
# DIGWIS_PANEL_PREVIEW_PORT=
# DIGWIS_PANEL_SSL_MODE=none
server {{
  listen 80;
  server_name $DOMAIN;

  location / {{
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }}
}}
EOF
fi
else
cat >"$tmp_conf" <<EOF
# DIGWIS_PANEL_PROJECT_ID=$PROJECT_ID
# DIGWIS_PANEL_DOMAIN=
# DIGWIS_PANEL_PREVIEW_PORT=$PREVIEW_PORT
# DIGWIS_PANEL_SSL_MODE=none
server {{
  listen $PREVIEW_PORT;
  server_name _;

  location / {{
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }}
}}
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
"#,
        project_id = shell_single_quote(&opts.project_id),
        remote_app_dir = shell_single_quote(&opts.remote_app_dir),
        app_port = shell_single_quote(&app_port.to_string()),
        domain = shell_single_quote(&domain),
        ssl_email = shell_single_quote(&ssl_email),
        conf = shell_single_quote(&config_path),
        cert_dir = shell_single_quote(&cert_dir),
        cert_path = shell_single_quote(&cert_path),
        key_path = shell_single_quote(&key_path),
        custom_ssl_block = custom_ssl_block,
    )
}

pub struct ApplySiteOptions {
    pub project_id: String,
    pub remote_app_dir: String,
    pub app_port: Option<u32>,
    pub domain: Option<String>,
    pub ssl_email: Option<String>,
    pub certificate_pem: Option<String>,
    pub private_key_pem: Option<String>,
}

pub fn apply_project_site_settings(
    connection: &VpsConnectionInput,
    opts: &ApplySiteOptions,
) -> AppResult<ProjectSiteSettingsResult> {
    let script = build_apply_site_settings_script(opts);
    let result = run_remote_shell_command(connection, &script, 240_000)?;
    let combined = format!("{}\n{}", result.stdout, result.stderr);
    if result.code != 0 || !parse_bool_marker(&combined, "DIGWIS_SITE_OK") {
        return Ok(ProjectSiteSettingsResult {
            ok: false,
            message: if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                "应用站点设置失败".into()
            },
            preview_url: None,
            public_url: None,
        });
    }

    let domain = {
        let d = parse_marker(&combined, "DOMAIN");
        if d.is_empty() { None } else { Some(d) }
    };
    let preview_port = parse_int_marker(&combined, "PREVIEW_PORT");
    let ssl_enabled = parse_bool_marker(&combined, "SSL_ENABLED");
    let has_ssl_email = opts.ssl_email.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

    let message = match &domain {
        Some(d) => {
            if ssl_enabled {
                format!("域名已生效，并已启用 HTTPS：{d}")
            } else {
                format!(
                    "域名已生效：{d}{}",
                    if has_ssl_email { "；SSL 申请未完成，请稍后重试或检查 DNS。" } else { "" }
                )
            }
        }
        None => format!(
            "预览地址已生成：http://{}:{}",
            connection.host,
            preview_port.map(|p| p.to_string()).unwrap_or_default()
        ),
    };

    Ok(ProjectSiteSettingsResult {
        ok: true,
        message,
        preview_url: if domain.is_none() && preview_port.is_some() {
            Some(format!("http://{}:{}", connection.host, preview_port.unwrap()))
        } else {
            None
        },
        public_url: domain.map(|d| format!("{}://{}", if ssl_enabled { "https" } else { "http" }, d)),
    })
}

// ---------- bootstrap (project-bootstrap) ----------

fn materialize_env_template(template: Option<&str>) -> Option<String> {
    let template = template?;
    let mut replacements: HashMap<String, String> = HashMap::new();
    let mut get_replacement = |key: &str, factory: &dyn Fn() -> String| -> String {
        replacements
            .entry(key.to_string())
            .or_insert_with(factory)
            .clone()
    };
    let out = template
        .lines()
        .map(|line| {
            if line.starts_with("SESSION_SECRET=") && line.contains("CHANGE_ME") {
                let v = get_replacement("SESSION_SECRET", &|| random_secret_urlsafe(32));
                return format!("SESSION_SECRET={v}");
            }
            if line.starts_with("DATABASE_URL=") && line.contains("CHANGE_ME") {
                let raw = &line["DATABASE_URL=".len()..];
                if let Ok(mut parsed) = url::Url::parse(raw) {
                    if parsed.password().map(|p| p.contains("CHANGE_ME")).unwrap_or(false) {
                        let pw = get_replacement("DATABASE_PASSWORD", &|| random_secret_urlsafe(18));
                        let _ = parsed.set_password(Some(&pw));
                        return format!("DATABASE_URL={parsed}");
                    }
                }
                return line.to_string();
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(out)
}

fn build_bootstrap_script(config: &ProjectPanelDeployConfig) -> AppResult<String> {
    let remote_app_dir = config
        .deploy
        .as_ref()
        .and_then(|d| d.remote_app_dir.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| internal_error("部署配置缺少 deploy.remoteAppDir，无法初始化远端。"))?;
    let remote_service = config.deploy.as_ref().and_then(|d| d.remote_service.as_ref()).map(|s| s.trim().to_string());
    let env_template = materialize_env_template(
        config.init.as_ref().and_then(|i| i.env_template.as_deref()).map(str::trim),
    );
    let systemd_unit = config.init.as_ref().and_then(|i| i.systemd_unit.as_ref()).map(|s| s.trim().to_string());
    let env_values = extract_env_from_template(env_template.as_deref());
    let mut remote_packages: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for item in config
        .init
        .as_ref()
        .and_then(|i| i.remote_packages.clone())
        .unwrap_or_default()
    {
        let t = item.trim().to_string();
        if !t.is_empty() && seen.insert(t.clone()) {
            remote_packages.push(t);
        }
    }

    let mut postgres_block = "echo \"[2/5] No PostgreSQL bootstrap requested; skipping...\"".to_string();
    if let Some(db_url) = env_values.get("DATABASE_URL").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if let Ok(parsed) = url::Url::parse(&db_url) {
            let database_name = parsed.path().trim_start_matches('/').trim().to_string();
            let database_user = percent_encoding::percent_decode_str(parsed.username()).decode_utf8_lossy().trim().to_string();
            let database_password = parsed
                .password()
                .map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().trim().to_string())
                .unwrap_or_default();
            let database_host = parsed.host_str().unwrap_or("").trim().to_string();
            if !database_name.is_empty()
                && !database_user.is_empty()
                && !database_password.is_empty()
                && ["127.0.0.1", "localhost"].contains(&database_host.as_str())
            {
                let esc_dq = |s: &str| s.replace('"', "\"\"");
                let esc_sq = |s: &str| s.replace('\'', "''");
                postgres_block = format!(
                    r#"
echo "[2/5] Provisioning PostgreSQL..."
if command -v systemctl >/dev/null 2>&1; then
  as_root systemctl enable --now postgresql || true
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found after package installation" >&2
  exit 3
fi
run_as_postgres "psql -tAc {role_exists} | grep -q 1 || psql -c {create_role}"
run_as_postgres "psql -c {alter_role}"
run_as_postgres "psql -tAc {db_exists} | grep -q 1 || psql -c {create_db}"
"#,
                    role_exists = shell_single_quote(&format!(
                        "SELECT 1 FROM pg_roles WHERE rolname='{}'",
                        esc_sq(&database_user)
                    )),
                    create_role = shell_single_quote(&format!(
                        "CREATE ROLE \"{}\" LOGIN;",
                        esc_dq(&database_user)
                    )),
                    alter_role = shell_single_quote(&format!(
                        "ALTER ROLE \"{}\" WITH LOGIN PASSWORD '{}';",
                        esc_dq(&database_user),
                        esc_sq(&database_password)
                    )),
                    db_exists = shell_single_quote(&format!(
                        "SELECT 1 FROM pg_database WHERE datname='{}'",
                        esc_sq(&database_name)
                    )),
                    create_db = shell_single_quote(&format!(
                        "CREATE DATABASE \"{}\" OWNER \"{}\";",
                        esc_dq(&database_name),
                        esc_dq(&database_user)
                    )),
                );
            }
        } else {
            postgres_block =
                "echo \"[2/5] DATABASE_URL could not be parsed; skipping PostgreSQL bootstrap...\"".to_string();
        }
    }

    let package_install_block = if !remote_packages.is_empty() {
        let joined = remote_packages
            .iter()
            .map(|p| shell_single_quote(p))
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            r#"
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
    as_root apt-get install -y {joined}
    ;;
  dnf)
    as_root dnf install -y {joined}
    ;;
  yum)
    as_root yum install -y {joined}
    ;;
  apk)
    as_root apk add --no-cache {joined}
    ;;
  pacman)
    as_root pacman -Sy --noconfirm {joined}
    ;;
esac
"#
        )
    } else {
        "echo \"[1/4] No remote packages requested; skipping...\"".to_string()
    };

    let env_block = if let Some(tpl) = &env_template {
        format!(
            r#"
echo "[4/5] Ensuring .env exists..."
if [ ! -f "$REMOTE_APP_DIR/.env" ]; then
  {env_heredoc}
  echo "Created $REMOTE_APP_DIR/.env from template."
else
  echo "$REMOTE_APP_DIR/.env already exists; keeping current file."
fi
"#,
            env_heredoc = heredoc_to_file("DIGWIS_PANEL_ENV", tpl, "\"$REMOTE_APP_DIR/.env\"", true),
        )
    } else {
        "echo \"[4/5] No env template configured; skipping .env bootstrap...\"".to_string()
    };

    let service_block = match (remote_service.filter(|s| !s.is_empty()), systemd_unit.filter(|s| !s.is_empty())) {
        (Some(svc), Some(unit)) => format!(
            r#"
echo "[5/5] Writing systemd service..."
{unit_heredoc}
as_root install -m 0644 "/tmp/{svc}" "/etc/systemd/system/{svc}"
rm -f "/tmp/{svc}"
as_root systemctl daemon-reload
as_root systemctl enable {svc_q}
as_root systemctl restart {svc_q} || true
as_root systemctl is-active {svc_q} || true
"#,
            unit_heredoc = heredoc_to_file("DIGWIS_PANEL_SERVICE", &unit, &format!("/tmp/{svc}"), false),
            svc = svc,
            svc_q = shell_single_quote(&svc),
        ),
        _ => "echo \"[5/5] No systemd unit configured; skipping service bootstrap...\"".to_string(),
    };

    Ok(format!(
        r#"
set -Eeuo pipefail

REMOTE_APP_DIR={remote_app_dir}

as_root() {{
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}}

{package_install_block}

run_as_postgres() {{
  if [ "$(id -u)" -eq 0 ]; then
    su - postgres -c "$1"
  else
    sudo -n -u postgres bash -lc "$1"
  fi
}}

{postgres_block}

echo "[3/5] Ensuring remote directories..."
as_root mkdir -p "$REMOTE_APP_DIR"
as_root chown -R $(id -un):$(id -gn) "$REMOTE_APP_DIR"

{env_block}

{service_block}

printf '%s\n' DIGWIS_PROJECT_BOOTSTRAP_OK
"#,
        remote_app_dir = shell_single_quote(&remote_app_dir),
    ))
}

pub fn initialize_project_on_vps(
    connection: &VpsConnectionInput,
    config: &ProjectPanelDeployConfig,
) -> AppResult<ProjectDeployResult> {
    let start = std::time::Instant::now();
    let kind = config
        .deploy
        .as_ref()
        .and_then(|d| d.strategy.clone())
        .or(Some("local-npm-script".to_string()));
    let remote_path = config
        .deploy
        .as_ref()
        .and_then(|d| d.remote_app_dir.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let script = match build_bootstrap_script(config) {
        Ok(s) => s,
        Err(e) => {
            return Ok(ProjectDeployResult {
                ok: false,
                duration_ms: start.elapsed().as_millis() as u64,
                kind,
                message: e,
                remote_path,
            })
        }
    };

    match run_remote_shell_command(connection, &script, 900_000) {
        Ok(result) => {
            let combined = format!("{}\n{}", result.stdout, result.stderr);
            let ok = result.code == 0 && combined.contains("DIGWIS_PROJECT_BOOTSTRAP_OK");
            let detail = tail_text(&combined, 1800);
            Ok(ProjectDeployResult {
                ok,
                duration_ms: start.elapsed().as_millis() as u64,
                kind,
                message: if ok {
                    if detail.is_empty() {
                        "远端初始化已完成。".to_string()
                    } else {
                        format!("远端初始化已完成。\n{detail}")
                    }
                } else if detail.is_empty() {
                    format!("远端初始化失败（退出码 {}）", result.code)
                } else {
                    detail
                },
                remote_path,
            })
        }
        Err(e) => Ok(ProjectDeployResult {
            ok: false,
            duration_ms: start.elapsed().as_millis() as u64,
            kind,
            message: e,
            remote_path,
        }),
    }
}

// ---------- deploy (project-deploy) ----------

const BLOCKED_REMOTE_PREFIXES: &[&str] = &[
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sys", "/usr/bin", "/usr/sbin",
    "/sbin", "/run/systemd",
];

pub fn assert_sane_remote_deploy_path(remote_path: &str) -> AppResult<()> {
    let normalized = posix_normalize(&remote_path.replace('\\', "/"));
    if !normalized.starts_with('/') {
        return Err(internal_error("远端路径必须是绝对路径"));
    }
    if normalized.contains("/../") || normalized.ends_with("/..") || normalized == ".." {
        return Err(internal_error("远端路径不能包含 .."));
    }
    for prefix in BLOCKED_REMOTE_PREFIXES {
        if normalized == *prefix || normalized.starts_with(&format!("{prefix}/")) {
            return Err(internal_error(format!("不允许部署到系统目录：{prefix}")));
        }
    }
    Ok(())
}

pub fn resolve_remote_deploy_path_for_project(
    connection: &VpsConnectionInput,
    project_id: &str,
    remote_parent_path: Option<&str>,
) -> AppResult<String> {
    let parent: String;
    if let Some(raw_in) = remote_parent_path.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let mut raw = raw_in.replace('\\', "/");
        if let Some(rest) = raw.strip_prefix("~/") {
            let home = ssh::run_remote_shell_command(connection, "printf %s \"$HOME\"", 20_000)?;
            if home.code != 0 {
                return Err(internal_error(format!(
                    "无法解析远端主目录（用于展开 ~）：{}",
                    if !home.stderr.is_empty() { home.stderr } else { home.stdout }
                )));
            }
            let home_dir = {
                let h = home.stdout.trim().replace('\\', "/");
                if h.is_empty() { "/root".to_string() } else { h }
            };
            raw = posix_join(&home_dir, rest);
        }
        parent = posix_normalize(&raw);
    } else {
        let home = ssh::run_remote_shell_command(connection, "printf %s \"$HOME\"", 20_000)?;
        if home.code != 0 {
            return Err(internal_error(format!(
                "无法解析远端主目录：{}",
                if !home.stderr.is_empty() { home.stderr } else { home.stdout }
            )));
        }
        let home_dir = {
            let h = home.stdout.trim().replace('\\', "/");
            if h.is_empty() { "/root".to_string() } else { h }
        };
        parent = posix_join(&home_dir, "openvps-projects");
    }
    assert_sane_remote_deploy_path(&parent)?;
    let deploy = posix_join(&parent, project_id).replace('\\', "/");
    assert_sane_remote_deploy_path(&deploy)?;
    Ok(deploy)
}

fn default_upload_excluded(name: &str, is_dir: bool) -> bool {
    const EXCLUDED: &[&str] = &[
        "node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", "out", "coverage",
        "target", ".turbo", ".cache",
    ];
    if EXCLUDED.contains(&name) {
        return true;
    }
    !is_dir && name == ".DS_Store"
}

/// Recursively upload local dir to remote via SFTP, honoring the default filter.
fn sftp_upload_dir(
    sftp: &ssh2::Sftp,
    local: &Path,
    remote: &str,
    failures: &mut Vec<String>,
) -> AppResult<()> {
    let remote = remote.trim_end_matches('/');
    if let Err(e) = sftp.mkdir(Path::new(remote), 0o755) {
        let _ = e; // may already exist
    }
    let entries = std::fs::read_dir(local).map_err(|e| internal_error(e.to_string()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        let local_path = entry.path();
        let remote_path = format!("{remote}/{name}");
        if ft.is_dir() {
            if default_upload_excluded(&name, true) {
                continue;
            }
            sftp_upload_dir(sftp, &local_path, &remote_path, failures)?;
        } else if ft.is_file() {
            if default_upload_excluded(&name, false) {
                continue;
            }
            if let Err(e) = crate::remote_files::sftp_upload_file(sftp, &local_path, &remote_path) {
                failures.push(format!("{name}: {e}"));
            }
        }
    }
    Ok(())
}

pub fn deploy_local_project_to_vps(
    connection: &VpsConnectionInput,
    local_root: &str,
    remote_deploy_path: &str,
) -> ProjectDeployResult {
    let start = std::time::Instant::now();
    if let Err(e) = assert_sane_remote_deploy_path(remote_deploy_path) {
        return ProjectDeployResult {
            ok: false,
            message: e,
            remote_path: None,
            duration_ms: start.elapsed().as_millis() as u64,
            kind: Some("sftp".into()),
        };
    }

    let prepare = match run_remote_shell_command(
        connection,
        &format!(
            "mkdir -p {p} && rm -rf {p}/*",
            p = shell_single_quote(remote_deploy_path)
        ),
        180_000,
    ) {
        Ok(r) => r,
        Err(e) => {
            return ProjectDeployResult {
                ok: false,
                message: e,
                remote_path: None,
                duration_ms: start.elapsed().as_millis() as u64,
                kind: Some("sftp".into()),
            }
        }
    };
    if prepare.code != 0 {
        return ProjectDeployResult {
            ok: false,
            message: format!(
                "准备远端目录失败：{}",
                if !prepare.stderr.is_empty() {
                    prepare.stderr.chars().take(400).collect::<String>()
                } else {
                    prepare.stdout
                }
            ),
            remote_path: None,
            duration_ms: start.elapsed().as_millis() as u64,
            kind: Some("sftp".into()),
        };
    }

    let session = match ssh::connect(connection, 20_000) {
        Ok(s) => s,
        Err(e) => {
            return ProjectDeployResult {
                ok: false,
                message: e,
                remote_path: None,
                duration_ms: start.elapsed().as_millis() as u64,
                kind: Some("sftp".into()),
            }
        }
    };
    let sftp = match session.sftp() {
        Ok(s) => s,
        Err(e) => {
            return ProjectDeployResult {
                ok: false,
                message: e,
                remote_path: None,
                duration_ms: start.elapsed().as_millis() as u64,
                kind: Some("sftp".into()),
            }
        }
    };

    let mut failures = Vec::new();
    let upload_result = sftp_upload_dir(&sftp, Path::new(local_root), remote_deploy_path, &mut failures);
    if let Err(e) = upload_result {
        return ProjectDeployResult {
            ok: false,
            message: e,
            remote_path: None,
            duration_ms: start.elapsed().as_millis() as u64,
            kind: Some("sftp".into()),
        };
    }
    if !failures.is_empty() {
        return ProjectDeployResult {
            ok: false,
            message: format!("部分文件上传失败：{}", failures.join("；")),
            remote_path: None,
            duration_ms: start.elapsed().as_millis() as u64,
            kind: Some("sftp".into()),
        };
    }

    ProjectDeployResult {
        ok: true,
        message: "项目文件已同步到 VPS".into(),
        remote_path: Some(remote_deploy_path.to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
        kind: Some("sftp".into()),
    }
}

// ---------- remote-managed project scan (remote-managed-projects) ----------

const NGINX_CONFIG_PATHS: &[&str] = &[
    "/etc/nginx/conf.d",
    "/etc/nginx/sites-enabled",
    "/etc/nginx/sites-available",
];
const FALLBACK_PROBE_DIRS: &[&str] = &["/srv/www", "/opt"];
const HEURISTIC_PROBE_LIMIT: usize = 6;

fn heuristic_probe_dirs() -> Vec<String> {
    let mut dirs = vec![get_default_remote_directory()];
    for d in FALLBACK_PROBE_DIRS {
        if !dirs.contains(&d.to_string()) {
            dirs.push(d.to_string());
        }
    }
    dirs
}

fn parse_nginx_proxy_servers(config_path: &str, content: &str) -> Vec<RemoteManagedProject> {
    let block_re = regex::Regex::new(r"server\s*\{[\s\S]*?\}").unwrap();
    let name_re = regex::Regex::new(r"server_name\s+([^;]+);").unwrap();
    let proxy_re = regex::Regex::new(r"proxy_pass\s+([^;]+);").unwrap();
    let mut projects = vec![];
    for (index, caps) in block_re.captures_iter(content).enumerate() {
        let block = &caps[0];
        let server_name = name_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().split_whitespace().next().unwrap_or("").to_string());
        let proxy_pass = proxy_re.captures(block).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string());
        let (Some(server_name), Some(proxy_pass)) = (server_name, proxy_pass) else {
            continue;
        };
        if server_name.is_empty() {
            continue;
        }
        projects.push(RemoteManagedProject {
            id: format!("{config_path}#{index}#{server_name}"),
            connection_id: String::new(),
            domain: server_name,
            nginx_config_path: config_path.to_string(),
            proxy_target: proxy_pass,
            project_path: None,
            path_source: "unknown".into(),
            service_name: None,
            runtime_type: None,
            status: "unknown".into(),
            status_text: "已识别反向代理站点，尚未推断项目路径".into(),
        });
    }
    projects
}

fn extract_listen_port(proxy_target: &str) -> Option<u32> {
    let re = regex::Regex::new(r"(?:/|:)(\d{2,5})\b").unwrap();
    re.captures(proxy_target)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
}

fn probe_heuristic_path(payload: &VpsConnectionInput, project: &RemoteManagedProject) -> Option<String> {
    for base in heuristic_probe_dirs() {
        let cmd = format!(
            "if [ -d {b} ]; then ls -1 {b} | head -n {limit} | sed 's#^#{base}/#'; fi",
            b = shell_quote(&base),
            limit = HEURISTIC_PROBE_LIMIT,
            base = base,
        );
        let Ok(result) = run_remote_shell_command(payload, &cmd, 5_000) else {
            continue;
        };
        if result.code != 0 {
            continue;
        }
        let entries: Vec<String> = result
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let tokens = project.domain.split('.').take(2).collect::<Vec<_>>().join(".");
        if let Some(matched) = entries.iter().find(|e| e.ends_with(&format!("{base}/{tokens}"))) {
            return Some(matched.clone());
        }
        if let Some(fallback) = entries.iter().find(|e| {
            e.ends_with("/app") || e.ends_with("/web") || e.ends_with("/server")
        }) {
            return Some(fallback.clone());
        }
    }
    None
}

struct InferredPath {
    project_path: Option<String>,
    service_name: Option<String>,
    runtime_type: Option<String>,
    path_source: String,
}

fn infer_path_from_process_manager(payload: &VpsConnectionInput, project: &RemoteManagedProject) -> InferredPath {
    let unknown = |src: &str| InferredPath {
        project_path: None,
        service_name: None,
        runtime_type: None,
        path_source: src.into(),
    };
    let Some(port) = extract_listen_port(&project.proxy_target) else {
        return unknown("unknown");
    };

    let probe = format!(
        "for unit in $(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{{print $1}}'); do \
         if systemctl show -p WorkingDirectory \"$unit\" 2>/dev/null | grep -q WorkingDirectory=; then \
         cwd=$(systemctl show -p WorkingDirectory --value \"$unit\" 2>/dev/null); \
         if ss -ltnp 2>/dev/null | grep -q \":{port} \"; then echo \"$unit|$cwd\"; fi; \
         fi; done"
    );
    if let Ok(r) = run_remote_shell_command(payload, &probe, 8_000) {
        if r.code == 0 {
            if let Some(first) = r.stdout.lines().map(|l| l.trim()).find(|l| !l.is_empty()) {
                let mut parts = first.splitn(2, '|');
                let unit = parts.next().unwrap_or("").to_string();
                let cwd = parts.next().unwrap_or("").to_string();
                if !cwd.is_empty() {
                    return InferredPath {
                        project_path: Some(cwd),
                        service_name: Some(unit),
                        runtime_type: Some("node".into()),
                        path_source: "systemd".into(),
                    };
                }
            }
        }
    }

    if let Ok(r) = run_remote_shell_command(
        payload,
        "command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | head -c 4096 || true",
        5_000,
    ) {
        if r.code == 0 && !r.stdout.trim().is_empty() {
            if let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&r.stdout) {
                if let Some(matched) = list.iter().find(|e| {
                    e.get("pm2_env")
                        .and_then(|env| env.get("pm_cwd"))
                        .and_then(|v| v.as_str())
                        .is_some()
                }) {
                    return InferredPath {
                        project_path: matched
                            .get("pm2_env")
                            .and_then(|env| env.get("pm_cwd"))
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        service_name: matched.get("name").and_then(|v| v.as_str()).map(String::from),
                        runtime_type: Some("pm2".into()),
                        path_source: "pm2".into(),
                    };
                }
            }
        }
    }

    if let Ok(r) = run_remote_shell_command(
        payload,
        "command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}|{{.Ports}}|{{.Mounts}}' || true",
        5_000,
    ) {
        if r.code == 0 && !r.stdout.trim().is_empty() {
            if let Some(line) = r
                .stdout
                .lines()
                .map(|l| l.trim())
                .find(|row| row.contains(&format!(":{port}->")))
            {
                let mut parts = line.splitn(3, '|');
                let _ = parts.next();
                let _ = parts.next();
                if let Some(mounts_raw) = parts.next() {
                    let bind = mounts_raw.split(',').map(str::trim).find(|e| e.contains("bind"));
                    if let Some(bind) = bind {
                        let host = bind.split(':').next().unwrap_or("").to_string();
                        if !host.is_empty() {
                            return InferredPath {
                                project_path: Some(host),
                                service_name: None,
                                runtime_type: Some("docker".into()),
                                path_source: "docker".into(),
                            };
                        }
                    }
                }
            }
        }
    }

    if let Some(heuristic) = probe_heuristic_path(payload, project) {
        return InferredPath {
            project_path: Some(heuristic),
            service_name: None,
            runtime_type: None,
            path_source: "heuristic".into(),
        };
    }
    unknown("unknown")
}

fn read_nginx_files(payload: &VpsConnectionInput) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let cmd = format!(
        "for dir in {}; do if [ -d \"$dir\" ]; then find \"$dir\" -maxdepth 1 -type f \\( -name '*.conf' -o -name 'sites-*' \\) 2>/dev/null; fi; done",
        NGINX_CONFIG_PATHS.iter().map(|d| shell_quote(d)).collect::<Vec<_>>().join(" ")
    );
    let Ok(list) = run_remote_shell_command(payload, &cmd, 8_000) else {
        return result;
    };
    if list.code != 0 {
        return result;
    }
    for file in list.stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if let Ok(read) =
            run_remote_shell_command(payload, &format!("cat {} 2>/dev/null || true", shell_quote(file)), 5_000)
        {
            if read.code == 0 && !read.stdout.trim().is_empty() {
                result.insert(file.to_string(), read.stdout);
            }
        }
    }
    result
}

pub fn scan_remote_managed_projects(payload: &VpsConnectionInput) -> RemoteManagedProjectScanResult {
    let scanned_at = now_iso();
    let files = read_nginx_files(payload);
    let mut all = vec![];
    for (path, content) in &files {
        for mut project in parse_nginx_proxy_servers(path, content) {
            project.connection_id = payload.id.clone().unwrap_or_default();
            all.push(project);
        }
    }
    let mut enriched = vec![];
    for project in all {
        let inferred = infer_path_from_process_manager(payload, &project);
        let has_path = inferred.project_path.is_some();
        enriched.push(RemoteManagedProject {
            service_name: inferred.service_name,
            runtime_type: inferred.runtime_type,
            status: if has_path { "ok".into() } else { "unknown".into() },
            status_text: if has_path {
                format!("项目路径来源：{}", inferred.path_source)
            } else {
                "反向代理站点已识别，尚未推断项目目录".into()
            },
            project_path: inferred.project_path,
            path_source: inferred.path_source,
            ..project
        });
    }
    RemoteManagedProjectScanResult {
        connection_id: payload.id.clone().unwrap_or_default(),
        projects: enriched,
        scanned_at,
    }
}

// ---------- migration (project-migration) ----------

fn build_prepare_source_bundle_script(project_id: &str, remote_app_dir: &str, remote_service: Option<&str>) -> String {
    let remote_app_dir = remote_app_dir.trim_end_matches('/');
    let fallback_config = managed_nginx_config_path(&posix_basename(remote_app_dir));
    format!(
        r#"
set -Eeuo pipefail

PROJECT_ID={project_id}
REMOTE_APP_DIR={remote_app_dir}
REMOTE_SERVICE={remote_service}
PRIMARY_NGINX_CONF={primary_conf}
FALLBACK_NGINX_CONF={fallback_conf}
PRIMARY_CERT_DIR={primary_cert}
FALLBACK_CERT_DIR={fallback_cert}
TMP_ROOT="$(mktemp -d /tmp/digwis-panel-migrate-XXXXXX)"
APP_ARCHIVE="$TMP_ROOT/app.tar.gz"
SYSTEM_ARCHIVE="$TMP_ROOT/system.tar.gz"

[ -d "$REMOTE_APP_DIR" ] || {{ echo "源服务器项目目录不存在：$REMOTE_APP_DIR" >&2; exit 2; }}
sudo -n tar -C / -czf "$APP_ARCHIVE" "{remote_rel}"

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
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${{ACTIVE_NGINX_CONF#/}}"
  SITE_DOMAIN="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_DOMAIN=' '$ACTIVE_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
  SITE_SSL_MODE="$(sudo -n sh -c "grep '^# DIGWIS_PANEL_SSL_MODE=' '$ACTIVE_NGINX_CONF' 2>/dev/null | tail -n1 | cut -d= -f2-")"
fi

if sudo -n test -d "$PRIMARY_CERT_DIR"; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${{PRIMARY_CERT_DIR#/}}"
  echo "HAS_CUSTOM_CERT_DIR=1"
elif sudo -n test -d "$FALLBACK_CERT_DIR"; then
  SYSTEM_ITEMS="$SYSTEM_ITEMS ${{FALLBACK_CERT_DIR#/}}"
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
"#,
        project_id = shell_single_quote(project_id),
        remote_app_dir = shell_single_quote(remote_app_dir),
        remote_service = shell_single_quote(remote_service.unwrap_or("")),
        primary_conf = shell_single_quote(&managed_nginx_config_path(project_id)),
        fallback_conf = shell_single_quote(&fallback_config),
        primary_cert = shell_single_quote(&format!("/etc/ssl/digwis-panel/{project_id}")),
        fallback_cert = shell_single_quote(&format!("/etc/ssl/digwis-panel/{}", posix_basename(remote_app_dir))),
        remote_rel = remote_app_dir.trim_start_matches('/'),
    )
}

fn build_ensure_packages_script(packages: &[String]) -> String {
    let mut seen = HashSet::new();
    let list: Vec<String> = packages
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && seen.insert(p.clone()))
        .collect();
    if list.is_empty() {
        return "echo \"DIGWIS_DEPS_OK=1\"".to_string();
    }
    let joined = list.iter().map(|p| shell_single_quote(p)).collect::<Vec<_>>().join(" ");
    format!(
        r#"
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
    sudo -n apt-get install -y {joined}
    ;;
  dnf)
    sudo -n dnf install -y {joined}
    ;;
  yum)
    sudo -n yum install -y {joined}
    ;;
  apk)
    sudo -n apk add --no-cache {joined}
    ;;
  pacman)
    sudo -n pacman -Sy --noconfirm {joined}
    ;;
  *)
    echo "无法识别目标服务器包管理器" >&2
    exit 3
    ;;
esac
echo "DIGWIS_DEPS_OK=1"
"#
    )
}

fn build_apply_bundle_script(
    project_id: &str,
    remote_app_dir: &str,
    remote_service: Option<&str>,
    target_tmp_dir: &str,
) -> String {
    format!(
        r#"
set -Eeuo pipefail

PROJECT_ID={project_id}
REMOTE_APP_DIR={remote_app_dir}
REMOTE_SERVICE={remote_service}
TARGET_TMP_DIR={tmp_dir}
APP_ARCHIVE="$TARGET_TMP_DIR/app.tar.gz"
SYSTEM_ARCHIVE="$TARGET_TMP_DIR/system.tar.gz"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -f "$APP_ARCHIVE" ] || {{ echo "迁移包缺少 app.tar.gz" >&2; exit 2; }}
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
"#,
        project_id = shell_single_quote(project_id),
        remote_app_dir = shell_single_quote(remote_app_dir.trim_end_matches('/')),
        remote_service = shell_single_quote(remote_service.unwrap_or("")),
        tmp_dir = shell_single_quote(target_tmp_dir),
    )
}

fn build_disable_source_script(project_id: &str, remote_app_dir: &str, remote_service: Option<&str>) -> String {
    let remote_app_dir = remote_app_dir.trim_end_matches('/');
    let fallback = managed_nginx_config_path(&posix_basename(remote_app_dir));
    format!(
        r#"
set -Eeuo pipefail

REMOTE_SERVICE={remote_service}
PRIMARY_NGINX_CONF={primary}
FALLBACK_NGINX_CONF={fallback}
REMOTE_APP_DIR={remote_app_dir}
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
"#,
        remote_service = shell_single_quote(remote_service.unwrap_or("")),
        primary = shell_single_quote(&managed_nginx_config_path(project_id)),
        fallback = shell_single_quote(&fallback),
        remote_app_dir = shell_single_quote(remote_app_dir),
    )
}

fn remove_remote_path(connection: &VpsConnectionInput, remote_path: &str) {
    let _ = run_remote_shell_command(
        connection,
        &format!("rm -rf {}", shell_single_quote(remote_path)),
        120_000,
    );
}

pub fn migrate_project_between_servers(
    project_id: &str,
    config: Option<&ProjectPanelDeployConfig>,
    source_connection: &VpsConnectionInput,
    target_connection: &VpsConnectionInput,
    remote_app_dir: &str,
) -> ProjectMigrationResult {
    let started = std::time::Instant::now();
    let remote_service = config
        .and_then(|c| c.deploy.as_ref())
        .and_then(|d| d.remote_service.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let backup_packages = config
        .and_then(|c| c.init.as_ref())
        .and_then(|i| i.remote_packages.clone())
        .unwrap_or_default();
    let temp_root = std::env::temp_dir().join(format!("digwis-panel-migrate-{}", random_uuid()));
    let _ = std::fs::create_dir_all(&temp_root);
    let local_app_archive = temp_root.join("app.tar.gz");
    let local_system_archive = temp_root.join("system.tar.gz");
    let mut source_bundle_dir = String::new();
    let target_tmp_dir = format!(
        "/tmp/digwis-panel-migrate-{}-{}",
        project_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let fail = |message: String| ProjectMigrationResult {
        ok: false,
        duration_ms: started.elapsed().as_millis() as u64,
        target_connection_id: Some(target_connection.id.clone().unwrap_or_default()),
        target_remote_path: Some(remote_app_dir.to_string()),
        source_disabled: false,
        message,
    };

    let mut run = || -> Result<ProjectMigrationResult, String> {
        let prepared = run_remote_shell_command(
            source_connection,
            &build_prepare_source_bundle_script(project_id, remote_app_dir, remote_service.as_deref()),
            30 * 60 * 1000,
        )
        .map_err(|e| e)?;
        let prepared_out = format!("{}\n{}", prepared.stdout, prepared.stderr);
        if prepared.code != 0 || !prepared_out.contains("DIGWIS_PREPARE_BUNDLE_OK=1") {
            return Err(if tail_text(&prepared_out, 1800).is_empty() {
                "源服务器迁移打包失败".into()
            } else {
                tail_text(&prepared_out, 1800)
            });
        }

        source_bundle_dir = parse_marker(&prepared_out, "BUNDLE_DIR");
        let source_app_archive = parse_marker(&prepared_out, "APP_ARCHIVE");
        let source_system_archive = parse_marker(&prepared_out, "SYSTEM_ARCHIVE");
        let site_domain = parse_marker(&prepared_out, "SITE_DOMAIN");
        let site_ssl_mode = parse_marker(&prepared_out, "SITE_SSL_MODE");

        let mut required = backup_packages.clone();
        if !site_domain.is_empty() {
            required.push("nginx".into());
            if site_ssl_mode == "letsencrypt" {
                required.push("certbot".into());
            }
        }

        let ensure = run_remote_shell_command(
            target_connection,
            &build_ensure_packages_script(&required),
            30 * 60 * 1000,
        )
        .map_err(|e| e)?;
        let ensure_out = format!("{}\n{}", ensure.stdout, ensure.stderr);
        if ensure.code != 0 || !ensure_out.contains("DIGWIS_DEPS_OK=1") {
            return Err(if tail_text(&ensure_out, 1800).is_empty() {
                "目标服务器依赖检查失败".into()
            } else {
                tail_text(&ensure_out, 1800)
            });
        }

        // download archives from source
        {
            let session = ssh::connect(source_connection, 20_000).map_err(|e| e)?;
            let sftp = session.sftp().map_err(|e| e)?;
            crate::remote_files::sftp_download_file(&sftp, &source_app_archive, &local_app_archive)
                .map_err(|e| e)?;
            if !source_system_archive.is_empty() {
                crate::remote_files::sftp_download_file(&sftp, &source_system_archive, &local_system_archive)
                    .map_err(|e| e)?;
            }
        }

        // upload to target
        {
            let session = ssh::connect(target_connection, 20_000).map_err(|e| e)?;
            let sftp = session.sftp().map_err(|e| e)?;
            let _ = sftp.mkdir(Path::new(&target_tmp_dir), 0o755);
            crate::remote_files::sftp_upload_file(
                &sftp,
                &local_app_archive,
                &format!("{target_tmp_dir}/app.tar.gz"),
            )
            .map_err(|e| e)?;
            let has_system = std::fs::metadata(&local_system_archive).map(|m| m.len() > 0).unwrap_or(false);
            if has_system {
                crate::remote_files::sftp_upload_file(
                    &sftp,
                    &local_system_archive,
                    &format!("{target_tmp_dir}/system.tar.gz"),
                )
                .map_err(|e| e)?;
            } else {
                let empty = temp_root.join("empty.bin");
                std::fs::write(&empty, b"").map_err(|e| e.to_string())?;
                crate::remote_files::sftp_upload_file(
                    &sftp,
                    &empty,
                    &format!("{target_tmp_dir}/system.tar.gz"),
                )
                .map_err(|e| e)?;
            }
        }

        let applied = run_remote_shell_command(
            target_connection,
            &build_apply_bundle_script(project_id, remote_app_dir, remote_service.as_deref(), &target_tmp_dir),
            30 * 60 * 1000,
        )
        .map_err(|e| e)?;
        let applied_out = format!("{}\n{}", applied.stdout, applied.stderr);
        if applied.code != 0 || !applied_out.contains("DIGWIS_APPLY_BUNDLE_OK=1") {
            return Err(if tail_text(&applied_out, 1800).is_empty() {
                "目标服务器迁移落地失败".into()
            } else {
                tail_text(&applied_out, 1800)
            });
        }

        let disabled = run_remote_shell_command(
            source_connection,
            &build_disable_source_script(project_id, remote_app_dir, remote_service.as_deref()),
            10 * 60 * 1000,
        )
        .map_err(|e| e)?;
        let disabled_out = format!("{}\n{}", disabled.stdout, disabled.stderr);
        let source_disabled = disabled.code == 0 && disabled_out.contains("DIGWIS_SOURCE_DISABLED=1");

        Ok(ProjectMigrationResult {
            ok: true,
            duration_ms: started.elapsed().as_millis() as u64,
            target_connection_id: Some(target_connection.id.clone().unwrap_or_default()),
            target_remote_path: Some(remote_app_dir.to_string()),
            source_disabled,
            message: format!(
                "项目已迁移到 {}，目标目录 {}。{}",
                target_connection.name,
                remote_app_dir,
                if source_disabled {
                    "源服务器服务与入口已停用。"
                } else {
                    "目标已完成，但源服务器停用步骤需要手动确认。"
                }
            ),
        })
    };

    let result = match run() {
        Ok(r) => r,
        Err(e) => fail(e),
    };

    if !source_bundle_dir.is_empty() {
        remove_remote_path(source_connection, &source_bundle_dir);
    }
    remove_remote_path(target_connection, &target_tmp_dir);
    let _ = std::fs::remove_dir_all(&temp_root);
    result
}
