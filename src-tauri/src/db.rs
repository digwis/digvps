//! SQLite layer — rusqlite port of `src/main/services/db.ts`.
//! Same file (`openvps.sqlite`), same schema, same dedup/migration logic.

use crate::error::{internal_error, AppResult};
use crate::models::{LocalProjectInput, LocalProjectRecord, VpsConnectionInput, VpsConnectionRecord};
use crate::secrets::{decrypt_secret, encrypt_secret};
use crate::util::{now_iso, random_uuid, user_data_dir};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static DB: LazyLock<Mutex<Option<Connection>>> = LazyLock::new(|| Mutex::new(None));

fn with_db<T>(f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
    let guard = DB.lock().map_err(|_| internal_error("数据库锁获取失败"))?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| internal_error("Database not initialized"))?;
    f(conn)
}

fn with_db_mut<T>(f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
    let mut guard = DB.lock().map_err(|_| internal_error("数据库锁获取失败"))?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| internal_error("Database not initialized"))?;
    f(conn)
}

fn normalize_identity(value: &str) -> String {
    value.trim().to_lowercase()
}

#[derive(Debug, Clone)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub provider: Option<String>,
    pub location_label: Option<String>,
    pub expires_at: Option<String>,
    pub auth_type: String,
    pub source: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
    pub last_connected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl ConnectionRow {
    fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            host: row.get("host")?,
            port: row.get("port")?,
            username: row.get("username")?,
            provider: row.get("provider")?,
            location_label: row.get("location_label")?,
            expires_at: row.get("expires_at")?,
            auth_type: row.get("auth_type")?,
            source: row.get("source")?,
            password: row.get("password")?,
            private_key: row.get("private_key")?,
            passphrase: row.get("passphrase")?,
            status: row.get("status")?,
            last_error: row.get("last_error")?,
            last_connected_at: row.get("last_connected_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

fn map_record(row: &ConnectionRow) -> VpsConnectionRecord {
    VpsConnectionRecord {
        id: row.id.clone(),
        name: row.name.clone(),
        host: row.host.clone(),
        port: row.port as u16,
        username: row.username.clone(),
        provider: row.provider.clone(),
        location_label: row.location_label.clone(),
        expires_at: row.expires_at.clone(),
        auth_type: row.auth_type.clone(),
        source: Some(row.source.clone()),
        status: row.status.clone(),
        last_error: row.last_error.clone(),
        last_connected_at: row.last_connected_at.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn normalize_duplicate_connections(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn
        .prepare(
            "SELECT host, port, username, COUNT(*) AS duplicate_count
             FROM vps_connections
             GROUP BY lower(trim(host)), port, lower(trim(username))
             HAVING COUNT(*) > 1",
        )
        .ipc()?;
    let duplicates: Vec<(String, i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .ipc()?
        .filter_map(|r| r.ok())
        .collect();
    if duplicates.is_empty() {
        return Ok(());
    }

    for (host, port, username) in duplicates {
        let mut pick = conn
            .prepare(
                "SELECT vc.*,
                    (SELECT COUNT(*) FROM local_projects lp WHERE lp.last_connection_id = vc.id)
                        AS project_count
                 FROM vps_connections vc
                 WHERE lower(trim(vc.host)) = ?1
                   AND vc.port = ?2
                   AND lower(trim(vc.username)) = ?3
                 ORDER BY project_count DESC, created_at ASC, updated_at DESC",
            )
            .ipc()?;
        let rows: Vec<ConnectionRow> = pick
            .query_map(
                params![normalize_identity(&host), port, normalize_identity(&username)],
                |r| ConnectionRow::from_row(r),
            )
            .ipc()?
            .filter_map(|r| r.ok())
            .collect();
        let Some(canonical) = rows.first().cloned() else { continue };
        // Latest row by updated_at/created_at supplies fresh values.
        let latest = rows
            .iter()
            .max_by(|a, b| {
                a.updated_at
                    .cmp(&b.updated_at)
                    .then(a.created_at.cmp(&b.created_at))
            })
            .cloned()
            .unwrap_or_else(|| canonical.clone());

        conn.execute(
            "UPDATE vps_connections SET
                name=?1, host=?2, port=?3, username=?4, provider=?5, location_label=?6,
                expires_at=?7, auth_type=?8, source=?9, password=?10, private_key=?11,
                passphrase=?12, status=?13, last_error=?14, last_connected_at=?15, updated_at=?16
             WHERE id=?17",
            params![
                latest.name, latest.host, latest.port, latest.username, latest.provider,
                latest.location_label, latest.expires_at, latest.auth_type, latest.source,
                latest.password, latest.private_key, latest.passphrase, latest.status,
                latest.last_error, latest.last_connected_at, latest.updated_at, canonical.id,
            ],
        )
        .ipc()?;

        for row in rows.iter().skip(1) {
            conn.execute(
                "UPDATE local_projects SET last_connection_id = ?1 WHERE last_connection_id = ?2",
                params![canonical.id, row.id],
            )
            .ipc()?;
            conn.execute("DELETE FROM vps_connections WHERE id = ?1", params![row.id])
                .ipc()?;
        }
    }
    Ok(())
}

use crate::error::ToIpc;

pub fn initialize_database() -> AppResult<PathBuf> {
    let dir = user_data_dir();
    std::fs::create_dir_all(&dir).ipc_msg("无法创建数据目录")?;
    let db_path = dir.join("openvps.sqlite");
    let conn = Connection::open(&db_path).ipc_msg("无法打开数据库")?;
    conn.pragma_update(None, "journal_mode", "WAL").ipc()?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vps_connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            provider TEXT,
            location_label TEXT,
            expires_at TEXT,
            auth_type TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            password TEXT,
            private_key TEXT,
            passphrase TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            last_error TEXT,
            last_connected_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .ipc()?;

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(vps_connections)")
        .ipc()?
        .query_map([], |r| r.get::<_, String>(1))
        .ipc()?
        .filter_map(|r| r.ok())
        .collect();
    for (col, ddl) in [
        ("source", "ALTER TABLE vps_connections ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"),
        ("provider", "ALTER TABLE vps_connections ADD COLUMN provider TEXT"),
        ("location_label", "ALTER TABLE vps_connections ADD COLUMN location_label TEXT"),
        ("expires_at", "ALTER TABLE vps_connections ADD COLUMN expires_at TEXT"),
    ] {
        if !columns.iter().any(|c| c == col) {
            conn.execute_batch(ddl).ipc()?;
        }
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_projects (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            local_path TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL DEFAULT 'local-dev',
            last_connection_id TEXT,
            last_remote_path TEXT,
            last_deploy_at TEXT,
            last_deploy_status TEXT NOT NULL DEFAULT 'none',
            last_deploy_message TEXT,
            last_deploy_kind TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .ipc()?;
    let lp_columns: Vec<String> = conn
        .prepare("PRAGMA table_info(local_projects)")
        .ipc()?
        .query_map([], |r| r.get::<_, String>(1))
        .ipc()?
        .filter_map(|r| r.ok())
        .collect();
    if !lp_columns.iter().any(|c| c == "last_deploy_kind") {
        conn.execute_batch("ALTER TABLE local_projects ADD COLUMN last_deploy_kind TEXT")
            .ipc()?;
    }

    normalize_duplicate_connections(&conn)?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .ipc()?;

    *DB.lock().map_err(|_| internal_error("数据库锁获取失败"))? = Some(conn);
    Ok(db_path)
}

pub fn get_app_setting(key: &str) -> Option<String> {
    with_db(|conn| {
        let value: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .ok();
        Ok(value)
    })
    .ok()
    .flatten()
}

pub fn set_app_setting(key: &str, value: &str) -> AppResult<()> {
    with_db(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_iso()],
        )
        .ipc()?;
        Ok(())
    })
}

pub fn list_connections() -> AppResult<Vec<VpsConnectionRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT * FROM vps_connections
                 ORDER BY CASE status WHEN 'connected' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
                 updated_at DESC",
            )
            .ipc()?;
        let rows: Vec<VpsConnectionRecord> = stmt
            .query_map([], |r| ConnectionRow::from_row(r))
            .ipc()?
            .filter_map(|r| r.ok())
            .map(|row| map_record(&row))
            .collect();
        Ok(rows)
    })
}

fn encrypt_opt(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        if v.is_empty() {
            None
        } else {
            Some(encrypt_secret(v))
        }
    })
}

pub fn save_connection(record: &VpsConnectionInput) -> AppResult<VpsConnectionRecord> {
    with_db_mut(|conn| {
        let now = now_iso();
        let target_id: String = {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM vps_connections
                     WHERE lower(trim(host)) = ?1 AND port = ?2 AND lower(trim(username)) = ?3
                     ORDER BY created_at ASC LIMIT 1",
                    params![
                        normalize_identity(&record.host),
                        record.port as i64,
                        normalize_identity(&record.username)
                    ],
                    |r| r.get(0),
                )
                .ok();
            existing.unwrap_or_else(|| record.id.clone().unwrap_or_else(random_uuid))
        };
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM vps_connections WHERE id = ?1",
                params![target_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| now.clone());

        conn.execute(
            "INSERT INTO vps_connections (
                id, name, host, port, username, provider, location_label, auth_type,
                password, private_key, passphrase, expires_at, source, status,
                last_error, last_connected_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'idle', NULL, NULL, ?14, ?15
             )
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                provider = excluded.provider,
                location_label = excluded.location_label,
                expires_at = excluded.expires_at,
                auth_type = excluded.auth_type,
                source = excluded.source,
                password = excluded.password,
                private_key = excluded.private_key,
                passphrase = excluded.passphrase,
                updated_at = excluded.updated_at",
            params![
                target_id,
                record.name,
                record.host,
                record.port as i64,
                record.username,
                record.provider.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                record.location_label.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                record.auth_type,
                encrypt_opt(record.password.as_deref()),
                encrypt_opt(record.private_key.as_deref()),
                encrypt_opt(record.passphrase.as_deref()),
                record.expires_at.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                record.source.as_deref().unwrap_or("manual"),
                created_at,
                now,
            ],
        )
        .ipc()?;

        let row = conn
            .query_row(
                "SELECT * FROM vps_connections WHERE id = ?1",
                params![target_id],
                |r| ConnectionRow::from_row(r),
            )
            .ipc()?;
        Ok(map_record(&row))
    })
}

pub struct ConnectionSecrets {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

pub fn get_connection_secrets(id: &str) -> Option<ConnectionSecrets> {
    with_db(|conn| {
        let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT password, private_key, passphrase FROM vps_connections WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        Ok(row.map(|(password, private_key, passphrase)| ConnectionSecrets {
            password: password.as_deref().and_then(decrypt_secret),
            private_key: private_key.as_deref().and_then(decrypt_secret),
            passphrase: passphrase.as_deref().and_then(decrypt_secret),
        }))
    })
    .ok()
    .flatten()
}

pub fn update_connection_health(id: &str, status: &str, last_error: Option<&str>) -> AppResult<()> {
    with_db(|conn| {
        conn.execute(
            "UPDATE vps_connections SET
                status = ?1,
                last_error = ?2,
                last_connected_at = CASE WHEN ?1 = 'connected' THEN ?3 ELSE last_connected_at END,
                updated_at = ?3
             WHERE id = ?4",
            params![status, last_error, now_iso(), id],
        )
        .ipc()?;
        Ok(())
    })
}

pub fn delete_connection(id: &str) -> AppResult<()> {
    with_db(|conn| {
        conn.execute("DELETE FROM vps_connections WHERE id = ?1", params![id])
            .ipc()?;
        Ok(())
    })
}

pub fn get_vps_connection_input(id: &str) -> Option<VpsConnectionInput> {
    let row = with_db(|conn| {
        conn.query_row(
            "SELECT * FROM vps_connections WHERE id = ?1",
            params![id],
            |r| ConnectionRow::from_row(r),
        )
        .ipc()
    })
    .ok()?;
    let secrets = get_connection_secrets(&row.id);
    Some(VpsConnectionInput {
        id: Some(row.id),
        name: row.name,
        host: row.host,
        port: row.port as u16,
        username: row.username,
        provider: row.provider,
        location_label: row.location_label,
        expires_at: row.expires_at,
        auth_type: row.auth_type,
        password: secrets.as_ref().and_then(|s| s.password.clone()),
        private_key: secrets.as_ref().and_then(|s| s.private_key.clone()),
        passphrase: secrets.as_ref().and_then(|s| s.passphrase.clone()),
        source: Some(row.source),
    })
}

// ---------- local projects ----------

#[derive(Debug, Clone)]
pub struct LocalProjectRow {
    pub id: String,
    pub display_name: String,
    pub local_path: String,
    pub category: String,
    pub last_connection_id: Option<String>,
    pub last_remote_path: Option<String>,
    pub last_deploy_at: Option<String>,
    pub last_deploy_status: String,
    pub last_deploy_message: Option<String>,
    pub last_deploy_kind: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl LocalProjectRow {
    fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            display_name: row.get("display_name")?,
            local_path: row.get("local_path")?,
            category: row.get("category")?,
            last_connection_id: row.get("last_connection_id")?,
            last_remote_path: row.get("last_remote_path")?,
            last_deploy_at: row.get("last_deploy_at")?,
            last_deploy_status: row.get("last_deploy_status")?,
            last_deploy_message: row.get("last_deploy_message")?,
            last_deploy_kind: row.get("last_deploy_kind")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

fn map_local_project(row: &LocalProjectRow) -> LocalProjectRecord {
    LocalProjectRecord {
        id: row.id.clone(),
        display_name: row.display_name.clone(),
        local_path: row.local_path.clone(),
        category: row.category.clone(),
        last_connection_id: row.last_connection_id.clone(),
        last_remote_path: row.last_remote_path.clone(),
        last_deploy_at: row.last_deploy_at.clone(),
        last_deploy_status: row.last_deploy_status.clone(),
        last_deploy_message: row.last_deploy_message.clone(),
        last_deploy_kind: row.last_deploy_kind.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

pub fn list_local_projects() -> AppResult<Vec<LocalProjectRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT * FROM local_projects ORDER BY updated_at DESC")
            .ipc()?;
        let rows = stmt
            .query_map([], |r| LocalProjectRow::from_row(r))
            .ipc()?
            .filter_map(|r| r.ok())
            .map(|row| map_local_project(&row))
            .collect();
        Ok(rows)
    })
}

pub fn get_local_project(id: &str) -> Option<LocalProjectRecord> {
    with_db(|conn| {
        conn.query_row(
            "SELECT * FROM local_projects WHERE id = ?1",
            params![id],
            |r| LocalProjectRow::from_row(r),
        )
        .ipc()
    })
    .ok()
    .map(|row| map_local_project(&row))
}

pub fn add_local_project_from_path(payload: &LocalProjectInput) -> AppResult<LocalProjectRecord> {
    let resolved = std::fs::canonicalize(payload.local_path.trim())
        .map_err(|_| internal_error("本地路径不存在或无法访问"))?;
    if !resolved.is_dir() {
        return Err(internal_error("请选择文件夹（目录）作为项目根路径"));
    }
    let resolved_str = resolved.to_string_lossy().to_string();
    let display_name = payload
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(200).collect::<String>())
        .unwrap_or_else(|| {
            resolved
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string())
        });
    let category = payload.category.clone().unwrap_or_else(|| "local-dev".to_string());
    let id = random_uuid();
    let now = now_iso();

    with_db_mut(|conn| {
        conn.execute(
            "INSERT INTO local_projects (
                id, display_name, local_path, category,
                last_connection_id, last_remote_path, last_deploy_at,
                last_deploy_status, last_deploy_message, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, 'none', NULL, ?5, ?6)",
            params![id, display_name, resolved_str, category, now, now],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                internal_error("该本地路径已在项目管理中")
            } else {
                internal_error(e.to_string())
            }
        })?;
        Ok(())
    })?;
    get_local_project(&id).ok_or_else(|| internal_error("项目写入后读取失败"))
}

pub fn update_local_project_path(project_id: &str, local_path: &str) -> AppResult<LocalProjectRecord> {
    let current = get_local_project(project_id)
        .ok_or_else(|| internal_error("项目不存在或已被删除"))?;
    let resolved = std::fs::canonicalize(local_path.trim())
        .map_err(|_| internal_error("本地路径不存在或无法访问"))?;
    if !resolved.is_dir() {
        return Err(internal_error("请选择文件夹（目录）作为项目根路径"));
    }
    let resolved_str = resolved.to_string_lossy().to_string();

    with_db_mut(|conn| {
        let duplicated: Option<String> = conn
            .query_row(
                "SELECT id FROM local_projects WHERE local_path = ?1 AND id != ?2",
                params![resolved_str, project_id],
                |r| r.get(0),
            )
            .ok();
        if duplicated.is_some() {
            return Err(internal_error("该本地路径已在项目管理中"));
        }
        let current_base = PathBuf::from(&current.local_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let next_base = resolved
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let next_display = if current.display_name == current_base {
            next_base.chars().take(200).collect::<String>()
        } else {
            current.display_name.clone()
        };
        conn.execute(
            "UPDATE local_projects SET display_name = ?1, local_path = ?2, updated_at = ?3 WHERE id = ?4",
            params![next_display, resolved_str, now_iso(), project_id],
        )
        .ipc()?;
        Ok(())
    })?;
    get_local_project(project_id).ok_or_else(|| internal_error("项目更新后读取失败"))
}

pub fn delete_local_project(id: &str) -> AppResult<()> {
    with_db(|conn| {
        conn.execute("DELETE FROM local_projects WHERE id = ?1", params![id])
            .ipc()?;
        Ok(())
    })
}

pub fn update_local_project_deploy_result(
    id: &str,
    connection_id: &str,
    remote_path: Option<&str>,
    status: &str,
    message: &str,
    deploy_kind: Option<&str>,
) -> AppResult<()> {
    with_db(|conn| {
        let truncated: String = message.chars().take(2000).collect();
        conn.execute(
            "UPDATE local_projects SET
                last_connection_id = ?1,
                last_remote_path = ?2,
                last_deploy_at = ?3,
                last_deploy_status = ?4,
                last_deploy_message = ?5,
                last_deploy_kind = ?6,
                updated_at = ?3
             WHERE id = ?7",
            params![connection_id, remote_path, now_iso(), status, truncated, deploy_kind, id],
        )
        .ipc()?;
        Ok(())
    })
}


