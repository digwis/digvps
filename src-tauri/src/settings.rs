//! App settings — port of settings.ts.

use crate::db;
use crate::error::{internal_error, AppResult};

pub const DEFAULT_REMOTE_DIRECTORY: &str = "/var/www";
const DEFAULT_REMOTE_DIRECTORY_KEY: &str = "defaultRemoteDirectory";

pub fn get_default_remote_directory() -> String {
    db::get_app_setting(DEFAULT_REMOTE_DIRECTORY_KEY)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_REMOTE_DIRECTORY.to_string())
}

pub fn set_default_remote_directory(value: &str) -> AppResult<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(internal_error("默认远程目录不能为空"));
    }
    if !trimmed.starts_with('/') {
        return Err(internal_error("默认远程目录必须是绝对路径（以 / 开头）"));
    }
    db::set_app_setting(DEFAULT_REMOTE_DIRECTORY_KEY, trimmed)
}
