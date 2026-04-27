export const REMOTE_FILE_HELPER_VERSION = "2026-04-25.1"

export const REMOTE_FILE_HELPER_SCRIPT = String.raw`#!/usr/bin/env python3
import concurrent.futures
import json
import os
import shutil
import stat
import sys
import threading
import time
from datetime import datetime, timezone

DEFAULT_ROOT = "/var/www"
BROWSE_CACHE_TTL = 10.0
PREFETCH_LIMIT = 6
VERSION = "${REMOTE_FILE_HELPER_VERSION}"

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
`
