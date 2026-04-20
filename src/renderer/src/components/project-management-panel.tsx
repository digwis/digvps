import { useEffect, useMemo, useState } from "react"
import {
  ExternalLink,
  FilePenLine,
  FolderInput,
  FolderOpen,
  Globe,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { getDesktopApi } from "@/lib/desktop-api"
import { useProjectStore } from "@/store/project-store"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import type {
  LocalProjectRecord,
  ProjectDeployProfile,
  ProjectDeployStrategy,
  ProjectRemoteDetails,
  ProjectRemoteState,
} from "../../../shared/projects"
import type { VpsConnectionRecord } from "../../../shared/vps"

export type ProjectManagementPanelProps = {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
}

type DeployScriptOption = {
  value: string
  label: string
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function connectionLabel(connections: VpsConnectionRecord[], id?: string | null) {
  if (!id) {
    return ""
  }
  return connections.find((c) => c.id === id)?.name ?? id
}

function buildDeployScriptOptions(scripts: string[]): DeployScriptOption[] {
  const has = new Set(scripts)
  const options: DeployScriptOption[] = []
  const add = (names: string[], label: string) => {
    const match = names.find((name) => has.has(name))
    if (match && !options.some((item) => item.value === match)) {
      options.push({ value: match, label })
    }
  }

  add(["sync:vps:admin-data", "sync:vps"], "完整部署")
  add(["deploy:panel", "deploy:vps:code"], "部署代码")
  add(["backup:vps", "backup"], "备份远程数据")

  if (options.length === 0) {
    const fallback = scripts.slice(0, 4)
    return fallback.map((name, index) => ({
      value: name,
      label: `自定义动作 ${index + 1}`,
    }))
  }

  return options.slice(0, 4)
}

function ProjectDeployCard({
  project,
  connections,
  selectedConnectionId,
  isDeploying,
  deployingProjectId,
  isInitializing,
  initializingProjectId,
  onInitialize,
  onDeploy,
  onDelete,
}: {
  project: LocalProjectRecord
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
  isDeploying: boolean
  deployingProjectId?: string
  isInitializing: boolean
  initializingProjectId?: string
  onInitialize: (args: { connectionId: string }) => void
  onDeploy: (args: {
    connectionId: string
    strategy: ProjectDeployStrategy
    remoteParentPath?: string
    npmScript?: string
  }) => void
  onDelete: () => void
}) {
  const [connectionId, setConnectionId] = useState<string>(project.lastConnectionId ?? selectedConnectionId ?? "")
  const [remoteParent, setRemoteParent] = useState("")
  const [strategy, setStrategy] = useState<ProjectDeployStrategy>(
    project.lastDeployKind === "local-npm-script" ? "local-npm-script" : "sftp",
  )
  const [npmScripts, setNpmScripts] = useState<DeployScriptOption[]>([])
  const [npmScript, setNpmScript] = useState("")
  const [deployProfile, setDeployProfile] = useState<ProjectDeployProfile | null>(null)
  const [envOpen, setEnvOpen] = useState(false)
  const [envText, setEnvText] = useState("")
  const [envLoading, setEnvLoading] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)
  const [envError, setEnvError] = useState<string>()
  const [remoteState, setRemoteState] = useState<ProjectRemoteState | null>(null)
  const [remoteStateLoading, setRemoteStateLoading] = useState(false)
  const [initDialogOpen, setInitDialogOpen] = useState(false)
  const [remoteDetails, setRemoteDetails] = useState<ProjectRemoteDetails | null>(null)
  const [remoteDetailsLoading, setRemoteDetailsLoading] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserPath, setBrowserPath] = useState<string>()
  const [browserDetails, setBrowserDetails] = useState<ProjectRemoteDetails | null>(null)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [siteDomain, setSiteDomain] = useState("")
  const [sslEmail, setSslEmail] = useState("")
  const [certificatePem, setCertificatePem] = useState("")
  const [privateKeyPem, setPrivateKeyPem] = useState("")
  const [siteSaving, setSiteSaving] = useState(false)
  const [siteError, setSiteError] = useState<string>()
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState("")

  useEffect(() => {
    setConnectionId((current) => {
      if (project.lastConnectionId) {
        return project.lastConnectionId
      }
      if (!current && selectedConnectionId) {
        return selectedConnectionId
      }
      return current
    })
  }, [project.lastConnectionId, selectedConnectionId])

  useEffect(() => {
    if (project.lastDeployKind === "local-npm-script") {
      setStrategy("local-npm-script")
    } else if (project.lastDeployKind === "sftp") {
      setStrategy("sftp")
    }
  }, [project.lastDeployKind])

  useEffect(() => {
    let cancelled = false
    void getDesktopApi()
      .projects.getDeployProfile(project.id)
      .then((profile) => {
        if (cancelled) {
          return
        }
        setDeployProfile(profile)
        const scriptOptions = buildDeployScriptOptions(profile.npmScripts)
        setNpmScripts(scriptOptions)
        const nextStrategy =
          scriptOptions.length > 0
            ? "local-npm-script"
            : project.lastDeployKind === "local-npm-script" || project.lastDeployKind === "sftp"
              ? project.lastDeployKind
              : profile.recommendedStrategy
        setStrategy(nextStrategy)
        if (profile.recommendedNpmScript && scriptOptions.some((item) => item.value === profile.recommendedNpmScript)) {
          setNpmScript(profile.recommendedNpmScript)
        } else if (scriptOptions[0]) {
          setNpmScript(scriptOptions[0].value)
        } else {
          setNpmScript("")
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeployProfile(null)
          setNpmScripts([])
          setNpmScript("")
        }
      })
    return () => {
      cancelled = true
    }
  }, [project.id])

  useEffect(() => {
    if (!connectionId || !deployProfile?.canInitialize) {
      setRemoteState(null)
      setRemoteStateLoading(false)
      return
    }

    let cancelled = false
    setRemoteStateLoading(true)
    void getDesktopApi()
      .projects.getProjectRemoteState({
        projectId: project.id,
        connectionId,
      })
      .then((state) => {
        if (!cancelled) {
          setRemoteState(state)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRemoteState(null)
          toast({
            variant: "destructive",
            title: `${project.displayName} 检查失败`,
            description: error instanceof Error ? error.message : "无法检查远端初始化状态",
          })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteStateLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionId, deployProfile?.canInitialize, project.displayName, project.id])

  const effectiveRemoteAppDir = useMemo(
    () => project.lastRemotePath || deployProfile?.defaultRemoteAppDir || null,
    [deployProfile?.defaultRemoteAppDir, project.lastRemotePath],
  )

  const loadRemoteDetails = async (browseTarget?: string) => {
    if (!connectionId || !effectiveRemoteAppDir) {
      return null
    }
    return await getDesktopApi().projects.getProjectRemoteDetails({
      projectId: project.id,
      connectionId,
      browsePath: browseTarget,
    })
  }

  useEffect(() => {
    if (!connectionId || !effectiveRemoteAppDir) {
      setRemoteDetails(null)
      setRemoteDetailsLoading(false)
      return
    }

    let cancelled = false
    setRemoteDetailsLoading(true)
    void loadRemoteDetails()
      .then((details) => {
        if (!cancelled) {
          setRemoteDetails(details)
          setSiteDomain(details?.site.domain ?? "")
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRemoteDetails(null)
          toast({
            variant: "destructive",
            title: `${project.displayName} 远端详情读取失败`,
            description: error instanceof Error ? error.message : "无法读取远端项目详情",
          })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteDetailsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionId, effectiveRemoteAppDir, project.displayName, project.id, project.lastDeployAt])

  const busy = isDeploying && deployingProjectId === project.id
  const bootstrapping = isInitializing && initializingProjectId === project.id
  const success = project.lastDeployStatus === "success"
  const failed = project.lastDeployStatus === "failed"
  const hasScriptActions = strategy === "local-npm-script" && npmScripts.length > 0
  const selectedActionLabel =
    hasScriptActions
      ? npmScripts.find((item) => item.value === npmScript)?.label ?? "开始执行"
      : "部署代码"
  const initHint =
    remoteStateLoading
      ? "正在检查远端环境…"
      : remoteState && !remoteState.ready && remoteState.missingItems.length > 0
        ? `需要初始化：${remoteState.missingItems.join("、")}`
        : remoteState?.runtimeIssues.length
          ? `远端已初始化；${remoteState.runtimeIssues.join("、")}`
          : remoteState?.ready
            ? "远端已初始化"
            : deployProfile?.canInitialize
              ? "可执行远端初始化"
              : undefined
  const shouldShowInitializeButton =
    Boolean(deployProfile?.canInitialize) && !remoteStateLoading && !remoteState?.ready
  const remoteRuntimeHint = remoteDetails?.service.configured
    ? remoteDetails.service.active
      ? "服务运行中"
      : "服务未启动"
    : "未配置远端服务"

  const refreshRemoteDetails = async () => {
    if (!effectiveRemoteAppDir || !connectionId) {
      return
    }
    setRemoteDetailsLoading(true)
    setSiteError(undefined)
    try {
      const details = await loadRemoteDetails()
      setRemoteDetails(details)
      if (details) {
        setSiteDomain(details.site.domain ?? "")
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 刷新失败`,
        description: error instanceof Error ? error.message : "无法刷新远端项目状态",
      })
    } finally {
      setRemoteDetailsLoading(false)
    }
  }

  const openRemoteBrowser = async (targetPath?: string) => {
    if (!connectionId || !effectiveRemoteAppDir) {
      return
    }
    setBrowserOpen(true)
    setBrowserLoading(true)
    try {
      const details = await loadRemoteDetails(targetPath)
      setBrowserDetails(details)
      setBrowserPath(details?.currentPath)
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 浏览失败`,
        description: error instanceof Error ? error.message : "无法浏览远端目录",
      })
    } finally {
      setBrowserLoading(false)
    }
  }

  const restartRemoteService = async () => {
    if (!connectionId) {
      return
    }
    try {
      const restarted = await getDesktopApi().projects.restartProjectService({
        projectId: project.id,
        connectionId,
      })
      if (!restarted.ok) {
        toast({
          variant: "destructive",
          title: `${project.displayName} 重启失败`,
          description: restarted.message,
        })
        return
      }
      toast({
        title: `${project.displayName} 已重启`,
        description: restarted.message,
      })
      await refreshRemoteDetails()
    } catch (error) {
      toast({
        variant: "destructive",
        title: `${project.displayName} 重启失败`,
        description: error instanceof Error ? error.message : "无法重启远端服务",
      })
    }
  }

  const saveSiteSettings = async () => {
    if (!connectionId) {
      setSiteError("请先选择目标 VPS")
      return
    }
    setSiteSaving(true)
    setSiteError(undefined)
    try {
      const result = await getDesktopApi().projects.saveProjectSiteSettings({
        projectId: project.id,
        connectionId,
        domain: siteDomain.trim() || undefined,
        sslEmail: sslEmail.trim() || undefined,
        certificatePem: certificatePem.trim() || undefined,
        privateKeyPem: privateKeyPem.trim() || undefined,
      })
      if (!result.ok) {
        setSiteError(result.message)
        return
      }
      toast({
        title: `${project.displayName} 站点配置已更新`,
        description: result.publicUrl ?? result.previewUrl ?? result.message,
      })
      await refreshRemoteDetails()
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : "保存站点配置失败")
    } finally {
      setSiteSaving(false)
    }
  }

  useEffect(() => {
    if (!siteSettingsOpen) {
      return
    }

    const syncFromRemote = async () => {
      let details = remoteDetails
      if (!details && connectionId && effectiveRemoteAppDir) {
        try {
          details = await loadRemoteDetails()
          setRemoteDetails(details)
        } catch (error) {
          setSiteError(error instanceof Error ? error.message : "无法读取当前站点设置")
          return
        }
      }

      setSiteError(undefined)
      setSiteDomain(details?.site.domain ?? "")
      setSslEmail("")
      setCertificatePem(details?.site.certificatePem ?? "")
      setPrivateKeyPem("")
    }

    void syncFromRemote()
  }, [siteSettingsOpen, remoteDetails, connectionId, effectiveRemoteAppDir])

  const openBrowserParent = async () => {
    if (!browserDetails || browserDetails.currentPath === browserDetails.remoteAppDir) {
      return
    }
    const segments = browserDetails.currentPath.split("/").filter(Boolean)
    segments.pop()
    const parentPath = `/${segments.join("/")}`
    await openRemoteBrowser(parentPath || browserDetails.remoteAppDir)
  }

  const openEnvEditor = async () => {
    if (!connectionId) {
      setEnvError("请先选择目标 VPS")
      setEnvOpen(true)
      return
    }
    setEnvOpen(true)
    setEnvLoading(true)
    setEnvError(undefined)
    try {
      const result = await getDesktopApi().projects.getProjectEnv({
        projectId: project.id,
        connectionId,
      })
      if (!result.ok) {
        setEnvError(result.message)
        return
      }
      setEnvText(result.content ?? "")
    } catch (error) {
      setEnvError(error instanceof Error ? error.message : "读取远端 .env 失败")
    } finally {
      setEnvLoading(false)
    }
  }

  const saveEnv = async () => {
    await persistEnv(false)
  }

  const saveAndRestartEnv = async () => {
    await persistEnv(true)
  }

  const persistEnv = async (restartAfterSave: boolean) => {
    if (!connectionId) {
      setEnvError("请先选择目标 VPS")
      return
    }
    setEnvSaving(true)
    setEnvError(undefined)
    try {
      const result = await getDesktopApi().projects.saveProjectEnv({
        projectId: project.id,
        connectionId,
        content: envText,
      })
      if (!result.ok) {
        setEnvError(result.message)
        return
      }
      setEnvText(result.content ?? envText)
      if (restartAfterSave) {
        const restarted = await getDesktopApi().projects.restartProjectService({
          projectId: project.id,
          connectionId,
        })
        if (!restarted.ok) {
          setEnvError(restarted.message)
          return
        }
      }
      setEnvOpen(false)
    } catch (error) {
      setEnvError(error instanceof Error ? error.message : "保存远端 .env 失败")
    } finally {
      setEnvSaving(false)
    }
  }

  const rotateSecret = async () => {
    if (!connectionId) {
      setEnvError("请先选择目标 VPS")
      return
    }
    setEnvSaving(true)
    setEnvError(undefined)
    try {
      const rotated = await getDesktopApi().projects.rotateProjectSecret({
        projectId: project.id,
        connectionId,
      })
      if (!rotated.ok) {
        setEnvError(rotated.message)
        return
      }
      setEnvText(rotated.content ?? envText)
    } catch (error) {
      setEnvError(error instanceof Error ? error.message : "重置 SESSION_SECRET 失败")
    } finally {
      setEnvSaving(false)
    }
  }

  return (
    <>
      <Card
        className={cn(
          "overflow-visible border-border/80 shadow-sm transition",
          success && "border-emerald-500/35 bg-gradient-to-br from-emerald-500/[0.06] to-card",
          failed && !success && "border-destructive/25 bg-destructive/[0.03]",
        )}
      >
        <CardHeader className="space-y-2 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="truncate text-base font-semibold">{project.displayName}</CardTitle>
                <Badge variant="secondary" className="shrink-0 font-normal">
                  本地开发
                </Badge>
                {success ? (
                  <Badge className="shrink-0 border-emerald-500/40 bg-emerald-500/15 font-normal text-emerald-800 dark:text-emerald-200">
                    已部署
                  </Badge>
                ) : null}
              </div>
              <CardDescription className="break-all font-mono text-[11px] leading-snug">
                {project.localPath}
              </CardDescription>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 shrink-0 rounded-lg border-destructive/25 px-2.5 text-destructive hover:bg-destructive/5 hover:text-destructive"
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                  移除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>从面板移除此项目？</AlertDialogTitle>
                  <AlertDialogDescription>
                    只会把项目从当前面板列表中移除，不会删除本地项目文件，也不会删除远端 VPS 上的目录和数据。请输入项目名 <span className="font-medium text-foreground">{project.displayName}</span> 以确认。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  className="h-9 rounded-lg"
                  placeholder={`输入 ${project.displayName} 确认`}
                  value={deleteConfirmText}
                  onChange={(event) => setDeleteConfirmText(event.target.value)}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setDeleteConfirmText("")}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deleteConfirmText.trim() !== project.displayName}
                    onClick={() => {
                      setDeleteConfirmText("")
                      onDelete()
                    }}
                  >
                    确认移除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">目标服务器</Label>
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm">
              {connectionId ? connectionLabel(connections, connectionId) : "请先在上方选择服务器"}
            </div>
          </div>

          {hasScriptActions ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">项目动作</Label>
              <select
                className={cn(
                  "h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs shadow-sm",
                  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                value={npmScripts.length ? npmScript : ""}
                onChange={(event) => setNpmScript(event.target.value)}
                disabled={busy || bootstrapping || npmScripts.length === 0}
              >
                {npmScripts.length === 0 ? (
                  <option value="">未找到可用动作</option>
                ) : (
                  npmScripts.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))
                )}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">远端父目录（可选）</Label>
              <Input
                className="h-9 rounded-lg font-mono text-xs"
                placeholder="例如 /var/www 或 ~/sites（可选）"
                value={remoteParent}
                onChange={(e) => setRemoteParent(e.target.value)}
                disabled={busy || bootstrapping}
              />
            </div>
          )}

          {effectiveRemoteAppDir ? (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/[0.08] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm font-medium">远端项目</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={remoteDetails?.service.active ? "default" : "secondary"} className="font-normal">
                      <Server className="mr-1 size-3.5" />
                      {remoteRuntimeHint}
                    </Badge>
                    {remoteDetails?.site.mode === "domain" ? (
                      <Badge variant="secondary" className="font-normal">
                        <Globe className="mr-1 size-3.5" />
                        域名访问
                      </Badge>
                    ) : remoteDetails?.site.mode === "port" ? (
                      <Badge variant="secondary" className="font-normal">
                        <ExternalLink className="mr-1 size-3.5" />
                        端口预览
                      </Badge>
                    ) : null}
                    {remoteDetails?.site.sslEnabled ? (
                      <Badge className="border-emerald-500/40 bg-emerald-500/15 font-normal text-emerald-800 dark:text-emerald-200">
                        <ShieldCheck className="mr-1 size-3.5" />
                        HTTPS
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-lg"
                  disabled={remoteDetailsLoading || !connectionId}
                  onClick={() => void refreshRemoteDetails()}
                >
                  {remoteDetailsLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  刷新状态
                </Button>
              </div>

              <div className={cn("grid gap-3", remoteDetails?.publicUrl ? "md:grid-cols-2" : "md:grid-cols-1")}>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">部署位置</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start rounded-lg border border-border/70 px-3 py-2 font-mono text-xs"
                    disabled={!effectiveRemoteAppDir || !connectionId}
                    onClick={() => void openRemoteBrowser(effectiveRemoteAppDir)}
                  >
                    <FolderOpen className="size-4 shrink-0" />
                    <span className="truncate text-left">{effectiveRemoteAppDir}</span>
                  </Button>
                </div>

                {remoteDetails?.publicUrl ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">访问入口</Label>
                    <div className="rounded-lg border border-border/70 bg-background px-3 py-2 text-xs">
                      <button type="button" className="break-all text-left text-sky-600 hover:underline" onClick={() => window.open(remoteDetails.publicUrl!, "_blank")}>
                        {remoteDetails.publicUrl}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-lg"
                  disabled={!connectionId}
                  onClick={() => setSiteSettingsOpen(true)}
                >
                  <Settings2 className="size-4" />
                  设置站点
                </Button>
                <Button type="button" variant="outline" className="rounded-lg" disabled={!remoteDetails?.service.configured || !connectionId} onClick={() => void restartRemoteService()}>
                  <Server className="size-4" />
                  重启服务
                </Button>
              </div>

              {remoteDetails ? (
                <div className="grid gap-2 text-[11px] text-muted-foreground md:grid-cols-2">
                  <p>服务单元：{remoteDetails.service.unit ?? "未配置"}</p>
                  <p>应用端口：{remoteDetails.appPort ?? "未知"}</p>
                  <p>nginx：{remoteDetails.site.nginxInstalled ? "已安装" : "未安装"}</p>
                  <p>certbot：{remoteDetails.site.certbotInstalled ? "已安装" : "未安装"}</p>
                  <p>域名：{remoteDetails.site.domain ?? "未配置"}</p>
                  <p>SSL：{remoteDetails.site.sslEnabled ? "已启用" : "未启用"}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {initHint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{initHint}</p> : null}

          <div className="grid gap-2 sm:grid-cols-3">
            {shouldShowInitializeButton ? (
              <AlertDialog open={initDialogOpen} onOpenChange={setInitDialogOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full rounded-lg"
                    disabled={bootstrapping || busy || !connectionId}
                  >
                    {bootstrapping ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        正在初始化…
                      </>
                    ) : (
                      <>
                        <Settings2 className="size-4" />
                        初始化远端
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>需要初始化以下远端项目</AlertDialogTitle>
                    <AlertDialogDescription>
                      {remoteState?.missingItems.length ? remoteState.missingItems.join("、") : "将执行远端初始化。"}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setInitDialogOpen(false)
                        onInitialize({ connectionId })
                      }}
                    >
                      开始初始化
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <div className="hidden sm:block" />
            )}
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-lg"
              disabled={busy || bootstrapping || !connectionId}
              onClick={() => void openEnvEditor()}
            >
              <FilePenLine className="size-4" />
              编辑 .env
            </Button>
            <Button
              type="button"
              className="w-full rounded-lg"
              disabled={
                busy ||
                bootstrapping ||
                !connectionId ||
                (strategy === "local-npm-script" && (!npmScript || npmScripts.length === 0))
              }
              onClick={() =>
                onDeploy({
                  connectionId,
                  strategy,
                  remoteParentPath: strategy === "sftp" ? remoteParent.trim() || undefined : undefined,
                  npmScript: hasScriptActions ? npmScript : undefined,
                })
              }
            >
              {busy ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  正在{selectedActionLabel}…
                </>
              ) : (
                <>
                  <Rocket className="size-4" />
                  {selectedActionLabel}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={envOpen} onOpenChange={setEnvOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>编辑远端 .env</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {envError ? <p className="text-sm text-destructive">{envError}</p> : null}
            <Textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              className="min-h-[360px] font-mono text-xs"
              disabled={envLoading || envSaving}
            />
            <p className="text-[11px] text-muted-foreground">
              保存后需要重新点击“一键部署”或手动重启服务才会完全生效。
            </p>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void rotateSecret()}
              disabled={envLoading || envSaving}
            >
              重置 SESSION_SECRET
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setEnvOpen(false)} disabled={envSaving}>
                关闭
              </Button>
              <Button type="button" onClick={() => void saveEnv()} disabled={envLoading || envSaving}>
                {envSaving ? "保存中…" : "保存 .env"}
              </Button>
              <Button type="button" onClick={() => void saveAndRestartEnv()} disabled={envLoading || envSaving}>
                {envSaving ? "处理中…" : "保存并重启服务"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>浏览远端部署目录</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="rounded-lg"
                disabled={!browserDetails || browserDetails.currentPath === browserDetails.remoteAppDir || browserLoading}
                onClick={() => void openBrowserParent()}
              >
                返回上级
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-lg"
                disabled={browserLoading || !browserPath}
                onClick={() => void openRemoteBrowser(browserPath)}
              >
                {browserLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
              <div className="min-w-0 flex-1 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 font-mono text-xs">
                {browserDetails?.currentPath ?? browserPath ?? effectiveRemoteAppDir}
              </div>
            </div>

            <div className="max-h-[420px] overflow-auto rounded-lg border border-border/70">
              {browserLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  正在读取远端目录…
                </div>
              ) : browserDetails?.files.length ? (
                <div className="divide-y divide-border/60">
                  {browserDetails.files.map((entry) => (
                    <div key={entry.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 justify-start px-0 py-0 text-left"
                        disabled={entry.type !== "directory"}
                        onClick={() => void openRemoteBrowser(entry.path)}
                      >
                        <FolderOpen className={cn("mr-2 size-4 shrink-0", entry.type !== "directory" && "opacity-40")} />
                        <span className="truncate font-mono text-xs">{entry.name}</span>
                      </Button>
                      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                        {entry.type === "directory" ? "目录" : formatFileSize(entry.size)}
                      </span>
                      <span className="w-36 shrink-0 text-right text-[11px] text-muted-foreground">
                        {entry.modifiedAt ?? "-"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">当前目录为空或尚未部署。</div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBrowserOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={siteSettingsOpen} onOpenChange={setSiteSettingsOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>站点设置</DialogTitle>
            <DialogDescription>{project.displayName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {remoteDetails ? (
              <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/[0.08] p-3 text-[12px] text-muted-foreground md:grid-cols-3">
                <p>当前域名：{remoteDetails.site.domain ?? "未配置"}</p>
                <p>
                  当前 SSL：
                  {remoteDetails.site.sslMode === "custom"
                    ? "自定义证书"
                    : remoteDetails.site.sslMode === "letsencrypt"
                      ? "Let's Encrypt"
                      : remoteDetails.site.sslEnabled
                        ? "已启用"
                        : "未启用"}
                </p>
                <p>
                  自定义证书：
                  {remoteDetails.site.customCertificateConfigured ? "已配置" : "未配置"}
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">域名</Label>
                <Input
                  className="h-9 rounded-lg text-sm"
                  placeholder="例如 app.example.com；留空则使用随机端口预览"
                  value={siteDomain}
                  onChange={(event) => setSiteDomain(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">SSL 邮箱（可选）</Label>
                <Input
                  className="h-9 rounded-lg text-sm"
                  placeholder="用于 Let’s Encrypt 申请证书"
                  value={sslEmail}
                  onChange={(event) => setSslEmail(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">自定义证书（可选）</Label>
                <Textarea
                  className="min-h-[180px] rounded-lg font-mono text-[11px]"
                  placeholder="粘贴 PEM 证书；如使用 Cloudflare Origin Certificate 可填这里"
                  value={certificatePem}
                  onChange={(event) => setCertificatePem(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">自定义私钥（可选）</Label>
                <Textarea
                  className="min-h-[180px] rounded-lg font-mono text-[11px]"
                  placeholder="粘贴 PEM 私钥；与左侧证书成对使用"
                  value={privateKeyPem}
                  onChange={(event) => setPrivateKeyPem(event.target.value)}
                  disabled={siteSaving || !connectionId}
                />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              这里不会回显服务器上已保存的私钥明文。若当前已配置自定义证书，上方会显示状态；需要替换时再粘贴新的证书和私钥。
            </p>
            <p className="text-[11px] text-muted-foreground">
              不填写域名时会自动分配随机预览端口。填写域名后会切换到域名访问；若同时提供证书和私钥，则优先使用自定义证书。
            </p>

            {siteError ? <p className="text-sm text-destructive">{siteError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSiteSettingsOpen(false)} disabled={siteSaving}>
              关闭
            </Button>
            <Button type="button" onClick={() => void saveSiteSettings()} disabled={siteSaving || !connectionId}>
              {siteSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Globe className="size-4" />}
              保存站点配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ProjectManagementPanel({ connections, selectedConnectionId }: ProjectManagementPanelProps) {
  const {
    projects,
    isLoading,
    isImporting,
    isDeploying,
    deployingProjectId,
    isInitializing,
    initializingProjectId,
    error,
    info,
    loadProjects,
    importFromPicker,
    deleteProject,
    initializeProject,
    deployProject,
    clearFeedback,
  } = useProjectStore()

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (info) {
      toast({
        title: "操作完成",
        description: info,
      })
      clearFeedback()
      return
    }
    if (error) {
      toast({
        variant: "destructive",
        title: "操作失败",
        description: error,
      })
      clearFeedback()
      return
    }
  }, [info, error, clearFeedback])

  const sorted = useMemo(() => {
    const copy = [...projects]
    copy.sort((a, b) => {
      if (a.lastDeployStatus === "success" && b.lastDeployStatus !== "success") {
        return -1
      }
      if (b.lastDeployStatus === "success" && a.lastDeployStatus !== "success") {
        return 1
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
    return copy
  }, [projects])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">项目管理</h3>
        </div>
        <Button
          type="button"
          className="shrink-0 rounded-lg"
          onClick={() => void importFromPicker()}
          disabled={isImporting}
        >
          {isImporting ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              选择中…
            </>
          ) : (
            <>
              <FolderInput className="size-4" />
              导入本地项目
            </>
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/80 py-20">
          <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">加载项目列表…</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/10 px-8 py-16 text-center">
          <p className="text-base font-medium text-foreground">还没有登记任何本地项目</p>
          <p className="max-w-md text-sm text-muted-foreground">点击「导入本地项目」选择仓库根目录。</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((project: LocalProjectRecord) => (
            <ProjectDeployCard
              key={project.id}
              project={project}
              connections={connections}
              selectedConnectionId={selectedConnectionId}
              isDeploying={isDeploying}
              deployingProjectId={deployingProjectId}
              isInitializing={isInitializing}
              initializingProjectId={initializingProjectId}
              onInitialize={(args) => {
                void initializeProject({
                  projectId: project.id,
                  connectionId: args.connectionId,
                })
              }}
              onDeploy={(args) => {
                void deployProject({
                  projectId: project.id,
                  connectionId: args.connectionId,
                  strategy: args.strategy,
                  remoteParentPath: args.remoteParentPath,
                  npmScript: args.npmScript,
                })
              }}
              onDelete={() => void deleteProject(project.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
