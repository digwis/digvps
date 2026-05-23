import { useState } from "react"
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
import type { VpsConnectionInput, VpsConnectionRecord } from "../../../shared/vps"

type Props = {
  connection: VpsConnectionRecord | undefined
}

const MANUAL_UPGRADE_COMMANDS = `sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
sudo apt-get autoremove -y`

export function SystemUpgradePrompt({ connection }: Props) {
  const upgradePrompt = useVpsStore((s) => s.upgradePrompt)
  const upgradePromptForConnectionId = useVpsStore((s) => s.upgradePromptForConnectionId)
  const dismissUpgradePrompt = useVpsStore((s) => s.dismissUpgradePrompt)
  const applyRemoteSystemUpgrade = useVpsStore((s) => s.applyRemoteSystemUpgrade)
  const inspectConnection = useVpsStore((s) => s.inspectConnection)
  const isApplyingUpgrade = useVpsStore((s) => s.isApplyingUpgrade)

  const [reboot, setReboot] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyManualCommands = async () => {
    try {
      await navigator.clipboard.writeText(MANUAL_UPGRADE_COMMANDS)
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
          <DialogTitle>检测到系统软件包可更新</DialogTitle>
          <DialogDescription>
            这台服务器有可更新的软件包。你可以自己在 SSH 里执行命令，或在面板里一键更新。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            检测到 <span className="font-medium text-foreground">{upgradePrompt?.upgradableCount}</span> 个可升级项。
            {!upgradePrompt?.indexRefreshed ? (
              <>
                {" "}
                如果你刚改过软件源，先执行 <code className="text-foreground">sudo apt-get update</code> 再更新。
              </>
            ) : null}
          </p>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-foreground">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">终端命令</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">登录服务器后直接执行，可按提示输入 sudo 密码。</p>
            <code className="mt-2 block whitespace-pre-wrap break-all rounded-md border border-border bg-background/80 px-2 py-2 text-xs text-foreground">
              {MANUAL_UPGRADE_COMMANDS}
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
              {copied ? "已复制" : "复制上述命令"}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              若内核有更新，升级完成后可自行执行 <code className="text-foreground">sudo reboot</code>。
            </p>
          </div>

          <div className="rounded-lg border border-border/80 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">一键更新说明</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              下方按钮会通过 SSH 在服务器上直接执行同样的升级命令。
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              如果之前一键更新失败，通常是因为账户<strong className="font-medium text-foreground">没有配置免密 sudo</strong>，而不是没有 sudo 权限。
            </p>
            <p className="mt-2 text-xs text-destructive">需要输入 sudo 密码时，请改用上面的终端命令。</p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-1 size-4 rounded border border-input"
                checked={reboot}
                onChange={(event) => setReboot(event.target.checked)}
              />
              <span className="text-sm">完成后立即重启主机（会中断 SSH，请确保已保存工作）</span>
            </label>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={isApplyingUpgrade} onClick={() => onOpenChange(false)}>
            关闭（我自行在服务器处理）
          </Button>
          <Button type="button" disabled={isApplyingUpgrade} onClick={() => void handleConfirm()}>
            {isApplyingUpgrade ? <LoaderCircle className="size-4 animate-spin" /> : null}
            在服务器执行 apt 升级
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
