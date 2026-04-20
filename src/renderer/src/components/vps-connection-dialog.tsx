import { useEffect, useMemo, useState } from "react"
import { Eye, EyeOff, Import, KeyRound, LoaderCircle, LockKeyhole, Server } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import type { SshConfigCandidate, VpsConnectionInput } from "../../../shared/vps"
import { useVpsStore } from "@/store/vps-store"

type Props = {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  preset?: Partial<VpsConnectionInput> | null
}

const initialForm: VpsConnectionInput = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "password",
  password: "",
  privateKey: "",
  passphrase: "",
}

export function VpsConnectionDialog({ children, open: openProp, onOpenChange: onOpenChangeProp, preset }: Props) {
  const {
    saveConnection,
    testConnection,
    sshConfigCandidates,
    loadSshConfigCandidates,
    isSaving,
    isTesting,
    isLoadingSshConfigCandidates,
    info,
    error,
    lastTestResult,
    clearFeedback,
  } =
    useVpsStore()
  const [internalOpen, setInternalOpen] = useState(false)
  const [form, setForm] = useState<VpsConnectionInput>(initialForm)
  const [showSecret, setShowSecret] = useState(false)
  const open = openProp ?? internalOpen

  const isValid = useMemo(() => {
    if (!form.name || !form.host || !form.username || !form.port) {
      return false
    }

    if (form.authType === "password") {
      return Boolean(form.password)
    }

    return Boolean(form.privateKey)
  }, [form])

  const updateField = <K extends keyof VpsConnectionInput>(
    key: K,
    value: VpsConnectionInput[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const reset = () => {
    setForm(initialForm)
    setShowSecret(false)
    clearFeedback()
  }

  useEffect(() => {
    if (open) {
      void loadSshConfigCandidates()
      setForm((current) => ({
        ...initialForm,
        ...current,
        ...preset,
      }))
    }
  }, [loadSshConfigCandidates, open, preset])

  const applyCandidate = (candidate: SshConfigCandidate) => {
    setForm((current) => ({
      ...current,
      name: candidate.name,
      host: candidate.host,
      port: candidate.port,
      username: candidate.username,
      authType: candidate.authType,
      password: "",
      privateKey: "",
      passphrase: "",
    }))
  }

  const onOpenChange = (nextOpen: boolean) => {
    setInternalOpen(nextOpen)
    onOpenChangeProp?.(nextOpen)
    if (!nextOpen) {
      reset()
    }
  }

  const handleSave = async () => {
    await saveConnection(form)
    await useVpsStore.getState().loadConnections()
    onOpenChange(false)
  }

  const handleTest = async () => {
    await testConnection(form)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="flex max-h-[min(90vh,880px)] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden border-border bg-card p-0 text-card-foreground sm:w-full">
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Server data-icon="inline-start" />
            新建 VPS 连接
          </DialogTitle>
          <DialogDescription>
            保存一台可复用的服务器连接，后续安装环境、上传项目和部署流程都会基于这里继续扩展。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
          <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">自动识别本机 SSH 配置</p>
              <p className="mt-1 text-sm text-muted-foreground">
                这里会读取 `~/.ssh/config` 中的主机，但只有你主动选择的项才会带入当前连接表单。
              </p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 self-start sm:self-auto"
              onClick={() => void loadSshConfigCandidates()}
              disabled={isLoadingSshConfigCandidates}
            >
              {isLoadingSshConfigCandidates ? <LoaderCircle className="animate-spin" /> : <Import />}
              刷新本机配置
            </Button>
          </div>

          <div className="rounded-2xl border border-border bg-muted/40 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">可选 SSH 配置项</p>
              <span className="text-xs text-muted-foreground">
                {sshConfigCandidates.length} 项
              </span>
            </div>
            <div className="flex max-h-[min(11rem,28vh)] flex-col gap-2 overflow-y-auto">
              {sshConfigCandidates.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  当前没有可选的 SSH 配置项。
                </div>
              ) : (
                sshConfigCandidates.map((candidate) => (
                  <button
                    key={`${candidate.name}-${candidate.host}-${candidate.port}`}
                    type="button"
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/80 px-3 py-3 text-left transition hover:bg-muted"
                    onClick={() => applyCandidate(candidate)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{candidate.name}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {candidate.username}@{candidate.host}:{candidate.port}
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                      {candidate.authType === "privateKey" ? "私钥" : "密码"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-muted-foreground">
              连接名称
              <Input
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="Production - Singapore"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-muted-foreground">
              服务器地址
              <Input
                value={form.host}
                onChange={(event) => updateField("host", event.target.value)}
                placeholder="203.0.113.42"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-muted-foreground">
              SSH 端口
              <Input
                type="number"
                value={String(form.port)}
                onChange={(event) => updateField("port", Number(event.target.value))}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-muted-foreground">
              登录用户
              <Input
                value={form.username}
                onChange={(event) => updateField("username", event.target.value)}
                placeholder="root"
              />
            </label>
          </div>

          <Separator />

          <Tabs
            value={form.authType}
            onValueChange={(value) =>
              updateField("authType", value as VpsConnectionInput["authType"])
            }
            className="flex flex-col gap-4"
          >
            <TabsList className="grid h-11 w-full grid-cols-2 gap-1 bg-muted p-1">
              <TabsTrigger value="password" className="gap-2">
                <LockKeyhole />
                密码认证
              </TabsTrigger>
              <TabsTrigger value="privateKey" className="gap-2">
                <KeyRound />
                私钥认证
              </TabsTrigger>
            </TabsList>

            <TabsContent value="password" className="mt-0">
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                SSH 密码
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    value={form.password ?? ""}
                    onChange={(event) => updateField("password", event.target.value)}
                    placeholder="输入服务器密码"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setShowSecret((current) => !current)}
                  >
                    {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </label>
            </TabsContent>

            <TabsContent value="privateKey" className="mt-0 flex flex-col gap-4">
              <label className="flex min-h-0 flex-col gap-2 text-sm text-muted-foreground">
                私钥内容
                <textarea
                  value={form.privateKey ?? ""}
                  onChange={(event) => updateField("privateKey", event.target.value)}
                  className="max-h-48 min-h-32 resize-y overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                私钥口令
                <Input
                  type={showSecret ? "text" : "password"}
                  value={form.passphrase ?? ""}
                  onChange={(event) => updateField("passphrase", event.target.value)}
                  placeholder="如私钥已加密则填写"
                />
              </label>
            </TabsContent>
          </Tabs>

          {(error || info || lastTestResult) && (
            <div className="rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm">
              {error ? (
                <p className="text-destructive">{error}</p>
              ) : info ? (
                <p className="text-primary">{info}</p>
              ) : (
                <div className="flex flex-col gap-1 text-emerald-600 dark:text-emerald-300">
                  <p>{lastTestResult?.message}</p>
                  <p className="text-muted-foreground">
                    延迟 {lastTestResult?.latencyMs}ms
                    {lastTestResult?.workingDirectory
                      ? ` · 工作目录 ${lastTestResult.workingDirectory}`
                      : ""}
                  </p>
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-card px-6 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-sm text-muted-foreground sm:min-w-0 sm:flex-1 sm:pr-2">
              当前版本会把连接配置写入本地 SQLite，方便后续继续做部署编排。
            </p>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 sm:justify-end">
              <Button variant="outline" onClick={handleTest} disabled={!isValid || isTesting}>
                {isTesting ? <LoaderCircle className="animate-spin" /> : null}
                测试连接
              </Button>
              <Button onClick={handleSave} disabled={!isValid || isSaving}>
                {isSaving ? <LoaderCircle className="animate-spin" /> : null}
                保存连接
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
