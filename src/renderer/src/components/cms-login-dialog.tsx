import { useState } from "react"
import { Server, Lock, User, LoaderCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useCmsStore } from "@/store/cms-store"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CmsLoginDialog({ open, onOpenChange }: Props) {
  const { isLoggingIn, loginError, login, apiUrl: storedApiUrl } = useCmsStore()
  const [apiUrl, setApiUrl] = useState(storedApiUrl || "http://localhost:8080")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await login(apiUrl, username, password)
      onOpenChange(false)
    } catch {}
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border bg-card text-card-foreground">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Server className="size-5" />
            连接 CMS API
          </DialogTitle>
          <DialogDescription>
            输入 Go API 地址和登录凭据以连接内容管理系统。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-1.5 text-muted-foreground">
              <Server className="size-3.5" />
              API 地址
            </Label>
            <Input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://localhost:8080"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-1.5 text-muted-foreground">
              <User className="size-3.5" />
              用户名
            </Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-1.5 text-muted-foreground">
              <Lock className="size-3.5" />
              密码
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
            />
          </div>

          {loginError && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loginError}
            </div>
          )}

          <Button type="submit" disabled={isLoggingIn || !apiUrl || !username || !password}>
            {isLoggingIn && <LoaderCircle className="animate-spin" />}
            登录
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
