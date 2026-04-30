import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FolderOpen,
  FolderKanban,
  HardDriveDownload,
  LoaderCircle,
  PanelLeft,
  Plus,
  Search,
  Server,
  Settings,
  ShieldAlert,
  SquareArrowOutUpRight,
  SquarePen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
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
import { useVpsStore } from "@/store/vps-store"
import { AppSettingsPage } from "@/components/app-settings-page"
import { DependencyCards } from "@/components/dependency-cards"
import { InspectionTelemetryCards } from "@/components/inspection-telemetry-cards"
import { SystemUpgradePrompt } from "@/components/system-upgrade-prompt"
import { VpsConnectionDialog } from "@/components/vps-connection-dialog"
import { ProjectManagementPanel } from "@/components/project-management-panel"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { Toaster } from "@/components/ui/toaster"
import type {
  RemotePackageStatus,
  SystemUpgradeCheckResult,
  VpsConnectionInput,
  VpsConnectionRecord,
  VpsInspection,
} from "../../shared/vps"

type NavKey = "monitor" | "deps" | "projects" | "files" | "settings"

type AppLocation = {
  nav: NavKey
  highlightedProjectId?: string
  fileBrowserRequest?: {
    connectionId: string
    path: string
  }
}

const LAST_ACTIVE_NAV_KEY = "digwis:last-active-nav"
const SIDEBAR_COLLAPSED_KEY = "digwis:sidebar-collapsed"
const TELEMETRY_FRESH_MS = 20_000

const navItems: Array<{ key: NavKey; label: string; icon: typeof Server }> = [
  { key: "monitor", label: "主机概览", icon: Server },
  { key: "deps", label: "运行环境", icon: HardDriveDownload },
  { key: "projects", label: "项目部署", icon: FolderKanban },
  { key: "files", label: "文件管理", icon: FolderOpen },
]

function isNavKey(value: string): value is NavKey {
  return value === "settings" || navItems.some((item) => item.key === value)
}

function readLastActiveNav(): NavKey {
  try {
    const stored = window.localStorage.getItem(LAST_ACTIVE_NAV_KEY)
    return stored && isNavKey(stored) ? stored : "monitor"
  } catch {
    return "monitor"
  }
}

function writeLastActiveNav(nav: NavKey) {
  try {
    window.localStorage.setItem(LAST_ACTIVE_NAV_KEY, nav)
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  } catch {
    return false
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false")
  } catch {
    // Ignore storage errors in desktop renderer.
  }
}

function sidebarItemClass(active: boolean, collapsed: boolean) {
  return cn(
    "group flex w-full items-center overflow-hidden rounded-3xl text-left transition-all duration-300 ease-out",
    collapsed ? "h-11 justify-center px-0" : "h-11 gap-3 px-3.5",
    active
      ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60 dark:bg-white/[0.08] dark:shadow-none dark:ring-white/10"
      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground dark:hover:bg-white/[0.05]",
  )
}

function sidebarToolClass(collapsed: boolean) {
  return cn(
    "flex h-10 items-center rounded-2xl text-muted-foreground transition-all duration-300 ease-out hover:bg-muted/60 hover:text-foreground dark:hover:bg-white/[0.05]",
    collapsed ? "w-10 justify-center" : "gap-3 px-3",
  )
}

function upgradeStatusPresentation(
  status: SystemUpgradeCheckResult | undefined,
  checking: boolean,
): { title: string; detail?: string; tone: "muted" | "ok" | "warn" | "danger" } {
  if (checking) {
    return { title: "正在检测…", tone: "muted" }
  }
  if (!status) {
    return { title: "尚未检测", detail: "连接后会自动检测", tone: "muted" }
  }
  if (!status.supported) {
    if (status.reason === "no_apt") {
      return { title: "非 APT 环境", detail: "仅支持 Debian/Ubuntu 系 apt 检测", tone: "muted" }
    }
    if (status.reason === "exec_error") {
      return {
        title: "检测失败",
        detail: status.hint ? status.hint.slice(0, 120) : undefined,
        tone: "danger",
      }
    }
    return { title: "无法检测", tone: "muted" }
  }
  if (status.upgradableCount > 0) {
    return {
      title: `${status.upgradableCount} 个软件包可升级`,
      detail: status.indexRefreshed ? "已尝试刷新 apt 索引" : "索引可能未刷新，数量可能偏保守",
      tone: "warn",
    }
  }
  return {
    title: "已是最新版本",
    detail: status.indexRefreshed ? "apt 索引已刷新，无可升级项" : "基于当前缓存，无可升级项",
    tone: "ok",
  }
}

function daemonPackages(packages: RemotePackageStatus[]) {
  return packages.filter((pkg) => ["docker", "nginx", "postgresql", "pm2"].includes(pkg.id))
}

function buildMonitorAlerts(
  inspection: VpsInspection,
  upgradeStatus: SystemUpgradeCheckResult | undefined,
): Array<{ key: string; label: string; tone: "danger" | "warn" | "ok" }> {
  const alerts: Array<{ key: string; label: string; tone: "danger" | "warn" | "ok" }> = []
  const telemetry = inspection.telemetry
  if (telemetry) {
    if (telemetry.cpuPercent >= 85) {
      alerts.push({ key: "cpu", label: `CPU ${telemetry.cpuPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.memoryPercent >= 85) {
      alerts.push({ key: "memory", label: `内存 ${telemetry.memoryPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.diskPercent >= 90) {
      alerts.push({ key: "disk", label: `系统盘 ${telemetry.diskPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.loadPercent >= 75) {
      alerts.push({ key: "load", label: `负载 ${telemetry.loadPercent.toFixed(0)}%`, tone: "warn" })
    }
  }
  if (upgradeStatus?.supported && upgradeStatus.upgradableCount > 0) {
    alerts.push({
      key: "upgrade",
      label: `${upgradeStatus.upgradableCount} 个包可升级`,
      tone: upgradeStatus.upgradableCount >= 10 ? "danger" : "warn",
    })
  }
  for (const pkg of daemonPackages(inspection.packages)) {
    if (pkg.installed && pkg.running === false) {
      alerts.push({ key: `svc-${pkg.id}`, label: `${pkg.name} 未运行`, tone: "warn" })
    }
  }
  if (alerts.length === 0) {
    alerts.push({ key: "ok", label: "当前没有明显风险", tone: "ok" })
  }
  return alerts.slice(0, 4)
}

function inspectionFreshness(checkedAt: string, now: number) {
  const deltaMs = Math.max(0, now - new Date(checkedAt).getTime())
  const deltaSeconds = Math.round(deltaMs / 1000)
  const deltaMinutes = Math.round(deltaMs / 60_000)
  if (deltaMs <= TELEMETRY_FRESH_MS) {
    return {
      label: "监控数据刚同步",
      className: "bg-emerald-500/8 text-emerald-300",
      stale: false,
    }
  }
  if (deltaSeconds < 60) {
    return {
      label: `${deltaSeconds} 秒前采样`,
      className: "bg-[#34301f] text-amber-300",
      stale: true,
    }
  }
  if (deltaMinutes <= 5) {
    return {
      label: `${deltaMinutes} 分钟前采样`,
      className: "bg-[#34301f] text-amber-300",
      stale: true,
    }
  }
  return {
    label: `${deltaMinutes} 分钟前采样`,
    className: "bg-[#34301f] text-amber-300",
    stale: true,
  }
}

function sameLocation(left: AppLocation, right: AppLocation) {
  return (
    left.nav === right.nav &&
    left.highlightedProjectId === right.highlightedProjectId &&
    left.fileBrowserRequest?.connectionId === right.fileBrowserRequest?.connectionId &&
    left.fileBrowserRequest?.path === right.fileBrowserRequest?.path
  )
}

function metricValue(inspection: VpsInspection, label: string) {
  return inspection.metrics.find((metric) => metric.label === label)?.value ?? "unknown"
}

function summarizeUptime(uptime: string) {
  const normalized = uptime.toLowerCase()
  const valueOf = (unit: string) => {
    const match = normalized.match(new RegExp(`(\\d+)\\s+${unit}`))
    return match ? Number(match[1]) : 0
  }

  const years = valueOf("year")
  const months = valueOf("month")
  const weeks = valueOf("week")
  const days = valueOf("day")
  const hours = valueOf("hour")
  const totalMonths = years * 12 + months
  const totalDays = weeks * 7 + days

  if (totalMonths > 0) {
    return totalDays > 0 ? `已运行 ${totalMonths} 个月 ${totalDays} 天` : `已运行 ${totalMonths} 个月`
  }
  if (totalDays > 0) {
    return hours > 0 ? `已运行 ${totalDays} 天 ${hours} 小时` : `已运行 ${totalDays} 天`
  }
  if (hours > 0) {
    return `已运行 ${hours} 小时`
  }
  return "刚启动"
}

function simplifyOsLabel(os: string, kernel: string) {
  const normalizedOs = os
    .replace(/^Debian GNU\/Linux/i, "Debian")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const kernelVersion = kernel.split("+")[0]?.trim() || kernel.trim()
  const architecture = kernel.includes("amd64")
    ? "amd64"
    : kernel.includes("arm64")
      ? "arm64"
      : ""
  return [normalizedOs, `Kernel ${kernelVersion}`, architecture].filter(Boolean).join(" · ")
}

function shouldShowConnectionAlias(name: string | undefined, hostname: string) {
  if (!name) {
    return false
  }
  return name.trim().toLowerCase() !== hostname.trim().toLowerCase()
}

function formatConnectionMeta(connection: Pick<VpsConnectionRecord, "provider" | "locationLabel"> | undefined) {
  if (!connection) {
    return undefined
  }
  const parts = [connection.provider?.trim(), connection.locationLabel?.trim()].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

function expirationPresentation(expiresAt?: string) {
  if (!expiresAt) {
    return undefined
  }
  const target = new Date(`${expiresAt}T00:00:00`)
  const time = target.getTime()
  if (!Number.isFinite(time)) {
    return undefined
  }
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const diffDays = Math.ceil((time - startOfToday) / 86_400_000)
  if (diffDays < 0) {
    return {
      label: `已到期 ${Math.abs(diffDays)} 天`,
      tone: "danger" as const,
    }
  }
  if (diffDays === 0) {
    return {
      label: "今天到期",
      tone: "danger" as const,
    }
  }
  if (diffDays <= 7) {
    return {
      label: `还有 ${diffDays} 天到期`,
      tone: "danger" as const,
    }
  }
  if (diffDays <= 30) {
    return {
      label: `还有 ${diffDays} 天到期`,
      tone: "warn" as const,
    }
  }
  return {
    label: `还有 ${diffDays} 天到期`,
    tone: "ok" as const,
  }
}

export default function App() {
  const { projects, loadProjects, isLoading: isProjectsLoading } = useProjectStore()
  const {
    connections,
    selectedConnectionId,
    inspection,
    isLoading,
    isInspecting,
    info,
    error,
    upgradeStatusMap,
    isCheckingUpgrade,
    loadConnections,
    inspectConnection,
    installDependency,
    inspectDependencyUsage,
    uninstallDependency,
    dependencyServiceAction,
    isInstallingDependency,
    installingDependencyId,
    isDependencyServicePending,
    dependencyServicePendingKey,
    checkSystemUpgradesAfterInspect,
    checkAllConnectionsUpgrades,
    prewarmInspectionCache,
    reopenUpgradePrompt,
    deleteConnection,
    selectConnection,
  } = useVpsStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogPreset, setDialogPreset] = useState<Partial<VpsConnectionInput> | null>(null)
  const [activeNav, setActiveNav] = useState<NavKey>(() => readLastActiveNav())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [highlightedProjectId, setHighlightedProjectId] = useState<string>()
  const [fileBrowserRequest, setFileBrowserRequest] = useState<{ connectionId: string; path: string; token: number }>()
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [navHistoryState, setNavHistoryState] = useState<{
    entries: AppLocation[]
    index: number
  }>({
    entries: [{ nav: readLastActiveNav() }],
    index: 0,
  })

  useEffect(() => {
    void loadConnections().then(() => {
      void checkAllConnectionsUpgrades()
      void prewarmInspectionCache()
    })
  }, [loadConnections, checkAllConnectionsUpgrades, prewarmInspectionCache])

  useEffect(() => {
    if (connections.length <= 1) {
      return
    }
    const timer = window.setTimeout(() => {
      void prewarmInspectionCache()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [connections, prewarmInspectionCache, selectedConnectionId])

  useEffect(() => {
    writeLastActiveNav(activeNav)
  }, [activeNav])

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery("")
      return
    }
    if (projects.length === 0 && !isProjectsLoading) {
      void loadProjects()
    }
  }, [isProjectsLoading, loadProjects, projects.length, searchOpen])

  useEffect(() => {
    if (selectedConnectionId && projects.length === 0 && !isProjectsLoading) {
      void loadProjects()
    }
  }, [isProjectsLoading, loadProjects, projects.length, selectedConnectionId])

  const selectedConnection = connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId)
  const selectedConnectionListed = Boolean(
    selectedConnectionId && connections.some((item: VpsConnectionRecord) => item.id === selectedConnectionId),
  )
  const upgradeStatus = selectedConnection ? upgradeStatusMap[selectedConnection.id] : undefined
  const expirationStatus = expirationPresentation(selectedConnection?.expiresAt)
  const isCheckingUpdates = Boolean(
    selectedConnectionId &&
      inspection &&
      inspection.connectionId === selectedConnectionId &&
      isCheckingUpgrade,
  )
  const upgradePresentation = upgradeStatusPresentation(upgradeStatus, isCheckingUpdates)
  const trimmedSearch = searchQuery.trim()
  const serverResults = useMemo(
    () =>
      connections.map((connection) => ({
        id: connection.id,
        title: connection.name,
        subtitle: `${connection.username}@${connection.host}:${connection.port}`,
        keywords: [
          connection.name,
          connection.host,
          connection.username,
          String(connection.port),
          connection.source ?? "",
        ],
      })),
    [connections],
  )
  const projectResults = useMemo(
    () =>
      projects.map((project) => ({
        id: project.id,
        title: project.displayName,
        subtitle: project.localPath,
        remotePath: project.lastRemotePath ?? undefined,
        keywords: [
          project.displayName,
          project.localPath,
          project.lastRemotePath ?? "",
          project.lastConnectionId ?? "",
        ],
      })),
    [projects],
  )
  const hasSearchResults = serverResults.length > 0 || projectResults.length > 0

  // 只用「选中的 id + 是否已在列表中」作为依赖：inspect 结束后的 loadConnections 会替换
  // connections 里整条对象引用，若依赖 selectedConnection 对象会导致无限重新巡检。
  useEffect(() => {
    if (!selectedConnectionId || !selectedConnectionListed) {
      return
    }
    const conn = useVpsStore
      .getState()
      .connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId)
    if (!conn) {
      return
    }
    void inspectConnection(conn, { backgroundRefresh: true })
  }, [inspectConnection, selectedConnectionId, selectedConnectionListed])

  useEffect(() => {
    if (activeNav !== "monitor" || !selectedConnectionId || !selectedConnectionListed) {
      return
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || useVpsStore.getState().isInspecting) {
        return
      }
      const conn = useVpsStore
        .getState()
        .connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId)
      if (!conn) {
        return
      }
      void inspectConnection(conn, { forceRefresh: true })
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [activeNav, inspectConnection, selectedConnectionId, selectedConnectionListed])

  useEffect(() => {
    if (!selectedConnectionId || !inspection || isInspecting) {
      return
    }
    if (inspection.connectionId !== selectedConnectionId) {
      return
    }
    const conn = useVpsStore
      .getState()
      .connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId)
    if (!conn) {
      return
    }
    void checkSystemUpgradesAfterInspect(conn as VpsConnectionInput)
  }, [checkSystemUpgradesAfterInspect, inspection, isInspecting, selectedConnectionId])

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const openCreateDialog = (preset?: Partial<VpsConnectionInput>) => {
    setDialogPreset(preset ?? null)
    setDialogOpen(true)
  }

  const navigateTo = (location: AppLocation, options?: { recordHistory?: boolean }) => {
    setActiveNav(location.nav)
    setHighlightedProjectId(location.highlightedProjectId)
    if (location.fileBrowserRequest) {
      setFileBrowserRequest({
        ...location.fileBrowserRequest,
        token: Date.now(),
      })
    }
    if (options?.recordHistory === false) {
      return
    }
    setNavHistoryState((current) => {
      const activeLocation = current.entries[current.index] ?? current.entries[0]
      if (sameLocation(activeLocation, location)) {
        return current
      }
      const nextEntries = [...current.entries.slice(0, current.index + 1), location]
      return {
        entries: nextEntries.slice(-80),
        index: Math.min(nextEntries.length - 1, 79),
      }
    })
  }

  const canGoBack = navHistoryState.index > 0
  const canGoForward = navHistoryState.index < navHistoryState.entries.length - 1

  const moveHistory = (direction: "back" | "forward") => {
    const nextIndex = direction === "back" ? navHistoryState.index - 1 : navHistoryState.index + 1
    const target = navHistoryState.entries[nextIndex]
    if (!target) {
      return
    }
    setNavHistoryState((current) => ({ ...current, index: nextIndex }))
    navigateTo(target, { recordHistory: false })
  }

  const openServerFromSearch = (connectionId: string) => {
    selectConnection(connectionId)
    navigateTo({ nav: "monitor" })
    setSearchOpen(false)
    setSearchQuery("")
  }

  const openProjectFromSearch = (projectId: string) => {
    navigateTo({ nav: "projects", highlightedProjectId: projectId })
    setSearchOpen(false)
    setSearchQuery("")
  }

  const openRemoteDirectoryInBrowser = (payload: { connectionId: string; path: string; projectId: string }) => {
    if (connections.some((item: VpsConnectionRecord) => item.id === payload.connectionId)) {
      selectConnection(payload.connectionId)
    }
    navigateTo({
      nav: "files",
      highlightedProjectId: payload.projectId,
      fileBrowserRequest: {
        connectionId: payload.connectionId,
        path: payload.path,
      },
    })
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <Toaster />
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="搜索服务器、主机、项目路径…"
        />
        <CommandList>
          <CommandEmpty>
            {trimmedSearch ? "没有找到匹配的服务器或项目" : hasSearchResults ? "输入关键字开始筛选" : "还没有可搜索的服务器或项目"}
          </CommandEmpty>
          {serverResults.length > 0 ? (
            <CommandGroup heading="服务器">
              {serverResults.map((connection) => (
                <CommandItem
                  key={connection.id}
                  value={`${connection.title} ${connection.subtitle} ${connection.keywords.join(" ")}`}
                  keywords={connection.keywords}
                  onSelect={() => openServerFromSearch(connection.id)}
                >
                  <Server className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{connection.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{connection.subtitle}</div>
                  </div>
                  <CommandShortcut>服务器</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {serverResults.length > 0 && projectResults.length > 0 ? <CommandSeparator /> : null}
          {projectResults.length > 0 ? (
            <CommandGroup heading="项目">
              {projectResults.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.title} ${project.subtitle} ${project.remotePath ?? ""} ${project.keywords.join(" ")}`}
                  keywords={project.keywords}
                  onSelect={() => openProjectFromSearch(project.id)}
                >
                  <FolderKanban className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{project.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{project.subtitle}</div>
                    {project.remotePath ? <div className="truncate text-[11px] text-muted-foreground/80">{project.remotePath}</div> : null}
                  </div>
                  <CommandShortcut>项目</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
      <SystemUpgradePrompt connection={selectedConnection} />
      <VpsConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} preset={dialogPreset} />

      <div className="relative flex h-screen overflow-hidden">
        {activeNav === "settings" ? null : (
        <div className="pointer-events-none absolute left-[118px] top-3 z-30 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="pointer-events-auto size-11 rounded-2xl text-muted-foreground transition-all duration-300 hover:bg-background/45 hover:text-foreground"
            type="button"
            title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            <PanelLeft
              className={cn(
                "size-[22px] transition-transform duration-300",
                sidebarCollapsed && "rotate-180",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="pointer-events-auto size-10 rounded-xl text-muted-foreground/85 transition-all duration-300 hover:bg-background/45 hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35 dark:hover:bg-white/5"
            type="button"
            title="后退"
            disabled={!canGoBack}
            onClick={() => moveHistory("back")}
          >
            <ArrowLeft className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="pointer-events-auto size-10 rounded-xl text-muted-foreground/85 transition-all duration-300 hover:bg-background/45 hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35 dark:hover:bg-white/5"
            type="button"
            title="前进"
            disabled={!canGoForward}
            onClick={() => moveHistory("forward")}
          >
            <ArrowRight className="size-5" />
          </Button>
        </div>
        )}

        {/* Sidebar */}
        {activeNav === "settings" ? null : (
        <aside
          className={cn(
            "hidden h-screen min-h-0 shrink-0 flex-col border-r border-border/60 bg-sidebar/95 pb-5 pt-16 transition-[width,padding,opacity] duration-300 ease-out dark:border-white/10 lg:flex",
            sidebarCollapsed
              ? "w-0 overflow-hidden px-0 opacity-0"
              : "w-[288px] px-4 opacity-100",
          )}
        >
          <div className="mt-7 flex shrink-0 flex-col gap-1 px-1 transition-all duration-300">
            <button
              type="button"
              className={sidebarToolClass(false)}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-[18px] shrink-0" />
              <span className="whitespace-nowrap text-[15px] transition-all duration-200">搜索</span>
            </button>
            <button
              type="button"
              className={sidebarToolClass(false)}
              onClick={() => openCreateDialog()}
            >
              <SquarePen className="size-[18px] shrink-0" />
              <span className="whitespace-nowrap text-[15px] transition-all duration-200">新建服务器</span>
            </button>
          </div>

          <nav
            className={cn(
              "mt-8 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
              "gap-1 px-1",
            )}
          >
            <div className="px-3.5 pb-2 text-[12px] font-medium text-muted-foreground/65">工作区</div>
            {navItems.map((item) => (
              (() => {
                const active = item.key === activeNav
                return (
              <button
                key={item.label}
                type="button"
                onClick={() => navigateTo({ nav: item.key })}
                className={sidebarItemClass(active, false)}
              >
                <item.icon
                  className={cn(
                    "size-[18px] shrink-0",
                    active ? "text-foreground/80" : "opacity-70",
                  )}
                />
                <span className="whitespace-nowrap text-[15px] transition-all duration-200">{item.label}</span>
              </button>
                )
              })()
            ))}
          </nav>

          <div className="mt-4 shrink-0 px-0 pt-5">
            <Button
              type="button"
              variant="ghost"
              className="flex h-14 w-full items-center justify-start gap-3 rounded-3xl px-5 text-left text-muted-foreground shadow-none transition-all duration-200 hover:bg-muted/60 hover:text-foreground dark:hover:bg-white/[0.05]"
              onClick={() => navigateTo({ nav: "settings" })}
            >
              <Settings className="size-[22px] shrink-0 opacity-85" />
              <span className="whitespace-nowrap text-[16px] font-medium tracking-normal">设置</span>
            </Button>
          </div>
        </aside>
        )}

        <main className="flex h-screen min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[28px] border-l border-t border-border/60 bg-background shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:border-white/10 dark:shadow-none">
          {activeNav === "settings" ? null : (
          <header className="flex h-14 shrink-0 items-center justify-between bg-background px-5 lg:px-7 dark:bg-background">
            <div className="flex min-w-0 items-center gap-3">
              <div className="w-[172px] shrink-0" aria-hidden="true" />
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-2">
                <>
                  <Select
                    value={selectedConnectionId ?? ""}
                    onOpenChange={(open) => {
                      if (open) {
                        void prewarmInspectionCache()
                      }
                    }}
                    onValueChange={(value: string) => {
                      if (!value) {
                        return
                      }
                      selectConnection(value)
                    }}
                  >
                    <SelectTrigger className="h-9 w-[148px] rounded-2xl border-border/60 bg-muted/55 shadow-none hover:bg-muted/70 dark:border-transparent dark:bg-white/[0.05] sm:w-[220px]">
                      <SelectValue placeholder="选择服务器" />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.length === 0 ? (
                        <SelectItem value="__empty__" disabled>
                          暂无服务器
                        </SelectItem>
                      ) : (
                        connections.map((connection: VpsConnectionRecord) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-9 rounded-2xl border-border/60 bg-muted/55 shadow-none hover:bg-muted/75 dark:border-transparent dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"
                    title="编辑当前服务器"
                    onClick={() => {
                      if (!selectedConnection) {
                        return
                      }
                      openCreateDialog(selectedConnection as VpsConnectionInput)
                    }}
                    disabled={!selectedConnection}
                  >
                    <SquarePen className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-9 rounded-2xl border-border/60 bg-muted/55 shadow-none hover:bg-muted/75 dark:border-transparent dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"
                    title="添加服务器"
                    onClick={() => openCreateDialog()}
                  >
                    <Plus className="size-4" />
                  </Button>
                </>
            </div>
          </header>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className={cn(
              "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden",
              activeNav === "settings" ? "px-0 py-0" : "px-5 py-6 lg:px-8",
            )}>
              {(info || error) && (
                <div className="rounded-3xl border border-border/60 bg-card/90 px-5 py-4 text-sm shadow-sm dark:border-white/10 dark:bg-[#181818] dark:shadow-none">
                  {error ? (
                    <p className="text-destructive">{error}</p>
                  ) : (
                    <p className="text-primary">{info}</p>
                  )}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-5">
                <div className="flex min-h-[min(520px,70svh)] flex-1 flex-col gap-5">
                {activeNav === "settings" ? (
                  <AppSettingsPage onExit={() => {
                    if (canGoBack) {
                      moveHistory("back")
                      return
                    }
                    navigateTo({ nav: "monitor" })
                  }} />
                ) : activeNav === "projects" ? (
                  <ProjectManagementPanel
                    connections={connections}
                    selectedConnectionId={selectedConnectionId}
                    highlightedProjectId={highlightedProjectId}
                    onOpenRemoteDirectory={openRemoteDirectoryInBrowser}
                  />
                ) : activeNav === "files" ? (
                  <FileBrowserPanel
                    selectedConnection={selectedConnection}
                    fallbackConnectionId={fileBrowserRequest?.connectionId}
                    requestedPath={fileBrowserRequest?.path}
                    requestToken={fileBrowserRequest?.token}
                  />
                ) : !selectedConnection ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
                    <p className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                      接下来要管理哪台服务器？
                    </p>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                      在右上角新建或选择一条 VPS 连接，即可查看主机名、内核、资源与软件包状态。
                    </p>
                    <Button
                      type="button"
                      className="mt-2 rounded-full px-6"
                      onClick={() => openCreateDialog()}
                    >
                      <SquarePen className="size-4" />
                      新建连接
                    </Button>
                  </div>
                ) : isInspecting && !inspection ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
                    <LoaderCircle className="size-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">正在拉取远程环境信息…</p>
                  </div>
                ) : error ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-amber-500/25 bg-amber-500/[0.04] px-6 py-12 text-center">
                    <ShieldAlert className="text-amber-500 dark:text-amber-300" />
                    <div className="flex flex-col gap-2">
                      <p className="text-base font-medium text-foreground">服务器监控没有完成</p>
                      <p className="text-sm leading-6 text-amber-600 dark:text-amber-300">{error}</p>
                    </div>
                  </div>
                ) : inspection ? (
                  activeNav === "deps" ? (
                    <DependencyCards
                      packages={inspection.packages}
                      connection={selectedConnection as VpsConnectionInput}
                      installDependency={installDependency}
                      inspectDependencyUsage={inspectDependencyUsage}
                      uninstallDependency={uninstallDependency}
                      dependencyServiceAction={dependencyServiceAction}
                      isInstallingDependency={isInstallingDependency}
                      installingDependencyId={installingDependencyId}
                      isDependencyServicePending={isDependencyServicePending}
                      dependencyServicePendingKey={dependencyServicePendingKey}
                    />
                  ) : (
                    (() => {
                      const alerts = buildMonitorAlerts(inspection, upgradeStatus)
                      const freshness = inspectionFreshness(inspection.checkedAt, nowTick)
                      const connectionMeta = formatConnectionMeta(selectedConnection)
                      return (
                        <div className="space-y-6">
                          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
                            <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
                              <div className="flex items-start gap-5">
                                <div className="mt-0.5 grid size-16 place-items-center rounded-3xl bg-[#f1f5f9] text-muted-foreground dark:bg-white/[0.06]">
                                  <Server className="size-7" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  {shouldShowConnectionAlias(selectedConnection?.name, inspection.hostname) ? (
                                    <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                      {selectedConnection?.name}
                                    </p>
                                  ) : null}
                                  {connectionMeta ? (
                                    <p className="mb-3 text-sm text-muted-foreground">{connectionMeta}</p>
                                  ) : null}
                                  <h3 className="text-4xl font-semibold tracking-tight text-foreground">
                                    {inspection.hostname}
                                  </h3>
                                  <p className="mt-3 text-[18px] text-muted-foreground">
                                    {simplifyOsLabel(inspection.os, inspection.kernel)}
                                  </p>
                                  <div className="mt-8 flex flex-wrap gap-3 text-[14px] text-muted-foreground">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 dark:border-transparent dark:bg-white/[0.04]">
                                      <Clock3 className="size-4" />
                                      <span className="text-muted-foreground">运行时间</span>
                                      <span className="text-foreground">{summarizeUptime(inspection.uptime)}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 dark:border-transparent dark:bg-white/[0.04]">
                                      <span className="text-muted-foreground">IP</span>
                                      <span className="text-foreground">{selectedConnection.host}</span>
                                    </span>
                                    {expirationStatus ? (
                                      <span
                                        className={cn(
                                          "inline-flex items-center gap-2 rounded-full px-4 py-2",
                                          expirationStatus.tone === "ok" &&
                                            "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300",
                                          expirationStatus.tone === "warn" &&
                                            "border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300",
                                          expirationStatus.tone === "danger" &&
                                            "border border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200",
                                        )}
                                      >
                                        <Clock3 className="size-4" />
                                        <span>{expirationStatus.label}</span>
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div
                              className={cn(
                                "rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424]",
                                upgradePresentation.tone === "warn" && "bg-amber-50 border-amber-200/70 dark:border-[#4c3c1d] dark:bg-[#2b261d]",
                                upgradePresentation.tone === "danger" && "bg-red-50 border-red-200/70 dark:border-[#4d2929] dark:bg-[#2b1f1f]",
                              )}
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="text-sm font-medium text-muted-foreground">运行状态</p>
                                  <p className="mt-3 text-3xl font-semibold text-foreground">
                                    {alerts[0]?.tone === "ok" ? "运行平稳" : "需要关注"}
                                  </p>
                                </div>
                                {alerts[0]?.tone === "ok" ? (
                                  <CheckCircle2 className="size-8 text-emerald-400" />
                                ) : (
                                  <AlertTriangle className="size-8 text-amber-400" />
                                )}
                              </div>

                              <div className="mt-6 flex flex-wrap gap-2">
                                {alerts.slice(0, 3).map((item) => (
                                  <span
                                    key={item.key}
                                    className={cn(
                                      "rounded-full px-3 py-1 text-[12px]",
                                      item.tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                                      item.tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                                      item.tone === "danger" && "bg-destructive/10 text-red-700 dark:text-red-200",
                                    )}
                                  >
                                    {item.label}
                                  </span>
                                ))}
                              </div>

                              <div className="mt-10">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-sm font-medium text-muted-foreground">软件包更新</p>
                                  {upgradeStatus?.supported && upgradeStatus.upgradableCount > 0 ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="size-9 rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/[0.06]"
                                      onClick={() => selectedConnection && reopenUpgradePrompt(selectedConnection.id)}
                                    >
                                      <SquareArrowOutUpRight className="size-4" />
                                    </Button>
                                  ) : null}
                                </div>
                                <div className="mt-3 flex items-center gap-3">
                                  {isCheckingUpdates ? (
                                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                                  ) : upgradePresentation.tone === "ok" ? (
                                    <CheckCircle2 className="size-5 text-emerald-400" />
                                  ) : (
                                    <ShieldAlert className="size-5 text-amber-400" />
                                  )}
                                  <p className="text-2xl font-semibold text-foreground">{upgradePresentation.title}</p>
                                </div>
                                {upgradePresentation.detail ? (
                                  <p className="mt-4 text-base leading-7 text-muted-foreground">
                                    {upgradePresentation.detail}
                                  </p>
                                ) : null}
                              </div>

                              {freshness.stale ? (
                                <p className="mt-8 text-sm text-muted-foreground">
                                  监控数据较早，最近一次采样为 {freshness.label}
                                </p>
                              ) : null}
                            </div>
                          </div>

                          {inspection.telemetry ? (
                            <InspectionTelemetryCards
                              telemetry={inspection.telemetry}
                              metrics={inspection.metrics}
                            />
                          ) : (
                            <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 text-sm text-muted-foreground shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
                              暂未返回监控数据，请稍后再次采样。
                            </div>
                          )}
                        </div>
                      )
                    })()
                  )
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
                    这台服务器还没有监控快照
                  </div>
                )}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
