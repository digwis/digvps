import { useTranslation } from "react-i18next"
import { useEffect, useRef, useState } from "react"
import { Import, LoaderCircle, Plus, Save, Server } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useVpsStore } from "@/store/vps-store"

type Props = {
  children?: React.ReactNode
}

const HOST_TEMPLATE = `Host new-host
  HostName 203.0.113.42
  User root
  Port 22
  IdentityFile ~/.ssh/id_ed25519
`

export function SshConfigManagerDialog({
  children,
}: Props) {
  const { t } = useTranslation()
  const {
    rawSshConfig,
    loadRawSshConfig,
    saveRawSshConfig,
    isSavingRawSshConfig,
    info,
    error,
    clearFeedback,
  } = useVpsStore()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    void (async () => {
      const raw = await loadRawSshConfig()
      setDraft(raw?.content ?? "")
    })()
  }, [loadRawSshConfig, open])

  useEffect(() => {
    if (!open || !rawSshConfig) {
      return
    }
    setDraft(rawSshConfig.content)
  }, [open, rawSshConfig])

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      clearFeedback()
    }
  }

  const handleSave = async () => {
    const next = await saveRawSshConfig({ content: draft })
    setDraft(next.content)
  }

  const insertTemplate = () => {
    const separator = draft.trim().length > 0 && !draft.endsWith("\n") ? "\n\n" : draft.trim().length > 0 ? "\n" : ""
    const nextDraft = `${draft}${separator}${HOST_TEMPLATE}`
    setDraft(nextDraft)
    window.requestAnimationFrame(() => {
      const target = textareaRef.current
      if (!target) {
        return
      }
      target.focus()
      const start = nextDraft.length - HOST_TEMPLATE.length
      target.setSelectionRange(start, nextDraft.length)
    })
  }

  const isDirty = rawSshConfig ? draft !== rawSshConfig.content : Boolean(draft)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="flex max-h-[min(90vh,920px)] max-w-5xl flex-col gap-0 overflow-hidden border-border bg-card p-0 text-card-foreground">
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Server data-icon="inline-start" />
            {t("sshConfig.title")}
          </DialogTitle>
          <DialogDescription>
            {t("sshConfig.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
          <div className="flex h-full flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/50 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {t("sshConfig.rawNote")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={insertTemplate}>
                  <Plus />
                  {t("sshConfig.insertHost")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void (async () => {
                      const raw = await loadRawSshConfig()
                      setDraft(raw?.content ?? "")
                    })()
                  }}
                  disabled={isSavingRawSshConfig}
                >
                  <Import />
                  {t("common.refresh")}
                </Button>
                <Button onClick={() => void handleSave()} disabled={!isDirty || isSavingRawSshConfig}>
                  {isSavingRawSshConfig ? <LoaderCircle className="animate-spin" /> : <Save />}
                  {t("sshConfig.saveRaw")}
                </Button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-muted/30 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{t("sshConfig.rawTitle")}</p>
                <span className="text-xs text-muted-foreground">{t("sshConfig.rawDesc")}</span>
              </div>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-xl border border-input bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={`# ~/.ssh/config\n\nHost example\n  HostName 203.0.113.42\n  User root\n  Port 22\n`}
              />
            </div>

            {(error || info) && (
              <div className="rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm">
                {error ? <p className="text-destructive">{error}</p> : <p className="text-primary">{info}</p>}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
