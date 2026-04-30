import { useMemo, useState } from "react"
import { BadgeAlert, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { RemoteServiceStatus } from "../../../shared/vps"

type Props = {
  services: RemoteServiceStatus[]
}

function serviceTone(service: RemoteServiceStatus) {
  if (service.active === "active" && service.sub === "running") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (service.active === "failed") {
    return "bg-destructive/10 text-destructive"
  }
  if (service.active === "activating" || service.active === "reloading" || service.sub === "auto-restart") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  return "bg-muted text-muted-foreground"
}

function sortServices(services: RemoteServiceStatus[]) {
  const rank = (service: RemoteServiceStatus) => {
    if (service.active === "failed") {
      return 0
    }
    if (service.active === "active" && service.sub === "running") {
      return 1
    }
    if (service.active === "active") {
      return 2
    }
    return 3
  }

  return [...services].sort((left, right) => {
    const delta = rank(left) - rank(right)
    if (delta !== 0) {
      return delta
    }
    return left.unit.localeCompare(right.unit)
  })
}

export function InspectionServiceBrowser({ services }: Props) {
  const [query, setQuery] = useState("")
  const visibleServices = useMemo(() => {
    const sorted = sortServices(services)
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) {
      return sorted
    }
    return sorted.filter((service) =>
      [service.unit, service.description, service.active, service.sub, service.load]
        .join(" ")
        .toLowerCase()
        .includes(trimmed),
    )
  }, [query, services])

  const runningCount = services.filter((service) => service.active === "active" && service.sub === "running").length
  const failedCount = services.filter((service) => service.active === "failed").length

  return (
    <div className="rounded-3xl bg-card/95 px-5 py-5 shadow-sm dark:bg-[#181818]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">服务浏览</p>
          <p className="mt-1 text-xs text-muted-foreground">基于 VPS 当前 `systemd` 服务清单，显示真实 active / sub 状态。</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-full bg-muted px-2.5 py-1 dark:bg-white/[0.06]">总计 {services.length}</span>
          <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
            运行中 {runningCount}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-1",
              failedCount > 0
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            异常 {failedCount}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 rounded-xl pl-9 dark:bg-white/[0.03]"
            placeholder="筛选 service 名称或描述"
          />
        </div>

        <div className="overflow-hidden rounded-2xl bg-background/40 dark:bg-white/[0.02]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>服务</TableHead>
                <TableHead className="w-[120px]">状态</TableHead>
                <TableHead className="w-[120px]">子状态</TableHead>
                <TableHead className="w-[120px]">加载</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleServices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                    {services.length === 0 ? "当前主机没有返回 systemd 服务清单" : "没有匹配的服务"}
                  </TableCell>
                </TableRow>
              ) : (
                visibleServices.map((service) => (
                  <TableRow key={service.unit}>
                    <TableCell className="font-mono text-xs text-foreground">{service.unit}</TableCell>
                    <TableCell>
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px]", serviceTone(service))}>
                        {service.active}
                      </span>
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{service.sub}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{service.load}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="flex items-start gap-2">
                        {service.active === "failed" ? (
                          <BadgeAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                        ) : null}
                        <span>{service.description || "-"}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
