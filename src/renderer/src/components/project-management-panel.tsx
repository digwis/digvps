import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  ArrowRightLeft,
  CircleStop,
  ExternalLink,
  FileText,
  FolderInput,
  FolderOpen,
  Globe,
  HelpCircle,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { getDesktopApi } from "@/lib/desktop-api"
import { useProjectStore } from "@/store/project-store"
import { toast } from "@/hooks/use-toast"
import type {
  LocalProjectRecord,
  ProjectActionKind,
  ProjectActionHint,
  ProjectBackupSchedule,
  ProjectBackupScheduleState,
  ProjectDeployProfile,
  ProjectDeployStrategy,
  ProjectOperationLogEntry,
  ProjectRemoteDetails,
  ProjectRemoteState,
} from "../../../shared/projects"
import type { VpsConnectionRecord } from "../../../shared/vps"

export type ProjectManagementPanelProps = {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
  highlightedProjectId?: string
  onOpenRemoteDirectory?: (payload: { connectionId: string; path: string; projectId: string }) => void
}

type DeployScriptOption = {
  value: string
  label: string
  action?: "code" | "data" | "uploads" | "backup"
}

type ProjectLogFilter = "all" | "init" | "deploy" | "backup" | "error"

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

function connectionLabel(connections: VpsConnectionRecord[], id?: string | null) {
  if (!id) {
    return ""
  }
  return connections.find((c) => c.id === id)?.name ?? ""
}

function buildDeployScriptOptions(scripts: string[]): DeployScriptOption[] {
  const has = new Set(scripts)
  const options: DeployScriptOption[] = []
  const add = (names: string[], label: string, action?: DeployScriptOption["action"]) => {
    const match = names.find((name) => has.has(name))
    if (match && !options.some((item) => item.value === match)) {
      options.push({ value: match, label, action })
    }
  }

  add(["deploy:panel", "deploy:vps:code"], "部署代码", "code")
  add(["sync:vps:admin-data", "sync:vps:data", "sync:vps"], "部署数据", "data")
  add(["sync:vps:uploads", "sync:uploads:vps"], "同步文件", "uploads")

  if (options.length === 0) {
    const fallback = scripts.slice(0, 4)
    return fallback.map((name, index) => ({
      value: name,
      label: `自定义动作 ${index + 1}`,
    }))
  }

  return options.slice(0, 4)
}

function formatActionSummary(hint?: ProjectActionHint) {
  if (!hint) {
    return "可直接执行"
  }
  if (hint.needsAttention) {
    return hint.lastRunAt ? "检测到新变化" : "尚未执行过"
  }
  return "已是最新"
}

function backupScheduleLabel(schedule?: ProjectBackupSchedule) {
  if (schedule === "daily") {
    return "每天"
  }
  if (schedule === "weekly") {
    return "每周"
  }
  if (schedule === "monthly") {
    return "每月"
  }
  return "关闭"
}

function recommendedAction(project: LocalProjectRecord, args: {
  selectedConnectionId?: string
  remoteDetails: ProjectRemoteDetails | null
  remoteState: ProjectRemoteState | null
  actionHints?: ProjectActionHint[]
}) {
  const { selectedConnectionId, remoteDetails, remoteState, actionHints } = args
  const hintMap = new Map((actionHints ?? []).map((item) => [item.action, item]))

  if (!project.lastConnectionId && !selectedConnectionId) {
    return {
      label: "先关联服务器",
      detail: "当前项目还没有绑定目标 VPS",
      tone: "bg-amber-500/10 text-amber-700 dark:text-amber-200",
    }
  }
  if (project.lastDeployStatus === "failed") {
    return {
      label: "重新部署代码",
      detail: "上次部署失败，请查看日志后重试。",
      tone: "bg-destructive/10 text-destructive",
    }
  }
  if (remoteState?.runtimeIssues.length) {
    return {
      label: "检查远端运行状态",
      detail: remoteState.runtimeIssues[0] ?? "远端存在运行异常",
      tone: "bg-amber-500/10 text-amber-700 dark:text-amber-200",
    }
  }
  if (remoteDetails?.service.configured && !remoteDetails.service.active) {
    return {
      label: "重启远端服务",
      detail: remoteDetails.service.statusText || "服务已配置但当前未运行",
      tone: "bg-amber-500/10 text-amber-700 dark:text-amber-200",
    }
  }

  const actionPriority: Array<{ action: ProjectActionKind; label: string }> = [
    { action: "code", label: "部署代码" },
    { action: "data", label: "部署数据" },
    { action: "uploads", label: "同步文件" },
    { action: "backup", label: "执行备份" },
  ]

  const pending = actionPriority.find((item) => hintMap.get(item.action)?.needsAttention)
  if (pending) {
    return {
      label: pending.label,
      detail: hintMap.get(pending.action)?.reason ?? "检测到有待处理的变更",
      tone: "bg-sky-500/10 text-sky-700 dark:text-sky-200",
    }
  }

  return {
    label: "当前无需额外操作",
    detail: "部署与同步状态都处于最新",
    tone: "bg-muted text-muted-foreground",
  }
}

function summarizeProjectLog(entry: ProjectOperationLogEntry) {
  const text = entry.chunk.replace(/\s+/g, " ").trim()
  if (!text) {
    return null
  }
  if (text.includes("[finish]")) {
    const failed = text.includes("failed")
    return {
      title: failed ? "最近执行失败" : "最近执行完成",
      detail: failed ? "执行失败，详情请查看日志。" : "执行完成，详情可在日志中查看。",
      tone: failed ? "text-destructive" : "text-foreground",
    }
  }
  if (text.includes("[start]")) {
    return {
      title: "正在执行",
      detail: text.replace("[start]", "").trim(),
      tone: "text-muted-foreground",
    }
  }
  if (text.includes("[backup-schedule]")) {
    return {
      title: "备份计划已更新",
      detail: text.replace("[backup-schedule]", "").trim(),
      tone: "text-foreground",
    }
  }
  return {
    title: entry.stream === "stderr" ? "最近输出" : "最近记录",
    detail: entry.stream === "stderr" ? "有新的错误输出，详情请查看日志。" : "有新的执行记录，详情请查看日志。",
    tone: entry.stream === "stderr" ? "text-destructive" : "text-muted-foreground",
  }
}

function isInitLog(entry: ProjectOperationLogEntry) {
  return entry.chunk.includes("initialize remote project") || entry.chunk.includes("initialize success") || entry.chunk.includes("initialize failed")
}

function isConfigLog(entry: ProjectOperationLogEntry) {
  return entry.chunk.includes("[backup-schedule]")
}

function isBackupLog(entry: ProjectOperationLogEntry) {
  const text = entry.chunk.toLowerCase()
  return text.includes("backup") || text.includes("[backup-schedule]")
}

function isErrorLog(entry: ProjectOperationLogEntry) {
  const text = entry.chunk.toLowerCase()
  return entry.stream === "stderr" || text.includes("failed") || text.includes("error")
}

function isDeployLog(entry: ProjectOperationLogEntry) {
  return !isInitLog(entry) && !isBackupLog(entry)
}

function matchesLogFilter(entry: ProjectOperationLogEntry, filter: ProjectLogFilter) {
  if (filter === "all") {
    return true
  }
  if (filter === "init") {
    return isInitLog(entry)
  }
  if (filter === "deploy") {
    return isDeployLog(entry)
  }
  if (filter === "backup") {
    return isBackupLog(entry)
  }
  if (filter === "error") {
    return isErrorLog(entry)
  }
  return true
}

function latestMatchingLog(entries: ProjectOperationLogEntry[] | undefined, predicate: (entry: ProjectOperationLogEntry) => boolean) {
  if (!entries?.length) {
    return undefined
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (predicate(entry)) {
      return entry
    }
  }
  return undefined
}

function deployStatusMeta(project: LocalProjectRecord) {
  if (project.lastDeployStatus === "success") {
    return {
      label: "部署正常",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
    }
  }
  if (project.lastDeployStatus === "running") {
    return {
      label: "执行中",
      className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200",
    }
  }
  if (project.lastDeployStatus === "failed") {
    return {
      label: "部署失败",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    }
  }
  return {
    label: "未部署",
    className: "border-border/70 bg-muted/70 text-muted-foreground",
  }
}

function ProjectDeployCard({
  project,
  connections,
  selectedConnectionId,
  highlighted,
  isDeploying,
  deployingProjectId,
  isInitializing,
  initializingProjectId,
  onInitialize,
  onDeploy,
  onDelete,
  actionHints,
  backupSchedule,
  recentLogs,
  fullLogs,
  onProjectStateRefresh,
  onOpenRemoteDirectory,
}: {
  project: LocalProjectRecord
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
  highlighted?: boolean
  isDeploying: boolean
  deployingProjectId?: string
  isInitializing: boolean
  initializingProjectId?: string
  onInitialize: (args: { connectionId: string }) => void
  onDeploy: (args: {
    connectionId: string
    strategy: ProjectDeployStrategy
    remoteParentPath?: string
    npmScript?: string
  }) => void
  onDelete: () => void
  actionHints?: ProjectActionHint[]
  backupSchedule?: ProjectBackupScheduleState
  recentLogs?: ProjectOperationLogEntry[]
  fullLogs?: ProjectOperationLogEntry[]
  onProjectStateRefresh: () => Promise<void>
  onOpenRemoteDirectory?: (payload: { connectionId: string; path: string; projectId: string }) => void
}) {
  const [connectionId, setConnectionId] = useState<string>(project.lastConnectionId ?? selectedConnectionId ?? "")
  const [remoteParent, setRemoteParent] = useState("")
  const [strategy, setStrategy] = useState<ProjectDeployStrategy>(
    project.lastDeployKind === "local-npm-script" ? "local-npm-script" : "sftp",
  )
  const [npmScripts, setNpmScripts] = useState<DeployScriptOption[]>([])
  const [npmScript, setNpmScript] = useState("")
  const [deployProfile, setDeployProfile] = useState<ProjectDeployProfile | null>(null)
  const [remoteState, setRemoteState] = useState<ProjectRemoteState | null>(null)
  const [remoteStateLoading, setRemoteStateLoading] = useState(false)
  const [initDialogOpen, setInitDialogOpen] = useState(false)
  const [remoteDetails, setRemoteDetails] = useState<ProjectRemoteDetails | null>(null)
  const [remoteDetailsLoading, setRemoteDetailsLoading] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserPath, setBrowserPath] = useState<string>()
  const [browserDetails, setBrowserDetails] = useState<ProjectRemoteDetails | null>(null)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [siteDomain, setSiteDomain] = useState("")
  const [sslEmail, setSslEmail] = useState("")
  const [certificatePem, setCertificatePem] = useState("")
  const [privateKeyPem, setPrivateKeyPem] = useState("")
  const [siteSaving, setSiteSaving] = useState(false)
  const [siteError, setSiteError] = useState<string>()
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false)
  const [remoteInfoOpen, setRemoteInfoOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logFilter, setLogFilter] = useState<ProjectLogFilter>("all")
  const [logQuery, setLogQuery] = useState("")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [stoppingService, setStoppingService] = useState(false)
  const [runningBackup, setRunningBackup] = useState(false)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrationTargetId, setMigrationTargetId] = useState("")
  const hintByAction = useMemo(() => {
    const map = new Map<string, ProjectActionHint>()
    for (const item of actionHints ?? []) {
      map.set(item.action, item)
    }
    return map
  }, [actionHints])

  const executeScriptAction = (item: DeployScriptOption) => {
    setNpmScript(item.value)
    onDeploy({
      connectionId,
      strategy,
      npmScript: item.value,
    })
  }

  useEffect(() => {
    setConnectionId((current) => {
      if (project.lastConnectionId) {
        return project.lastConnectionId
      }
      if (!current && selectedConnectionId) {
        return selectedConnectionId
      }
      return current
    })
  }, [project.lastConnectionId, selectedConnectionId])

  useEffect(() => {
    if (project.lastDeployKind === "local-npm-script") {
      setStrategy("local-npm-script")
    } else if (project.lastDeployKind === "sftp") {
      setStrategy("sftp")
    }
  }, [project.lastDeployKind])

  useEffect(() => {
    const fallbackTarget = connections.find((item) => item.id !== connectionId)?.id ?? ""
    setMigrationTargetId((current) => (current && current !== connectionId ? current : fallbackTarget))
  }, [connectionId, connections])

  useEffect(() => {
    let cancelled = false
    void getDesktopApi()
      .projects.getDeployProfile(project.id)
      .then((profile) => {
        if (cancelled) {
          return
        }
        setDeployProfile(profile)
        const scriptOptions = buildDeployScriptOptions(profile.npmScripts)
        setNpmScripts(scriptOptions)
        const nextStrategy =
          scriptOptions.length > 0
            ? "local-npm-script"
            : project.lastDeployKind === "local-npm-script" || project.lastDeployKind === "sftp"
              ? project.lastDeployKind
              : profile.recommendedStrategy
        setStrategy(nextStrategy)
        if (profile.recommendedNpmScript && scriptOptions.some((item) => item.value === profile.recommendedNpmScript)) {
          setNpmScript(profile.recommendedNpmScript)
        } else if (scriptOptions[0]) {
          setNpmScript(scriptOptions[0].value)
        } else {
          setNpmScript("")
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeployProfile(null)
          setNpmScripts([])
          setNpmScript("")
        }
      })
    return () => {
      cancelled = true
    }
  }, [project.id])

  useEffect(() => {
    if (!connectionId || !deployProfile?.canInitialize) {
      setRemoteState(null)
      setRemoteStateLoading(false)
      return
    }

    let cancelled = false
    setRemoteStateLoading(true)
    void getDesktopApi()
      .projects.getProjectRemoteState({
        projectId: project.id,
        connectionId,
      })
      .then((state) => {
        if (!cancelled) {
          setRemoteState(state)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRemoteState(null)
          toast({
            variant: "destructive",
            title: `${project.displayName} 检查失败`,
            description: error instanceof Error ? error.message : "无法检查远端初始化状态",
          })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteStateLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionId, deployProfile?.canInitialize, project.displayName, project.id])

  const effectiveRemoteAppDir = useMemo(
    () => project.lastRemotePath || deployProfile?.defaultRemoteAppDir || null,
    [deployProfile?.defaultRemoteAppDir, project.lastRemotePath],
  )

  const loadRemoteDetails = async (browseTarget?: string, options?: { forceRefresh?: boolean }) => {
    if (!connectionId || !effectiveRemoteAppDir) {
      return null
    }
    return await getDesktopApi().projects.getProjectRemoteDetails({
      projectId: project.id,
      connectionId,
      browsePath: browseTarget,
      forceRefresh: options?.forceRefresh,
    })
  }

  useEffect(() => {
    if (!connectionId || !effectiveRemoteAppDir) {
      setRemoteDetails(null)
      setRemoteDetailsLoading(false)
      return
    }

    let cancelled = false
    setRemoteDetailsLoading(true)
    void loadRemoteDetails()
      .then((details) => {
        if (!cancelled) {
          setRemoteDetails(details)
          setSiteDomain(details?.site.domain ?? "")
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRemoteDetails(null)
          toast({
            variant: "destructive",
            title: `${project.displayName} 远端详情读取失败`,
            description: error instanceof Error ? error.message : "无法读取远端项目详情",
          })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteDetailsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionId, effectiveRemoteAppDir, project.displayName, project.id, project.lastDeployAt])

  const busy = isDeploying && deployingProjectId === project.id
  const bootstrapping = isInitializing && initializingProjectId === project.id
  const success = project.lastDeployStatus === "success"
  const failed = project.lastDeployStatus === "failed"
  const hasScriptActions = strategy === "local-npm-script" && npmScripts.length > 0
  const initHint =
    remoteStateLoading
      ? "正在检查远端环境…"
      : remoteState && !remoteState.ready && remoteState.missingItems.length > 0
        ? `需要初始化：${remoteState.missingItems.join("、")}`
        : remoteState?.runtimeIssues.length
          ? `远端已初始化；${remoteState.runtimeIssues.join("、")}`
          : remoteState?.ready
            ? "远端已初始化"
            : deployProfile?.canInitialize
              ? "可执行远端初始化"
              : undefined
  const shouldShowInitializeButton =
    Boolean(deployProfile?.canInitialize) && !remoteStateLoading && !remoteState?.ready
  const remoteRuntimeHint = remoteDetails?.service.configured
    ? remoteDetails.service.active
      ? "服务运行中"
      : "服务未启动"
    : "未配置远端服务"
  const deployBadge = deployStatusMeta(project)
  const needsAttention =
    failed ||
    Boolean(remoteState?.runtimeIssues.length) ||
    Boolean(actionHints?.some((item) => item.needsAttention))
  const nextAction = recommendedAction(project, {
    selectedConnectionId,
    remoteDetails,
    remoteState,
    actionHints,
  })
  const canOpenRemoteDirectory = Boolean(connectionId && effectiveRemoteAppDir && onOpenRemoteDirectory)
  const latestInitLog = latestMatchingLog(fullLogs, isInitLog)
  const latestActionLog = latestMatchingLog(fullLogs, (entry) => !isInitLog(entry) && !isConfigLog(entry))
  const initSummary = latestInitLog ? summarizeProjectLog(latestInitLog) : null
  const actionSummary = latestActionLog ? summarizeProjectLog(latestActionLog) : null
  const filteredLogs = useMemo(
    () =>
      (fullLogs ?? []).filter((entry) => {
        if (!matchesLogFilter(entry, logFilter)) {
          return false
        }
        const query = logQuery.trim().toLowerCase()
        if (!query) {
          return true
        }
        return `${entry.chunk}\n${entry.stream}\n${entry.at}`.toLowerCase().includes(query)
      }),
    [fullLogs, logFilter, logQuery],
  )
  const logFilterCounts = useMemo(
    () => ({
      all: fullLogs?.length ?? 0,
      init: (fullLogs ?? []).filter(isInitLog).length,
      deploy: (fullLogs ?? []).filter(isDeployLog).length,
      backup: (fullLogs ?? []).filter(isBackupLog).length,
      error: (fullLogs ?? []).filter(isErrorLog).length,
    }),
    [fullLogs],
  )
  const overviewBadges = [
    {
      label: deployBadge.label,
      className: deployBadge.className,
    },
    remoteDetails?.service.configured
      ? {
          label: remoteDetails.service.active ? "服务运行中" : "服务未启动",
          className: remoteDetails.service.active
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200",
        }
      : null,
    remoteDetails?.publicUrl
      ? {
          label: remoteDetails.site.mode === "domain" ? "域名入口" : "端口预览",
          className: "border-border/70 bg-muted/70 text-foreground",
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; className: string }>

  const refreshRemoteDetails = async () => {
    if (!effectiveRemoteAppDir || !connectionId) {
      return
    }
    setRemoteDetailsLoading(true)
    setSiteError(undefined)
    try {
      const details = await loadRemoteDetails(undefined, { forceRefresh: true })
      setRemoteDetails(details)
      if (details) {
        setSiteDomain(details.site.domain ?? "")
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 刷新失败`,
        description: error instanceof Error ? error.message : "无法刷新远端项目状态",
      })
    } finally {
      setRemoteDetailsLoading(false)
    }
  }

  const openRemoteBrowser = async (targetPath?: string) => {
    if (!connectionId || !effectiveRemoteAppDir) {
      return
    }
    setBrowserOpen(true)
    setBrowserLoading(true)
    try {
      const details = await loadRemoteDetails(targetPath)
      setBrowserDetails(details)
      setBrowserPath(details?.currentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 浏览失败`,
        description: error instanceof Error ? error.message : "无法浏览远端目录",
      })
    } finally {
      setBrowserLoading(false)
    }
  }

  const restartRemoteService = async () => {
    if (!connectionId) {
      return
    }
    try {
      const restarted = await getDesktopApi().projects.restartProjectService({
        projectId: project.id,
        connectionId,
      })
      if (!restarted.ok) {
        toast({
          variant: "destructive",
          title: `${project.displayName} 重启失败`,
          description: restarted.message,
        })
        return
      }
      toast({
        title: `${project.displayName} 已重启`,
        description: restarted.message,
      })
      await refreshRemoteDetails()
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 重启失败`,
        description: error instanceof Error ? error.message : "无法重启远端服务",
      })
    }
  }

  const stopRemoteService = async () => {
    if (!connectionId) {
      return
    }
    setStoppingService(true)
    try {
      const stopped = await getDesktopApi().projects.stopProjectService({
        projectId: project.id,
        connectionId,
      })
      if (!stopped.ok) {
        toast({
          variant: "destructive",
          title: `${project.displayName} 停止失败`,
          description: stopped.message,
        })
        return
      }
      toast({
        title: `${project.displayName} 已停止`,
        description: stopped.message,
      })
      await refreshRemoteDetails()
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 停止失败`,
        description: error instanceof Error ? error.message : "无法停止远端服务",
      })
    } finally {
      setStoppingService(false)
    }
  }

  const runManualBackup = async () => {
    if (!connectionId) {
      return
    }
    setRunningBackup(true)
    try {
      const result = await getDesktopApi().projects.runProjectBackup({
        projectId: project.id,
        connectionId,
      })
      if (!result.ok) {
        toast({
          variant: "destructive",
          title: `${project.displayName} 备份失败`,
          description: result.message,
        })
        return
      }
      toast({
        title: `${project.displayName} 备份完成`,
        description: result.message,
      })
      await onProjectStateRefresh()
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 备份失败`,
        description: error instanceof Error ? error.message : "无法执行远端备份",
      })
    } finally {
      setRunningBackup(false)
    }
  }

  const runMigration = async () => {
    if (!connectionId || !migrationTargetId || migrationTargetId === connectionId) {
      return
    }
    setMigrating(true)
    try {
      const result = await getDesktopApi().projects.migrateProject({
        projectId: project.id,
        sourceConnectionId: connectionId,
        targetConnectionId: migrationTargetId,
      })
      if (!result.ok) {
        toast({
          variant: "destructive",
          title: `${project.displayName} 迁移失败`,
          description: result.message,
        })
        return
      }
      toast({
        title: `${project.displayName} 已迁移`,
        description: result.message,
      })
      setMigrateOpen(false)
      await onProjectStateRefresh()
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 迁移失败`,
        description: error instanceof Error ? error.message : "无法执行项目迁移",
      })
    } finally {
      setMigrating(false)
    }
  }

  const saveSiteSettings = async () => {
    if (!connectionId) {
      setSiteError("请先选择目标 VPS")
      return
    }
    setSiteSaving(true)
    setSiteError(undefined)
    try {
      const result = await getDesktopApi().projects.saveProjectSiteSettings({
        projectId: project.id,
        connectionId,
        domain: siteDomain.trim() || undefined,
        sslEmail: sslEmail.trim() || undefined,
        certificatePem: certificatePem.trim() || undefined,
        privateKeyPem: privateKeyPem.trim() || undefined,
      })
      if (!result.ok) {
        setSiteError(result.message)
        return
      }
      toast({
        title: `${project.displayName} 站点配置已更新`,
        description: result.publicUrl ?? result.previewUrl ?? result.message,
      })
      await refreshRemoteDetails()
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : "保存站点配置失败")
    } finally {
      setSiteSaving(false)
    }
  }

  useEffect(() => {
    if (!siteSettingsOpen) {
      return
    }

    const syncFromRemote = async () => {
      let details = remoteDetails
      if (!details && connectionId && effectiveRemoteAppDir) {
        try {
          details = await loadRemoteDetails(undefined, { forceRefresh: true })
          setRemoteDetails(details)
        } catch (error) {
          setSiteError(error instanceof Error ? error.message : "无法读取当前站点设置")
          return
        }
      }

      setSiteError(undefined)
      setSiteDomain(details?.site.domain ?? "")
      setSslEmail("")
      setCertificatePem(details?.site.certificatePem ?? "")
      setPrivateKeyPem("")
    }

    void syncFromRemote()
  }, [siteSettingsOpen, remoteDetails, connectionId, effectiveRemoteAppDir])

  const openBrowserParent = async () => {
    if (!browserDetails || browserDetails.currentPath === browserDetails.remoteAppDir) {
      return
    }
    const segments = browserDetails.currentPath.split("/").filter(Boolean)
    segments.pop()
    const parentPath = `/${segments.join("/")}`
    await openRemoteBrowser(parentPath || browserDetails.remoteAppDir)
  }

  return (
    <>
      <Card
        id={`project-card-${project.id}`}
        className={cn(
          "overflow-visible rounded-2xl border border-border/70 bg-card shadow-sm transition",
          success && "border-emerald-500/30",
          highlighted && "border-primary/40 bg-primary/[0.04] ring-2 ring-primary/20",
        )}
      >
        <CardHeader className="space-y-2 px-5 py-5 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <CardTitle className="truncate text-base font-semibold">{project.displayName}</CardTitle>
                {effectiveRemoteAppDir ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground"
                    disabled={!connectionId}
                    onClick={() => setRemoteInfoOpen(true)}
                  >
                    <HelpCircle className="size-4" />
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{project.localPath}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {overviewBadges.map((item) => (
                  <Badge key={item.label} variant="outline" className={cn("h-5 rounded-md px-2 font-normal shadow-none", item.className)}>
                    {item.label}
                  </Badge>
                ))}
                {needsAttention ? (
                  <Badge variant="outline" className="h-5 rounded-md border-amber-500/30 bg-amber-500/10 px-2 font-normal text-amber-700 shadow-none dark:text-amber-200">
                    需要关注
                  </Badge>
                ) : null}
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 shrink-0 rounded-lg border-destructive/20 px-2.5 text-xs text-destructive shadow-none hover:bg-destructive/5 hover:text-destructive"
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                  移除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>从面板移除此项目？</AlertDialogTitle>
                  <AlertDialogDescription>
                    只会把项目从当前面板列表中移除，不会删除本地项目文件，也不会删除远端 VPS 上的目录和数据。请输入项目名 <span className="font-medium text-foreground">{project.displayName}</span> 以确认。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  className="h-9 rounded-lg"
                  placeholder={`输入 ${project.displayName} 确认`}
                  value={deleteConfirmText}
                  onChange={(event) => setDeleteConfirmText(event.target.value)}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setDeleteConfirmText("")}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deleteConfirmText.trim() !== project.displayName}
                    onClick={() => {
                      setDeleteConfirmText("")
                      onDelete()
                    }}
                  >
                    确认移除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-5 pb-5 pt-0">
          <div className="grid gap-2 rounded-xl border border-border/60 bg-muted/[0.06] px-3 py-3 text-[11px] text-muted-foreground sm:grid-cols-2">
            <p className="truncate">
              最近部署
              <span className="ml-1 text-foreground">
                {project.lastDeployAt ? new Date(project.lastDeployAt).toLocaleString() : "尚无记录"}
              </span>
            </p>
            <p className="truncate">
              远端目录
              {canOpenRemoteDirectory ? (
                <button
                  type="button"
                  className="ml-1 inline-flex max-w-full items-center gap-1 truncate text-foreground underline-offset-4 hover:text-primary hover:underline"
                  onClick={() =>
                    onOpenRemoteDirectory?.({
                      connectionId,
                      path: effectiveRemoteAppDir as string,
                      projectId: project.id,
                    })
                  }
                  title={`打开 ${effectiveRemoteAppDir} 到文件浏览`}
                >
                  <span className="truncate">{effectiveRemoteAppDir}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </button>
              ) : (
                <span className="ml-1 text-foreground">{effectiveRemoteAppDir ?? "未配置"}</span>
              )}
            </p>
            <p className="truncate">
              代码状态
              <span className="ml-1 text-foreground">{formatActionSummary(hintByAction.get("code"))}</span>
            </p>
            <p className="truncate">
              备份计划
              <span className="ml-1 text-foreground">{backupScheduleLabel(backupSchedule?.schedule)}</span>
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-background px-3 py-2.5">
            <span className={cn("mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium", nextAction.tone)}>
              {nextAction.label}
            </span>
            <p className="min-w-0 flex-1 text-[11px] leading-5 text-muted-foreground">
              {nextAction.detail}
            </p>
          </div>
          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/[0.05] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">最近执行</p>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <span className={cn("shrink-0 text-[12px] font-medium", actionSummary?.tone ?? "text-foreground")}>
                    {actionSummary?.title ?? "暂无记录"}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {actionSummary?.detail ?? "尚未记录部署、同步或备份结果。"}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {latestActionLog ? new Date(latestActionLog.at).toLocaleTimeString() : "暂无"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  disabled={!fullLogs?.length}
                  onClick={() => setLogsOpen(true)}
                >
                  <FileText className="size-3.5" />
                  日志
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">初始化</p>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {initSummary?.detail ?? "尚未执行初始化"}
                </p>
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {latestInitLog ? new Date(latestInitLog.at).toLocaleTimeString() : "暂无"}
              </span>
            </div>
          </div>
          {hasScriptActions ? null : (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">远端父目录（可选）</Label>
              <Input
                className="h-9 rounded-xl font-mono text-xs"
                placeholder="例如 /var/www 或 ~/sites（可选）"
                value={remoteParent}
                onChange={(e) => setRemoteParent(e.target.value)}
                disabled={busy || bootstrapping}
              />
            </div>
          )}
          <div className={cn("grid gap-2", hasScriptActions ? "grid-cols-2" : "sm:grid-cols-3")}>
            {shouldShowInitializeButton ? (
              <AlertDialog open={initDialogOpen} onOpenChange={setInitDialogOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 w-full rounded-xl text-xs shadow-none"
                    disabled={bootstrapping || busy || !connectionId}
                  >
                    {bootstrapping ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        正在初始化…
                      </>
                    ) : (
                      <>
                        <Settings2 className="size-4" />
                        初始化远端
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>需要初始化以下远端项目</AlertDialogTitle>
                    <AlertDialogDescription>
                      {remoteState?.missingItems.length ? remoteState.missingItems.join("、") : "将执行远端初始化。"}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setInitDialogOpen(false)
                        onInitialize({ connectionId })
                      }}
                    >
                      开始初始化
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              hasScriptActions ? null : <div className="hidden sm:block" />
            )}
            {hasScriptActions ? (
              <>
                {npmScripts.map((item) => {
                  const running = busy && npmScript === item.value
                  return (
                    <Button
                      key={item.value}
                      type="button"
                      variant={item.value === npmScript && running ? "default" : "outline"}
                      className="h-10 w-full rounded-xl text-sm shadow-none"
                      disabled={busy || bootstrapping || !connectionId}
                      onClick={() => executeScriptAction(item)}
                    >
                      {running ? (
                        <>
                          <LoaderCircle className="size-4 animate-spin" />
                          正在执行…
                        </>
                      ) : (
                        <>
                          <Rocket className="size-4" />
                          {item.label}
                        </>
                      )}
                    </Button>
                  )
                })}
              </>
            ) : (
              <Button
                type="button"
                className="h-9 w-full rounded-xl text-xs"
                disabled={busy || bootstrapping || !connectionId}
                onClick={() =>
                  onDeploy({
                    connectionId,
                    strategy,
                    remoteParentPath: remoteParent.trim() || undefined,
                  })
                }
              >
                {busy ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    正在部署代码…
                  </>
                ) : (
                  <>
                    <Rocket className="size-4" />
                    部署代码
                  </>
                )}
              </Button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl text-xs shadow-none"
              disabled={!connectionId || runningBackup || busy || bootstrapping}
              onClick={() => void runManualBackup()}
            >
              {runningBackup ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  备份中…
                </>
              ) : (
                <>
                  <Archive className="size-4" />
                  立即备份
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl text-xs shadow-none"
              disabled={!connectionId || stoppingService || !remoteDetails?.service.configured}
              onClick={() => void stopRemoteService()}
            >
              {stoppingService ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  停止中…
                </>
              ) : (
                <>
                  <CircleStop className="size-4" />
                  停止项目
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl text-xs shadow-none"
              disabled={!connectionId || connections.filter((item) => item.id !== connectionId).length === 0}
              onClick={() => setMigrateOpen(true)}
            >
              <ArrowRightLeft className="size-4" />
              一键迁移
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>浏览远端部署目录</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="rounded-lg"
                disabled={!browserDetails || browserDetails.currentPath === browserDetails.remoteAppDir || browserLoading}
                onClick={() => void openBrowserParent()}
              >
                返回上级
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-lg"
                disabled={browserLoading || !browserPath}
                onClick={() => void openRemoteBrowser(browserPath)}
              >
                {browserLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
              <div className="min-w-0 flex-1 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 font-mono text-xs">
                {browserDetails?.currentPath ?? browserPath ?? effectiveRemoteAppDir}
              </div>
            </div>

            <div className="max-h-[420px] overflow-auto rounded-lg border border-border/70">
              {browserLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  正在读取远端目录…
                </div>
              ) : browserDetails?.files.length ? (
                <div className="divide-y divide-border/60">
                  {browserDetails.files.map((entry) => (
                    <div key={entry.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 justify-start px-0 py-0 text-left"
                        disabled={entry.type !== "directory"}
                        onClick={() => void openRemoteBrowser(entry.path)}
                      >
                        <FolderOpen className={cn("mr-2 size-4 shrink-0", entry.type !== "directory" && "opacity-40")} />
                        <span className="truncate font-mono text-xs">{entry.name}</span>
                      </Button>
                      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                        {entry.type === "directory" ? "目录" : formatFileSize(entry.size)}
                      </span>
                      <span className="w-36 shrink-0 text-right text-[11px] text-muted-foreground">
                        {entry.modifiedAt ?? "-"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">当前目录为空或尚未部署。</div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBrowserOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>项目操作日志</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <Input
            className="h-9 rounded-lg text-sm"
            placeholder="搜索日志内容，例如 failed、backup、nginx、端口号"
            value={logQuery}
            onChange={(event) => setLogQuery(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {[
              { key: "all", label: "全部" },
              { key: "init", label: "初始化" },
              { key: "deploy", label: "部署" },
              { key: "backup", label: "备份" },
              { key: "error", label: "错误" },
            ].map((item) => (
              <Button
                key={item.key}
                type="button"
                variant="outline"
                className={cn(
                  "h-8 rounded-full px-3 text-[11px] shadow-none",
                  logFilter === item.key && "border-primary/40 bg-primary/[0.06] text-foreground",
                )}
                onClick={() => setLogFilter(item.key as ProjectLogFilter)}
              >
                {item.label}
                <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {logFilterCounts[item.key as ProjectLogFilter]}
                </span>
              </Button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-xl border border-border/70 bg-muted/[0.04]">
            {filteredLogs.length ? (
              <div className="divide-y divide-border/60">
                {filteredLogs.slice().reverse().map((entry) => {
                  const summary = summarizeProjectLog(entry)
                  const raw = entry.chunk.replace(/\r/g, "").trim()
                  return (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className={cn("text-xs font-medium", summary?.tone ?? "text-foreground")}>
                          {summary?.title ?? (entry.stream === "stderr" ? "错误输出" : "日志")}
                        </p>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {new Date(entry.at).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-muted-foreground">
                        {raw || entry.chunk}
                      </p>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {fullLogs?.length ? "当前筛选条件下没有日志" : "暂无项目日志"}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLogsOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={remoteInfoOpen} onOpenChange={setRemoteInfoOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>远端概览</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={remoteDetails?.service.active ? "default" : "secondary"} className="h-5 rounded-md px-2 font-normal shadow-none">
                  <Server className="mr-1 size-3.5" />
                  {remoteRuntimeHint}
                </Badge>
                {remoteDetails?.site.mode === "domain" ? (
                  <Badge variant="secondary" className="h-5 rounded-md px-2 font-normal shadow-none">
                    <Globe className="mr-1 size-3.5" />
                    域名访问
                  </Badge>
                ) : remoteDetails?.site.mode === "port" ? (
                  <Badge variant="secondary" className="h-5 rounded-md px-2 font-normal shadow-none">
                    <ExternalLink className="mr-1 size-3.5" />
                    端口预览
                  </Badge>
                ) : null}
                {remoteDetails?.site.sslEnabled ? (
                  <Badge className="h-5 rounded-md border-emerald-500/30 bg-emerald-500/10 px-2 font-normal text-emerald-700 shadow-none dark:text-emerald-200">
                    <ShieldCheck className="mr-1 size-3.5" />
                    HTTPS
                  </Badge>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                className="h-8 rounded-lg px-2.5 text-xs text-muted-foreground"
                disabled={remoteDetailsLoading || !connectionId}
                onClick={() => void refreshRemoteDetails()}
              >
                {remoteDetailsLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新状态
              </Button>
            </div>

            <div className={cn("grid gap-3", remoteDetails?.publicUrl ? "md:grid-cols-2" : "md:grid-cols-1")}>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">部署位置</Label>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start rounded-xl border border-border/60 bg-background px-3 py-2.5 font-mono text-[11px] shadow-none"
                  disabled={!effectiveRemoteAppDir || !connectionId}
                  onClick={() => void openRemoteBrowser(effectiveRemoteAppDir ?? undefined)}
                >
                  <FolderOpen className="size-4 shrink-0" />
                  <span className="truncate text-left">{effectiveRemoteAppDir}</span>
                </Button>
              </div>

              {remoteDetails?.publicUrl ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">访问入口</Label>
                  <div className="rounded-xl border border-border/60 bg-background px-3 py-2.5 text-[11px]">
                    <button type="button" className="break-all text-left text-sky-600 hover:underline" onClick={() => window.open(remoteDetails.publicUrl!, "_blank")}>
                      {remoteDetails.publicUrl}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-8 rounded-lg px-2.5 text-xs shadow-none"
                disabled={!connectionId}
                onClick={() => setSiteSettingsOpen(true)}
              >
                <Settings2 className="size-4" />
                设置站点
              </Button>
              <Button type="button" variant="outline" className="h-8 rounded-lg px-2.5 text-xs shadow-none" disabled={!remoteDetails?.service.configured || !connectionId} onClick={() => void restartRemoteService()}>
                <Server className="size-4" />
                重启服务
              </Button>
            </div>

            {remoteDetails ? (
              <div className="grid gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-[11px] md:grid-cols-3">
                <p className="truncate text-muted-foreground">服务 <span className="ml-1 text-foreground">{remoteDetails.service.unit ?? "未配置"}</span></p>
                <p className="text-muted-foreground">端口 <span className="ml-1 text-foreground">{remoteDetails.appPort ?? "未知"}</span></p>
                <p className="text-muted-foreground">域名 <span className="ml-1 text-foreground">{remoteDetails.site.domain ?? "未配置"}</span></p>
                <p className="text-muted-foreground">nginx <span className="ml-1 text-foreground">{remoteDetails.site.nginxInstalled ? "已安装" : "未安装"}</span></p>
                <p className="text-muted-foreground">certbot <span className="ml-1 text-foreground">{remoteDetails.site.certbotInstalled ? "已安装" : "未安装"}</span></p>
                <p className="text-muted-foreground">SSL <span className="ml-1 text-foreground">{remoteDetails.site.sslEnabled ? "已启用" : "未启用"}</span></p>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={siteSettingsOpen} onOpenChange={setSiteSettingsOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>站点设置</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {remoteDetails ? (
              <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/[0.08] p-3 text-[12px] text-muted-foreground md:grid-cols-3">
                <p>当前域名：{remoteDetails.site.domain ?? "未配置"}</p>
                <p>
                  当前 SSL：
                  {remoteDetails.site.sslMode === "custom"
                    ? "自定义证书"
                    : remoteDetails.site.sslMode === "letsencrypt"
                      ? "Let's Encrypt"
                      : remoteDetails.site.sslEnabled
                        ? "已启用"
                        : "未启用"}
                </p>
                <p>
                  自定义证书：
                  {remoteDetails.site.customCertificateConfigured ? "已配置" : "未配置"}
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">域名</Label>
                <Input
                  className="h-9 rounded-lg text-sm"
                  placeholder="例如 app.example.com；留空则使用随机端口预览"
                  value={siteDomain}
                  onChange={(event) => setSiteDomain(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">SSL 邮箱（可选）</Label>
                <Input
                  className="h-9 rounded-lg text-sm"
                  placeholder="用于 Let’s Encrypt 申请证书"
                  value={sslEmail}
                  onChange={(event) => setSslEmail(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">自定义证书（可选）</Label>
                <Textarea
                  className="min-h-[180px] rounded-lg font-mono text-[11px]"
                  placeholder="粘贴 PEM 证书；如使用 Cloudflare Origin Certificate 可填这里"
                  value={certificatePem}
                  onChange={(event) => setCertificatePem(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">自定义私钥（可选）</Label>
                <Textarea
                  className="min-h-[180px] rounded-lg font-mono text-[11px]"
                  placeholder="粘贴 PEM 私钥；与左侧证书成对使用"
                  value={privateKeyPem}
                  onChange={(event) => setPrivateKeyPem(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              这里不会回显服务器上已保存的私钥明文。若当前已配置自定义证书，上方会显示状态；需要替换时再粘贴新的证书和私钥。
            </p>
            <p className="text-[11px] text-muted-foreground">
              不填写域名时会自动分配随机预览端口。填写域名后会切换到域名访问；若同时提供证书和私钥，则优先使用自定义证书。
            </p>

            {siteError ? <p className="text-sm text-destructive">{siteError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSiteSettingsOpen(false)} disabled={siteSaving}>
              关闭
            </Button>
            <Button type="button" onClick={() => void saveSiteSettings()} disabled={siteSaving || !connectionId}>
              {siteSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Globe className="size-4" />}
              保存站点配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={migrateOpen} onOpenChange={setMigrateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>一键迁移项目</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-muted/[0.08] p-3 text-[12px] text-muted-foreground">
              迁移会先在目标服务器检查并补装部署依赖，然后完整复制当前项目目录、systemd 服务配置、站点入口与证书内容。迁移完成后会停用原服务器上的服务和入口，避免旧实例继续对外可用。
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">当前服务器</Label>
                <div className="rounded-xl border border-border/60 bg-background px-3 py-2.5 text-sm text-foreground">
                  {connectionLabel(connections, connectionId) || "未选择"}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">迁移目标</Label>
                <Select value={migrationTargetId} onValueChange={setMigrationTargetId}>
                  <SelectTrigger className="h-10 rounded-xl text-sm shadow-none">
                    <SelectValue placeholder="选择目标服务器" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections
                      .filter((item) => item.id !== connectionId)
                      .map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2 rounded-xl border border-border/60 bg-background p-3 text-[11px] text-muted-foreground">
              <p>
                远端目录
                <span className="ml-1 font-mono text-foreground">{effectiveRemoteAppDir ?? "未配置"}</span>
              </p>
              <p>
                服务
                <span className="ml-1 text-foreground">{remoteDetails?.service.unit ?? deployProfile?.defaultRemoteService ?? "未配置"}</span>
              </p>
              <p>
                当前备份计划
                <span className="ml-1 text-foreground">{backupScheduleLabel(backupSchedule?.schedule)}</span>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={migrating} onClick={() => setMigrateOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={!connectionId || !migrationTargetId || migrationTargetId === connectionId || migrating}
              onClick={() => void runMigration()}
            >
              {migrating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />}
              开始迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ProjectManagementPanel({
  connections,
  selectedConnectionId,
  highlightedProjectId,
  onOpenRemoteDirectory,
}: ProjectManagementPanelProps) {
  const {
    projects,
    operationLogs,
    isLoading,
    isImporting,
    isDeploying,
    deployingProjectId,
    isInitializing,
    initializingProjectId,
    error,
    info,
    loadProjects,
    importFromPicker,
    deleteProject,
    initializeProject,
    deployProject,
    appendDeployLog,
    appendOperationLog,
    loadOperationLogs,
    clearFeedback,
  } = useProjectStore()
  const [actionHintsByProject, setActionHintsByProject] = useState<Record<string, ProjectActionHint[]>>({})
  const [backupScheduleByProject, setBackupScheduleByProject] = useState<Record<string, ProjectBackupScheduleState>>({})
  const [statusFilter, setStatusFilter] = useState<"all" | "attention" | "failed" | "linked">("all")
  const fullLogsByProject = useMemo(() => {
    const map: Record<string, ProjectOperationLogEntry[]> = {}
    for (const entry of operationLogs) {
      const current = map[entry.projectId] ?? []
      current.push(entry)
      map[entry.projectId] = current
    }
    return map
  }, [operationLogs])
  const recentLogsByProject = useMemo(() => {
    const map: Record<string, ProjectOperationLogEntry[]> = {}
    for (const entry of operationLogs) {
      const current = map[entry.projectId] ?? []
      current.push(entry)
      map[entry.projectId] = current.slice(-8)
    }
    return map
  }, [operationLogs])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const unsubscribe = getDesktopApi().projects.onDeployLog((event) => {
      appendDeployLog(event.projectId, event.chunk)
      appendOperationLog({
        id: `${event.projectId}-${event.at}-${Math.random().toString(36).slice(2, 7)}`,
        projectId: event.projectId,
        stream: event.stream,
        chunk: event.chunk,
        at: event.at,
      })
    })
    return unsubscribe
  }, [appendDeployLog, appendOperationLog])

  useEffect(() => {
    void loadOperationLogs(400)
  }, [loadOperationLogs])

  useEffect(() => {
    if (projects.length === 0) {
      setActionHintsByProject({})
      setBackupScheduleByProject({})
      return
    }
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          const [hints, backup] = await Promise.all([
            getDesktopApi().projects.getProjectActionHints(project.id),
            getDesktopApi().projects.getProjectBackupSchedule(project.id),
          ])
          return {
            id: project.id,
            hints: hints.hints,
            backup,
          }
        }),
      ).catch(() => [])
      if (cancelled) {
        return
      }
      const nextHints: Record<string, ProjectActionHint[]> = {}
      const nextBackup: Record<string, ProjectBackupScheduleState> = {}
      for (const entry of entries) {
        nextHints[entry.id] = entry.hints
        nextBackup[entry.id] = entry.backup
      }
      setActionHintsByProject(nextHints)
      setBackupScheduleByProject(nextBackup)
    })()
    return () => {
      cancelled = true
    }
  }, [projects, deployingProjectId])

  useEffect(() => {
    if (info) {
      toast({
        title: "操作完成",
        description: info,
      })
      clearFeedback()
      return
    }
    if (error) {
      toast({
        variant: "destructive",
        title: "操作失败",
        description: error,
      })
      clearFeedback()
      return
    }
  }, [info, error, clearFeedback])

  useEffect(() => {
    if (!highlightedProjectId) {
      return
    }
    const target = window.document.getElementById(`project-card-${highlightedProjectId}`)
    if (!target) {
      return
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [highlightedProjectId, projects])

  const refreshProjectMeta = async () => {
    const latestProjects = await getDesktopApi().projects.listProjects()
    await loadOperationLogs(400)
    const entries = await Promise.all(
      latestProjects.map(async (project) => {
        const [hints, backup] = await Promise.all([
          getDesktopApi().projects.getProjectActionHints(project.id),
          getDesktopApi().projects.getProjectBackupSchedule(project.id),
        ])
        return {
          id: project.id,
          hints: hints.hints,
          backup,
        }
      }),
    ).catch(() => [])
    const nextHints: Record<string, ProjectActionHint[]> = {}
    const nextBackup: Record<string, ProjectBackupScheduleState> = {}
    for (const entry of entries) {
      nextHints[entry.id] = entry.hints
      nextBackup[entry.id] = entry.backup
    }
    useProjectStore.setState({ projects: latestProjects })
    setActionHintsByProject(nextHints)
    setBackupScheduleByProject(nextBackup)
  }

  const sorted = useMemo(() => {
    const copy = [...projects]
    copy.sort((a, b) => {
      if (a.lastDeployStatus === "success" && b.lastDeployStatus !== "success") {
        return -1
      }
      if (b.lastDeployStatus === "success" && a.lastDeployStatus !== "success") {
        return 1
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
    return copy
  }, [projects])
  const filteredProjects = useMemo(() => {
    return sorted.filter((project) => {
      if (statusFilter === "failed") {
        return project.lastDeployStatus === "failed"
      }
      if (statusFilter === "linked") {
        return Boolean(selectedConnectionId && project.lastConnectionId === selectedConnectionId)
      }
      if (statusFilter === "attention") {
        const hints = actionHintsByProject[project.id] ?? []
        return (
          project.lastDeployStatus === "failed" ||
          hints.some((item) => item.needsAttention)
        )
      }
      return true
    })
  }, [actionHintsByProject, selectedConnectionId, sorted, statusFilter])
  const summary = useMemo(
    () => ({
      total: projects.length,
      success: projects.filter((item) => item.lastDeployStatus === "success").length,
      failed: projects.filter((item) => item.lastDeployStatus === "failed").length,
      linked: projects.filter((item) => item.lastConnectionId === selectedConnectionId).length,
      attention: projects.filter((project) => {
        const hints = actionHintsByProject[project.id] ?? []
        return project.lastDeployStatus === "failed" || hints.some((item) => item.needsAttention)
      }).length,
    }),
    [actionHintsByProject, projects, selectedConnectionId],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight text-foreground">项目管理</h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {summary.total} 个项目
            </span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              { key: "all", label: "全部", count: summary.total },
              { key: "attention", label: "需关注", count: summary.attention },
              { key: "failed", label: "失败", count: summary.failed },
              ...(selectedConnectionId ? [{ key: "linked", label: "当前服务器", count: summary.linked }] : []),
            ].map((item) => (
              <Button
                key={item.key}
                type="button"
                variant="outline"
                className={cn(
                  "h-8 rounded-full px-3 text-[11px] shadow-none",
                  statusFilter === item.key
                    ? "border-primary/40 bg-primary/[0.06] text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setStatusFilter(item.key as typeof statusFilter)}
              >
                {item.label}
                <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {item.count}
                </span>
              </Button>
            ))}
          </div>
        </div>
        <Button
          type="button"
          className="shrink-0 rounded-lg"
          onClick={() => void importFromPicker()}
          disabled={isImporting}
        >
          {isImporting ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              选择中…
            </>
          ) : (
            <>
              <FolderInput className="size-4" />
              导入本地项目
            </>
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 py-20">
          <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">加载项目列表…</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/10 px-8 py-16 text-center">
          <p className="text-base font-medium text-foreground">还没有登记任何本地项目</p>
          <p className="max-w-md text-sm text-muted-foreground">点击「导入本地项目」选择仓库根目录。</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/10 px-8 py-16 text-center">
          <p className="text-base font-medium text-foreground">当前筛选下没有项目</p>
          <p className="max-w-md text-sm text-muted-foreground">切换上方筛选即可查看其他项目。</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredProjects.map((project: LocalProjectRecord) => (
            <ProjectDeployCard
              key={project.id}
              project={project}
              connections={connections}
              selectedConnectionId={selectedConnectionId}
              highlighted={project.id === highlightedProjectId}
              isDeploying={isDeploying}
              deployingProjectId={deployingProjectId}
              isInitializing={isInitializing}
              initializingProjectId={initializingProjectId}
              onInitialize={(args) => {
                void initializeProject({
                  projectId: project.id,
                  connectionId: args.connectionId,
                })
              }}
              onDeploy={(args) => {
                void deployProject({
                  projectId: project.id,
                  connectionId: args.connectionId,
                  strategy: args.strategy,
                  remoteParentPath: args.remoteParentPath,
                  npmScript: args.npmScript,
                })
              }}
              onDelete={() => void deleteProject(project.id)}
              actionHints={actionHintsByProject[project.id]}
              backupSchedule={backupScheduleByProject[project.id]}
              recentLogs={recentLogsByProject[project.id]}
              fullLogs={fullLogsByProject[project.id]}
              onProjectStateRefresh={refreshProjectMeta}
              onOpenRemoteDirectory={onOpenRemoteDirectory}
            />
          ))}
        </div>
      )}
    </div>
  )
}
