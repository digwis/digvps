import { useEffect, useMemo, useState } from "react"
import {
  ExternalLink,
  FolderKanban,
  FolderOpen,
  Globe,
  LoaderCircle,
  RefreshCw,
  ServerOff,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useProjectStore } from "@/store/project-store"
import type { RemoteManagedProject, RemoteManagedProjectPathSource } from "../../../shared/projects"
import type { VpsConnectionRecord } from "../../../shared/vps"

export type ProjectManagementPanelProps = {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
  highlightedProjectId?: string
  onOpenRemoteDirectory?: (payload: { connectionId: string; path: string; projectId: string }) => void
}

const PATH_SOURCE_LABEL: Record<RemoteManagedProjectPathSource, string> = {
  systemd: "systemd",
  pm2: "pm2",
  docker: "docker",
  heuristic: "目录启发",
  unknown: "未识别",
}

const STATUS_TONE: Record<RemoteManagedProject["status"], string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unknown: "bg-muted text-muted-foreground",
}

function connectionLabel(connections: VpsConnectionRecord[], id?: string | null) {
  if (!id) return ""
  return connections.find((c) => c.id === id)?.name ?? ""
}

function ProjectCard({
  project,
  onOpen,
  highlight,
}: {
  project: RemoteManagedProject
  onOpen: (path: string) => void
  highlight: boolean
}) {
  return (
    <Card
      className={`transition-all ${
        highlight ? "ring-2 ring-primary/40" : ""
      }`}
    >
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="grid size-10 place-items-center rounded-2xl bg-muted text-muted-foreground">
              <Globe className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-foreground">
                {project.domain}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                代理目标：<span className="font-mono text-foreground">{project.proxyTarget}</span>
              </p>
            </div>
          </div>
          <Badge className={STATUS_TONE[project.status]}>
            {project.statusText || PATH_SOURCE_LABEL[project.pathSource]}
          </Badge>
        </div>

        <div className="grid gap-2 rounded-2xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span>项目路径</span>
            {project.projectPath ? (
              <code className="truncate rounded-md bg-background px-2 py-1 font-mono text-foreground">
                {project.projectPath}
              </code>
            ) : (
              <span className="rounded-md bg-background px-2 py-1 text-foreground/70">
                路径未识别
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>Nginx 配置</span>
            <code className="truncate rounded-md bg-background px-2 py-1 font-mono text-foreground">
              {project.nginxConfigPath}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>推断来源</span>
            <span className="rounded-md bg-background px-2 py-1 text-foreground">
              {PATH_SOURCE_LABEL[project.pathSource]}
            </span>
            {project.serviceName ? (
              <span className="rounded-md bg-background px-2 py-1 font-mono text-foreground">
                {project.serviceName}
              </span>
            ) : null}
          </div>
        </div>

        {project.projectPath ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => onOpen(project.projectPath!)}
            >
              <FolderOpen className="size-4" />
              打开远程目录
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function ProjectManagementPanel({
  connections,
  selectedConnectionId,
  highlightedProjectId,
  onOpenRemoteDirectory,
}: ProjectManagementPanelProps) {
  const { scanResult, isScanning, scanError, scanForConnection, clearScan } =
    useProjectStore()
  const [hasAutoScanned, setHasAutoScanned] = useState(false)

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId),
    [connections, selectedConnectionId],
  )

  useEffect(() => {
    if (!selectedConnectionId) {
      clearScan()
      setHasAutoScanned(false)
      return
    }
    if (scanResult?.connectionId !== selectedConnectionId) {
      clearScan()
    }
    if (!hasAutoScanned) {
      setHasAutoScanned(true)
      void scanForConnection(selectedConnectionId)
    }
  }, [
    selectedConnectionId,
    scanResult?.connectionId,
    scanForConnection,
    clearScan,
    hasAutoScanned,
  ])

  if (!selectedConnectionId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
        <FolderKanban className="size-10 text-muted-foreground/60" />
        <p className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          先选择一台 VPS
        </p>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          在右上角新建或选择一条 VPS 连接，即可自动扫描这台服务器上由 Nginx 反向代理对外服务的项目。
        </p>
      </div>
    )
  }

  if (!selectedConnection) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center dark:border-white/10 dark:bg-white/[0.03]">
        <ServerOff className="size-10 text-muted-foreground/60" />
        <p className="text-lg font-medium text-foreground">
          当前选择已失效，请重新选择服务器
        </p>
      </div>
    )
  }

  const handleOpen = (path: string) => {
    if (!onOpenRemoteDirectory || !selectedConnectionId) {
      return
    }
    onOpenRemoteDirectory({
      connectionId: selectedConnectionId,
      path,
      projectId: path,
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {connectionLabel(connections, selectedConnectionId)} 上的项目
          </h2>
          <p className="text-xs text-muted-foreground">
            自动扫描 Nginx 反向代理站点，路径推断来源包括 systemd、pm2、docker 与常见目录启发。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {scanResult ? (
            <span className="text-xs text-muted-foreground">
              最近扫描于 {new Date(scanResult.scannedAt).toLocaleTimeString()}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isScanning}
            onClick={() => void scanForConnection(selectedConnectionId)}
          >
            {isScanning ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {isScanning ? "扫描中" : "刷新扫描"}
          </Button>
        </div>
      </div>

      {scanError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
          {scanError}
        </div>
      ) : null}

      {isScanning && (!scanResult || scanResult.projects.length === 0) ? (
        <div className="flex flex-1 items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
          正在读取 Nginx 配置并反推项目路径…
        </div>
      ) : scanResult && scanResult.projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-muted/15 px-6 py-16 text-center text-sm text-muted-foreground">
          <Globe className="size-8 text-muted-foreground/60" />
          <p>未检测到由 Nginx 反向代理对外服务的项目。</p>
          <p className="text-xs text-muted-foreground/80">
            确认这台服务器已经安装 Nginx，并在 /etc/nginx/conf.d 或 sites-enabled 下配置了 proxy_pass 站点。
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {scanResult?.projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={handleOpen}
              highlight={project.id === highlightedProjectId}
            />
          ))}
        </div>
      )}

      {scanResult && scanResult.projects.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          共 {scanResult.projects.length} 个反向代理项目。
          <a
            className="ml-2 inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            href={selectedConnection?.host ? `https://${selectedConnection.host}` : undefined}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-3" />
            在浏览器打开主机
          </a>
        </div>
      ) : null}
    </div>
  )
}