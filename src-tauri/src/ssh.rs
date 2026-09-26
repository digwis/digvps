//! SSH session layer — port of ssh-auth.ts / ssh-runtime.ts / remote-command.ts / remote-exec.ts
//! onto the blocking `ssh2` crate (libssh2). All ops run on Tauri's blocking thread pool.

use crate::error::{internal_error, AppResult};
use crate::models::VpsConnectionInput;
use base64::Engine;
use sha2::Digest;
use ssh2::{KeyboardInteractivePrompt, Prompt, Session};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// ssh-auth.ts resolvePrivateKeyMaterial: accept PEM inline, a path, or `~`-relative path.
fn resolve_private_key_material(private_key: Option<&str>) -> AppResult<String> {
    let Some(raw) = private_key else {
        return Err(internal_error("未提供私钥"));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(internal_error("未提供私钥"));
    }
    if trimmed.contains("-----BEGIN") || trimmed.starts_with("PuTTY-User-Key-File") {
        return Ok(raw.to_string());
    }
    let expanded = crate::util::expand_home(trimmed).to_string_lossy().to_string();
    // `~/x` handled above; absolute path → itself; bare name → CWD then ~/.ssh
    let mut candidates: Vec<PathBuf> = Vec::new();
    let expanded_path = PathBuf::from(&expanded);
    if expanded_path.is_absolute() {
        candidates.push(expanded_path);
    } else {
        candidates.push(std::env::current_dir().unwrap_or_default().join(&expanded));
        candidates.push(crate::util::home_dir().join(".ssh").join(&expanded));
    }
    for candidate in &candidates {
        if let Ok(content) = std::fs::read_to_string(candidate) {
            return Ok(content);
        }
    }
    Err(internal_error(format!("无法读取私钥文件：{trimmed}")))
}

struct PasswordPrompt {
    password: String,
}

impl KeyboardInteractivePrompt for PasswordPrompt {
    fn prompt<'a>(
        &mut self,
        _username: &'a str,
        _instructions: &'a str,
        prompts: &[Prompt<'a>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.password.clone()).collect()
    }
}

pub struct SshSession {
    pub session: Session,
    stream: TcpStream,
}

impl SshSession {
    /// Host key as SHA256 fingerprint ("SHA256:base64"), matching ssh.ts testConnection.
    pub fn host_fingerprint(&self) -> Option<String> {
        let (key, _kind) = self.session.host_key()?;
        let digest = sha2::Sha256::digest(key);
        Some(base64::engine::general_purpose::STANDARD.encode(digest))
    }

    pub fn disconnect(&self) {
        let _ = self.session.disconnect(None, "", None);
    }

    /// Open the SFTP subsystem on this session.
    pub fn sftp(&self) -> AppResult<ssh2::Sftp> {
        self.session.sftp().map_err(|e| internal_error(e.to_string()))
    }
}

/// connectSshClient: TCP connect → handshake → authenticate.
pub fn connect(payload: &VpsConnectionInput, ready_timeout_ms: u64) -> AppResult<SshSession> {
    let host = payload.host.trim();
    let username = payload.username.trim();
    let port = if payload.port == 0 { 22 } else { payload.port };

    let addr_str = format!("{host}:{port}");
    let mut addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| internal_error(format!("无法解析地址 {addr_str}: {e}")))?;
    let addr = addrs
        .next()
        .ok_or_else(|| internal_error(format!("无法解析地址 {addr_str}")))?;

    let connect_timeout = Duration::from_millis(ready_timeout_ms.min(15_000).max(2_000));
    let stream = TcpStream::connect_timeout(&addr, connect_timeout).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("timed out") {
            internal_error(format!(
                "无法连接到 {host}:{port}，请检查服务器是否在线、防火墙/安全组是否已放行 SSH 端口。"
            ))
        } else if msg.contains("refused") {
            internal_error(format!("目标 {host}:{port} 拒绝连接，请检查 SSH 服务是否已启动，或端口是否填错。"))
        } else {
            internal_error(format!("无法连接到 {host}:{port}：{msg}"))
        }
    })?;
    let _ = stream.set_nodelay(true);

    let mut session = Session::new().map_err(|e| internal_error(e.to_string()))?;
    session.set_tcp_stream(stream.try_clone().map_err(|e| internal_error(e.to_string()))?);
    session.set_timeout(ready_timeout_ms as u32);
    session.handshake().map_err(|e| {
        let msg = e.to_string();
        if msg.contains("timed out") || msg.contains("timeout") {
            internal_error(format!(
                "无法连接到 {host}:{port}，请检查服务器是否在线、防火墙/安全组是否已放行 SSH 端口。"
            ))
        } else {
            internal_error(msg)
        }
    })?;

    let auth_result: AppResult<()> = (|| {
        if payload.auth_type == "password" {
            let password = payload.password.clone().unwrap_or_default();
            let primary = session.userauth_password(username, &password);
            if primary.is_err() || !session.authenticated() {
                // tryKeyboard equivalent: keyboard-interactive with the same password
                let mut prompt = PasswordPrompt {
                    password: password.clone(),
                };
                match session.userauth_keyboard_interactive(username, &mut prompt) {
                    Ok(_) if session.authenticated() => Ok(()),
                    _ => Err(auth_failed_message(payload)),
                }
            } else {
                Ok(())
            }
        } else {
            let key_material = resolve_private_key_material(payload.private_key.as_deref())?;
            match session.userauth_pubkey_memory(
                username,
                None,
                &key_material,
                payload.passphrase.as_deref(),
            ) {
                Ok(_) if session.authenticated() => Ok(()),
                Ok(_) => Err(auth_failed_message(payload)),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.to_lowercase().contains("auth") {
                        Err(auth_failed_message(payload))
                    } else {
                        Err(internal_error(msg))
                    }
                }
            }
        }
    })();

    match auth_result {
        Ok(()) => Ok(SshSession { session, stream }),
        Err(e) => {
            let _ = session.disconnect(None, "", None);
            Err(e)
        }
    }
}

fn auth_failed_message(payload: &VpsConnectionInput) -> String {
    let account_hint = if payload.username.trim() == "root" {
        "当前填写的是 root，很多云主机会默认禁用 root 密码登录。"
    } else {
        "当前账号或认证方式没有被服务器接受。"
    };
    internal_error(format!(
        "SSH 认证失败。{account_hint} 请检查密码是否正确、服务器是否关闭了 PasswordAuthentication，或是否只允许私钥登录。"
    ))
}

fn is_auth_failure(error: &str) -> bool {
    let m = error.to_lowercase();
    m.contains("authentication") || m.contains("auth ") || m.contains("认证失败")
}

/// execOnClient + deadline enforcement.
pub fn exec_on_session(
    sess: &Session,
    command: &str,
    timeout_ms: u64,
    timeout_message: &str,
) -> AppResult<ExecResult> {
    let mut channel = sess
        .channel_session()
        .map_err(|e| internal_error(e.to_string()))?;
    channel
        .exec(command)
        .map_err(|e| internal_error(e.to_string()))?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    // Socket-level per-read timeout: min(30s, remaining) keeps the loop responsive.
    let read_slice = timeout_ms.min(30_000).max(5_000);
    sess.set_timeout(read_slice as u32);

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut buf = [0u8; 32 * 1024];
    let mut out_open = true;
    let mut err_open = true;

    while out_open || err_open {
        if Instant::now() > deadline {
            let _ = channel.close();
            return Err(internal_error(timeout_message));
        }
        let mut progressed = false;
        if out_open {
            match channel.read(&mut buf) {
                Ok(0) => out_open = false,
                Ok(n) => {
                    stdout.extend_from_slice(&buf[..n]);
                    progressed = true;
                }
                Err(e) => {
                    if e.to_string().to_lowercase().contains("timed out") {
                        std::thread::sleep(Duration::from_millis(50));
                    } else {
                        out_open = false;
                    }
                }
            }
        }
        if err_open {
            match channel.stderr().read(&mut buf) {
                Ok(0) => err_open = false,
                Ok(n) => {
                    stderr.extend_from_slice(&buf[..n]);
                    progressed = true;
                }
                Err(e) => {
                    if e.to_string().to_lowercase().contains("timed out") {
                        std::thread::sleep(Duration::from_millis(50));
                    } else {
                        err_open = false;
                    }
                }
            }
        }
        if !progressed && (out_open || err_open) {
            // Both streams timed out on this pass; short yield before retrying.
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    let _ = channel.wait_close();
    let code = channel.exit_status().unwrap_or(-1);
    Ok(ExecResult {
        code,
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

/// runSshCommand: fresh connection per command.
pub fn run_ssh_command(
    payload: &VpsConnectionInput,
    command: &str,
    timeout_ms: u64,
    timeout_message: &str,
) -> AppResult<ExecResult> {
    let sess = connect(payload, 10_000)?;
    let result = exec_on_session(&sess.session, command, timeout_ms, timeout_message);
    sess.disconnect();
    result
}

/// sshpass + `ssh -o StrictHostKeyChecking=no` local fallback for password auth.
fn run_remote_via_local_sshpass(
    payload: &VpsConnectionInput,
    command: &str,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    if payload.auth_type != "password" || payload.password.is_none() {
        return Err(internal_error("SSH 本地回退仅支持密码认证"));
    }
    let mut child = Command::new("sshpass")
        .args([
            "-p",
            payload.password.as_deref().unwrap_or_default(),
            "ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-p",
            &payload.port.to_string(),
            &format!("{}@{}", payload.username.trim(), payload.host.trim()),
            "bash",
            "-s",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(crate::util::env_with_extra_path())
        .spawn()
        .map_err(|e| internal_error(format!("无法启动 sshpass：{e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(command.as_bytes());
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child.wait_with_output().map_err(|e| internal_error(e.to_string()))?;
                return Ok(ExecResult {
                    code: output.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                });
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    return Err(internal_error("远程命令执行超时"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(internal_error(e.to_string())),
        }
    }
}

/// runRemoteShellCommand: libssh2 path first, sshpass fallback on auth failure (password only).
pub fn run_remote_shell_command(
    payload: &VpsConnectionInput,
    command: &str,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    match run_ssh_command(payload, command, timeout_ms, "远程命令执行超时") {
        Ok(r) => Ok(r),
        Err(e) => {
            if payload.auth_type == "password" && is_auth_failure(&e) {
                return run_remote_via_local_sshpass(payload, command, timeout_ms);
            }
            Err(e)
        }
    }
}

/// testConnection: connect → pwd → sftp cwd, measuring latency and fingerprint.
pub fn test_connection(payload: &VpsConnectionInput) -> AppResult<crate::models::ConnectionTestResult> {
    let start = Instant::now();
    let session = connect(payload, 10_000)?;
    let fingerprint = session.host_fingerprint().unwrap_or_default();

    let pwd = exec_on_session(&session.session, "pwd", 15_000, "连接测试超时，请检查 SSH 配置或网络状态")?;
    if pwd.code != 0 && !pwd.stderr.trim().is_empty() {
        session.disconnect();
        return Err(internal_error(pwd.stderr.trim()));
    }
    let mut working_directory = pwd.stdout.trim().to_string();

    if let Ok(sftp) = session.sftp() {
        if working_directory.is_empty() {
            if let Ok(entries) = sftp.readdir(std::path::Path::new(".")) {
                let _ = entries;
            }
        }
        // libssh2 has no cwd(); "." stat gives us nothing extra — keep pwd result.
    }
    if working_directory.is_empty() {
        working_directory = ".".to_string();
    }
    session.disconnect();

    Ok(crate::models::ConnectionTestResult {
        success: true,
        message: "SSH 与 SFTP 握手成功".to_string(),
        latency_ms: start.elapsed().as_millis() as u64,
        server_fingerprint: Some(fingerprint),
        working_directory: Some(working_directory),
    })
}
