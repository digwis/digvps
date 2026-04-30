import { Activity, Cpu, HardDrive, Network, ServerCog, Waves } from "lucide-react"
import { cn } from "@/lib/utils"
import type { InspectionTelemetry, SystemMetric } from "../../../shared/vps"

function metricValue(metrics: SystemMetric[], label: string) {
  return metrics.find((m) => m.label === label)?.value
}

function formatBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) {
    return "0 B/s"
  }
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"]
  let v = bps
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const digits = v >= 10 || i === 0 ? 0 : 1
  return `${v.toFixed(digits)} ${units[i]}`
}

function progressTone(percent: number) {
  if (percent >= 85) {
    return "bg-red-400"
  }
  if (percent >= 65) {
    return "bg-amber-400"
  }
  return "bg-emerald-400"
}

type MetricCard = {
  key: string
  label: string
  value: string
  detail: string
  percent?: number
  icon: typeof Cpu
  priority: "primary" | "secondary"
}

type Props = {
  telemetry: InspectionTelemetry
  metrics: SystemMetric[]
}

export function InspectionTelemetryCards({ telemetry, metrics }: Props) {
  const coreCount = metricValue(metrics, "逻辑核心") ?? "?"
  const items: MetricCard[] = [
    {
      key: "cpu",
      label: "CPU",
      value: `${telemetry.cpuPercent.toFixed(1)}%`,
      detail: `${coreCount} 核 · ${metricValue(metrics, "CPU") ?? "1s 采样"}`,
      percent: telemetry.cpuPercent,
      icon: Cpu,
      priority: "primary",
    },
    {
      key: "memory",
      label: "内存",
      value: `${telemetry.memoryPercent.toFixed(1)}%`,
      detail: metricValue(metrics, "内存占用") ?? "-",
      percent: telemetry.memoryPercent,
      icon: ServerCog,
      priority: "primary",
    },
    {
      key: "disk",
      label: "磁盘",
      value: `${telemetry.diskPercent.toFixed(1)}%`,
      detail: metricValue(metrics, "系统盘") ?? "-",
      percent: telemetry.diskPercent,
      icon: HardDrive,
      priority: "primary",
    },
    {
      key: "network",
      label: "网络",
      value: `${formatBps(telemetry.netUpBps)} / ${formatBps(telemetry.netDownBps)}`,
      detail: "上行 / 下行",
      icon: Network,
      priority: "primary",
    },
    {
      key: "load",
      label: "负载",
      value: `${telemetry.loadPercent.toFixed(1)}%`,
      detail: `1m 平均 / ${coreCount} 核`,
      percent: telemetry.loadPercent,
      icon: Activity,
      priority: "secondary",
    },
    {
      key: "inode",
      label: "inode",
      value: `${telemetry.inodePercent.toFixed(1)}%`,
      detail: metricValue(metrics, "inode") ?? "-",
      percent: telemetry.inodePercent,
      icon: Waves,
      priority: "secondary",
    },
  ]

  const primaryItems = items.filter((item) => item.priority === "primary")
  const secondaryItems = items.filter((item) => item.priority === "secondary")

  return (
    <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
      <div className="mb-6">
        <p className="text-2xl font-semibold tracking-tight text-foreground">核心监控</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        {primaryItems.map((item) => (
          <div
            key={item.key}
            className="rounded-3xl border border-[#e5e7eb] bg-[#f4f7fb] px-5 py-5 dark:border-transparent dark:bg-[#2b2b2b]"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <item.icon className="size-4" />
                {item.label}
              </div>
              {typeof item.percent === "number" ? (
                <span className="text-[12px] text-muted-foreground">{item.percent.toFixed(0)}%</span>
              ) : null}
            </div>
            <p className="mt-5 text-3xl font-semibold tracking-tight text-foreground">{item.value}</p>
            <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
            {typeof item.percent === "number" ? (
              <div className="mt-5 h-2 rounded-full bg-black/8 dark:bg-white/8">
                <div
                  className={cn("h-2 rounded-full transition-all", progressTone(item.percent))}
                  style={{ width: `${Math.max(6, Math.min(100, item.percent))}%` }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {secondaryItems.map((item) => (
          <div key={item.key} className="rounded-3xl border border-[#e5e7eb] bg-[#f4f7fb] px-5 py-4 dark:border-transparent dark:bg-[#2b2b2b]">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <item.icon className="size-4" />
                {item.label}
              </div>
              <span className="text-xl font-semibold text-foreground">{item.value}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
