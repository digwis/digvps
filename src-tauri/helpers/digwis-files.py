#!/usr/bin/env python3
import concurrent.futures
import json
import os
import shutil
import stat
import sys
import threading
import time
from datetime import datetime, timezone

DEFAULT_ROOT = os.environ.get("DIGWIS_DEFAULT_ROOT", "/var/www")
BROWSE_CACHE_TTL = 10.0
PREFETCH_LIMIT = 6
VERSION = "2026-04-28.1"

browse_cache = {}
realpath_cache = {}
cache_lock = threading.Lock()
executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

def now_ts():
    return time.time()

def iso_time(ts):
    if not ts or ts <= 0:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")

def normalize_path(raw):
    if not raw:
        return DEFAULT_ROOT
    raw = str(raw).replace("\\", "/").strip()
    if not raw:
        return DEFAULT_ROOT
    if not raw.startswith("/"):
        raw = "/" + raw
    return os.path.normpath(raw)

def stat_type(st):
    mode = st.st_mode
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "file"

def format_permissions(st_mode):
    permission_bits = stat.S_IMODE(st_mode)
    return {
        "octal": format(permission_bits, "03o"),
        "symbolic": stat.filemode(st_mode),
    }

def cached_realpath(path_value):
    normalized = normalize_path(path_value)
    with cache_lock:
        cached = realpath_cache.get(normalized)
        if cached and now_ts() - cached["cached_at"] <= BROWSE_CACHE_TTL:
            return cached["value"]
    try:
        value = os.path.realpath(normalized)
    except OSError:
        value = None
    with cache_lock:
        realpath_cache[normalized] = {"cached_at": now_ts(), "value": value}
    return value

def invalidate(path_value):
    normalized = normalize_path(path_value)
    parent = os.path.dirname(normalized) or "/"
    with cache_lock:
        for key in [normalized, parent]:
            browse_cache.pop(key, None)
            realpath_cache.pop(key, None)

def browse_entry(parent_path, name):
    child_path = os.path.join(parent_path, name)
    try:
        st = os.lstat(child_path)
        return {
            "name": name,
            "path": normalize_path(child_path),
            "type": stat_type(st),
            "size": 0 if stat.S_ISDIR(st.st_mode) else int(st.st_size),
            "modifiedAt": iso_time(st.st_mtime),
        }
    except OSError:
        return None

def resolve_directory_path(requested_path, allow_parent_fallback=False):
    queue = [normalize_path(requested_path)]
    visited = set()
    while queue:
        candidate = normalize_path(queue.pop(0))
        if candidate in visited:
            continue
        visited.add(candidate)
        try:
            st = os.lstat(candidate)
            if stat.S_ISDIR(st.st_mode):
                return candidate
        except OSError:
            st = None
        real_candidate = cached_realpath(candidate)
        if real_candidate and real_candidate not in visited:
            try:
                real_st = os.lstat(real_candidate)
                if stat.S_ISDIR(real_st.st_mode):
                    return normalize_path(real_candidate)
            except OSError:
                pass
            queue.append(real_candidate)
        if allow_parent_fallback:
            parent = os.path.dirname(candidate) or "/"
            if parent != candidate:
                queue.append(parent)
            if real_candidate:
                real_parent = os.path.dirname(real_candidate) or "/"
                if real_parent != real_candidate:
                    queue.append(real_parent)
    raise RuntimeError("当前路径不是目录")

def resolve_browse_target(path_value):
    initial = normalize_path(path_value)
    allow_parent_fallback = not path_value or not str(path_value).strip()
    try:
        st = os.lstat(initial)
        kind = stat_type(st)
    except OSError:
        st = None
        kind = None

    if kind == "directory" or (not path_value or not str(path_value).strip()):
        return {
            "currentPath": resolve_directory_path(initial, allow_parent_fallback),
            "focusedPath": None,
            "focusedType": None,
        }

    if kind in ("file", "symlink"):
        real_path = cached_realpath(initial)
        if real_path:
            try:
                real_st = os.lstat(real_path)
                real_kind = stat_type(real_st)
            except OSError:
                real_kind = None
        else:
            real_kind = None
        if real_kind == "directory":
            return {
                "currentPath": normalize_path(real_path),
                "focusedPath": None,
                "focusedType": None,
            }
        focused_path = normalize_path(real_path or initial)
        focused_type = real_kind or kind
        parent_path = os.path.dirname(focused_path) or "/"
        return {
            "currentPath": resolve_directory_path(parent_path, True),
            "focusedPath": focused_path,
            "focusedType": focused_type,
        }

    return {
        "currentPath": resolve_directory_path(initial, allow_parent_fallback),
        "focusedPath": None,
        "focusedType": None,
    }

def prefetch_child(child_path):
    try:
        handle_browse({"path": child_path, "_prefetch": True})
    except Exception:
        return None
    return None

def handle_browse(params):
    target = resolve_browse_target(params.get("path"))
    current_path = normalize_path(target["currentPath"])
    if not params.get("forceRefresh"):
        with cache_lock:
            cached = browse_cache.get(current_path)
            if cached and now_ts() - cached["cached_at"] <= BROWSE_CACHE_TTL:
                result = dict(cached["value"])
                result["focusedPath"] = target["focusedPath"]
                result["focusedType"] = target["focusedType"]
                return result

    entries = []
    with os.scandir(current_path) as it:
        for item in it:
            if item.name in (".", ".."):
                continue
            entry = browse_entry(current_path, item.name)
            if entry:
                entries.append(entry)
    entries.sort(key=lambda entry: (0 if entry["type"] == "directory" else 1, entry["name"].lower()))
    root_path = resolve_directory_path(DEFAULT_ROOT, True)
    result = {
        "currentPath": current_path,
        "parentPath": None if current_path == "/" else (os.path.dirname(current_path) or "/"),
        "rootPath": root_path,
        "focusedPath": target["focusedPath"],
        "focusedType": target["focusedType"],
        "entries": entries,
    }
    with cache_lock:
        browse_cache[current_path] = {
            "cached_at": now_ts(),
            "value": {
                "currentPath": result["currentPath"],
                "parentPath": result["parentPath"],
                "rootPath": result["rootPath"],
                "focusedPath": None,
                "focusedType": None,
                "entries": entries,
            },
        }
    if not params.get("_prefetch"):
        for child in [entry for entry in entries if entry["type"] == "directory"][:PREFETCH_LIMIT]:
            executor.submit(prefetch_child, child["path"])
    return result

def handle_stat(params):
    target_path = normalize_path(params.get("path"))
    st = os.lstat(target_path)
    return {
        "path": target_path,
        "type": stat_type(st),
        "size": int(st.st_size),
        "modifiedAt": iso_time(st.st_mtime),
        "realPath": cached_realpath(target_path),
        "permissions": format_permissions(st.st_mode),
    }

def handle_read_text(params):
    target_path = normalize_path(params.get("path"))
    st = os.lstat(target_path)
    if stat.S_ISDIR(st.st_mode):
        raise RuntimeError("目录不能直接作为文本文件打开")
    if st.st_size > 1024 * 1024:
        raise RuntimeError("暂只支持打开 1 MB 以内的文本文件")
    with open(target_path, "rb") as handle:
        raw = handle.read()
    if b"\x00" in raw:
        raise RuntimeError("该文件看起来是二进制内容，暂不支持在面板里直接编辑")
    return {
        "path": target_path,
        "content": raw.decode("utf-8"),
        "size": int(st.st_size),
        "modifiedAt": iso_time(st.st_mtime),
    }

def handle_write_text(params):
    target_path = normalize_path(params.get("path"))
    parent = os.path.dirname(target_path) or "/"
    if not os.path.isdir(parent):
        raise RuntimeError("目标目录不存在")
    with open(target_path, "w", encoding="utf-8") as handle:
        handle.write(params.get("content", ""))
    invalidate(target_path)
    return {"ok": True, "path": target_path, "message": "文件已保存"}

def handle_mkdir(params):
    parent = normalize_path(params.get("parentPath"))
    name = str(params.get("directoryName", "")).strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise RuntimeError("目录名无效")
    target = normalize_path(os.path.join(parent, name))
    os.mkdir(target)
    invalidate(parent)
    return {"ok": True, "path": target, "message": "目录已创建"}

def handle_rename(params):
    target_path = normalize_path(params.get("path"))
    next_name = str(params.get("nextName", "")).strip()
    if not next_name or "/" in next_name or "\\" in next_name or next_name in (".", ".."):
        raise RuntimeError("名称无效")
    next_path = normalize_path(os.path.join(os.path.dirname(target_path) or "/", next_name))
    os.rename(target_path, next_path)
    invalidate(target_path)
    invalidate(next_path)
    return {"ok": True, "path": next_path, "message": "名称已更新"}

def apply_permissions(target_path, mode_value, recursive=False):
    st = os.lstat(target_path)
    os.chmod(target_path, mode_value)
    if recursive and stat.S_ISDIR(st.st_mode):
        for root, dirnames, filenames in os.walk(target_path, topdown=True, followlinks=False):
            for dirname in dirnames:
                os.chmod(os.path.join(root, dirname), mode_value)
            for filename in filenames:
                file_path = os.path.join(root, filename)
                try:
                    file_st = os.lstat(file_path)
                except OSError:
                    continue
                if stat.S_ISLNK(file_st.st_mode):
                    continue
                os.chmod(file_path, mode_value)

def handle_chmod(params):
    target_path = normalize_path(params.get("path"))
    raw_mode = str(params.get("mode", "")).strip()
    recursive = bool(params.get("recursive"))
    if not raw_mode or any(ch not in "01234567" for ch in raw_mode) or len(raw_mode) not in (3, 4):
        raise RuntimeError("权限必须是 3 到 4 位八进制数字")
    mode_value = int(raw_mode, 8)
    apply_permissions(target_path, mode_value, recursive)
    invalidate(target_path)
    return {"ok": True, "path": target_path, "message": "权限已更新"}

def handle_delete(params):
    target_path = normalize_path(params.get("path"))
    st = os.lstat(target_path)
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(target_path)
        message = "目录已删除"
    else:
        os.remove(target_path)
        message = "文件已删除"
    invalidate(target_path)
    return {"ok": True, "path": target_path, "message": message}

def dispatch(method, params):
    if method == "ping":
        return {"ok": True}
    if method == "version":
        return {"version": VERSION}
    if method == "browse":
        return handle_browse(params)
    if method == "stat":
        return handle_stat(params)
    if method == "readText":
        return handle_read_text(params)
    if method == "writeText":
        return handle_write_text(params)
    if method == "mkdir":
        return handle_mkdir(params)
    if method == "rename":
        return handle_rename(params)
    if method == "chmod":
        return handle_chmod(params)
    if method == "delete":
        return handle_delete(params)
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
