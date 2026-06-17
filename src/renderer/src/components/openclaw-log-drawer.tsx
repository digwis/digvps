import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useProjectStore } from "@/store/project-store"
import type { OpenClawInstance } from "../../../shared/projects"

export function OpenClawLogDrawer({
  target,
  connectionId,
  onClose,
}: {
  target: OpenClawInstance | null
  connectionId: string
  onClose: () => void
}) {
  const { fetchOpenClawLogs } = useProjectStore()
  const [logs, setLogs] = useState("")
  useEffect(() => {
    if (!target) {
      setLogs("")
      return
    }
    let cancelled = false
    void fetchOpenClawLogs(target.id, connectionId, 100).then((value) => {
      if (!cancelled) setLogs(value)
    })
    return () => {
      cancelled = true
    }
  }, [target, connectionId, fetchOpenClawLogs])
  return (
    <Dialog open={!!target} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>OpenClaw 日志：{target?.serviceName}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
          {logs || "暂无日志"}
        </pre>
      </DialogContent>
    </Dialog>
  )
}