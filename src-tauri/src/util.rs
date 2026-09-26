//! Shared helpers: paths, shell quoting, timestamps, remote-path math.

use std::path::{Path, PathBuf};

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Equivalent to Electron `app.getPath("userData")`. Intentionally keeps the
/// legacy "OpenVPS" directory so existing databases survive the DigVPS rename.
/// Keeps using the existing directory so the SQLite DB migrates transparently.
pub fn user_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library/Application Support/OpenVPS")
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| home_dir().join("AppData/Roaming"))
            .join("OpenVPS")
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        dirs::config_dir()
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("OpenVPS")
    }
}

pub fn expand_home(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    if value == "~" {
        return home_dir();
    }
    PathBuf::from(value)
}

/// `'${value}'` with embedded single quotes escaped — same as TS shellSingleQuote.
pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Lighter quoting used by remote-managed-projects: only quote when needed.
pub fn shell_quote(value: &str) -> String {
    if value.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '/' | '_' | '-')) {
        return value.to_string();
    }
    shell_single_quote(value)
}

/// path.posix.normalize + leading slash, matching toRemotePath() in sftp-fallback.
pub fn to_remote_path(raw: &str) -> String {
    let normalized = posix_normalize(&raw.replace('\\', "/"));
    if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    }
}

pub fn posix_normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let absolute = path.starts_with('/');
    for seg in path.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                if !parts.is_empty() && *parts.last().unwrap() != ".." {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

pub fn posix_join(a: &str, b: &str) -> String {
    if b.starts_with('/') {
        return posix_normalize(b);
    }
    if a.ends_with('/') {
        posix_normalize(&format!("{a}{b}"))
    } else {
        posix_normalize(&format!("{a}/{b}"))
    }
}

pub fn posix_dirname(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

pub fn posix_basename(path: &str) -> String {
    let p = path.trim_end_matches('/');
    p.rsplit('/').next().unwrap_or("").to_string()
}

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

/// `randomBytes(n).toString("base64url")` equivalent.
pub fn random_secret_urlsafe(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, buf)
}

pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Env for spawned CLI tools: prepend common tool paths Finder-launched apps miss.
pub fn env_with_extra_path() -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    if cfg!(windows) {
        return env;
    }
    let extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
    ];
    let existing: Vec<String> = env
        .get("PATH")
        .map(|p| p.split(':').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<String> = Vec::new();
    for seg in extra.iter().map(|s| s.to_string()).chain(existing) {
        if seen.insert(seg.clone()) {
            merged.push(seg);
        }
    }
    env.insert("PATH".to_string(), merged.join(":"));
    env
}
