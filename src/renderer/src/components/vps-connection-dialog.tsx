import { useEffect, useMemo, useRef, useState } from "react"
import { Eye, EyeOff, Import, KeyRound, LoaderCircle, LockKeyhole, Server, WandSparkles } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { toast } from "@/hooks/use-toast"
import { getDesktopApi } from "@/lib/desktop-api"
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
  provider: "",
  locationLabel: "",
  expiresAt: "",
  authType: "password",
  password: "",
  privateKey: "",
  passphrase: "",
}

const STORED_SECRET_MASK = "********"

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
  } = useVpsStore()
  const [internalOpen, setInternalOpen] = useState(false)
  const [form, setForm] = useState<VpsConnectionInput>(initialForm)
  const [showSecret, setShowSecret] = useState(false)
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string>()
  const [sshPickerOpen, setSshPickerOpen] = useState(false)
  const [sshSearch, setSshSearch] = useState("")
  const [isProvisioningKey, setIsProvisioningKey] = useState(false)
  const [provisionHint, setProvisionHint] = useState<string>()
  const [hasStoredPassword, setHasStoredPassword] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const open = openProp ?? internalOpen
  const isEditing = Boolean(preset?.id)

  const isValid = useMemo(() => {
    if (!form.name || !form.host || !form.username || !form.port) {
      return false
    }

    const hasStoredAuth = Boolean(form.id)

    if (form.authType === "password") {
      return hasStoredAuth || Boolean(form.password)
    }

    return hasStoredAuth || Boolean(form.privateKey)
  }, [form])

  const updateField = <K extends keyof VpsConnectionInput>(key: K, value: VpsConnectionInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const selectedCandidate = useMemo(
    () =>
      sshConfigCandidates.find(
        (candidate) => `${candidate.configPath}:${candidate.name}` === selectedCandidateKey,
      ) ?? null,
    [selectedCandidateKey, sshConfigCandidates],
  )

  const filteredSshCandidates = useMemo(() => {
    const keyword = sshSearch.trim().toLowerCase()
    if (!keyword) {
      return sshConfigCandidates
    }
    return sshConfigCandidates.filter((candidate) => {
      const haystack = [candidate.name, candidate.host, candidate.username, String(candidate.port)].join(" ").toLowerCase()
      return haystack.includes(keyword)
    })
  }, [sshConfigCandidates, sshSearch])

  const reset = () => {
    setForm(initialForm)
    setShowSecret(false)
    setSelectedCandidateKey(undefined)
    setSshPickerOpen(false)
    setSshSearch("")
    setIsProvisioningKey(false)
    setProvisionHint(undefined)
    setHasStoredPassword(false)
    clearFeedback()
  }

  useEffect(() => {
    if (!open) {
      return
    }
    void loadSshConfigCandidates()
    setForm((current) => ({
      ...initialForm,
      ...current,
      ...preset,
    }))
    setHasStoredPassword(Boolean(preset?.id && preset?.authType === "password"))
  }, [loadSshConfigCandidates, open, preset])

  useEffect(() => {
    if (!selectedCandidateKey) {
      return
    }
    const stillExists = sshConfigCandidates.some(
      (candidate) => `${candidate.configPath}:${candidate.name}` === selectedCandidateKey,
    )
    if (!stillExists) {
      setSelectedCandidateKey(undefined)
    }
  }, [selectedCandidateKey, sshConfigCandidates])

  const applyCandidate = (candidate: SshConfigCandidate) => {
    setSelectedCandidateKey(`${candidate.configPath}:${candidate.name}`)
    setForm((current) => ({
      ...current,
      name: candidate.name,
      host: candidate.host,
      port: candidate.port,
      username: candidate.username,
      provider: "",
      locationLabel: "",
      expiresAt: "",
      authType: candidate.authType,
      password: "",
      privateKey: candidate.privateKey ?? "",
      passphrase: "",
    }))
    setHasStoredPassword(false)
    setSshPickerOpen(false)

    window.requestAnimationFrame(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    })
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
    try {
      const result = await testConnection(form)
      toast({
        title: "测试连接成功",
        description: `${result.message}${result.workingDirectory ? ` · ${result.workingDirectory}` : ""}`,
      })
    } catch {
      // Error feedback is already handled by the store and visible in-dialog.
    }
  }

  const handleProvisionKey = async () => {
    if (!form.host || !form.username || !form.port || (!(form.password ?? "").trim() && !hasStoredPassword)) {
      toast({
        variant: "destructive",
        title: "缺少密码信息",
        description: "请先填写可用的 SSH 密码，再执行一键创建私钥。",
      })
      return
    }

    setIsProvisioningKey(true)
    setProvisionHint(undefined)
    try {
      const result = await getDesktopApi().vps.createAndInstallSshKey({
        ...form,
        authType: "password",
      })
      const nextForm: VpsConnectionInput = {
        ...form,
        authType: "privateKey",
        privateKey: result.privateKey,
        password: "",
      }
      setForm(nextForm)
      setHasStoredPassword(false)
      const testResult = await testConnection(nextForm)
      setProvisionHint(`${result.message}：${result.keyPath}`)
      toast({
        title: result.created ? "私钥已创建" : "私钥已复用",
        description: `${result.message}，并已更新 ${result.configPath} · ${testResult.message}`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "一键创建私钥失败",
        description: error instanceof Error ? error.message : "无法生成并安装私钥",
      })
    } finally {
      setIsProvisioningKey(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="flex max-h-[min(90vh,880px)] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden border-border bg-card p-0 text-card-foreground sm:w-full">
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Server data-icon="inline-start" />
            {isEditing ? "编辑 VPS 连接" : "新建 VPS 连接"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "修改已保存的服务器连接名称或参数，后续巡检与部署会继续使用这条记录。"
              : "保存一台可复用的服务器连接，后续安装环境、上传项目和部署流程都会基于这里继续扩展。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
          <div className="flex flex-col gap-6">
            {!isEditing ? (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/80 bg-muted/35 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">SSH 本地配置</p>
                  <p className="mt-1 text-sm text-muted-foreground">如果你电脑里已经配好了 `~/.ssh/config`，点右侧按钮就能直接选一条导入。</p>
                </div>
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    void loadSshConfigCandidates()
                    setSshPickerOpen(true)
                  }}
                  disabled={isLoadingSshConfigCandidates}
                >
                  {isLoadingSshConfigCandidates ? <LoaderCircle className="animate-spin" /> : <Import />}
                  导入 SSH 配置
                </Button>
              </div>
            ) : null}

            {selectedCandidate ? (
              <div className="rounded-xl border border-border/80 bg-muted/30 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">已导入 SSH 配置</p>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {selectedCandidate.name} · {selectedCandidate.username}@{selectedCandidate.host}:{selectedCandidate.port}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">这只是导入一份到当前连接，不会自动跟随 `~/.ssh/config` 变化。</p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void loadSshConfigCandidates()
                      setSshPickerOpen(true)
                    }}
                    disabled={isLoadingSshConfigCandidates}
                  >
                    重新导入
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                连接备注名称
                <Input
                  ref={nameInputRef}
                  value={form.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  placeholder="Production - Singapore"
                />
                <span className="text-xs text-muted-foreground">
                  这是面板里显示的名字，方便你自己记，不会去修改 SSH 原配置。
                </span>
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
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                服务商名称
                <Input
                  value={form.provider ?? ""}
                  onChange={(event) => updateField("provider", event.target.value)}
                  placeholder="例如 GreenCloud"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                机房地点 / 线路
                <Input
                  value={form.locationLabel ?? ""}
                  onChange={(event) => updateField("locationLabel", event.target.value)}
                  placeholder="例如 东京软银"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                到期时间
                <Input
                  type="date"
                  value={form.expiresAt ?? ""}
                  onChange={(event) => updateField("expiresAt", event.target.value)}
                />
              </label>
            </div>

            <Separator />

            <div className="rounded-xl border border-border/80 bg-muted/25 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className={
                    form.authType === "privateKey"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                      : ""
                  }
                >
                  {form.authType === "privateKey" ? (
                    <>
                      <KeyRound className="mr-1 size-3.5" />
                      当前使用私钥认证
                    </>
                  ) : (
                    <>
                      <LockKeyhole className="mr-1 size-3.5" />
                      当前使用密码认证
                    </>
                  )}
                </Badge>
                {form.authType === "privateKey" ? (
                  <span className="text-xs text-muted-foreground">
                    当前连接会优先使用私钥完成 SSH 登录。
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    当前连接仍会使用密码完成 SSH 登录。
                  </span>
                )}
              </div>
            </div>

            <Tabs
              value={form.authType}
              onValueChange={(value) => updateField("authType", value as VpsConnectionInput["authType"])}
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
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                    SSH 密码
                    <div className="relative">
                      <Input
                        type={showSecret ? "text" : "password"}
                        value={hasStoredPassword && !(form.password ?? "").length ? STORED_SECRET_MASK : (form.password ?? "")}
                        onChange={(event) => {
                          setHasStoredPassword(false)
                          updateField("password", event.target.value)
                        }}
                        onFocus={() => {
                          if (hasStoredPassword && !(form.password ?? "").length) {
                            setHasStoredPassword(false)
                          }
                        }}
                        placeholder={hasStoredPassword ? "已保存密码" : "输入服务器密码"}
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

                  <div className="rounded-xl border border-border/80 bg-muted/30 px-4 py-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">一键改为私钥登录</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          会在本机生成一把新的 ED25519 私钥，并用当前密码把公钥安装到服务器。
                        </p>
                        {provisionHint ? <p className="mt-2 break-all text-xs text-emerald-600 dark:text-emerald-300">{provisionHint}</p> : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 rounded-lg"
                        disabled={isProvisioningKey || (!(form.password ?? "").trim() && !hasStoredPassword)}
                        onClick={() => void handleProvisionKey()}
                      >
                        {isProvisioningKey ? <LoaderCircle className="animate-spin" /> : <WandSparkles className="size-4" />}
                        一键创建私钥
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="privateKey" className="mt-0 flex flex-col gap-4">
                <label className="flex min-h-0 flex-col gap-2 text-sm text-muted-foreground">
                  私钥内容
                  <textarea
                    value={form.privateKey ?? ""}
                    onChange={(event) => updateField("privateKey", event.target.value)}
                    className="max-h-48 min-h-32 resize-y overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                      {lastTestResult?.workingDirectory ? ` · 工作目录 ${lastTestResult.workingDirectory}` : ""}
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

      <Dialog open={sshPickerOpen} onOpenChange={setSshPickerOpen}>
        <DialogContent className="max-w-xl border-border bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>导入本机 SSH 配置</DialogTitle>
            <DialogDescription>
              选择一条 `~/.ssh/config` 里的配置，点一下就会直接带入当前表单。
            </DialogDescription>
          </DialogHeader>

          <Input
            value={sshSearch}
            onChange={(event) => setSshSearch(event.target.value)}
            placeholder="搜索 Host、地址、用户名或端口"
          />

          <div className="flex max-h-[min(22rem,55vh)] flex-col gap-2 overflow-y-auto">
            {filteredSshCandidates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                {sshConfigCandidates.length === 0 ? "当前没有可导入的 SSH 配置项。" : "没有找到匹配的 SSH 配置。"}
              </div>
            ) : (
              filteredSshCandidates.map((candidate) => {
                const candidateKey = `${candidate.configPath}:${candidate.name}`
                return (
                  <button
                    key={candidateKey}
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
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
