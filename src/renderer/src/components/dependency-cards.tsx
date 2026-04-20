import { LoaderCircle, Play, Power, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  DependencyServiceAction,
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

function watermarkLetter(name: string): string {
  const m = name.match(/[A-Za-z0-9]/)
  return m ? m[0].toUpperCase() : name.charAt(0).toUpperCase()
}

function badgeFor(item: RemotePackageStatus): { label: string; className: string } {
  if (!item.installed) {
    return { label: "未安装", className: "border-border bg-muted/80 text-muted-foreground" }
  }
  if (!DAEMON_IDS.has(item.id)) {
    return {
      label: "已就绪",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    }
  }
  if (item.running === true) {
    return {
      label: "运行中",
      className: "border-emerald-500/35 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
    }
  }
  if (item.running === false) {
    return {
      label: "已安装 · 未运行",
      className: "border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-100",
    }
  }
  return {
    label: "已安装",
    className: "border-border bg-secondary/80 text-secondary-foreground",
  }
}

function cardTone(item: RemotePackageStatus): string {
  if (!item.installed) {
    return "border-border/80 bg-muted/20 text-muted-foreground"
  }
  if (DAEMON_IDS.has(item.id) && item.running === true) {
    return "border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.07] to-card text-foreground"
  }
  return "border-border/80 bg-card/90 text-foreground"
}

export type DependencyCardsProps = {
  packages: RemotePackageStatus[]
  connection: VpsConnectionInput
  installDependency: (payload: VpsConnectionInput, id: string) => void
  dependencyServiceAction: (
    payload: VpsConnectionInput,
    options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
  ) => void
  isInstallingDependency: boolean
  installingDependencyId?: string
  isDependencyServicePending: boolean
  dependencyServicePendingKey?: string
}

export function DependencyCards({
  packages,
  connection,
  installDependency,
  dependencyServiceAction,
  isInstallingDependency,
  installingDependencyId,
  isDependencyServicePending,
  dependencyServicePendingKey,
}: DependencyCardsProps) {
  const busy = isInstallingDependency || isDependencyServicePending

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {packages.map((item) => {
        const badge = badgeFor(item)
        const isDaemon = DAEMON_IDS.has(item.id)
        const pendingKey = (action: DependencyServiceAction) => `${item.id}-${action}`
        const showService =
          item.installed &&
          isDaemon &&
          (item.id === "pm2" || item.id === "docker" || item.id === "nginx" || item.id === "postgresql")

        return (
          <div
            key={item.id}
            className={cn(
              "relative overflow-hidden rounded-2xl border p-4 shadow-sm transition-colors",
              cardTone(item),
            )}
          >
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-[5.5rem] font-bold leading-none text-foreground/[0.05] select-none dark:text-foreground/[0.06]"
              aria-hidden
            >
              {watermarkLetter(item.name)}
            </div>

            <div className="relative flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[15px] font-semibold tracking-tight">{item.name}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {DESCRIPTIONS[item.id] ?? "远程环境依赖项。"}
                  </p>
                </div>
                <Badge variant="outline" className={cn("shrink-0 border", badge.className)}>
                  {badge.label}
                </Badge>
              </div>

              <div className="space-y-1.5 text-sm">
                <p className="font-mono text-[13px] leading-snug text-foreground/90">
                  {item.version || "未检测到版本"}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {item.portHint ? (
                    <span>
                      端口 <span className="font-medium text-foreground/80">{item.portHint}</span>
                    </span>
                  ) : null}
                  {item.detail && item.detail !== "—" ? (
                    <span className="min-w-0 flex-1">{item.detail}</span>
                  ) : null}
                </div>
                <p className="font-mono text-[11px] text-muted-foreground/90">{item.command}</p>
              </div>

              {!item.installed ? (
                <Button
                  type="button"
                  size="sm"
                  className="mt-1 w-full rounded-lg"
                  disabled={busy}
                  onClick={() => installDependency(connection, item.id)}
                >
                  {isInstallingDependency && installingDependencyId === item.id ? (
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
                    "mt-1 grid gap-2",
                    item.running === true ? "grid-cols-2" : "grid-cols-3",
                  )}
                >
                  {item.running !== true ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg"
                      disabled={busy}
                      title="启动服务"
                      onClick={() =>
                        dependencyServiceAction(connection, {
                          dependencyId: item.id,
                          action: "start",
                          systemdUnit: item.systemdUnit,
                        })
                      }
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
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy || item.running === false}
                    title={item.running === false ? "服务未在运行" : "停止服务"}
                    onClick={() =>
                      dependencyServiceAction(connection, {
                        dependencyId: item.id,
                        action: "stop",
                        systemdUnit: item.systemdUnit,
                      })
                    }
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
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg"
                    disabled={busy}
                    onClick={() =>
                      dependencyServiceAction(connection, {
                        dependencyId: item.id,
                        action: "restart",
                        systemdUnit: item.systemdUnit,
                      })
                    }
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
                <p className="mt-1 text-center text-xs text-muted-foreground">运行环境已就绪，无独立服务需管理</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
