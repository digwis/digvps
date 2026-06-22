import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Eye, EyeOff, Import, KeyRound, LoaderCircle, LockKeyhole, Server, Trash2, WandSparkles } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { useShallow } from "zustand/react/shallow"

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

export function VpsConnectionDialog({
  children,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  preset,
}: Props) {
  const { t } = useTranslation()
  const {
    saveConnection,
    testConnection,
    deleteConnection,
    sshConfigCandidates,
    loadSshConfigCandidates,
    isSaving,
    isTesting,
    isLoadingSshConfigCandidates,
    info,
    error,
    lastTestResult,
    clearFeedback,
  } = useVpsStore(
    useShallow((s) => ({
      saveConnection: s.saveConnection,
      testConnection: s.testConnection,
      deleteConnection: s.deleteConnection,
      sshConfigCandidates: s.sshConfigCandidates,
      loadSshConfigCandidates: s.loadSshConfigCandidates,
      isSaving: s.isSaving,
      isTesting: s.isTesting,
      isLoadingSshConfigCandidates: s.isLoadingSshConfigCandidates,
      info: s.info,
      error: s.error,
      lastTestResult: s.lastTestResult,
      clearFeedback: s.clearFeedback,
    }))
  )
  const [internalOpen, setInternalOpen] = useState(false)
  const [form, setForm] = useState<VpsConnectionInput>(initialForm)
  const [showSecret, setShowSecret] = useState(false)
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string>()
  const [sshPickerOpen, setSshPickerOpen] = useState(false)
  const [sshSearch, setSshSearch] = useState("")
  const [isProvisioningKey, setIsProvisioningKey] = useState(false)
  const [provisionHint, setProvisionHint] = useState<string>()
  const [hasStoredPassword, setHasStoredPassword] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState("")
  const [isDeleting, setIsDeleting] = useState(false)
  const [sshCandidatesLoaded, setSshCandidatesLoaded] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const initializedPresetIdRef = useRef<string | null>(null)
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
    setDeleteDialogOpen(false)
    setDeleteConfirmName("")
    setIsDeleting(false)
    clearFeedback()
  }

  useEffect(() => {
    if (!open) {
      return
    }
    if (initializedPresetIdRef.current !== preset?.id) {
      setForm((current) => ({
        ...initialForm,
        ...current,
        ...preset,
      }))
      setHasStoredPassword(Boolean(preset?.id && preset?.authType === "password"))
      initializedPresetIdRef.current = preset?.id ?? null
    }
  }, [open, preset])

  useEffect(() => {
    if (open || !sshCandidatesLoaded) {
      return
    }
    setSshCandidatesLoaded(false)
  }, [open, sshCandidatesLoaded])

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
        title: t("connection.toastTestOk"),
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
        title: t("connection.toastMissingPassword"),
        description: t("connection.toastMissingPasswordDesc"),
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
        title: result.created ? t("connection.toastKeyCreated") : t("connection.toastKeyReused"),
        description: t("connection.toastKeyDesc", { msg: result.message, path: result.configPath, test: testResult.message }),
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("connection.toastKeyFailed"),
        description: error instanceof Error ? error.message : t("connection.toastKeyFailedDesc"),
      })
    } finally {
      setIsProvisioningKey(false)
    }
  }

  const handleOpenDeleteDialog = () => {
    if (!preset?.id) {
      return
    }
    setDeleteConfirmName("")
    setDeleteDialogOpen(true)
  }

  const handleCloseDeleteDialog = (nextOpen: boolean) => {
    if (isDeleting) {
      return
    }
    setDeleteDialogOpen(nextOpen)
    if (!nextOpen) {
      setDeleteConfirmName("")
    }
  }

  const handleConfirmDelete = async () => {
    if (!preset?.id) {
      return
    }
    const trimmedName = form.name.trim()
    if (!trimmedName || deleteConfirmName.trim() !== trimmedName) {
      return
    }
    setIsDeleting(true)
    try {
      await deleteConnection(preset.id)
      toast({
        title: t("connection.toastDeleteOk", { name: trimmedName }),
      })
      setDeleteDialogOpen(false)
      setDeleteConfirmName("")
      onOpenChange(false)
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("connection.toastDeleteFailed"),
        description: error instanceof Error ? error.message : t("connection.toastDeleteFailed"),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="flex max-h-[min(90vh,880px)] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden border-border bg-card p-0 text-card-foreground sm:w-full">
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Server data-icon="inline-start" />
            {isEditing ? t("connection.editTitle") : t("connection.newTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t("connection.editDesc")
              : t("connection.newDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
          <div className="flex flex-col gap-6">
            {!isEditing ? (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/80 bg-muted/35 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t("connection.sshLocalConfig")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t("connection.sshLocalConfigDesc")}</p>
                </div>
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    if (!sshCandidatesLoaded) {
                      void loadSshConfigCandidates().then(() => setSshCandidatesLoaded(true))
                    }
                    setSshPickerOpen(true)
                  }}
                  disabled={isLoadingSshConfigCandidates}
                >
                  {isLoadingSshConfigCandidates ? <LoaderCircle className="animate-spin" /> : <Import />}
                  {t("connection.importSshConfig")}
                </Button>
              </div>
            ) : null}

            {selectedCandidate ? (
              <div className="rounded-xl border border-border/80 bg-muted/30 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{t("connection.sshConfigImported")}</p>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {selectedCandidate.name} · {selectedCandidate.username}@{selectedCandidate.host}:{selectedCandidate.port}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("connection.sshConfigImportedDesc")}</p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void loadSshConfigCandidates()
                      setSshPickerOpen(true)
                    }}
                    disabled={isLoadingSshConfigCandidates}
                  >
                    {t("connection.reimport")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldName")}
                <Input
                  ref={nameInputRef}
                  value={form.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  placeholder="Production - Singapore"
                />
                <span className="text-xs text-muted-foreground">
                  {t("connection.fieldNameDesc")}
                </span>
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldHost")}
                <Input
                  value={form.host}
                  onChange={(event) => updateField("host", event.target.value)}
                  placeholder="203.0.113.42"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldPort")}
                <Input
                  type="number"
                  value={String(form.port)}
                  onChange={(event) => updateField("port", Number(event.target.value))}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldUsername")}
                <Input
                  value={form.username}
                  onChange={(event) => updateField("username", event.target.value)}
                  placeholder="root"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldProvider")}
                <Input
                  value={form.provider ?? ""}
                  onChange={(event) => updateField("provider", event.target.value)}
                  placeholder={t("connection.fieldProviderPlaceholder")}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldLocation")}
                <Input
                  value={form.locationLabel ?? ""}
                  onChange={(event) => updateField("locationLabel", event.target.value)}
                  placeholder={t("connection.fieldLocationPlaceholder")}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                {t("connection.fieldExpiration")}
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
                      {t("connection.usePrivateKey")}
                    </>
                  ) : (
                    <>
                      <LockKeyhole className="mr-1 size-3.5" />
                      {t("connection.usePassword")}
                    </>
                  )}
                </Badge>
                {form.authType === "privateKey" ? (
                  <span className="text-xs text-muted-foreground">
                    {t("connection.usePrivateKeyDesc")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("connection.usePasswordDesc")}
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
                  {t("connection.authPassword")}
                </TabsTrigger>
                <TabsTrigger value="privateKey" className="gap-2">
                  <KeyRound />
                  {t("connection.authPrivateKey")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="password" className="mt-0">
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                    {t("connection.fieldPassword")}
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
                        placeholder={hasStoredPassword ? t("connection.passwordStored") : t("connection.fieldPassword")}
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
                        <p className="text-sm font-medium text-foreground">{t("connection.switchToKey")}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {t("connection.switchToKeyDesc")}
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
                        {t("connection.createKey")}
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="privateKey" className="mt-0 flex flex-col gap-4">
                <label className="flex min-h-0 flex-col gap-2 text-sm text-muted-foreground">
                  {t("connection.fieldPrivateKey")}
                  <textarea
                    value={form.privateKey ?? ""}
                    onChange={(event) => updateField("privateKey", event.target.value)}
                    className="max-h-48 min-h-32 resize-y overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm text-muted-foreground">
                  {t("connection.fieldKeyPassphrase")}
                  <Input
                    type={showSecret ? "text" : "password"}
                    value={form.passphrase ?? ""}
                    onChange={(event) => updateField("passphrase", event.target.value)}
                    placeholder={t("connection.keyPassphrasePlaceholder")}
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
                      {t("connection.testLatency", { ms: lastTestResult?.latencyMs })}
                      {lastTestResult?.workingDirectory ? t("connection.testWorkingDir", { path: lastTestResult.workingDirectory }) : ""}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-card px-6 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:pr-2">
              {isEditing ? (
                <Button
                  variant="outline"
                  className="w-fit border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleOpenDeleteDialog}
                  disabled={!form.name?.trim() || isDeleting}
                >
                  <Trash2 />
                  {t("connection.deleteButton")}
                </Button>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {t("connection.versionNote")}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 sm:justify-end">
              <Button variant="outline" onClick={handleTest} disabled={!isValid || isTesting}>
                {isTesting ? <LoaderCircle className="animate-spin" /> : null}
                {t("connection.testConnection")}
              </Button>
              <Button onClick={handleSave} disabled={!isValid || isSaving}>
                {isSaving ? <LoaderCircle className="animate-spin" /> : null}
                {t("connection.saveConnection")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>

      <Dialog open={sshPickerOpen} onOpenChange={setSshPickerOpen}>
        <DialogContent className="max-w-xl border-border bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>{t("connection.importDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("connection.importDialogDesc")}
            </DialogDescription>
          </DialogHeader>

          <Input
            value={sshSearch}
            onChange={(event) => setSshSearch(event.target.value)}
            placeholder={t("connection.importSearchPlaceholder")}
          />

          <div className="flex max-h-[min(22rem,55vh)] flex-col gap-2 overflow-y-auto">
            {filteredSshCandidates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                {sshConfigCandidates.length === 0 ? t("connection.importEmpty") : t("connection.importNoMatch")}
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
                      {candidate.authType === "privateKey" ? t("connection.authType.privateKey") : t("connection.authType.password")}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={handleCloseDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 />
              {t("connection.deleteDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("connection.deleteDialogDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-foreground">
              {t("connection.deleteDialogPrompt", { name: form.name })}
            </p>
            <Input
              value={deleteConfirmName}
              onChange={(event) => setDeleteConfirmName(event.target.value)}
              placeholder={t("connection.deleteDialogInputPlaceholder")}
              disabled={isDeleting}
              autoComplete="off"
              spellCheck={false}
            />
            {deleteConfirmName.trim().length > 0 &&
            deleteConfirmName.trim() !== form.name.trim() ? (
              <p className="text-xs text-destructive">
                {t("connection.deleteDialogInputMismatch")}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("connection.deleteDialogCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting || deleteConfirmName.trim() !== form.name.trim()}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDelete()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {t("connection.deleteDialogConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
