import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ClipboardCopy, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useVpsStore } from "@/store/vps-store"
import { useShallow } from "zustand/react/shallow"
import type { VpsConnectionInput, VpsConnectionRecord } from "../../../shared/vps"

type Props = {
  connection: VpsConnectionRecord | undefined
}

function getManualUpgradeCommands(isRoot: boolean) {
  const prefix = isRoot ? "" : "sudo "
  return `${prefix}apt-get update
${prefix}DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
${prefix}apt-get autoremove -y`
}

export function SystemUpgradePrompt({
  connection,
}: Props) {
  const { t } = useTranslation()
  const {
    upgradePrompt,
    upgradePromptForConnectionId,
    dismissUpgradePrompt,
    applyRemoteSystemUpgrade,
    inspectConnection,
    isApplyingUpgrade,
  } = useVpsStore(
    useShallow((s) => ({
      upgradePrompt: s.upgradePrompt,
      upgradePromptForConnectionId: s.upgradePromptForConnectionId,
      dismissUpgradePrompt: s.dismissUpgradePrompt,
      applyRemoteSystemUpgrade: s.applyRemoteSystemUpgrade,
      inspectConnection: s.inspectConnection,
      isApplyingUpgrade: s.isApplyingUpgrade,
    }))
  )

  const [reboot, setReboot] = useState(false)
  const [copied, setCopied] = useState(false)
  const isRoot = connection?.username === "root"
  const manualUpgradeCommands = getManualUpgradeCommands(isRoot)

  const copyManualCommands = async () => {
    try {
      await navigator.clipboard.writeText(manualUpgradeCommands)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const open =
    Boolean(connection) &&
    Boolean(upgradePrompt) &&
    upgradePromptForConnectionId === connection?.id &&
    upgradePrompt!.supported &&
    upgradePrompt!.upgradableCount > 0

  const onOpenChange = (next: boolean) => {
    if (isApplyingUpgrade) {
      return
    }
    if (!next) {
      dismissUpgradePrompt()
      setReboot(false)
    }
  }

  const handleConfirm = async () => {
    if (!connection) {
      return
    }
    const payload = connection as VpsConnectionInput
    try {
      const result = await applyRemoteSystemUpgrade(payload, { reboot })
      setReboot(false)
      if (result.ok && !result.likelyRebooting) {
        void inspectConnection(payload, { forceRefresh: true })
      }
    } catch {
      // 错误文案已由 store 写入 error
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-border bg-card text-card-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("upgrade.title")}</DialogTitle>
          <DialogDescription>
            {t("upgrade.desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            {t("upgrade.countDesc", { count: upgradePrompt?.upgradableCount })}
            {!upgradePrompt?.indexRefreshed ? (
              <>
                {" "}
                {t(isRoot ? "upgrade.rootAptUpdateHint" : "upgrade.aptUpdateHint")}
              </>
            ) : null}
          </p>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-foreground">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("upgrade.terminalCmd")}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t(isRoot ? "upgrade.rootTerminalCmdDesc" : "upgrade.terminalCmdDesc")}
            </p>
            <code className="mt-2 block whitespace-pre-wrap break-all rounded-md border border-border bg-background/80 px-2 py-2 text-xs text-foreground">
              {manualUpgradeCommands}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3 gap-2"
              disabled={isApplyingUpgrade}
              onClick={() => void copyManualCommands()}
            >
              <ClipboardCopy className="size-3.5" />
              {copied ? t("upgrade.copiedBtn") : t("upgrade.copyBtn")}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(isRoot ? "upgrade.rootRebootHint" : "upgrade.rebootHint")}
            </p>
          </div>

          <div className="rounded-lg border border-border/80 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("upgrade.oneClickTitle")}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("upgrade.oneClickDesc")}
            </p>
            {!isRoot ? (
              <>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t("upgrade.oneClickPwdHint")}
                </p>
                <p className="mt-2 text-xs text-destructive">{t("upgrade.needPwd")}</p>
              </>
            ) : null}
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-1 size-4 rounded border border-input"
                checked={reboot}
                onChange={(event) => setReboot(event.target.checked)}
              />
              <span className="text-sm">{t("upgrade.rebootLabel")}</span>
            </label>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={isApplyingUpgrade} onClick={() => onOpenChange(false)}>
            {t("upgrade.closeBtn")}
          </Button>
          <Button type="button" disabled={isApplyingUpgrade} onClick={() => void handleConfirm()}>
            {isApplyingUpgrade ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {t("upgrade.applyBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
