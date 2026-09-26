//! System upgrade check/apply — port of system-upgrade.ts.

use crate::error::AppResult;
use crate::models::{SystemUpgradeApplyResult, SystemUpgradeCheckResult, VpsConnectionInput};
use crate::ssh::run_ssh_command;
use std::collections::HashMap;

const UPGRADE_CHECK_SCRIPT: &str = r##"
set +e
status=unsupported
reason=
manager=none
upgradable_count=0
index_refreshed=0

if [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
else
  run_privileged() { sudo -n "$@"; }
fi

if command -v apt >/dev/null 2>&1; then
  manager=apt
elif command -v apt-get >/dev/null 2>&1; then
  manager=apt-get
fi

if [ "$manager" = "none" ]; then
  printf 'status=unsupported\n'
  printf 'reason=no_apt\n'
  printf 'manager=none\n'
  printf 'upgradable_count=0\n'
  printf 'index_refreshed=0\n'
  exit 0
fi

if run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>/dev/null; then
  index_refreshed=1
fi

if [ "$manager" = "apt" ]; then
  upgradable_count=$(apt list --upgradable 2>/dev/null | grep -cF '[upgradable from:' || true)
else
  upgradable_count=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
fi
case "$upgradable_count" in ''|*[!0-9]*) upgradable_count=0 ;; esac

printf 'status=supported\n'
printf 'manager=%s\n' "$manager"
printf 'upgradable_count=%s\n' "$upgradable_count"
printf 'index_refreshed=%s\n' "$index_refreshed"
exit 0
"##;

fn parse_check_output(raw: &str) -> SystemUpgradeCheckResult {
    let mut map = HashMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(idx) = trimmed.find('=') {
            map.insert(trimmed[..idx].to_string(), trimmed[idx + 1..].to_string());
        }
    }
    let manager = map.get("manager").map(|s| s.as_str()).unwrap_or("none");
    let manager = if matches!(manager, "apt" | "apt-get" | "none") { manager } else { "none" };
    SystemUpgradeCheckResult {
        supported: map.get("status").map(|s| s == "supported").unwrap_or(false),
        manager: manager.to_string(),
        upgradable_count: map
            .get("upgradable_count")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        index_refreshed: map.get("index_refreshed").map(|v| v == "1").unwrap_or(false),
        reason: map.get("reason").filter(|s| !s.is_empty()).cloned(),
        hint: None,
    }
}

pub fn check_system_upgrades(payload: &VpsConnectionInput) -> AppResult<SystemUpgradeCheckResult> {
    let result = run_ssh_command(payload, UPGRADE_CHECK_SCRIPT, 120_000, "远程命令执行超时")?;
    if result.code != 0 && !result.stderr.trim().is_empty() {
        return Ok(SystemUpgradeCheckResult {
            supported: false,
            manager: "none".to_string(),
            upgradable_count: 0,
            index_refreshed: false,
            reason: Some("exec_error".to_string()),
            hint: Some(result.stderr.trim().chars().take(400).collect()),
        });
    }
    Ok(parse_check_output(&result.stdout))
}

fn build_apply_script(reboot: bool) -> String {
    let reboot_line = if reboot {
        "run_privileged env DEBIAN_FRONTEND=noninteractive shutdown -r +0 \"digwis-panel maintenance reboot\" || true\n"
    } else {
        ""
    };
    format!(
        r##"
set -e
export DEBIAN_FRONTEND=noninteractive
if [ "$(id -u)" -eq 0 ]; then
  run_privileged() {{ "$@"; }}
else
  run_privileged() {{ sudo -n "$@"; }}
fi
run_privileged apt-get update -qq
run_privileged apt-get full-upgrade -y
run_privileged apt-get autoremove -y
printf '%s\n' "DIGWIS_UPGRADE_DONE"
{reboot_line}"##
    )
}

fn tail_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        text[text.len() - max..].to_string()
    }
}

fn is_connection_interruption(error: &str) -> bool {
    let msg = error.to_lowercase();
    msg.contains("econnreset")
        || msg.contains("econnaborted")
        || msg.contains("connection closed")
        || msg.contains("socket hang up")
        || msg.contains("disconnected")
        || msg.contains("socket")
        || msg.contains("closed by remote")
        || msg.contains("通道已关闭")
        || msg.contains("连接已中断")
}

pub fn apply_system_upgrade(payload: &VpsConnectionInput, reboot: bool) -> AppResult<SystemUpgradeApplyResult> {
    let script = build_apply_script(reboot);
    match run_ssh_command(payload, &script, 900_000, "远程命令执行超时") {
        Ok(result) => {
            let combined = format!("{}\n{}", result.stdout, result.stderr);
            let saw_done = combined.contains("DIGWIS_UPGRADE_DONE");
            let ok = result.code == 0 || (reboot && saw_done);
            if !ok && !result.stderr.trim().is_empty() {
                return Ok(SystemUpgradeApplyResult {
                    ok: false,
                    likely_rebooting: None,
                    likely_interrupted: None,
                    stdout: tail_text(&combined, 4000),
                    message: result.stderr.trim().chars().take(500).collect::<String>(),
                });
            }
            if !ok {
                return Ok(SystemUpgradeApplyResult {
                    ok: false,
                    likely_rebooting: None,
                    likely_interrupted: None,
                    stdout: tail_text(&combined, 4000),
                    message: format!("命令退出码: {}", result.code),
                });
            }
            Ok(SystemUpgradeApplyResult {
                ok: true,
                likely_rebooting: Some(reboot),
                likely_interrupted: None,
                stdout: tail_text(&combined, 4000),
                message: if reboot {
                    "升级已完成，主机正在或即将重启，请稍后重新连接。".to_string()
                } else {
                    "升级与清理已完成。若内核有更新，请在服务器上自行执行重启以生效。".to_string()
                },
            })
        }
        Err(error) => {
            if is_connection_interruption(&error) {
                if reboot {
                    return Ok(SystemUpgradeApplyResult {
                        ok: true,
                        likely_rebooting: Some(true),
                        likely_interrupted: None,
                        stdout: String::new(),
                        message: "连接已中断，主机可能正在重启。请稍后重新检测或重新连接。".to_string(),
                    });
                }
                return Ok(SystemUpgradeApplyResult {
                    ok: false,
                    likely_rebooting: None,
                    likely_interrupted: Some(true),
                    stdout: String::new(),
                    message: "升级期间 SSH 连接被中断，远程升级可能已成功或仍在进行。请稍后重新检测软件更新以确认结果。".to_string(),
                });
            }
            Ok(SystemUpgradeApplyResult {
                ok: false,
                likely_rebooting: None,
                likely_interrupted: None,
                stdout: String::new(),
                message: error,
            })
        }
    }
}
