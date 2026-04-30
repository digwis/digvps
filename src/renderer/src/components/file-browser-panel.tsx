import { useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  LayoutGrid,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Shield,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { getDesktopApi } from "@/lib/desktop-api"
import { Switch } from "@/components/ui/switch"
import type {
  RemoteFileBrowseResult,
  RemoteFileEntry,
  RemoteFileReadResult,
  RemoteFileStatResult,
  RemoteTrashEntry,
  RemoteTrashListResult,
  VpsConnectionRecord,
} from "../../../shared/vps"

export type FileBrowserPanelProps = {
  selectedConnection?: VpsConnectionRecord
  fallbackConnectionId?: string
  requestedPath?: string
  requestToken?: number
}

const DEFAULT_REMOTE_DIRECTORY = "/var/www"
const BROWSE_CACHE_STORAGE_KEY = "digwis:file-browser-cache"
const BROWSE_CACHE_FRESH_TTL_MS = 10_000
const BROWSE_CACHE_STORAGE_TTL_MS = 12 * 60 * 60 * 1000
const SHOW_HIDDEN_STORAGE_KEY = "digwis:file-browser-show-hidden"
const EXPANDED_PATHS_STORAGE_KEY = "digwis:file-browser-expanded"
const PERMISSION_PRESETS = [
  {
    label: "标准目录",
    mode: "755",
    description: "所有人可读执行",
    className: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-200",
  },
  {
    label: "协作目录",
    mode: "775",
    description: "组可写",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
  },
  {
    label: "安全目录",
    mode: "750",
    description: "仅组可读",
    className: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-200",
  },
  {
    label: "私有目录",
    mode: "700",
    description: "仅所有者",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200",
  },
] as const

type CachedBrowseEntry = {
  cachedAt: number
  data: RemoteFileBrowseResult
}

type TreeRow =
  | {
      kind: "entry"
      entry: RemoteFileEntry
      depth: number
    }
  | {
      kind: "file-group"
      parentPath: string
      depth: number
      count: number
    }

function readBrowseCacheStore() {
  try {
    const raw = window.localStorage.getItem(BROWSE_CACHE_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, CachedBrowseEntry>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function buildBrowseCacheMap() {
  const store = readBrowseCacheStore()
  const nextCache = new Map<string, CachedBrowseEntry>()
  const now = Date.now()
  for (const [key, value] of Object.entries(store)) {
    if (!value || typeof value.cachedAt !== "number" || !value.data) {
      continue
    }
    if (now - value.cachedAt > BROWSE_CACHE_STORAGE_TTL_MS) {
      continue
    }
    nextCache.set(key, value)
  }
  return nextCache
}

function writeBrowseCacheStore(store: Record<string, CachedBrowseEntry>) {
  try {
    window.localStorage.setItem(BROWSE_CACHE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function readExpandedPathsStore() {
  try {
    const raw = window.localStorage.getItem(EXPANDED_PATHS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, string[]>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeExpandedPathsStore(store: Record<string, string[]>) {
  try {
    window.localStorage.setItem(EXPANDED_PATHS_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function defaultNewFilePath(currentPath: string) {
  if (currentPath === "/") {
    return "/untitled.txt"
  }
  const normalized = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath
  return `${normalized}/untitled.txt`
}

function getParentRemotePath(pathValue: string) {
  if (!pathValue || pathValue === "/") {
    return "/"
  }
  const normalized = pathValue.endsWith("/") && pathValue.length > 1 ? pathValue.slice(0, -1) : pathValue
  const lastSlashIndex = normalized.lastIndexOf("/")
  if (lastSlashIndex <= 0) {
    return "/"
  }
  return normalized.slice(0, lastSlashIndex)
}

function getRelativeRemotePath(basePath: string, targetPath: string) {
  const normalizedBase = basePath === "/" ? "/" : basePath.replace(/\/+$/, "")
  if (targetPath === normalizedBase) {
    return "."
  }
  const prefix = normalizedBase === "/" ? "/" : `${normalizedBase}/`
  if (targetPath.startsWith(prefix)) {
    return targetPath.slice(prefix.length)
  }
  return targetPath
}

function buildPathSegments(currentPath: string, rootPath: string) {
  const current = currentPath.split("/").filter(Boolean)
  const root = rootPath.split("/").filter(Boolean)
  const items: Array<{ label: string; path: string }> = [
    { label: rootPath === "/" ? "根目录" : rootPath, path: rootPath },
  ]
  let composed = ""
  for (const [index, part] of current.entries()) {
    composed = `${composed}/${part}`
    if (index < root.length - 1) {
      continue
    }
    if (index === root.length - 1 && rootPath !== "/") {
      continue
    }
    items.push({ label: part, path: composed || "/" })
  }
  return items
}

function isHiddenRemoteEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith(".")
}

function describePermissionMode(mode: string) {
  const normalized = mode.trim()
  const threeDigits = normalized.length === 4 ? normalized.slice(1) : normalized
  const [owner, group, others] = threeDigits.padStart(3, "0").split("").map((item) => Number.parseInt(item, 10))
  const toText = (value: number) => [value & 4 ? "读" : null, value & 2 ? "写" : null, value & 1 ? "执行" : null].filter(Boolean).join("") || "无"
  return `所有者: ${toText(owner)}，组: ${toText(group)}，其他: ${toText(others)}`
}

export function FileBrowserPanel({
  selectedConnection,
  fallbackConnectionId,
  requestedPath,
  requestToken,
}: FileBrowserPanelProps) {
  const [displayMode, setDisplayMode] = useState<"tree" | "cards">("tree")
  const [browser, setBrowser] = useState<RemoteFileBrowseResult | null>(null)
  const [trash, setTrash] = useState<RemoteTrashListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashDialogOpen, setTrashDialogOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [pathDraft, setPathDraft] = useState("")
  const [filterDraft, setFilterDraft] = useState("")
  const [selectedPath, setSelectedPath] = useState<string>()
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set<string>())
  const [renameTarget, setRenameTarget] = useState<RemoteFileEntry | null>(null)
  const [renameName, setRenameName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<RemoteFileEntry | null>(null)
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<RemoteFileEntry[]>([])
  const [permissionTarget, setPermissionTarget] = useState<RemoteFileEntry | null>(null)
  const [permissionDetails, setPermissionDetails] = useState<RemoteFileStatResult | null>(null)
  const [permissionMode, setPermissionMode] = useState("755")
  const [permissionRecursive, setPermissionRecursive] = useState(false)
  const [permissionLoading, setPermissionLoading] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<RemoteTrashEntry | null>(null)
  const [contextMenuTarget, setContextMenuTarget] = useState<RemoteFileEntry | null>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [newFolderParentPath, setNewFolderParentPath] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorMode, setEditorMode] = useState<"create" | "edit">("edit")
  const [editorPath, setEditorPath] = useState("")
  const [editorContent, setEditorContent] = useState("")
  const [editorMeta, setEditorMeta] = useState<RemoteFileReadResult | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set<string>())
  const [treeLoadingPaths, setTreeLoadingPaths] = useState<Set<string>>(() => new Set<string>())
  const browseCacheRef = useRef<Map<string, CachedBrowseEntry>>(buildBrowseCacheMap())
  const prefetchingRef = useRef<Set<string>>(new Set<string>())
  const lastHandledRequestTokenRef = useRef<number | undefined>(undefined)

  const connectionId = selectedConnection?.id ?? fallbackConnectionId
  const normalizedFilter = filterDraft.trim().toLowerCase()
  const visibleEntries = useMemo(
    () => browser?.entries.filter((entry) => showHiddenFiles || !isHiddenRemoteEntry(entry)) ?? [],
    [browser, showHiddenFiles],
  )

  const getBrowseCacheKey = (pathValue?: string) => {
    if (!connectionId) {
      return undefined
    }
    const resolvedPath = pathValue?.trim() || browser?.currentPath || DEFAULT_REMOTE_DIRECTORY
    return `${connectionId}:${resolvedPath}`
  }

  const getCachedBrowseResult = (pathValue: string) => {
    const cacheKey = getBrowseCacheKey(pathValue)
    return cacheKey ? browseCacheRef.current.get(cacheKey)?.data : undefined
  }

  const treeRows = useMemo(() => {
    if (!browser) {
      return [] as TreeRow[]
    }
    const rows: TreeRow[] = []
    const entryMatchesFilter = (entry: RemoteFileEntry): boolean => {
      if (!normalizedFilter) {
        return true
      }
      const name = entry.name.toLowerCase()
      const path = entry.path.toLowerCase()
      return name.includes(normalizedFilter) || path.includes(normalizedFilter)
    }
    const subtreeHasMatch = (entry: RemoteFileEntry, visited = new Set<string>()): boolean => {
      if (entryMatchesFilter(entry)) {
        return true
      }
      if (entry.type !== "directory" || visited.has(entry.path)) {
        return false
      }
      const cached = getCachedBrowseResult(entry.path)
      if (!cached) {
        return false
      }
      const nextVisited = new Set(visited)
      nextVisited.add(entry.path)
      return cached.entries
        .filter((child) => showHiddenFiles || !isHiddenRemoteEntry(child))
        .some((child) => subtreeHasMatch(child, nextVisited))
    }
    const walk = (
      entries: RemoteFileEntry[],
      depth: number,
      parentPath: string,
      parentChain: Set<string>,
    ) => {
      const matchingEntries = normalizedFilter
        ? entries.filter((entry) => subtreeHasMatch(entry))
        : entries
      const directories = matchingEntries.filter((entry) => entry.type === "directory")
      const files = matchingEntries.filter((entry) => entry.type !== "directory")
      for (const entry of directories) {
        rows.push({ kind: "entry", entry, depth })
        if (entry.type !== "directory" || !expandedPaths.has(entry.path) || parentChain.has(entry.path)) {
          continue
        }
        if (treeLoadingPaths.has(entry.path)) {
          rows.push({
            kind: "file-group",
            parentPath: `${entry.path}::__loading__`,
            depth: depth + 1,
            count: -1,
          })
          continue
        }
        const next = getCachedBrowseResult(entry.path)
        if (!next) {
          continue
        }
        const childEntries = next.entries.filter((child) => showHiddenFiles || !isHiddenRemoteEntry(child))
        const nextChain = new Set(parentChain)
        nextChain.add(entry.path)
        walk(childEntries, depth + 1, entry.path, nextChain)
      }
      for (const entry of files) {
        rows.push({ kind: "entry", entry, depth })
      }
    }
    walk(visibleEntries, 0, browser.currentPath, new Set<string>())
    return rows
  }, [browser, expandedPaths, normalizedFilter, showHiddenFiles, treeLoadingPaths, visibleEntries])

  const treeSummary = useMemo(() => {
    let directories = 0
    let files = 0
    for (const row of treeRows) {
      if (row.kind !== "entry") {
        continue
      }
      if (row.entry.type === "directory") {
        directories += 1
      } else {
        files += 1
      }
    }
    return { directories, files }
  }, [treeRows])

  const selectablePaths = useMemo(
    () => treeRows.filter((row) => row.kind === "entry").map((row) => row.entry.path),
    [treeRows],
  )

  const selectableEntryMap = useMemo(() => {
    const next = new Map<string, RemoteFileEntry>()
    for (const entry of visibleEntries) {
      next.set(entry.path, entry)
    }
    for (const row of treeRows) {
      if (row.kind !== "entry") {
        continue
      }
      next.set(row.entry.path, row.entry)
    }
    return next
  }, [treeRows, visibleEntries])

  const selectedEntries = useMemo(
    () => Array.from(selectedPaths).map((pathValue) => selectableEntryMap.get(pathValue)).filter(Boolean) as RemoteFileEntry[],
    [selectableEntryMap, selectedPaths],
  )

  useEffect(() => {
    try {
      setShowHiddenFiles(window.localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === "true")
    } catch {
      setShowHiddenFiles(false)
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, showHiddenFiles ? "true" : "false")
    } catch {
      // Ignore storage errors in desktop renderer.
    }
  }, [showHiddenFiles])

  useEffect(() => {
    if (!connectionId) {
      setExpandedPaths(new Set<string>())
      return
    }
    const store = readExpandedPathsStore()
    const paths = Array.isArray(store[connectionId]) ? store[connectionId] : []
    setExpandedPaths(new Set(paths))
  }, [connectionId])

  useEffect(() => {
    if (!connectionId) {
      return
    }
    const store = readExpandedPathsStore()
    store[connectionId] = Array.from(expandedPaths)
    writeExpandedPathsStore(store)
  }, [connectionId, expandedPaths])

  const persistBrowseCache = (key: string, entry: CachedBrowseEntry) => {
    browseCacheRef.current.set(key, entry)
    const nextStore: Record<string, CachedBrowseEntry> = {}
    const now = Date.now()
    for (const [cacheKey, cacheEntry] of browseCacheRef.current.entries()) {
      if (now - cacheEntry.cachedAt > BROWSE_CACHE_STORAGE_TTL_MS) {
        continue
      }
      nextStore[cacheKey] = cacheEntry
    }
    writeBrowseCacheStore(nextStore)
  }

  const invalidateBrowseCache = (...paths: Array<string | undefined | null>) => {
    if (!connectionId) {
      return
    }
    for (const rawPath of paths) {
      const normalized = rawPath?.trim()
      if (!normalized) {
        continue
      }
      browseCacheRef.current.delete(`${connectionId}:${normalized}`)
    }
  }

  const prefetchChildDirectories = (result: RemoteFileBrowseResult) => {
    if (!connectionId) {
      return
    }
    for (const entry of result.entries.filter((item) => item.type === "directory").slice(0, 6)) {
      const cacheKey = `${connectionId}:${entry.path}`
      const cached = browseCacheRef.current.get(cacheKey)
      if (cached && Date.now() - cached.cachedAt <= BROWSE_CACHE_FRESH_TTL_MS) {
        continue
      }
      if (prefetchingRef.current.has(cacheKey)) {
        continue
      }
      prefetchingRef.current.add(cacheKey)
      void getDesktopApi()
        .vps.browseRemoteFiles({
          connectionId,
          path: entry.path,
        })
        .then((next) => {
          persistBrowseCache(`${connectionId}:${next.currentPath}`, {
            cachedAt: Date.now(),
            data: next,
          })
        })
        .catch(() => undefined)
        .finally(() => {
          prefetchingRef.current.delete(cacheKey)
        })
    }
  }

  const loadBrowser = async (nextPath?: string, options?: { forceRefresh?: boolean }) => {
    if (!connectionId) {
      setBrowser(null)
      setPathDraft("")
      return
    }
    const cacheKey = getBrowseCacheKey(nextPath)
    const cached = cacheKey ? browseCacheRef.current.get(cacheKey) : undefined
    const cacheAgeMs = cached ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY
    const canUseCached = !options?.forceRefresh && Boolean(cached)
    const isFreshCached = canUseCached && cacheAgeMs <= BROWSE_CACHE_FRESH_TTL_MS
    if (cached && canUseCached) {
      setBrowser(cached.data)
      setPathDraft(cached.data.focusedPath ?? cached.data.currentPath)
      if (isFreshCached) {
        prefetchChildDirectories(cached.data)
        return
      }
    }
    setLoading(true)
    try {
      const next = await getDesktopApi().vps.browseRemoteFiles({
        connectionId,
        path: nextPath,
        forceRefresh: options?.forceRefresh,
      })
      persistBrowseCache(`${connectionId}:${next.currentPath}`, {
        cachedAt: Date.now(),
        data: next,
      })
      setBrowser(next)
      setPathDraft(next.focusedPath ?? next.currentPath)
      prefetchChildDirectories(next)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "远端目录读取失败",
        description: error instanceof Error ? error.message : "无法浏览服务器文件",
      })
    } finally {
      setLoading(false)
    }
  }

  const restoreCachedBrowser = (pathValue?: string) => {
    const cacheKey = getBrowseCacheKey(pathValue)
    if (!cacheKey) {
      return false
    }
    const cached = browseCacheRef.current.get(cacheKey)
    if (!cached) {
      return false
    }
    setBrowser(cached.data)
    setPathDraft(cached.data.focusedPath ?? cached.data.currentPath)
    return true
  }

  useEffect(() => {
    setTrash(null)
    setTreeLoadingPaths(new Set<string>())
    const targetPath = requestedPath?.trim() || DEFAULT_REMOTE_DIRECTORY
    if (requestToken && lastHandledRequestTokenRef.current !== requestToken) {
      lastHandledRequestTokenRef.current = requestToken
    }
    const restored = restoreCachedBrowser(targetPath)
    if (!restored) {
      setBrowser(null)
      setPathDraft(targetPath)
      setSelectedPath(undefined)
      setSelectedPaths(new Set<string>())
    }
    void loadBrowser(targetPath)
  }, [connectionId, requestedPath, requestToken])

  const loadTrash = async () => {
    if (!connectionId) {
      setTrash(null)
      return
    }
    setTrashLoading(true)
    try {
      const next = await getDesktopApi().vps.listRemoteTrash({ connectionId })
      setTrash(next)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "回收站读取失败",
        description: error instanceof Error ? error.message : "无法读取远端回收站",
      })
    } finally {
      setTrashLoading(false)
    }
  }

  useEffect(() => {
    if (!trashDialogOpen || !connectionId) {
      return
    }
    void loadTrash()
  }, [trashDialogOpen, connectionId])

  useEffect(() => {
    if (!browser) {
      setSelectedPath(undefined)
      setSelectedPaths(new Set<string>())
      return
    }
    setSelectedPath((current) => {
      if (!current) {
        return browser.focusedPath ?? undefined
      }
      return browser.entries.some((entry) => entry.path === current)
        ? current
        : (browser.focusedPath ?? undefined)
    })
  }, [browser])

  useEffect(() => {
    if (selectedPath && selectablePaths.includes(selectedPath)) {
      return
    }
    setSelectedPath(selectablePaths[0])
  }, [selectablePaths, selectedPath])

  useEffect(() => {
    const validPaths = new Set(selectableEntryMap.keys())
    setSelectedPaths((current) => {
      const next = new Set(Array.from(current).filter((pathValue) => validPaths.has(pathValue)))
      return next.size === current.size ? current : next
    })
  }, [selectableEntryMap])

  const openEntry = async (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
    setSelectedPaths(new Set<string>([entry.path]))
    if (entry.type === "directory") {
      await loadBrowser(entry.path)
      return
    }
    await openTextEditor(entry)
  }

  const openDraftPath = async () => {
    const nextPath = pathDraft.trim()
    if (!nextPath) {
      return
    }
    await loadBrowser(nextPath)
  }

  const startRename = (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
    setRenameTarget(entry)
    setRenameName(entry.name)
  }

  const openPermissionEditor = async (entry: RemoteFileEntry) => {
    if (!connectionId) {
      return
    }
    setSelectedPath(entry.path)
    setPermissionTarget(entry)
    setPermissionDetails(null)
    setPermissionRecursive(false)
    setPermissionMode(entry.type === "directory" ? "755" : "644")
    setPermissionLoading(true)
    try {
      const details = await getDesktopApi().vps.statRemoteEntry({
        connectionId,
        path: entry.path,
      })
      setPermissionDetails(details)
      setPermissionMode(details.permissions?.octal ?? (entry.type === "directory" ? "755" : "644"))
    } catch (error) {
      setPermissionTarget(null)
      toast({
        variant: "destructive",
        title: "权限信息读取失败",
        description: error instanceof Error ? error.message : "无法读取当前权限",
      })
    } finally {
      setPermissionLoading(false)
    }
  }

  const openNewFolderDialog = (parentPath?: string) => {
    setNewFolderParentPath(parentPath?.trim() || browser?.currentPath || DEFAULT_REMOTE_DIRECTORY)
    setNewFolderName("")
    setNewFolderOpen(true)
  }

  const openTextEditor = async (entry?: RemoteFileEntry, targetDirectoryPath?: string) => {
    if (!connectionId || !browser) {
      return
    }
    setEditorMode(entry ? "edit" : "create")
    setEditorMeta(null)
    setEditorPath(entry?.path ?? defaultNewFilePath(targetDirectoryPath?.trim() || browser.currentPath))
    setEditorContent("")
    setEditorOpen(true)
    if (!entry) {
      return
    }
    setEditorLoading(true)
    try {
      const file = await getDesktopApi().vps.readRemoteTextFile({
        connectionId,
        path: entry.path,
      })
      setEditorMeta(file)
      setEditorPath(file.path)
      setEditorContent(file.content)
    } catch (error) {
      setEditorOpen(false)
      toast({
        variant: "destructive",
        title: "文件打开失败",
        description: error instanceof Error ? error.message : "无法读取远端文件",
      })
    } finally {
      setEditorLoading(false)
    }
  }

  const saveTextFile = async () => {
    if (!connectionId || !editorPath.trim()) {
      return
    }
    setEditorSaving(true)
    try {
      const result = await getDesktopApi().vps.writeRemoteTextFile({
        connectionId,
        path: editorPath.trim(),
        content: editorContent,
      })
      toast({
        title: editorMode === "create" ? "文本文件已创建" : "文本文件已保存",
        description: result.path,
      })
      invalidateBrowseCache(getParentRemotePath(result.path))
      setEditorOpen(false)
      await loadBrowser(browser?.currentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "保存失败",
        description: error instanceof Error ? error.message : "无法写入远端文件",
      })
    } finally {
      setEditorSaving(false)
    }
  }

  const createFolder = async () => {
    const parentPath = newFolderParentPath.trim() || browser?.currentPath
    if (!connectionId || !parentPath) {
      return
    }
    setBusyKey("mkdir")
    try {
      const result = await getDesktopApi().vps.createRemoteDirectory({
        connectionId,
        parentPath,
        directoryName: newFolderName,
      })
      toast({
        title: "目录已创建",
        description: result.path,
      })
      invalidateBrowseCache(parentPath, getParentRemotePath(result.path))
      setNewFolderOpen(false)
      setNewFolderName("")
      setNewFolderParentPath("")
      await loadBrowser(browser?.currentPath ?? parentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "创建目录失败",
        description: error instanceof Error ? error.message : "无法创建目录",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const renameEntry = async () => {
    if (!connectionId || !renameTarget) {
      return
    }
    setBusyKey(`rename:${renameTarget.path}`)
    try {
      const result = await getDesktopApi().vps.renameRemoteEntry({
        connectionId,
        path: renameTarget.path,
        nextName: renameName,
      })
      toast({
        title: "名称已更新",
        description: result.path,
      })
      invalidateBrowseCache(renameTarget.path, result.path, getParentRemotePath(renameTarget.path), getParentRemotePath(result.path))
      setRenameTarget(null)
      setRenameName("")
      await loadBrowser(browser?.currentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "重命名失败",
        description: error instanceof Error ? error.message : "无法重命名该项",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const savePermissions = async () => {
    if (!connectionId || !permissionTarget) {
      return
    }
    const nextMode = permissionMode.trim()
    if (!/^[0-7]{3,4}$/.test(nextMode)) {
      toast({
        variant: "destructive",
        title: "权限格式不正确",
        description: "请输入 3 到 4 位八进制数字，例如 755、775、750、700。",
      })
      return
    }
    setBusyKey(`chmod:${permissionTarget.path}`)
    try {
      const result = await getDesktopApi().vps.changeRemotePermissions({
        connectionId,
        path: permissionTarget.path,
        mode: nextMode,
        recursive: permissionTarget.type === "directory" ? permissionRecursive : false,
      })
      toast({
        title: "权限已更新",
        description: `${result.path} -> ${nextMode}`,
      })
      invalidateBrowseCache(result.path, getParentRemotePath(result.path))
      setPermissionTarget(null)
      setPermissionDetails(null)
      setPermissionRecursive(false)
      await loadBrowser(browser?.currentPath, { forceRefresh: true })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "修改权限失败",
        description: error instanceof Error ? error.message : "无法更新目标权限",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const removeEntry = async () => {
    if (!connectionId || !deleteTarget) {
      return
    }
    setBusyKey(`delete:${deleteTarget.path}`)
    try {
      const currentPath = browser?.currentPath
      const result = await getDesktopApi().vps.deleteRemoteEntry({
        connectionId,
        path: deleteTarget.path,
      })
      invalidateBrowseCache(deleteTarget.path, currentPath)
      toast({
        title: deleteTarget.type === "directory" ? "目录已移入回收站" : "文件已移入回收站",
        description: result.path,
      })
      setDeleteTarget(null)
      await loadBrowser(currentPath, { forceRefresh: true })
      if (trash) {
        await loadTrash()
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "删除失败",
        description: error instanceof Error ? error.message : "无法删除该项",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const restoreTrashEntry = async (entry: RemoteTrashEntry) => {
    if (!connectionId) {
      return
    }
    setBusyKey(`restore:${entry.id}`)
    try {
      const result = await getDesktopApi().vps.restoreRemoteTrashEntry({
        connectionId,
        trashId: entry.id,
      })
      toast({
        title: "已恢复",
        description: result.path,
      })
      await loadTrash()
      if (browser?.currentPath) {
        await loadBrowser(browser.currentPath)
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "恢复失败",
        description: error instanceof Error ? error.message : "无法恢复该项",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const purgeTrashEntry = async () => {
    if (!connectionId || !purgeTarget) {
      return
    }
    setBusyKey(`purge:${purgeTarget.id}`)
    try {
      const result = await getDesktopApi().vps.purgeRemoteTrashEntry({
        connectionId,
        trashId: purgeTarget.id,
      })
      toast({
        title: "已彻底删除",
        description: result.path,
      })
      setPurgeTarget(null)
      await loadTrash()
    } catch (error) {
      toast({
        variant: "destructive",
        title: "彻底删除失败",
        description: error instanceof Error ? error.message : "无法彻底删除该项",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const uploadEntries = async () => {
    if (!connectionId || !browser) {
      return
    }
    setBusyKey("upload")
    try {
      const result = await getDesktopApi().vps.uploadRemoteEntries({
        connectionId,
        remotePath: browser.currentPath,
      })
      toast({
        title: "上传完成",
        description: result.message,
      })
      invalidateBrowseCache(browser.currentPath)
      await loadBrowser(browser.currentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "上传失败",
        description: error instanceof Error ? error.message : "无法上传文件到服务器",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const downloadEntry = async (entry: RemoteFileEntry) => {
    if (!connectionId) {
      return
    }
    setSelectedPath(entry.path)
    setBusyKey(`download:${entry.path}`)
    try {
      const result = await getDesktopApi().vps.downloadRemoteEntry({
        connectionId,
        path: entry.path,
        name: entry.name,
        type: entry.type,
      })
      toast({
        title: "下载完成",
        description: result.message,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "下载失败",
        description: error instanceof Error ? error.message : "无法下载该项",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const setExclusiveSelection = (pathValue: string) => {
    setSelectedPath(pathValue)
    setSelectedPaths(new Set<string>([pathValue]))
  }

  const toggleSelection = (entry: RemoteFileEntry, additive: boolean) => {
    setSelectedPath(entry.path)
    if (!additive) {
      setSelectedPaths(new Set<string>([entry.path]))
      return
    }
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
      }
      if (next.size === 0) {
        next.add(entry.path)
      }
      return next
    })
  }

  const isAdditiveSelectionEvent = (event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) =>
    Boolean(event.metaKey || event.ctrlKey || event.shiftKey)

  const prepareEntrySelection = (entry: RemoteFileEntry, additive: boolean) => {
    if (additive) {
      toggleSelection(entry, true)
      return
    }
    setExclusiveSelection(entry.path)
  }

  const prepareContextSelection = (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
    setSelectedPaths((current) => {
      if (current.has(entry.path)) {
        return current
      }
      return new Set<string>([entry.path])
    })
  }

  const downloadSelectedEntries = async () => {
    if (!connectionId || selectedEntries.length === 0) {
      return
    }
    if (selectedEntries.length === 1) {
      await downloadEntry(selectedEntries[0])
      return
    }
    setBusyKey("download:selected")
    try {
      for (const entry of selectedEntries) {
        await getDesktopApi().vps.downloadRemoteEntry({
          connectionId,
          path: entry.path,
          name: entry.name,
          type: entry.type,
        })
      }
      toast({
        title: "批量下载完成",
        description: `${selectedEntries.length} 个项目已下载`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "批量下载失败",
        description: error instanceof Error ? error.message : "无法下载选中项目",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const removeSelectedEntries = () => {
    if (!connectionId || selectedEntries.length === 0) {
      return
    }
    if (selectedEntries.length === 1) {
      setDeleteTarget(selectedEntries[0])
      return
    }
    setBulkDeleteTargets(selectedEntries)
  }

  const confirmBulkRemove = async () => {
    if (!connectionId || bulkDeleteTargets.length === 0) {
      return
    }
    setBusyKey("delete:selected")
    try {
      const currentPath = browser?.currentPath
      for (const entry of bulkDeleteTargets) {
        await getDesktopApi().vps.deleteRemoteEntry({
          connectionId,
          path: entry.path,
        })
        invalidateBrowseCache(entry.path, getParentRemotePath(entry.path), currentPath)
      }
      toast({
        title: "批量删除完成",
        description: `${bulkDeleteTargets.length} 个项目已移入回收站`,
      })
      setBulkDeleteTargets([])
      setSelectedPaths(new Set<string>())
      await loadBrowser(currentPath, { forceRefresh: true })
      if (trash) {
        await loadTrash()
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "批量删除失败",
        description: error instanceof Error ? error.message : "无法删除选中项目",
      })
    } finally {
      setBusyKey(undefined)
    }
  }

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast({
        title: `${label}已复制`,
        description: value,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${label}复制失败`,
        description: error instanceof Error ? error.message : "无法写入剪贴板",
      })
    }
  }

  const loadTreeDirectory = async (pathValue: string, options?: { forceRefresh?: boolean }) => {
    if (!connectionId) {
      return
    }
    const cacheKey = getBrowseCacheKey(pathValue)
    const cached = cacheKey ? browseCacheRef.current.get(cacheKey) : undefined
    const cacheAgeMs = cached ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY
    if (cached && !options?.forceRefresh && cacheAgeMs <= BROWSE_CACHE_FRESH_TTL_MS) {
      return
    }
    setTreeLoadingPaths((current) => new Set(current).add(pathValue))
    try {
      const next = await getDesktopApi().vps.browseRemoteFiles({
        connectionId,
        path: pathValue,
        forceRefresh: options?.forceRefresh,
      })
      persistBrowseCache(`${connectionId}:${next.currentPath}`, {
        cachedAt: Date.now(),
        data: next,
      })
      prefetchChildDirectories(next)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "子目录读取失败",
        description: error instanceof Error ? error.message : "无法展开该目录",
      })
      throw error
    } finally {
      setTreeLoadingPaths((current) => {
        const next = new Set(current)
        next.delete(pathValue)
        return next
      })
    }
  }

  const toggleTreeDirectory = async (entry: RemoteFileEntry) => {
    if (entry.type !== "directory") {
      return
    }
    if (expandedPaths.has(entry.path)) {
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
      return
    }
    setExpandedPaths((current) => new Set(current).add(entry.path))
    try {
      await loadTreeDirectory(entry.path)
    } catch {
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
    }
  }

  const moveSelection = (direction: -1 | 1) => {
    if (selectablePaths.length === 0) {
      return
    }
    const currentIndex = selectedPath ? selectablePaths.indexOf(selectedPath) : -1
    const fallbackIndex = direction > 0 ? 0 : selectablePaths.length - 1
    const nextIndex = currentIndex === -1
      ? fallbackIndex
      : Math.min(selectablePaths.length - 1, Math.max(0, currentIndex + direction))
    setSelectedPath(selectablePaths[nextIndex])
  }

  const openSelectedEntry = async () => {
    const selectedEntry = treeRows.find(
      (row) => row.kind === "entry" && row.entry.path === selectedPath,
    )
    if (!selectedEntry || selectedEntry.kind !== "entry") {
      return
    }
    await openEntry(selectedEntry.entry)
  }

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    const tagName = target?.tagName ?? ""
    if (tagName === "INPUT" || tagName === "TEXTAREA") {
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveSelection(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveSelection(-1)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      void openSelectedEntry()
    }
  }

  const renderEntryActions = (entry: RemoteFileEntry) => (
    <>
      <DropdownMenuItem onClick={() => void openEntry(entry)}>
        {entry.type === "directory" ? <FolderOpen className="size-4" /> : <FileCode2 className="size-4" />}
        {entry.type === "directory" ? "打开目录" : "编辑文本"}
      </DropdownMenuItem>
      {entry.type === "directory" ? (
        <>
          <DropdownMenuItem onClick={() => void openTextEditor(undefined, entry.path)}>
            <FileCode2 className="size-4" />
            在此新建文件
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openNewFolderDialog(entry.path)}>
            <FolderPlus className="size-4" />
            在此新建目录
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem onClick={() => void copyText(entry.path, "绝对路径")}>
        <FileCode2 className="size-4" />
        复制路径
      </DropdownMenuItem>
      {browser ? (
        <DropdownMenuItem
          onClick={() => void copyText(getRelativeRemotePath(browser.currentPath, entry.path), "相对路径")}
        >
          <FileCode2 className="size-4" />
          复制相对路径
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => void downloadEntry(entry)}>
        {busyKey === `download:${entry.path}` ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        下载
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => startRename(entry)}>
        <Pencil className="size-4" />
        重命名
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void openPermissionEditor(entry)}>
        <Shield className="size-4" />
        修改权限
      </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            prepareContextSelection(entry)
            setDeleteTarget(entry)
          }}
        >
          <Trash2 className="size-4" />
        删除
      </DropdownMenuItem>
    </>
  )

  const renderTrashActions = (entry: RemoteTrashEntry) => (
    <>
      <DropdownMenuItem onClick={() => void restoreTrashEntry(entry)}>
        {busyKey === `restore:${entry.id}` ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <RotateCcw className="size-4" />
        )}
        恢复
      </DropdownMenuItem>
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => setPurgeTarget(entry)}
      >
        <Trash2 className="size-4" />
        彻底删除
      </DropdownMenuItem>
    </>
  )

  const renderFileCards = () => {
    if (visibleEntries.length === 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {showHiddenFiles ? "当前目录为空" : "当前目录没有可见文件"}
        </div>
      )
    }
    return (
      <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visibleEntries.map((entry) => {
          const isSelected = selectedPaths.has(entry.path)
          const hasMultiSelection = selectedPaths.size > 0
          const isDirectory = entry.type === "directory"
          return (
            <div
              key={entry.path}
              className={cn(
                "relative rounded-xl border border-border/60 bg-muted/[0.04] px-4 py-3 shadow-sm transition-all duration-150 dark:border-white/10 dark:bg-white/[0.02]",
                "hover:border-border hover:bg-muted/25",
                hasMultiSelection && !isSelected && "opacity-70",
                isSelected && "border-border bg-muted/50 shadow-md dark:border-white/15 dark:bg-white/[0.06]",
                browser?.focusedPath === entry.path && !isSelected && "ring-1 ring-primary/15",
              )}
              onClick={(event) => prepareEntrySelection(entry, isAdditiveSelectionEvent(event))}
              onContextMenu={(event) => {
                event.preventDefault()
                prepareContextSelection(entry)
                setContextMenuPosition({ x: event.clientX, y: event.clientY })
                setContextMenuTarget(entry)
              }}
            >
              <button
                type="button"
                className={cn(
                  "flex w-full text-left",
                  isDirectory ? "items-center justify-center" : "items-start gap-3",
                )}
                onDoubleClick={() => void openEntry(entry)}
              >
                {isDirectory ? (
                  <div className="relative flex min-h-[64px] w-full flex-col items-center justify-center px-6 py-1.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-0 right-0 size-7 rounded-lg text-muted-foreground"
                          onClick={(event) => {
                            event.stopPropagation()
                            prepareContextSelection(entry)
                          }}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {renderEntryActions(entry)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <p className="max-w-full truncate text-center font-mono text-[13px] text-foreground">
                      {entry.name}
                    </p>
                  </div>
                ) : (
                  <>
                    <div
                      className={cn(
                        "mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground transition-colors dark:bg-white/[0.06]",
                        isSelected && "bg-background text-foreground dark:bg-white/[0.08] dark:text-white",
                      )}
                    >
                      <FileCode2 className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm text-foreground transition-colors">
                            {entry.name}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "size-7 shrink-0 rounded-lg text-muted-foreground",
                                isSelected && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                prepareContextSelection(entry)
                              }}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {renderEntryActions(entry)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div
                        className={cn(
                          "mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground transition-colors",
                          isSelected && "text-foreground/70 dark:text-white/70",
                        )}
                      >
                        <span>{entry.type === "symlink" ? "链接" : "文件"}</span>
                        <span className="font-mono">{formatFileSize(entry.size)}</span>
                      </div>
                      <p
                        className={cn(
                          "mt-2 text-[11px] text-muted-foreground transition-colors",
                          isSelected && "text-foreground/65 dark:text-white/65",
                        )}
                      >
                        {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "-"}
                      </p>
                    </div>
                  </>
                )}
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  const renderTreeRows = () => {
    if (treeRows.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
            {showHiddenFiles ? "当前目录为空" : "当前目录没有可见文件"}
          </TableCell>
        </TableRow>
      )
    }

    return treeRows.map((row) => {
      if (row.kind === "file-group") {
        return (
          <TableRow key={row.parentPath}>
            <TableCell>
              <div
                className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground"
                style={{ paddingLeft: `${row.depth * 18}px` }}
              >
                <LoaderCircle className="size-3.5 animate-spin" />
                <span>正在读取子目录…</span>
              </div>
            </TableCell>
            <TableCell className="text-[11px] text-muted-foreground">-</TableCell>
            <TableCell className="text-right font-mono text-[11px] text-muted-foreground">-</TableCell>
            <TableCell className="text-[11px] text-muted-foreground">-</TableCell>
            <TableCell />
          </TableRow>
        )
      }

      const { entry, depth } = row
      const isDirectory = entry.type === "directory"
      const isExpanded = expandedPaths.has(entry.path)
      const isLoadingNode = treeLoadingPaths.has(entry.path)
      const cachedChildren = isDirectory ? getCachedBrowseResult(entry.path) : undefined
      const childEntries = cachedChildren?.entries.filter((child) => showHiddenFiles || !isHiddenRemoteEntry(child)) ?? []
      const canExpand = isDirectory && (isLoadingNode || Boolean(cachedChildren) || childEntries.length > 0)

      return (
        <TableRow
          key={entry.path}
          data-state={selectedPaths.has(entry.path) ? "selected" : undefined}
          className={cn(browser?.focusedPath === entry.path && "bg-muted/40")}
          onClick={(event) => prepareEntrySelection(entry, isAdditiveSelectionEvent(event))}
          onContextMenu={(event) => {
            event.preventDefault()
            prepareContextSelection(entry)
            setContextMenuPosition({ x: event.clientX, y: event.clientY })
            setContextMenuTarget(entry)
          }}
        >
          <TableCell>
            <div
              className="flex min-w-0 items-center gap-2"
              style={{ paddingLeft: `${depth * 18}px` }}
            >
              {isDirectory ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 rounded-md"
                  title={isExpanded ? "收起子目录" : "展开子目录"}
                  onClick={(event) => {
                    event.stopPropagation()
                    void toggleTreeDirectory(entry)
                  }}
                  disabled={isLoadingNode}
                >
                  {isLoadingNode ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : isExpanded ? (
                    <ChevronDown className="size-3.5" />
                  ) : canExpand ? (
                    <ChevronRight className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5 opacity-30" />
                  )}
                </Button>
              ) : (
                <span className="block size-6 shrink-0" />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onDoubleClick={() => void openEntry(entry)}
              >
                {isDirectory ? (
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <span className="block truncate font-mono text-xs text-foreground">{entry.name}</span>
                </div>
              </button>
            </div>
          </TableCell>
          <TableCell className="text-[11px] text-muted-foreground">
            {entry.type === "directory" ? "目录" : entry.type === "symlink" ? "链接" : "文件"}
          </TableCell>
          <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
            {entry.type === "directory" ? "-" : formatFileSize(entry.size)}
          </TableCell>
          <TableCell className="text-[11px] text-muted-foreground">
            {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "-"}
          </TableCell>
          <TableCell className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg"
                  onClick={(event) => {
                    event.stopPropagation()
                    prepareContextSelection(entry)
                  }}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {renderEntryActions(entry)}
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
      )
    })
  }

  const renderTrashCards = () => {
    if (trashLoading && !trash) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          正在读取回收站…
        </div>
      )
    }
    if ((trash?.entries.length ?? 0) === 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          回收站为空
        </div>
      )
    }
    return (
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {trash!.entries.map((entry) => (
          <div key={entry.id} className="rounded-2xl border border-border/60 bg-background/70 px-4 py-4 shadow-sm dark:border-white/10 dark:bg-white/[0.02]">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-muted p-2 text-muted-foreground dark:bg-white/[0.06]">
                {entry.type === "directory" ? <FolderOpen className="size-4" /> : <FileCode2 className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-foreground">{entry.name}</p>
                    <p className="mt-1 line-clamp-2 break-all text-[11px] text-muted-foreground">{entry.originalPath}</p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {renderTrashActions(entry)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="mt-2 truncate text-[11px] text-muted-foreground">{entry.trashedPath}</p>
                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>{entry.type === "directory" ? "目录" : entry.type === "symlink" ? "链接" : "文件"}</span>
                  <span className="font-mono">{entry.type === "directory" ? "-" : formatFileSize(entry.size)}</span>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">{new Date(entry.deletedAt).toLocaleString()}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (!connectionId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border/70 bg-muted/[0.06] px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.02]">
        <FolderTree className="size-8 text-muted-foreground" />
        <p className="text-base font-medium text-foreground">先选择一台服务器</p>
        <p className="max-w-md text-sm text-muted-foreground">选择连接后即可浏览远端目录、上传文件、编辑文本文件和下载内容。</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-col gap-4 px-5 pt-1 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 rounded-2xl"
              title="返回上级"
              onClick={() => void loadBrowser(browser?.parentPath ?? browser?.rootPath)}
              disabled={!browser?.parentPath || loading}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Input
              className="h-10 flex-1 rounded-2xl border-0 bg-muted/60 font-mono text-xs shadow-none dark:bg-white/[0.04]"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="输入远端路径后回车即可跳转"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void openDraftPath()
                }
              }}
            />
            <Input
              className="h-10 w-[220px] rounded-2xl border-0 bg-muted/60 text-xs shadow-none dark:bg-white/[0.04]"
              value={filterDraft}
              onChange={(event) => setFilterDraft(event.target.value)}
              placeholder="过滤当前树中的名称或路径"
            />
            <div className="ml-auto flex items-center gap-2 px-1 py-1">
              <Label htmlFor="show-hidden-files" className="text-xs font-normal text-muted-foreground">
                显示隐藏文件
              </Label>
              <Switch
                id="show-hidden-files"
                checked={showHiddenFiles}
                onCheckedChange={setShowHiddenFiles}
              />
            </div>
            {browser?.transport === "sftp" ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-300">
                降级模式
              </span>
            ) : null}
            <div className="flex items-center rounded-2xl bg-muted/[0.08] p-1 dark:bg-white/[0.03]">
              <Button
                type="button"
                variant={displayMode === "tree" ? "secondary" : "ghost"}
                size="icon"
                className="size-8 rounded-xl"
                title="树形列表"
                onClick={() => setDisplayMode("tree")}
              >
                <FolderTree className="size-4" />
              </Button>
              <Button
                type="button"
                variant={displayMode === "cards" ? "secondary" : "ghost"}
                size="icon"
                className="size-8 rounded-xl"
                title="卡片视图"
                onClick={() => setDisplayMode("cards")}
              >
                <LayoutGrid className="size-4" />
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-2xl"
              title="新建文件"
              onClick={() => void openTextEditor()}
              disabled={!browser}
            >
              <FileCode2 className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-2xl"
              title="新建目录"
              onClick={() => openNewFolderDialog()}
              disabled={!browser}
            >
              <FolderPlus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-2xl"
              title="上传"
              onClick={() => void uploadEntries()}
              disabled={!browser || busyKey === "upload"}
            >
              {busyKey === "upload" ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-2xl"
              title="刷新"
              onClick={() => void loadBrowser(browser?.currentPath, { forceRefresh: true })}
              disabled={loading}
            >
              {loading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-2xl"
              title="打开回收站"
              onClick={() => setTrashDialogOpen(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading && !browser ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              正在连接远端目录…
            </div>
          ) : browser ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between px-5 py-3 text-[11px] text-muted-foreground">
                <span>
                  {visibleEntries.length} 个项目
                  {displayMode === "tree" ? ` · ${treeSummary.directories} 个目录 · ${treeSummary.files} 个文件` : ""}
                  {normalizedFilter ? ` · 已过滤: ${filterDraft}` : ""}
                  {selectedEntries.length > 0 ? ` · 已选 ${selectedEntries.length} 项` : ""}
                </span>
                <div className="flex items-center gap-2">
                  {selectedEntries.length > 0 ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-xl"
                        onClick={() => void downloadSelectedEntries()}
                        disabled={busyKey === "download:selected" || busyKey === "delete:selected"}
                      >
                        {busyKey === "download:selected" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                        下载所选
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-xl text-destructive hover:text-destructive"
                        onClick={() => void removeSelectedEntries()}
                        disabled={busyKey === "download:selected" || busyKey === "delete:selected"}
                      >
                        {busyKey === "delete:selected" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除所选
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 rounded-xl"
                        onClick={() => {
                          setSelectedPath(undefined)
                          setSelectedPaths(new Set<string>())
                        }}
                      >
                        清除选择
                      </Button>
                    </>
                  ) : null}
                  {loading ? <span>显示缓存内容，正在刷新…</span> : browser.transport === "sftp" ? <span>当前使用 SFTP 回退</span> : <span>helper 已连接</span>}
                </div>
              </div>
              <div
                className="min-h-0 flex-1 overflow-auto outline-none"
                tabIndex={0}
                onKeyDown={handleTreeKeyDown}
              >
                {displayMode === "cards" ? renderFileCards() : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead className="w-[84px]">类型</TableHead>
                        <TableHead className="w-[104px] text-right">大小</TableHead>
                        <TableHead className="w-[168px]">修改时间</TableHead>
                        <TableHead className="w-[72px] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{renderTreeRows()}</TableBody>
                  </Table>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">还没有读取到目录内容</div>
          )}
        </div>
      </div>

      <DropdownMenu
        open={Boolean(contextMenuTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuTarget(null)
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed h-0 w-0 opacity-0 pointer-events-none"
            style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {contextMenuTarget ? renderEntryActions(contextMenuTarget) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={trashDialogOpen} onOpenChange={setTrashDialogOpen}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>回收站</DialogTitle>
            <DialogDescription>删除项目会先进入这里，可恢复或彻底删除。</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[520px] flex-col">
            <div className="flex items-center justify-between px-1 pb-3 text-[11px] text-muted-foreground">
              <span>{trash?.entries.length ?? 0} 个项目</span>
              <div className="flex items-center gap-2">
                <span>{trashLoading ? "正在刷新回收站…" : "仅展示当前连接的回收站内容"}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-2xl"
                  onClick={() => void loadTrash()}
                  disabled={trashLoading}
                >
                  {trashLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  刷新
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {displayMode === "cards" ? renderTrashCards() : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>原路径</TableHead>
                      <TableHead className="w-[84px]">类型</TableHead>
                      <TableHead className="w-[104px] text-right">大小</TableHead>
                      <TableHead className="w-[168px]">删除时间</TableHead>
                      <TableHead className="w-[72px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trashLoading && !trash ? (
                      <TableRow>
                        <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                          正在读取回收站…
                        </TableCell>
                      </TableRow>
                    ) : (trash?.entries.length ?? 0) === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                          回收站为空
                        </TableCell>
                      </TableRow>
                    ) : (
                      trash!.entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <div className="min-w-0">
                              <span className="block truncate font-mono text-xs text-foreground">{entry.name}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">{entry.trashedPath}</span>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            <span className="block truncate">{entry.originalPath}</span>
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {entry.type === "directory" ? "目录" : entry.type === "symlink" ? "链接" : "文件"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                            {entry.type === "directory" ? "-" : formatFileSize(entry.size)}
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {new Date(entry.deletedAt).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {renderTrashActions(entry)}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建目录</DialogTitle>
            <DialogDescription>{newFolderParentPath || browser?.currentPath}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">目录名</Label>
            <Input
              className="h-9 rounded-lg"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="例如 uploads 或 backup"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewFolderOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void createFolder()} disabled={!newFolderName.trim() || busyKey === "mkdir"}>
              {busyKey === "mkdir" ? <LoaderCircle className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null)
            setRenameName("")
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription>{renameTarget?.path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">新名称</Label>
            <Input
              className="h-9 rounded-lg"
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void renameEntry()} disabled={!renameName.trim() || busyKey === `rename:${renameTarget?.path}`}>
              {busyKey === `rename:${renameTarget?.path}` ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(permissionTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setPermissionTarget(null)
            setPermissionDetails(null)
            setPermissionRecursive(false)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>修改权限</DialogTitle>
            <DialogDescription>{permissionTarget?.path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="rounded-2xl border border-border/60 bg-muted/[0.08] px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="text-lg font-semibold text-foreground">{permissionTarget?.name}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {permissionLoading ? "正在读取当前权限…" : `当前: ${permissionDetails?.permissions?.symbolic ?? "-"} · 八进制: ${permissionDetails?.permissions?.octal ?? "-"}`}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {permissionLoading ? "请稍候" : describePermissionMode(permissionDetails?.permissions?.octal ?? permissionMode)}
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-sm font-medium text-foreground">快速设置</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {PERMISSION_PRESETS.map((preset) => {
                  const selected = permissionMode.trim() === preset.mode
                  return (
                    <button
                      key={preset.mode}
                      type="button"
                      className={cn(
                        "rounded-xl border px-4 py-4 text-left transition-colors",
                        selected ? preset.className : "border-border/60 bg-muted/[0.05] hover:bg-muted/[0.1] dark:border-white/10 dark:bg-white/[0.02]",
                      )}
                      onClick={() => setPermissionMode(preset.mode)}
                    >
                      <div className="text-lg font-semibold">{preset.label}</div>
                      <div className="mt-1 text-xl font-mono">{preset.mode}</div>
                      <div className="mt-1 text-sm opacity-80">{preset.description}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">手动设置</Label>
              <Input
                className="h-14 rounded-xl border-border/60 bg-background font-mono text-3xl text-center tracking-normal dark:border-white/10"
                value={permissionMode}
                maxLength={4}
                onChange={(event) => setPermissionMode(event.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
                disabled={permissionLoading || busyKey === `chmod:${permissionTarget?.path}`}
              />
              <p className="text-xs text-muted-foreground">{describePermissionMode(permissionMode || "000")}</p>
            </div>

            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-foreground">递归修改子文件夹权限</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {permissionTarget?.type === "directory" ? "会同步更新当前目录下的子目录和文件权限。" : "仅目录支持递归修改。"}
                  </div>
                </div>
                <Switch
                  checked={permissionRecursive}
                  onCheckedChange={setPermissionRecursive}
                  disabled={permissionTarget?.type !== "directory" || permissionLoading || busyKey === `chmod:${permissionTarget?.path}`}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPermissionTarget(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void savePermissions()}
              disabled={permissionLoading || busyKey === `chmod:${permissionTarget?.path}` || !permissionMode.trim()}
            >
              {busyKey === `chmod:${permissionTarget?.path}` ? <LoaderCircle className="size-4 animate-spin" /> : <Shield className="size-4" />}
              保存权限
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleteTarget?.type === "directory" ? "目录" : "文件"}？</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="break-all">{deleteTarget?.path}</span>
              <span className="mt-2 block">
                {deleteTarget?.type === "directory" ? "会将目录及其内容移入回收站。" : "删除后会先进入回收站，可稍后恢复或彻底删除。"}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => void removeEntry()}
            >
              {busyKey === `delete:${deleteTarget?.path}` ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bulkDeleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setBulkDeleteTargets([])
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移入回收站 {bulkDeleteTargets.length} 个项目？</AlertDialogTitle>
            <AlertDialogDescription>
              已选项目会移动到回收站，可稍后恢复或彻底删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => void confirmBulkRemove()}
            >
              {busyKey === "delete:selected" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(purgeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setPurgeTarget(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除该项目？</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="break-all">{purgeTarget?.originalPath}</span>
              <span className="mt-2 block">该操作会从回收站中永久移除，无法恢复。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => void purgeTrashEntry()}
            >
              {busyKey === `purge:${purgeTarget?.id}` ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              彻底删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) {
            setEditorMeta(null)
            setEditorContent("")
          }
        }}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{editorMode === "create" ? "新建文本文件" : "编辑文本文件"}</DialogTitle>
            <DialogDescription>{editorMeta?.modifiedAt ? `上次修改 ${new Date(editorMeta.modifiedAt).toLocaleString()}` : "支持 UTF-8 文本内容"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">远端路径</Label>
              <Input
                className="h-9 rounded-lg font-mono text-xs"
                value={editorPath}
                onChange={(event) => setEditorPath(event.target.value)}
                disabled={editorLoading || editorSaving}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                内容 {editorMeta ? `· ${formatFileSize(editorMeta.size)}` : ""}
              </Label>
              {editorLoading ? (
                <div className="flex h-[420px] items-center justify-center gap-2 rounded-lg border border-border/70 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  正在加载文件内容…
                </div>
              ) : (
                <Textarea
                  className="min-h-[420px] rounded-lg font-mono text-xs"
                  value={editorContent}
                  onChange={(event) => setEditorContent(event.target.value)}
                  disabled={editorSaving}
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
              关闭
            </Button>
            <Button type="button" onClick={() => void saveTextFile()} disabled={editorLoading || editorSaving || !editorPath.trim()}>
              {editorSaving ? <LoaderCircle className="size-4 animate-spin" /> : <FileCode2 className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
