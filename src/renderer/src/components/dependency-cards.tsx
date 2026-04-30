import { useEffect, useState } from "react"
import {
  LoaderCircle,
  Play,
  Power,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "@/hooks/use-toast"
import type {
  DependencyServiceAction,
  DependencyUsageReport,
  RemotePackageStatus,
  VpsConnectionInput,
} from "../../../shared/vps"

const DESCRIPTIONS: Record<string, string> = {
  docker: "容器运行时，多项目可隔离部署在同一主机。",
  nodejs: "JavaScript 服务端运行时，常与 PM2、Nginx 配合。",
  nginx: "HTTP(S) 反向代理与静态资源入口，多站点常用。",
  pm2: "Node 进程守护与开机自启，适合常驻 Web/API。",
  python3: "Python 解释器与 pip，用于脚本与部分后端框架。",
  postgresql: "关系型数据库；多项目可共用实例并划分库与用户。",
}

const DAEMON_IDS = new Set(["docker", "nginx", "postgresql", "pm2"])
const OPTIONAL_DEPENDENCY_IDS = new Set(["docker", "pm2"])

function supportNotes(item: RemotePackageStatus): string[] {
  switch (item.id) {
    case "docker":
      return ["适合多项目隔离部署。", "卸载前请确认没有仍在运行的容器或卷。"]
    case "nodejs":
      return ["Node.js 常与 PM2、Nginx 搭配。", "卸载会一并移除 npm，并尝试清理全局 PM2。"]
    case "nginx":
      return ["常作为 80/443 入口。", "卸载前建议确认没有站点仍依赖当前反向代理配置。"]
    case "pm2":
      return ["PM2 负责 Node 进程守护。", "卸载前建议确认托管应用已迁移或停止。"]
    case "python3":
      return ["适用于脚本和 Python Web 服务。", "卸载可能影响现有虚拟环境和脚本执行。"]
    case "postgresql":
      return ["数据库服务通常承载业务数据。", "卸载前务必备份数据库并确认没有项目仍在使用。"]
    default:
      return ["远程环境依赖项。"]
  }
}

function actionLabel(action: DependencyServiceAction): string {
  if (action === "start") return "启动"
  if (action === "stop") return "停止"
  return "重启"
}

function badgeFor(item: RemotePackageStatus): { label: string; className: string } {
  if (!item.installed) {
    return { label: "未安装", className: "border-border/70 bg-background text-muted-foreground dark:border-white/10 dark:bg-white/[0.02]" }
  }
  if (!DAEMON_IDS.has(item.id)) {
    return {
      label: "已就绪",
      className: "border-border/70 bg-background text-foreground dark:border-white/10 dark:bg-white/[0.02]",
    }
  }
  if (item.running === true) {
    return {
      label: "运行中",
      className: "border-border/70 bg-background text-foreground dark:border-white/10 dark:bg-white/[0.02]",
    }
  }
  if (item.running === false) {
    return {
      label: "未运行",
      className: "border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-100",
    }
  }
  return {
    label: "已安装",
    className: "border-border/70 bg-background text-foreground dark:border-white/10 dark:bg-white/[0.02]",
  }
}

function cardTone(item: RemotePackageStatus): string {
  if (!item.installed) {
    return "border-border/70 bg-background text-foreground hover:border-border hover:bg-muted/20 dark:border-white/10 dark:bg-white/[0.02] dark:hover:bg-white/[0.05]"
  }
  if (DAEMON_IDS.has(item.id) && item.running === false) {
    return "border-amber-500/25 bg-amber-500/[0.04] text-foreground dark:border-[#4c3c1d] dark:bg-[#2b261d]"
  }
  return "border-border/70 bg-background text-foreground hover:border-border hover:bg-muted/20 dark:border-white/10 dark:bg-white/[0.02] dark:hover:bg-white/[0.05]"
}

export type DependencyCardsProps = {
  packages: RemotePackageStatus[]
  connection: VpsConnectionInput
  installDependency: (payload: VpsConnectionInput, id: string) => Promise<unknown>
  inspectDependencyUsage: (payload: VpsConnectionInput, id: string) => Promise<DependencyUsageReport>
  uninstallDependency: (payload: VpsConnectionInput, id: string) => Promise<unknown>
  dependencyServiceAction: (
    payload: VpsConnectionInput,
    options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
  ) => Promise<unknown>
  isInstallingDependency: boolean
  installingDependencyId?: string
  isDependencyServicePending: boolean
  dependencyServicePendingKey?: string
}

export function DependencyCards({
  packages,
  connection,
  installDependency,
  inspectDependencyUsage,
  uninstallDependency,
  dependencyServiceAction,
  isInstallingDependency,
  installingDependencyId,
  isDependencyServicePending,
  dependencyServicePendingKey,
}: DependencyCardsProps) {
  const [settingsTarget, setSettingsTarget] = useState<RemotePackageStatus | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<RemotePackageStatus | null>(null)
  const [usageReport, setUsageReport] = useState<DependencyUsageReport | null>(null)
  const [isUsageLoading, setIsUsageLoading] = useState(false)
  const visiblePackages = packages.filter((item) => item.installed || !OPTIONAL_DEPENDENCY_IDS.has(item.id))

  const runQuickAction = async (item: RemotePackageStatus, action: DependencyServiceAction) => {
    try {
      await dependencyServiceAction(connection, {
        dependencyId: item.id,
        action,
        systemdUnit: item.systemdUnit,
      })
    } catch (error) {
      toast({
        title: `${item.name}${actionLabel(action)}失败`,
        description: error instanceof Error ? error.message : "远程服务操作失败",
        variant: "destructive",
      })
    }
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) {
      return
    }
    try {
      await uninstallDependency(connection, uninstallTarget.id)
      setUninstallTarget(null)
    } catch (error) {
      toast({
        title: `${uninstallTarget.name} 卸载失败`,
        description: error instanceof Error ? error.message : "远程卸载失败",
        variant: "destructive",
      })
    }
  }

  useEffect(() => {
    if (!uninstallTarget?.installed) {
      setUsageReport(null)
      setIsUsageLoading(false)
      return
    }

    let alive = true
    setIsUsageLoading(true)
    setUsageReport(null)

    void inspectDependencyUsage(connection, uninstallTarget.id)
      .then((report) => {
        if (!alive) {
          return
        }
        setUsageReport(report)
        setIsUsageLoading(false)
      })
      .catch((error) => {
        if (!alive) {
          return
        }
        setIsUsageLoading(false)
        toast({
          title: `无法分析 ${uninstallTarget.name} 使用情况`,
          description: error instanceof Error ? error.message : "依赖使用分析失败",
          variant: "destructive",
        })
      })

    return () => {
      alive = false
    }
  }, [connection, inspectDependencyUsage, uninstallTarget])

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visiblePackages.map((item) => {
            const badge = badgeFor(item)
            const isDaemon = DAEMON_IDS.has(item.id)
            const pendingKey = (action: DependencyServiceAction) => `${item.id}-${action}`
            const showService =
              item.installed &&
              isDaemon &&
              (item.id === "pm2" || item.id === "docker" || item.id === "nginx" || item.id === "postgresql")
            const installingThis = isInstallingDependency && installingDependencyId === item.id
            const servicePendingThis =
              isDependencyServicePending &&
              dependencyServicePendingKey != null &&
              dependencyServicePendingKey.startsWith(`${item.id}-`)

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSettingsTarget(item)}
                className={cn(
                  "relative min-h-[250px] rounded-3xl border p-6 text-left transition",
                  cardTone(item),
                  (installingThis || servicePendingThis) && "ring-2 ring-primary/20",
                )}
              >
                <div className="flex h-full flex-col gap-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 pt-1">
                      <p className="text-[2rem] font-semibold leading-none tracking-tight text-foreground">{item.name}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Badge variant="outline" className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-normal shadow-none", badge.className)}>
                        {badge.label}
                      </Badge>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/70 hover:text-foreground dark:hover:bg-white/[0.06]"
                          title={`${item.name} 设置`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSettingsTarget(item)
                          }}
                        >
                          <Settings2 className="size-4" />
                        </Button>
                        {item.installed ? (
                          <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title={`卸载 ${item.name}`}
                          disabled={isInstallingDependency || isDependencyServicePending}
                          onClick={(event) => {
                              event.stopPropagation()
                              setUninstallTarget(item)
                            }}
                          >
                            {installingThis ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {item.installed && item.running === true ? (
                    <div className="inline-flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-300">
                      <span className="inline-block size-2 rounded-full bg-emerald-500" />
                      正常运行
                    </div>
                  ) : null}

                  <div className="space-y-2 text-sm">
                    <p className="font-mono text-[15px] leading-snug text-foreground/90">
                      {item.version || "未检测到版本"}
                    </p>
                    <div className="space-y-1.5 rounded-2xl bg-muted/20 px-4 py-3 text-[11px] text-muted-foreground dark:bg-white/[0.03]">
                      {item.portHint ? (
                        <p>
                          端口 <span className="font-medium text-foreground/80">{item.portHint}</span>
                        </p>
                      ) : null}
                      {typeof item.detail === "string" && item.detail !== "—" ? (
                        <p className="line-clamp-2 leading-5">{item.detail}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-auto">
                    {!item.installed ? (
                      <Button
                        type="button"
                        size="sm"
                        className="w-full rounded-xl"
                        disabled={isInstallingDependency || isDependencyServicePending}
                        onClick={(event) => {
                          event.stopPropagation()
                          void installDependency(connection, item.id)
                        }}
                      >
                        {installingThis ? (
                          <>
                            <LoaderCircle className="size-4 animate-spin" />
                            正在安装…
                          </>
                        ) : (
                          "安装"
                        )}
                      </Button>
                    ) : showService ? (
                      <div
                        className={cn(
                          "grid gap-2",
                          item.running === true ? "grid-cols-2" : "grid-cols-3",
                        )}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.running !== true ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl"
                            disabled={isInstallingDependency || isDependencyServicePending}
                            title="启动服务"
                            onClick={() => void runQuickAction(item, "start")}
                          >
                            {isDependencyServicePending && dependencyServicePendingKey === pendingKey("start") ? (
                              <LoaderCircle className="size-3.5 animate-spin" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                            启动
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={isInstallingDependency || isDependencyServicePending || item.running === false}
                          title={item.running === false ? "服务未在运行" : "停止服务"}
                          onClick={() => void runQuickAction(item, "stop")}
                        >
                          {isDependencyServicePending && dependencyServicePendingKey === pendingKey("stop") ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <Power className="size-3.5" />
                          )}
                          停止
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl"
                          disabled={isInstallingDependency || isDependencyServicePending}
                          onClick={() => void runQuickAction(item, "restart")}
                        >
                          {isDependencyServicePending && dependencyServicePendingKey === pendingKey("restart") ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          重启
                        </Button>
                      </div>
                    ) : (
                      <p className="text-center text-xs text-muted-foreground">运行环境已就绪，无独立服务需管理</p>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <Dialog open={Boolean(settingsTarget)} onOpenChange={(open) => !open && setSettingsTarget(null)}>
        <DialogContent className="max-w-2xl rounded-2xl border-border/80 bg-card p-0">
          {settingsTarget ? (
            <>
              <DialogHeader className="border-b border-border/70 px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2 text-left">
                    <DialogTitle className="text-xl">{settingsTarget.name} 设置</DialogTitle>
                    <DialogDescription className="max-w-xl leading-6">
                      {DESCRIPTIONS[settingsTarget.id] ?? "远程环境依赖项。"}
                    </DialogDescription>
                  </div>
                  <Badge variant="outline" className={cn("border", badgeFor(settingsTarget).className)}>
                    {badgeFor(settingsTarget).label}
                  </Badge>
                </div>
              </DialogHeader>

              <div className="grid gap-5 px-6 py-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-border/70 px-4 py-3">
                    <p className="text-xs text-muted-foreground">版本</p>
                    <p className="mt-2 font-mono text-sm text-foreground">{settingsTarget.version || "未检测到版本"}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 px-4 py-3">
                    <p className="text-xs text-muted-foreground">端口 / 提示</p>
                    <p className="mt-2 text-sm text-foreground">
                      {settingsTarget.portHint || settingsTarget.detail || "暂无额外提示"}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 px-4 py-3">
                  <p className="text-xs text-muted-foreground">检测命令</p>
                  <p className="mt-2 break-all font-mono text-xs leading-6 text-foreground/90">
                    {settingsTarget.command}
                  </p>
                </div>

                {typeof settingsTarget.detail === "string" && settingsTarget.detail !== "—" ? (
                  <div className="rounded-xl border border-border/70 px-4 py-3">
                    <p className="text-xs text-muted-foreground">当前状态补充</p>
                    <p className="mt-2 text-sm leading-6 text-foreground">{settingsTarget.detail}</p>
                  </div>
                ) : null}

                {settingsTarget.systemdUnit ? (
                  <div className="rounded-xl border border-border/70 px-4 py-3">
                    <p className="text-xs text-muted-foreground">systemd 单元</p>
                    <p className="mt-2 font-mono text-xs leading-6 text-foreground/90">{settingsTarget.systemdUnit}</p>
                  </div>
                ) : null}

                <div className="rounded-xl border border-border/70 px-4 py-3">
                  <p className="text-xs text-muted-foreground">操作提示</p>
                  <ul className="mt-2 grid gap-2 text-sm leading-6 text-foreground/90">
                    {supportNotes(settingsTarget).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>

                {settingsTarget.installed && DAEMON_IDS.has(settingsTarget.id) ? (
                  <div className="rounded-xl border border-border/70 px-4 py-3">
                    <p className="text-xs text-muted-foreground">服务动作</p>
                    <div
                      className={cn(
                        "mt-3 grid gap-2",
                        settingsTarget.running === true ? "grid-cols-2" : "grid-cols-3",
                      )}
                    >
                      {settingsTarget.running !== true ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-lg"
                          disabled={isInstallingDependency || isDependencyServicePending}
                          onClick={() => void runQuickAction(settingsTarget, "start")}
                        >
                          {isDependencyServicePending && dependencyServicePendingKey === `${settingsTarget.id}-start` ? (
                            <LoaderCircle className="size-4 animate-spin" />
                          ) : (
                            <Play className="size-4" />
                          )}
                          启动
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={isInstallingDependency || isDependencyServicePending || settingsTarget.running === false}
                        onClick={() => void runQuickAction(settingsTarget, "stop")}
                      >
                        {isDependencyServicePending && dependencyServicePendingKey === `${settingsTarget.id}-stop` ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Power className="size-4" />
                        )}
                        停止
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="rounded-lg"
                        disabled={isInstallingDependency || isDependencyServicePending}
                        onClick={() => void runQuickAction(settingsTarget, "restart")}
                      >
                        {isDependencyServicePending && dependencyServicePendingKey === `${settingsTarget.id}-restart` ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                        重启
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>

              <DialogFooter className="border-t border-border/70 px-6 py-4">
                {settingsTarget.installed ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={isInstallingDependency || isDependencyServicePending}
                    onClick={() => setUninstallTarget(settingsTarget)}
                  >
                    <Trash2 className="size-4" />
                    卸载
                  </Button>
                ) : null}
                <Button type="button" variant="secondary" className="rounded-lg" onClick={() => setSettingsTarget(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent className="max-w-lg rounded-2xl border-border/80 bg-card">
          {uninstallTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>卸载 {uninstallTarget.name}</DialogTitle>
                <DialogDescription className="leading-6">
                  将通过远程包管理器卸载这个依赖，并在支持的情况下先停止相关服务。这个动作可能影响现有项目运行。
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 text-sm text-foreground/90">
                <div className="rounded-xl border border-border/70 px-4 py-3">
                  <p className="text-xs text-muted-foreground">当前状态</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn("border", badgeFor(uninstallTarget).className)}>
                      {badgeFor(uninstallTarget).label}
                    </Badge>
                    {uninstallTarget.portHint ? (
                      <span className="text-xs text-muted-foreground">端口 {uninstallTarget.portHint}</span>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 px-4 py-3">
                  <p className="text-xs text-muted-foreground">卸载前确认</p>
                  <ul className="mt-2 grid gap-2 leading-6">
                    {supportNotes(uninstallTarget).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl border border-border/70 px-4 py-3">
                  <p className="text-xs text-muted-foreground">项目使用分析</p>
                  {isUsageLoading ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                      正在扫描当前主机关联项目…
                    </div>
                  ) : usageReport && usageReport.projects.length > 0 ? (
                    <div className="mt-3 grid gap-3">
                      <p className="text-sm text-destructive">
                        检测到 {usageReport.projects.length} 个项目可能依赖 {uninstallTarget.name}，卸载前请确认这些项目已经迁移或停用。
                      </p>
                      {usageReport.projects.map((project) => (
                        <div key={project.projectId} className="rounded-lg border border-border/70 px-3 py-3">
                          <div className="flex flex-col gap-1">
                            <p className="text-sm font-medium text-foreground">{project.displayName}</p>
                            <p className="text-[11px] text-muted-foreground">{project.localPath}</p>
                          </div>
                          <ul className="mt-2 grid gap-1 text-xs leading-5 text-foreground/85">
                            {project.reasons.map((reason) => (
                              <li key={reason}>- {reason}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      当前没有扫描到明确依赖这个组件的本地项目，可以继续卸载。
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="secondary" className="rounded-lg" onClick={() => setUninstallTarget(null)}>
                  取消
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="rounded-lg"
                  disabled={isInstallingDependency || isDependencyServicePending || isUsageLoading}
                  onClick={() => void confirmUninstall()}
                >
                  {isInstallingDependency && installingDependencyId === uninstallTarget.id ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      正在卸载…
                    </>
                  ) : (
                    <>
                      <Trash2 className="size-4" />
                      确认卸载
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
