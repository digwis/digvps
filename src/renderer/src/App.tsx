import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FolderOpen,
  HardDriveDownload,
  LoaderCircle,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  SquareArrowOutUpRight,
  SquarePen,
  SquareTerminal,
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

import { cn, createDebouncedStorageWriter } from "@/lib/utils"
import { getDesktopApi } from "@/lib/desktop-api"
import { useProjectStore } from "@/store/project-store"
import { getCachedInspection, useVpsStore } from "@/store/vps-store"
import { AppSettingsPage } from "@/components/app-settings-page"
import { InspectionTelemetryCards } from "@/components/inspection-telemetry-cards"
import { SystemUpgradePrompt } from "@/components/system-upgrade-prompt"
import { TerminalPage } from "@/components/terminal-page"
import { VpsConnectionDialog } from "@/components/vps-connection-dialog"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { Toaster } from "@/components/ui/toaster"
import type {
  ConnectionStatus,
  RemotePackageStatus,
  SystemUpgradeCheckResult,
  VpsConnectionInput,
  VpsConnectionRecord,
  VpsInspection,
} from "../../shared/vps"

type NavKey = "monitor" | "projects" | "files" | "settings"

type AppLocation = {
  nav: NavKey
  highlightedProjectId?: string
  fileBrowserRequest?: {
    connectionId: string
    path: string
  }
}

const LAST_ACTIVE_NAV_KEY = "openvps:last-active-nav"
const SIDEBAR_COLLAPSED_KEY = "openvps:sidebar-collapsed"
const SIDEBAR_WIDTH_KEY = "openvps:sidebar-width"
const SIDEBAR_DEFAULT_WIDTH = 288
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 560
const TELEMETRY_FRESH_MS = 20_000

const lastActiveNavWriter = createDebouncedStorageWriter(LAST_ACTIVE_NAV_KEY)
const sidebarCollapsedWriter = createDebouncedStorageWriter(SIDEBAR_COLLAPSED_KEY)
const sidebarWidthWriter = createDebouncedStorageWriter(SIDEBAR_WIDTH_KEY)

const navItems: Array<{ key: NavKey; icon: typeof Server }> = [
  { key: "monitor", icon: Server },
  { key: "projects", icon: SquareTerminal },
  { key: "files", icon: FolderOpen },
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
  lastActiveNavWriter.schedule(nav)
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  } catch {
    return false
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  sidebarCollapsedWriter.schedule(collapsed ? "true" : "false")
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width))
}

function readSidebarWidth() {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

function writeSidebarWidth(width: number) {
  sidebarWidthWriter.schedule(String(clampSidebarWidth(width)))
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
  t: (key: string, options?: Record<string, unknown>) => string,
): { title: string; detail?: string; tone: "muted" | "ok" | "warn" | "danger" } {
  if (checking) {
    return { title: t("monitor.checkingUpgrades"), tone: "muted" }
  }
  if (!status) {
    return { title: t("monitor.notChecked"), tone: "muted" }
  }
  if (!status.supported) {
    if (status.reason === "no_apt") {
      return { title: t("monitor.unsupportedUpgrade"), tone: "muted" }
    }
    if (status.reason === "exec_error") {
      return {
        title: t("monitor.monitorIncomplete"),
        detail: status.hint ? status.hint.slice(0, 120) : undefined,
        tone: "danger",
      }
    }
    return { title: t("monitor.monitorIncomplete"), tone: "muted" }
  }
  if (status.upgradableCount > 0) {
    return {
      title: t("upgrade.countDesc", { count: status.upgradableCount }),
      detail: status.indexRefreshed ? undefined : t("upgrade.aptUpdateHint"),
      tone: "warn",
    }
  }
  return {
    title: t("monitor.upToDate"),
    detail: t("monitor.upToDateDesc"),
    tone: "ok",
  }
}

function connectionStatusDotClass(status: ConnectionStatus | undefined) {
  if (status === "connected") {
    return "bg-emerald-500"
  }
  if (status === "failed") {
    return "bg-red-500"
  }
  return "bg-muted-foreground/40"
}

function connectionStatusLabel(status: ConnectionStatus | undefined, t: (key: string) => string) {
  if (status === "connected") {
    return t("monitor.status.connected")
  }
  if (status === "failed") {
    return t("monitor.status.failed")
  }
  return t("monitor.status.idle")
}

function daemonPackages(packages: RemotePackageStatus[]) {
  return packages.filter((pkg) => ["docker", "nginx", "postgresql", "pm2"].includes(pkg.id))
}

function buildMonitorAlerts(
  inspection: VpsInspection,
  upgradeStatus: SystemUpgradeCheckResult | undefined,
  daemonPackageList: RemotePackageStatus[],
  t: (key: string, options?: Record<string, unknown>) => string,
): Array<{ key: string; label: string; tone: "danger" | "warn" | "ok" }> {
  const alerts: Array<{ key: string; label: string; tone: "danger" | "warn" | "ok" }> = []
  const telemetry = inspection.telemetry
  if (telemetry) {
    if (telemetry.cpuPercent >= 85) {
      alerts.push({ key: "cpu", label: `CPU ${telemetry.cpuPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.memoryPercent >= 85) {
      alerts.push({ key: "memory", label: `${t("monitor.metric.memory")} ${telemetry.memoryPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.diskPercent >= 90) {
      alerts.push({ key: "disk", label: `${t("monitor.metric.disk")} ${telemetry.diskPercent.toFixed(0)}%`, tone: "danger" })
    }
    if (telemetry.loadPercent >= 75) {
      alerts.push({ key: "load", label: `${t("monitor.metric.load")} ${telemetry.loadPercent.toFixed(0)}%`, tone: "warn" })
    }
  }
  if (upgradeStatus?.supported && upgradeStatus.upgradableCount > 0) {
    alerts.push({
      key: "upgrade",
      label: t("upgrade.countDesc", { count: upgradeStatus.upgradableCount }),
      tone: upgradeStatus.upgradableCount >= 10 ? "danger" : "warn",
    })
  }
  for (const pkg of daemonPackageList) {
    if (pkg.installed && pkg.running === false) {
      alerts.push({ key: `svc-${pkg.id}`, label: `${pkg.name} ${t("monitor.package.stopped")}`, tone: "warn" })
    }
  }
  if (alerts.length === 0) {
    alerts.push({ key: "ok", label: t("monitor.allGood"), tone: "ok" })
  }
  return alerts.slice(0, 4)
}

function inspectionFreshness(checkedAt: string, now: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const deltaMs = Math.max(0, now - new Date(checkedAt).getTime())
  const deltaSeconds = Math.round(deltaMs / 1000)
  const deltaMinutes = Math.round(deltaMs / 60_000)
  if (deltaMs <= TELEMETRY_FRESH_MS) {
    return {
      label: t("monitor.justNow"),
      className: "bg-emerald-500/8 text-emerald-300",
      stale: false,
    }
  }
  if (deltaSeconds < 60) {
    return {
      label: `${deltaSeconds}s`,
      className: "bg-[#34301f] text-amber-300",
      stale: true,
    }
  }
  if (deltaMinutes <= 5) {
    return {
      label: `${deltaMinutes}m`,
      className: "bg-[#34301f] text-amber-300",
      stale: true,
    }
  }
  return {
    label: `${deltaMinutes}m`,
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

function summarizeUptime(uptime: string, t: (key: string, options?: Record<string, unknown>) => string) {
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
    return totalDays > 0 ? `${totalMonths}m ${totalDays}d` : `${totalMonths}m`
  }
  if (totalDays > 0) {
    return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`
  }
  if (hours > 0) {
    return `${hours}h`
  }
  return ""
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

function expirationPresentation(expiresAt: string | undefined, t: (key: string, options?: Record<string, unknown>) => string) {
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
      label: `${diffDays}d`,
      tone: "danger" as const,
    }
  }
  if (diffDays === 0) {
    return {
      label: `0d`,
      tone: "danger" as const,
    }
  }
  if (diffDays <= 7) {
    return {
      label: `${diffDays}d`,
      tone: "danger" as const,
    }
  }
  if (diffDays <= 30) {
    return {
      label: `${diffDays}d`,
      tone: "warn" as const,
    }
  }
  return {
    label: `${diffDays}d`,
    tone: "ok" as const,
  }
}

type FreshnessIndicatorProps = {
  checkedAt: string
  t: (key: string, options?: Record<string, unknown>) => string
}

function FreshnessIndicator({ checkedAt, t }: FreshnessIndicatorProps) {
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const freshness = inspectionFreshness(checkedAt, nowTick, t)
  if (!freshness.stale) {
    return null
  }
  return <p className="mt-8 text-sm text-muted-foreground">{freshness.label}</p>
}

export default function App() {
  const { t } = useTranslation()
  const {
    connections,
    selectedConnectionId,
    inspection,
    isInspecting,
    info,
    error,
    upgradeStatusMap,
    isCheckingUpgrade,
  } = useVpsStore(
    useShallow((state) => ({
      connections: state.connections,
      selectedConnectionId: state.selectedConnectionId,
      inspection: state.inspection,
      isInspecting: state.isInspecting,
      info: state.info,
      error: state.error,
      upgradeStatusMap: state.upgradeStatusMap,
      isCheckingUpgrade: state.isCheckingUpgrade,
    })),
  )
  const {
    loadConnections,
    inspectConnection,
    checkSystemUpgradesAfterInspect,
    checkAllConnectionsUpgrades,
    prewarmInspectionCache,
    reopenUpgradePrompt,
    deleteConnection,
    selectConnection,
  } = useVpsStore(
    useShallow((state) => ({
      loadConnections: state.loadConnections,
      inspectConnection: state.inspectConnection,
      checkSystemUpgradesAfterInspect: state.checkSystemUpgradesAfterInspect,
      checkAllConnectionsUpgrades: state.checkAllConnectionsUpgrades,
      prewarmInspectionCache: state.prewarmInspectionCache,
      reopenUpgradePrompt: state.reopenUpgradePrompt,
      deleteConnection: state.deleteConnection,
      selectConnection: state.selectConnection,
    })),
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogPreset, setDialogPreset] = useState<Partial<VpsConnectionInput> | null>(null)
  const [activeNav, setActiveNav] = useState<NavKey>(() => readLastActiveNav())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed())
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth())
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [highlightedProjectId, setHighlightedProjectId] = useState<string>()
  const [fileBrowserRequest, setFileBrowserRequest] = useState<{ connectionId: string; path: string; token: number }>()
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
    writeSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  const startSidebarResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    setSidebarResizing(true)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const onMove = (e: MouseEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + e.clientX - startX))
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      setSidebarResizing(false)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement
      if (active instanceof HTMLButtonElement) {
        active.blur()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

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
    if (!selectedConnectionId) {
      void prewarmInspectionCache()
    }
  }, [selectedConnectionId, prewarmInspectionCache])

  useEffect(() => {
    const flushWriters = () => {
      lastActiveNavWriter.flush()
      sidebarCollapsedWriter.flush()
      sidebarWidthWriter.flush()
    }
    window.addEventListener("beforeunload", flushWriters)
    window.addEventListener("pagehide", flushWriters)
    return () => {
      flushWriters()
      window.removeEventListener("beforeunload", flushWriters)
      window.removeEventListener("pagehide", flushWriters)
    }
  }, [])

  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery("")
    }
  }, [searchOpen])

  const selectedConnection = useMemo(
    () => connections.find((item: VpsConnectionRecord) => item.id === selectedConnectionId),
    [connections, selectedConnectionId],
  )
  const selectedConnectionListed = useMemo(
    () =>
      Boolean(
        selectedConnectionId && connections.some((item: VpsConnectionRecord) => item.id === selectedConnectionId),
      ),
    [connections, selectedConnectionId],
  )
  const upgradeStatus = useMemo(
    () => (selectedConnection ? upgradeStatusMap[selectedConnection.id] : undefined),
    [selectedConnection, upgradeStatusMap],
  )
  const expirationStatus = useMemo(
    () => expirationPresentation(selectedConnection?.expiresAt, t),
    [selectedConnection?.expiresAt, t],
  )
  const isCheckingUpdates = useMemo(
    () =>
      Boolean(
        selectedConnectionId &&
          inspection &&
          inspection.connectionId === selectedConnectionId &&
          isCheckingUpgrade,
      ),
    [inspection, isCheckingUpgrade, selectedConnectionId],
  )
  const upgradePresentation = useMemo(
    () => upgradeStatusPresentation(upgradeStatus, isCheckingUpdates, t),
    [upgradeStatus, isCheckingUpdates, t],
  )
  const connectionMeta = useMemo(
    () => formatConnectionMeta(selectedConnection),
    [selectedConnection],
  )
  const daemonPackageList = useMemo(
    () => daemonPackages(inspection?.packages ?? []),
    [inspection?.packages],
  )
  const monitorAlerts = useMemo(
    () => (inspection ? buildMonitorAlerts(inspection, upgradeStatus, daemonPackageList, t) : []),
    [inspection, upgradeStatus, daemonPackageList, t],
  )
  const uptimeSummary = useMemo(
    () => (inspection ? summarizeUptime(inspection.uptime, t) : ""),
    [inspection, t],
  )
  const osLabel = useMemo(
    () => (inspection ? simplifyOsLabel(inspection.os, inspection.kernel) : ""),
    [inspection],
  )
  const showAlias = useMemo(
    () => Boolean(inspection && shouldShowConnectionAlias(selectedConnection?.name, inspection.hostname)),
    [inspection, selectedConnection?.name],
  )
  const trimmedSearch = useMemo(() => searchQuery.trim(), [searchQuery])
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
  const projectResults = useMemo(() => {
    const store = useProjectStore.getState()
    const remoteProjects = store.scanResult?.projects ?? []
    return remoteProjects.map((project) => ({
      id: project.id,
      title: project.domain,
      subtitle: project.projectPath ?? project.proxyTarget,
      remotePath: project.projectPath,
      keywords: [
        project.domain,
        project.projectPath ?? "",
        project.proxyTarget,
      ],
    }))
  }, [])
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
      {searchOpen && (
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder={t("common.search")}
        />
        <CommandList>
          <CommandEmpty>
            {trimmedSearch ? t("common.noData") : hasSearchResults ? t("common.search") : t("common.noData")}
          </CommandEmpty>
          {serverResults.length > 0 ? (
            <CommandGroup heading={t("common.search")}>
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
                  <CommandShortcut>{t("common.search")}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {serverResults.length > 0 && projectResults.length > 0 ? <CommandSeparator /> : null}
          {projectResults.length > 0 ? (
            <CommandGroup heading={t("common.search")}>
              {projectResults.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.title} ${project.subtitle} ${project.remotePath ?? ""} ${project.keywords.join(" ")}`}
                  keywords={project.keywords}
                  onSelect={() => openProjectFromSearch(project.id)}
                >
                  <SquareTerminal className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{project.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{project.subtitle}</div>
                    {project.remotePath ? <div className="truncate text-[11px] text-muted-foreground/80">{project.remotePath}</div> : null}
                  </div>
                  <CommandShortcut>{t("common.search")}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
      )}
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
            title={sidebarCollapsed ? t("common.back") : t("common.cancel")}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            <PanelLeft
              className={cn(
                "size-[22px] transition-transform duration-300",
                sidebarCollapsed && "rotate-180",
              )}
            />
          </Button>
        </div>
        )}

        {/* Sidebar */}
        {activeNav === "settings" ? null : (
        <aside
          data-tauri-drag-region
          className={cn(
            "relative hidden h-screen min-h-0 shrink-0 flex-col border-r border-border/60 bg-sidebar/95 pb-5 pt-16 duration-300 ease-out dark:border-white/10 lg:flex",
            sidebarResizing ? "transition-none" : "transition-[width,padding,opacity]",
            sidebarCollapsed
              ? "w-0 overflow-hidden px-0 opacity-0"
              : "px-4 opacity-100",
          )}
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
        >
          {!sidebarCollapsed ? (
            <div
              role="separator"
              aria-orientation="vertical"
              title={t("sidebar.resizeHint")}
              onMouseDown={startSidebarResize}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              className="absolute inset-y-0 -right-0.5 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/25 active:bg-primary/40"
            />
          ) : null}
          <div className="mt-7 flex shrink-0 flex-col gap-1 px-1 transition-all duration-300">
            <button
              type="button"
              className={sidebarToolClass(false)}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-[18px] shrink-0" />
              <span className="whitespace-nowrap text-[15px] transition-all duration-200">{t("common.search")}</span>
            </button>
            <button
              type="button"
              className={sidebarToolClass(false)}
              onClick={() => openCreateDialog()}
            >
              <SquarePen className="size-[18px] shrink-0" />
              <span className="whitespace-nowrap text-[15px] transition-all duration-200">{t("connection.newTitle")}</span>
            </button>
          </div>

          <nav
            className={cn(
              "mt-8 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
              "gap-1 px-1",
            )}
          >
            <div className="px-3.5 pb-2 text-[12px] font-medium text-muted-foreground/65">{t("nav.monitor")}</div>
            {navItems.map((item) => (
              (() => {
                const active = item.key === activeNav
                return (
              <button
                key={item.key}
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
                <span className="whitespace-nowrap text-[15px] transition-all duration-200">{t(`nav.${item.key}`)}</span>
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
              <span className="whitespace-nowrap text-[16px] font-medium tracking-normal">{t("nav.settings")}</span>
            </Button>
          </div>
        </aside>
        )}

        <main className="flex h-screen min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border/60 bg-background dark:border-white/10">
          {activeNav === "settings" ? null : (
          <header data-tauri-drag-region className="flex h-14 shrink-0 items-center justify-between bg-background px-5 lg:px-7 dark:bg-background">
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
                      <SelectValue placeholder={t("connection.fieldHost")} />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.length === 0 ? (
                        <SelectItem value="__empty__" disabled>
                          {t("common.noData")}
                        </SelectItem>
                      ) : (
                        connections.map((connection: VpsConnectionRecord) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  connectionStatusDotClass(connection.status),
                                )}
                              />
                              <span className="truncate">{connection.name}</span>
                              <span className="truncate text-xs text-muted-foreground">{connection.host}</span>
                            </span>
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
                    title={t("connection.editTitle")}
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
                    title={t("connection.newTitle")}
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
                <div
                  className={cn(
                    "flex min-h-[min(520px,70svh)] flex-1 flex-col gap-5",
                    activeNav !== "projects" && "hidden",
                  )}
                >
                  <TerminalPage
                    connections={connections}
                    selectedConnectionId={selectedConnectionId}
                  />
                </div>
                {activeNav !== "projects" && (activeNav === "settings" ? (
                  <AppSettingsPage onExit={() => {
                    if (canGoBack) {
                      moveHistory("back")
                      return
                    }
                    navigateTo({ nav: "monitor" })
                  }} />
                ) : activeNav === "files" ? (
                  <FileBrowserPanel
                    selectedConnection={selectedConnection}
                    fallbackConnectionId={fileBrowserRequest?.connectionId}
                    requestedPath={fileBrowserRequest?.path}
                    requestToken={fileBrowserRequest?.token}
                  />
                ) : !selectedConnection ? (
                  connections.length > 0 ? (
                    <div className="flex flex-1 flex-col gap-5">
                      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {connections.map((conn: VpsConnectionRecord) => {
                          const cached = getCachedInspection(conn.id)
                          const telemetry = cached?.telemetry
                          return (
                            <button
                              key={conn.id}
                              type="button"
                              onClick={() => selectConnection(conn.id)}
                              className="group flex flex-col gap-3 rounded-3xl border border-[#e5e7eb] bg-[#fbfcfe] px-6 py-5 text-left shadow-[0_8px_24px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-[#cfd8e3] hover:shadow-[0_12px_32px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[#242424] dark:hover:border-white/20"
                            >
                              <div className="flex items-center gap-2.5">
                                <span
                                  className={cn(
                                    "size-2.5 shrink-0 rounded-full",
                                    connectionStatusDotClass(conn.status),
                                  )}
                                />
                                <span className="truncate text-[16px] font-semibold text-foreground">
                                  {conn.name}
                                </span>
                                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                  {connectionStatusLabel(conn.status, t)}
                                </span>
                              </div>
                              <p className="truncate text-[13px] text-muted-foreground">
                                {conn.username}@{conn.host}:{conn.port}
                              </p>
                              {conn.lastError && conn.status === "failed" ? (
                                <p className="line-clamp-2 text-[12px] leading-5 text-red-600 dark:text-red-300">
                                  {conn.lastError}
                                </p>
                              ) : null}
                              {telemetry ? (
                                <div className="mt-1 space-y-2">
                                  {[
                                    { label: "CPU", value: telemetry.cpuPercent },
                                    { label: t("monitor.metric.memory"), value: telemetry.memoryPercent },
                                    { label: t("monitor.metric.disk"), value: telemetry.diskPercent },
                                  ].map((metric) => (
                                    <div key={metric.label} className="flex items-center gap-2">
                                      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">
                                        {metric.label}
                                      </span>
                                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#e5e7eb] dark:bg-white/[0.08]">
                                        <div
                                          className={cn(
                                            "h-full rounded-full",
                                            metric.value >= 85 ? "bg-red-400" : "bg-emerald-400",
                                          )}
                                          style={{ width: `${Math.min(100, Math.max(0, metric.value))}%` }}
                                        />
                                      </div>
                                      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                        {metric.value.toFixed(0)}%
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </button>
                          )
                        })}
                        <button
                          type="button"
                          onClick={() => openCreateDialog()}
                          className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-6 py-5 text-muted-foreground transition hover:border-border hover:text-foreground dark:border-white/15 dark:bg-white/[0.02]"
                        >
                          <Plus className="size-5" />
                          <span className="text-sm">{t("monitor.newConnection")}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
                    <p className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                      {t("monitor.selectServer")}
                    </p>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                      {t("monitor.selectServerDesc")}
                    </p>
                    <Button
                      type="button"
                      className="mt-2 rounded-full px-6"
                      onClick={() => openCreateDialog()}
                    >
                      <SquarePen className="size-4" />
                      {t("monitor.newConnection")}
                    </Button>
                  </div>
                  )
                ) : isInspecting && !inspection ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
                    <LoaderCircle className="size-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t("monitor.loadingRemoteEnv")}</p>
                  </div>
                ) : inspection ? (
                  (
                    <div className="space-y-6">
                          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
                            <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
                              <div className="flex items-start gap-5">
                                <div className="mt-0.5 grid size-16 place-items-center rounded-3xl bg-[#f1f5f9] text-muted-foreground dark:bg-white/[0.06]">
                                  <Server className="size-7" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  {showAlias ? (
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
                                    {osLabel}
                                  </p>
                                  <div className="mt-8 flex flex-wrap gap-3 text-[14px] text-muted-foreground">
                                    <span
                                      className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 dark:border-transparent dark:bg-white/[0.04]"
                                      title={selectedConnection?.lastError ?? undefined}
                                    >
                                      <span
                                        className={cn(
                                          "size-2 rounded-full",
                                          connectionStatusDotClass(selectedConnection?.status),
                                        )}
                                      />
                                      <span className="text-foreground">
                                        {connectionStatusLabel(selectedConnection?.status, t)}
                                      </span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 dark:border-transparent dark:bg-white/[0.04]">
                                      <Clock3 className="size-4" />
                                      <span className="text-muted-foreground">{t("monitor.metric.uptime")}</span>
                                      <span className="text-foreground">{uptimeSummary}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 dark:border-transparent dark:bg-white/[0.04]">
                                      <span className="text-muted-foreground">IP</span>
                                      <span className="text-foreground">{selectedConnection?.host}</span>
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
                                    <button
                                      type="button"
                                      className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f3f6fa] px-4 py-2 transition hover:bg-[#e9eef5] hover:text-foreground disabled:opacity-50 dark:border-transparent dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                                      disabled={isInspecting}
                                      title={t("monitor.refresh")}
                                      onClick={() => {
                                        if (!selectedConnection) {
                                          return
                                        }
                                        void inspectConnection(
                                          selectedConnection as VpsConnectionInput,
                                          { forceRefresh: true },
                                        )
                                      }}
                                    >
                                      <RefreshCw className={cn("size-4", isInspecting && "animate-spin")} />
                                      {t("monitor.refresh")}
                                    </button>
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
                                  <p className="text-sm font-medium text-muted-foreground">{t("monitor.health")}</p>
                                  <p className="mt-3 text-3xl font-semibold text-foreground">
                                    {monitorAlerts[0]?.tone === "ok" ? t("monitor.allGood") : t("monitor.alertTitle")}
                                  </p>
                                </div>
                                {monitorAlerts[0]?.tone === "ok" ? (
                                  <CheckCircle2 className="size-8 text-emerald-400" />
                                ) : (
                                  <AlertTriangle className="size-8 text-amber-400" />
                                )}
                              </div>

                              <div className="mt-6 flex flex-wrap gap-2">
                                {monitorAlerts.slice(0, 3).map((item) => (
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
                                  <p className="text-sm font-medium text-muted-foreground">{t("monitor.systemUpdates")}</p>
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

                              {inspection.checkedAt ? <FreshnessIndicator checkedAt={inspection.checkedAt} t={t} /> : null}
                            </div>
                          </div>

                          {inspection.telemetry ? (
                            <InspectionTelemetryCards
                              telemetry={inspection.telemetry}
                              metrics={inspection.metrics}
                            />
                          ) : (
                            <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 text-sm text-muted-foreground shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
                              {t("monitor.noSnapshot")}
                            </div>
                          )}
                        </div>
                  )
                ) : error ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-amber-500/25 bg-amber-500/[0.04] px-6 py-12 text-center">
                    <ShieldAlert className="text-amber-500 dark:text-amber-300" />
                    <div className="flex flex-col gap-2">
                      <p className="text-base font-medium text-foreground">{t("monitor.monitorIncomplete")}</p>
                      <p className="text-sm leading-6 text-amber-600 dark:text-amber-300">{error}</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-2 rounded-full px-6"
                      disabled={isInspecting || !selectedConnection}
                      onClick={() => {
                        if (!selectedConnection) {
                          return
                        }
                        void inspectConnection(
                          selectedConnection as VpsConnectionInput,
                          { forceRefresh: true },
                        )
                      }}
                    >
                      <RefreshCw className={cn("size-4", isInspecting && "animate-spin")} />
                      {t("common.retry")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
                    {t("monitor.noSnapshot")}
                  </div>
                ))}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
