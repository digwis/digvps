#!/usr/bin/env python3
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time

VERSION = "${REMOTE_INSPECTION_HELPER_VERSION}"
ROOT_PATH = "/"
PACKAGE_IDS = ("apt", "yum", "dnf", "apk", "pacman")
PORTS = (
    ("HTTP", 80),
    ("HTTPS", 443),
    ("PostgreSQL", 5432),
    ("Kiro Gateway", 9527),
    ("Vite", 5173),
)

sample_lock = threading.Lock()
previous_sample = None


def run_command(command, timeout=5):
    try:
        return subprocess.run(
            ["bash", "-lc", command],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return None


def command_output(command, timeout=5, default="unknown"):
    result = run_command(command, timeout=timeout)
    if not result:
        return default
    output = (result.stdout or result.stderr or "").strip()
    return output or default


def read_os_name():
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return command_output("uname -s", timeout=2, default="unknown")


def read_uptime():
    pretty = command_output("uptime -p", timeout=2, default="")
    if pretty:
        return pretty
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            seconds = int(float(handle.read().split()[0]))
        days, seconds = divmod(seconds, 86400)
        hours, seconds = divmod(seconds, 3600)
        minutes = seconds // 60
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes or not parts:
            parts.append(f"{minutes}m")
        return " ".join(parts)
    except Exception:
        return "unknown"


def detect_package_manager():
    for name in PACKAGE_IDS:
        if shutil.which(name):
            return name
    return "unknown"


def read_cpu_model():
    if shutil.which("lscpu"):
        result = run_command("lscpu", timeout=2)
        if result and result.stdout:
            for line in result.stdout.splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                if key.strip() == "Model name":
                    return value.strip() or "unknown"
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                if key.strip().lower() == "model name":
                    return value.strip() or "unknown"
    except OSError:
        pass
    return "unknown"


def read_meminfo():
    values = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                key, raw = line.split(":", 1)
                number = raw.strip().split()[0]
                values[key] = int(number)
    except Exception:
        return None
    return values


def format_bytes(value):
    if value is None or value < 0:
        return "unknown"
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    amount = float(value)
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024.0
        index += 1
    if index == 0:
        return f"{int(amount)} {units[index]}"
    if amount >= 10:
        return f"{amount:.0f} {units[index]}"
    return f"{amount:.1f} {units[index]}"


def read_memory_metrics():
    meminfo = read_meminfo()
    if not meminfo:
        return {"value": "unknown", "percent": 0.0}
    total = int(meminfo.get("MemTotal", 0)) * 1024
    available = int(meminfo.get("MemAvailable", 0)) * 1024
    used = max(total - available, 0)
    percent = (used / total * 100.0) if total > 0 else 0.0
    return {
        "value": f"{format_bytes(used)} / {format_bytes(total)}",
        "percent": clamp(percent),
    }


def read_disk_metrics():
    try:
        stats = os.statvfs(ROOT_PATH)
        total = stats.f_blocks * stats.f_frsize
        free = stats.f_bavail * stats.f_frsize
        used = max(total - free, 0)
        percent = (used / total * 100.0) if total > 0 else 0.0
        return {
            "value": f"{format_bytes(used)} / {format_bytes(total)} ({int(round(percent))}%)",
            "percent": clamp(percent),
        }
    except OSError:
        return {"value": "unknown", "percent": 0.0}


def read_inode_metrics():
    try:
        stats = os.statvfs(ROOT_PATH)
        total = int(stats.f_files)
        free = int(stats.f_ffree)
        used = max(total - free, 0)
        percent = (used / total * 100.0) if total > 0 else 0.0
        return {
            "value": f"{used} / {total} ({int(round(percent))}%)",
            "percent": clamp(percent),
        }
    except OSError:
        return {"value": "unknown", "percent": 0.0}


def clamp(value):
    try:
        numeric = float(value)
    except Exception:
        return 0.0
    if numeric < 0:
        return 0.0
    if numeric > 100:
        return 100.0
    return numeric


def read_cpu_stat():
    try:
        with open("/proc/stat", "r", encoding="utf-8") as handle:
            for line in handle:
                if not line.startswith("cpu "):
                    continue
                parts = line.split()
                values = [int(item) for item in parts[1:9]]
                while len(values) < 8:
                    values.append(0)
                return values
    except Exception:
        return None
    return None


def select_interface():
    result = run_command("ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.*dev \\([^ ]*\\).*/\\1/p'", timeout=2)
    if result and result.stdout.strip():
        return result.stdout.strip()
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as handle:
            for line in handle.readlines()[2:]:
                if ":" not in line:
                    continue
                name = line.split(":", 1)[0].strip()
                if re.match(r"^(eth|en|wl|wlan|bond|venet|veth)", name):
                    return name
    except OSError:
        pass
    return None


def read_network_bytes(iface):
    if not iface:
        return None
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as handle:
            for line in handle.readlines()[2:]:
                if ":" not in line:
                    continue
                name, rest = line.split(":", 1)
                if name.strip() != iface:
                    continue
                fields = rest.split()
                return (int(fields[0]), int(fields[8]))
    except Exception:
        return None
    return None


def build_sample():
    iface = select_interface()
    return {
        "at": time.time(),
        "cpu": read_cpu_stat(),
        "iface": iface,
        "net": read_network_bytes(iface),
    }


def compute_cpu_metrics(previous, current):
    before = previous.get("cpu") if previous else None
    after = current.get("cpu")
    if not before or not after or len(before) < 8 or len(after) < 8:
        return {"cpu": 0.0, "iowait": 0.0, "steal": 0.0}
    total_before = sum(before[:8])
    total_after = sum(after[:8])
    delta_total = total_after - total_before
    if delta_total <= 0:
        return {"cpu": 0.0, "iowait": 0.0, "steal": 0.0}
    delta_idle = after[3] - before[3]
    delta_iowait = after[4] - before[4]
    delta_steal = after[7] - before[7]
    busy = delta_total - delta_idle - delta_iowait
    return {
        "cpu": clamp(100.0 * max(busy, 0) / delta_total),
        "iowait": clamp(100.0 * max(delta_iowait, 0) / delta_total),
        "steal": clamp(100.0 * max(delta_steal, 0) / delta_total),
    }


def compute_network_rates(previous, current):
    before = previous.get("net") if previous else None
    after = current.get("net")
    if not before or not after:
        return {"down": 0.0, "up": 0.0}
    elapsed = max(float(current.get("at", 0)) - float(previous.get("at", 0)), 0.001)
    down = max(after[0] - before[0], 0) / elapsed
    up = max(after[1] - before[1], 0) / elapsed
    return {"down": down, "up": up}


def compute_live_telemetry():
    global previous_sample
    with sample_lock:
        current = build_sample()
        previous = previous_sample
        if previous is None or current["iface"] != previous.get("iface") or current["at"] - previous.get("at", 0) < 0.25:
            previous = current
            time.sleep(0.6)
            current = build_sample()
        cpu = compute_cpu_metrics(previous, current)
        net = compute_network_rates(previous, current)
        previous_sample = current
    memory = read_memory_metrics()
    disk = read_disk_metrics()
    inode = read_inode_metrics()
    cores = os.cpu_count() or 1
    try:
        load1 = os.getloadavg()[0]
    except OSError:
        load1 = 0.0
    load_percent = clamp((load1 / max(cores, 1)) * 100.0)
    return {
        "cpuPercent": round(cpu["cpu"], 1),
        "cpuIowaitPercent": round(cpu["iowait"], 1),
        "cpuStealPercent": round(cpu["steal"], 1),
        "memoryPercent": round(memory["percent"], 1),
        "diskPercent": round(disk["percent"], 1),
        "inodePercent": round(inode["percent"], 1),
        "loadPercent": round(load_percent, 1),
        "netDownBps": max(int(round(net["down"])), 0),
        "netUpBps": max(int(round(net["up"])), 0),
    }


def list_listening_ports():
    result = run_command("ss -ltnH 2>/dev/null", timeout=3)
    if result and result.stdout:
        lines = result.stdout.splitlines()
    else:
        result = run_command("netstat -ltn 2>/dev/null", timeout=3)
        lines = result.stdout.splitlines() if result and result.stdout else []
    ports = set()
    for line in lines:
        fields = line.split()
        if not fields:
            continue
        address = fields[-2] if len(fields) >= 2 else fields[-1]
        match = re.search(r":(\d+)$", address)
        if match:
            ports.add(int(match.group(1)))
    return ports


def collect_services():
    if not shutil.which("systemctl"):
        return []
    result = run_command(
        "systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n 120",
        timeout=6,
    )
    if not result or not result.stdout:
        return []
    services = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        unit = parts[0]
        load = parts[1]
        active = parts[2]
        sub = parts[3]
        description = parts[4].strip() if len(parts) > 4 else ""
        services.append({
            "unit": unit,
            "load": load,
            "active": active,
            "sub": sub,
            "description": description,
        })
    return services


def bool_command(command, timeout=4):
    result = run_command(command, timeout=timeout)
    return bool(result and result.returncode == 0)


def count_command(command, timeout=4):
    result = run_command(command, timeout=timeout)
    if not result:
        return 0
    output = (result.stdout or "").strip()
    try:
        return int(output)
    except ValueError:
        return 0


def package_statuses():
    docker_installed = shutil.which("docker") is not None
    nginx_installed = shutil.which("nginx") is not None
    node_installed = shutil.which("node") is not None
    pm2_installed = shutil.which("pm2") is not None
    python_installed = shutil.which("python3") is not None
    psql_installed = shutil.which("psql") is not None

    docker_running = bool_command("systemctl is-active --quiet docker 2>/dev/null") or bool_command("pgrep -x dockerd >/dev/null 2>&1", timeout=2)
    docker_count = count_command("docker ps -q 2>/dev/null | wc -l | tr -d ' '", timeout=4) if docker_installed else 0
    nginx_running = bool_command("systemctl is-active --quiet nginx 2>/dev/null")

    pg_unit = ""
    for unit in ("postgresql", "postgresql@16-main", "postgresql@15-main", "postgresql@14-main", "postgresql@17-main", "postgresql-16", "postgresql-15"):
        if bool_command(f"systemctl is-active --quiet {unit} 2>/dev/null", timeout=2):
            pg_unit = unit
            break
    pg_running = bool(pg_unit)

    pm2_running = bool_command("pm2 ping >/dev/null 2>&1", timeout=4) if pm2_installed else False
    pm2_count = count_command("pm2 jlist 2>/dev/null | grep -c '\"pm_id\"' || echo 0", timeout=4) if pm2_installed else 0

    return [
        {
            "name": "Docker",
            "id": "docker",
            "installed": docker_installed,
            "version": command_output("docker --version", timeout=3, default="未安装") if docker_installed else "未安装",
            "command": "docker --version",
            "running": docker_running,
            "portHint": "—",
            "detail": f"运行中容器 {docker_count} 个" if docker_installed else "—",
        },
        {
            "name": "Node.js",
            "id": "nodejs",
            "installed": node_installed,
            "version": command_output("node --version", timeout=2, default="未安装") if node_installed else "未安装",
            "command": "node --version",
            "running": node_installed,
            "portHint": "—",
        },
        {
            "name": "Nginx",
            "id": "nginx",
            "installed": nginx_installed,
            "version": command_output("nginx -v", timeout=3, default="未安装") if nginx_installed else "未安装",
            "command": "nginx -v",
            "running": nginx_running,
            "portHint": "80 / 443",
        },
        {
            "name": "PM2",
            "id": "pm2",
            "installed": pm2_installed,
            "version": command_output("pm2 --version", timeout=3, default="未安装") if pm2_installed else "未安装",
            "command": "pm2 --version",
            "running": pm2_running,
            "portHint": "—",
            "detail": f"托管应用 {pm2_count} 个" if pm2_installed else "—",
        },
        {
            "name": "Python 3",
            "id": "python3",
            "installed": python_installed,
            "version": command_output("python3 --version", timeout=2, default="未安装") if python_installed else "未安装",
            "command": "python3 --version",
            "running": python_installed,
            "portHint": "—",
        },
        {
            "name": "PostgreSQL",
            "id": "postgresql",
            "installed": psql_installed,
            "version": command_output("psql --version", timeout=2, default="未安装") if psql_installed else "未安装",
            "command": "psql --version",
            "running": pg_running,
            "portHint": "5432",
            "systemdUnit": pg_unit or None,
        },
    ]


def build_metrics():
    memory = read_memory_metrics()
    disk = read_disk_metrics()
    inode = read_inode_metrics()
    return [
        {"label": "CPU", "value": read_cpu_model()},
        {"label": "逻辑核心", "value": str(os.cpu_count() or "unknown")},
        {"label": "内存占用", "value": memory["value"]},
        {"label": "系统盘", "value": disk["value"]},
        {"label": "inode", "value": inode["value"]},
    ]


def build_port_checks():
    listening = list_listening_ports()
    return [
        {"label": label, "port": port, "listening": port in listening}
        for label, port in PORTS
    ]


def handle_inspect(_params):
    return {
        "hostname": socket.gethostname() or "unknown",
        "os": read_os_name(),
        "kernel": command_output("uname -r", timeout=2, default="unknown"),
        "uptime": read_uptime(),
        "workingDirectory": os.path.expanduser("~") or "~",
        "packageManager": detect_package_manager(),
        "metrics": build_metrics(),
        "telemetry": compute_live_telemetry(),
        "portChecks": build_port_checks(),
        "packages": package_statuses(),
        "services": collect_services(),
    }


def dispatch(method, params):
    if method == "ping":
        return {"ok": True}
    if method == "version":
        return {"version": VERSION}
    if method == "inspect":
        return handle_inspect(params)
    raise RuntimeError("unsupported_method")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue
    request_id = None
    try:
        payload = json.loads(line)
        request_id = payload.get("id")
        result = dispatch(payload.get("method"), payload.get("params") or {})
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        emit({"id": request_id, "ok": False, "error": str(exc)})
