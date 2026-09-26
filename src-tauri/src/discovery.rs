//! SSH config + known_hosts discovery — port of discovery.ts.

use crate::error::{internal_error, AppResult};
use crate::models::{
    DiscoveredHostCandidate, RawSshConfigFile, SshConfigCandidate, SshConfigMutationInput,
    VpsConnectionInput,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
struct HostEntry {
    aliases: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    config_path: String,
    start_line: usize,
    end_line: usize,
}

fn primary_ssh_config_path() -> PathBuf {
    crate::util::home_dir().join(".ssh").join("config")
}

pub fn get_raw_ssh_config() -> RawSshConfigFile {
    let path = primary_ssh_config_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    RawSshConfigFile {
        path: path.to_string_lossy().to_string(),
        content,
    }
}

pub fn save_raw_ssh_config(content: &str) -> AppResult<RawSshConfigFile> {
    let path = primary_ssh_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
    }
    std::fs::write(&path, content).map_err(|e| internal_error(e.to_string()))?;
    Ok(get_raw_ssh_config())
}

fn resolve_config_path(file_path: &str, parent_file_path: Option<&str>) -> String {
    let expanded = crate::util::expand_home(file_path);
    if expanded.is_absolute() {
        return expanded.to_string_lossy().to_string();
    }
    if let Some(parent) = parent_file_path {
        return Path::new(parent)
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .join(&expanded)
            .to_string_lossy()
            .to_string();
    }
    expanded.to_string_lossy().to_string()
}

fn parse_config_file(file_path: &str, visited: &mut HashSet<String>) -> Vec<HostEntry> {
    let resolved = resolve_config_path(file_path, None);
    if visited.contains(&resolved) {
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(&resolved) else {
        return Vec::new();
    };
    visited.insert(resolved.clone());

    let lines: Vec<&str> = content.split('\n').collect();
    let mut hosts: Vec<HostEntry> = Vec::new();
    let mut current: Option<HostEntry> = None;

    for (index, raw_line) in lines.iter().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(keyword) = parts.next() else { continue };
        let value = parts.collect::<Vec<_>>().join(" ");
        let keyword = keyword.to_lowercase();

        if keyword == "include" {
            for include_item in value.split_whitespace() {
                let resolved_include = resolve_config_path(include_item, Some(&resolved));
                hosts.extend(parse_config_file(&resolved_include, visited));
            }
            continue;
        }

        if keyword == "host" {
            if current.is_some() {
                if let Some(last) = hosts.last_mut() {
                    last.end_line = index;
                }
            }
            let aliases: Vec<String> = value
                .split_whitespace()
                .filter(|item| !item.is_empty() && !item.contains('*') && !item.contains('?'))
                .map(|s| s.to_string())
                .collect();
            current = if aliases.is_empty() {
                None
            } else {
                let entry = HostEntry {
                    aliases,
                    config_path: resolved.clone(),
                    start_line: index,
                    end_line: lines.len(),
                    ..Default::default()
                };
                hosts.push(entry.clone());
                Some(entry)
            };
            continue;
        }

        let Some(entry) = current.as_mut() else { continue };
        match keyword.as_str() {
            "hostname" => entry.host_name = Some(value),
            "user" => entry.user = Some(value),
            "port" => entry.port = value.parse::<u16>().ok(),
            "identityfile" => entry.identity_file = Some(resolve_config_path(&value, Some(&resolved))),
            _ => {}
        }
        // Sync the copy stored in `hosts` (parse is single-pass, current is the last pushed).
        if let Some(last) = hosts.last_mut() {
            *last = entry.clone();
        }
    }
    hosts
}

fn read_private_key(file_path: Option<&str>) -> Option<String> {
    let file_path = file_path?;
    std::fs::read_to_string(file_path).ok()
}

fn list_host_blocks_from_file(file_path: &str) -> Vec<HostEntry> {
    let resolved = resolve_config_path(file_path, None);
    parse_config_file(file_path, &mut HashSet::new())
        .into_iter()
        .filter(|entry| entry.config_path == resolved)
        .collect()
}

fn find_host_block(file_path: &str, original_name: &str) -> Option<HostEntry> {
    list_host_blocks_from_file(file_path)
        .into_iter()
        .find(|entry| entry.aliases.iter().any(|a| a == original_name))
}

fn find_host_block_for_connection(
    file_path: &str,
    payload: (&str, &str, &str, u16), // name, host, username, port
) -> Option<HostEntry> {
    let resolved = resolve_config_path(file_path, None);
    let (name, host, username, port) = payload;
    list_host_blocks_from_file(&resolved).into_iter().find(|entry| {
        let entry_host = entry
            .host_name
            .clone()
            .or_else(|| entry.aliases.first().cloned())
            .unwrap_or_default();
        let entry_user = entry
            .user
            .as_deref()
            .map(|u| u.split('@').next().unwrap_or(u).to_string())
            .unwrap_or_else(|| "root".to_string());
        let entry_port = entry.port.unwrap_or(22);
        entry.aliases.iter().any(|a| a == name)
            || (entry_host == host && entry_user == username && entry_port == port)
    })
}

fn upsert_directive(lines: &mut Vec<String>, key: &str, next_value: Option<&str>) {
    let lower_key = key.to_lowercase();
    let index = lines.iter().enumerate().position(|(i, line)| {
        if i == 0 {
            return false;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return false;
        }
        trimmed
            .split_whitespace()
            .next()
            .map(|d| d.to_lowercase() == lower_key)
            .unwrap_or(false)
    });

    match (index, next_value) {
        (Some(i), None) => {
            lines.remove(i);
        }
        (Some(i), Some(v)) => {
            let indent: String = lines[i].chars().take_while(|c| c.is_whitespace()).collect();
            let indent = if indent.is_empty() { "  ".to_string() } else { indent };
            lines[i] = format!("{indent}{key} {v}");
        }
        (None, Some(v)) => lines.push(format!("  {key} {v}")),
        (None, None) => {}
    }
}

fn write_lines(file_path: &str, lines: &[String]) -> AppResult<()> {
    if let Some(parent) = Path::new(file_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
    }
    let joined = lines.join("\n");
    let content = format!("{}\n", joined.trim_end_matches('\n'));
    std::fs::write(file_path, content).map_err(|e| internal_error(e.to_string()))
}

struct NormalizedMutation {
    name: String,
    host: String,
    username: String,
    port: u16,
    identity_file_path: Option<String>,
}

fn normalize_mutation(payload: &SshConfigMutationInput) -> AppResult<NormalizedMutation> {
    let name = payload.name.trim().to_string();
    let host = payload.host.trim().to_string();
    let username = payload.username.trim().to_string();
    let port = payload.port;
    let identity_file_path = payload
        .identity_file_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if name.is_empty() || host.is_empty() || username.is_empty() || port == 0 {
        return Err(internal_error("SSH 配置项不完整，无法写回本机配置"));
    }
    Ok(NormalizedMutation {
        name,
        host,
        username,
        port,
        identity_file_path,
    })
}

fn assert_no_duplicate(next_name: &str, config_path: &str, original_name: Option<&str>) -> AppResult<()> {
    let duplicate = list_ssh_config_candidates().into_iter().find(|item| {
        item.name == next_name
            && !(item.config_path == config_path && Some(item.name.as_str()) == original_name)
    });
    if duplicate.is_some() {
        return Err(internal_error(format!(
            "SSH 主机别名 \"{next_name}\" 已存在，请更换名称"
        )));
    }
    Ok(())
}

pub fn discover_local_connections() -> Vec<VpsConnectionInput> {
    parse_config_file(&primary_ssh_config_path().to_string_lossy(), &mut HashSet::new())
        .into_iter()
        .filter_map(|entry| {
            let host = entry
                .host_name
                .clone()
                .or_else(|| entry.aliases.first().cloned())?;
            let username = entry
                .user
                .as_deref()
                .map(|u| u.split('@').next().unwrap_or(u).to_string())
                .unwrap_or_else(|| "root".to_string());
            let private_key = read_private_key(entry.identity_file.as_deref());
            Some(VpsConnectionInput {
                id: None,
                name: entry
                    .aliases
                    .first()
                    .cloned()
                    .unwrap_or_else(|| format!("{username}@{host}")),
                host,
                port: entry.port.unwrap_or(22),
                username,
                provider: None,
                location_label: None,
                expires_at: None,
                auth_type: if private_key.is_some() { "privateKey" } else { "password" }.to_string(),
                password: None,
                private_key,
                passphrase: None,
                source: Some("ssh-config".to_string()),
            })
        })
        .collect()
}

pub fn list_ssh_config_candidates() -> Vec<SshConfigCandidate> {
    parse_config_file(&primary_ssh_config_path().to_string_lossy(), &mut HashSet::new())
        .into_iter()
        .filter_map(|entry| {
            let host = entry
                .host_name
                .clone()
                .or_else(|| entry.aliases.first().cloned())?;
            let username = entry
                .user
                .as_deref()
                .map(|u| u.split('@').next().unwrap_or(u).to_string())
                .unwrap_or_else(|| "root".to_string());
            let private_key = read_private_key(entry.identity_file.as_deref());
            Some(SshConfigCandidate {
                name: entry
                    .aliases
                    .first()
                    .cloned()
                    .unwrap_or_else(|| format!("{username}@{host}")),
                host,
                port: entry.port.unwrap_or(22),
                username,
                auth_type: if private_key.is_some() { "privateKey" } else { "password" }.to_string(),
                source: "ssh-config".to_string(),
                config_path: entry.config_path.clone(),
                identity_file_path: entry.identity_file.clone(),
                private_key,
            })
        })
        .collect()
}

pub fn create_ssh_config_candidate(payload: &SshConfigMutationInput) -> AppResult<Vec<SshConfigCandidate>> {
    let default_path = primary_ssh_config_path().to_string_lossy().to_string();
    let file_path = resolve_config_path(
        if payload.config_path.is_empty() { &default_path } else { &payload.config_path },
        None,
    );
    let m = normalize_mutation(payload)?;
    assert_no_duplicate(&m.name, &file_path, None)?;

    let existing = std::fs::read_to_string(&file_path).unwrap_or_default();
    let existing = existing.trim_end_matches('\n').to_string();
    let mut block = vec![
        format!("Host {}", m.name),
        format!("  HostName {}", m.host),
        format!("  User {}", m.username),
        format!("  Port {}", m.port),
    ];
    if let Some(identity) = &m.identity_file_path {
        block.push(format!("  IdentityFile {identity}"));
    }
    let next_content = if existing.is_empty() {
        format!("{}\n", block.join("\n"))
    } else {
        format!("{existing}\n\n{}\n", block.join("\n"))
    };
    if let Some(parent) = Path::new(&file_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal_error(e.to_string()))?;
    }
    std::fs::write(&file_path, next_content).map_err(|e| internal_error(e.to_string()))?;
    Ok(list_ssh_config_candidates())
}

pub fn update_ssh_config_candidate(payload: &SshConfigMutationInput) -> AppResult<Vec<SshConfigCandidate>> {
    let original_name = payload
        .original_name
        .as_deref()
        .ok_or_else(|| internal_error("缺少原始 SSH 主机别名，无法更新"))?;
    let file_path = resolve_config_path(&payload.config_path, None);
    let m = normalize_mutation(payload)?;
    assert_no_duplicate(&m.name, &file_path, Some(original_name))?;

    let block = find_host_block(&file_path, original_name)
        .ok_or_else(|| internal_error("未找到对应的 SSH 配置项，可能已被外部修改"))?;
    let mut lines: Vec<String> = std::fs::read_to_string(&file_path)
        .map_err(|e| internal_error(e.to_string()))?
        .split('\n')
        .map(|s| s.trim_end_matches('\r').to_string())
        .collect();
    let mut block_lines: Vec<String> = lines[block.start_line..block.end_line].to_vec();
    if block_lines.is_empty() {
        return Err(internal_error("SSH 配置项内容为空，无法写回"));
    }
    block_lines[0] = format!("Host {}", m.name);
    upsert_directive(&mut block_lines, "HostName", Some(&m.host));
    upsert_directive(&mut block_lines, "User", Some(&m.username));
    upsert_directive(&mut block_lines, "Port", Some(&m.port.to_string()));
    upsert_directive(&mut block_lines, "IdentityFile", m.identity_file_path.as_deref());
    lines.splice(block.start_line..block.end_line, block_lines);
    write_lines(&file_path, &lines)?;
    Ok(list_ssh_config_candidates())
}

pub fn ensure_ssh_config_candidate_for_connection(
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    identity_file_path: &str,
) -> AppResult<(String, String)> {
    let file_path = primary_ssh_config_path().to_string_lossy().to_string();
    if let Some(existing) = find_host_block_for_connection(&file_path, (name, host, username, port)) {
        let original = existing.aliases.first().cloned().unwrap_or_else(|| name.to_string());
        update_ssh_config_candidate(&SshConfigMutationInput {
            config_path: existing.config_path.clone(),
            original_name: Some(original),
            name: name.to_string(),
            host: host.to_string(),
            port,
            username: username.to_string(),
            identity_file_path: Some(identity_file_path.to_string()),
        })?;
        return Ok((existing.config_path, name.to_string()));
    }
    create_ssh_config_candidate(&SshConfigMutationInput {
        config_path: file_path.clone(),
        original_name: None,
        name: name.to_string(),
        host: host.to_string(),
        port,
        username: username.to_string(),
        identity_file_path: Some(identity_file_path.to_string()),
    })?;
    Ok((file_path, name.to_string()))
}

pub fn delete_ssh_config_candidate(config_path: &str, original_name: &str) -> AppResult<Vec<SshConfigCandidate>> {
    let file_path = resolve_config_path(config_path, None);
    let block = find_host_block(&file_path, original_name)
        .ok_or_else(|| internal_error("未找到要删除的 SSH 配置项，可能已被外部修改"))?;
    let mut lines: Vec<String> = std::fs::read_to_string(&file_path)
        .map_err(|e| internal_error(e.to_string()))?
        .split('\n')
        .map(|s| s.trim_end_matches('\r').to_string())
        .collect();
    let mut delete_start = block.start_line;
    let mut delete_end = block.end_line.min(lines.len());
    while delete_end < lines.len() && lines[delete_end].trim().is_empty() {
        delete_end += 1;
    }
    if delete_start > 0 && lines[delete_start - 1].trim().is_empty() {
        delete_start -= 1;
    }
    lines.drain(delete_start..delete_end);
    write_lines(&file_path, &lines)?;
    Ok(list_ssh_config_candidates())
}

pub fn discover_known_hosts(existing_hosts: &[(String, u16)]) -> Vec<DiscoveredHostCandidate> {
    let known_hosts_path = crate::util::home_dir().join(".ssh").join("known_hosts");
    let Ok(content) = std::fs::read_to_string(&known_hosts_path) else {
        return Vec::new();
    };
    let existing: HashSet<String> = existing_hosts
        .iter()
        .map(|(h, p)| format!("{h}:{p}"))
        .collect();
    let mut discovered: HashMap<String, DiscoveredHostCandidate> = HashMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('|') {
            continue;
        }
        let Some(host_field) = trimmed.split_whitespace().next() else { continue };
        for raw_host in host_field.split(',') {
            if raw_host.is_empty() || raw_host.contains('*') || raw_host.contains('?') {
                continue;
            }
            let (host, port) = if let Some(caps) = regex::Regex::new(r"^\[([^\]]+)\]:(\d+)$")
                .ok()
                .and_then(|re| re.captures(raw_host))
            {
                (caps[1].to_string(), caps[2].parse::<u16>().unwrap_or(22))
            } else {
                (raw_host.to_string(), 22)
            };
            let key = format!("{host}:{port}");
            if existing.contains(&key) || discovered.contains_key(&key) {
                continue;
            }
            discovered.insert(
                key,
                DiscoveredHostCandidate {
                    name: host.clone(),
                    host,
                    port,
                    source: "known-hosts".to_string(),
                },
            );
        }
    }
    let mut out: Vec<_> = discovered.into_values().collect();
    out.sort_by(|a, b| a.host.cmp(&b.host));
    out
}
