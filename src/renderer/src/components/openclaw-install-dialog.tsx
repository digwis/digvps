import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useProjectStore } from "@/store/project-store"
import type {
  OpenClawInstance,
  OpenClawPrecheck,
  OpenClawPrecheckReason,
} from "../../../shared/projects"
import { PRECHECK_TEXT } from "./agent-management-panel"

const MAX_INSTANCES = 4

export function OpenClawInstallDialog({
  open,
  onOpenChange,
  connectionId,
  existingInstances,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connectionId: string
  existingInstances: OpenClawInstance[]
}) {
  const { precheckOpenClaw, installOpenClaw } = useProjectStore()
  const [port, setPort] = useState(18789)
  const [precheck, setPrecheck] = useState<OpenClawPrecheck | null>(null)
  const [progress, setProgress] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!open) return
    const usedPorts = new Set(existingInstances.map((i) => i.listenPort))
    let next = 18789
    for (let i = 0; i < MAX_INSTANCES; i += 1) {
      if (!usedPorts.has(18789 + i)) {
        next = 18789 + i
        break
      }
    }
    setPort(next)
  }, [open, existingInstances])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void precheckOpenClaw({ connectionId, listenPort: port })
      .then((value) => {
        if (!cancelled) setPrecheck(value)
      })
      .catch(() => {
        if (!cancelled) setPrecheck({ ready: false, reasons: [], existingInstances: 0, portInUse: false })
      })
    return () => {
      cancelled = true
    }
  }, [open, port, connectionId, precheckOpenClaw])

  const submit = async () => {
    setInstalling(true)
    setProgress([])
    try {
      const inst = await installOpenClaw({ connectionId, listenPort: port })
      setProgress((p) => [...p, `已安装 ${inst.serviceName}@${inst.listenPort}`])
      setTimeout(() => onOpenChange(false), 800)
    } catch (error) {
      setProgress((p) => [...p, `安装失败：${error instanceof Error ? error.message : String(error)}`])
    } finally {
      setInstalling(false)
    }
  }

  const reasons: OpenClawPrecheckReason[] = precheck?.reasons ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>安装 OpenClaw（小龙虾）</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span>监听端口</span>
            <Input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
          {precheck?.nodeVersion ? (
            <p className="text-xs text-muted-foreground">Node 版本：{precheck.nodeVersion}</p>
          ) : null}
          {reasons.length > 0 ? (
            <ul className="list-disc pl-4 text-xs text-destructive">
              {reasons.map((r) => (
                <li key={r}>{PRECHECK_TEXT[r]}</li>
              ))}
            </ul>
          ) : precheck ? (
            <p className="text-xs text-emerald-600">预检通过，可以安装。</p>
          ) : null}
          {progress.length > 0 ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {progress.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            取消
          </Button>
          <Button onClick={submit} disabled={installing || !precheck?.ready}>
            {installing ? "安装中" : "开始安装"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}