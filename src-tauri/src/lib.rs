//! DigVPS Tauri backend — Rust port of the Electron main process.
//! Command names mirror the old `domain:action` IPC channels (colon → underscore).
//! The renderer's desktop-api adapter calls `invoke("vps_list", ...)` etc.

mod bitcoin;
mod db;
mod discovery;
mod error;
mod helper;
mod inspection;
mod models;
mod project_local;
mod project_remote;
mod project_scaffold;
mod remote_files;
mod scaffold_templates;
mod secrets;
mod settings;
mod ssh;
mod ssh_key_setup;
mod system_upgrade;
mod terminal;
mod util;

use error::{internal_error, AppResult};
use models::*;
use tauri::{AppHandle, Emitter, Manager};

async fn block<F, T>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| internal_error(e.to_string()))?
}

fn require_connection(connection_id: &str) -> AppResult<VpsConnectionInput> {
    db::get_vps_connection_input(connection_id).ok_or_else(|| internal_error("连接不存在或已被删除"))
}

/// Electron `resolveStoredPayload`: the renderer only sends the public record
/// (no secrets); backfill password/privateKey/passphrase from the local DB by id.
fn resolve_stored_payload(mut payload: VpsConnectionInput) -> VpsConnectionInput {
    if let Some(id) = payload.id.as_deref() {
        if let Some(secrets) = db::get_connection_secrets(id) {
            if payload.password.as_deref().is_none_or(str::is_empty) {
                payload.password = secrets.password;
            }
            if payload.private_key.as_deref().is_none_or(|s| s.trim().is_empty()) {
                payload.private_key = secrets.private_key;
            }
            if payload.passphrase.is_none() {
                payload.passphrase = secrets.passphrase;
            }
        }
    }
    payload
}

/// Electron `ensureSavedPayload`: keep stored secrets when the form field is
/// empty, drop the credentials not used by the selected auth type.
fn ensure_saved_payload(mut payload: VpsConnectionInput) -> VpsConnectionInput {
    let secrets = payload.id.as_deref().and_then(db::get_connection_secrets);
    if payload.auth_type == "password" {
        if payload.password.as_deref().is_none_or(|s| s.trim().is_empty()) {
            payload.password = secrets.as_ref().and_then(|s| s.password.clone());
        }
        payload.private_key = None;
        payload.passphrase = None;
    } else {
        if payload.private_key.as_deref().is_none_or(|s| s.trim().is_empty()) {
            payload.private_key = secrets.as_ref().and_then(|s| s.private_key.clone());
        }
        if payload.passphrase.is_none() {
            payload.passphrase = secrets.and_then(|s| s.passphrase);
        }
        payload.password = None;
    }
    payload
}

fn require_project(project_id: &str) -> AppResult<LocalProjectRecord> {
    db::get_local_project(project_id).ok_or_else(|| internal_error("项目不存在或已被删除"))
}

// ---------- vps ----------

#[tauri::command]
async fn vps_list() -> AppResult<Vec<VpsConnectionRecord>> {
    block(|| db::list_connections()).await
}

#[tauri::command]
async fn vps_import_local() -> AppResult<Vec<VpsConnectionInput>> {
    block(|| Ok(discovery::discover_local_connections())).await
}

#[tauri::command]
async fn vps_list_ssh_config_candidates() -> AppResult<Vec<SshConfigCandidate>> {
    block(|| Ok(discovery::list_ssh_config_candidates())).await
}

#[tauri::command]
async fn vps_get_raw_ssh_config() -> AppResult<RawSshConfigFile> {
    block(|| Ok(discovery::get_raw_ssh_config())).await
}

#[tauri::command]
async fn vps_save_raw_ssh_config(content: String) -> AppResult<RawSshConfigFile> {
    block(move || discovery::save_raw_ssh_config(&content)).await
}

#[tauri::command]
async fn vps_create_ssh_config_candidate(
    payload: SshConfigMutationInput,
) -> AppResult<Vec<SshConfigCandidate>> {
    block(move || discovery::create_ssh_config_candidate(&payload)).await
}

#[tauri::command]
async fn vps_update_ssh_config_candidate(
    payload: SshConfigMutationInput,
) -> AppResult<Vec<SshConfigCandidate>> {
    block(move || discovery::update_ssh_config_candidate(&payload)).await
}

#[tauri::command]
async fn vps_delete_ssh_config_candidate(
    config_path: String,
    original_name: String,
) -> AppResult<Vec<SshConfigCandidate>> {
    block(move || discovery::delete_ssh_config_candidate(&config_path, &original_name)).await
}

#[tauri::command]
async fn vps_discover_hosts() -> AppResult<Vec<DiscoveredHostCandidate>> {
    block(|| {
        let connections = db::list_connections()?;
        Ok(discovery::discover_known_hosts(
            &connections
                .iter()
                .map(|c| (c.host.clone(), c.port))
                .collect::<Vec<_>>(),
        ))
    })
    .await
}

#[tauri::command]
async fn vps_save(payload: VpsConnectionInput) -> AppResult<VpsConnectionRecord> {
    block(move || db::save_connection(&ensure_saved_payload(payload))).await
}

#[tauri::command]
async fn vps_create_and_install_ssh_key(payload: VpsConnectionInput) -> AppResult<SshKeySetupResult> {
    block(move || ssh_key_setup::create_and_install_ssh_key(&resolve_stored_payload(payload))).await
}

#[tauri::command]
async fn vps_test(payload: VpsConnectionInput) -> AppResult<ConnectionTestResult> {
    block(move || {
        let payload = resolve_stored_payload(payload);
        let result = ssh::test_connection(&payload);
        if let Some(id) = payload.id.as_deref() {
            match &result {
                Ok(r) => {
                    let _ = db::update_connection_health(id, if r.success { "connected" } else { "failed" }, None);
                }
                Err(e) => {
                    let _ = db::update_connection_health(id, "failed", Some(e));
                }
            }
        }
        result
    })
    .await
}

#[tauri::command]
async fn vps_inspect(payload: VpsConnectionInput, force_refresh: Option<bool>) -> AppResult<VpsInspection> {
    block(move || {
        let payload = resolve_stored_payload(payload);
        let result = inspection::inspect_connection(&payload, force_refresh.unwrap_or(false));
        if let Some(id) = payload.id.as_deref() {
            match &result {
                Ok(_) => {
                    let _ = db::update_connection_health(id, "connected", None);
                }
                Err(e) => {
                    let _ = db::update_connection_health(id, "failed", Some(e));
                }
            }
        }
        result
    })
    .await
}

#[tauri::command]
async fn vps_upgrade_check(payload: VpsConnectionInput) -> AppResult<SystemUpgradeCheckResult> {
    block(move || system_upgrade::check_system_upgrades(&resolve_stored_payload(payload))).await
}

#[tauri::command]
async fn vps_upgrade_apply(
    payload: VpsConnectionInput,
    reboot: Option<bool>,
) -> AppResult<SystemUpgradeApplyResult> {
    block(move || {
        system_upgrade::apply_system_upgrade(&resolve_stored_payload(payload), reboot.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn vps_delete(id: String) -> AppResult<()> {
    block(move || db::delete_connection(&id)).await
}

// ---------- remote files ----------

#[tauri::command]
async fn vps_files_browse(
    connection_id: String,
    path: Option<String>,
    force_refresh: Option<bool>,
) -> AppResult<RemoteFileBrowseResult> {
    block(move || {
        let conn = require_connection(&connection_id)?;
        remote_files::browse_remote_files(&conn, path.as_deref(), force_refresh.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn vps_files_read_text(connection_id: String, path: String) -> AppResult<RemoteFileReadResult> {
    block(move || remote_files::read_remote_text_file(&require_connection(&connection_id)?, &path)).await
}

#[tauri::command]
async fn vps_files_stat(connection_id: String, path: String) -> AppResult<RemoteFileStatResult> {
    block(move || remote_files::stat_remote_entry(&require_connection(&connection_id)?, &path)).await
}

#[tauri::command]
async fn vps_files_write_text(
    connection_id: String,
    path: String,
    content: String,
) -> AppResult<RemoteFileMutationResult> {
    block(move || remote_files::write_remote_text_file(&require_connection(&connection_id)?, &path, &content))
        .await
}

#[tauri::command]
async fn vps_files_create_directory(
    connection_id: String,
    parent_path: String,
    directory_name: String,
) -> AppResult<RemoteFileMutationResult> {
    block(move || {
        remote_files::create_remote_directory(&require_connection(&connection_id)?, &parent_path, &directory_name)
    })
    .await
}

#[tauri::command]
async fn vps_files_rename(
    connection_id: String,
    path: String,
    next_name: String,
) -> AppResult<RemoteFileMutationResult> {
    block(move || remote_files::rename_remote_entry(&require_connection(&connection_id)?, &path, &next_name))
        .await
}

#[tauri::command]
async fn vps_files_chmod(
    connection_id: String,
    path: String,
    mode: String,
    recursive: Option<bool>,
) -> AppResult<RemoteFileMutationResult> {
    block(move || {
        remote_files::change_remote_permissions(
            &require_connection(&connection_id)?,
            &path,
            &mode,
            recursive.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn vps_files_delete(connection_id: String, path: String) -> AppResult<RemoteFileMutationResult> {
    block(move || remote_files::delete_remote_entry(&require_connection(&connection_id)?, &path)).await
}

#[tauri::command]
async fn vps_files_trash_list(connection_id: String) -> AppResult<RemoteTrashListResult> {
    block(move || remote_files::list_remote_trash(&require_connection(&connection_id)?)).await
}

#[tauri::command]
async fn vps_files_trash_restore(
    connection_id: String,
    trash_id: String,
) -> AppResult<RemoteFileMutationResult> {
    block(move || remote_files::restore_remote_trash_entry(&require_connection(&connection_id)?, &trash_id))
        .await
}

#[tauri::command]
async fn vps_files_trash_purge(
    connection_id: String,
    trash_id: String,
) -> AppResult<RemoteFileMutationResult> {
    block(move || remote_files::purge_remote_trash_entry(&require_connection(&connection_id)?, &trash_id))
        .await
}

#[tauri::command]
async fn vps_files_upload(
    app: AppHandle,
    connection_id: String,
    remote_path: String,
) -> AppResult<RemoteFileUploadResult> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择要上传的文件或目录")
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let paths = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| internal_error(e.to_string()))?
        .map_err(|e| internal_error(e.to_string()))?;
    let Some(paths) = paths else {
        return Ok(RemoteFileUploadResult {
            ok: true,
            uploaded_count: 0,
            message: "已取消上传".into(),
        });
    };
    let local_paths: Vec<String> = paths
        .iter()
        .filter_map(|p| p.as_path().map(|p| p.to_string_lossy().to_string()))
        .collect();
    block(move || remote_files::upload_paths_via_sftp(&require_connection(&connection_id)?, &remote_path, &local_paths))
        .await
}

#[tauri::command]
async fn vps_files_download(
    app: AppHandle,
    connection_id: String,
    input: RemoteFileDownloadInput,
) -> AppResult<RemoteFileMutationResult> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    if input.entry_type == "directory" {
        app.dialog()
            .file()
            .set_title("选择保存目录")
            .pick_folder(move |p| {
                let _ = tx.send(p.and_then(|p| p.as_path().map(|p| p.to_path_buf())));
            });
    } else {
        app.dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&input.name)
            .save_file(move |p| {
                let _ = tx.send(p.and_then(|p| p.as_path().map(|p| p.to_path_buf())));
            });
    }
    let target = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| internal_error(e.to_string()))?
        .map_err(|e| internal_error(e.to_string()))?;
    let Some(target) = target else {
        return Ok(RemoteFileMutationResult {
            ok: true,
            message: "已取消下载".into(),
            path: String::new(),
        });
    };
    let local_target = if input.entry_type == "directory" {
        target.join(&input.name).to_string_lossy().to_string()
    } else {
        target.to_string_lossy().to_string()
    };
    block(move || remote_files::download_via_sftp(&require_connection(&connection_id)?, &input, &local_target))
        .await
}

// ---------- settings / bitcoin ----------

#[tauri::command]
async fn settings_get_default_remote_directory() -> AppResult<String> {
    block(|| Ok(settings::get_default_remote_directory())).await
}

#[tauri::command]
async fn settings_set_default_remote_directory(value: String) -> AppResult<()> {
    block(move || settings::set_default_remote_directory(&value)).await
}

#[tauri::command]
async fn bitcoin_get_price() -> AppResult<BitcoinPrice> {
    block(|| bitcoin::fetch_bitcoin_price()).await
}

// ---------- terminal ----------

#[tauri::command]
async fn terminal_create(app: AppHandle, payload: TerminalCreateInput) -> AppResult<TerminalCreateResult> {
    let conn = require_connection(&payload.connection_id)?;
    let session_id = tauri::async_runtime::spawn_blocking(move || {
        terminal::create_terminal_session(&app, &conn)
    })
    .await
    .map_err(|e| internal_error(e.to_string()))??;
    Ok(TerminalCreateResult { session_id })
}

#[tauri::command]
fn terminal_write(payload: TerminalWriteInput) -> AppResult<()> {
    terminal::write_terminal_input(&payload.session_id, &payload.data)
}

#[tauri::command]
fn terminal_resize(payload: TerminalResizeInput) -> AppResult<()> {
    terminal::resize_terminal_session(&payload.session_id, payload.cols, payload.rows)
}

#[tauri::command]
fn terminal_close(payload: TerminalCloseInput) -> AppResult<()> {
    terminal::close_terminal_session(&payload.session_id)
}

// ---------- projects: local ----------

#[tauri::command]
async fn projects_list() -> AppResult<Vec<LocalProjectRecord>> {
    block(|| db::list_local_projects()).await
}

#[tauri::command]
async fn projects_add(payload: LocalProjectInput) -> AppResult<LocalProjectRecord> {
    block(move || db::add_local_project_from_path(&payload)).await
}

#[tauri::command]
async fn projects_create_scaffold(
    app: AppHandle,
    payload: ProjectScaffoldInput,
) -> AppResult<ProjectScaffoldResult> {
    block(move || {
        let app2 = app.clone();
        project_scaffold::create_project_scaffold(
            &payload,
            Some(std::sync::Arc::new(move |event| {
                let _ = app2.emit("projects:scaffold-progress", event);
            })),
        )
    })
    .await
}

#[tauri::command]
async fn projects_scan_remote(connection_id: String) -> AppResult<RemoteManagedProjectScanResult> {
    block(move || {
        let conn = require_connection(&connection_id)?;
        Ok(project_remote::scan_remote_managed_projects(&conn))
    })
    .await
}

#[tauri::command]
async fn projects_get_config(project_id: String) -> AppResult<Option<DigwisProjectConfig>> {
    block(move || {
        let project = require_project(&project_id)?;
        Ok(project_scaffold::get_project_config(&project.local_path))
    })
    .await
}

#[tauri::command]
async fn projects_set_runtime_modules(
    payload: ProjectRuntimeModulesUpdateInput,
) -> AppResult<ProjectRuntimeModulesUpdateResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        project_scaffold::set_project_runtime_modules(&project.local_path, &payload.runtime_modules)
    })
    .await
}

#[tauri::command]
async fn projects_update_local_path(
    payload: ProjectLocalPathUpdateInput,
) -> AppResult<LocalProjectRecord> {
    block(move || db::update_local_project_path(&payload.project_id, &payload.local_path)).await
}

#[tauri::command]
async fn projects_delete(payload: ProjectDeleteInput) -> AppResult<ProjectDeleteResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        let local_path = project.local_path.clone();
        let mut removed = false;
        if payload.remove_local_directory.unwrap_or(false) {
            project_local::stop_local_runtime_if_present(&local_path);
            removed = project_local::remove_local_directory_strict(&local_path)?;
        }
        db::delete_local_project(&payload.project_id)?;
        Ok(ProjectDeleteResult {
            success: true,
            removed_local_directory: removed,
            local_path: Some(local_path),
        })
    })
    .await
}

#[tauri::command]
async fn projects_list_npm_scripts(project_id: String) -> AppResult<Vec<String>> {
    block(move || {
        let names = db::get_local_project(&project_id)
            .map(|p| project_local::read_package_json_script_names(&p.local_path))
            .unwrap_or_default();
        Ok(names)
    })
    .await
}

#[tauri::command]
async fn projects_get_local_preview(project_id: String) -> AppResult<ProjectLocalPreview> {
    block(move || {
        let project = require_project(&project_id)?;
        Ok(project_local::resolve_project_local_preview(&project.local_path))
    })
    .await
}

#[tauri::command]
async fn projects_open_local_preview(app: AppHandle, project_id: String) -> AppResult<ProjectLocalPreview> {
    let preview = block(move || {
        let project = require_project(&project_id)?;
        Ok(project_local::resolve_project_local_preview(&project.local_path))
    })
    .await?;
    tauri_plugin_opener::open_url(&preview.url, None::<&str>)
        .map_err(|e| internal_error(e.to_string()))?;
    let _ = app;
    Ok(preview)
}

#[tauri::command]
async fn projects_open_local_admin(project_id: String) -> AppResult<ProjectLocalPreview> {
    let preview = block(move || {
        let project = require_project(&project_id)?;
        Ok(project_local::resolve_project_local_preview(&project.local_path))
    })
    .await?;
    let admin = preview
        .admin_url
        .clone()
        .unwrap_or_else(|| format!("{}/admin", preview.url.trim_end_matches('/')));
    tauri_plugin_opener::open_url(&admin, None::<&str>).map_err(|e| internal_error(e.to_string()))?;
    Ok(preview)
}

#[tauri::command]
async fn projects_start_local_dev(project_id: String) -> AppResult<ProjectLocalDevStartResult> {
    block(move || {
        let project = require_project(&project_id)?;
        let preview = project_local::resolve_project_local_preview(&project.local_path);
        if !std::path::Path::new(&preview.web_path).exists() {
            return Err(internal_error(format!("本地 Web 目录不存在：{}", preview.web_path)));
        }
        project_local::repair_project_native_modules(&project.local_path);
        let started = project_local::start_local_dev_detached(&project.local_path, &preview.web_path)?;
        let detected = project_local::wait_for_preview_url_from_log(&started.log_path, 20_000);
        let next_preview_url = detected.unwrap_or_else(|| preview.url.clone());
        let next_admin_url = project_local::resolve_admin_url_from_preview(
            &next_preview_url,
            preview.admin_url.as_deref(),
        );
        let _ = project_local::write_project_local_runtime(
            &project.local_path,
            Some(next_preview_url.clone()),
            Some(next_admin_url),
            started.pid,
            Some(started.log_path.clone()),
        );
        Ok(ProjectLocalDevStartResult {
            ok: true,
            message: "已在后台启动本地开发服务".into(),
            pid: started.pid,
            preview_url: next_preview_url,
        })
    })
    .await
}

#[tauri::command]
async fn projects_start_local_admin_service(project_id: String) -> AppResult<ProjectLocalAdminStartResult> {
    block(move || {
        let project = require_project(&project_id)?;
        let preview = project_local::resolve_project_local_preview(&project.local_path);
        Ok(project_local::start_local_admin_service(&project.local_path, &preview))
    })
    .await
}

#[tauri::command]
async fn projects_check_url_reachable(url: String) -> AppResult<ProjectUrlReachabilityResult> {
    if url.trim().is_empty() {
        return Err(internal_error("URL 不能为空"));
    }
    let url = url.trim().to_string();
    block(move || Ok(project_local::check_url_reachable(&url, 0))).await
}

#[tauri::command]
async fn projects_open_client_app_path(payload: ProjectClientAppInput) -> AppResult<ProjectClientAppOpenResult> {
    let (absolute_path, target) = block(move || {
        let project = require_project(&payload.project_id)?;
        let (_app, absolute_path) =
            project_local::resolve_project_client_app(&project.local_path, &payload.target)?;
        if !std::path::Path::new(&absolute_path).exists() {
            return Err(internal_error(format!("客户端目录不存在：{}", absolute_path)));
        }
        Ok((absolute_path, payload.target.clone()))
    })
    .await?;
    tauri_plugin_opener::open_path(&absolute_path, None::<&str>)
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(ProjectClientAppOpenResult {
        ok: true,
        target,
        path: absolute_path,
    })
}

#[tauri::command]
async fn projects_start_client_app(payload: ProjectClientAppInput) -> AppResult<ProjectClientAppStartResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        let (app, absolute_path) =
            project_local::resolve_project_client_app(&project.local_path, &payload.target)?;
        if !std::path::Path::new(&absolute_path).exists() {
            return Err(internal_error(format!("客户端目录不存在：{}", absolute_path)));
        }
        let dev_command = app
            .dev_command
            .clone()
            .filter(|c| !c.trim().is_empty())
            .ok_or_else(|| internal_error("当前客户端骨架没有可直接启动的 dev 命令"))?;
        let started = project_local::start_client_app_detached(
            &project.local_path,
            &payload.target,
            &absolute_path,
            &dev_command,
        )?;
        Ok(ProjectClientAppStartResult {
            ok: true,
            message: "已在后台启动客户端".into(),
            target: payload.target.clone(),
            path: absolute_path,
            pid: started.pid,
        })
    })
    .await
}

#[tauri::command]
async fn projects_open_client_app_ide(
    payload: ProjectClientAppInput,
) -> AppResult<ProjectClientAppIdeOpenResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        project_local::open_client_app_ide(&project.local_path, &payload.target)
    })
    .await
}

// ---------- projects: deploy / remote ----------

fn deploy_log_emit(app: &AppHandle, project_id: &str, script: Option<&str>, stream: &str, chunk: &str) {
    let entry = ProjectDeployLogEvent {
        project_id: project_id.to_string(),
        script: script.map(String::from),
        stream: stream.to_string(),
        chunk: chunk.to_string(),
        at: util::now_iso(),
    };
    let _ = project_local::append_operation_log(
        project_id,
        stream,
        chunk,
        Some(entry.at.clone()),
    );
    let _ = app.emit("projects:deploy-log", &entry);
}

#[tauri::command]
async fn projects_get_deploy_profile(project_id: String) -> AppResult<ProjectDeployProfile> {
    block(move || {
        match db::get_local_project(&project_id) {
            Some(p) => Ok(project_local::read_project_deploy_profile(&p.local_path)),
            None => Ok(ProjectDeployProfile {
                npm_scripts: vec![],
                recommended_strategy: "sftp".into(),
                recommended_npm_script: None,
                can_initialize: false,
                config_path: None,
                config_error: Some("项目不存在或已被删除".into()),
                default_remote_app_dir: None,
                default_remote_service: None,
                default_public_check_url: None,
            }),
        }
    })
    .await
}

#[tauri::command]
async fn projects_get_remote_state(
    project_id: String,
    connection_id: String,
) -> AppResult<ProjectRemoteState> {
    block(move || {
        let project = require_project(&project_id)?;
        let conn = require_connection(&connection_id)?;
        let config = project_local::read_project_deploy_config(&project.local_path)
            .ok_or_else(|| internal_error("项目缺少 openvps.deploy.json"))?;
        project_remote::inspect_project_remote_state(&conn, &config)
    })
    .await
}

#[tauri::command]
async fn projects_get_remote_details(
    payload: ProjectRemoteDetailsInput,
) -> AppResult<ProjectRemoteDetails> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        let conn = require_connection(&payload.connection_id)?;
        let config = project_local::read_project_deploy_config(&project.local_path);
        let remote_app_dir = project
            .last_remote_path
            .clone()
            .or_else(|| config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.remote_app_dir.clone()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| internal_error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录"))?;
        let remote_service = config
            .as_ref()
            .and_then(|c| c.deploy.as_ref())
            .and_then(|d| d.remote_service.clone())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        project_remote::get_project_remote_details(
            &project.id,
            &conn,
            &remote_app_dir,
            remote_service.as_deref(),
            payload.browse_path.as_deref(),
            payload.force_refresh.unwrap_or(false),
        )
    })
    .await
}

fn env_remote_app_dir(project: &LocalProjectRecord) -> AppResult<String> {
    project_local::read_project_deploy_config(&project.local_path)
        .and_then(|c| c.deploy.and_then(|d| d.remote_app_dir))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| internal_error("项目未配置 deploy.remoteAppDir"))
}

#[tauri::command]
async fn projects_get_env(project_id: String, connection_id: String) -> AppResult<ProjectEnvResult> {
    block(move || {
        let dir = env_remote_app_dir(&require_project(&project_id)?)?;
        project_remote::read_project_env_file(&require_connection(&connection_id)?, &dir)
    })
    .await
}

#[tauri::command]
async fn projects_save_env(payload: ProjectEnvUpdateInput) -> AppResult<ProjectEnvResult> {
    block(move || {
        let dir = env_remote_app_dir(&require_project(&payload.project_id)?)?;
        project_remote::save_project_env_file(&require_connection(&payload.connection_id)?, &dir, &payload.content)
    })
    .await
}

#[tauri::command]
async fn projects_rotate_secret(project_id: String, connection_id: String) -> AppResult<ProjectEnvResult> {
    block(move || {
        let dir = env_remote_app_dir(&require_project(&project_id)?)?;
        project_remote::rotate_project_session_secret(&require_connection(&connection_id)?, &dir)
    })
    .await
}

fn remote_service_name(project: &LocalProjectRecord) -> AppResult<String> {
    project_local::read_project_deploy_config(&project.local_path)
        .and_then(|c| c.deploy.and_then(|d| d.remote_service))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| internal_error("项目未配置 deploy.remoteService"))
}

#[tauri::command]
async fn projects_restart_service(project_id: String, connection_id: String) -> AppResult<ProjectEnvResult> {
    block(move || {
        let svc = remote_service_name(&require_project(&project_id)?)?;
        project_remote::control_project_remote_service(&require_connection(&connection_id)?, &svc, "restart")
    })
    .await
}

#[tauri::command]
async fn projects_stop_service(project_id: String, connection_id: String) -> AppResult<ProjectEnvResult> {
    block(move || {
        let svc = remote_service_name(&require_project(&project_id)?)?;
        project_remote::control_project_remote_service(&require_connection(&connection_id)?, &svc, "stop")
    })
    .await
}

#[tauri::command]
async fn projects_save_site_settings(
    payload: ProjectSiteSettingsInput,
) -> AppResult<ProjectSiteSettingsResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        let conn = require_connection(&payload.connection_id)?;
        let config = project_local::read_project_deploy_config(&project.local_path);
        let remote_app_dir = project
            .last_remote_path
            .clone()
            .or_else(|| config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.remote_app_dir.clone()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| internal_error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录"))?;
        let remote_service = config
            .as_ref()
            .and_then(|c| c.deploy.as_ref())
            .and_then(|d| d.remote_service.clone())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let details = project_remote::get_project_remote_details(
            &project.id,
            &conn,
            &remote_app_dir,
            remote_service.as_deref(),
            None,
            true,
        )?;
        project_remote::apply_project_site_settings(
            &conn,
            &project_remote::ApplySiteOptions {
                project_id: project.id.clone(),
                remote_app_dir,
                app_port: details.app_port,
                domain: payload.domain,
                ssl_email: payload.ssl_email,
                certificate_pem: payload.certificate_pem,
                private_key_pem: payload.private_key_pem,
            },
        )
    })
    .await
}

#[tauri::command]
async fn projects_initialize(project_id: String, connection_id: String) -> AppResult<ProjectDeployResult> {
    block(move || {
        let project = require_project(&project_id)?;
        let conn = require_connection(&connection_id)?;
        let config = project_local::read_project_deploy_config(&project.local_path);
        if config.as_ref().and_then(|c| c.init.as_ref()).is_none() {
            return Err(internal_error("该项目未配置远端初始化模板（缺少 openvps.deploy.json 中的 init 段）"));
        }
        let config = config.unwrap();
        let _ = project_local::append_operation_log(&project.id, "system", "[start] initialize remote project\n", None);
        let result = project_remote::initialize_project_on_vps(&conn, &config)?;
        let _ = project_local::append_operation_log(
            &project.id,
            if result.ok { "system" } else { "stderr" },
            &format!(
                "[finish] initialize {} ({}s)\n{}\n",
                if result.ok { "success" } else { "failed" },
                result.duration_ms / 1000,
                result.message
            ),
            None,
        );
        let _ = db::update_local_project_deploy_result(
            &project.id,
            &connection_id,
            result.remote_path.as_deref(),
            if result.ok { "success" } else { "failed" },
            &result.message,
            Some("local-npm-script"),
        );
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn projects_pick_directory(app: AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择本地项目根目录")
        .pick_folder(move |p| {
            let _ = tx.send(p);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| internal_error(e.to_string()))?
        .map_err(|e| internal_error(e.to_string()))?;
    Ok(picked.and_then(|p| p.as_path().map(|p| p.to_string_lossy().to_string())))
}

#[tauri::command]
async fn projects_deploy(app: AppHandle, payload: ProjectDeployInput) -> AppResult<ProjectDeployResult> {
    block(move || {
        let project = require_project(&payload.project_id)?;
        let conn = require_connection(&payload.connection_id)?;
        let conn_id = conn.id.clone().unwrap_or_else(|| payload.connection_id.clone());
        let strategy = payload.strategy.clone().unwrap_or_else(|| "sftp".into());

        if strategy == "local-npm-script" {
            let profile = project_local::read_project_deploy_profile(&project.local_path);
            let config = project_local::read_project_deploy_config(&project.local_path);
            let script = payload
                .npm_script
                .clone()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| profile.recommended_npm_script.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
                .ok_or_else(|| internal_error("请选择要运行的 npm 脚本"))?;
            deploy_log_emit(&app, &project.id, Some(&script), "system", &format!("[start] npm run {script}\n"));
            let app2 = app.clone();
            let pid2 = project.id.clone();
            let script2 = script.clone();
            let deploy_cfg = config.as_ref().and_then(|c| c.deploy.as_ref());
            let env = project_local::build_project_script_env(
                &project.id,
                &project.local_path,
                &conn,
                deploy_cfg.and_then(|d| d.remote_app_dir.as_deref()).map(str::trim).filter(|s| !s.is_empty()),
                deploy_cfg.and_then(|d| d.remote_service.as_deref()).map(str::trim).filter(|s| !s.is_empty()),
                deploy_cfg.and_then(|d| d.public_check_url.as_deref()).map(str::trim).filter(|s| !s.is_empty()),
                deploy_cfg.and_then(|d| d.env.as_ref()),
            );
            let timeout = if script == "sync:vps:uploads" || script == "sync:uploads:vps" {
                Some(3 * 60 * 60 * 1000)
            } else {
                None
            };
            let result = project_local::run_local_npm_script(
                &project.local_path,
                &script,
                Some(&env),
                timeout,
                Some(std::sync::Arc::new(move |chunk: &str, stream: &str| {
                    deploy_log_emit(&app2, &pid2, Some(&script2), stream, chunk);
                })),
            );
            deploy_log_emit(
                &app,
                &project.id,
                Some(&script),
                "system",
                &format!(
                    "[finish] {} ({}s)\n",
                    if result.ok { "success" } else { "failed" },
                    result.duration_ms / 1000
                ),
            );
            if result.ok {
                if let Some(action) = project_local::resolve_action_kind_from_script(Some(&script)) {
                    if action == "data" {
                        let marker = project_local::read_local_postgres_lsn(&project.local_path);
                        project_local::mark_project_action_run(&project.id, action, marker);
                    } else {
                        project_local::mark_project_action_run(&project.id, action, None);
                    }
                }
            }
            let _ = db::update_local_project_deploy_result(
                &project.id,
                &conn_id,
                result
                    .remote_path
                    .as_deref()
                    .or_else(|| config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.remote_app_dir.as_deref()).map(|s| s.trim()).filter(|s| !s.is_empty())),
                if result.ok { "success" } else { "failed" },
                &result.message,
                Some("local-npm-script"),
            );
            return Ok(result);
        }

        let remote_deploy_path = match project_remote::resolve_remote_deploy_path_for_project(
            &conn,
            &project.id,
            payload.remote_parent_path.as_deref(),
        ) {
            Ok(p) => p,
            Err(message) => {
                let _ = db::update_local_project_deploy_result(
                    &project.id,
                    &conn_id,
                    None,
                    "failed",
                    &message,
                    Some("sftp"),
                );
                return Ok(ProjectDeployResult {
                    ok: false,
                    message,
                    duration_ms: 0,
                    remote_path: None,
                    kind: Some("sftp".into()),
                });
            }
        };
        let result = project_remote::deploy_local_project_to_vps(&conn, &project.local_path, &remote_deploy_path);
        let _ = db::update_local_project_deploy_result(
            &project.id,
            &conn_id,
            result.remote_path.as_deref(),
            if result.ok { "success" } else { "failed" },
            &result.message,
            Some("sftp"),
        );
        if result.ok {
            project_local::mark_project_action_run(&project.id, "code", None);
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn projects_get_action_hints(project_id: String) -> AppResult<ProjectActionHints> {
    block(move || {
        let project = require_project(&project_id)?;
        Ok(project_local::inspect_project_action_hints(&project))
    })
    .await
}

#[tauri::command]
async fn projects_migrate(payload: ProjectMigrationInput) -> AppResult<ProjectMigrationResult> {
    block(move || {
        if payload.source_connection_id == payload.target_connection_id {
            return Err(internal_error("迁移目标必须是另一台服务器"));
        }
        let project = require_project(&payload.project_id)?;
        let source = require_connection(&payload.source_connection_id)?;
        let target = require_connection(&payload.target_connection_id)?;
        let config = project_local::read_project_deploy_config(&project.local_path);
        let remote_app_dir = project
            .last_remote_path
            .clone()
            .or_else(|| config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.remote_app_dir.clone()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| internal_error("项目未配置 deploy.remoteAppDir，且还没有记录远端部署目录"))?;
        let _ = project_local::append_operation_log(
            &project.id,
            "system",
            &format!("[start] migrate project to {}\n", target.name),
            None,
        );
        let result = project_remote::migrate_project_between_servers(
            &project.id,
            config.as_ref(),
            &source,
            &target,
            &remote_app_dir,
        );
        let _ = project_local::append_operation_log(
            &project.id,
            if result.ok { "system" } else { "stderr" },
            &format!(
                "[finish] {} ({}s)\n{}\n",
                if result.ok { "success" } else { "failed" },
                result.duration_ms / 1000,
                result.message
            ),
            None,
        );
        if result.ok {
            let kind = project
                .last_deploy_kind
                .clone()
                .or_else(|| config.as_ref().and_then(|c| c.deploy.as_ref()).and_then(|d| d.strategy.clone()))
                .unwrap_or_else(|| "local-npm-script".into());
            let _ = db::update_local_project_deploy_result(
                &project.id,
                &payload.target_connection_id,
                result.target_remote_path.as_deref().or(Some(remote_app_dir.as_str())),
                "success",
                &result.message,
                Some(&kind),
            );
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn projects_list_operation_logs(limit: Option<u32>) -> AppResult<Vec<ProjectOperationLogEntry>> {
    block(move || Ok(project_local::list_operation_logs(limit))).await
}

#[tauri::command]
async fn projects_append_operation_log(
    payload: ProjectOperationLogAppendInput,
) -> AppResult<ProjectOperationLogEntry> {
    block(move || {
        require_project(&payload.project_id)?;
        project_local::append_operation_log(&payload.project_id, &payload.stream, &payload.chunk, None)
    })
    .await
}

// ---------- app ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let _ = db::initialize_database();
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vps_list,
            vps_import_local,
            vps_list_ssh_config_candidates,
            vps_get_raw_ssh_config,
            vps_save_raw_ssh_config,
            vps_create_ssh_config_candidate,
            vps_update_ssh_config_candidate,
            vps_delete_ssh_config_candidate,
            vps_discover_hosts,
            vps_save,
            vps_create_and_install_ssh_key,
            vps_files_browse,
            vps_files_read_text,
            vps_files_stat,
            vps_files_write_text,
            vps_files_create_directory,
            vps_files_rename,
            vps_files_chmod,
            vps_files_delete,
            vps_files_trash_list,
            vps_files_trash_restore,
            vps_files_trash_purge,
            vps_files_upload,
            vps_files_download,
            vps_test,
            vps_inspect,
            vps_upgrade_check,
            vps_upgrade_apply,
            vps_delete,
            settings_get_default_remote_directory,
            settings_set_default_remote_directory,
            bitcoin_get_price,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            projects_list,
            projects_add,
            projects_create_scaffold,
            projects_scan_remote,
            projects_get_config,
            projects_set_runtime_modules,
            projects_update_local_path,
            projects_delete,
            projects_list_npm_scripts,
            projects_get_local_preview,
            projects_open_local_preview,
            projects_open_local_admin,
            projects_start_local_dev,
            projects_start_local_admin_service,
            projects_check_url_reachable,
            projects_open_client_app_path,
            projects_start_client_app,
            projects_open_client_app_ide,
            projects_get_deploy_profile,
            projects_get_remote_state,
            projects_get_remote_details,
            projects_get_env,
            projects_save_env,
            projects_rotate_secret,
            projects_restart_service,
            projects_stop_service,
            projects_save_site_settings,
            projects_initialize,
            projects_pick_directory,
            projects_deploy,
            projects_get_action_hints,
            projects_migrate,
            projects_list_operation_logs,
            projects_append_operation_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DigVPS");
}
