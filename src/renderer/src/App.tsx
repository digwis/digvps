import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Clock3,
  Cpu,
  FolderOpen,
  FolderKanban,
  HardDriveDownload,
  LoaderCircle,
  Moon,
  PanelLeft,
  Plus,
  PlugZap,
  Search,
  Server,
  Settings,
  ShieldAlert,
  SquarePen,
  Sun,
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
import { useThemeStore } from "@/store/theme-store"
import { AppSettingsSheet } from "@/components/app-settings-sheet"
import { DependencyCards } from "@/components/dependency-cards"
import { InspectionTelemetryCards } from "@/components/inspection-telemetry-cards"
import { SystemUpgradePrompt } from "@/components/system-upgrade-prompt"
import { VpsConnectionDialog } from "@/components/vps-connection-dialog"
import { ProjectManagementPanel } from "@/components/project-management-panel"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { Toaster } from "@/components/ui/toaster"
import type { LocalProjectRecord, ProjectRemoteDetails } from "../../shared/projects"
import type {
  InspectionPortCheck,
  InspectionReachabilityCheck,
  RemotePackageStatus,
  SystemUpgradeCheckResult,
  VpsConnectionInput,
  VpsConnectionRecord,
  VpsInspection,
} from "../../shared/vps"

type NavKey = "monitor" | "deps" | "projects" | "files"

const LAST_ACTIVE_NAV_KEY = "digwis:last-active-nav"

const navItems: Array<{ key: NavKey; label: string; icon: typeof Server }> = [
  { key: "monitor", label: "系统监控", icon: Server },
  { key: "deps", label: "依赖安装", icon: HardDriveDownload },
  { key: "projects", label: "项目管理", icon: FolderKanban },
  { key: "files", label: "文件浏览", icon: FolderOpen },
]

function isNavKey(value: string): value is NavKey {
  return navItems.some((item) => item.key === value)
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

function statusLabel(connection: VpsConnectionRecord) {
  if (connection.status === "connected") {
    return { text: "最近可用", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" }
  }
  if (connection.status === "failed") {
    return { text: "需要修复", className: "bg-amber-500/10 text-amber-600 dark:text-amber-300" }
  }
  return { text: "未验证", className: "bg-muted text-muted-foreground" }
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

function serviceBadge(pkg: RemotePackageStatus): { text: string; className: string } {
  if (!pkg.installed) {
    return { text: "未安装", className: "bg-muted text-muted-foreground" }
  }
  if (pkg.running === true) {
    return {
      text: "运行中",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    }
  }
  if (pkg.running === false) {
    return {
      text: "未运行",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    }
  }
  return { text: "已安装", className: "bg-muted text-muted-foreground" }
}

function portCheckTone(check: InspectionPortCheck): string {
  return check.listening
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : "bg-muted text-muted-foreground"
}

function inspectionFreshness(checkedAt: string) {
  const deltaMs = Date.now() - new Date(checkedAt).getTime()
  const deltaMinutes = Math.max(0, Math.round(deltaMs / 60_000))
  if (deltaMinutes <= 1) {
    return {
      label: "刚刚更新",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      stale: false,
    }
  }
  if (deltaMinutes <= 5) {
    return {
      label: `${deltaMinutes} 分钟前`,
      className: "bg-muted text-muted-foreground",
      stale: false,
    }
  }
  return {
    label: `${deltaMinutes} 分钟前`,
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    stale: true,
  }
}

function reachabilityBadge(check: InspectionReachabilityCheck) {
  if (!check.ok) {
    return { label: "失败", className: "bg-destructive/10 text-destructive" }
  }
  if ((check.responseTimeMs ?? 0) >= 1500) {
    return {
      label: "偏慢",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    }
  }
  return {
    label: "可达",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  }
}

export default function App() {
  const { theme, toggleTheme } = useThemeStore()
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
    operationLogs,
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
    deleteConnection,
    selectConnection,
    clearOperationLogs,
  } = useVpsStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogPreset, setDialogPreset] = useState<Partial<VpsConnectionInput> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeNav, setActiveNav] = useState<NavKey>(() => readLastActiveNav())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [highlightedProjectId, setHighlightedProjectId] = useState<string>()
  const [monitorProjectEntries, setMonitorProjectEntries] = useState<
    Array<{ project: LocalProjectRecord; details: ProjectRemoteDetails | null }>
  >([])
  const [monitorProjectsLoading, setMonitorProjectsLoading] = useState(false)

  useEffect(() => {
    void loadConnections().then(() => {
      void checkAllConnectionsUpgrades()
    })
  }, [loadConnections, checkAllConnectionsUpgrades])

  useEffect(() => {
    writeLastActiveNav(activeNav)
  }, [activeNav])

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

  useEffect(() => {
    if (!selectedConnectionId) {
      setMonitorProjectEntries([])
      setMonitorProjectsLoading(false)
      return
    }
    if (projects.length === 0) {
      setMonitorProjectEntries([])
      setMonitorProjectsLoading(false)
      return
    }
    const relatedProjects = projects.filter((project) => project.lastConnectionId === selectedConnectionId).slice(0, 6)
    if (relatedProjects.length === 0) {
      setMonitorProjectEntries([])
      setMonitorProjectsLoading(false)
      return
    }

    let cancelled = false
    setMonitorProjectsLoading(true)
    void Promise.all(
      relatedProjects.map(async (project) => {
        try {
          const details = await getDesktopApi().projects.getProjectRemoteDetails({
            projectId: project.id,
            connectionId: selectedConnectionId,
          })
          return { project, details }
        } catch {
          return { project, details: null }
        }
      }),
    ).then((items) => {
      if (!cancelled) {
        setMonitorProjectEntries(items)
        setMonitorProjectsLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [projects, selectedConnectionId])

  const selectedConnection = connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId)
  const selectedConnectionListed = Boolean(
    selectedConnectionId && connections.some((item: VpsConnectionRecord) => item.id === selectedConnectionId),
  )
  const upgradeStatus = selectedConnection ? upgradeStatusMap[selectedConnection.id] : undefined
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
    void inspectConnection(conn, { forceRefresh: true })
  }, [inspectConnection, selectedConnectionId, selectedConnectionListed])

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

  const openCreateDialog = (preset?: Partial<VpsConnectionInput>) => {
    setDialogPreset(preset ?? null)
    setDialogOpen(true)
  }

  const openServerFromSearch = (connectionId: string) => {
    selectConnection(connectionId)
    setActiveNav("monitor")
    setSearchOpen(false)
    setSearchQuery("")
  }

  const openProjectFromSearch = (projectId: string) => {
    setActiveNav("projects")
    setHighlightedProjectId(projectId)
    setSearchOpen(false)
    setSearchQuery("")
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
      <AppSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VpsConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} preset={dialogPreset} />

      <div className="fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.06),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.12),transparent)]" />

      <div className="relative flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="hidden h-screen min-h-0 w-[272px] shrink-0 flex-col border-r border-border/80 bg-sidebar px-3 pb-5 pt-10 lg:flex">
          <div className="flex items-center gap-2.5 px-1">
            <div className="grid size-9 place-items-center rounded-xl border border-border/80 bg-background text-foreground shadow-sm">
              <Server className="size-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">digwis-panel</p>
              <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">VPS Control Desk</h1>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>

          <button
            type="button"
            className="mt-3 flex w-full items-center gap-2.5 rounded-full border border-transparent bg-background/70 px-3.5 py-2 text-left text-[13px] text-muted-foreground shadow-sm ring-1 ring-border/50 transition hover:bg-background hover:text-foreground hover:ring-border"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">搜索服务器、项目…</span>
            <span className="ml-auto text-[11px] text-muted-foreground/80">⌘K</span>
          </button>

          <nav className="mt-6 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-0.5 [scrollbar-gutter:stable]">
            {navItems.map((item) => (
              (() => {
                const active = item.key === activeNav
                return (
              <button
                key={item.label}
                type="button"
                onClick={() => setActiveNav(item.key)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition",
                  active
                    ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 shrink-0",
                    active ? "text-muted-foreground" : "opacity-70",
                  )}
                />
                {item.label}
              </button>
                )
              })()
            ))}
          </nav>

          <div className="mt-3 shrink-0 border-t border-border/70 px-0.5 pt-3">
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full justify-start gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-background/80 hover:text-foreground"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4 shrink-0 opacity-80" />
              设置
            </Button>
          </div>
        </aside>

        <main className="flex h-screen min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background pt-10">
          <header className="flex shrink-0 items-center justify-between border-b border-border/60 px-5 py-2.5 lg:px-7">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="truncate text-[14px] font-semibold text-foreground">
                  {selectedConnection?.name ?? "服务器监控"}
                </h2>
                {selectedConnection ? (
                  <span
                    className={cn(
                      "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
                      statusLabel(selectedConnection).className,
                    )}
                  >
                    {statusLabel(selectedConnection).text}
                  </span>
                ) : null}
                {inspection ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {inspection.hostname}
                    <span className="mx-1 text-muted-foreground/70">·</span>
                    系统在线 {inspection.uptime}
                  </span>
                ) : (
                  <span className="truncate text-xs text-muted-foreground">选择服务器后显示巡检状态</span>
                )}
              </div>
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-2">
              <Select
                value={selectedConnectionId ?? ""}
                onValueChange={(value: string) => {
                  if (!value) {
                    return
                  }
                  selectConnection(value)
                }}
              >
                <SelectTrigger className="h-8 w-[148px] rounded-lg border-border/70 bg-background shadow-none sm:w-[220px]">
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
                className="size-8 rounded-lg border-border/70 shadow-none"
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
                className="size-8 rounded-lg border-border/70 shadow-none"
                title="添加服务器"
                onClick={() => openCreateDialog()}
              >
                <Plus className="size-4" />
              </Button>
              {inspection ? (
                <div className="hidden h-8 items-center rounded-full bg-muted px-3 text-[11px] text-muted-foreground sm:inline-flex">
                  已更新 {new Date(inspection.checkedAt).toLocaleTimeString()}
                </div>
              ) : null}
              <Button variant="ghost" size="icon" className="size-8 rounded-lg lg:hidden" type="button" title="侧栏">
                <PanelLeft className="size-4" />
              </Button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden px-5 py-6 lg:px-8">
              {(info || error) && (
                <div className="rounded-2xl border border-border/80 bg-card px-4 py-3 text-sm shadow-sm">
                  {error ? (
                    <p className="text-destructive">{error}</p>
                  ) : (
                    <p className="text-primary">{info}</p>
                  )}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-5">
                <div className="flex min-h-[min(520px,70svh)] flex-1 flex-col gap-5">
                {activeNav === "projects" ? (
                  <ProjectManagementPanel
                    connections={connections}
                    selectedConnectionId={selectedConnectionId}
                    highlightedProjectId={highlightedProjectId}
                  />
                ) : activeNav === "files" ? (
                  <FileBrowserPanel selectedConnection={selectedConnection} />
                ) : !selectedConnection ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center">
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
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center">
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
                      operationLogs={operationLogs}
                      clearOperationLogs={clearOperationLogs}
                    />
                  ) : (
                    (() => {
                      const alerts = buildMonitorAlerts(inspection, upgradeStatus)
                      const servicePackages = daemonPackages(inspection.packages)
                      const runningServices = servicePackages.filter((pkg) => pkg.installed && pkg.running === true)
                      const problemServices = servicePackages.filter((pkg) => pkg.installed && pkg.running === false)
                      const activePortChecks = (inspection.portChecks ?? []).filter((item) => item.listening)
                      const freshness = inspectionFreshness(inspection.checkedAt)
                      const reachableChecks = inspection.reachabilityChecks ?? []
                      const degradedReachability = reachableChecks.filter(
                        (item) => !item.ok || (item.responseTimeMs ?? 0) >= 1500,
                      )

                      return (
                        <>
                          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]">
                            <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                              <div className="flex items-start gap-3">
                                <div className="mt-0.5 grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground">
                                  <Server className="size-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="text-lg font-semibold text-foreground">{inspection.hostname}</h3>
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                      {inspection.packageManager ?? "未知"}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    {inspection.os} · Kernel {inspection.kernel}
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                                    <span className="inline-flex items-center gap-1.5">
                                      <Clock3 className="size-3.5" />
                                      在线 {inspection.uptime}
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                      <Cpu className="size-3.5" />
                                      {inspection.metrics.find((metric) => metric.label === "逻辑核心")?.value ?? "?"} 核
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                      <Boxes className="size-3.5" />
                                      服务 {runningServices.length}/{servicePackages.length || 0}
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                      <PlugZap className="size-3.5" />
                                      监听端口 {activePortChecks.length}/{inspection.portChecks?.length ?? 0}
                                    </span>
                                    <span className={cn("rounded-full px-2 py-0.5", freshness.className)}>
                                      {freshness.label}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
                              <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-medium text-muted-foreground">风险提醒</p>
                                    <p className="mt-1 text-sm text-foreground">
                                      {alerts[0]?.tone === "ok" ? "运行平稳" : `${alerts.filter((item) => item.tone !== "ok").length} 个关注项`}
                                    </p>
                                  </div>
                                  {alerts[0]?.tone === "ok" ? (
                                    <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-300" />
                                  ) : (
                                    <AlertTriangle className="size-5 text-amber-600 dark:text-amber-300" />
                                  )}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {alerts.map((item) => (
                                    <span
                                      key={item.key}
                                      className={cn(
                                        "rounded-full px-2 py-1 text-[11px]",
                                        item.tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                                        item.tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                                        item.tone === "danger" && "bg-destructive/10 text-destructive",
                                      )}
                                    >
                                      {item.label}
                                    </span>
                                  ))}
                                  {freshness.stale ? (
                                    <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                                      巡检数据偏旧
                                    </span>
                                  ) : null}
                                  {degradedReachability.length > 0 ? (
                                    <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                                      入口有 {degradedReachability.length} 项需关注
                                    </span>
                                  ) : null}
                                </div>
                              </div>

                              <div
                                className={cn(
                                  "rounded-2xl border px-4 py-4 shadow-sm",
                                  upgradePresentation.tone === "ok" &&
                                    "border-emerald-500/20 bg-emerald-500/[0.05]",
                                  upgradePresentation.tone === "warn" &&
                                    "border-amber-500/25 bg-amber-500/[0.06]",
                                  upgradePresentation.tone === "danger" &&
                                    "border-destructive/20 bg-destructive/[0.05]",
                                  upgradePresentation.tone === "muted" && "border-border/70 bg-card",
                                )}
                              >
                                <p className="text-xs font-medium text-muted-foreground">软件包更新</p>
                                <div className="mt-2 flex items-center gap-2">
                                  {isCheckingUpdates ? (
                                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                                  ) : upgradePresentation.tone === "ok" ? (
                                    <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-300" />
                                  ) : (
                                    <ShieldAlert className="size-4 text-amber-600 dark:text-amber-300" />
                                  )}
                                  <p className="text-sm font-medium text-foreground">{upgradePresentation.title}</p>
                                </div>
                                {upgradePresentation.detail ? (
                                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                                    {upgradePresentation.detail}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          {inspection.telemetry ? (
                            <InspectionTelemetryCards
                              telemetry={inspection.telemetry}
                              metrics={inspection.metrics}
                              checkedAt={inspection.checkedAt}
                            />
                          ) : (
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                              {inspection.metrics.map((metric: { label: string; value: string }) => (
                                <div
                                  key={metric.label}
                                  className="rounded-2xl border border-border/80 bg-card p-4 shadow-sm"
                                >
                                  <p className="text-sm text-muted-foreground">{metric.label}</p>
                                  <p className="mt-3 text-lg font-semibold text-foreground">{metric.value}</p>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
                            <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-foreground">服务状态</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    常用运行时与守护进程
                                  </p>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  异常 {problemServices.length}
                                </div>
                              </div>
                              <div className="mt-4 grid gap-2 md:grid-cols-2">
                                {servicePackages.length === 0 ? (
                                  <div className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
                                    还没有检测到常用服务
                                  </div>
                                ) : (
                                  servicePackages.map((pkg) => {
                                    const badge = serviceBadge(pkg)
                                    return (
                                      <div
                                        key={pkg.id}
                                        className="rounded-xl border border-border/70 px-3 py-3"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-foreground">{pkg.name}</p>
                                            <p className="truncate text-[11px] text-muted-foreground">
                                              {pkg.detail || pkg.version || pkg.command}
                                            </p>
                                          </div>
                                          <span className={cn("rounded-full px-2 py-0.5 text-[11px]", badge.className)}>
                                            {badge.text}
                                          </span>
                                        </div>
                                        {pkg.portHint ? (
                                          <p className="mt-2 text-[11px] text-muted-foreground">端口 {pkg.portHint}</p>
                                        ) : null}
                                      </div>
                                    )
                                  })
                                )}
                              </div>
                            </div>

                            <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                              <p className="text-sm font-medium text-foreground">巡检摘要</p>
                              <div className="mt-4 space-y-3 text-sm">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-muted-foreground">巡检时间</span>
                                  <span className="text-foreground">{new Date(inspection.checkedAt).toLocaleString()}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-muted-foreground">工作目录</span>
                                  <span className="max-w-[55%] truncate text-foreground">{inspection.workingDirectory}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-muted-foreground">包管理器</span>
                                  <span className="text-foreground">{inspection.packageManager ?? "未知"}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-muted-foreground">运行中服务</span>
                                  <span className="text-foreground">{runningServices.length}</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">关键端口监听</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  基于远端当前监听状态
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                已监听 {activePortChecks.length}
                              </div>
                            </div>
                            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                              {(inspection.portChecks ?? []).map((check) => (
                                <div
                                  key={`${check.label}-${check.port}`}
                                  className="rounded-xl border border-border/70 px-3 py-3"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div>
                                      <p className="text-sm font-medium text-foreground">{check.label}</p>
                                      <p className="mt-1 text-[11px] text-muted-foreground">端口 {check.port}</p>
                                    </div>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px]", portCheckTone(check))}>
                                      {check.listening ? "已监听" : "未监听"}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">入口连通性</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  从本机对服务器入口做实际请求
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                可达 {reachableChecks.filter((item) => item.ok).length}
                              </div>
                            </div>
                            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                              {reachableChecks.map((item) => {
                                const badge = reachabilityBadge(item)
                                return (
                                  <div
                                    key={item.url}
                                    className={cn(
                                      "rounded-xl border px-3 py-3",
                                      item.ok
                                        ? "border-border/70"
                                        : "border-destructive/25 bg-destructive/[0.03]",
                                    )}
                                  >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-foreground">{item.label}</p>
                                      <p className="truncate text-[11px] text-muted-foreground">{item.url}</p>
                                    </div>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px]", badge.className)}>
                                      {badge.label}
                                    </span>
                                  </div>
                                  <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                                    <span>{item.detail ?? (item.statusCode ? `HTTP ${item.statusCode}` : "未返回更多信息")}</span>
                                    <span>
                                      {typeof item.responseTimeMs === "number"
                                        ? `${item.responseTimeMs} ms`
                                        : "无时延数据"}
                                    </span>
                                  </div>
                                </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-border/70 bg-card px-4 py-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">项目入口</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  当前服务器关联项目的预览地址与应用端口
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {monitorProjectsLoading ? "读取中…" : `${monitorProjectEntries.length} 个项目`}
                              </div>
                            </div>
                            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                              {monitorProjectsLoading ? (
                                <div className="rounded-xl border border-dashed border-border/70 px-3 py-5 text-sm text-muted-foreground">
                                  正在读取项目入口…
                                </div>
                              ) : monitorProjectEntries.length === 0 ? (
                                <div className="rounded-xl border border-dashed border-border/70 px-3 py-5 text-sm text-muted-foreground">
                                  当前服务器还没有已关联的项目入口
                                </div>
                              ) : (
                                monitorProjectEntries.map(({ project, details }) => (
                                  <div
                                    key={project.id}
                                    className="rounded-xl border border-border/70 px-3 py-3"
                                  >
                                    <p className="text-sm font-medium text-foreground">{project.displayName}</p>
                                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                                      {details?.publicUrl ?? details?.previewUrl ?? project.lastRemotePath ?? "未发现入口"}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                                      {details?.appPort ? (
                                        <span className="rounded-full bg-muted px-2 py-0.5">端口 {details.appPort}</span>
                                      ) : null}
                                      {details?.site.mode === "domain" ? (
                                        <span className="rounded-full bg-muted px-2 py-0.5">域名入口</span>
                                      ) : details?.site.mode === "port" ? (
                                        <span className="rounded-full bg-muted px-2 py-0.5">端口预览</span>
                                      ) : null}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </>
                      )
                    })()
                  )
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground">
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
