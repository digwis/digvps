import { FileText, Power, Trash2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useProjectStore } from "@/store/project-store"
import type { OpenClawInstance } from "../../../shared/projects"

const STATUS_TONE: Record<OpenClawInstance["status"], string> = {
  running: "bg-emerald-500/10 text-emerald-700",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
}

export function OpenClawInstanceCard({
  instance,
  onShowLogs,
  connectionId,
}: {
  instance: OpenClawInstance
  onShowLogs: () => void
  connectionId: string
}) {
  const { restartOpenClaw, uninstallOpenClaw } = useProjectStore()
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">OpenClaw · :{instance.listenPort}</p>
            <p className="text-xs text-muted-foreground">
              service：<code>{instance.serviceName}</code>
            </p>
          </div>
          <Badge className={STATUS_TONE[instance.status]}>{instance.status}</Badge>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <div>Node：{instance.nodeVersion ?? "未识别"}</div>
          <div>版本：{instance.openclawVersion ?? "未识别"}</div>
          <div>
            数据目录：<code>{instance.dataDir}</code>
          </div>
          <div>安装时间：{new Date(instance.installedAt).toLocaleString()}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onShowLogs}>
            <FileText className="size-4" /> 日志
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void restartOpenClaw(instance.id, connectionId)}
          >
            <Power className="size-4" /> 重启
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (confirm(`确认卸载 OpenClaw :${instance.listenPort}？`)) {
                void uninstallOpenClaw(instance.id, connectionId)
              }
            }}
          >
            <Trash2 className="size-4" /> 卸载
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}