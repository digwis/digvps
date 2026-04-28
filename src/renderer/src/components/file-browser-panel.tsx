import { useEffect, useMemo, useRef, useState } from "react"
import {
  Download,
  FileCode2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  LayoutGrid,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
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
  RemoteTrashEntry,
  RemoteTrashListResult,
  VpsConnectionRecord,
} from "../../../shared/vps"

export type FileBrowserPanelProps = {
  selectedConnection?: VpsConnectionRecord
}

const DEFAULT_REMOTE_DIRECTORY = "/var/www"
const BROWSE_CACHE_STORAGE_KEY = "digwis:file-browser-cache"
const BROWSE_CACHE_FRESH_TTL_MS = 10_000
const BROWSE_CACHE_STORAGE_TTL_MS = 12 * 60 * 60 * 1000
const SHOW_HIDDEN_STORAGE_KEY = "digwis:file-browser-show-hidden"

type CachedBrowseEntry = {
  cachedAt: number
  data: RemoteFileBrowseResult
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

function isHiddenRemoteEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith(".")
}

function buildPathSegments(currentPath: string, rootPath: string) {
  const current = currentPath.split("/").filter(Boolean)
  const root = rootPath.split("/").filter(Boolean)
  const items: Array<{ label: string; path: string }> = [{ label: rootPath === "/" ? "根目录" : rootPath, path: rootPath }]
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

export function FileBrowserPanel({ selectedConnection }: FileBrowserPanelProps) {
  const [browserView, setBrowserView] = useState<"files" | "trash">("files")
  const [displayMode, setDisplayMode] = useState<"list" | "cards">("list")
  const [browser, setBrowser] = useState<RemoteFileBrowseResult | null>(null)
  const [trash, setTrash] = useState<RemoteTrashListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [trashLoading, setTrashLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [pathDraft, setPathDraft] = useState("")
  const [selectedPath, setSelectedPath] = useState<string>()
  const [renameTarget, setRenameTarget] = useState<RemoteFileEntry | null>(null)
  const [renameName, setRenameName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<RemoteFileEntry | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<RemoteTrashEntry | null>(null)
  const [contextMenuTarget, setContextMenuTarget] = useState<RemoteFileEntry | null>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorMode, setEditorMode] = useState<"create" | "edit">("edit")
  const [editorPath, setEditorPath] = useState("")
  const [editorContent, setEditorContent] = useState("")
  const [editorMeta, setEditorMeta] = useState<RemoteFileReadResult | null>(null)
  const browseCacheRef = useRef<Map<string, CachedBrowseEntry>>(buildBrowseCacheMap())
  const prefetchingRef = useRef<Set<string>>(new Set())

  const connectionId = selectedConnection?.id
  const visibleEntries = useMemo(
    () => browser?.entries.filter((entry) => showHiddenFiles || !isHiddenRemoteEntry(entry)) ?? [],
    [browser, showHiddenFiles],
  )
  const pathSegments = useMemo(
    () => (browser ? buildPathSegments(browser.currentPath, browser.rootPath) : []),
    [browser],
  )

  const getBrowseCacheKey = (pathValue?: string) => {
    if (!connectionId) {
      return undefined
    }
    const resolvedPath = pathValue?.trim() || browser?.currentPath || DEFAULT_REMOTE_DIRECTORY
    return `${connectionId}:${resolvedPath}`
  }

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
    setBrowserView("files")
    setTrash(null)
    const restored = restoreCachedBrowser(DEFAULT_REMOTE_DIRECTORY)
    if (!restored) {
      setBrowser(null)
      setPathDraft(DEFAULT_REMOTE_DIRECTORY)
      setSelectedPath(undefined)
    }
    void loadBrowser(DEFAULT_REMOTE_DIRECTORY)
  }, [connectionId])

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
    if (browserView !== "trash" || !connectionId) {
      return
    }
    void loadTrash()
  }, [browserView, connectionId])

  useEffect(() => {
    if (!browser) {
      setSelectedPath(undefined)
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

  const openEntry = async (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
    if (entry.type === "directory") {
      await loadBrowser(entry.path)
      return
    }
    await openTextEditor(entry)
  }

  const startRename = (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
    setRenameTarget(entry)
    setRenameName(entry.name)
  }

  const openTextEditor = async (entry?: RemoteFileEntry) => {
    if (!connectionId || !browser) {
      return
    }
    setEditorMode(entry ? "edit" : "create")
    setEditorMeta(null)
    setEditorPath(entry?.path ?? defaultNewFilePath(browser.currentPath))
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
    if (!connectionId || !browser) {
      return
    }
    setBusyKey("mkdir")
    try {
      const result = await getDesktopApi().vps.createRemoteDirectory({
        connectionId,
        parentPath: browser.currentPath,
        directoryName: newFolderName,
      })
      toast({
        title: "目录已创建",
        description: result.path,
      })
      setNewFolderOpen(false)
      setNewFolderName("")
      await loadBrowser(browser.currentPath)
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
      if (browserView === "files" && browser?.currentPath) {
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

  const renderEntryActions = (entry: RemoteFileEntry) => (
    <>
      <DropdownMenuItem onClick={() => void openEntry(entry)}>
        {entry.type === "directory" ? <FolderOpen className="size-4" /> : <FileCode2 className="size-4" />}
        {entry.type === "directory" ? "打开目录" : "编辑文本"}
      </DropdownMenuItem>
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
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => {
          setSelectedPath(entry.path)
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
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visibleEntries.map((entry) => (
          <div
            key={entry.path}
            className={cn(
              "rounded-lg border border-border/70 bg-card px-4 py-3 shadow-sm",
              selectedPath === entry.path && "border-primary/40 bg-primary/[0.04]",
              browser?.focusedPath === entry.path && "ring-1 ring-primary/20",
            )}
            onClick={() => setSelectedPath(entry.path)}
            onContextMenu={(event) => {
              event.preventDefault()
              setSelectedPath(entry.path)
              setContextMenuPosition({ x: event.clientX, y: event.clientY })
              setContextMenuTarget(entry)
            }}
          >
            <button
              type="button"
              className="flex w-full items-start gap-3 text-left"
              onDoubleClick={() => void openEntry(entry)}
            >
              <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
                {entry.type === "directory" ? <FolderOpen className="size-4" /> : <FileCode2 className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-foreground">{entry.name}</p>
                    <p className="mt-1 line-clamp-2 break-all text-[11px] text-muted-foreground">{entry.path}</p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 rounded-lg"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedPath(entry.path)
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
                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>{entry.type === "directory" ? "目录" : entry.type === "symlink" ? "链接" : "文件"}</span>
                  <span className="font-mono">{entry.type === "directory" ? "-" : formatFileSize(entry.size)}</span>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "-"}
                </p>
              </div>
            </button>
          </div>
        ))}
      </div>
    )
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
          <div key={entry.id} className="rounded-lg border border-border/70 bg-card px-4 py-3 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
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

  if (!selectedConnection) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/80 bg-muted/10 px-8 py-16 text-center">
        <FolderTree className="size-8 text-muted-foreground" />
        <p className="text-base font-medium text-foreground">先选择一台服务器</p>
        <p className="max-w-md text-sm text-muted-foreground">选择连接后即可浏览远端目录、上传文件、编辑文本文件和下载内容。</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">文件浏览</h3>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {selectedConnection.username}@{selectedConnection.host}
                </span>
                {browser?.transport === "sftp" ? (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-300">
                    降级模式
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={browserView === "files" ? "default" : "outline"}
                  size="sm"
                  className="rounded-lg"
                  onClick={() => setBrowserView("files")}
                >
                  文件
                </Button>
                <Button
                  type="button"
                  variant={browserView === "trash" ? "default" : "outline"}
                  size="sm"
                  className="rounded-lg"
                  onClick={() => setBrowserView("trash")}
                >
                  <Trash2 className="size-4" />
                  回收站
                </Button>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {pathSegments.map((segment, index) => (
                  <div key={segment.path} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      className="max-w-[14rem] truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
                      disabled={browserView !== "files"}
                      onClick={() => void loadBrowser(segment.path)}
                    >
                      {segment.label}
                    </button>
                    {index < pathSegments.length - 1 ? <span>/</span> : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-lg border border-border/70 bg-muted/20 p-1">
                <Button
                  type="button"
                  variant={displayMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-8 rounded-md"
                  onClick={() => setDisplayMode("list")}
                >
                  <List className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant={displayMode === "cards" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-8 rounded-md"
                  onClick={() => setDisplayMode("cards")}
                >
                  <LayoutGrid className="size-4" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void openTextEditor()} disabled={!browser || browserView !== "files"}>
                <FileCode2 className="size-4" />
                新建文本
              </Button>
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setNewFolderOpen(true)} disabled={!browser || browserView !== "files"}>
                <FolderPlus className="size-4" />
                新建目录
              </Button>
              <Button type="button" size="sm" className="rounded-lg" onClick={() => void uploadEntries()} disabled={!browser || busyKey === "upload" || browserView !== "files"}>
                {busyKey === "upload" ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
                上传
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => void (browserView === "files" ? loadBrowser(browser?.currentPath, { forceRefresh: true }) : loadTrash())}
                disabled={browserView === "files" ? loading : trashLoading}
              >
                {(browserView === "files" ? loading : trashLoading) ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => void loadBrowser(browser?.parentPath ?? browser?.rootPath)}
              disabled={browserView !== "files" || !browser?.parentPath || loading}
            >
              返回上级
            </Button>
            <Input
              className="h-8 flex-1 rounded-lg border-0 bg-muted/60 font-mono text-xs shadow-none"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder={browserView === "files" ? "输入远端路径后回车或点击打开" : "回收站视图不支持路径跳转"}
              disabled={browserView !== "files"}
              onKeyDown={(event) => {
                if (browserView === "files" && event.key === "Enter") {
                  event.preventDefault()
                  void loadBrowser(pathDraft)
                }
              }}
            />
            <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void loadBrowser(pathDraft)} disabled={browserView !== "files" || !pathDraft.trim() || loading}>
              打开
            </Button>
            <div className="ml-auto flex items-center gap-2 px-1 py-1">
              <Label htmlFor="show-hidden-files" className="text-xs font-normal text-muted-foreground">
                显示隐藏文件
              </Label>
              <Switch
                id="show-hidden-files"
                checked={showHiddenFiles}
                onCheckedChange={setShowHiddenFiles}
                disabled={browserView !== "files"}
              />
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {browserView === "files" && loading && !browser ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              正在连接远端目录…
            </div>
          ) : browserView === "files" && browser ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
                <span>{visibleEntries.length} 个项目</span>
                {loading ? <span>显示缓存内容，正在刷新…</span> : browser.transport === "sftp" ? <span>当前使用 SFTP 回退</span> : <span>helper 已连接</span>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
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
                    <TableBody>
                      {visibleEntries.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                            {showHiddenFiles ? "当前目录为空" : "当前目录没有可见文件"}
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleEntries.map((entry) => (
                          <TableRow
                            key={entry.path}
                            data-state={selectedPath === entry.path ? "selected" : undefined}
                            className={cn(browser.focusedPath === entry.path && "bg-muted/40")}
                            onClick={() => setSelectedPath(entry.path)}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              setSelectedPath(entry.path)
                              setContextMenuPosition({ x: event.clientX, y: event.clientY })
                              setContextMenuTarget(entry)
                            }}
                          >
                            <TableCell>
                              <button
                                type="button"
                                className="flex min-w-0 items-center gap-2 text-left"
                                onDoubleClick={() => void openEntry(entry)}
                              >
                                {entry.type === "directory" ? (
                                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                                ) : (
                                  <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                <div className="min-w-0">
                                  <span className="block truncate font-mono text-xs text-foreground">{entry.name}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">{entry.path}</span>
                                </div>
                              </button>
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
                                    onClick={() => setSelectedPath(entry.path)}
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
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          ) : browserView === "trash" ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
                <span>{trash?.entries.length ?? 0} 个项目</span>
                {trashLoading ? <span>正在刷新回收站…</span> : <span>删除项目会先进入这里</span>}
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

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建目录</DialogTitle>
            <DialogDescription>{browser?.currentPath}</DialogDescription>
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
