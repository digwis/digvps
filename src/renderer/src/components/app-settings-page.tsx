import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Check, DatabaseBackup, FolderOpen, Globe, LoaderCircle, MonitorSmartphone, Moon, Palette, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { getDesktopApi } from "@/lib/desktop-api"
import { cn } from "@/lib/utils"
import { useThemeStore, type Theme } from "@/store/theme-store"
import { useLocaleStore, SUPPORTED_LOCALES, type Locale } from "@/store/locale-store"
import { useSettingsStore } from "@/store/settings-store"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type SettingsSection = "appearance" | "language" | "remote"

const SECTION_KEYS: Array<SettingsSection> = ["appearance", "language", "remote"]

const SECTION_ICONS: Record<SettingsSection, typeof Palette> = {
  appearance: Palette,
  language: Globe,
  remote: FolderOpen,
}

export function AppSettingsPage({ onExit }: { onExit: () => void }) {
  const { t } = useTranslation()
  const { theme, resolvedTheme, setTheme } = useThemeStore()
  const { locale, setLocale } = useLocaleStore()
  const { defaultRemoteDirectory, setDefaultRemoteDirectory } = useSettingsStore()
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance")
  const [remoteDirectoryDraft, setRemoteDirectoryDraft] = useState(defaultRemoteDirectory)
  const [remoteDirectorySaving, setRemoteDirectorySaving] = useState(false)
  const [backupSaving, setBackupSaving] = useState(false)
  const [projectCount, setProjectCount] = useState(0)

  useEffect(() => {
    setRemoteDirectoryDraft(defaultRemoteDirectory)
  }, [defaultRemoteDirectory])

  const saveDefaultRemoteDirectory = async () => {
    const value = remoteDirectoryDraft.trim()
    if (!value) {
      toast({
        variant: "destructive",
        title: t("settings.remote.emptyPathTitle"),
        description: t("settings.remote.emptyPathDesc"),
      })
      return
    }
    if (!value.startsWith("/")) {
      toast({
        variant: "destructive",
        title: t("settings.remote.relativePathTitle"),
        description: t("settings.remote.relativePathDesc"),
      })
      return
    }
    setRemoteDirectorySaving(true)
    try {
      await setDefaultRemoteDirectory(value)
      toast({
        title: t("settings.remote.savedTitle"),
        description: t("settings.remote.savedDesc", { path: value }),
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("settings.remote.saveFailedTitle"),
        description: error instanceof Error ? error.message : t("settings.remote.saveFailedDesc"),
      })
    } finally {
      setRemoteDirectorySaving(false)
    }
  }

  const themeOptions = useMemo<Array<{
    value: Theme
    label: string
    description: string
    icon: typeof MonitorSmartphone
  }>>(() => [
    { value: "system", label: t("settings.appearance.options.system"), description: t("settings.appearance.options.systemDesc"), icon: MonitorSmartphone },
    { value: "light", label: t("settings.appearance.options.light"), description: t("settings.appearance.options.lightDesc"), icon: Sun },
    { value: "dark", label: t("settings.appearance.options.dark"), description: t("settings.appearance.options.darkDesc"), icon: Moon },
  ], [t])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/60 bg-sidebar/95 px-3 pb-6 pt-8 dark:border-white/10">
        <button
          type="button"
          onClick={onExit}
          className="mb-6 flex h-11 items-center gap-3 rounded-xl px-3 text-left text-muted-foreground transition hover:bg-background/40 hover:text-foreground dark:hover:bg-white/5"
        >
          <ArrowLeft className="size-5 shrink-0" />
          <span className="text-[15px] font-medium">{t("common.back")}</span>
        </button>

        <nav className="flex flex-col gap-1">
          <div className="px-3 pb-2 text-[12px] font-medium text-muted-foreground/75">{t("settings.title")}</div>
          {SECTION_KEYS.map((key) => {
            const Icon = SECTION_ICONS[key]
            const active = key === activeSection
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveSection(key)}
                className={cn(
                  "flex items-start gap-3 rounded-xl px-3 py-3 text-left transition",
                  active
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border/60 dark:bg-white/10 dark:shadow-none dark:ring-white/10"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground dark:hover:bg-white/5",
                )}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-foreground/80" : "opacity-70")} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(`settings.section.${key}`)}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {key === "appearance" && t("settings.appearance.themeMode")}
                    {key === "language" && t("settings.language.displayLanguage")}
                    {key === "remote" && t("settings.remote.defaultDirectory")}
                  </div>
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
                <h3 className="text-3xl font-semibold text-foreground">{t("settings.appearance.title")}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("settings.appearance.subtitle", {
                    theme: t(resolvedTheme === "dark" ? "settings.appearance.themeDark" : "settings.appearance.themeLight"),
                  })}
                </p>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t("settings.appearance.themeMode")}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t("settings.appearance.themeModeDesc")}</p>
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
                      <p className="text-sm font-medium text-foreground">{t("settings.appearance.quickSwitch")}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{t("settings.appearance.quickSwitchDesc")}</p>
                    </div>
                    <Button type="button" variant="outline" className="rounded-xl" onClick={() => setTheme("system")}>
                      {t("settings.appearance.followSystem")}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : activeSection === "language" ? (
            <>
              <div className="mb-8">
                <h3 className="text-3xl font-semibold text-foreground">{t("settings.language.title")}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{t("settings.language.subtitle")}</p>
              </div>

              <div className="space-y-6">
                <div className="grid gap-4 xl:grid-cols-2">
                  {SUPPORTED_LOCALES.map((code) => {
                    const selected = code === locale
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setLocale(code as Locale)}
                        className={cn(
                          "relative min-h-[180px] rounded-3xl border p-6 text-left transition",
                          selected
                            ? "border-primary/40 bg-primary/[0.07] shadow-sm ring-1 ring-primary/20 dark:border-white/15 dark:bg-white/[0.08] dark:shadow-none dark:ring-white/10"
                            : "border-border/70 bg-background hover:border-border hover:bg-muted/20 dark:border-white/10 dark:bg-white/[0.02] dark:hover:bg-white/[0.05]",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground dark:bg-white/10">
                            <Globe className="size-5" />
                          </div>
                          {selected ? (
                            <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-4" />
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-8">
                          <div className="text-xl font-semibold text-foreground">{t(`settings.language.options.${code}`)}</div>
                          <div className="mt-2 text-sm leading-7 text-muted-foreground">{code}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="mb-8">
                <h3 className="text-3xl font-semibold text-foreground">{t("settings.remote.title")}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{t("settings.remote.subtitle")}</p>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="default-remote-directory" className="text-sm font-medium text-foreground">
                      {t("settings.remote.defaultDirectory")}
                    </Label>
                    <p className="mt-1 text-sm text-muted-foreground">{t("settings.remote.defaultDirectoryDesc")}</p>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Input
                      id="default-remote-directory"
                      className="h-11 flex-1 rounded-xl font-mono text-sm"
                      value={remoteDirectoryDraft}
                      placeholder={t("settings.remote.defaultDirectoryPlaceholder")}
                      onChange={(event) => setRemoteDirectoryDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          void saveDefaultRemoteDirectory()
                        }
                      }}
                    />
                    <Button
                      type="button"
                      className="h-11 rounded-xl px-6"
                      disabled={remoteDirectorySaving || remoteDirectoryDraft.trim() === defaultRemoteDirectory}
                      onClick={() => void saveDefaultRemoteDirectory()}
                    >
                      {remoteDirectorySaving ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        t("common.save")
                      )}
                    </Button>
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
