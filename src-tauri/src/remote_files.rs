//! Remote file operations — port of remote-files.ts + remote-files-sftp-fallback.ts.
//! Helper-first with automatic SFTP fallback (delete/trash/upload/download are SFTP-only).

use crate::error::{internal_error, AppResult};
use crate::helper::{helper_rpc, HelperKind};
use crate::models::{
    RemoteFileBrowseResult, RemoteFileDownloadInput, RemoteFileEntry, RemoteFileMutationResult,
    RemoteFilePermissions, RemoteFileReadResult, RemoteFileStatResult, RemoteFileUploadResult,
    RemoteTrashEntry, RemoteTrashListResult, VpsConnectionInput,
};
use crate::settings::get_default_remote_directory;
use crate::ssh::{connect, SshSession};
use crate::util::{posix_basename, posix_dirname, posix_join, to_remote_path};
use serde_json::json;
use ssh2::{FileStat, Sftp};
use std::io::{Read, Write};
use std::path::Path;

const TRASH_CONTAINER_DIR: &str = ".digwis-panel/trash";
const TRASH_FILES_DIRNAME: &str = "files";
const TRASH_META_DIRNAME: &str = "meta";

fn assert_simple_name(name: &str, label: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(internal_error(format!("{label}不能为空")));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(internal_error(format!("{label}不能包含路径分隔符")));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(internal_error(format!("{label}无效")));
    }
    Ok(trimmed.to_string())
}

fn as_iso_time(raw: Option<u64>) -> Option<String> {
    let secs = raw?;
    if secs == 0 {
        return None;
    }
    let dt = chrono::DateTime::from_timestamp(secs as i64, 0)?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn map_stat_type(stat: &FileStat) -> &'static str {
    let Some(perm) = stat.perm else {
        return "file";
    };
    match perm & 0o170000 {
        0o040000 => "directory",
        0o120000 => "symlink",
        _ => "file",
    }
}

fn format_permissions(mode: Option<u32>) -> Option<RemoteFilePermissions> {
    let mode = mode?;
    let bits = mode & 0o7777;
    let to_triplet = |v: u32| -> String {
        [
            if v & 0o4 != 0 { "r" } else { "-" },
            if v & 0o2 != 0 { "w" } else { "-" },
            if v & 0o1 != 0 { "x" } else { "-" },
        ]
        .concat()
    };
    let special = (bits >> 9) & 0o7;
    let mut owner = to_triplet((bits >> 6) & 0o7);
    let mut group = to_triplet((bits >> 3) & 0o7);
    let mut others = to_triplet(bits & 0o7);
    if special & 0o4 != 0 {
        owner.replace_range(2..3, if owner.ends_with('x') { "s" } else { "S" });
    }
    if special & 0o2 != 0 {
        group.replace_range(2..3, if group.ends_with('x') { "s" } else { "S" });
    }
    if special & 0o1 != 0 {
        others.replace_range(2..3, if others.ends_with('x') { "t" } else { "T" });
    }
    let octal = if special != 0 {
        format!("{bits:04o}")
    } else {
        format!("{bits:03o}")
    };
    Some(RemoteFilePermissions {
        octal,
        symbolic: format!("-{owner}{group}{others}"),
    })
}

fn with_sftp<T>(connection: &VpsConnectionInput, f: impl FnOnce(&Sftp) -> AppResult<T>) -> AppResult<T> {
    let sess = connect(connection, 20_000)?;
    let result = (|| {
        let sftp = sess.sftp()?;
        f(&sftp)
    })();
    sess.disconnect();
    result
}

fn sftp_cwd(sftp: &Sftp) -> String {
    sftp.realpath(Path::new("."))
        .map(|p| to_remote_path(&p.to_string_lossy()))
        .unwrap_or_else(|_| "/".to_string())
}

fn resolve_browse_path(sftp: &Sftp, requested: Option<&str>) -> String {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        None => to_remote_path(&get_default_remote_directory()),
        Some(next) if next.starts_with('/') => to_remote_path(next),
        Some(next) => posix_join(&sftp_cwd(sftp), next),
    }
}

fn get_path_type(sftp: &Sftp, remote_path: &str) -> Option<&'static str> {
    sftp.stat(Path::new(remote_path)).ok().map(|st| map_stat_type(&st))
}

fn path_exists(sftp: &Sftp, remote_path: &str) -> bool {
    sftp.stat(Path::new(remote_path)).is_ok()
}

fn ensure_directory(sftp: &Sftp, remote_path: &str) -> AppResult<()> {
    match get_path_type(sftp, remote_path) {
        Some("directory") => Ok(()),
        Some(_) => Err(internal_error(format!("目标路径不是目录: {remote_path}"))),
        None => mkdir_recursive(sftp, remote_path),
    }
}

fn mkdir_recursive(sftp: &Sftp, remote_path: &str) -> AppResult<()> {
    let normalized = to_remote_path(remote_path);
    let mut current = String::new();
    for segment in normalized.split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(segment);
        match get_path_type(sftp, &current) {
            Some("directory") => continue,
            Some(_) => return Err(internal_error(format!("目标路径不是目录: {current}"))),
            None => sftp
                .mkdir(Path::new(&current), 0o755)
                .map_err(|e| internal_error(format!("无法创建目录 {current}: {e}")))?,
        }
    }
    Ok(())
}

fn resolve_trash_paths(sftp: &Sftp) -> AppResult<(String, String, String)> {
    let home = sftp_cwd(sftp);
    let root_path = posix_join(&home, TRASH_CONTAINER_DIR);
    let files_path = posix_join(&root_path, TRASH_FILES_DIRNAME);
    let meta_path = posix_join(&root_path, TRASH_META_DIRNAME);
    ensure_directory(sftp, &root_path)?;
    ensure_directory(sftp, &files_path)?;
    ensure_directory(sftp, &meta_path)?;
    Ok((root_path, files_path, meta_path))
}

fn is_within_path(target: &str, parent: &str) -> bool {
    let t = to_remote_path(target);
    let p = to_remote_path(parent);
    t == p || t.starts_with(&format!("{p}/"))
}

fn get_real_remote_path(sftp: &Sftp, remote_path: &str) -> Option<String> {
    let resolved = sftp.realpath(Path::new(remote_path)).ok()?;
    let normalized = to_remote_path(&resolved.to_string_lossy());
    if normalized == "." {
        None
    } else {
        Some(normalized)
    }
}

fn resolve_directory_path(
    sftp: &Sftp,
    requested: Option<&str>,
    allow_parent_fallback: bool,
) -> AppResult<String> {
    let initial = resolve_browse_path(sftp, requested);
    let mut queue = vec![initial];
    let mut visited = std::collections::HashSet::new();
    while let Some(raw) = queue.first().cloned() {
        queue.remove(0);
        let candidate = to_remote_path(&raw);
        if !visited.insert(candidate.clone()) {
            continue;
        }
        if get_path_type(sftp, &candidate) == Some("directory") {
            return Ok(candidate);
        }
        let real_path = get_real_remote_path(sftp, &candidate);
        if let Some(real) = &real_path {
            if !visited.contains(real) {
                if get_path_type(sftp, real) == Some("directory") {
                    return Ok(real.clone());
                }
                queue.push(real.clone());
            }
        }
        if allow_parent_fallback {
            let parent = posix_dirname(&candidate);
            if parent != candidate && !visited.contains(&parent) {
                queue.push(parent);
            }
            if let Some(real) = &real_path {
                let real_parent = posix_dirname(real);
                if real_parent != *real && !visited.contains(&real_parent) {
                    queue.push(real_parent);
                }
            }
        }
    }
    Err(internal_error("当前路径不是目录"))
}

struct BrowseTarget {
    current_path: String,
    focused_path: Option<String>,
    focused_type: Option<String>,
}

fn resolve_browse_target(sftp: &Sftp, requested: Option<&str>) -> AppResult<BrowseTarget> {
    let allow_parent_fallback = requested.map(str::trim).filter(|s| !s.is_empty()).is_none();
    let initial = resolve_browse_path(sftp, requested);
    let initial_type = get_path_type(sftp, &initial);

    if requested.map(str::trim).filter(|s| !s.is_empty()).is_none() || initial_type == Some("directory") {
        return Ok(BrowseTarget {
            current_path: resolve_directory_path(sftp, requested, allow_parent_fallback)?,
            focused_path: None,
            focused_type: None,
        });
    }

    if initial_type == Some("file") || initial_type == Some("symlink") {
        let real_path = get_real_remote_path(sftp, &initial);
        let real_type = real_path.as_deref().and_then(|p| get_path_type(sftp, p));
        if real_type == Some("directory") {
            return Ok(BrowseTarget {
                current_path: real_path.unwrap(),
                focused_path: None,
                focused_type: None,
            });
        }
        let focused_path = if matches!(real_type, Some("file") | Some("symlink")) {
            real_path.clone().unwrap()
        } else {
            initial.clone()
        };
        let focused_type = real_type.or(initial_type).map(|s| s.to_string());
        let parent = posix_dirname(&focused_path);
        return Ok(BrowseTarget {
            current_path: resolve_directory_path(sftp, Some(&parent), true)?,
            focused_path: Some(focused_path),
            focused_type,
        });
    }

    Ok(BrowseTarget {
        current_path: resolve_directory_path(sftp, requested, allow_parent_fallback)?,
        focused_path: None,
        focused_type: None,
    })
}

fn build_browse_result(
    current_path: &str,
    entries: Vec<RemoteFileEntry>,
    root_path: &str,
    focused_path: Option<String>,
    focused_type: Option<String>,
) -> RemoteFileBrowseResult {
    let normalized = to_remote_path(current_path);
    RemoteFileBrowseResult {
        parent_path: if normalized == "/" {
            None
        } else {
            Some(posix_dirname(&normalized))
        },
        current_path: normalized,
        root_path: to_remote_path(root_path),
        focused_path: focused_path.map(|p| to_remote_path(&p)),
        focused_type,
        transport: Some("sftp".to_string()),
        entries,
    }
}

pub fn browse_via_sftp(connection: &VpsConnectionInput, requested: Option<&str>) -> AppResult<RemoteFileBrowseResult> {
    with_sftp(connection, |sftp| {
        let target = resolve_browse_target(sftp, requested)?;
        let current_path = target.current_path.clone();
        let mut entries: Vec<RemoteFileEntry> = sftp
            .readdir(Path::new(&current_path))
            .map_err(|e| internal_error(e.to_string()))?
            .into_iter()
            .filter(|(path, _)| {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                !name.is_empty() && name != "." && name != ".."
            })
            .map(|(path, stat)| {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                RemoteFileEntry {
                    path: posix_join(&current_path, &name),
                    name,
                    entry_type: map_stat_type(&stat).to_string(),
                    size: if map_stat_type(&stat) == "directory" {
                        0
                    } else {
                        stat.size.unwrap_or(0)
                    },
                    modified_at: as_iso_time(stat.mtime),
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            let ad = a.entry_type == "directory";
            let bd = b.entry_type == "directory";
            bd.cmp(&ad).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let root_path = resolve_directory_path(sftp, None, true)?;
        Ok(build_browse_result(
            &current_path,
            entries,
            &root_path,
            target.focused_path,
            target.focused_type,
        ))
    })
}

pub fn read_text_via_sftp(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileReadResult> {
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let stat = sftp.stat(Path::new(&resolved)).map_err(|e| internal_error(e.to_string()))?;
        if map_stat_type(&stat) == "directory" {
            return Err(internal_error("目录不能直接作为文本文件打开"));
        }
        let size = stat.size.unwrap_or(0);
        if size > 1024 * 1024 {
            return Err(internal_error("暂只支持打开 1 MB 以内的文本文件"));
        }
        let mut buf = Vec::new();
        sftp.open(Path::new(&resolved))
            .map_err(|e| internal_error(e.to_string()))?
            .read_to_end(&mut buf)
            .map_err(|e| internal_error(e.to_string()))?;
        if buf.contains(&0) {
            return Err(internal_error("该文件看起来是二进制内容，暂不支持在面板里直接编辑"));
        }
        Ok(RemoteFileReadResult {
            path: resolved,
            content: String::from_utf8_lossy(&buf).to_string(),
            size,
            modified_at: as_iso_time(stat.mtime),
        })
    })
}

pub fn stat_via_sftp(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileStatResult> {
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let stat = sftp.stat(Path::new(&resolved)).map_err(|e| internal_error(e.to_string()))?;
        Ok(RemoteFileStatResult {
            path: resolved.clone(),
            entry_type: map_stat_type(&stat).to_string(),
            size: stat.size.unwrap_or(0),
            modified_at: as_iso_time(stat.mtime),
            real_path: get_real_remote_path(sftp, &resolved),
            permissions: format_permissions(stat.perm),
        })
    })
}

pub fn write_text_via_sftp(
    connection: &VpsConnectionInput,
    remote_path: &str,
    content: &str,
) -> AppResult<RemoteFileMutationResult> {
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let parent = posix_dirname(&resolved);
        match get_path_type(sftp, &parent) {
            None => return Err(internal_error("目标目录不存在")),
            Some("directory") => {}
            Some(_) => return Err(internal_error("目标父路径不是目录")),
        }
        let mut f = sftp
            .create(Path::new(&resolved))
            .map_err(|e| internal_error(e.to_string()))?;
        f.write_all(content.as_bytes())
            .map_err(|e| internal_error(e.to_string()))?;
        Ok(RemoteFileMutationResult {
            ok: true,
            path: resolved,
            message: "文件已保存".to_string(),
        })
    })
}

pub fn mkdir_via_sftp(
    connection: &VpsConnectionInput,
    parent_path: &str,
    directory_name: &str,
) -> AppResult<RemoteFileMutationResult> {
    let name = assert_simple_name(directory_name, "目录名")?;
    with_sftp(connection, |sftp| {
        let resolved_parent = resolve_browse_path(sftp, Some(parent_path));
        let target = posix_join(&resolved_parent, &name);
        sftp.mkdir(Path::new(&target), 0o755)
            .map_err(|e| internal_error(e.to_string()))?;
        Ok(RemoteFileMutationResult {
            ok: true,
            path: target,
            message: "目录已创建".to_string(),
        })
    })
}

pub fn rename_via_sftp(
    connection: &VpsConnectionInput,
    remote_path: &str,
    next_name: &str,
) -> AppResult<RemoteFileMutationResult> {
    let safe_name = assert_simple_name(next_name, "名称")?;
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let next_path = posix_join(&posix_dirname(&resolved), &safe_name);
        sftp.rename(Path::new(&resolved), Path::new(&next_path), None)
            .map_err(|e| internal_error(e.to_string()))?;
        Ok(RemoteFileMutationResult {
            ok: true,
            path: next_path,
            message: "名称已更新".to_string(),
        })
    })
}

pub fn chmod_via_sftp(
    connection: &VpsConnectionInput,
    remote_path: &str,
    mode: &str,
    recursive: bool,
) -> AppResult<RemoteFileMutationResult> {
    let raw = mode.trim();
    if raw.is_empty() || raw.len() < 3 || raw.len() > 4 || !raw.chars().all(|c| ('0'..='7').contains(&c)) {
        return Err(internal_error("权限必须是 3 到 4 位八进制数字"));
    }
    let mode_value = u32::from_str_radix(raw, 8).map_err(|_| internal_error("权限必须是 3 到 4 位八进制数字"))?;
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let apply = |target: &str| -> AppResult<()> {
            sftp.setstat(
                Path::new(target),
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(mode_value),
                    atime: None,
                    mtime: None,
                },
            )
            .map_err(|e| internal_error(e.to_string()))
        };
        apply(&resolved)?;
        if recursive && get_path_type(sftp, &resolved) == Some("directory") {
            fn walk(sftp: &Sftp, dir: &str, apply: &dyn Fn(&str) -> AppResult<()>) -> AppResult<()> {
                for (path, stat) in sftp
                    .readdir(Path::new(dir))
                    .map_err(|e| internal_error(e.to_string()))?
                {
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    if name.is_empty() || name == "." || name == ".." {
                        continue;
                    }
                    let child = posix_join(dir, &name);
                    let child_type = map_stat_type(&stat);
                    if child_type == "symlink" {
                        continue;
                    }
                    apply(&child)?;
                    if child_type == "directory" {
                        walk(sftp, &child, apply)?;
                    }
                }
                Ok(())
            }
            walk(sftp, &resolved, &apply)?;
        }
        Ok(RemoteFileMutationResult {
            ok: true,
            path: resolved,
            message: "权限已更新".to_string(),
        })
    })
}

// ---------- trash ----------

fn read_trash_metadata(sftp: &Sftp, meta_dir: &str, trash_id: &str) -> Option<RemoteTrashEntry> {
    let meta_path = posix_join(meta_dir, &format!("{trash_id}.json"));
    let mut buf = Vec::new();
    sftp.open(Path::new(&meta_path)).ok()?.read_to_end(&mut buf).ok()?;
    let parsed: RemoteTrashEntry = serde_json::from_slice(&buf).ok()?;
    if parsed.id.is_empty() || parsed.trashed_path.is_empty() || parsed.original_path.is_empty() {
        return None;
    }
    Some(parsed)
}

pub fn delete_via_sftp(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileMutationResult> {
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(remote_path));
        let (root_path, files_path, meta_path) = resolve_trash_paths(sftp)?;
        if is_within_path(&resolved, &root_path) {
            return Err(internal_error("回收站中的项目请使用彻底删除"));
        }
        let stat = sftp.stat(Path::new(&resolved)).map_err(|e| internal_error(e.to_string()))?;
        let entry_type = map_stat_type(&stat).to_string();
        let trash_id = crate::util::random_uuid();
        let trashed_path = posix_join(&files_path, &trash_id);
        sftp.rename(Path::new(&resolved), Path::new(&trashed_path), None)
            .map_err(|e| internal_error(e.to_string()))?;
        let metadata = RemoteTrashEntry {
            id: trash_id.clone(),
            name: posix_basename(&resolved),
            original_path: resolved.clone(),
            trashed_path,
            entry_type: entry_type.clone(),
            size: stat.size.unwrap_or(0),
            deleted_at: crate::util::now_iso(),
            modified_at: as_iso_time(stat.mtime),
        };
        let meta_path = posix_join(&meta_path, &format!("{trash_id}.json"));
        let mut f = sftp
            .create(Path::new(&meta_path))
            .map_err(|e| internal_error(e.to_string()))?;
        f.write_all(serde_json::to_string(&metadata).unwrap_or_default().as_bytes())
            .map_err(|e| internal_error(e.to_string()))?;
        Ok(RemoteFileMutationResult {
            ok: true,
            path: resolved,
            message: if entry_type == "directory" {
                "目录已移入回收站".to_string()
            } else {
                "文件已移入回收站".to_string()
            },
        })
    })
}

pub fn list_trash_via_sftp(connection: &VpsConnectionInput) -> AppResult<RemoteTrashListResult> {
    with_sftp(connection, |sftp| {
        let (root_path, _, meta_path) = resolve_trash_paths(sftp)?;
        let mut entries: Vec<RemoteTrashEntry> = Vec::new();
        for (path, _) in sftp
            .readdir(Path::new(&meta_path))
            .map_err(|e| internal_error(e.to_string()))?
        {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !name.ends_with(".json") {
                continue;
            }
            let trash_id = name.trim_end_matches(".json");
            let Some(metadata) = read_trash_metadata(sftp, &meta_path, trash_id) else {
                continue;
            };
            if !path_exists(sftp, &metadata.trashed_path) {
                continue;
            }
            entries.push(metadata);
        }
        entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(RemoteTrashListResult {
            root_path,
            transport: Some("sftp".to_string()),
            entries,
        })
    })
}

pub fn restore_trash_via_sftp(connection: &VpsConnectionInput, trash_id: &str) -> AppResult<RemoteFileMutationResult> {
    with_sftp(connection, |sftp| {
        let (_, _, meta_path) = resolve_trash_paths(sftp)?;
        let metadata = read_trash_metadata(sftp, &meta_path, trash_id)
            .ok_or_else(|| internal_error("回收站记录不存在"))?;
        if path_exists(sftp, &metadata.original_path) {
            return Err(internal_error(format!(
                "原路径已存在同名项目，无法恢复: {}",
                metadata.original_path
            )));
        }
        let parent = posix_dirname(&metadata.original_path);
        if get_path_type(sftp, &parent) != Some("directory") {
            return Err(internal_error(format!("原目录不存在，无法恢复: {parent}")));
        }
        sftp.rename(
            Path::new(&metadata.trashed_path),
            Path::new(&metadata.original_path),
            None,
        )
        .map_err(|e| internal_error(e.to_string()))?;
        let _ = sftp.unlink(Path::new(&posix_join(&meta_path, &format!("{trash_id}.json"))));
        Ok(RemoteFileMutationResult {
            ok: true,
            path: metadata.original_path,
            message: "已从回收站恢复".to_string(),
        })
    })
}

fn remove_dir_recursive(sftp: &Sftp, dir: &str) -> AppResult<()> {
    for (path, stat) in sftp
        .readdir(Path::new(dir))
        .map_err(|e| internal_error(e.to_string()))?
    {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let child = posix_join(dir, &name);
        if map_stat_type(&stat) == "directory" {
            remove_dir_recursive(sftp, &child)?;
        } else {
            sftp.unlink(Path::new(&child)).map_err(|e| internal_error(e.to_string()))?;
        }
    }
    sftp.rmdir(Path::new(dir)).map_err(|e| internal_error(e.to_string()))
}

pub fn purge_trash_via_sftp(connection: &VpsConnectionInput, trash_id: &str) -> AppResult<RemoteFileMutationResult> {
    with_sftp(connection, |sftp| {
        let (_, _, meta_path) = resolve_trash_paths(sftp)?;
        let metadata = read_trash_metadata(sftp, &meta_path, trash_id)
            .ok_or_else(|| internal_error("回收站记录不存在"))?;
        match get_path_type(sftp, &metadata.trashed_path) {
            Some("directory") => remove_dir_recursive(sftp, &metadata.trashed_path)?,
            Some(_) => {
                sftp.unlink(Path::new(&metadata.trashed_path))
                    .map_err(|e| internal_error(e.to_string()))?;
            }
            None => {}
        }
        let _ = sftp.unlink(Path::new(&posix_join(&meta_path, &format!("{trash_id}.json"))));
        Ok(RemoteFileMutationResult {
            ok: true,
            path: metadata.original_path,
            message: "已彻底删除".to_string(),
        })
    })
}

// ---------- upload / download ----------

fn upload_dir_recursive(sftp: &Sftp, local: &Path, remote_dir: &str) -> AppResult<()> {
    mkdir_recursive(sftp, remote_dir)?;
    for entry in walkdir::WalkDir::new(local).min_depth(1) {
        let entry = entry.map_err(|e| internal_error(e.to_string()))?;
        let rel = entry
            .path()
            .strip_prefix(local)
            .map_err(|e| internal_error(e.to_string()))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let target = posix_join(remote_dir, &rel_str);
        if entry.file_type().is_dir() {
            mkdir_recursive(sftp, &target)?;
        } else {
            let mut remote = sftp
                .create(Path::new(&target))
                .map_err(|e| internal_error(format!("无法写入远端文件 {target}: {e}")))?;
            let mut local_file = std::fs::File::open(entry.path())
                .map_err(|e| internal_error(e.to_string()))?;
            std::io::copy(&mut local_file, &mut remote).map_err(|e| internal_error(e.to_string()))?;
        }
    }
    Ok(())
}

pub fn upload_paths_via_sftp(
    connection: &VpsConnectionInput,
    remote_path: &str,
    local_paths: &[String],
) -> AppResult<RemoteFileUploadResult> {
    if local_paths.is_empty() {
        return Ok(RemoteFileUploadResult {
            ok: true,
            uploaded_count: 0,
            message: "已取消上传".to_string(),
        });
    }
    with_sftp(connection, |sftp| {
        let target_dir = resolve_browse_path(sftp, Some(remote_path));
        if get_path_type(sftp, &target_dir) != Some("directory") {
            return Err(internal_error("上传目标不是目录"));
        }
        let mut uploaded_count = 0u32;
        for local_path in local_paths {
            let local = Path::new(local_path);
            let meta = std::fs::metadata(local).map_err(|e| internal_error(e.to_string()))?;
            let base = local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let target = posix_join(&target_dir, &base);
            if meta.is_dir() {
                upload_dir_recursive(sftp, local, &target)?;
            } else {
                let mut remote = sftp
                    .create(Path::new(&target))
                    .map_err(|e| internal_error(e.to_string()))?;
                let mut local_file = std::fs::File::open(local).map_err(|e| internal_error(e.to_string()))?;
                std::io::copy(&mut local_file, &mut remote).map_err(|e| internal_error(e.to_string()))?;
            }
            uploaded_count += 1;
        }
        Ok(RemoteFileUploadResult {
            ok: true,
            uploaded_count,
            message: format!("已上传 {uploaded_count} 个项目"),
        })
    })
}

fn download_dir_recursive(sftp: &Sftp, remote_dir: &str, local: &Path) -> AppResult<()> {
    std::fs::create_dir_all(local).map_err(|e| internal_error(e.to_string()))?;
    for (path, stat) in sftp
        .readdir(Path::new(remote_dir))
        .map_err(|e| internal_error(e.to_string()))?
    {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let remote_child = posix_join(remote_dir, &name);
        let local_child = local.join(&name);
        if map_stat_type(&stat) == "directory" {
            download_dir_recursive(sftp, &remote_child, &local_child)?;
        } else {
            let mut remote = sftp
                .open(Path::new(&remote_child))
                .map_err(|e| internal_error(e.to_string()))?;
            let mut local_file = std::fs::File::create(&local_child)
                .map_err(|e| internal_error(e.to_string()))?;
            std::io::copy(&mut remote, &mut local_file).map_err(|e| internal_error(e.to_string()))?;
        }
    }
    Ok(())
}

pub fn download_via_sftp(
    connection: &VpsConnectionInput,
    input: &RemoteFileDownloadInput,
    local_target: &str,
) -> AppResult<RemoteFileMutationResult> {
    with_sftp(connection, |sftp| {
        let resolved = resolve_browse_path(sftp, Some(&input.path));
        let local = Path::new(local_target);
        if input.entry_type == "directory" {
            download_dir_recursive(sftp, &resolved, local)?;
        } else {
            if let Some(parent) = local.parent() {
                std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
            }
            let mut remote = sftp
                .open(Path::new(&resolved))
                .map_err(|e| internal_error(e.to_string()))?;
            let mut local_file = std::fs::File::create(local).map_err(|e| internal_error(e.to_string()))?;
            std::io::copy(&mut remote, &mut local_file).map_err(|e| internal_error(e.to_string()))?;
        }
        Ok(RemoteFileMutationResult {
            ok: true,
            path: local_target.to_string(),
            message: format!(
                "{}已下载到 {local_target}",
                if input.entry_type == "directory" { "目录" } else { "文件" }
            ),
        })
    })
}

/// delete/trash ops go straight to SFTP in the Electron implementation as well.
pub fn delete_remote_entry(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileMutationResult> {
    delete_via_sftp(connection, remote_path)
}

pub fn list_remote_trash(connection: &VpsConnectionInput) -> AppResult<RemoteTrashListResult> {
    list_trash_via_sftp(connection)
}

pub fn restore_remote_trash_entry(
    connection: &VpsConnectionInput,
    trash_id: &str,
) -> AppResult<RemoteFileMutationResult> {
    restore_trash_via_sftp(connection, trash_id)
}

pub fn purge_remote_trash_entry(
    connection: &VpsConnectionInput,
    trash_id: &str,
) -> AppResult<RemoteFileMutationResult> {
    purge_trash_via_sftp(connection, trash_id)
}

/// Single-file upload helper shared by project deploy/migration.
pub fn sftp_upload_file(sftp: &Sftp, local: &Path, remote_path: &str) -> AppResult<()> {
    if let Some(parent) = Path::new(remote_path).parent() {
        let _ = mkdir_recursive(sftp, &parent.to_string_lossy());
    }
    let mut remote = sftp
        .create(Path::new(remote_path))
        .map_err(|e| internal_error(format!("无法写入远端文件 {remote_path}: {e}")))?;
    let mut local_file = std::fs::File::open(local).map_err(|e| internal_error(e.to_string()))?;
    std::io::copy(&mut local_file, &mut remote).map_err(|e| internal_error(e.to_string()))?;
    Ok(())
}

/// Single-file download helper shared by project migration.
pub fn sftp_download_file(sftp: &Sftp, remote_path: &str, local: &Path) -> AppResult<()> {
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
    }
    let mut remote = sftp
        .open(Path::new(remote_path))
        .map_err(|e| internal_error(format!("无法读取远端文件 {remote_path}: {e}")))?;
    let mut local_file = std::fs::File::create(local).map_err(|e| internal_error(e.to_string()))?;
    std::io::copy(&mut remote, &mut local_file).map_err(|e| internal_error(e.to_string()))?;
    Ok(())
}

// ---------- public facade (helper first, SFTP fallback) ----------

fn rpc<T: serde::de::DeserializeOwned>(
    connection: &VpsConnectionInput,
    method: &str,
    params: serde_json::Value,
) -> AppResult<T> {
    let value = helper_rpc(HelperKind::Files, connection, method, params)?;
    serde_json::from_value(value).map_err(|e| internal_error(format!("helper 响应解析失败: {e}")))
}

pub fn browse_remote_files(
    connection: &VpsConnectionInput,
    requested: Option<&str>,
    force_refresh: bool,
) -> AppResult<RemoteFileBrowseResult> {
    let helper_result: AppResult<RemoteFileBrowseResult> = (|| {
        let mut result: RemoteFileBrowseResult = rpc(
            connection,
            "browse",
            json!({ "path": requested, "forceRefresh": force_refresh }),
        )?;
        result.transport = Some("helper".to_string());
        Ok(result)
    })();
    helper_result.or_else(|_| browse_via_sftp(connection, requested))
}

pub fn read_remote_text_file(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileReadResult> {
    rpc::<RemoteFileReadResult>(connection, "readText", json!({ "path": remote_path }))
        .or_else(|_| read_text_via_sftp(connection, remote_path))
}

pub fn stat_remote_entry(connection: &VpsConnectionInput, remote_path: &str) -> AppResult<RemoteFileStatResult> {
    rpc::<RemoteFileStatResult>(connection, "stat", json!({ "path": remote_path }))
        .or_else(|_| stat_via_sftp(connection, remote_path))
}

pub fn write_remote_text_file(
    connection: &VpsConnectionInput,
    remote_path: &str,
    content: &str,
) -> AppResult<RemoteFileMutationResult> {
    rpc::<RemoteFileMutationResult>(connection, "writeText", json!({ "path": remote_path, "content": content }))
        .or_else(|_| write_text_via_sftp(connection, remote_path, content))
}

pub fn create_remote_directory(
    connection: &VpsConnectionInput,
    parent_path: &str,
    directory_name: &str,
) -> AppResult<RemoteFileMutationResult> {
    rpc::<RemoteFileMutationResult>(
        connection,
        "mkdir",
        json!({ "parentPath": parent_path, "directoryName": directory_name }),
    )
    .or_else(|_| mkdir_via_sftp(connection, parent_path, directory_name))
}

pub fn rename_remote_entry(
    connection: &VpsConnectionInput,
    remote_path: &str,
    next_name: &str,
) -> AppResult<RemoteFileMutationResult> {
    rpc::<RemoteFileMutationResult>(connection, "rename", json!({ "path": remote_path, "nextName": next_name }))
        .or_else(|_| rename_via_sftp(connection, remote_path, next_name))
}

pub fn change_remote_permissions(
    connection: &VpsConnectionInput,
    remote_path: &str,
    mode: &str,
    recursive: bool,
) -> AppResult<RemoteFileMutationResult> {
    rpc::<RemoteFileMutationResult>(
        connection,
        "chmod",
        json!({ "path": remote_path, "mode": mode, "recursive": recursive }),
    )
    .or_else(|_| chmod_via_sftp(connection, remote_path, mode, recursive))
}
