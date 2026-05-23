import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  ArrowRightLeft,
  Blocks,
  Check,
  CircleStop,
  ExternalLink,
  FileText,
  FolderInput,
  FolderOpen,
  Globe,
  HelpCircle,
  LoaderCircle,
  Plus,
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
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { getDesktopApi } from "@/lib/desktop-api"
import { useProjectStore } from "@/store/project-store"
import { toast } from "@/hooks/use-toast"
import type {
  DigwisProjectConfig,
  ProjectClientTarget,
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
  ProjectScaffoldDatabase,
  ProjectScaffoldProgressEvent,
  ProjectScaffoldInput,
  ProjectScaffoldTemplate,
  ProjectRuntimeModule,
  ProjectServiceModule,
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

type ActiveScaffoldState = ProjectScaffoldProgressEvent & {
  lines: string[]
}

const scaffoldTemplateOptions: Array<{ value: ProjectScaffoldTemplate; label: string; detail: string }> = [
  {
    value: "next-core",
    label: "Next Core",
    detail: "只生成 Next 主应用、共享包占位和面板项目协议。",
  },
  {
    value: "next-payload",
    label: "Next + Payload",
    detail: "声明 Payload 作为 CMS 契约，并保留后续补全 collections/admin 的位置。",
  },
  {
    value: "next-directus",
    label: "Next + Directus",
    detail: "声明 Directus 作为外部 CMS 服务，并为服务目录与协议留位。",
  },
]

const scaffoldDatabaseOptions: Array<{ value: ProjectScaffoldDatabase; label: string; detail: string }> = [
  {
    value: "postgresql",
    label: "PostgreSQL",
    detail: "默认主库选择，适合多项目与多服务共享。",
  },
  {
    value: "sqlite",
    label: "SQLite",
    detail: "适合本地实验或单机轻量项目，不建议作为平台默认值。",
  },
]

const runtimeModuleOptions: Array<{ value: ProjectRuntimeModule; label: string; detail: string }> = [
  { value: "auth", label: "Auth", detail: "统一登录、会话和权限入口。" },
  { value: "dashboard", label: "Dashboard", detail: "保留控制台/运营后台骨架。" },
  { value: "docs", label: "Docs", detail: "预留文档与帮助中心模块。" },
  { value: "blog", label: "Blog", detail: "预留文章与内容列表模块。" },
  { value: "i18n", label: "i18n", detail: "预留多语言路由与文案管理。" },
  { value: "search", label: "Search", detail: "预留站内搜索与索引能力。" },
  { value: "queue", label: "Queue", detail: "为异步任务和后台处理留位。" },
  { value: "payments", label: "Payments", detail: "预留支付与账单模块。" },
  { value: "multi-tenant", label: "Multi-tenant", detail: "预留站点/租户隔离能力。" },
]

const lightRuntimeModuleOptions = runtimeModuleOptions.filter((option) =>
  ["docs", "dashboard", "blog", "i18n"].includes(option.value),
)

const serviceModuleOptions: Array<{ value: ProjectServiceModule; label: string; detail: string }> = [
  { value: "python-ai", label: "Python AI", detail: "FastAPI worker，适合 AI 推理与编排。" },
  { value: "python-data", label: "Python Data", detail: "FastAPI worker，适合数据分析与报表。" },
  { value: "go-worker", label: "Go Worker", detail: "高并发或常驻 worker 的占位服务。" },
  { value: "rust-worker", label: "Rust Worker", detail: "极致性能或本地核心模块的占位服务。" },
]

const clientTargetOptions: Array<{ value: ProjectClientTarget; label: string; detail: string }> = [
  { value: "electron", label: "Electron Desktop", detail: "生成桌面客户端骨架，可与 Web 共享核心模块与接口。" },
  { value: "ios-native", label: "Native iOS", detail: "生成 SwiftUI 原生 iOS 目录骨架，适合作为苹果客户端起点。" },
  { value: "android-native", label: "Native Android", detail: "生成 Kotlin 原生 Android 目录骨架，适合作为安卓客户端起点。" },
]

function toProjectSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function joinProjectPath(parentPath: string, slug: string) {
  const base = parentPath.trim().replace(/[\\/]+$/, "")
  if (!base) {
    return slug.trim()
  }
  if (!slug.trim()) {
    return base
  }
  return `${base}/${slug.trim()}`
}

async function checkUrlReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  return getDesktopApi().projects.checkProjectUrlReachable(url)
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

function connectionLabel(connections: VpsConnectionRecord[], id?: string | null) {
  if (!id) {
    return ""
  }
  return connections.find((c) => c.id === id)?.name ?? ""
}

function clientTargetBadgeLabel(target: ProjectClientTarget) {
  if (target === "electron") return "Electron"
  if (target === "ios-native") return "iOS"
  return "Android"
}

function clientAppSummary(config: DigwisProjectConfig | null) {
  if (!config) {
    return []
  }
  const items: Array<{ key: string; target: ProjectClientTarget; label: string; path: string; command?: string }> = []
  if (config.apps.desktop) {
    items.push({
      key: "desktop",
      target: "electron",
      label: "Electron",
      path: config.apps.desktop.path,
      command: config.apps.desktop.devCommand,
    })
  }
  if (config.apps.mobileIos) {
    items.push({
      key: "mobile-ios",
      target: "ios-native",
      label: "iOS",
      path: config.apps.mobileIos.path,
      command: config.apps.mobileIos.devCommand,
    })
  }
  if (config.apps.mobileAndroid) {
    items.push({
      key: "mobile-android",
      target: "android-native",
      label: "Android",
      path: config.apps.mobileAndroid.path,
      command: config.apps.mobileAndroid.devCommand,
    })
  }
  return items
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

function scaffoldStatusTone(status: ActiveScaffoldState["status"]) {
  if (status === "success") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
  }
  if (status === "warning") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
  }
  if (status === "error") {
    return "border-destructive/30 bg-destructive/10 text-destructive"
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200"
}

function scaffoldStageLabel(stage: ActiveScaffoldState["stage"]) {
  if (stage === "prepare") return "准备目录"
  if (stage === "template") return "写入模板"
  if (stage === "register") return "加入面板"
  if (stage === "install") return "安装依赖"
  if (stage === "start") return "启动预览"
  if (stage === "admin") return "启动后台"
  if (stage === "done") return "创建完成"
  if (stage === "failed") return "创建失败"
  return stage
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
  fullLogs,
  scaffoldProgress,
  onAppendOperationLog,
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
  onDelete: (options: { removeLocalDirectory: boolean }) => void
  actionHints?: ProjectActionHint[]
  backupSchedule?: ProjectBackupScheduleState
  fullLogs?: ProjectOperationLogEntry[]
  scaffoldProgress?: ActiveScaffoldState
  onAppendOperationLog: (entry: ProjectOperationLogEntry) => void
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
  const [manageOpen, setManageOpen] = useState(false)
  const [modulesOpen, setModulesOpen] = useState(false)
  const [remoteInfoOpen, setRemoteInfoOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logFilter, setLogFilter] = useState<ProjectLogFilter>("all")
  const [logQuery, setLogQuery] = useState("")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [removeLocalDirectory, setRemoveLocalDirectory] = useState(false)
  const [stoppingService, setStoppingService] = useState(false)
  const [runningBackup, setRunningBackup] = useState(false)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrationTargetId, setMigrationTargetId] = useState("")
  const [relinkingLocalPath, setRelinkingLocalPath] = useState(false)
  const [openingPreview, setOpeningPreview] = useState(false)
  const [openingAdmin, setOpeningAdmin] = useState(false)
  const [startingLocalDev, setStartingLocalDev] = useState(false)
  const [autoFixingLocal, setAutoFixingLocal] = useState(false)
  const [projectConfig, setProjectConfig] = useState<DigwisProjectConfig | null>(null)
  const [moduleDraft, setModuleDraft] = useState<ProjectRuntimeModule[]>([])
  const [loadingModules, setLoadingModules] = useState(false)
  const [savingModules, setSavingModules] = useState(false)
  const [previewUrl, setPreviewUrl] = useState("http://localhost:3000")
  const [adminUrl, setAdminUrl] = useState("http://localhost:3000/admin")
  const [previewAlive, setPreviewAlive] = useState(false)
  const [adminAlive, setAdminAlive] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const hasProjectContract = projectConfig != null
  const clientApps = useMemo(() => clientAppSummary(projectConfig), [projectConfig])
  const projectClientTargets = projectConfig?.clientTargets ?? []
  const [openingClientTarget, setOpeningClientTarget] = useState<ProjectClientTarget | null>(null)
  const [startingClientTarget, setStartingClientTarget] = useState<ProjectClientTarget | null>(null)
  const [openingClientIdeTarget, setOpeningClientIdeTarget] = useState<ProjectClientTarget | null>(null)
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
    let cancelled = false
    void getDesktopApi()
      .projects.getProjectConfig(project.id)
      .then((config) => {
        if (cancelled) {
          return
        }
        setProjectConfig(config)
        setModuleDraft(config?.runtimeModules ?? [])
      })
      .catch(() => {
        if (!cancelled) {
          setProjectConfig(null)
          setModuleDraft([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [project.id, scaffoldProgress?.at])

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
  const boundConnectionLabel = connectionLabel(connections, connectionId || project.lastConnectionId) || "未关联服务器"
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
  const actionSummary = latestActionLog ? summarizeProjectLog(latestActionLog) : null
  const primaryScriptAction = useMemo(() => {
    if (!npmScripts.length) {
      return undefined
    }
    return (
      npmScripts.find((item) => item.action === "code") ??
      npmScripts.find((item) => item.action === "data") ??
      npmScripts[0]
    )
  }, [npmScripts])
  const secondaryScriptActions = useMemo(
    () =>
      npmScripts.filter((item) => item.value !== primaryScriptAction?.value).map((item) => ({
        ...item,
        shortLabel:
          item.action === "data"
            ? "同步数据库"
            : item.action === "uploads"
              ? "同步文件"
              : item.label,
      })),
    [npmScripts, primaryScriptAction],
  )
  const remoteAccessLabel = remoteDetails?.publicUrl ?? (remoteDetails?.site.domain ? `https://${remoteDetails.site.domain}` : "未配置")
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

  const relinkLocalProjectPath = async () => {
    setRelinkingLocalPath(true)
    try {
      const picked = await getDesktopApi().projects.pickProjectDirectory()
      if (!picked) {
        return
      }
      await getDesktopApi().projects.updateProjectLocalPath({
        projectId: project.id,
        localPath: picked,
      })
      await onProjectStateRefresh()
      toast({
        title: `${project.displayName} 已重新匹配`,
        description: "本地项目目录已更新。",
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 重新匹配失败`,
        description: error instanceof Error ? error.message : "无法更新本地项目目录",
      })
    } finally {
      setRelinkingLocalPath(false)
    }
  }

  const openRuntimeModulesDialog = async () => {
    setModulesOpen(true)
    setLoadingModules(true)
    try {
      const config = await getDesktopApi().projects.getProjectConfig(project.id)
      if (!config) {
        toast({
          title: `${project.displayName} 还未接入面板项目协议`,
          description: "当前目录里没有 digwis-project.json，暂时不能从这里管理运行时模块。",
        })
        setModulesOpen(false)
        setProjectConfig(null)
        setModuleDraft([])
        return
      }
      setProjectConfig(config)
      setModuleDraft(config?.runtimeModules ?? [])
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 模块读取失败`,
        description: error instanceof Error ? error.message : "无法读取项目模块配置",
      })
      setModulesOpen(false)
    } finally {
      setLoadingModules(false)
    }
  }

  const toggleLightModuleDraft = (moduleId: ProjectRuntimeModule, enabled: boolean) => {
    setModuleDraft((current) => {
      const base = current.filter((item) => item !== moduleId)
      return enabled ? [...base, moduleId] : base
    })
  }

  const saveRuntimeModules = async () => {
    if (!projectConfig) {
      return
    }
    const preservedModules = projectConfig.runtimeModules.filter(
      (moduleId) => !lightRuntimeModuleOptions.some((option) => option.value === moduleId),
    )
    const nextRuntimeModules = [...new Set([...preservedModules, ...moduleDraft])]
    setSavingModules(true)
    try {
      const result = await getDesktopApi().projects.setProjectRuntimeModules({
        projectId: project.id,
        runtimeModules: nextRuntimeModules,
      })
      setProjectConfig(result.contract)
      setModuleDraft(result.contract.runtimeModules)
      setModulesOpen(false)
      toast({
        title: `${project.displayName} 模块已更新`,
        description:
          result.warnings[0]
          ?? result.message,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 模块更新失败`,
        description: error instanceof Error ? error.message : "无法保存模块配置",
      })
    } finally {
      setSavingModules(false)
    }
  }

  const refreshLocalHealth = async () => {
    setHealthChecking(true)
    try {
      const preview = await getDesktopApi().projects.getProjectLocalPreview(project.id)
      const nextPreview = preview.url
      const nextAdmin = preview.adminUrl ?? `${preview.url.replace(/\/$/, "")}/admin`
      setPreviewUrl(nextPreview)
      setAdminUrl(nextAdmin)
      const [previewOk, adminOk] = await Promise.all([
        checkUrlReachable(nextPreview),
        checkUrlReachable(nextAdmin),
      ])
      setPreviewAlive(previewOk.ok)
      setAdminAlive(adminOk.ok)
    } finally {
      setHealthChecking(false)
    }
  }

  const openLocalPreview = async () => {
    setOpeningPreview(true)
    try {
      const preview = await getDesktopApi().projects.openProjectLocalPreview(project.id)
      setPreviewUrl(preview.url)
      if (preview.adminUrl) {
        setAdminUrl(preview.adminUrl)
      }
      toast({
        title: `${project.displayName} 预览已打开`,
        description: preview.url,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 预览打开失败`,
        description: error instanceof Error ? error.message : "无法打开本地预览",
      })
    } finally {
      setOpeningPreview(false)
    }
  }

  const openLocalAdmin = async () => {
    setOpeningAdmin(true)
    try {
      const preview = await getDesktopApi().projects.openProjectLocalAdmin(project.id)
      const url = preview.adminUrl ?? `${preview.url.replace(/\/$/, "")}/admin`
      setPreviewUrl(preview.url)
      setAdminUrl(url)
      toast({
        title: `${project.displayName} 管理端已打开`,
        description: url,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 管理端打开失败`,
        description: error instanceof Error ? error.message : "无法打开本地管理端",
      })
    } finally {
      setOpeningAdmin(false)
    }
  }

  const startLocalDev = async () => {
    setStartingLocalDev(true)
    try {
      const result = await getDesktopApi().projects.startProjectLocalDev(project.id)
      toast({
        title: `${project.displayName} 已启动本地开发服务`,
        description: `${result.previewUrl}${result.pid ? ` (pid ${result.pid})` : ""}`,
      })
      setTimeout(() => {
        void refreshLocalHealth()
      }, 2500)
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 启动失败`,
        description: error instanceof Error ? error.message : "无法启动本地开发服务",
      })
    } finally {
      setStartingLocalDev(false)
    }
  }

  const autoFixLocalAccess = async () => {
    setAutoFixingLocal(true)
    const appendLocalLog = async (stream: "stdout" | "stderr" | "system", chunk: string) => {
      const entry = await getDesktopApi().projects.appendProjectOperationLog({
        projectId: project.id,
        stream,
        chunk,
      })
      onAppendOperationLog(entry)
    }
    try {
      const result = await getDesktopApi().projects.startProjectLocalDev(project.id)
      setPreviewUrl(result.previewUrl)
      const previewMeta = await getDesktopApi().projects.getProjectLocalPreview(project.id)
      const expectedAdmin = previewMeta.adminUrl ?? `${previewMeta.url.replace(/\/$/, "")}/admin`
      const shouldWaitForAdmin = expectedAdmin.includes(":8055")
      await appendLocalLog(
        "system",
        `[local-fix] start preview=${result.previewUrl} admin=${expectedAdmin} waitForAdmin=${shouldWaitForAdmin}\n`,
      )
      if (shouldWaitForAdmin) {
        await getDesktopApi().projects.startProjectLocalAdminService(project.id)
      }
      const startedAt = Date.now()
      let ok = false
      let lastPreviewDetail = "not checked"
      let lastAdminDetail = "not checked"
      while (Date.now() - startedAt < 45_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const preview = await getDesktopApi().projects.getProjectLocalPreview(project.id)
        const nextPreview = preview.url
        const nextAdmin = preview.adminUrl ?? `${preview.url.replace(/\/$/, "")}/admin`
        setPreviewUrl(nextPreview)
        setAdminUrl(nextAdmin)
        const previewResult = await checkUrlReachable(nextPreview)
        lastPreviewDetail = `${nextPreview} (${previewResult.detail})`
        setPreviewAlive(previewResult.ok)
        if (previewResult.ok) {
          const adminResult = await checkUrlReachable(nextAdmin)
          lastAdminDetail = `${nextAdmin} (${adminResult.detail})`
          setAdminAlive(adminResult.ok)
          if (!shouldWaitForAdmin || adminResult.ok) {
            ok = true
            break
          }
        }
      }
      if (ok) {
        await appendLocalLog(
          "system",
          shouldWaitForAdmin
            ? `[local-fix] success preview=${result.previewUrl} admin=${expectedAdmin}\n`
            : `[local-fix] success preview=${result.previewUrl}\n`,
        )
        toast({
          title: `${project.displayName} 自动修复完成`,
          description: shouldWaitForAdmin ? `预览与管理端均可访问：${result.previewUrl}` : `本地预览已可访问：${result.previewUrl}`,
        })
      } else {
        await appendLocalLog(
          "stderr",
          shouldWaitForAdmin
            ? `[local-fix] failed preview=${lastPreviewDetail}; admin=${lastAdminDetail}\n`
            : `[local-fix] failed preview=${lastPreviewDetail}\n`,
        )
        toast({
          variant: "destructive",
          title: `${project.displayName} 自动修复未完成`,
          description: shouldWaitForAdmin
            ? `45 秒内未同时可达。预览：${lastPreviewDetail}；管理端：${lastAdminDetail}`
            : `45 秒内未检测到预览可达。${lastPreviewDetail}`,
        })
      }
    } catch (error) {
      await appendLocalLog(
        "stderr",
        `[local-fix] error ${error instanceof Error ? error.message : "unknown error"}\n`,
      ).catch(() => undefined)
      toast({
        variant: "destructive",
        title: `${project.displayName} 自动修复失败`,
        description: error instanceof Error ? error.message : "无法自动修复本地访问",
      })
    } finally {
      setAutoFixingLocal(false)
    }
  }

  const openClientAppPath = async (target: ProjectClientTarget) => {
    setOpeningClientTarget(target)
    try {
      const result = await getDesktopApi().projects.openProjectClientAppPath({
        projectId: project.id,
        target,
      })
      toast({
        title: `${project.displayName} 已打开客户端目录`,
        description: result.path,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 目录打开失败`,
        description: error instanceof Error ? error.message : "无法打开客户端目录",
      })
    } finally {
      setOpeningClientTarget(null)
    }
  }

  const startClientApp = async (target: ProjectClientTarget) => {
    setStartingClientTarget(target)
    try {
      const result = await getDesktopApi().projects.startProjectClientApp({
        projectId: project.id,
        target,
      })
      toast({
        title: `${project.displayName} 客户端已启动`,
        description: `${result.path}${result.pid ? ` (pid ${result.pid})` : ""}`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 启动失败`,
        description: error instanceof Error ? error.message : "无法启动客户端",
      })
    } finally {
      setStartingClientTarget(null)
    }
  }

  const openClientAppIde = async (target: ProjectClientTarget) => {
    setOpeningClientIdeTarget(target)
    try {
      const result = await getDesktopApi().projects.openProjectClientAppIde({
        projectId: project.id,
        target,
      })
      toast({
        title: `${project.displayName} 已在 ${result.application} 中打开`,
        description: result.path,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} IDE 打开失败`,
        description: error instanceof Error ? error.message : "无法打开客户端 IDE",
      })
    } finally {
      setOpeningClientIdeTarget(null)
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

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) {
        return
      }
      await refreshLocalHealth()
    }
    void run()
    const timer = window.setInterval(() => {
      void run()
    }, 12000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [project.id])

  return (
    <>
      <Card
        id={`project-card-${project.id}`}
        className={cn(
          "overflow-visible rounded-3xl border border-border/70 bg-background shadow-sm transition dark:border-white/10 dark:bg-white/[0.02]",
          success && "border-emerald-500/30",
          highlighted && "border-primary/40 ring-2 ring-primary/20",
        )}
      >
        <CardHeader className="space-y-0 px-6 py-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground dark:bg-white/10">
                <Blocks className="size-5" />
              </div>
              <CardTitle className="mt-7 truncate text-[2rem] font-semibold leading-tight tracking-tight">{project.displayName}</CardTitle>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-3">
              {(needsAttention || remoteDetails?.service.active || success) ? (
                <span className="inline-flex items-center">
                  <span
                    className={cn(
                      "inline-block size-2 rounded-full",
                      needsAttention
                        ? "bg-amber-500"
                        : remoteDetails?.service.active
                          ? "bg-emerald-500"
                          : "bg-border",
                    )}
                  />
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/70 hover:text-foreground dark:hover:bg-white/[0.06]"
                onClick={() => setManageOpen(true)}
              >
                <Settings2 className="size-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-6 pb-6 pt-0">
          <div className="flex min-h-[180px] flex-col">
            <div className="mt-auto space-y-4">
              {scaffoldProgress ? (
                <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">创建进度：{scaffoldStageLabel(scaffoldProgress.stage)}</p>
                      <p className="truncate text-xs text-muted-foreground">{scaffoldProgress.message}</p>
                    </div>
                    <Badge className={cn("shrink-0 border", scaffoldStatusTone(scaffoldProgress.status))}>
                      {scaffoldProgress.percent}%
                    </Badge>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/70 dark:bg-white/10">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        scaffoldProgress.status === "error"
                          ? "bg-destructive"
                          : scaffoldProgress.status === "warning"
                            ? "bg-amber-500"
                            : scaffoldProgress.status === "success"
                              ? "bg-emerald-500"
                              : "bg-sky-500",
                      )}
                      style={{ width: `${Math.max(6, Math.min(scaffoldProgress.percent, 100))}%` }}
                    />
                  </div>
                  {scaffoldProgress.detail ? (
                    <p className="mt-3 text-xs text-muted-foreground">{scaffoldProgress.detail}</p>
                  ) : null}
                  {scaffoldProgress.lines.length > 0 ? (
                    <div className="mt-3 rounded-xl bg-background/80 px-3 py-2 dark:bg-black/20">
                      {scaffoldProgress.lines.slice(-3).map((line, index) => (
                        <p key={`${scaffoldProgress.at}-${index}`} className="truncate text-[11px] text-muted-foreground">
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="rounded-2xl bg-muted/20 px-4 py-3 dark:bg-white/[0.03]">
                <p className="truncate text-sm text-muted-foreground">{nextAction.detail}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 w-full rounded-2xl text-sm shadow-none"
                  disabled={startingLocalDev}
                  onClick={() => void startLocalDev()}
                >
                  {startingLocalDev ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      启动中…
                    </>
                  ) : (
                    <>
                      <Server className="size-4" />
                      启动本地开发
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 w-full rounded-2xl text-sm shadow-none"
                  disabled={openingPreview}
                  onClick={() => void openLocalPreview()}
                >
                  {openingPreview ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      打开中…
                    </>
                  ) : (
                    <>
                      <ExternalLink className="size-4" />
                      本地预览
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 w-full rounded-2xl text-sm shadow-none"
                  disabled={openingAdmin}
                  onClick={() => void openLocalAdmin()}
                >
                  {openingAdmin ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      打开中…
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="size-4" />
                      CMS/Admin
                    </>
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-1",
                    previewAlive
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-border/70 bg-muted/40 text-muted-foreground",
                  )}
                >
                  本地预览：{previewAlive ? "可达" : healthChecking ? "检查中" : "未启动"}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-1",
                    adminAlive
                      ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                      : "border-border/70 bg-muted/40 text-muted-foreground",
                  )}
                >
                  CMS/Admin：{adminAlive ? "可达" : healthChecking ? "检查中" : "未启动"}
                </span>
                <span className="truncate text-muted-foreground">{previewUrl}</span>
                {!previewAlive ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-7 rounded-xl px-2 text-[11px] shadow-none"
                    disabled={autoFixingLocal || startingLocalDev}
                    onClick={() => void autoFixLocalAccess()}
                  >
                    {autoFixingLocal ? (
                      <>
                        <LoaderCircle className="size-3 animate-spin" />
                        自动修复中…
                      </>
                    ) : (
                      "自动修复"
                    )}
                  </Button>
                ) : null}
              </div>
              <div className={cn("grid gap-2", hasScriptActions ? "sm:grid-cols-1" : "sm:grid-cols-1")}>
                {hasScriptActions && primaryScriptAction ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full rounded-2xl text-sm shadow-none"
                    disabled={busy || bootstrapping || !connectionId}
                    onClick={() => executeScriptAction(primaryScriptAction)}
                  >
                    {busy && npmScript === primaryScriptAction.value ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        正在执行…
                      </>
                    ) : (
                      <>
                        <Rocket className="size-4" />
                        {primaryScriptAction.label}
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full rounded-2xl text-sm shadow-none"
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
              {hasScriptActions && secondaryScriptActions.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {secondaryScriptActions.slice(0, 2).map((item) => {
                    const running = busy && npmScript === item.value
                    return (
                      <Button
                        key={item.value}
                        type="button"
                        variant="outline"
                        className="h-9 w-full rounded-2xl text-sm shadow-none"
                        disabled={busy || bootstrapping || !connectionId}
                        onClick={() => executeScriptAction(item)}
                      >
                        {running ? (
                          <>
                            <LoaderCircle className="size-4 animate-spin" />
                            正在执行…
                          </>
                        ) : (
                          item.shortLabel
                        )}
                      </Button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-4xl rounded-3xl border-border/80 bg-card p-0">
          <DialogHeader className="border-b border-border/70 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 text-left">
                <DialogTitle className="text-2xl">{project.displayName}</DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground">{boundConnectionLabel}</DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-2xl px-3 text-xs shadow-none"
                  title={hasProjectContract ? "管理运行时模块" : "当前项目尚未接入 digwis-project.json"}
                  onClick={() => void openRuntimeModulesDialog()}
                >
                  <Blocks className="size-4" />
                  模块
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-2xl px-3 text-xs shadow-none"
                  disabled={!connectionId || connections.filter((item) => item.id !== connectionId).length === 0}
                  onClick={() => setMigrateOpen(true)}
                >
                  <ArrowRightLeft className="size-4" />
                  迁移
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-2xl px-3 text-xs shadow-none"
                  disabled={!connectionId}
                  onClick={() => setRemoteInfoOpen(true)}
                >
                  <HelpCircle className="size-4" />
                  远端概览
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-4 px-6 py-5">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-border/60 bg-muted/[0.08] px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-foreground">本地</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{hasScriptActions ? "脚本部署" : "目录同步"}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-xl px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      disabled={relinkingLocalPath || busy || bootstrapping}
                      onClick={() => void relinkLocalProjectPath()}
                    >
                      {relinkingLocalPath ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="size-3.5" />
                      )}
                      重新匹配
                    </Button>
                  </div>
                </div>
                <div className="mt-4 space-y-3 text-[11px] text-muted-foreground">
                  <p className="truncate text-sm text-foreground">{project.localPath}</p>
                  <div className="flex flex-wrap gap-2">
                    {(projectConfig?.runtimeModules ?? []).map((moduleId) => (
                      <Badge key={moduleId} variant="secondary" className="h-5 rounded-md px-2 font-normal shadow-none">
                        {runtimeModuleOptions.find((option) => option.value === moduleId)?.label ?? moduleId}
                      </Badge>
                    ))}
                    {!hasProjectContract ? (
                      <span className="text-[11px] text-muted-foreground">
                        未接入 Digwis 项目协议，当前只保留基础部署信息
                      </span>
                    ) : projectConfig?.runtimeModules?.length ? null : (
                      <span className="text-[11px] text-muted-foreground">尚未声明运行时模块</span>
                    )}
                  </div>
                  {hasProjectContract ? (
                    <div className="space-y-2">
                      <p>客户端</p>
                      {projectClientTargets.length ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            {projectClientTargets.map((target) => (
                              <Badge key={target} variant="outline" className="h-5 rounded-md px-2 font-normal shadow-none">
                                {clientTargetBadgeLabel(target)}
                              </Badge>
                            ))}
                          </div>
                          <div className="space-y-2">
                            {clientApps.map((app) => (
                              <div
                                key={app.key}
                                className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm text-foreground">{app.label}</span>
                                  <span className="truncate font-mono text-[11px] text-muted-foreground">{app.path}</span>
                                </div>
                                {app.command ? (
                                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{app.command}</p>
                                ) : (
                                  <p className="mt-1 text-[11px] text-muted-foreground">当前提供目录骨架，启动流程需在对应原生工程中继续完成。</p>
                                )}
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {app.target === "ios-native" || app.target === "android-native" ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="h-7 rounded-xl px-2 text-[11px] shadow-none"
                                      disabled={openingClientIdeTarget === app.target}
                                      onClick={() => void openClientAppIde(app.target)}
                                    >
                                      {openingClientIdeTarget === app.target ? (
                                        <>
                                          <LoaderCircle className="size-3 animate-spin" />
                                          打开中…
                                        </>
                                      ) : (
                                        <>
                                          <ExternalLink className="size-3" />
                                          打开 IDE
                                        </>
                                      )}
                                    </Button>
                                  ) : null}
                                  {app.command ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="h-7 rounded-xl px-2 text-[11px] shadow-none"
                                      disabled={startingClientTarget === app.target}
                                      onClick={() => void startClientApp(app.target)}
                                    >
                                      {startingClientTarget === app.target ? (
                                        <>
                                          <LoaderCircle className="size-3 animate-spin" />
                                          启动中…
                                        </>
                                      ) : (
                                        <>
                                          <Server className="size-3" />
                                          启动
                                        </>
                                      )}
                                    </Button>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="h-7 rounded-xl px-2 text-[11px] shadow-none"
                                    disabled={openingClientTarget === app.target}
                                    onClick={() => void openClientAppPath(app.target)}
                                  >
                                    {openingClientTarget === app.target ? (
                                      <>
                                        <LoaderCircle className="size-3 animate-spin" />
                                        打开中…
                                      </>
                                    ) : (
                                      <>
                                        <FolderOpen className="size-3" />
                                        打开目录
                                      </>
                                    )}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">当前项目仅生成 Web 端。</span>
                      )}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <p>
                      代码
                      <span className="ml-2 text-sm text-foreground">{formatActionSummary(hintByAction.get("code"))}</span>
                    </p>
                    <p>
                      备份
                      <span className="ml-2 text-sm text-foreground">{backupScheduleLabel(backupSchedule?.schedule)}</span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-border/60 bg-muted/[0.08] px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-foreground">远端</p>
                  <span className="text-[11px] text-muted-foreground">{remoteRuntimeHint}</span>
                </div>
                <div className="mt-4 space-y-3 text-[11px] text-muted-foreground">
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <p>
                      服务器
                      <span className="ml-2 text-sm text-foreground">{boundConnectionLabel}</span>
                    </p>
                    <p>
                      部署
                      <span className="ml-2 text-sm text-foreground">
                        {project.lastDeployAt ? new Date(project.lastDeployAt).toLocaleDateString() : "尚无记录"}
                      </span>
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p>目录</p>
                    {canOpenRemoteDirectory ? (
                      <button
                        type="button"
                        className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-sm text-foreground underline-offset-4 hover:text-primary hover:underline"
                        onClick={() =>
                          onOpenRemoteDirectory?.({
                            connectionId,
                            path: effectiveRemoteAppDir as string,
                            projectId: project.id,
                          })
                        }
                      >
                        <span className="truncate">{effectiveRemoteAppDir}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </button>
                    ) : (
                      <p className="mt-1 truncate text-sm text-foreground">{effectiveRemoteAppDir ?? "未配置"}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p>入口</p>
                    <p className="truncate text-sm text-foreground">{remoteAccessLabel}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-border/60 bg-background px-4 py-3 dark:border-white/10 dark:bg-white/[0.02]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{actionSummary?.title ?? nextAction.label}</p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {actionSummary?.detail ?? nextAction.detail}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-[10px] text-muted-foreground">
                    {latestActionLog
                      ? new Date(latestActionLog.at).toLocaleTimeString()
                      : latestInitLog
                        ? new Date(latestInitLog.at).toLocaleTimeString()
                        : "暂无"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-xl px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={!fullLogs?.length}
                    onClick={() => setLogsOpen(true)}
                  >
                    <FileText className="size-3.5" />
                    日志
                  </Button>
                </div>
              </div>
            </div>

            {hasScriptActions ? null : (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">远端目录</Label>
                <Input
                  className="h-10 rounded-2xl font-mono text-xs"
                  placeholder="例如 /var/www 或 ~/sites"
                  value={remoteParent}
                  onChange={(e) => setRemoteParent(e.target.value)}
                  disabled={busy || bootstrapping}
                />
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-1">
              {shouldShowInitializeButton ? (
                <AlertDialog open={initDialogOpen} onOpenChange={setInitDialogOpen}>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 w-full rounded-2xl text-xs shadow-none"
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
                <div className="hidden" />
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-2xl text-xs shadow-none"
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
                className="h-10 rounded-2xl text-xs shadow-none"
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
            </div>

            <div className="flex justify-end pt-1">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 rounded-xl px-2 text-xs text-destructive hover:bg-destructive/5 hover:text-destructive"
                    disabled={busy}
                  >
                    <Trash2 className="size-3.5" />
                    从面板移除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-3xl border-border/80 bg-card p-6 shadow-2xl">
                  <AlertDialogHeader className="space-y-3">
                    <AlertDialogTitle className="text-xl">从面板移除此项目？</AlertDialogTitle>
                    <AlertDialogDescription className="leading-6">
                      {removeLocalDirectory
                        ? <>将删除面板记录，并移除本地目录 <span className="font-medium text-foreground">{project.localPath}</span>。不会删除远端 VPS 上的目录和数据。请输入项目名 <span className="font-medium text-foreground">{project.displayName}</span> 以确认。</>
                        : <>默认只会删除当前面板里的项目记录，不会删除本地项目目录，也不会删除远端 VPS 上的目录和数据。请输入项目名 <span className="font-medium text-foreground">{project.displayName}</span> 以确认。</>}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Input
                    className="mt-1 h-10 rounded-2xl"
                    placeholder={`输入 ${project.displayName} 确认`}
                    value={deleteConfirmText}
                    onChange={(event) => setDeleteConfirmText(event.target.value)}
                  />
                  <label className="mt-3 flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/30 px-4 py-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-border"
                      checked={removeLocalDirectory}
                      onChange={(event) => setRemoveLocalDirectory(event.target.checked)}
                    />
                    <span>
                      <span className="block font-medium text-foreground">同时删除本地项目文件夹</span>
                      <span className="mt-1 block text-muted-foreground">
                        将一并移除 <span className="font-medium text-foreground">{project.localPath}</span> 整个目录。此操作不可撤销。
                      </span>
                    </span>
                  </label>
                  <AlertDialogFooter className="mt-2">
                    <AlertDialogCancel
                      className="rounded-2xl"
                      onClick={() => {
                        setDeleteConfirmText("")
                        setRemoveLocalDirectory(false)
                      }}
                    >
                      取消
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={deleteConfirmText.trim() !== project.displayName}
                      onClick={() => {
                        const nextRemoveLocalDirectory = removeLocalDirectory
                        setDeleteConfirmText("")
                        setRemoveLocalDirectory(false)
                        onDelete({ removeLocalDirectory: nextRemoveLocalDirectory })
                      }}
                    >
                      {removeLocalDirectory ? "确认移除并删目录" : "确认移除"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modulesOpen} onOpenChange={setModulesOpen}>
        <DialogContent className="max-w-2xl rounded-3xl">
          <DialogHeader>
            <DialogTitle>扩展运行时模块</DialogTitle>
            <DialogDescription>
              这一步只管理轻模块：`Docs / Dashboard / Blog / i18n`。关闭时保留文件，但会从项目契约中停用对应路由。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {loadingModules ? (
              <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取当前模块配置…
              </div>
            ) : (
              lightRuntimeModuleOptions.map((option) => {
                const checked = moduleDraft.includes(option.value)
                return (
                  <label
                    key={option.value}
                    className="flex items-start justify-between gap-4 rounded-2xl border border-border/70 bg-muted/20 px-4 py-4"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">{option.label}</p>
                      <p className="text-xs text-muted-foreground">{option.detail}</p>
                    </div>
                    <Switch
                      checked={checked}
                      disabled={savingModules}
                      onCheckedChange={(enabled) => toggleLightModuleDraft(option.value, enabled)}
                    />
                  </label>
                )
              })
            )}
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-[11px] text-muted-foreground">
            新启用的模块会补齐占位页面与运行时配置；已存在的自定义文件不会被重写。
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={savingModules} onClick={() => setModulesOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={loadingModules || savingModules} onClick={() => void saveRuntimeModules()}>
              {savingModules ? <LoaderCircle className="size-4 animate-spin" /> : <Blocks className="size-4" />}
              保存模块配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [creatingScaffold, setCreatingScaffold] = useState(false)
  const [scaffoldDisplayName, setScaffoldDisplayName] = useState("")
  const [scaffoldSlug, setScaffoldSlug] = useState("")
  const [scaffoldParentPath, setScaffoldParentPath] = useState("/Users/zhao/Documents/Projects")
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)
  const [scaffoldTemplate, setScaffoldTemplate] = useState<ProjectScaffoldTemplate>("next-core")
  const [scaffoldDatabase, setScaffoldDatabase] = useState<ProjectScaffoldDatabase>("postgresql")
  const [scaffoldClientTargets, setScaffoldClientTargets] = useState<ProjectClientTarget[]>([])
  const [scaffoldRuntimeModules, setScaffoldRuntimeModules] = useState<ProjectRuntimeModule[]>(["auth", "dashboard"])
  const [scaffoldServiceModules, setScaffoldServiceModules] = useState<ProjectServiceModule[]>([])
  const [useFullTemplatePull, setUseFullTemplatePull] = useState(false)
  const [activeScaffold, setActiveScaffold] = useState<ActiveScaffoldState | null>(null)
  const fullLogsByProject = useMemo(() => {
    const map: Record<string, ProjectOperationLogEntry[]> = {}
    for (const entry of operationLogs) {
      const current = map[entry.projectId] ?? []
      current.push(entry)
      map[entry.projectId] = current
    }
    return map
  }, [operationLogs])
  const scaffoldLocalPath = useMemo(
    () => joinProjectPath(scaffoldParentPath, scaffoldSlug),
    [scaffoldParentPath, scaffoldSlug],
  )

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const unsubscribe = getDesktopApi().projects.onScaffoldProgress((event) => {
      let shouldLoadProjects = false
      setActiveScaffold((current) => {
        if (event.projectId && current?.projectId !== event.projectId) {
          shouldLoadProjects = true
        }
        const baseLines =
          current && current.localPath === event.localPath
            ? current.lines
            : []
        const nextLine = [event.message, event.detail].filter(Boolean).join(" - ")
        const nextLines = nextLine ? [...baseLines, nextLine].slice(-8) : baseLines
        return {
          ...event,
          lines: nextLines,
        }
      })
      if (shouldLoadProjects) {
        void loadProjects()
      }
      if (event.stage === "done" || event.stage === "failed") {
        window.setTimeout(() => {
          setActiveScaffold((current) => {
            if (!current || current.localPath !== event.localPath) {
              return current
            }
            return event.stage === "done" && current.status !== "error" ? current : null
          })
        }, event.stage === "done" ? 20_000 : 0)
      }
    })
    return unsubscribe
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

  useEffect(() => {
    if (scaffoldTemplate === "next-payload" && useFullTemplatePull && scaffoldDatabase !== "postgresql") {
      setScaffoldDatabase("postgresql")
    }
  }, [scaffoldTemplate, useFullTemplatePull, scaffoldDatabase])

  const toggleClientTarget = (value: ProjectClientTarget) => {
    setScaffoldClientTargets((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }

  const toggleRuntimeModule = (value: ProjectRuntimeModule) => {
    setScaffoldRuntimeModules((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }

  const toggleServiceModule = (value: ProjectServiceModule) => {
    setScaffoldServiceModules((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }

  const openCreateDialog = () => {
    setScaffoldDisplayName("")
    setScaffoldSlug("")
    setScaffoldParentPath("/Users/zhao/Documents/Projects")
    setSlugManuallyEdited(false)
    setScaffoldTemplate("next-core")
    setScaffoldDatabase("postgresql")
    setScaffoldClientTargets([])
    setScaffoldRuntimeModules(["auth", "dashboard"])
    setScaffoldServiceModules([])
    setUseFullTemplatePull(false)
    setCreateDialogOpen(true)
  }

  const pickScaffoldDirectory = async () => {
    const picked = await getDesktopApi().projects.pickProjectDirectory()
    if (picked) {
      setScaffoldParentPath(picked)
    }
  }

  const createScaffold = async () => {
    const payload: ProjectScaffoldInput = {
      displayName: scaffoldDisplayName.trim(),
      slug: scaffoldSlug.trim(),
      localPath: scaffoldLocalPath.trim(),
      packageManager: "pnpm",
      monorepo: true,
      template: scaffoldTemplate,
      database: scaffoldDatabase,
      clientTargets: scaffoldClientTargets,
      runtimeModules: scaffoldRuntimeModules,
      serviceModules: scaffoldServiceModules,
      autoInstall: true,
      autoStart: true,
      fullTemplatePull: scaffoldTemplate === "next-payload" ? useFullTemplatePull : false,
    }
    setCreatingScaffold(true)
    setActiveScaffold({
      stage: "prepare",
      status: "running",
      percent: 1,
      message: "已提交创建任务",
      detail: "面板正在准备模板与安装流程。",
      localPath: payload.localPath,
      displayName: payload.displayName,
      at: new Date().toISOString(),
      lines: ["已提交创建任务"],
    })
    try {
      const result = await getDesktopApi().projects.createProjectScaffold(payload)
      await loadProjects()
      setActiveScaffold((current) =>
        current && current.localPath === result.localPath
          ? {
              ...current,
              stage: "done",
              status: result.warnings.length > 0 ? "warning" : "success",
              percent: 100,
              message: result.warnings.length > 0 ? "项目已创建，但仍有后续步骤" : "项目已创建完成",
              detail: result.warnings[0],
              projectId: result.project.id,
              at: new Date().toISOString(),
            }
          : current,
      )
      const previewHint = result.bootstrap?.startOk && result.bootstrap.previewUrl
        ? ` 已自动启动，可直接访问：${result.bootstrap.previewUrl}`
        : ""
      const directusAdminReady = result.bootstrap?.healthChecks.some(
        (item) => item.name === "directus-admin" && item.ok,
      )
      const adminHint = directusAdminReady && result.contract.panel.adminUrl
        ? ` Directus 管理端：${result.contract.panel.adminUrl}`
        : ""
      toast({
        title: "项目骨架已生成",
        description:
          result.warnings[0] ??
          `${result.project.displayName} 已加入项目列表。Next.js 主应用目录：${result.contract.apps.web.path === "." ? result.localPath : `${result.localPath}/${result.contract.apps.web.path}`}.${previewHint}${adminHint}`,
      })
      setCreateDialogOpen(false)
    } catch (error) {
      setActiveScaffold((current) =>
        current
          ? {
              ...current,
              stage: "failed",
              status: "error",
              percent: 100,
              message: "项目创建失败",
              detail: error instanceof Error ? error.message : "创建失败",
              at: new Date().toISOString(),
              lines: [...current.lines, error instanceof Error ? error.message : "创建失败"].slice(-8),
            }
          : current,
      )
      toast({
        variant: "destructive",
        title: "无法生成项目骨架",
        description: error instanceof Error ? error.message : "创建失败",
      })
    } finally {
      setCreatingScaffold(false)
    }
  }

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
  const visibleProjects = useMemo(() => {
    if (!selectedConnectionId) {
      return sorted
    }
    return sorted.filter(
      (project) => !project.lastConnectionId || project.lastConnectionId === selectedConnectionId,
    )
  }, [selectedConnectionId, sorted])
  const visibleScaffoldCard = activeScaffold && !activeScaffold.projectId ? activeScaffold : null
  const createDisabled =
    creatingScaffold || !scaffoldDisplayName.trim() || !scaffoldSlug.trim() || !scaffoldParentPath.trim()
  const missingFields: string[] = []
  if (!scaffoldDisplayName.trim()) {
    missingFields.push("项目名")
  }
  if (!scaffoldSlug.trim()) {
    missingFields.push("slug")
  }
  if (!scaffoldParentPath.trim()) {
    missingFields.push("父目录")
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>创建平台项目</DialogTitle>
            <DialogDescription>
              生成一个以 Next.js 为中心、可挂接 Electron、iOS、Android 与 Python/Go/Rust 服务的项目骨架，并自动加入当前面板。默认 Web 应用会放在
              <code className="mx-1">apps/web</code>。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="scaffold-display-name">项目名</Label>
                <Input
                  id="scaffold-display-name"
                  value={scaffoldDisplayName}
                  onChange={(event) => {
                    const nextName = event.target.value
                    setScaffoldDisplayName(nextName)
                    const nextSlug = toProjectSlug(nextName)
                    if (!slugManuallyEdited) {
                      setScaffoldSlug(nextSlug)
                    }
                  }}
                  placeholder="Digwis Platform"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="scaffold-slug">slug</Label>
                <Input
                  id="scaffold-slug"
                  value={scaffoldSlug}
                  onChange={(event) => {
                    const nextSlug = toProjectSlug(event.target.value)
                    setSlugManuallyEdited(true)
                    setScaffoldSlug(nextSlug)
                  }}
                  placeholder="digwis-platform"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="scaffold-parent-path">父目录</Label>
              <div className="flex gap-2">
                <Input
                  id="scaffold-parent-path"
                  value={scaffoldParentPath}
                  onChange={(event) => {
                    setScaffoldParentPath(event.target.value)
                  }}
                  placeholder="/Users/zhao/Documents/Projects"
                />
                <Button type="button" variant="outline" onClick={() => void pickScaffoldDirectory()}>
                  <FolderOpen className="size-4" />
                  选择目录
                </Button>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <p>创建时会自动在这个父目录下新建项目文件夹。</p>
                <p>
                  最终目录：
                  <span className="ml-1 font-mono text-foreground">{scaffoldLocalPath || "请输入项目名"}</span>
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>模板</Label>
                <div className="grid gap-2">
                  {scaffoldTemplateOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setScaffoldTemplate(option.value)
                        if (option.value === "next-payload") {
                          setUseFullTemplatePull(true)
                        } else {
                          setUseFullTemplatePull(false)
                        }
                      }}
                      className={cn(
                        "flex items-start justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                        scaffoldTemplate === option.value
                          ? "border-sky-500 bg-sky-500/10"
                          : "border-border/70 bg-muted/20 hover:bg-muted/40",
                      )}
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{option.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{option.detail}</p>
                      </div>
                      {scaffoldTemplate === option.value ? <Check className="mt-0.5 size-4 text-sky-400" /> : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <Label>数据库</Label>
                <div className="grid gap-2">
                  {scaffoldDatabaseOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setScaffoldDatabase(option.value)}
                      className={cn(
                        "flex items-start justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                        scaffoldDatabase === option.value
                          ? "border-sky-500 bg-sky-500/10"
                          : "border-border/70 bg-muted/20 hover:bg-muted/40",
                      )}
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{option.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{option.detail}</p>
                      </div>
                      {scaffoldDatabase === option.value ? <Check className="mt-0.5 size-4 text-sky-400" /> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {scaffoldTemplate === "next-payload" || scaffoldTemplate === "next-directus" ? (
              <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={useFullTemplatePull}
                    onChange={(event) => setUseFullTemplatePull(event.target.checked)}
                  />
                  <span className="text-sm text-foreground">
                    {scaffoldTemplate === "next-payload"
                      ? "拉取 Payload 官方 Website Template（最新、最完整、单体项目结构，推荐配合 PostgreSQL）"
                      : "生成 Directus 完整 sidecar（含 docker-compose，可直接启动）"}
                  </span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label>客户端目标</Label>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {clientTargetOptions.map((option) => {
                  const active = scaffoldClientTargets.includes(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleClientTarget(option.value)}
                      className={cn(
                        "rounded-lg border px-4 py-3 text-left transition-colors",
                        active ? "border-amber-500 bg-amber-500/10" : "border-border/70 bg-muted/20 hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">{option.label}</p>
                        {active ? <Check className="size-4 text-amber-400" /> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{option.detail}</p>
                    </button>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Web 端始终会生成；这里额外勾选的客户端会放到同一个 monorepo 下，共用后端与核心层。
              </p>
            </div>

            <div className="grid gap-2">
              <Label>运行时模块</Label>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {runtimeModuleOptions.map((option) => {
                  const active = scaffoldRuntimeModules.includes(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleRuntimeModule(option.value)}
                      className={cn(
                        "rounded-lg border px-4 py-3 text-left transition-colors",
                        active ? "border-emerald-500 bg-emerald-500/10" : "border-border/70 bg-muted/20 hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">{option.label}</p>
                        {active ? <Check className="size-4 text-emerald-400" /> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{option.detail}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>专项服务模块</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {serviceModuleOptions.map((option) => {
                  const active = scaffoldServiceModules.includes(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleServiceModule(option.value)}
                      className={cn(
                        "rounded-lg border px-4 py-3 text-left transition-colors",
                        active ? "border-violet-500 bg-violet-500/10" : "border-border/70 bg-muted/20 hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">{option.label}</p>
                        {active ? <Check className="size-4 text-violet-400" /> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{option.detail}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {creatingScaffold && activeScaffold ? (
              <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">正在{scaffoldStageLabel(activeScaffold.stage)}</p>
                    <p className="text-xs text-muted-foreground">{activeScaffold.message}</p>
                  </div>
                  <Badge className={cn("border", scaffoldStatusTone(activeScaffold.status))}>
                    {activeScaffold.percent}%
                  </Badge>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/70 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-all duration-500"
                    style={{ width: `${Math.max(6, Math.min(activeScaffold.percent, 100))}%` }}
                  />
                </div>
                {activeScaffold.detail ? (
                  <p className="mt-3 text-xs text-muted-foreground">{activeScaffold.detail}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            {createDisabled ? (
              <p className="mr-auto text-xs text-amber-600">
                还缺少必填项：{missingFields.join("、")}
              </p>
            ) : (
              <p className="mr-auto text-xs text-muted-foreground">配置已完整，可以直接生成项目。</p>
            )}
            <Button type="button" variant="outline" disabled={creatingScaffold} onClick={() => setCreateDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={createDisabled} onClick={() => void createScaffold()}>
              {creatingScaffold ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              生成项目
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          className="h-10 shrink-0 rounded-2xl bg-foreground px-4 text-background shadow-none hover:bg-foreground/90"
          onClick={openCreateDialog}
        >
          <Plus className="size-4" />
          创建平台项目
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 shrink-0 rounded-2xl border-border/80 bg-muted/30 text-foreground shadow-none hover:bg-muted/50 focus-visible:ring-border dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:focus-visible:ring-white/20"
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
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-border/70 bg-muted/[0.06] py-20 dark:border-white/10 dark:bg-white/[0.02]">
          <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">加载项目列表…</p>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border/70 bg-muted/[0.06] px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.02]">
          <p className="text-base font-medium text-foreground">
            {selectedConnectionId ? "当前服务器下还没有可管理的项目" : "还没有登记任何本地项目"}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {selectedConnectionId
              ? "这台服务器下还没有已绑定项目；未部署、未绑定服务器的本地项目仍会显示在这里。"
              : "可以先点「创建平台项目」生成新的 Next 中心骨架，也可以点「导入本地项目」接入现有仓库。"}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleScaffoldCard ? (
            <Card className="rounded-3xl border border-sky-500/30 bg-sky-500/5 shadow-sm dark:bg-sky-500/5">
              <CardHeader className="px-6 py-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="grid size-11 place-items-center rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
                      <LoaderCircle className="size-5 animate-spin" />
                    </div>
                    <CardTitle className="mt-7 truncate text-[2rem] font-semibold leading-tight tracking-tight">
                      {visibleScaffoldCard.displayName}
                    </CardTitle>
                  </div>
                  <Badge className={cn("border", scaffoldStatusTone(visibleScaffoldCard.status))}>
                    {visibleScaffoldCard.percent}%
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="px-6 pb-6 pt-0">
                <div className="space-y-4">
                  <div className="rounded-2xl border border-sky-500/20 bg-background/70 px-4 py-3 dark:bg-black/20">
                    <p className="text-sm font-medium text-foreground">
                      正在{scaffoldStageLabel(visibleScaffoldCard.stage)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{visibleScaffoldCard.message}</p>
                    {visibleScaffoldCard.detail ? (
                      <p className="mt-1 text-xs text-muted-foreground">{visibleScaffoldCard.detail}</p>
                    ) : null}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted/70 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-all duration-500"
                      style={{ width: `${Math.max(6, Math.min(visibleScaffoldCard.percent, 100))}%` }}
                    />
                  </div>
                  <div className="rounded-2xl bg-muted/20 px-4 py-3 dark:bg-white/[0.03]">
                    <p className="truncate text-xs text-muted-foreground">{visibleScaffoldCard.localPath}</p>
                  </div>
                  {visibleScaffoldCard.lines.length > 0 ? (
                    <div className="rounded-2xl bg-muted/20 px-4 py-3 dark:bg-white/[0.03]">
                      {visibleScaffoldCard.lines.slice(-4).map((line, index) => (
                        <p key={`${visibleScaffoldCard.at}-${index}`} className="truncate text-xs text-muted-foreground">
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
          {visibleProjects.map((project: LocalProjectRecord) => (
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
              onDelete={(options) =>
                void deleteProject({
                  projectId: project.id,
                  removeLocalDirectory: options.removeLocalDirectory,
                })}
              actionHints={actionHintsByProject[project.id]}
              backupSchedule={backupScheduleByProject[project.id]}
              fullLogs={fullLogsByProject[project.id]}
              scaffoldProgress={activeScaffold?.projectId === project.id ? activeScaffold : undefined}
              onAppendOperationLog={appendOperationLog}
              onProjectStateRefresh={refreshProjectMeta}
              onOpenRemoteDirectory={onOpenRemoteDirectory}
            />
          ))}
        </div>
      )}
    </div>
  )
}
