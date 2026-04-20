import { useEffect, useState } from "react"
import {
  CheckCircle2,
  FolderKanban,
  HardDriveDownload,
  LoaderCircle,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SquarePen,
  Sun,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useVpsStore } from "@/store/vps-store"
import { useThemeStore } from "@/store/theme-store"
import { AppSettingsSheet } from "@/components/app-settings-sheet"
import { DependencyCards } from "@/components/dependency-cards"
import { InspectionTelemetryCards } from "@/components/inspection-telemetry-cards"
import { SystemUpgradePrompt } from "@/components/system-upgrade-prompt"
import { VpsConnectionDialog } from "@/components/vps-connection-dialog"
import { ProjectManagementPanel } from "@/components/project-management-panel"
import { Toaster } from "@/components/ui/toaster"
import type { SystemUpgradeCheckResult, VpsConnectionInput, VpsConnectionRecord } from "../../shared/vps"

type NavKey = "monitor" | "deps" | "projects" | "security"

const LAST_ACTIVE_NAV_KEY = "digwis:last-active-nav"

const navItems: Array<{ key: NavKey; label: string; icon: typeof Server }> = [
  { key: "monitor", label: "系统监控", icon: Server },
  { key: "deps", label: "依赖安装", icon: HardDriveDownload },
  { key: "projects", label: "项目管理", icon: FolderKanban },
  { key: "security", label: "安全与密钥", icon: ShieldCheck },
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

export default function App() {
  const { theme, toggleTheme } = useThemeStore()
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
    dependencyServiceAction,
    isInstallingDependency,
    installingDependencyId,
    isDependencyServicePending,
    dependencyServicePendingKey,
    checkSystemUpgradesAfterInspect,
    checkAllConnectionsUpgrades,
    deleteConnection,
    selectConnection,
  } = useVpsStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogPreset, setDialogPreset] = useState<Partial<VpsConnectionInput> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeNav, setActiveNav] = useState<NavKey>(() => readLastActiveNav())

  useEffect(() => {
    void loadConnections().then(() => {
      void checkAllConnectionsUpgrades()
    })
  }, [loadConnections, checkAllConnectionsUpgrades])

  useEffect(() => {
    writeLastActiveNav(activeNav)
  }, [activeNav])

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
    void inspectConnection(conn)
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <SystemUpgradePrompt connection={selectedConnection} />
      <AppSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VpsConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} preset={dialogPreset} />

      <div className="fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.06),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--primary)/0.12),transparent)]" />

      <div className="relative flex min-h-screen">
        {/* Sidebar */}
        <aside className="hidden h-svh min-h-0 w-[272px] shrink-0 flex-col border-r border-border/80 bg-sidebar px-3 pb-5 pt-10 lg:flex">
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
          >
            <Search className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">搜索服务器、项目…</span>
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

        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-10">
          <header className="flex min-h-[52px] shrink-0 items-center justify-between border-b border-border/70 px-5 py-2 lg:px-7">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                {selectedConnection?.name ?? "服务器监控"}
              </h2>
              {inspection ? (
                <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                  <span className="text-foreground/90">{inspection.hostname}</span>
                  <span className="mx-1 text-muted-foreground/80">·</span>
                  <span>系统在线 {inspection.uptime}</span>
                  <span className="mx-1 text-muted-foreground/80">·</span>
                  巡检 {new Date(inspection.checkedAt).toLocaleString()}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">在右上角选择项目以查看系统状态</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex items-center gap-2">
                <Select
                  value={selectedConnectionId ?? ""}
                  onValueChange={(value: string) => {
                    if (!value) {
                      return
                    }
                    selectConnection(value)
                  }}
                >
                  <SelectTrigger className="h-9 w-[160px] rounded-lg sm:w-[240px]">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.length === 0 ? (
                      <SelectItem value="__empty__" disabled>
                        暂无项目
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
                  className="size-9 rounded-lg"
                  title="添加服务器"
                  onClick={() => openCreateDialog()}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              {inspection ? (
                <Badge variant="secondary" className="hidden font-normal sm:inline-flex">
                  已更新 {new Date(inspection.checkedAt).toLocaleTimeString()}
                </Badge>
              ) : null}
              <Button variant="ghost" size="icon" className="size-8 rounded-lg lg:hidden" type="button" title="侧栏">
                <PanelLeft className="size-4" />
              </Button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-5 py-6 lg:px-8">
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
                  />
                ) : activeNav !== "monitor" && activeNav !== "deps" ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground">
                    功能开发中
                  </div>
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
                      installDependency={(payload, id) => {
                        void installDependency(payload, id)
                      }}
                      dependencyServiceAction={(payload, options) => {
                        void dependencyServiceAction(payload, options)
                      }}
                      isInstallingDependency={isInstallingDependency}
                      installingDependencyId={installingDependencyId}
                      isDependencyServicePending={isDependencyServicePending}
                      dependencyServicePendingKey={dependencyServicePendingKey}
                    />
                  ) : (
                    <>
                      <div className="rounded-2xl border border-border/80 bg-gradient-to-br from-muted/50 to-muted/20 p-5 shadow-sm">
                        <div className="flex flex-wrap items-start gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-muted-foreground">当前主机</p>
                            <h3 className="mt-2 text-2xl font-semibold text-foreground">
                              {inspection.hostname}
                            </h3>
                            <p className="mt-2 text-sm text-muted-foreground">
                              {inspection.os} · Kernel {inspection.kernel}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-stretch justify-end gap-4">
                            <div
                              className={cn(
                                "rounded-2xl border bg-card px-4 py-3 text-sm min-w-[10rem]",
                                upgradePresentation.tone === "ok" &&
                                  "border-emerald-500/25 bg-emerald-500/[0.06]",
                                upgradePresentation.tone === "warn" &&
                                  "border-amber-500/30 bg-amber-500/[0.06]",
                                upgradePresentation.tone === "danger" &&
                                  "border-destructive/30 bg-destructive/[0.06]",
                                upgradePresentation.tone === "muted" && "border-border",
                              )}
                            >
                              <p className="text-muted-foreground">软件包更新</p>
                              <div className="mt-2 flex items-center gap-2">
                                {isCheckingUpdates ? (
                                  <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
                                ) : upgradePresentation.tone === "ok" ? (
                                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
                                ) : upgradePresentation.tone === "warn" ? (
                                  <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
                                ) : upgradePresentation.tone === "danger" ? (
                                  <ShieldAlert className="size-4 shrink-0 text-destructive" />
                                ) : null}
                                <p
                                  className={cn(
                                    "font-medium leading-snug text-foreground",
                                    upgradePresentation.tone === "ok" &&
                                      "text-emerald-800 dark:text-emerald-200",
                                    upgradePresentation.tone === "warn" &&
                                      "text-amber-800 dark:text-amber-200",
                                    upgradePresentation.tone === "danger" && "text-destructive",
                                  )}
                                >
                                  {upgradePresentation.title}
                                </p>
                              </div>
                              {upgradePresentation.detail ? (
                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                                  {upgradePresentation.detail}
                                </p>
                              ) : null}
                            </div>
                            <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
                              <p className="text-muted-foreground">包管理器</p>
                              <p className="mt-2 text-foreground">{inspection.packageManager ?? "未知"}</p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {inspection.telemetry ? (
                        <InspectionTelemetryCards telemetry={inspection.telemetry} metrics={inspection.metrics} />
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
                    </>
                  )
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground">
                    这台服务器还没有监控快照
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
