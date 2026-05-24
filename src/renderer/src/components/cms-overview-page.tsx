import { useEffect, useState } from "react"
import { Globe, LogOut } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCmsStore } from "@/store/cms-store"
import { CmsLoginDialog } from "@/components/cms-login-dialog"
import { CmsSitePanel } from "@/components/cms-site-panel"
import { CmsContentPanel } from "@/components/cms-content-panel"

export function CmsOverviewPage() {
  const {
    isAuthenticated,
    selectedSite,
    restoreSession,
    loadSites,
    logout,
  } = useCmsStore()

  const [loginOpen, setLoginOpen] = useState(false)

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  useEffect(() => {
    if (isAuthenticated) {
      void loadSites()
    }
  }, [isAuthenticated, loadSites])

  useEffect(() => {
    if (!isAuthenticated) {
      setLoginOpen(true)
    }
  }, [isAuthenticated])

  if (!isAuthenticated) {
    return <CmsLoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
  }

  if (!selectedSite) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <CmsSitePanel />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{selectedSite.hostname}</span>
          <Badge variant="secondary">{selectedSite.spaceMode}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="mr-1 size-4" />
          退出
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <CmsContentPanel />
      </div>
    </div>
  )
}
