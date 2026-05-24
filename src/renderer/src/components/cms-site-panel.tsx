import { useEffect, useState } from "react"
import { Globe, Plus, Trash2, LoaderCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useCmsStore } from "@/store/cms-store"

type CreateSiteForm = {
  hostname: string
  label: string
  databaseUrl: string
  spaceMode: "standard" | "theme"
}

const initialForm: CreateSiteForm = {
  hostname: "",
  label: "",
  databaseUrl: "",
  spaceMode: "standard",
}

export function CmsSitePanel() {
  const {
    sites,
    selectedHostname,
    isLoadingSites,
    loadSites,
    selectSite,
    createSite,
    deleteSite,
  } = useCmsStore()

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [form, setForm] = useState<CreateSiteForm>(initialForm)
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  const updateField = <K extends keyof CreateSiteForm>(key: K, value: CreateSiteForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleCreate = async () => {
    setIsCreating(true)
    try {
      await createSite(form)
      setForm(initialForm)
      setShowCreateForm(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleDelete = async (hostname: string) => {
    if (!confirm(`确定要删除站点 ${hostname} 吗？`)) return
    await deleteSite(hostname)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">站点管理</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreateForm((v) => !v)}
        >
          {showCreateForm ? "取消" : <><Plus className="mr-1 size-4" />创建站点</>}
        </Button>
      </div>

      {showCreateForm && (
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">新建站点</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground">主机名</Label>
                <Input
                  value={form.hostname}
                  onChange={(e) => updateField("hostname", e.target.value)}
                  placeholder="example.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground">标签</Label>
                <Input
                  value={form.label}
                  onChange={(e) => updateField("label", e.target.value)}
                  placeholder="我的站点"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground">数据库 URL</Label>
                <Input
                  value={form.databaseUrl}
                  onChange={(e) => updateField("databaseUrl", e.target.value)}
                  placeholder="postgresql://user:pass@localhost:5432/db"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground">空间模式</Label>
                <Select
                  value={form.spaceMode}
                  onValueChange={(v) => updateField("spaceMode", v as "standard" | "theme")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">标准模式</SelectItem>
                    <SelectItem value="theme">主题模式</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              onClick={handleCreate}
              disabled={isCreating || !form.hostname || !form.label}
              className="self-end"
            >
              {isCreating && <LoaderCircle className="animate-spin" />}
              创建
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoadingSites ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <LoaderCircle className="mr-2 animate-spin size-5" />
          加载站点列表…
        </div>
      ) : sites.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          暂无站点，点击上方按钮创建。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sites.map((site) => (
            <Card
              key={site.hostname}
              className={cn(
                "cursor-pointer border-border transition-colors hover:bg-muted/50",
                selectedHostname === site.hostname && "border-primary bg-muted/60",
              )}
              onClick={() => selectSite(site.hostname)}
            >
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{site.label || site.hostname}</p>
                    <p className="truncate text-xs text-muted-foreground">{site.hostname}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">{site.spaceMode}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(site.hostname)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
