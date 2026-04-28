import { Check, MonitorSmartphone, Moon, Palette, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useThemeStore, type Theme } from "@/store/theme-store"

type SettingsSection = "appearance"

const sections: Array<{ key: SettingsSection; label: string; description: string; icon: typeof Palette }> = [
  { key: "appearance", label: "外观", description: "主题与界面显示", icon: Palette },
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

export function AppSettingsPage() {
  const { theme, resolvedTheme, setTheme } = useThemeStore()
  const activeSection: SettingsSection = "appearance"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-xl font-semibold text-foreground">设置</h3>
        <p className="text-sm text-muted-foreground">集中管理界面外观与应用偏好。</p>
      </div>

      <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-border/70 bg-card/70 p-2 shadow-sm">
          <nav className="flex flex-col gap-1">
            {sections.map((section) => {
              const active = section.key === activeSection
              return (
                <button
                  key={section.key}
                  type="button"
                  className={cn(
                    "flex items-start gap-3 rounded-xl px-3 py-3 text-left transition",
                    active
                      ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
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

        <section className="rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="border-b border-border/70 px-5 py-4">
            <h4 className="text-base font-semibold text-foreground">外观</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              主题选择会立即生效，当前界面正在使用 {resolvedTheme === "dark" ? "深色" : "浅色"} 外观。
            </p>
          </div>

          <div className="space-y-6 px-5 py-5">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-foreground">主题模式</p>
                <p className="mt-1 text-sm text-muted-foreground">可在跟随系统、固定浅色、固定深色之间切换。</p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {themeOptions.map((option) => {
                  const selected = option.value === theme
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTheme(option.value)}
                      className={cn(
                        "relative rounded-2xl border p-4 text-left transition",
                        selected
                          ? "border-primary/40 bg-primary/[0.07] shadow-sm ring-1 ring-primary/20"
                          : "border-border/70 bg-background hover:border-border hover:bg-muted/20",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground">
                          <option.icon className="size-4" />
                        </div>
                        {selected ? (
                          <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="size-3.5" />
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-4">
                        <div className="text-sm font-medium text-foreground">{option.label}</div>
                        <div className="mt-1 text-sm leading-6 text-muted-foreground">{option.description}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-4">
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
        </section>
      </div>
    </div>
  )
}
