//! Remote PTY terminal sessions — port of remote-terminal.ts.
//! Events emitted on the Tauri app handle:
//!   terminal:data  { sessionId, data }
//!   terminal:exit  { sessionId, code?, signal? }
//!   terminal:error { sessionId, message }   (new; renderer tolerates it)

use crate::error::{internal_error, AppResult};
use crate::models::{TerminalDataEvent, TerminalErrorEvent, TerminalExitEvent, VpsConnectionInput};
use crate::ssh::connect;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub enum TerminalCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Sender<TerminalCommand>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn emit_data(app: &AppHandle, session_id: &str, data: &[u8]) {
    let _ = app.emit(
        "terminal:data",
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data: String::from_utf8_lossy(data).to_string(),
        },
    );
}

fn session_thread(
    app: AppHandle,
    session_id: String,
    payload: VpsConnectionInput,
    rx: std::sync::mpsc::Receiver<TerminalCommand>,
    ready: Sender<AppResult<()>>,
) {
    let run = (|| -> AppResult<()> {
        let sess = connect(&payload, 10_000)?;
        let mut channel = sess
            .session
            .channel_session()
            .map_err(|e| internal_error(e.to_string()))?;
        channel
            .request_pty("xterm-256color", None, Some((120, 30, 0, 0)))
            .map_err(|e| internal_error(e.to_string()))?;
        channel.shell().map_err(|e| internal_error(e.to_string()))?;
        sess.session.set_blocking(false);
        let _ = ready.send(Ok(()));

        let mut buf = [0u8; 32 * 1024];
        let mut out_open = true;
        let mut err_open = true;
        let mut close_requested = false;

        loop {
            if out_open {
                match channel.read(&mut buf) {
                    Ok(0) => out_open = false,
                    Ok(n) => emit_data(&app, &session_id, &buf[..n]),
                    Err(e) => {
                        let m = e.to_string().to_lowercase();
                        if !(m.contains("wouldblock") || m.contains("would block")) {
                            out_open = false;
                        }
                    }
                }
            }
            if err_open {
                match channel.stderr().read(&mut buf) {
                    Ok(0) => err_open = false,
                    Ok(n) => emit_data(&app, &session_id, &buf[..n]),
                    Err(e) => {
                        let m = e.to_string().to_lowercase();
                        if !(m.contains("wouldblock") || m.contains("would block")) {
                            err_open = false;
                        }
                    }
                }
            }

            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    TerminalCommand::Write(data) => {
                        let mut written = 0;
                        while written < data.len() {
                            match channel.write(&data[written..]) {
                                Ok(0) => break,
                                Ok(n) => written += n,
                                Err(e) => {
                                    let m = e.to_string().to_lowercase();
                                    if m.contains("wouldblock") || m.contains("would block") {
                                        std::thread::sleep(Duration::from_millis(2));
                                        continue;
                                    }
                                    break;
                                }
                            }
                        }
                        let _ = channel.flush();
                    }
                    TerminalCommand::Resize { cols, rows } => {
                        let _ = channel.request_pty_size(cols, rows, None, None);
                    }
                    TerminalCommand::Close => close_requested = true,
                }
            }

            if close_requested || (!out_open && !err_open) {
                break;
            }
            std::thread::sleep(Duration::from_millis(8));
        }

        let _ = channel.wait_close();
        let code = channel.exit_status().ok();
        sess.disconnect();
        Ok(())
    })();

    if let Err(e) = &run {
        let _ = ready.send(Err(e.clone()));
        let _ = app.emit(
            "terminal:error",
            TerminalErrorEvent {
                session_id: session_id.clone(),
                message: e.clone(),
            },
        );
    }
    let code = if run.is_ok() { None } else { None };
    let _ = app.emit(
        "terminal:exit",
        TerminalExitEvent {
            session_id: session_id.clone(),
            code,
            signal: None,
        },
    );
    SESSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&session_id);
}

pub fn create_terminal_session(
    app: &AppHandle,
    payload: &VpsConnectionInput,
) -> AppResult<String> {
    let session_id = crate::util::random_uuid();
    let (tx, rx) = channel::<TerminalCommand>();
    let (ready_tx, ready_rx) = channel::<AppResult<()>>();
    let app2 = app.clone();
    let sid = session_id.clone();
    let payload2 = payload.clone();
    std::thread::spawn(move || session_thread(app2, sid, payload2, rx, ready_tx));
    match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {
            SESSIONS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(session_id.clone(), tx);
            Ok(session_id)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err(internal_error("无法创建远程终端")),
    }
}

fn with_session<T>(session_id: &str, f: impl FnOnce(&Sender<TerminalCommand>) -> T) -> AppResult<T> {
    let map = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    let Some(tx) = map.get(session_id) else {
        return Err(internal_error("终端会话不存在"));
    };
    Ok(f(tx))
}

pub fn write_terminal_input(session_id: &str, data: &str) -> AppResult<()> {
    with_session(session_id, |tx| {
        let _ = tx.send(TerminalCommand::Write(data.as_bytes().to_vec()));
    })
}

pub fn resize_terminal_session(session_id: &str, cols: u32, rows: u32) -> AppResult<()> {
    with_session(session_id, |tx| {
        let _ = tx.send(TerminalCommand::Resize { cols, rows });
    })
}

pub fn close_terminal_session(session_id: &str) -> AppResult<()> {
    let tx = {
        SESSIONS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(session_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(TerminalCommand::Close);
    }
    Ok(())
}
