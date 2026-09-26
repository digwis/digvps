//! Local-side project services: npm scripts, local runtime state, deploy profile,
//! operation log, action state/hints, DB marker, native-module repair, local preview.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::error::{internal_error, AppResult};
use crate::models::*;
use crate::util::{env_with_extra_path, now_iso, random_uuid};

const SCRIPT_TIMEOUT_MS: u64 = 45 * 60 * 1000;

fn bash_single_quoted(p: &str) -> String {
    crate::util::shell_single_quote(p)
}

// ---------- package.json scripts (project-local-npm) ----------

pub fn read_package_json_script_names(project_root: &str) -> Vec<String> {
    let pkg_path = Path::new(project_root).join("package.json");
    let Ok(raw) = fs::read_to_string(&pkg_path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(scripts) = parsed.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = scripts.keys().cloned().collect();
    names.sort();
    names
}

/// runLocalNpmScript — executes `npm run <script>` via login shell, streaming output.
pub fn run_local_npm_script(
    project_root: &str,
    script_name: &str,
    env: Option<&HashMap<String, String>>,
    timeout_ms: Option<u64>,
    on_output: Option<std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>>,
) -> ProjectDeployResult {
    let start = std::time::Instant::now();
    let names = read_package_json_script_names(project_root);
    if !names.iter().any(|n| n == script_name) {
        return ProjectDeployResult {
            ok: false,
            message: format!("package.json 中不存在脚本：{script_name}"),
            remote_path: None,
            duration_ms: 0,
            kind: Some("local-npm-script".into()),
        };
    }

    let mut child_env = env_with_extra_path();
    if let Some(extra) = env {
        for (k, v) in extra {
            child_env.insert(k.clone(), v.clone());
        }
    }

    let abs_root = fs::canonicalize(project_root).unwrap_or_else(|_| PathBuf::from(project_root));
    let shell_cmd = format!(
        "cd {} && npm run {}",
        bash_single_quoted(&abs_root.to_string_lossy()),
        bash_single_quoted(script_name)
    );

    let spawn_result = if cfg!(windows) {
        Command::new("npm.cmd")
            .args(["run", script_name])
            .current_dir(project_root)
            .envs(&child_env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        Command::new("/bin/bash")
            .args(["-lc", &shell_cmd])
            .envs(&child_env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            return ProjectDeployResult {
                ok: false,
                message: e.to_string(),
                remote_path: None,
                duration_ms: start.elapsed().as_millis() as u64,
                kind: Some("local-npm-script".into()),
            }
        }
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let combined = std::sync::Arc::new(Mutex::new(String::new()));
    let mut handles = Vec::new();
    for (pipe, stream_name) in [
        (stdout_pipe.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), "stdout"),
        (stderr_pipe.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), "stderr"),
    ] {
        if let Some(mut p) = pipe {
            let combined = std::sync::Arc::clone(&combined);
            let sn = stream_name.to_string();
            let on_output = on_output.clone();
            handles.push(std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 8192];
                while let Ok(n) = p.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    {
                        let mut c = combined.lock().unwrap();
                        c.push_str(&text);
                        if c.len() > 32_000 {
                            let keep = c.len() - 24_000;
                            *c = c[keep..].to_string();
                        }
                    }
                    if let Some(ref cb) = on_output {
                        cb(&text, &sn);
                    }
                }
            }));
        }
    }

    let timeout = timeout_ms.unwrap_or(SCRIPT_TIMEOUT_MS);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => break None,
        }
    };
    for h in handles {
        let _ = h.join();
    }

    let combined = combined.lock().unwrap().clone();
    let tail = combined.trim();
    let detail = if tail.len() > 900 {
        format!("…{}", &tail[tail.len() - 900..])
    } else {
        tail.to_string()
    };
    let duration_ms = start.elapsed().as_millis() as u64;

    match status {
        None => ProjectDeployResult {
            ok: false,
            message: format!("脚本执行超时（{} 分钟）", timeout / 60000),
            remote_path: None,
            duration_ms,
            kind: Some("local-npm-script".into()),
        },
        Some(s) if s.success() => ProjectDeployResult {
            ok: true,
            message: if detail.is_empty() {
                format!("本地脚本「{script_name}」已完成。")
            } else {
                format!("本地脚本「{script_name}」已完成。\n{detail}")
            },
            remote_path: None,
            duration_ms,
            kind: Some("local-npm-script".into()),
        },
        Some(s) => ProjectDeployResult {
            ok: false,
            message: format!(
                "本地脚本「{script_name}」失败（退出码 {}）{}",
                s.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()),
                if detail.is_empty() { String::new() } else { format!("：{detail}") }
            ),
            remote_path: None,
            duration_ms,
            kind: Some("local-npm-script".into()),
        },
    }
}

// ---------- deploy profile (project-deploy-profile) ----------

const DEPLOY_CONFIG_FILENAMES: &[&str] = &[
    "openvps.deploy.json",
    ".openvps.deploy.json",
    "digwis-panel.deploy.json",
    ".digwis-panel.deploy.json",
];

struct ResolvedDeployConfig {
    path: Option<String>,
    config: Option<ProjectPanelDeployConfig>,
    error: Option<String>,
}

fn read_deploy_config(project_root: &str) -> ResolvedDeployConfig {
    for filename in DEPLOY_CONFIG_FILENAMES {
        let full = Path::new(project_root).join(filename);
        if !full.exists() {
            continue;
        }
        match fs::read_to_string(&full)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            Some(parsed) => {
                let version = parsed.get("version").and_then(|v| v.as_u64());
                if version != Some(1) {
                    return ResolvedDeployConfig {
                        path: Some(full.to_string_lossy().into()),
                        config: None,
                        error: Some(format!(
                            "部署配置 version 仅支持 1，当前为 {}",
                            version.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into())
                        )),
                    };
                }
                let config = serde_json::from_value::<ProjectPanelDeployConfig>(parsed).ok();
                return ResolvedDeployConfig {
                    path: Some(full.to_string_lossy().into()),
                    config,
                    error: None,
                };
            }
            None => {
                return ResolvedDeployConfig {
                    path: Some(full.to_string_lossy().into()),
                    config: None,
                    error: Some("部署配置解析失败".into()),
                };
            }
        }
    }
    ResolvedDeployConfig { path: None, config: None, error: None }
}

pub fn read_project_deploy_config(project_root: &str) -> Option<ProjectPanelDeployConfig> {
    read_deploy_config(project_root).config
}

pub fn read_project_deploy_profile(project_root: &str) -> ProjectDeployProfile {
    let npm_scripts = read_package_json_script_names(project_root);
    let result = read_deploy_config(project_root);
    let deploy = result.config.as_ref().and_then(|c| c.deploy.as_ref());
    let configured = deploy.and_then(|d| d.script.as_ref()).map(|s| s.trim().to_string());
    let recommended_npm_script = configured
        .filter(|s| npm_scripts.contains(s))
        .or_else(|| {
            if npm_scripts.iter().any(|s| s == "deploy:panel") {
                Some("deploy:panel".to_string())
            } else if npm_scripts.iter().any(|s| s == "deploy:vps:code") {
                Some("deploy:vps:code".to_string())
            } else {
                npm_scripts.first().cloned()
            }
        });

    let strategy = deploy.and_then(|d| d.strategy.as_deref());
    let recommended_strategy = if strategy == Some("sftp") || strategy == Some("local-npm-script") {
        strategy.unwrap().to_string()
    } else if recommended_npm_script.is_some() {
        "local-npm-script".to_string()
    } else {
        "sftp".to_string()
    };

    ProjectDeployProfile {
        npm_scripts,
        recommended_strategy,
        recommended_npm_script,
        can_initialize: result.config.as_ref().and_then(|c| c.init.as_ref()).is_some(),
        config_path: result.path,
        config_error: result.error,
        default_remote_app_dir: deploy
            .and_then(|d| d.remote_app_dir.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        default_remote_service: deploy
            .and_then(|d| d.remote_service.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        default_public_check_url: deploy
            .and_then(|d| d.public_check_url.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    }
}

// ---------- local runtime state (project-local-runtime) ----------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocalRuntimeState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    pub updated_at: String,
}

fn runtime_file_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".digwis-panel").join("local-runtime.json")
}

pub fn read_project_local_runtime(project_path: &str) -> Option<ProjectLocalRuntimeState> {
    let p = runtime_file_path(project_path);
    fs::read_to_string(p)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

pub fn write_project_local_runtime(
    project_path: &str,
    preview_url: Option<String>,
    admin_url: Option<String>,
    pid: Option<u32>,
    log_path: Option<String>,
) -> std::io::Result<ProjectLocalRuntimeState> {
    let p = runtime_file_path(project_path);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let state = ProjectLocalRuntimeState {
        preview_url,
        admin_url,
        pid,
        log_path,
        updated_at: now_iso(),
    };
    fs::write(&p, serde_json::to_string_pretty(&state)? + "\n")?;
    Ok(state)
}

// ---------- operation log (project-operation-log) ----------

const MAX_LOG_LINES: usize = 5000;
const DEFAULT_LIST_LIMIT: usize = 300;

static OP_LOG: OnceLock<Mutex<OpLogState>> = OnceLock::new();

struct OpLogState {
    path: PathBuf,
    line_count: usize,
}

fn op_log() -> std::sync::MutexGuard<'static, OpLogState> {
    OP_LOG
        .get_or_init(|| {
            let path = crate::util::user_data_dir().join("project-operation-log.ndjson");
            let _ = crate::util::ensure_dir(path.parent().unwrap());
            if !path.exists() {
                let _ = fs::write(&path, "");
            }
            let line_count = fs::read_to_string(&path)
                .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count())
                .unwrap_or(0);
            Mutex::new(OpLogState { path, line_count })
        })
        .lock()
        .unwrap()
}

fn parse_log_lines(raw: &str) -> Vec<ProjectOperationLogEntry> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<ProjectOperationLogEntry>(l).ok())
        .filter(|e| !e.id.is_empty() && !e.project_id.is_empty())
        .collect()
}

fn read_all_logs(path: &Path) -> Vec<ProjectOperationLogEntry> {
    fs::read_to_string(path).map(|raw| parse_log_lines(&raw)).unwrap_or_default()
}

pub fn append_operation_log(
    project_id: &str,
    stream: &str,
    chunk: &str,
    at: Option<String>,
) -> AppResult<ProjectOperationLogEntry> {
    let entry = ProjectOperationLogEntry {
        id: random_uuid(),
        project_id: project_id.to_string(),
        stream: stream.to_string(),
        chunk: chunk.to_string(),
        at: at.unwrap_or_else(now_iso),
    };

    let mut state = op_log();
    if state.line_count < MAX_LOG_LINES {
        let line = serde_json::to_string(&entry).map_err(|e| internal_error(e.to_string()))?;
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&state.path)
            .map_err(|e| internal_error(e.to_string()))?;
        if state.line_count > 0 {
            f.write_all(b"\n").map_err(|e| internal_error(e.to_string()))?;
        }
        f.write_all(line.as_bytes()).map_err(|e| internal_error(e.to_string()))?;
        state.line_count += 1;
        return Ok(entry);
    }

    let mut all = read_all_logs(&state.path);
    all.push(entry.clone());
    let keep = all.len().saturating_sub(MAX_LOG_LINES);
    let trimmed: Vec<_> = all.into_iter().skip(keep).collect();
    let content = trimmed
        .iter()
        .filter_map(|e| serde_json::to_string(e).ok())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&state.path, if content.is_empty() { String::new() } else { format!("{content}\n") })
        .map_err(|e| internal_error(e.to_string()))?;
    state.line_count = trimmed.len();
    Ok(entry)
}

pub fn list_operation_logs(limit: Option<u32>) -> Vec<ProjectOperationLogEntry> {
    let limit = (limit.unwrap_or(DEFAULT_LIST_LIMIT as u32) as usize).clamp(1, 2000);
    let state = op_log();
    let all = read_all_logs(&state.path);
    let keep = all.len().saturating_sub(limit);
    all.into_iter().skip(keep).collect()
}

// ---------- action state (project-action-state) ----------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum ActionEntry {
    Plain(String),
    Full { at: String, marker: Option<String> },
}

impl ActionEntry {
    fn at(&self) -> &str {
        match self {
            ActionEntry::Plain(s) => s,
            ActionEntry::Full { at, .. } => at,
        }
    }
    fn marker(&self) -> Option<&str> {
        match self {
            ActionEntry::Full { marker, .. } => marker.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct StoredProjectState {
    #[serde(default)]
    actions: HashMap<String, ActionEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredActionState {
    version: u32,
    #[serde(default)]
    projects: HashMap<String, StoredProjectState>,
}

static ACTION_STATE: OnceLock<Mutex<StoredActionState>> = OnceLock::new();

fn action_state_path() -> PathBuf {
    crate::util::user_data_dir().join("project-action-state.json")
}

fn action_state() -> std::sync::MutexGuard<'static, StoredActionState> {
    ACTION_STATE
        .get_or_init(|| {
            let path = action_state_path();
            let state = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<StoredActionState>(&raw).ok())
                .filter(|s| s.version == 1)
                .unwrap_or(StoredActionState { version: 1, projects: HashMap::new() });
            Mutex::new(state)
        })
        .lock()
        .unwrap()
}

fn save_action_state(state: &StoredActionState) {
    let path = action_state_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, serde_json::to_string_pretty(state).unwrap_or_default());
}

pub fn get_project_action_run_at(project_id: &str, action: &str) -> Option<String> {
    let state = action_state();
    state
        .projects
        .get(project_id)
        .and_then(|p| p.actions.get(action))
        .map(|e| e.at().to_string())
}

pub fn get_project_action_marker(project_id: &str, action: &str) -> Option<String> {
    let state = action_state();
    state
        .projects
        .get(project_id)
        .and_then(|p| p.actions.get(action))
        .and_then(|e| e.marker().map(|m| m.to_string()))
}

pub fn mark_project_action_run(project_id: &str, action: &str, marker: Option<String>) {
    let mut state = action_state();
    let entry = state.projects.entry(project_id.to_string()).or_default();
    entry.actions.insert(
        action.to_string(),
        ActionEntry::Full { at: now_iso(), marker },
    );
    save_action_state(&state);
}

// ---------- local postgres LSN (project-db-marker) ----------

fn expand_env_template(value: &str, env: &HashMap<String, String>) -> String {
    let re = regex::Regex::new(r"\$\{([A-Z0-9_]+)(:-([^}]*))?\}").unwrap();
    re.replace_all(value, |caps: &regex::Captures| {
        let key = &caps[1];
        match env.get(key) {
            Some(v) if !v.is_empty() => v.clone(),
            _ => caps.get(3).map(|m| m.as_str().to_string()).unwrap_or_default(),
        }
    })
    .to_string()
}

fn resolve_local_db_url(project_path: &str) -> String {
    let config = read_project_deploy_config(project_path);
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if let Some(cfg_env) = config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.env.as_ref()) {
        for (k, v) in cfg_env {
            env.insert(k.clone(), v.clone());
        }
    }
    let cfg_env = config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.env.as_ref());
    let raw = cfg_env
        .and_then(|e| e.get("LOCAL_DB_URL").or_else(|| e.get("DATABASE_URL")))
        .cloned()
        .or_else(|| env.get("LOCAL_DB_URL").cloned())
        .or_else(|| env.get("DATABASE_URL").cloned())
        .unwrap_or_else(|| "postgresql://postgres@127.0.0.1:${PGPORT:-5432}/digwis".to_string());
    expand_env_template(&raw, &env)
}

pub fn read_local_postgres_lsn(project_path: &str) -> Option<String> {
    let db_url = resolve_local_db_url(project_path);
    let output = Command::new("psql")
        .args([db_url.as_str(), "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_current_wal_lsn()::text;"])
        .current_dir(project_path)
        .envs(env_with_extra_path())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let marker = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if marker.is_empty() { None } else { Some(marker) }
}

// ---------- action hints (project-action-hints) ----------

fn code_exclude_dirs() -> HashSet<&'static str> {
    [
        ".git", "node_modules", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage",
        "uploads", "data",
    ]
    .into_iter()
    .collect()
}

struct DirSnapshot {
    latest_iso: Option<String>,
    has_files: bool,
}

fn get_git_dirty_snapshot(project_path: &str) -> Option<DirSnapshot> {
    let inside = Command::new("git")
        .args(["-C", project_path, "rev-parse", "--is-inside-work-tree"])
        .envs(env_with_extra_path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !inside.success() {
        return None;
    }
    let output = Command::new("git")
        .args(["-C", project_path, "status", "--porcelain", "--untracked-files=normal"])
        .envs(env_with_extra_path())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        Some(DirSnapshot { latest_iso: None, has_files: false })
    } else {
        Some(DirSnapshot { latest_iso: Some(now_iso()), has_files: true })
    }
}

fn scan_dir_latest(dir: &Path, exclude: &HashSet<&str>, after_ms: Option<u128>) -> DirSnapshot {
    if !dir.exists() {
        return DirSnapshot { latest_iso: None, has_files: false };
    }
    let mut latest_ms: u128 = 0;
    let mut has_files = false;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name();
            let full = entry.path();
            if ft.is_dir() {
                if !exclude.contains(name.to_string_lossy().as_ref()) {
                    stack.push(full);
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            has_files = true;
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            if ms > latest_ms {
                latest_ms = ms;
            }
            if let Some(after) = after_ms {
                if ms > after {
                    return DirSnapshot {
                        latest_iso: Some(ts_ms_iso(ms)),
                        has_files,
                    };
                }
            }
        }
    }
    DirSnapshot {
        latest_iso: if latest_ms > 0 { Some(ts_ms_iso(latest_ms)) } else { None },
        has_files,
    }
}

fn ts_ms_iso(ms: u128) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
}

fn build_hint(
    action: &str,
    run_at: Option<String>,
    local: &DirSnapshot,
    missing_reason: &str,
    changed_reason: &str,
) -> ProjectActionHint {
    if !local.has_files {
        return ProjectActionHint {
            action: action.into(),
            needs_attention: false,
            reason: missing_reason.into(),
            last_run_at: run_at,
            local_changed_at: local.latest_iso.clone(),
        };
    }
    let Some(ref at) = run_at else {
        return ProjectActionHint {
            action: action.into(),
            needs_attention: true,
            reason: "尚未执行过".into(),
            last_run_at: None,
            local_changed_at: local.latest_iso.clone(),
        };
    };
    if let Some(ref latest) = local.latest_iso {
        let changed = chrono::DateTime::parse_from_rfc3339(latest)
            .ok()
            .zip(chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|(l, r)| l > r)
            .unwrap_or_else(|| latest.as_str() > at.as_str());
        if changed {
            return ProjectActionHint {
                action: action.into(),
                needs_attention: true,
                reason: changed_reason.into(),
                last_run_at: run_at,
                local_changed_at: local.latest_iso.clone(),
            };
        }
    }
    ProjectActionHint {
        action: action.into(),
        needs_attention: false,
        reason: "已是最新".into(),
        last_run_at: run_at,
        local_changed_at: local.latest_iso.clone(),
    }
}

pub fn inspect_project_action_hints(project: &LocalProjectRecord) -> ProjectActionHints {
    let code_run_at = get_project_action_run_at(&project.id, "code");
    let data_run_at = get_project_action_run_at(&project.id, "data");
    let data_marker = get_project_action_marker(&project.id, "data");
    let uploads_run_at = get_project_action_run_at(&project.id, "uploads");

    let code_local = get_git_dirty_snapshot(&project.local_path)
        .unwrap_or_else(|| scan_dir_latest(Path::new(&project.local_path), &code_exclude_dirs(), None));
    let current_lsn = read_local_postgres_lsn(&project.local_path);
    let uploads_dir = {
        let storage = Path::new(&project.local_path).join("storage").join("uploads");
        if storage.exists() {
            storage
        } else {
            Path::new(&project.local_path).join("uploads")
        }
    };
    let uploads_local = scan_dir_latest(&uploads_dir, &HashSet::new(), None);

    let data_needs = !data_run_at.is_some()
        || if current_lsn.is_some() && data_marker.is_some() {
            current_lsn != data_marker
        } else {
            false
        };
    let data_reason = if data_run_at.is_none() {
        "尚未执行过"
    } else if current_lsn.is_none() {
        "无法读取本地 PG 变更状态"
    } else if data_marker.is_none() {
        "缺少上次数据同步标记"
    } else if current_lsn != data_marker {
        "检测到本地 PG 数据有新增或修改"
    } else {
        "已是最新"
    };

    ProjectActionHints {
        project_id: project.id.clone(),
        checked_at: now_iso(),
        hints: vec![
            build_hint("code", code_run_at, &code_local, "未检测到本地代码变更", "检测到本地代码更新"),
            ProjectActionHint {
                action: "data".into(),
                needs_attention: data_needs,
                reason: data_reason.into(),
                last_run_at: data_run_at,
                local_changed_at: None,
            },
            build_hint(
                "uploads",
                uploads_run_at,
                &uploads_local,
                "未检测到上传文件目录",
                "检测到上传文件有新增或修改",
            ),
        ],
    }
}

// ---------- native module repair (project-native-module-fix, macOS only) ----------

const NATIVE_MODULE_PATTERNS: &[(&str, &str)] = &[
    (
        "@next+swc-darwin-arm64@",
        "node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node",
    ),
    (
        "@img+sharp-darwin-arm64@",
        "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
    ),
    (
        "@napi-rs+snappy-darwin-arm64@",
        "node_modules/@napi-rs/snappy-darwin-arm64/snappy.darwin-arm64.node",
    ),
];

fn sign_native_binary(binary: &Path) -> bool {
    let _ = Command::new("/usr/bin/xattr").args(["-cr"]).arg(binary).status();
    let _ = Command::new("/usr/bin/codesign")
        .args(["--remove-signature"])
        .arg(binary)
        .status();
    Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(binary)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn collect_native_binaries(root: &Path, repaired: &mut HashSet<String>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let full = entry.path();
            if ft.is_dir() {
                if entry.file_name() != ".bin" {
                    stack.push(full);
                }
            } else if ft.is_file() && entry.file_name().to_string_lossy().ends_with(".node") {
                if sign_native_binary(&full) {
                    repaired.insert(full.to_string_lossy().into());
                }
            }
        }
    }
}

pub fn repair_project_native_modules(project_path: &str) -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let pnpm_dir = Path::new(project_path).join("node_modules").join(".pnpm");
    if !pnpm_dir.exists() {
        return Vec::new();
    }
    let mut repaired = HashSet::new();
    let Ok(entries) = fs::read_dir(&pnpm_dir) else {
        return Vec::new();
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    for (prefix, rel) in NATIVE_MODULE_PATTERNS {
        for name in &names {
            if !name.starts_with(prefix) {
                continue;
            }
            let binary = pnpm_dir.join(name).join(rel);
            if binary.exists() && sign_native_binary(&binary) {
                repaired.insert(binary.to_string_lossy().into());
            }
        }
    }
    for name in &names {
        let nm_dir = pnpm_dir.join(name).join("node_modules");
        if nm_dir.exists() {
            collect_native_binaries(&nm_dir, &mut repaired);
        }
    }
    repaired.into_iter().collect()
}

// ---------- local preview / dev server orchestration (register-project-handlers helpers) ----------

#[derive(Debug, serde::Deserialize)]
struct RootPackageJson {
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
    scripts: Option<HashMap<String, String>>,
    dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: Option<HashMap<String, String>>,
}

fn read_root_package_json(project_path: &str) -> Option<RootPackageJson> {
    let raw = fs::read_to_string(Path::new(project_path).join("package.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn parse_local_port_from_scripts(pkg: Option<&RootPackageJson>) -> Option<u16> {
    let re = regex::Regex::new(r"--port(?:=|\s+)(\d{2,5})").unwrap();
    for script in [
        pkg.and_then(|p| p.scripts.as_ref()).and_then(|s| s.get("dev")),
        pkg.and_then(|p| p.scripts.as_ref()).and_then(|s| s.get("dev:webpack")),
        pkg.and_then(|p| p.scripts.as_ref()).and_then(|s| s.get("start")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(caps) = re.captures(script) {
            if let Ok(port) = caps[1].parse::<u16>() {
                return Some(port);
            }
        }
    }
    None
}

fn infer_local_preview_fallback(project_path: &str) -> ProjectLocalPreview {
    let pkg = read_root_package_json(project_path);
    let has_next_layout = ["src/app", "app", "src/pages", "pages"]
        .iter()
        .any(|p| Path::new(project_path).join(p).exists());
    let uses_next = pkg
        .as_ref()
        .map(|p| {
            p.dependencies.as_ref().map(|d| d.contains_key("next")).unwrap_or(false)
                || p.dev_dependencies.as_ref().map(|d| d.contains_key("next")).unwrap_or(false)
        })
        .unwrap_or(false);
    let web_path = if has_next_layout || uses_next {
        project_path.to_string()
    } else {
        Path::new(project_path).join("apps").join("web").to_string_lossy().to_string()
    };
    let port = parse_local_port_from_scripts(pkg.as_ref()).unwrap_or(3000);
    ProjectLocalPreview {
        url: format!("http://localhost:{port}"),
        web_path,
        admin_url: Some(format!("http://localhost:{port}/admin")),
    }
}

/// resolveProjectLocalPreview — digwis-project.json contract + runtime state + fallback.
pub fn resolve_project_local_preview(project_path: &str) -> ProjectLocalPreview {
    let fallback = infer_local_preview_fallback(project_path);
    let contract_path = Path::new(project_path).join("digwis-project.json");
    if !contract_path.exists() {
        return fallback;
    }
    let Ok(parsed) = fs::read_to_string(&contract_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DigwisProjectConfig>(&raw).ok())
        .ok_or(())
    else {
        return fallback;
    };
    let runtime = read_project_local_runtime(project_path);
    let preview_url = if parsed.panel.preview_url.trim().is_empty() {
        fallback.url.clone()
    } else {
        parsed.panel.preview_url.clone()
    };
    let web_path = if !parsed.apps.web.path.is_empty() {
        Path::new(project_path).join(&parsed.apps.web.path).to_string_lossy().to_string()
    } else {
        fallback.web_path.clone()
    };
    let contract_admin = {
        let base = runtime
            .as_ref()
            .and_then(|r| r.admin_url.clone())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| Some(parsed.panel.admin_url.clone()).filter(|s| !s.trim().is_empty()))
            .or(fallback.admin_url.clone());
        base.map(|u| resolve_admin_url_from_preview(&runtime.as_ref().and_then(|r| r.preview_url.clone()).unwrap_or_else(|| preview_url.clone()), Some(&u)))
    };
    ProjectLocalPreview {
        url: runtime
            .as_ref()
            .and_then(|r| r.preview_url.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(preview_url),
        web_path,
        admin_url: contract_admin,
    }
}

pub fn resolve_admin_url_from_preview(preview_url: &str, fallback_admin_url: Option<&str>) -> String {
    let Some(fallback) = fallback_admin_url else {
        return format!("{}/admin", preview_url.trim_end_matches('/'));
    };
    if fallback.is_empty() {
        return format!("{}/admin", preview_url.trim_end_matches('/'));
    }
    match (url::Url::parse(preview_url), url::Url::parse(fallback)) {
        (Ok(preview), Ok(mut admin)) => {
            if admin.port().map(|p| p == 8055).unwrap_or(false) || fallback.contains(":8055") {
                return fallback.to_string();
            }
            let _ = admin.set_scheme(preview.scheme());
            let _ = admin.set_host(preview.host_str());
            let _ = admin.set_port(preview.port());
            admin.to_string().trim_end_matches('/').to_string()
        }
        _ => fallback.to_string(),
    }
}

fn resolve_detached_dev_command(project_path: &str) -> String {
    let contract_path = Path::new(project_path).join("digwis-project.json");
    if contract_path.exists() {
        if let Ok(parsed) = fs::read_to_string(&contract_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<DigwisProjectConfig>(&raw).ok())
            .ok_or(())
        {
            if parsed.project_type == "next-platform" {
                return "npm run dev".to_string();
            }
        }
    }
    if let Some(pkg) = read_root_package_json(project_path) {
        if pkg
            .package_manager
            .as_deref()
            .map(|pm| pm.starts_with("bun@"))
            .unwrap_or(false)
        {
            return "bun run dev".to_string();
        }
    }
    "npm run dev".to_string()
}

pub struct DetachedStart {
    pub pid: Option<u32>,
    pub log_path: String,
}

pub(crate) fn spawn_detached(cwd: &str, command: &str, log_path: Option<&Path>) -> std::io::Result<u32> {
    let env = env_with_extra_path();
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.args(["/c", command]).current_dir(cwd);
        c
    } else {
        let mut c = Command::new("/bin/bash");
        c.args(["-lc", &format!("cd \"{}\" && {}", cwd.replace('"', "\\\""), command)]);
        c
    };
    cmd.envs(&env);
    match log_path {
        Some(p) => {
            let f = fs::OpenOptions::new().create(true).append(true).open(p)?;
            let f2 = f.try_clone()?;
            cmd.stdin(Stdio::null()).stdout(Stdio::from(f)).stderr(Stdio::from(f2));
        }
        None => {
            cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // Detach: on unix, start a new session so the dev server outlives the app.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let child = cmd.spawn()?;
    Ok(child.id())
}

pub fn start_local_dev_detached(project_path: &str, web_path: &str) -> AppResult<DetachedStart> {
    let runtime_dir = Path::new(project_path).join(".digwis-panel");
    fs::create_dir_all(&runtime_dir).map_err(|e| internal_error(e.to_string()))?;
    let log_path = runtime_dir.join("local-dev.log");
    let dev_command = resolve_detached_dev_command(project_path);
    let pid = spawn_detached(web_path, &dev_command, Some(&log_path))
        .map_err(|e| internal_error(format!("无法启动本地开发服务：{e}")))?;
    Ok(DetachedStart { pid: Some(pid), log_path: log_path.to_string_lossy().to_string() })
}

pub fn run_in_project_detached(
    project_path: &str,
    command: &str,
    log_name: Option<&str>,
) -> AppResult<Option<u32>> {
    let log_path = log_name.map(|n| {
        let dir = Path::new(project_path).join(".digwis-panel");
        let _ = fs::create_dir_all(&dir);
        dir.join(n)
    });
    let mut extra_env = HashMap::new();
    if command.contains("directus") {
        extra_env.insert("NAPI_RS_FORCE_WASI".to_string(), "1".to_string());
    }
    // merge NAPI_RS_FORCE_WASI into env via spawn wrapper: spawn_detached uses env_with_extra_path;
    // add the var through a prefix for simplicity.
    let cmd = if extra_env.is_empty() {
        command.to_string()
    } else {
        format!(
            "env {} {}",
            extra_env
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(" "),
            command
        )
    };
    let pid = spawn_detached(project_path, &cmd, log_path.as_deref())
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(Some(pid))
}

pub fn start_client_app_detached(
    project_path: &str,
    target: &str,
    cwd: &str,
    command: &str,
) -> AppResult<DetachedStart> {
    let runtime_dir = Path::new(project_path).join(".digwis-panel");
    fs::create_dir_all(&runtime_dir).map_err(|e| internal_error(e.to_string()))?;
    let suffix = match target {
        "electron" => "desktop",
        "ios-native" => "ios",
        _ => "android",
    };
    let log_path = runtime_dir.join(format!("{suffix}.log"));
    let pid = spawn_detached(cwd, command, Some(&log_path))
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(DetachedStart { pid: Some(pid), log_path: log_path.to_string_lossy().to_string() })
}

pub fn wait_for_preview_url_from_log(log_path: &str, timeout_ms: u64) -> Option<String> {
    let patterns = [
        regex::Regex::new(r"(?i)Local:\s+(http://localhost:\d+)").unwrap(),
        regex::Regex::new(r"(?i)Local:\s+(http://127\.0\.0\.1:\d+)").unwrap(),
        regex::Regex::new(r"(?i)Local:\s+(http://\[::1\]:\d+)").unwrap(),
        regex::Regex::new(r"(?i)Local:\s+(http://0\.0\.0\.0:\d+)").unwrap(),
    ];
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        if let Ok(raw) = fs::read_to_string(log_path) {
            for pat in &patterns {
                if let Some(caps) = pat.captures(&raw) {
                    return Some(
                        caps[1]
                            .replace("http://[::1]:", "http://localhost:")
                            .replace("http://0.0.0.0:", "http://localhost:"),
                    );
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
    None
}

pub fn stop_local_runtime_if_present(project_path: &str) {
    let Some(runtime) = read_project_local_runtime(project_path) else { return };
    let Some(pid) = runtime.pid else { return };
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        // kill process group first (detached dev server runs in its own session)
        if libc::kill(-(pid as i32), libc::SIGTERM) != 0 {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}

pub fn remove_local_directory_strict(local_path: &str) -> AppResult<bool> {
    let p = Path::new(local_path);
    if !p.exists() {
        return Ok(false);
    }
    if fs::remove_dir_all(p).is_err() && !cfg!(windows) {
        let ok = Command::new("/bin/rm")
            .args(["-rf", local_path])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err(internal_error("本地目录删除失败"));
        }
    }
    if p.exists() {
        return Err(internal_error(format!("本地目录删除失败，目录仍然存在：{local_path}")));
    }
    Ok(true)
}

fn ensure_directus_database(env_path: &Path) {
    let Ok(content) = fs::read_to_string(env_path) else { return };
    let db_client = content
        .lines()
        .find_map(|l| l.strip_prefix("DB_CLIENT=").map(|v| v.trim().to_string()));
    if db_client.as_deref() != Some("pg") {
        return;
    }
    let Some(conn) = content
        .lines()
        .find_map(|l| l.strip_prefix("DB_CONNECTION_STRING=").map(|v| v.trim().to_string()))
    else {
        return;
    };
    let normalized = conn.replacen("postgresql:", "postgres:", 1).replacen("postgres:", "postgres:", 1);
    let Ok(url) = url::Url::parse(&normalized) else { return };
    let db_name = url.path().trim_start_matches('/');
    if db_name.is_empty() {
        return;
    }
    let mut env = env_with_extra_path();
    if let Some(pw) = url.password() {
        env.insert(
            "PGPASSWORD".to_string(),
            percent_encoding::percent_decode_str(pw).decode_utf8_lossy().to_string(),
        );
    }
    let _ = Command::new("createdb")
        .args([
            "-h",
            url.host_str().unwrap_or("127.0.0.1"),
            "-p",
            &url.port().map(|p| p.to_string()).unwrap_or_else(|| "5432".into()),
            "-U",
            &percent_encoding::percent_decode_str(url.username()).decode_utf8_lossy(),
            db_name,
        ])
        .envs(&env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn bootstrap_directus_if_needed(sidecar_dir: &Path) {
    if !sidecar_dir.join(".env").exists() {
        return;
    }
    let mut env = env_with_extra_path();
    env.insert("NAPI_RS_FORCE_WASI".to_string(), "1".to_string());
    let _ = Command::new("/bin/bash")
        .args(["-lc", "npx directus bootstrap"])
        .current_dir(sidecar_dir)
        .envs(&env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

const DIRECTUS_LOCAL_ADMIN_URL: &str = "http://localhost:8055/admin";

/// projects:start-local-admin-service orchestration.
pub fn start_local_admin_service(project_path: &str, preview: &ProjectLocalPreview) -> ProjectLocalAdminStartResult {
    let admin_url = preview
        .admin_url
        .clone()
        .unwrap_or_else(|| DIRECTUS_LOCAL_ADMIN_URL.to_string());
    let directus_compose = Path::new(project_path).join("services/directus/docker-compose.yml");
    let sidecar_dir = Path::new(project_path).join("services/directus");
    let directus_package = sidecar_dir.join("package.json");
    let root_package = Path::new(project_path).join("package.json");

    if directus_compose.exists() {
        let _ = run_in_project_detached(project_path, "npm run directus:up", None);
        return ProjectLocalAdminStartResult {
            ok: true,
            message: "已在后台启动 CMS 管理服务（Docker）".into(),
            admin_url,
        };
    }
    if !directus_package.exists() {
        return ProjectLocalAdminStartResult {
            ok: true,
            message: "当前项目没有独立 CMS sidecar，跳过后台管理服务启动。".into(),
            admin_url,
        };
    }

    repair_project_native_modules(project_path);
    let env_path = sidecar_dir.join(".env");
    let env_example = sidecar_dir.join(".env.example");
    if !env_path.exists() && env_example.exists() {
        let _ = fs::copy(&env_example, &env_path);
    }
    ensure_directus_database(&env_path);
    bootstrap_directus_if_needed(&sidecar_dir);

    let mut start_command = "npm run directus:dev".to_string();
    if root_package.exists() {
        if let Some(pkg) = read_root_package_json(project_path) {
            if let Some(scripts) = pkg.scripts {
                if scripts.contains_key("directus:dev") {
                    start_command = "npm run directus:dev".to_string();
                } else if scripts.contains_key("directus:start") {
                    start_command = "npm run directus:start".to_string();
                }
            }
        }
    } else {
        start_command = "npm run dev".to_string();
    }
    let _ = run_in_project_detached(project_path, &start_command, Some("directus.log"));
    ProjectLocalAdminStartResult {
        ok: true,
        message: "已在后台启动 Directus 开发服务".into(),
        admin_url,
    }
}

/// checkUrlReachable — GET with redirect follow, 2.5s timeout.
pub fn check_url_reachable(url_str: &str, redirect_count: u32) -> ProjectUrlReachabilityResult {
    let parsed = match url::Url::parse(url_str) {
        Ok(u) => u,
        Err(e) => {
            return ProjectUrlReachabilityResult {
                ok: false,
                detail: e.to_string(),
                status: None,
                final_url: None,
            }
        }
    };
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_millis(2500)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let request = agent
        .get(parsed.as_str())
        .header("user-agent", "DigVPS/1.0")
        .header("accept", "*/*");
    match request.call() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (300..400).contains(&status) && redirect_count < 3 {
                if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                    if let Ok(next) = parsed.join(loc) {
                        return check_url_reachable(next.as_str(), redirect_count + 1);
                    }
                }
            }
            ProjectUrlReachabilityResult {
                ok: (200..400).contains(&status),
                detail: format!("HTTP {status}"),
                status: Some(status),
                final_url: Some(parsed.to_string()),
            }
        }
        Err(e) => ProjectUrlReachabilityResult {
            ok: false,
            detail: e.to_string(),
            status: None,
            final_url: Some(parsed.to_string()),
        },
    }
}

/// resolveProjectClientApp — from digwis-project.json contract.
pub fn resolve_project_client_app(
    project_path: &str,
    target: &str,
) -> AppResult<(DigwisProjectAppContract, String)> {
    let contract = crate::project_scaffold::get_project_config(project_path)
        .ok_or_else(|| internal_error("项目缺少 digwis-project.json，暂时无法解析客户端目录"))?;
    let app = match target {
        "electron" => contract.apps.desktop.clone(),
        "ios-native" => contract.apps.mobile_ios.clone(),
        _ => contract.apps.mobile_android.clone(),
    };
    let app = app.ok_or_else(|| internal_error("当前项目没有启用这个客户端目标"))?;
    if app.path.is_empty() {
        return Err(internal_error("当前项目没有启用这个客户端目标"));
    }
    let absolute = Path::new(project_path).join(&app.path).to_string_lossy().to_string();
    Ok((app, absolute))
}

fn find_ios_ide_path(client_root: &Path) -> PathBuf {
    if let Ok(entries) = fs::read_dir(client_root) {
        let mut project: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if name.ends_with(".xcworkspace") {
                    return entry.path();
                }
                if name.ends_with(".xcodeproj") {
                    project = Some(entry.path());
                }
            }
        }
        if let Some(p) = project {
            return p;
        }
    }
    client_root.to_path_buf()
}

fn ensure_ios_ide_project(client_root: &Path) -> AppResult<PathBuf> {
    let existing = find_ios_ide_path(client_root);
    if existing != client_root {
        return Ok(existing);
    }
    if !client_root.join("project.yml").exists() {
        return Ok(client_root.to_path_buf());
    }
    let ok = Command::new("/usr/bin/env")
        .args(["xcodegen", "generate"])
        .current_dir(client_root)
        .envs(env_with_extra_path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err(internal_error(
            "未检测到可用的 xcodegen。请先安装 xcodegen，或手动在 Xcode 中创建工程。",
        ));
    }
    Ok(find_ios_ide_path(client_root))
}

pub fn open_client_app_ide(project_path: &str, target: &str) -> AppResult<ProjectClientAppIdeOpenResult> {
    let (_app, absolute) = resolve_project_client_app(project_path, target)?;
    if !Path::new(&absolute).exists() {
        return Err(internal_error(format!("客户端目录不存在：{absolute}")));
    }
    if target == "electron" {
        return Err(internal_error("Electron 客户端没有专用原生 IDE，请直接使用启动或打开目录。"));
    }
    if !cfg!(target_os = "macos") {
        return Err(internal_error("一键打开 IDE 目前只支持 macOS"));
    }
    let application = if target == "ios-native" { "Xcode" } else { "Android Studio" };
    let ide_target = if target == "ios-native" {
        ensure_ios_ide_project(Path::new(&absolute))?
    } else {
        PathBuf::from(&absolute)
    };
    let ok = Command::new("open")
        .args(["-a", application])
        .arg(&ide_target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err(internal_error(format!("无法打开 {application}")));
    }
    Ok(ProjectClientAppIdeOpenResult {
        ok: true,
        target: target.to_string(),
        path: ide_target.to_string_lossy().to_string(),
        application: application.to_string(),
    })
}

// ---------- deploy script env / action kind (ipc/helpers.ts) ----------

pub fn resolve_action_kind_from_script(script: Option<&str>) -> Option<&'static str> {
    match script {
        Some("deploy:panel") | Some("deploy:vps:code") => Some("code"),
        Some("sync:vps:admin-data") | Some("sync:vps:data") | Some("sync:vps") => Some("data"),
        Some("sync:vps:uploads") | Some("sync:uploads:vps") => Some("uploads"),
        _ => None,
    }
}

pub fn build_project_script_env(
    project_id: &str,
    project_path: &str,
    connection: &VpsConnectionInput,
    config_remote_app_dir: Option<&str>,
    config_remote_service: Option<&str>,
    config_public_check_url: Option<&str>,
    config_env: Option<&HashMap<String, String>>,
) -> HashMap<String, String> {
    let mut base: HashMap<String, String> = [
        ("DIGWIS_PANEL", "1".to_string()),
        ("DIGWIS_PANEL_PROJECT_ID", project_id.to_string()),
        ("DIGWIS_PANEL_PROJECT_PATH", project_path.to_string()),
        ("VPS_CONNECTION_NAME", connection.name.clone()),
        ("VPS_HOST", connection.host.clone()),
        ("VPS_PORT", connection.port.to_string()),
        ("VPS_USER", connection.username.clone()),
        ("VPS_AUTH_TYPE", connection.auth_type.clone()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    if let Some(v) = config_remote_app_dir {
        base.insert("REMOTE_APP_DIR".into(), v.to_string());
    }
    if let Some(v) = config_remote_service {
        base.insert("REMOTE_SERVICE".into(), v.to_string());
    }
    if let Some(v) = config_public_check_url {
        base.insert("PUBLIC_CHECK_URL".into(), v.to_string());
    }
    if connection.auth_type == "password" {
        if let Some(pw) = &connection.password {
            base.insert("VPS_PASSWORD".into(), pw.clone());
        }
    } else {
        if let Some(k) = &connection.private_key {
            base.insert("VPS_PRIVATE_KEY".into(), k.clone());
        }
        if let Some(p) = &connection.passphrase {
            base.insert("VPS_PASSPHRASE".into(), p.clone());
        }
    }
    if let Some(cfg) = config_env {
        for (k, v) in cfg {
            base.insert(k.clone(), v.clone());
        }
    }
    base
}
