import { useEffect, useMemo, useRef, useState } from "react"
import {
  Download,
  FileCode2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
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
  const [browser, setBrowser] = useState<RemoteFileBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [pathDraft, setPathDraft] = useState("")
  const [renameTarget, setRenameTarget] = useState<RemoteFileEntry | null>(null)
  const [renameName, setRenameName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<RemoteFileEntry | null>(null)
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
    const restored = restoreCachedBrowser(DEFAULT_REMOTE_DIRECTORY)
    if (!restored) {
      setBrowser(null)
      setPathDraft(DEFAULT_REMOTE_DIRECTORY)
    }
    void loadBrowser(DEFAULT_REMOTE_DIRECTORY)
  }, [connectionId])

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
      const result = await getDesktopApi().vps.deleteRemoteEntry({
        connectionId,
        path: deleteTarget.path,
      })
      toast({
        title: deleteTarget.type === "directory" ? "目录已删除" : "文件已删除",
        description: result.path,
      })
      setDeleteTarget(null)
      await loadBrowser(browser?.currentPath)
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
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {pathSegments.map((segment, index) => (
                  <div key={segment.path} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      className="max-w-[14rem] truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
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
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void openTextEditor()} disabled={!browser}>
                <FileCode2 className="size-4" />
                新建文本
              </Button>
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setNewFolderOpen(true)} disabled={!browser}>
                <FolderPlus className="size-4" />
                新建目录
              </Button>
              <Button type="button" size="sm" className="rounded-lg" onClick={() => void uploadEntries()} disabled={!browser || busyKey === "upload"}>
                {busyKey === "upload" ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
                上传
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => void loadBrowser(browser?.currentPath, { forceRefresh: true })}
                disabled={loading}
              >
                {loading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
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
              disabled={!browser?.parentPath || loading}
            >
              返回上级
            </Button>
            <Input
              className="h-8 flex-1 rounded-lg border-0 bg-muted/60 font-mono text-xs shadow-none"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="输入远端路径后回车或点击打开"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void loadBrowser(pathDraft)
                }
              }}
            />
            <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void loadBrowser(pathDraft)} disabled={!pathDraft.trim() || loading}>
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
              />
            </div>
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
              <div className="flex items-center justify-between border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
                <span>{visibleEntries.length} 个项目</span>
                {loading ? <span>显示缓存内容，正在刷新…</span> : browser.transport === "sftp" ? <span>当前使用 SFTP 回退</span> : <span>helper 已连接</span>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
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
                          className={cn(browser.focusedPath === entry.path && "bg-muted/40")}
                        >
                          <TableCell>
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-2 text-left"
                              onClick={() => {
                                if (entry.type === "directory") {
                                  void loadBrowser(entry.path)
                                  return
                                }
                                void openTextEditor(entry)
                              }}
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
                                <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => {
                                    if (entry.type === "directory") {
                                      void loadBrowser(entry.path)
                                      return
                                    }
                                    void openTextEditor(entry)
                                  }}
                                >
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
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenameTarget(entry)
                                    setRenameName(entry.name)
                                  }}
                                >
                                  <Pencil className="size-4" />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteTarget(entry)}
                                >
                                  <Trash2 className="size-4" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">还没有读取到目录内容</div>
          )}
        </div>
      </div>

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
                {deleteTarget?.type === "directory" ? "会递归删除目录中的全部内容。" : "该操作不可撤销。"}
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
              删除
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
