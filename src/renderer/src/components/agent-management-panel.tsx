import { useEffect, useMemo, useState } from "react"
import { Bot, Globe, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useProjectStore } from "@/store/project-store"
import type {
  OpenClawInstance,
  OpenClawPrecheckReason,
} from "../../../shared/projects"
import type { VpsConnectionRecord } from "../../../shared/vps"
import { OpenClawInstallDialog } from "./openclaw-install-dialog"
import { OpenClawInstanceCard } from "./openclaw-instance-card"
import { OpenClawLogDrawer } from "./openclaw-log-drawer"

export const PRECHECK_TEXT: Record<OpenClawPrecheckReason, string> = {
  node_missing: "未检测到 Node.js",
  node_too_old: "Node 版本低于 20，需要升级",
  memory_low: "可用内存不足 350MB",
  port_in_use: "目标端口已被占用",
  systemd_missing: "当前系统未启用 systemd",
  instance_limit_reached: "已达单 VPS 实例上限（4 只）",
}

export function AgentManagementPanel({
  connections,
  selectedConnectionId,
}: {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
}) {
  const {
    scanResult,
    isScanning,
    scanError,
    scanForConnection,
    openclawInstances,
    openclawLoading,
    openclawError,
    loadOpenClawInstances,
  } = useProjectStore()
  const [installOpen, setInstallOpen] = useState(false)
  const [logTarget, setLogTarget] = useState<OpenClawInstance | null>(null)

  const connection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId),
    [connections, selectedConnectionId],
  )

  useEffect(() => {
    if (!selectedConnectionId) return
    void scanForConnection(selectedConnectionId)
    void loadOpenClawInstances(selectedConnectionId)
  }, [selectedConnectionId, scanForConnection, loadOpenClawInstances])

  if (!selectedConnectionId || !connection) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        先选择一台 VPS
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {connection.name} 上的代理
          </h2>
          <p className="text-xs text-muted-foreground">
            Nginx 反向代理站点 + 已安装的 OpenClaw（小龙虾）实例
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void scanForConnection(selectedConnectionId)
              void loadOpenClawInstances(selectedConnectionId)
            }}
          >
            <RefreshCw className={isScanning || openclawLoading ? "size-4 animate-spin" : "size-4"} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <Plus className="size-4" />
            {openclawInstances.length === 0 ? "一键安装 OpenClaw" : "再加一只"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Globe className="size-4" /> Nginx 反向代理站点
        </div>
        {scanError ? (
          <Card>
            <CardContent className="text-sm text-destructive">{scanError}</CardContent>
          </Card>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {scanResult?.projects.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.domain}</span>
                  <span className="text-xs text-muted-foreground">{p.proxyTarget}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  项目路径：<code>{p.projectPath ?? "未识别"}</code>
                </div>
                <div className="text-xs text-muted-foreground">
                  Nginx 配置：<code>{p.nginxConfigPath}</code>
                </div>
                <div className="text-xs text-muted-foreground">推断来源：{p.pathSource}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bot className="size-4" /> 已安装的 OpenClaw
        </div>
        {openclawError ? (
          <Card>
            <CardContent className="text-sm text-destructive">{openclawError}</CardContent>
          </Card>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {openclawInstances.map((inst) => (
            <OpenClawInstanceCard
              key={inst.id}
              instance={inst}
              onShowLogs={() => setLogTarget(inst)}
              connectionId={selectedConnectionId}
            />
          ))}
          {openclawInstances.length === 0 && !openclawLoading ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-2 p-5 text-sm text-muted-foreground">
                <p>这台 VPS 还没有装 OpenClaw。</p>
                <p className="text-xs">点击右上角“一键安装 OpenClaw”开始安装。</p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </section>

      <OpenClawInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        connectionId={selectedConnectionId}
        existingInstances={openclawInstances}
      />

      <OpenClawLogDrawer
        target={logTarget}
        connectionId={selectedConnectionId}
        onClose={() => setLogTarget(null)}
      />
    </div>
  )
}