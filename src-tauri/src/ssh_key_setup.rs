//! ssh-keygen + authorized_keys install + ssh-config writeback — port of ssh-key-setup.ts.

use crate::discovery::ensure_ssh_config_candidate_for_connection;
use crate::error::{internal_error, AppResult};
use crate::models::{SshKeySetupResult, VpsConnectionInput};
use crate::ssh::run_remote_shell_command;
use crate::util::shell_single_quote;
use std::path::PathBuf;
use std::process::Command;

fn sanitize_file_segment(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn resolve_key_file_path(payload: &VpsConnectionInput) -> PathBuf {
    let host_segment = {
        let s = sanitize_file_segment(&payload.host);
        if s.is_empty() { "server".to_string() } else { s }
    };
    let port_segment = if payload.port != 0 && payload.port != 22 {
        format!("_{}", payload.port)
    } else {
        String::new()
    };
    crate::util::home_dir()
        .join(".ssh")
        .join(format!("id_ed25519_{host_segment}{port_segment}"))
}

struct LocalKey {
    key_path: PathBuf,
    public_key_path: PathBuf,
    private_key: String,
    public_key: String,
    created: bool,
}

fn ensure_key_pair(key_path: &PathBuf, comment: &str) -> AppResult<LocalKey> {
    let public_key_path = PathBuf::from(format!("{}.pub", key_path.display()));
    if let Some(parent) = key_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let created = !key_path.exists() || !public_key_path.exists();
    if created {
        let status = Command::new("ssh-keygen")
            .args([
                "-q", "-t", "ed25519",
                "-f", &key_path.to_string_lossy(),
                "-N", "",
                "-C", comment,
            ])
            .envs(crate::util::env_with_extra_path())
            .status()
            .map_err(|e| internal_error(format!("无法启动 ssh-keygen：{e}")))?;
        if !status.success() {
            return Err(internal_error("ssh-keygen 生成密钥失败"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600));
        if public_key_path.exists() {
            let _ = std::fs::set_permissions(&public_key_path, std::fs::Permissions::from_mode(0o644));
        }
    }
    let private_key = std::fs::read_to_string(key_path).map_err(|e| internal_error(e.to_string()))?;
    let public_key = std::fs::read_to_string(&public_key_path)
        .map_err(|e| internal_error(e.to_string()))?
        .trim()
        .to_string();
    Ok(LocalKey {
        key_path: key_path.clone(),
        public_key_path,
        private_key,
        public_key,
        created,
    })
}

fn install_authorized_key(payload: &VpsConnectionInput, public_key: &str) -> AppResult<()> {
    let command = format!(
        "set -eu\numask 077\nmkdir -p ~/.ssh\nchmod 700 ~/.ssh\ntouch ~/.ssh/authorized_keys\nchmod 600 ~/.ssh/authorized_keys\nKEY_LINE={}\nif ! grep -Fqx \"$KEY_LINE\" ~/.ssh/authorized_keys 2>/dev/null; then\n  printf '%s\\n' \"$KEY_LINE\" >> ~/.ssh/authorized_keys\nfi\n",
        shell_single_quote(public_key)
    );
    let result = run_remote_shell_command(payload, &command, 60_000)?;
    if result.code != 0 {
        let msg = if !result.stderr.trim().is_empty() {
            result.stderr.trim().to_string()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim().to_string()
        } else {
            "公钥安装失败".to_string()
        };
        return Err(internal_error(msg));
    }
    Ok(())
}

pub fn create_and_install_ssh_key(payload: &VpsConnectionInput) -> AppResult<SshKeySetupResult> {
    if payload.auth_type != "password" || payload.password.is_none() {
        return Err(internal_error("需要先提供可用的 SSH 密码，才能一键创建私钥"));
    }
    let key_path = resolve_key_file_path(payload);
    let comment = format!(
        "{}@{} {}",
        payload.username.trim(),
        payload.host.trim(),
        &crate::util::now_iso()[..10]
    );
    let local_key = ensure_key_pair(&key_path, &comment)?;
    install_authorized_key(payload, &local_key.public_key)?;
    let name = {
        let n = payload.name.trim();
        if n.is_empty() { payload.host.trim().to_string() } else { n.to_string() }
    };
    let (config_path, _) = ensure_ssh_config_candidate_for_connection(
        &name,
        payload.host.trim(),
        payload.port,
        payload.username.trim(),
        &local_key.key_path.to_string_lossy(),
    )?;
    Ok(SshKeySetupResult {
        ok: true,
        key_path: local_key.key_path.to_string_lossy().to_string(),
        public_key_path: local_key.public_key_path.to_string_lossy().to_string(),
        config_path,
        private_key: local_key.private_key,
        public_key: local_key.public_key,
        created: local_key.created,
        message: if local_key.created {
            "已生成新私钥并写入服务器".to_string()
        } else {
            "已复用本地私钥并确认服务器公钥已安装".to_string()
        },
    })
}
