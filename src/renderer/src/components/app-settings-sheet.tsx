import { Moon, Sun } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { useThemeStore } from "@/store/theme-store"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AppSettingsSheet({ open, onOpenChange }: Props) {
  const { theme, setTheme } = useThemeStore()
  const isDark = theme === "dark"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-1 text-left">
          <SheetTitle>设置</SheetTitle>
          <SheetDescription>应用外观与关于信息。界面组件优先使用 shadcn/ui。</SheetDescription>
        </SheetHeader>

        <div className="mt-6 flex flex-col gap-6 pb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">外观</CardTitle>
              <CardDescription>与侧栏顶栏中的主题按钮同步。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="theme-dark" className="text-foreground">
                    深色模式
                  </Label>
                  <p className="text-xs text-muted-foreground">使用系统语义色与卡片对比度。</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Sun className="size-4 text-muted-foreground" />
                  <Switch
                    id="theme-dark"
                    checked={isDark}
                    onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                  />
                  <Moon className="size-4 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">关于</CardTitle>
              <CardDescription>digwis-panel · 本地 VPS 控制与监控</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>组件库位于 <code className="text-foreground">src/renderer/src/components/ui</code>，与 shadcn CLI 的 <code className="text-foreground">components.json</code> 对齐。</p>
              <p className="text-xs">
                shadcn 为按需拷贝源码；仓库内已包含常用 Radix 封装组件。若需更多区块，可在项目根目录执行{" "}
                <code className="text-foreground">npx shadcn@latest add …</code>。
              </p>
            </CardContent>
          </Card>
        </div>
      </SheetContent>
    </Sheet>
  )
}
