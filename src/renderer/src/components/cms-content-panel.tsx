import { useEffect, useState } from "react"
import { FileText, Plus, LoaderCircle, Tag } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useCmsStore } from "@/store/cms-store"

type CreateTypeForm = {
  key: string
  name: string
  description: string
}

type CreateEntryForm = {
  title: string
  slug: string
  summary: string
}

const initialTypeForm: CreateTypeForm = { key: "", name: "", description: "" }
const initialEntryForm: CreateEntryForm = { title: "", slug: "", summary: "" }

export function CmsContentPanel() {
  const {
    contentTypes,
    entries,
    selectedHostname,
    isLoadingContentTypes,
    isLoadingEntries,
    loadContentTypes,
    createContentType,
    loadEntries,
    createEntry,
  } = useCmsStore()

  const [selectedTypeKey, setSelectedTypeKey] = useState<string | null>(null)
  const [showCreateType, setShowCreateType] = useState(false)
  const [showCreateEntry, setShowCreateEntry] = useState(false)
  const [typeForm, setTypeForm] = useState<CreateTypeForm>(initialTypeForm)
  const [entryForm, setEntryForm] = useState<CreateEntryForm>(initialEntryForm)
  const [isCreatingType, setIsCreatingType] = useState(false)
  const [isCreatingEntry, setIsCreatingEntry] = useState(false)

  useEffect(() => {
    if (!selectedHostname) return
    void loadContentTypes()
  }, [selectedHostname, loadContentTypes])

  useEffect(() => {
    if (!selectedHostname) return
    void loadEntries(selectedTypeKey ?? undefined)
  }, [selectedHostname, selectedTypeKey, loadEntries])

  const handleCreateType = async () => {
    setIsCreatingType(true)
    try {
      await createContentType(typeForm)
      setTypeForm(initialTypeForm)
      setShowCreateType(false)
    } finally {
      setIsCreatingType(false)
    }
  }

  const handleCreateEntry = async () => {
    if (!selectedTypeKey) return
    setIsCreatingEntry(true)
    try {
      await createEntry({
        typeKey: selectedTypeKey,
        title: entryForm.title,
        slug: entryForm.slug || undefined,
        summary: entryForm.summary || undefined,
      })
      setEntryForm(initialEntryForm)
      setShowCreateEntry(false)
    } finally {
      setIsCreatingEntry(false)
    }
  }

  return (
    <div className="flex gap-4">
      <div className="flex w-64 shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">内容类型</h3>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setShowCreateType((v) => !v)}
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {showCreateType && (
          <Card className="border-border">
            <CardContent className="flex flex-col gap-2 pt-4">
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">Key</Label>
                <Input
                  value={typeForm.key}
                  onChange={(e) => setTypeForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="article"
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">名称</Label>
                <Input
                  value={typeForm.name}
                  onChange={(e) => setTypeForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="文章"
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">描述</Label>
                <Input
                  value={typeForm.description}
                  onChange={(e) => setTypeForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="可选"
                  className="h-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                onClick={handleCreateType}
                disabled={isCreatingType || !typeForm.key || !typeForm.name}
              >
                {isCreatingType && <LoaderCircle className="animate-spin" />}
                创建
              </Button>
            </CardContent>
          </Card>
        )}

        {isLoadingContentTypes ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <LoaderCircle className="mr-2 animate-spin size-4" />
            加载中…
          </div>
        ) : contentTypes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无内容类型
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {contentTypes.map((ct) => (
              <button
                key={ct.key}
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  selectedTypeKey === ct.key && "bg-muted font-medium",
                )}
                onClick={() => setSelectedTypeKey(ct.key)}
              >
                <Tag className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{ct.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{ct.key}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {selectedTypeKey ? `条目 · ${selectedTypeKey}` : "条目"}
          </h3>
          {selectedTypeKey && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setShowCreateEntry((v) => !v)}
            >
              <Plus className="size-4" />
            </Button>
          )}
        </div>

        {showCreateEntry && selectedTypeKey && (
          <Card className="mt-3 border-border">
            <CardContent className="flex flex-col gap-2 pt-4">
              <div className="grid gap-2 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">标题</Label>
                  <Input
                    value={entryForm.title}
                    onChange={(e) => setEntryForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="文章标题"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Slug</Label>
                  <Input
                    value={entryForm.slug}
                    onChange={(e) => setEntryForm((f) => ({ ...f, slug: e.target.value }))}
                    placeholder="article-slug"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">摘要</Label>
                <Input
                  value={entryForm.summary}
                  onChange={(e) => setEntryForm((f) => ({ ...f, summary: e.target.value }))}
                  placeholder="可选"
                  className="h-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                onClick={handleCreateEntry}
                disabled={isCreatingEntry || !entryForm.title}
                className="self-end"
              >
                {isCreatingEntry && <LoaderCircle className="animate-spin" />}
                创建条目
              </Button>
            </CardContent>
          </Card>
        )}

        {!selectedTypeKey ? (
          <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            请在左侧选择一个内容类型以查看条目。
          </div>
        ) : isLoadingEntries ? (
          <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
            <LoaderCircle className="mr-2 animate-spin size-4" />
            加载条目…
          </div>
        ) : entries.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            该类型下暂无条目。
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {entries.map((entry) => (
              <Card key={entry.id ?? entry.slug} className="border-border">
                <CardContent className="flex items-start justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{entry.title}</p>
                      {entry.summary && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {entry.summary}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {entry.editorialStatus && (
                          <Badge variant="secondary" className="text-xs">
                            {entry.editorialStatus}
                          </Badge>
                        )}
                        {entry.createdAt && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
