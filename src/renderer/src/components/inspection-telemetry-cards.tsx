import { useMemo } from "react"
import { useTranslation } from "react-i18next"
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

export function InspectionTelemetryCards({
  telemetry,
  metrics,
}: Props) {
  const { t } = useTranslation()
  const coreCount = metricValue(metrics, "逻辑核心") ?? "?"
  const items: MetricCard[] = useMemo(() => [
    {
      key: "cpu",
      label: "CPU",
      value: `${telemetry.cpuPercent.toFixed(1)}%`,
      detail: `${t("monitor.metric.cpuCores", { count: coreCount })} · ${metricValue(metrics, t("monitor.metric.cpu")) ?? t("monitor.metric.sample1s")}`,
      percent: telemetry.cpuPercent,
      icon: Cpu,
      priority: "primary",
    },
    {
      key: "memory",
      label: t("monitor.metric.memory"),
      value: `${telemetry.memoryPercent.toFixed(1)}%`,
      detail: metricValue(metrics, t("monitor.metric.memUsage")) ?? "-",
      percent: telemetry.memoryPercent,
      icon: ServerCog,
      priority: "primary",
    },
    {
      key: "disk",
      label: t("monitor.metric.disk"),
      value: `${telemetry.diskPercent.toFixed(1)}%`,
      detail: metricValue(metrics, t("monitor.metric.systemDisk")) ?? "-",
      percent: telemetry.diskPercent,
      icon: HardDrive,
      priority: "primary",
    },
    {
      key: "network",
      label: t("monitor.metric.network"),
      value: `${formatBps(telemetry.netUpBps)} / ${formatBps(telemetry.netDownBps)}`,
      detail: t("monitor.metric.netUpDown"),
      icon: Network,
      priority: "primary",
    },
    {
      key: "load",
      label: t("monitor.metric.load"),
      value: `${telemetry.loadPercent.toFixed(1)}%`,
      detail: t("monitor.metric.loadAvg", { count: coreCount }),
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
  ], [telemetry, metrics, t, coreCount])

  const primaryItems = useMemo(() => items.filter((item) => item.priority === "primary"), [items])
  const secondaryItems = useMemo(() => items.filter((item) => item.priority === "secondary"), [items])

  return (
    <div className="rounded-[32px] border border-[#e5e7eb] bg-[#fbfcfe] px-8 py-8 shadow-[0_8px_24px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-[#242424] dark:shadow-none">
      <div className="mb-6">
        <p className="text-2xl font-semibold tracking-tight text-foreground">{t("monitor.coreMonitoring")}</p>
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
