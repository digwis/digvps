//! VPS inspection — port of inspection.ts.
//! Persistent python helper first, marker-protocol shell script as fallback.
//! 15s result cache; reachability checks run locally over TCP/HTTP.

use crate::error::{internal_error, AppResult};
use crate::helper::{helper_rpc, HelperKind};
use crate::models::{
    InspectionPortCheck, InspectionReachabilityCheck, InspectionTelemetry, RemotePackageStatus,
    RemoteServiceStatus, SystemMetric, VpsConnectionInput, VpsInspection,
};
use crate::ssh::run_ssh_command;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(15);

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, VpsInspection)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_key(payload: &VpsConnectionInput) -> String {
    payload
        .id
        .clone()
        .unwrap_or_else(|| format!("{}@{}:{}", payload.username, payload.host, payload.port))
}

const INSPECTION_COMMAND: &str = r##"
set -e
line() { printf '%s=%s\n' "$1" "$2"; }
package_line() { printf 'PKG|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5"; }
hostname_value=$(hostname 2>/dev/null || echo unknown)
os_value=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || uname -s)
kernel_value=$(uname -r 2>/dev/null || echo unknown)
uptime_value=$(uptime -p 2>/dev/null || echo unknown)
pwd_value=$(pwd 2>/dev/null || echo ~)
package_manager=unknown
for pm in apt yum dnf apk pacman; do
  if command -v "$pm" >/dev/null 2>&1; then
    package_manager="$pm"
    break
  fi
done
cpu_model=$(sh -lc "command -v lscpu >/dev/null 2>&1 && lscpu | awk -F: '/Model name/ {gsub(/^ +/, \"\", \$2); print \$2; exit}' || echo unknown")
cpu_cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo unknown)
memory_value=$(free -h 2>/dev/null | awk '/Mem:/ {print $3 " / " $2}' || echo unknown)
disk_value=$(df -h / 2>/dev/null | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}' || echo unknown)
inode_value=$(df -Pi / 2>/dev/null | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}' || echo unknown)
mem_pct=$(free 2>/dev/null | awk '/Mem:/ {if ($2+0>0) printf "%.1f", 100*$3/$2; else print "0"}' || echo 0)
disk_pct=$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5+0}' || echo 0)
inode_pct=$(df -Pi / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5+0}' || echo 0)
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)
load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
load_pct=$(awk -v L="$load1" -v C="$cores" 'BEGIN {c=C+0; if(c<1)c=1; l=L+0; p=100*l/c; if(p>100)p=100; printf "%.1f", p}')
cpu_pct=0
cpu_iowait_pct=0
cpu_steal_pct=0
valid_pct() {
  awk -v p="$1" 'BEGIN { exit !((p ~ /^([0-9]+([.][0-9]+)?|[.][0-9]+)$/) && (p + 0) >= 0 && (p + 0) <= 100) }'
}
read_cpu_stat() {
  awk '/^cpu / {for (i = 2; i <= NF; i++) printf("%s%s", $i, (i < NF ? " " : "")); print ""; exit}' /proc/stat 2>/dev/null
}
cpu_stat1=$(read_cpu_stat)
if [ -n "$cpu_stat1" ]; then
  sleep 1
  cpu_stat2=$(read_cpu_stat)
  if [ -n "$cpu_stat2" ]; then
    cpu_metrics=$(awk -v a="$cpu_stat1" -v b="$cpu_stat2" '
      BEGIN {
        split(a, x, " ")
        split(b, y, " ")
        total1 = 0
        total2 = 0
        limit1 = length(x)
        limit2 = length(y)
        if (limit1 > 8) limit1 = 8
        if (limit2 > 8) limit2 = 8
        for (i = 1; i <= limit1; i++) total1 += x[i] + 0
        for (i = 1; i <= limit2; i++) total2 += y[i] + 0
        idle1 = x[4] + 0
        idle2 = y[4] + 0
        iowait1 = x[5] + 0
        iowait2 = y[5] + 0
        steal1 = x[8] + 0
        steal2 = y[8] + 0
        delta_total = total2 - total1
        delta_idle = idle2 - idle1
        delta_iowait = iowait2 - iowait1
        delta_steal = steal2 - steal1
        if (delta_total > 0) {
          busy = delta_total - delta_idle - delta_iowait
          if (busy < 0) busy = 0
          if (busy > delta_total) busy = delta_total
          iowait = 100 * delta_iowait / delta_total
          steal = 100 * delta_steal / delta_total
          usage = 100 * busy / delta_total
          if (usage < 0) usage = 0
          if (usage > 100) usage = 100
          if (iowait < 0) iowait = 0
          if (iowait > 100) iowait = 100
          if (steal < 0) steal = 0
          if (steal > 100) steal = 100
          printf "%.1f %.1f %.1f", usage, iowait, steal
        }
      }
    ')
    cpu_pct=$(echo "$cpu_metrics" | awk '{print $1}')
    cpu_iowait_pct=$(echo "$cpu_metrics" | awk '{print $2}')
    cpu_steal_pct=$(echo "$cpu_metrics" | awk '{print $3}')
  fi
fi
if ! valid_pct "$cpu_pct"; then
  cpu_idle2=$(vmstat 1 2 2>/dev/null | tail -1 | awk '{print $15}' || echo "")
  if valid_pct "$cpu_idle2"; then
    cpu_pct=$(awk -v id="$cpu_idle2" 'BEGIN {i=id+0; if(i>100)i=100; if(i<0)i=0; printf "%.1f", 100-i}')
  fi
fi
if ! valid_pct "$cpu_pct"; then
  cpu_idle_line=$(LANG=C top -bn1 2>/dev/null | grep -E '^%Cpu|^Cpu' | head -1 || true)
  if echo "$cpu_idle_line" | grep -q id; then
    cpu_idle=$(echo "$cpu_idle_line" | sed -n 's/.*, *\([0-9.]*\) *id.*/\1/p' | head -1)
    if valid_pct "$cpu_idle"; then
      cpu_pct=$(awk -v id="$cpu_idle" 'BEGIN {i=id+0; if(i>100)i=100; if(i<0)i=0; printf "%.1f", 100-i}')
    fi
  fi
fi
if ! valid_pct "$cpu_pct"; then cpu_pct=0; fi
if ! valid_pct "$cpu_iowait_pct"; then cpu_iowait_pct=0; fi
if ! valid_pct "$cpu_steal_pct"; then cpu_steal_pct=0; fi
iface=$(awk -F':' '/^[[:space:]]*(eth|en|wl|wlan|bond|venet|veth)/ {gsub(/^[[:space:]]+/, "", $1); print $1; exit}' /proc/net/dev)
if [ -z "$iface" ]; then iface=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p'); fi
net_rx_bps=0
net_tx_bps=0
if [ -n "$iface" ]; then
  read_rx_tx() { awk -v d="$iface" '$1 == d":" {print ($2+0), ($10+0)}' /proc/net/dev || echo "0 0"; }
  line1=$(read_rx_tx)
  rx1=$(echo "$line1" | awk '{print $1+0}')
  tx1=$(echo "$line1" | awk '{print $2+0}')
  sleep 1
  line2=$(read_rx_tx)
  rx2=$(echo "$line2" | awk '{print $1+0}')
  tx2=$(echo "$line2" | awk '{print $2+0}')
  net_rx_bps=$((rx2-rx1))
  net_tx_bps=$((tx2-tx1))
  if [ "$net_rx_bps" -lt 0 ] 2>/dev/null; then net_rx_bps=0; fi
  if [ "$net_tx_bps" -lt 0 ] 2>/dev/null; then net_tx_bps=0; fi
fi
docker_version=$(docker --version 2>/dev/null || true)
node_version=$(node --version 2>/dev/null || true)
if command -v nginx >/dev/null 2>&1; then
  nginx_version=$(nginx -v 2>&1)
else
  nginx_version=""
fi
pm2_version=$(pm2 --version 2>/dev/null || true)
python_version=$(python3 --version 2>/dev/null || true)
pg_version=$(psql --version 2>/dev/null || true)
line hostname "$hostname_value"
line os "$os_value"
line kernel "$kernel_value"
line uptime "$uptime_value"
line workingDirectory "$pwd_value"
line packageManager "$package_manager"
line metric_cpu "$cpu_model"
line metric_cores "$cpu_cores"
line metric_memory "$memory_value"
line metric_disk "$disk_value"
line metric_inode "$inode_value"
line metric_cpu_pct "$cpu_pct"
line metric_cpu_iowait_pct "$cpu_iowait_pct"
line metric_cpu_steal_pct "$cpu_steal_pct"
line metric_mem_pct "$mem_pct"
line metric_disk_pct "$disk_pct"
line metric_inode_pct "$inode_pct"
line metric_load_pct "$load_pct"
line metric_net_rx_bps "$net_rx_bps"
line metric_net_tx_bps "$net_tx_bps"
package_line Docker docker "$(command -v docker >/dev/null 2>&1 && echo true || echo false)" "${docker_version:-未安装}" "docker --version"
package_line Node.js nodejs "$(command -v node >/dev/null 2>&1 && echo true || echo false)" "${node_version:-未安装}" "node --version"
package_line Nginx nginx "$(command -v nginx >/dev/null 2>&1 && echo true || echo false)" "${nginx_version:-未安装}" "nginx -v"
package_line PM2 pm2 "$(command -v pm2 >/dev/null 2>&1 && echo true || echo false)" "${pm2_version:-未安装}" "pm2 --version"
package_line "Python 3" python3 "$(command -v python3 >/dev/null 2>&1 && echo true || echo false)" "${python_version:-未安装}" "python3 --version"
package_line PostgreSQL postgresql "$(command -v psql >/dev/null 2>&1 && echo true || echo false)" "${pg_version:-未安装}" "psql --version"

ext_line() { printf 'EXT|%s|%s|%s\n' "$1" "$2" "$3"; }

docker_running=false
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet docker 2>/dev/null; then docker_running=true; fi
fi
if [ "$docker_running" = "false" ] && pgrep -x dockerd >/dev/null 2>&1; then docker_running=true; fi
ext_line docker running "$docker_running"
dock_detail="—"
if command -v docker >/dev/null 2>&1; then
  dc=0
  if command -v timeout >/dev/null 2>&1; then
    dc=$(timeout 4 docker ps -q 2>/dev/null | wc -l | tr -d ' ')
  else
    dc=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
  fi
  case "$dc" in ''|*[!0-9]*) dc=0 ;; esac
  dock_detail="运行中容器 ${dc} 个"
fi
ext_line docker detail "$dock_detail"
ext_line docker port "—"

ngx_run=false
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet nginx 2>/dev/null; then ngx_run=true; fi
fi
ext_line nginx running "$ngx_run"
ext_line nginx port "80 / 443"

pg_unit=""
for u in postgresql postgresql@16-main postgresql@15-main postgresql@14-main postgresql@17-main postgresql-16 postgresql-15; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then pg_unit="$u"; break; fi
done
pg_run=false
[ -n "$pg_unit" ] && pg_run=true
ext_line postgresql running "$pg_run"
ext_line postgresql port "5432"
[ -n "$pg_unit" ] && ext_line postgresql unit "$pg_unit"

pm2_run=false
pm2_detail="—"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 ping >/dev/null 2>&1; then pm2_run=true; fi
  pc=0
  if command -v timeout >/dev/null 2>&1; then
    pc=$(timeout 4 pm2 jlist 2>/dev/null | grep -c '"pm_id"' || echo 0)
  else
    pc=$(pm2 jlist 2>/dev/null | grep -c '"pm_id"' || echo 0)
  fi
  case "$pc" in ''|*[!0-9]*) pc=0 ;; esac
  pm2_detail="托管应用 ${pc} 个"
fi
ext_line pm2 running "$pm2_run"
ext_line pm2 port "—"
ext_line pm2 detail "$pm2_detail"

node_r=$(command -v node >/dev/null 2>&1 && echo true || echo false)
ext_line nodejs running "$node_r"
ext_line nodejs port "—"

py_r=$(command -v python3 >/dev/null 2>&1 && echo true || echo false)
ext_line python3 running "$py_r"
ext_line python3 port "—"

check_port() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$" && echo true || echo false
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$" && echo true || echo false
    return
  fi
  echo false
}

line port_http "$(check_port 80)"
line port_https "$(check_port 443)"
line port_postgres "$(check_port 5432)"
line port_kiro "$(check_port 9527)"
line port_vite "$(check_port 5173)"

if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | \
    awk '
      {
        unit=$1
        load=$2
        active=$3
        substate=$4
        $1=$2=$3=$4=""
        sub(/^ +/, "", $0)
        printf "SVC|%s|%s|%s|%s|%s\n", unit, load, active, substate, $0
      }
    ' | head -n 120
fi
"##;

fn parse_telemetry(map: &HashMap<String, String>) -> Option<InspectionTelemetry> {
    let read = |key: &str| map.get(key).and_then(|v| v.parse::<f64>().ok());
    let cpu = read("metric_cpu_pct")?;
    let clamp = |n: f64| n.clamp(0.0, 100.0);
    Some(InspectionTelemetry {
        cpu_percent: clamp(cpu),
        cpu_iowait_percent: clamp(read("metric_cpu_iowait_pct").unwrap_or(0.0)),
        cpu_steal_percent: clamp(read("metric_cpu_steal_pct").unwrap_or(0.0)),
        memory_percent: clamp(read("metric_mem_pct").unwrap_or(0.0)),
        disk_percent: clamp(read("metric_disk_pct").unwrap_or(0.0)),
        inode_percent: clamp(read("metric_inode_pct").unwrap_or(0.0)),
        load_percent: clamp(read("metric_load_pct").unwrap_or(0.0)),
        net_down_bps: read("metric_net_rx_bps").filter(|v| *v >= 0.0).unwrap_or(0.0),
        net_up_bps: read("metric_net_tx_bps").filter(|v| *v >= 0.0).unwrap_or(0.0),
    })
}

fn parse_port_checks(map: &HashMap<String, String>) -> Vec<InspectionPortCheck> {
    [
        ("port_http", "HTTP", 80),
        ("port_https", "HTTPS", 443),
        ("port_postgres", "PostgreSQL", 5432),
        ("port_kiro", "Kiro Gateway", 9527),
        ("port_vite", "Vite", 5173),
    ]
    .iter()
    .map(|(key, label, port)| InspectionPortCheck {
        label: label.to_string(),
        port: *port,
        listening: map.get(*key).map(|v| v == "true").unwrap_or(false),
    })
    .collect()
}

fn parse_services(lines: &[String]) -> Vec<RemoteServiceStatus> {
    lines
        .iter()
        .filter(|l| l.starts_with("SVC|"))
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() < 5 {
                return None;
            }
            let unit = parts[1].to_string();
            if unit.is_empty() {
                return None;
            }
            Some(RemoteServiceStatus {
                unit,
                load: parts[2].to_string(),
                active: parts[3].to_string(),
                sub: parts[4].to_string(),
                description: parts.get(5..).map(|p| p.join("|")).unwrap_or_default().trim().to_string(),
            })
        })
        .collect()
}

fn check_reachability(url: &str, https: bool, host: &str, port: u16) -> InspectionReachabilityCheck {
    let label = if https { "HTTPS 入口" } else { "HTTP 入口" };
    let started = Instant::now();
    let addr = format!("{host}:{port}");
    let connect = addr
        .as_str()
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(3_500)));

    match connect {
        Some(Ok(mut stream)) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(3_500)));
            if https {
                // TCP-level reachability — TLS content is not probed (self-signed certs are common).
                return InspectionReachabilityCheck {
                    label: label.to_string(),
                    url: url.to_string(),
                    ok: true,
                    status_code: None,
                    response_time_ms: Some(started.elapsed().as_millis() as u64),
                    detail: Some("TCP 443 reachable".to_string()),
                };
            }
            let request = format!("GET / HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(request.as_bytes());
            let mut buf = [0u8; 2048];
            let status_code = match stream.read(&mut buf) {
                Ok(n) => {
                    let head = String::from_utf8_lossy(&buf[..n]);
                    head.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok())
                }
                Err(_) => None,
            };
            InspectionReachabilityCheck {
                label: label.to_string(),
                url: url.to_string(),
                ok: status_code.map(|s| s < 500).unwrap_or(true),
                status_code,
                response_time_ms: Some(started.elapsed().as_millis() as u64),
                detail: Some(status_code.map(|s| format!("HTTP {s}")).unwrap_or_else(|| "reachable".to_string())),
            }
        }
        Some(Err(e)) => InspectionReachabilityCheck {
            label: label.to_string(),
            url: url.to_string(),
            ok: false,
            status_code: None,
            response_time_ms: Some(started.elapsed().as_millis() as u64),
            detail: Some(e.to_string()),
        },
        None => InspectionReachabilityCheck {
            label: label.to_string(),
            url: url.to_string(),
            ok: false,
            status_code: None,
            response_time_ms: Some(started.elapsed().as_millis() as u64),
            detail: Some("无法解析地址".to_string()),
        },
    }
}

fn build_reachability_checks(payload: &VpsConnectionInput) -> Vec<InspectionReachabilityCheck> {
    let host = payload.host.trim();
    vec![
        check_reachability(&format!("http://{host}"), false, host, 80),
        check_reachability(&format!("https://{host}"), true, host, 443),
    ]
}

fn load_inspection_via_helper(payload: &VpsConnectionInput) -> AppResult<VpsInspection> {
    let value = helper_rpc(HelperKind::Inspect, payload, "inspect", serde_json::json!({}))?;
    let get = |k: &str| value.get(k).cloned().unwrap_or(Value::Null);
    let str_of = |v: &Value| v.as_str().unwrap_or("unknown").to_string();
    let reachability = build_reachability_checks(payload);
    Ok(VpsInspection {
        connection_id: payload.id.clone().unwrap_or_default(),
        checked_at: crate::util::now_iso(),
        hostname: str_of(&get("hostname")),
        os: str_of(&get("os")),
        kernel: str_of(&get("kernel")),
        uptime: str_of(&get("uptime")),
        working_directory: get("workingDirectory").as_str().unwrap_or("~").to_string(),
        package_manager: get("packageManager").as_str().map(|s| s.to_string()),
        metrics: serde_json::from_value(get("metrics")).unwrap_or_default(),
        telemetry: serde_json::from_value(get("telemetry")).ok(),
        port_checks: serde_json::from_value::<Vec<InspectionPortCheck>>(get("portChecks")).ok(),
        reachability_checks: Some(reachability),
        packages: serde_json::from_value::<Vec<RemotePackageStatus>>(get("packages")).unwrap_or_default(),
        services: serde_json::from_value::<Vec<RemoteServiceStatus>>(get("services")).ok(),
    })
}

fn load_inspection_via_shell(payload: &VpsConnectionInput) -> AppResult<VpsInspection> {
    let result = run_ssh_command(payload, INSPECTION_COMMAND, 45_000, "环境检测超时，请检查 SSH 连通性或认证配置")?;
    if result.code != 0 && !result.stderr.trim().is_empty() {
        return Err(internal_error(result.stderr.trim()));
    }
    let raw = result.stdout;
    let reachability = build_reachability_checks(payload);
    let lines: Vec<String> = raw.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let mut map: HashMap<String, String> = HashMap::new();
    let mut ext_by_id: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut packages: Vec<RemotePackageStatus> = Vec::new();

    for line in &lines {
        if let Some(rest) = line.strip_prefix("PKG|") {
            let parts: Vec<&str> = rest.split('|').collect();
            if parts.len() >= 5 {
                packages.push(RemotePackageStatus {
                    name: parts[0].to_string(),
                    id: parts[1].to_string(),
                    installed: parts[2] == "true",
                    version: Some(parts[3].to_string()),
                    command: parts[4].to_string(),
                    port_hint: None,
                    detail: None,
                    systemd_unit: None,
                    running: None,
                });
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("EXT|") {
            let parts: Vec<&str> = rest.split('|').collect();
            if parts.len() >= 3 {
                ext_by_id
                    .entry(parts[0].to_string())
                    .or_default()
                    .insert(parts[1].to_string(), parts[2..].join("|"));
            }
            continue;
        }
        if let Some(idx) = line.find('=') {
            map.insert(line[..idx].to_string(), line[idx + 1..].to_string());
        }
    }

    for pkg in packages.iter_mut() {
        if let Some(ext) = ext_by_id.get(&pkg.id) {
            pkg.running = ext.get("running").map(|v| v == "true");
            if let Some(p) = ext.get("port") {
                pkg.port_hint = Some(p.clone());
            }
            if let Some(d) = ext.get("detail") {
                pkg.detail = Some(d.clone());
            }
            if let Some(u) = ext.get("unit") {
                pkg.systemd_unit = Some(u.clone());
            }
        }
    }

    Ok(VpsInspection {
        connection_id: payload.id.clone().unwrap_or_default(),
        checked_at: crate::util::now_iso(),
        hostname: map.get("hostname").cloned().unwrap_or_else(|| "unknown".to_string()),
        os: map.get("os").cloned().unwrap_or_else(|| "unknown".to_string()),
        kernel: map.get("kernel").cloned().unwrap_or_else(|| "unknown".to_string()),
        uptime: map.get("uptime").cloned().unwrap_or_else(|| "unknown".to_string()),
        working_directory: map.get("workingDirectory").cloned().unwrap_or_else(|| "~".to_string()),
        package_manager: map.get("packageManager").cloned(),
        metrics: vec![
            SystemMetric { label: "CPU".to_string(), value: map.get("metric_cpu").cloned().unwrap_or_else(|| "unknown".to_string()) },
            SystemMetric { label: "逻辑核心".to_string(), value: map.get("metric_cores").cloned().unwrap_or_else(|| "unknown".to_string()) },
            SystemMetric { label: "内存占用".to_string(), value: map.get("metric_memory").cloned().unwrap_or_else(|| "unknown".to_string()) },
            SystemMetric { label: "系统盘".to_string(), value: map.get("metric_disk").cloned().unwrap_or_else(|| "unknown".to_string()) },
            SystemMetric { label: "inode".to_string(), value: map.get("metric_inode").cloned().unwrap_or_else(|| "unknown".to_string()) },
        ],
        telemetry: parse_telemetry(&map),
        port_checks: Some(parse_port_checks(&map)),
        reachability_checks: Some(reachability),
        packages,
        services: Some(parse_services(&lines)),
    })
}

pub fn inspect_connection(payload: &VpsConnectionInput, force_refresh: bool) -> AppResult<VpsInspection> {
    let key = cache_key(payload);
    if !force_refresh {
        let cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, value)) = cache.get(&key) {
            if at.elapsed() <= CACHE_TTL {
                return Ok(value.clone());
            }
        }
    }
    let inspection = load_inspection_via_helper(payload).or_else(|_| load_inspection_via_shell(payload))?;
    CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(key, (Instant::now(), inspection.clone()));
    Ok(inspection)
}
