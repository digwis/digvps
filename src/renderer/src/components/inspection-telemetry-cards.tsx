import type { InspectionTelemetry, SystemMetric } from "../../../shared/vps"
import { cn } from "@/lib/utils"

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

/** 将下行+上行速率映射为 0–100，约 1MiB/s 合计视为跑满（仅作活动度示意） */
function networkActivityPercent(down: number, up: number): number {
  const sum = down + up
  if (!Number.isFinite(sum) || sum <= 0) {
    return 0
  }
  return Math.min(100, (sum / (1024 * 1024)) * 100)
}

function bandwidthUsagePercent(down: number, up: number, bandwidthMbps?: number): number | undefined {
  if (!Number.isFinite(bandwidthMbps) || (bandwidthMbps ?? 0) <= 0) {
    return undefined
  }
  const capBytesPerSecond = ((bandwidthMbps ?? 0) * 1_000_000) / 8
  if (capBytesPerSecond <= 0) {
    return undefined
  }
  return Math.min(100, ((down + up) / capBytesPerSecond) * 100)
}

function RingGauge({ percent, className }: { percent: number; className?: string }) {
  const p = Math.min(100, Math.max(0, percent))
  const r = 34
  const c = 2 * Math.PI * r
  const offset = c - (p / 100) * c
  return (
    <svg viewBox="0 0 84 84" className={cn("size-[5.25rem] shrink-0", className)} aria-hidden>
      <circle cx="42" cy="42" r={r} fill="none" className="stroke-border/50" strokeWidth="7" />
      <circle
        cx="42"
        cy="42"
        r={r}
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        className="text-current transition-[stroke-dashoffset] duration-500 ease-out"
        stroke="currentColor"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 42 42)"
      />
    </svg>
  )
}

type CardTone = {
  ring: string
  surface: string
}

const tones: Record<"cpu" | "mem" | "disk" | "net" | "load" | "inode", CardTone> = {
  cpu: {
    ring: "text-sky-600 dark:text-sky-400",
    surface: "from-sky-500/[0.10] via-background to-background dark:from-sky-400/[0.12]",
  },
  mem: {
    ring: "text-emerald-600 dark:text-emerald-400",
    surface: "from-emerald-500/[0.10] via-background to-background dark:from-emerald-400/[0.12]",
  },
  disk: {
    ring: "text-amber-600 dark:text-amber-400",
    surface: "from-amber-500/[0.10] via-background to-background dark:from-amber-400/[0.12]",
  },
  net: {
    ring: "text-violet-600 dark:text-violet-400",
    surface: "from-violet-500/[0.10] via-background to-background dark:from-violet-400/[0.12]",
  },
  load: {
    ring: "text-orange-600 dark:text-orange-400",
    surface: "from-orange-500/[0.10] via-background to-background dark:from-orange-400/[0.12]",
  },
  inode: {
    ring: "text-slate-600 dark:text-slate-400",
    surface: "from-slate-500/[0.10] via-background to-background dark:from-slate-400/[0.12]",
  },
}

type Props = {
  telemetry: InspectionTelemetry
  metrics: SystemMetric[]
  checkedAt: string
}

export function InspectionTelemetryCards({ telemetry, metrics, checkedAt }: Props) {
  const netPct = networkActivityPercent(telemetry.netDownBps, telemetry.netUpBps)
  const sampledAtText = new Date(checkedAt).toLocaleTimeString()
  const cpuExtras = [
    telemetry.cpuStealPercent >= 0.1 ? `steal ${telemetry.cpuStealPercent.toFixed(1)}%` : "",
    telemetry.cpuIowaitPercent >= 0.1 ? `iowait ${telemetry.cpuIowaitPercent.toFixed(1)}%` : "",
  ]
    .filter(Boolean)
    .join("  ")

  const cards: Array<{
    key: string
    title: string
    percent: number
    tone: keyof typeof tones
    footer?: string
    extra?: string
  }> = [
    {
      key: "cpu",
      title: "CPU 使用率",
      percent: telemetry.cpuPercent,
      tone: "cpu",
      extra: cpuExtras || undefined,
      footer: metricValue(metrics, "CPU"),
    },
    {
      key: "mem",
      title: "内存使用率",
      percent: telemetry.memoryPercent,
      tone: "mem",
      footer: metricValue(metrics, "内存占用"),
    },
    {
      key: "disk",
      title: "磁盘使用率",
      percent: telemetry.diskPercent,
      tone: "disk",
      footer: metricValue(metrics, "系统盘"),
    },
    {
      key: "net",
      title: "网络流量",
      percent: netPct,
      tone: "net",
      extra: `↑ ${formatBps(telemetry.netUpBps)}  ↓ ${formatBps(telemetry.netDownBps)}`,
    },
    {
      key: "inode",
      title: "inode 使用率",
      percent: telemetry.inodePercent,
      tone: "inode",
      footer: metricValue(metrics, "inode"),
    },
    {
      key: "load",
      title: "系统负载",
      percent: telemetry.loadPercent,
      tone: "load",
      footer: `1m / ${metricValue(metrics, "逻辑核心") ?? "?"} 核`,
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {cards.map((item) => {
        const t = tones[item.tone]
        return (
          <div
            key={item.key}
            className={cn(
              "flex flex-col items-center gap-2 rounded-2xl border border-border/80 bg-gradient-to-b p-4 text-center shadow-sm",
              t.surface,
            )}
          >
            <p className="text-[13px] font-medium leading-tight text-foreground">{item.title}</p>
            <div className={cn("relative grid place-items-center", t.ring)}>
              <RingGauge percent={item.percent} />
              <span className="absolute text-lg font-semibold tabular-nums tracking-tight text-foreground">
                {item.percent.toFixed(1)}%
              </span>
            </div>
            {item.extra ? (
              <p className="text-[11px] leading-snug text-muted-foreground">{item.extra}</p>
            ) : null}
            {item.footer ? (
              <p className="line-clamp-2 w-full px-1 text-[11px] leading-snug text-muted-foreground">{item.footer}</p>
            ) : (
              <div className="min-h-[2rem]" />
            )}
            <p className="text-[11px] font-medium text-muted-foreground/90">采样 {sampledAtText}</p>
          </div>
        )
      })}
    </div>
  )
}
