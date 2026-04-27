import http from "node:http"
import https from "node:https"
import type { VpsInspection, VpsConnectionInput } from "../../shared/vps"
import { runSshCommand } from "./remote-command"

const INSPECTION_CACHE_TTL_MS = 15_000
const inspectionCache = new Map<string, { expiresAt: number; value: VpsInspection }>()
const inspectionInFlight = new Map<string, Promise<VpsInspection>>()

function inspectionCacheKey(payload: VpsConnectionInput) {
  return payload.id ?? `${payload.username}@${payload.host}:${payload.port}`
}

async function runRemoteCommand(
  payload: VpsConnectionInput,
  command: string,
  options?: { timeoutMs?: number },
) {
  const result = await runSshCommand(payload, command, {
    timeoutMs: options?.timeoutMs ?? 15_000,
    timeoutMessage: "环境检测超时，请检查 SSH 连通性或认证配置",
  })
  if (result.code !== 0 && result.stderr.trim()) {
    throw new Error(result.stderr.trim())
  }
  return result.stdout
}

const inspectionCommand = `
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
cpu_model=$(sh -lc "command -v lscpu >/dev/null 2>&1 && lscpu | awk -F: '/Model name/ {gsub(/^ +/, \\\"\\\", \\$2); print \\$2; exit}' || echo unknown")
cpu_cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo unknown)
memory_value=$(free -h 2>/dev/null | awk '/Mem:/ {print $3 \" / \" $2}' || echo unknown)
disk_value=$(df -h / 2>/dev/null | awk 'NR==2 {print $3 \" / \" $2 \" (\" $5 \")"}' || echo unknown)
inode_value=$(df -Pi / 2>/dev/null | awk 'NR==2 {print $3 \" / \" $2 \" (\" $5 \")"}' || echo unknown)
mem_pct=$(free 2>/dev/null | awk '/Mem:/ {if ($2+0>0) printf "%.1f", 100*$3/$2; else print "0"}' || echo 0)
disk_pct=$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5+0}' || echo 0)
inode_pct=$(df -Pi / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5+0}' || echo 0)
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)
load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
load_pct=$(awk -v L="$load1" -v C="$cores" 'BEGIN {c=C+0; if(c<1)c=1; l=L+0; p=100*l/c; if(p>100)p=100; printf "%.1f", p}')
cpu_pct=0
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
        irq1 = x[6] + 0
        irq2 = y[6] + 0
        softirq1 = x[7] + 0
        softirq2 = y[7] + 0
        steal1 = x[8] + 0
        steal2 = y[8] + 0
        user1 = x[1] + 0
        user2 = y[1] + 0
        nice1 = x[2] + 0
        nice2 = y[2] + 0
        system1 = x[3] + 0
        system2 = y[3] + 0
        delta_total = total2 - total1
        delta_user = user2 - user1
        delta_nice = nice2 - nice1
        delta_system = system2 - system1
        delta_idle = idle2 - idle1
        delta_iowait = iowait2 - iowait1
        delta_irq = irq2 - irq1
        delta_softirq = softirq2 - softirq1
        delta_steal = steal2 - steal1
        if (delta_total > 0) {
          busy = delta_user + delta_nice + delta_system + delta_irq + delta_softirq
          if (busy < 0) busy = 0
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
if [ -z "$cpu_iowait_pct" ]; then cpu_iowait_pct=0; fi
if [ -z "$cpu_steal_pct" ]; then cpu_steal_pct=0; fi
if awk -v p="$cpu_pct" 'BEGIN{exit !(p+0<=0)}'; then
  cpu_idle2=$(vmstat 1 2 2>/dev/null | tail -1 | awk '{print $15}' || echo "")
  if [ -n "$cpu_idle2" ]; then
    cpu_pct=$(awk -v id="$cpu_idle2" 'BEGIN {i=id+0; if(i>100)i=100; if(i<0)i=0; printf "%.1f", 100-i}')
  fi
fi
if awk -v p="$cpu_pct" 'BEGIN{exit !(p+0<=0)}'; then
  cpu_idle_line=$(LANG=C top -bn1 2>/dev/null | grep -E '^%Cpu|^Cpu' | head -1 || true)
  if echo "$cpu_idle_line" | grep -q id; then
    cpu_idle=$(echo "$cpu_idle_line" | sed -n 's/.*, *\\([0-9.]*\\) *id.*/\\1/p' | head -1)
    if [ -n "$cpu_idle" ]; then
      cpu_pct=$(awk -v id="$cpu_idle" 'BEGIN {i=id+0; if(i>100)i=100; if(i<0)i=0; printf "%.1f", 100-i}')
    fi
  fi
fi
iface=$(awk -F':' '/^[[:space:]]*(eth|en|wl|wlan|bond|venet|veth)/ {gsub(/^[[:space:]]+/, "", $1); print $1; exit}' /proc/net/dev)
if [ -z "$iface" ]; then iface=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.*dev \\([^ ]*\\).*/\\1/p'); fi
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
package_line Docker docker "$(command -v docker >/dev/null 2>&1 && echo true || echo false)" "\${docker_version:-未安装}" "docker --version"
package_line Node.js nodejs "$(command -v node >/dev/null 2>&1 && echo true || echo false)" "\${node_version:-未安装}" "node --version"
package_line Nginx nginx "$(command -v nginx >/dev/null 2>&1 && echo true || echo false)" "\${nginx_version:-未安装}" "nginx -v"
package_line PM2 pm2 "$(command -v pm2 >/dev/null 2>&1 && echo true || echo false)" "\${pm2_version:-未安装}" "pm2 --version"
package_line "Python 3" python3 "$(command -v python3 >/dev/null 2>&1 && echo true || echo false)" "\${python_version:-未安装}" "python3 --version"
package_line PostgreSQL postgresql "$(command -v psql >/dev/null 2>&1 && echo true || echo false)" "\${pg_version:-未安装}" "psql --version"

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
  dock_detail="运行中容器 \${dc} 个"
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
  pm2_detail="托管应用 \${pc} 个"
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
`

function parseInspectionTelemetry(map: Map<string, string>): VpsInspection["telemetry"] | undefined {
  const read = (key: string) => Number.parseFloat(map.get(key) ?? "")
  const cpuPercent = read("metric_cpu_pct")
  if (!Number.isFinite(cpuPercent)) {
    return undefined
  }
  const clamp = (n: number) => Math.min(100, Math.max(0, n))
  const cpuIowaitPercent = read("metric_cpu_iowait_pct")
  const cpuStealPercent = read("metric_cpu_steal_pct")
  const memoryPercent = read("metric_mem_pct")
  const diskPercent = read("metric_disk_pct")
  const inodePercent = read("metric_inode_pct")
  const loadPercent = read("metric_load_pct")
  const netDownBps = read("metric_net_rx_bps")
  const netUpBps = read("metric_net_tx_bps")
  return {
    cpuPercent: clamp(cpuPercent),
    cpuIowaitPercent: clamp(Number.isFinite(cpuIowaitPercent) ? cpuIowaitPercent : 0),
    cpuStealPercent: clamp(Number.isFinite(cpuStealPercent) ? cpuStealPercent : 0),
    memoryPercent: clamp(Number.isFinite(memoryPercent) ? memoryPercent : 0),
    diskPercent: clamp(Number.isFinite(diskPercent) ? diskPercent : 0),
    inodePercent: clamp(Number.isFinite(inodePercent) ? inodePercent : 0),
    loadPercent: clamp(Number.isFinite(loadPercent) ? loadPercent : 0),
    netDownBps: Number.isFinite(netDownBps) && netDownBps >= 0 ? netDownBps : 0,
    netUpBps: Number.isFinite(netUpBps) && netUpBps >= 0 ? netUpBps : 0,
  }
}

function parsePortChecks(map: Map<string, string>): VpsInspection["portChecks"] {
  const checks = [
    { key: "port_http", label: "HTTP", port: 80 },
    { key: "port_https", label: "HTTPS", port: 443 },
    { key: "port_postgres", label: "PostgreSQL", port: 5432 },
    { key: "port_kiro", label: "Kiro Gateway", port: 9527 },
    { key: "port_vite", label: "Vite", port: 5173 },
  ]
  return checks.map((item) => ({
    label: item.label,
    port: item.port,
    listening: map.get(item.key) === "true",
  }))
}

async function checkReachability(url: string): Promise<NonNullable<VpsInspection["reachabilityChecks"]>[number]> {
  const target = new URL(url)
  const client = target.protocol === "https:" ? https : http
  const startedAt = Date.now()

  return await new Promise((resolve) => {
    const req = client.request(
      target,
      {
        method: "GET",
        timeout: 3_500,
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume()
        const responseTimeMs = Date.now() - startedAt
        const statusCode = response.statusCode
        const ok = typeof statusCode === "number" ? statusCode < 500 : true
        resolve({
          label: target.protocol === "https:" ? "HTTPS 入口" : "HTTP 入口",
          url,
          ok,
          statusCode,
          responseTimeMs,
          detail: statusCode ? `HTTP ${statusCode}` : "reachable",
        })
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error("timeout"))
    })
    req.on("error", (error) => {
      resolve({
        label: target.protocol === "https:" ? "HTTPS 入口" : "HTTP 入口",
        url,
        ok: false,
        responseTimeMs: Date.now() - startedAt,
        detail: error.message,
      })
    })
    req.end()
  })
}

async function buildReachabilityChecks(payload: VpsConnectionInput): Promise<VpsInspection["reachabilityChecks"]> {
  const targets = [`http://${payload.host}`, `https://${payload.host}`]
  return await Promise.all(targets.map((url) => checkReachability(url)))
}

function mergeExtIntoPackages(
  packages: VpsInspection["packages"],
  extById: Map<string, Record<string, string>>,
): VpsInspection["packages"] {
  return packages.map((pkg) => {
    const ext = extById.get(pkg.id)
    if (!ext) {
      return pkg
    }
    let running: boolean | undefined
    if (ext.running === "true") {
      running = true
    } else if (ext.running === "false") {
      running = false
    }
    return {
      ...pkg,
      running,
      portHint: ext.port ?? pkg.portHint,
      detail: ext.detail ?? pkg.detail,
      systemdUnit: ext.unit ?? pkg.systemdUnit,
    }
  })
}

async function loadInspection(payload: VpsConnectionInput): Promise<VpsInspection> {
  const raw = await runRemoteCommand(payload, inspectionCommand, {
    timeoutMs: 45_000,
  })
  const reachabilityChecks = await buildReachabilityChecks(payload).catch(() => [])
  const lines = raw
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)

  const map = new Map<string, string>()
  const extById = new Map<string, Record<string, string>>()
  const packages: VpsInspection["packages"] = []

  for (const line of lines) {
    if (line.startsWith("PKG|")) {
      const parts = line.split("|")
      if (parts.length >= 6) {
        const [, name, id, installed, version, command] = parts
        packages.push({
          name,
          id,
          installed: installed === "true",
          version,
          command,
        })
      } else {
        const [, name, installed, version, command] = parts
        packages.push({
          name,
          id: name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "") || "unknown",
          installed: installed === "true",
          version,
          command,
        })
      }
      continue
    }

    if (line.startsWith("EXT|")) {
      const parts = line.split("|")
      if (parts.length >= 4) {
        const id = parts[1]
        const key = parts[2]
        const value = parts.slice(3).join("|")
        const bag = extById.get(id) ?? {}
        bag[key] = value
        extById.set(id, bag)
      }
      continue
    }

    const [key, ...rest] = line.split("=")
    map.set(key, rest.join("="))
  }

  return {
    connectionId: payload.id ?? "",
    checkedAt: new Date().toISOString(),
    hostname: map.get("hostname") ?? "unknown",
    os: map.get("os") ?? "unknown",
    kernel: map.get("kernel") ?? "unknown",
    uptime: map.get("uptime") ?? "unknown",
    workingDirectory: map.get("workingDirectory") ?? "~",
    packageManager: map.get("packageManager") ?? "unknown",
    metrics: [
      { label: "CPU", value: map.get("metric_cpu") ?? "unknown" },
      { label: "逻辑核心", value: map.get("metric_cores") ?? "unknown" },
      { label: "内存占用", value: map.get("metric_memory") ?? "unknown" },
      { label: "系统盘", value: map.get("metric_disk") ?? "unknown" },
      { label: "inode", value: map.get("metric_inode") ?? "unknown" },
    ],
    telemetry: parseInspectionTelemetry(map),
    portChecks: parsePortChecks(map),
    reachabilityChecks,
    packages: mergeExtIntoPackages(packages, extById),
  }
}

export async function inspectConnection(
  payload: VpsConnectionInput,
  options?: { forceRefresh?: boolean },
): Promise<VpsInspection> {
  const key = inspectionCacheKey(payload)
  if (!options?.forceRefresh) {
    const cached = inspectionCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }
    const pending = inspectionInFlight.get(key)
    if (pending) {
      return await pending
    }
  }

  const pending = loadInspection(payload)
    .then((inspection) => {
      inspectionCache.set(key, {
        value: inspection,
        expiresAt: Date.now() + INSPECTION_CACHE_TTL_MS,
      })
      inspectionInFlight.delete(key)
      return inspection
    })
    .catch((error) => {
      inspectionInFlight.delete(key)
      throw error
    })

  inspectionInFlight.set(key, pending)
  return await pending
}
