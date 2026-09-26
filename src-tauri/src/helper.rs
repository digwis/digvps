//! Persistent remote-helper sessions (JSON-RPC over an SSH exec channel).
//! Port of remote-file-session-manager.ts + remote-inspection-session-manager.ts.
//!
//! Each session is owned by a dedicated std::thread that holds the SSH session
//! and channel (ssh2 types are Send but borrowing channels pin the session).
//! Callers send HelperRequest items over an mpsc queue; the owner writes the
//! request line, streams output until the matching JSON-RPC response, and
//! replies over a oneshot-style mpsc.

use crate::error::{internal_error, AppResult};
use crate::models::VpsConnectionInput;
use crate::ssh::{connect, exec_on_session};
use crate::util::shell_single_quote;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const HELPER_DIR_NAME: &str = ".digwis-panel";
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const READY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperKind {
    Files,
    Inspect,
}

impl HelperKind {
    fn file_name(self) -> &'static str {
        match self {
            HelperKind::Files => "remote-file-helper.py",
            HelperKind::Inspect => "remote-inspection-helper.py",
        }
    }
    fn version_file(self) -> &'static str {
        match self {
            HelperKind::Files => "remote-file-helper.version",
            HelperKind::Inspect => "remote-inspection-helper.version",
        }
    }
    fn script(self) -> &'static str {
        match self {
            HelperKind::Files => include_str!("../helpers/digwis-files.py"),
            HelperKind::Inspect => include_str!("../helpers/digwis-inspect.py"),
        }
    }
    fn version(self) -> &'static str {
        "2026-04-28.1"
    }
}

pub struct HelperRequest {
    pub method: String,
    pub params: Value,
    pub respond: Sender<Result<Value, String>>,
}

struct HelperHandle {
    tx: Sender<HelperRequest>,
    alive: Arc<AtomicBool>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, HelperHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn session_key(kind: HelperKind, connection: &VpsConnectionInput) -> String {
    let base = connection
        .id
        .clone()
        .unwrap_or_else(|| format!("{}@{}:{}", connection.username, connection.host, connection.port));
    format!("{kind:?}:{base}")
}

fn upload_helper(
    connection: &VpsConnectionInput,
    kind: HelperKind,
    helper_path: &str,
    version_path: &str,
) -> AppResult<()> {
    let sess = connect(connection, 20_000)?;
    let result = (|| -> AppResult<()> {
        let sftp = sess.sftp()?;
        let mut f = sftp
            .create(std::path::Path::new(helper_path))
            .map_err(|e| internal_error(e.to_string()))?;
        f.write_all(kind.script().as_bytes())
            .map_err(|e| internal_error(e.to_string()))?;
        let mut vf = sftp
            .create(std::path::Path::new(version_path))
            .map_err(|e| internal_error(e.to_string()))?;
        vf.write_all(format!("{}\n", kind.version()).as_bytes())
            .map_err(|e| internal_error(e.to_string()))?;
        Ok(())
    })();
    sess.disconnect();
    result
}

fn ensure_helper_installed(
    sess: &crate::ssh::SshSession,
    connection: &VpsConnectionInput,
    kind: HelperKind,
) -> AppResult<(String, String)> {
    let script = [
        "set -e",
        "HOME_DIR=\"${HOME}\"",
        "PYTHON_BIN=\"\"",
        "if command -v python3 >/dev/null 2>&1; then PYTHON_BIN=\"$(command -v python3)\"; elif command -v python >/dev/null 2>&1; then PYTHON_BIN=\"$(command -v python)\"; fi",
        &format!("HELPER_DIR=\"$HOME_DIR/{HELPER_DIR_NAME}\""),
        &format!("HELPER_PATH=\"$HELPER_DIR/{}\"", kind.file_name()),
        &format!("VERSION_PATH=\"$HELPER_DIR/{}\"", kind.version_file()),
        "mkdir -p \"$HELPER_DIR\"",
        "printf \"HOME=%s\\nPYTHON=%s\\nHELPER=%s\\nVERSION=%s\\n\" \"$HOME_DIR\" \"$PYTHON_BIN\" \"$HELPER_PATH\" \"$(cat \"$VERSION_PATH\" 2>/dev/null || true)\"",
    ]
    .join("\n");
    let result = exec_on_session(
        &sess.session,
        &format!("bash -lc {}", shell_single_quote(&script)),
        20_000,
        "远端 helper 准备超时",
    )?;
    if result.code != 0 {
        return Err(internal_error(if result.stderr.trim().is_empty() {
            "远端 helper 初始化失败".to_string()
        } else {
            result.stderr.trim().to_string()
        }));
    }
    let mut values: HashMap<String, String> = HashMap::new();
    for line in result.stdout.lines() {
        if let Some(idx) = line.find('=') {
            if idx > 0 {
                values.insert(line[..idx].to_string(), line[idx + 1..].to_string());
            }
        }
    }
    let python_bin = values.get("PYTHON").map(|s| s.trim().to_string()).unwrap_or_default();
    let helper_path = values.get("HELPER").map(|s| s.trim().to_string()).unwrap_or_default();
    let current_version = values.get("VERSION").map(|s| s.trim().to_string()).unwrap_or_default();
    if python_bin.is_empty() {
        return Err(internal_error("远端缺少 python3/python，无法启动 helper"));
    }
    if helper_path.is_empty() {
        return Err(internal_error("远端 helper 路径解析失败"));
    }
    let helper_dir = crate::util::posix_dirname(&helper_path);
    let version_path = crate::util::posix_join(&helper_dir, kind.version_file());
    if current_version != kind.version() {
        upload_helper(connection, kind, &helper_path, &version_path)?;
        let chmod = exec_on_session(
            &sess.session,
            &format!(
                "bash -lc {}",
                shell_single_quote(&format!("chmod 700 {}", shell_single_quote(&helper_path)))
            ),
            20_000,
            "远端 helper 准备超时",
        )?;
        if chmod.code != 0 {
            return Err(internal_error(if chmod.stderr.trim().is_empty() {
                "远端 helper 权限设置失败".to_string()
            } else {
                chmod.stderr.trim().to_string()
            }));
        }
    }
    Ok((python_bin, helper_path))
}

struct SessionOwner {
    key: String,
    connection: VpsConnectionInput,
    kind: HelperKind,
    rx: Receiver<HelperRequest>,
    alive: Arc<AtomicBool>,
}

fn owner_main(owner: SessionOwner, ready: Sender<AppResult<()>>) {
    let SessionOwner {
        key,
        connection,
        kind,
        rx,
        alive,
    } = owner;

    let run = (|| -> AppResult<()> {
        let sess = connect(&connection, 20_000)?;
        let (python_bin, helper_path) = ensure_helper_installed(&sess, &connection, kind)?;
        let inner = format!("{} -u {}", shell_single_quote(&python_bin), shell_single_quote(&helper_path));
        let command = match kind {
            HelperKind::Files => {
                let default_dir = crate::settings::get_default_remote_directory();
                format!(
                    "DIGWIS_DEFAULT_ROOT={} bash -lc {}",
                    shell_single_quote(&default_dir),
                    shell_single_quote(&inner)
                )
            }
            HelperKind::Inspect => format!("bash -lc {}", shell_single_quote(&inner)),
        };
        let mut channel = sess
            .session
            .channel_session()
            .map_err(|e| internal_error(e.to_string()))?;
        channel.exec(&command).map_err(|e| internal_error(e.to_string()))?;
        sess.session.set_blocking(false);

        let mut buf = String::new();
        let mut chunk = [0u8; 32 * 1024];
        let mut last_activity = Instant::now();

        // Handshake: version ping before reporting ready.
        match roundtrip(&mut channel, &mut buf, &mut chunk, 1, "version", &json!({}), READY_TIMEOUT) {
            Ok(_) => {
                let _ = ready.send(Ok(()));
            }
            Err(e) => {
                let _ = ready.send(Err(e));
                let _ = channel.close();
                sess.disconnect();
                return Ok(());
            }
        }

        let mut next_id = 2u64;
        loop {
            if last_activity.elapsed() > SESSION_IDLE_TIMEOUT {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(req) => {
                    last_activity = Instant::now();
                    let id = next_id;
                    next_id += 1;
                    let result = roundtrip(&mut channel, &mut buf, &mut chunk, id, &req.method, &req.params, REQUEST_TIMEOUT);
                    let _ = req.respond.send(result);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = channel.close();
        sess.disconnect();
        Ok(())
    })();

    if let Err(e) = &run {
        let _ = ready.send(Err(e.clone()));
        // Drain any queued requests so callers don't hang.
        while let Ok(req) = rx.try_recv() {
            let _ = req.respond.send(Err(e.clone()));
        }
    }
    alive.store(false, Ordering::SeqCst);
    let mut map = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(entry) = map.get(&key) {
        if Arc::ptr_eq(&entry.alive, &alive) || !entry.alive.load(Ordering::SeqCst) {
            map.remove(&key);
        }
    }
}

/// Write one JSON-RPC line then read until the response for `id`.
/// `buf`/`chunk` carry stream state across calls.
fn roundtrip(
    channel: &mut ssh2::Channel,
    buf: &mut String,
    chunk: &mut [u8],
    id: u64,
    method: &str,
    params: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let payload = json!({ "id": id, "method": method, "params": params }).to_string();
    write_all_blocking(channel, format!("{payload}\n").as_bytes())?;
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            return Err(internal_error("远端 helper 响应超时"));
        }
        match channel.read(chunk) {
            Ok(0) => return Err(internal_error("远端 helper 连接已关闭")),
            Ok(n) => {
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                while let Some(idx) = buf.find('\n') {
                    let line: String = buf[..idx].trim().to_string();
                    buf.drain(..idx + 1);
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if parsed.get("id").and_then(|v| v.as_u64()) != Some(id) {
                        continue;
                    }
                    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                        return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
                    }
                    let msg = parsed
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("远端 helper 调用失败")
                        .to_string();
                    return Err(internal_error(msg));
                }
            }
            Err(e) => {
                if e.to_string().to_lowercase().contains("wouldblock")
                    || e.to_string().contains("WouldBlock")
                {
                    std::thread::sleep(Duration::from_millis(10));
                } else {
                    return Err(internal_error(e.to_string()));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Retry write on WouldBlock until done (channel is non-blocking).
fn write_all_blocking(channel: &mut ssh2::Channel, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    let deadline = Instant::now() + Duration::from_secs(30);
    while written < data.len() {
        match channel.write(&data[written..]) {
            Ok(0) => std::thread::sleep(Duration::from_millis(5)),
            Ok(n) => written += n,
            Err(e) => {
                if e.to_string().contains("WouldBlock") || e.to_string().to_lowercase().contains("wouldblock") {
                    if Instant::now() > deadline {
                        return Err(internal_error("远端 helper 写入超时"));
                    }
                    std::thread::sleep(Duration::from_millis(5));
                } else {
                    return Err(internal_error(e.to_string()));
                }
            }
        }
        if Instant::now() > deadline {
            return Err(internal_error("远端 helper 写入超时"));
        }
    }
    channel.flush().map_err(|e| internal_error(e.to_string()))
}

fn get_or_create(kind: HelperKind, connection: &VpsConnectionInput) -> AppResult<Sender<HelperRequest>> {
    let key = session_key(kind, connection);
    {
        let map = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(handle) = map.get(&key) {
            if handle.alive.load(Ordering::SeqCst) {
                return Ok(handle.tx.clone());
            }
        }
    }
    let (tx, rx) = channel::<HelperRequest>();
    let (ready_tx, ready_rx) = channel::<AppResult<()>>();
    let alive = Arc::new(AtomicBool::new(true));
    {
        let mut map = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
        map.insert(
            key.clone(),
            HelperHandle {
                tx: tx.clone(),
                alive: alive.clone(),
            },
        );
    }
    let owner = SessionOwner {
        key: key.clone(),
        connection: connection.clone(),
        kind,
        rx,
        alive: alive.clone(),
    };
    std::thread::spawn(move || owner_main(owner, ready_tx));
    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => Ok(tx),
        Ok(Err(e)) => {
            SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
            Err(e)
        }
        Err(_) => {
            SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
            Err(internal_error("远端 helper 启动超时"))
        }
    }
}

/// Public RPC entry point — one automatic session restart on transport failure.
pub fn helper_rpc(
    kind: HelperKind,
    connection: &VpsConnectionInput,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let mut attempt_restart = true;
    loop {
        let tx = get_or_create(kind, connection)?;
        let (resp_tx, resp_rx) = channel();
        let req = HelperRequest {
            method: method.to_string(),
            params: params.clone(),
            respond: resp_tx,
        };
        match tx.send(req) {
            Ok(()) => match resp_rx.recv_timeout(REQUEST_TIMEOUT + Duration::from_secs(30)) {
                Ok(result) => return result,
                Err(_) => {
                    if !attempt_restart {
                        return Err(internal_error("远端 helper 响应超时"));
                    }
                    attempt_restart = false;
                    invalidate_session(kind, connection);
                }
            },
            Err(_) => {
                if !attempt_restart {
                    return Err(internal_error("远端 helper 连接已关闭"));
                }
                attempt_restart = false;
                invalidate_session(kind, connection);
            }
        }
    }
}

pub fn invalidate_session(kind: HelperKind, connection: &VpsConnectionInput) {
    let key = session_key(kind, connection);
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
}
