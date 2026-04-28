import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Check, DatabaseBackup, LoaderCircle, MonitorSmartphone, Moon, Palette, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { getDesktopApi } from "@/lib/desktop-api"
import { cn } from "@/lib/utils"
import { useThemeStore, type Theme } from "@/store/theme-store"
import type { ProjectBackupSchedule } from "../../../shared/projects"

type SettingsSection = "appearance" | "backup"

const sections: Array<{ key: SettingsSection; label: string; description: string; icon: typeof Palette }> = [
  { key: "appearance", label: "外观", description: "主题与界面显示", icon: Palette },
  { key: "backup", label: "自动备份", description: "统一管理项目备份计划", icon: DatabaseBackup },
]

const themeOptions: Array<{
  value: Theme
  label: string
  description: string
  icon: typeof MonitorSmartphone
}> = [
  { value: "system", label: "跟随系统", description: "自动匹配 macOS 当前外观", icon: MonitorSmartphone },
  { value: "light", label: "浅色", description: "适合明亮环境和高可读性", icon: Sun },
  { value: "dark", label: "深色", description: "降低夜间使用时的眩光", icon: Moon },
]

function backupScheduleLabel(schedule: ProjectBackupSchedule) {
  if (schedule === "daily") {
    return "每天自动备份"
  }
  if (schedule === "weekly") {
    return "每周自动备份"
  }
  if (schedule === "monthly") {
    return "每月自动备份"
  }
  return "关闭自动备份"
}

export function AppSettingsPage({ onExit }: { onExit: () => void }) {
  const { theme, resolvedTheme, setTheme } = useThemeStore()
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance")
  const [backupSchedule, setBackupSchedule] = useState<ProjectBackupSchedule>("off")
  const [backupLoading, setBackupLoading] = useState(true)
  const [backupSaving, setBackupSaving] = useState(false)
  const [projectCount, setProjectCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const projects = await getDesktopApi().projects.listProjects()
        const schedules = await Promise.all(
          projects.map((project) => getDesktopApi().projects.getProjectBackupSchedule(project.id)),
        )
        if (cancelled) {
          return
        }
        setProjectCount(projects.length)
        const unique = Array.from(new Set(schedules.map((item) => item.schedule)))
        setBackupSchedule(unique.length === 1 ? unique[0]! : "off")
      } catch {
        if (!cancelled) {
          setProjectCount(0)
          setBackupSchedule("off")
        }
      } finally {
        if (!cancelled) {
          setBackupLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const backupSummary = useMemo(() => backupScheduleLabel(backupSchedule), [backupSchedule])

  const saveBackupSchedule = async (schedule: ProjectBackupSchedule) => {
    setBackupSchedule(schedule)
    setBackupSaving(true)
    try {
      const projects = await getDesktopApi().projects.listProjects()
      await Promise.all(
        projects.map((project) =>
          getDesktopApi().projects.setProjectBackupSchedule({ projectId: project.id, schedule }),
        ),
      )
      setProjectCount(projects.length)
      toast({
        title: "自动备份已更新",
        description: projects.length === 0 ? "当前没有项目可应用" : `已对 ${projects.length} 个项目应用${backupScheduleLabel(schedule)}`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "自动备份设置失败",
        description: error instanceof Error ? error.message : "无法更新自动备份设置",
      })
    } finally {
      setBackupSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-[28px] border border-border/60 bg-background dark:border-white/10">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/60 bg-sidebar/95 px-3 pb-6 pt-8 dark:border-white/10">
        <button
          type="button"
          onClick={onExit}
          className="mb-6 flex h-11 items-center gap-3 rounded-xl px-3 text-left text-muted-foreground transition hover:bg-background/40 hover:text-foreground dark:hover:bg-white/5"
        >
          <ArrowLeft className="size-5 shrink-0" />
          <span className="text-[15px] font-medium">返回应用</span>
        </button>

        <nav className="flex flex-col gap-1">
          <div className="px-3 pb-2 text-[12px] font-medium text-muted-foreground/75">设置</div>
          {sections.map((section) => {
            const active = section.key === activeSection
            return (
              <button
                key={section.key}
                type="button"
                onClick={() => setActiveSection(section.key)}
                className={cn(
                  "flex items-start gap-3 rounded-xl px-3 py-3 text-left transition",
                  active
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border/60 dark:bg-white/10 dark:shadow-none dark:ring-white/10"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground dark:hover:bg-white/5",
                )}
              >
                <section.icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-foreground/80" : "opacity-70")} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{section.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{section.description}</div>
                </div>
              </button>
            )
          })}
        </nav>
      </aside>

      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col px-8 py-10 lg:px-10">
          {activeSection === "appearance" ? (
            <>
              <div className="mb-8">
                <h3 className="text-3xl font-semibold text-foreground">外观</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  主题选择会立即生效，当前界面正在使用 {resolvedTheme === "dark" ? "深色" : "浅色"} 外观。
                </p>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">主题模式</p>
                    <p className="mt-1 text-sm text-muted-foreground">可在跟随系统、固定浅色、固定深色之间切换。</p>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-3">
                    {themeOptions.map((option) => {
                      const selected = option.value === theme
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setTheme(option.value)}
                          className={cn(
                            "relative min-h-[240px] rounded-3xl border p-6 text-left transition",
                            selected
                              ? "border-primary/40 bg-primary/[0.07] shadow-sm ring-1 ring-primary/20 dark:border-white/15 dark:bg-white/[0.08] dark:shadow-none dark:ring-white/10"
                              : "border-border/70 bg-background hover:border-border hover:bg-muted/20 dark:border-white/10 dark:bg-white/[0.02] dark:hover:bg-white/[0.05]",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground dark:bg-white/10">
                              <option.icon className="size-5" />
                            </div>
                            {selected ? (
                              <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="size-4" />
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-8">
                            <div className="text-xl font-semibold text-foreground">{option.label}</div>
                            <div className="mt-2 text-sm leading-7 text-muted-foreground">{option.description}</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-3xl border border-border/70 bg-muted/20 px-5 py-5 dark:border-white/10 dark:bg-white/[0.03]">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">快速切换</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        顶部工具栏按钮会在浅色和深色之间快速切换；需要恢复自动模式时，在这里重新选中跟随系统。
                      </p>
                    </div>
                    <Button type="button" variant="outline" className="rounded-xl" onClick={() => setTheme("system")}>
                      跟随系统
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="mb-8">
                <h3 className="text-3xl font-semibold text-foreground">自动备份</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  在这里统一设置项目自动备份频率。设置后会立即作用到当前已接入的项目。
                </p>
              </div>

              <div className="space-y-6">
                <div className="grid gap-4 rounded-3xl border border-border/70 bg-background p-5 dark:border-white/10 dark:bg-white/[0.02] md:grid-cols-[minmax(0,240px)_1fr] md:items-start">
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium text-foreground">统一备份频率</p>
                    <Select value={backupSchedule} onValueChange={(value) => void saveBackupSchedule(value as ProjectBackupSchedule)}>
                      <SelectTrigger className="h-10 rounded-xl text-sm shadow-none" disabled={backupLoading || backupSaving}>
                        <SelectValue placeholder="选择自动备份频率" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">关闭自动备份</SelectItem>
                        <SelectItem value="daily">每天备份</SelectItem>
                        <SelectItem value="weekly">每周备份</SelectItem>
                        <SelectItem value="monthly">每月备份</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p>当前状态：{backupLoading ? "读取中" : backupSummary}</p>
                    <p>作用范围：{projectCount} 个项目</p>
                    <p>项目卡片里不再单独设置自动备份，设置后的计划会由后台定时任务自动执行。</p>
                    {backupSaving ? (
                      <div className="inline-flex items-center gap-2 text-foreground">
                        <LoaderCircle className="size-4 animate-spin" />
                        正在应用到项目…
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
