//! IPC error serialization compatible with the Electron `DIGWIS_IPC_ERROR:` contract.
//! Tauri commands return `Result<T, String>`; the string carries the JSON error envelope
//! so `parseDigwisError` in desktop-api.ts keeps working unchanged.

use serde::Serialize;

pub const IPC_ERROR_PREFIX: &str = "DIGWIS_IPC_ERROR:";

#[derive(Serialize)]
struct IpcError<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
}

pub type AppResult<T> = Result<T, String>;

pub fn ipc_error(code: &str, message: impl Into<String>) -> String {
    let payload = IpcError {
        code,
        message: message.into(),
        details: None,
    };
    format!("{}{}", IPC_ERROR_PREFIX, serde_json::to_string(&payload).unwrap_or_default())
}

pub fn internal_error(message: impl Into<String>) -> String {
    ipc_error("INTERNAL_ERROR", message)
}

pub fn invalid_input(message: impl Into<String>) -> String {
    ipc_error("INVALID_INPUT", message)
}

/// Convert common Rust errors into the IPC envelope.
pub trait ToIpc<T> {
    fn ipc(self) -> AppResult<T>;
    fn ipc_msg(self, prefix: &str) -> AppResult<T>;
}

impl<T, E: std::fmt::Display> ToIpc<T> for Result<T, E> {
    fn ipc(self) -> AppResult<T> {
        self.map_err(|e| internal_error(e.to_string()))
    }
    fn ipc_msg(self, prefix: &str) -> AppResult<T> {
        self.map_err(|e| internal_error(format!("{prefix}: {}", e)))
    }
}
