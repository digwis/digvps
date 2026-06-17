# Remote Project Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local-project-driven "项目部署" workflow with a VPS-driven "项目管理" workflow that scans Nginx reverse-proxy sites and shows inferred remote project paths.

**Architecture:** Keep the existing Electron + IPC + SSH stack, add a focused remote project scanner in the main process, and pivot the renderer from local database records to live scan results for the selected VPS. Remove the CMS navigation entry and all local scaffold/import entry points from the project page while reusing remote browsing capabilities where they still fit.

**Tech Stack:** Electron, TypeScript, React, Zustand, Zod, Vitest, SSH remote execution

---

## File Map

- Create: `src/main/services/remote-managed-projects.ts`
- Create: `src/main/services/__tests__/remote-managed-projects.test.ts`
- Modify: `src/shared/projects.ts`
- Modify: `src/main/ipc/schemas.ts`
- Modify: `src/main/ipc/register-project-handlers.ts`
- Modify: `src/renderer/src/lib/desktop-api.ts`
- Modify: `src/renderer/src/store/project-store.ts`
- Modify: `src/renderer/src/components/project-management-panel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/app-settings-page.tsx`
- Test: `src/main/services/__tests__/remote-managed-projects.test.ts`

### Task 1: Define Remote Project Contracts

**Files:**
- Modify: `src/shared/projects.ts`
- Modify: `src/main/ipc/schemas.ts`
- Modify: `src/renderer/src/lib/desktop-api.ts`
- Test: `src/main/ipc/__tests__/schemas.test.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
import { describe, expect, it } from "vitest"
import { parseOrThrow, connectionIdSchema } from "../schemas"
import { z } from "zod"

const remoteManagedProjectScanSchema = z.object({
  connectionId: connectionIdSchema,
})

describe("remoteManagedProjectScanSchema", () => {
  it("accepts a connection id payload", () => {
    expect(
      parseOrThrow(remoteManagedProjectScanSchema, {
        connectionId: "conn-123",
      }),
    ).toEqual({ connectionId: "conn-123" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/ipc/__tests__/schemas.test.ts`
Expected: FAIL because `remoteManagedProjectScanSchema` is not exported from `src/main/ipc/schemas.ts`.

- [ ] **Step 3: Add shared types and IPC contract**

```ts
export type RemoteManagedProjectPathSource =
  | "systemd"
  | "pm2"
  | "docker"
  | "heuristic"
  | "unknown"

export type RemoteManagedProject = {
  id: string
  connectionId: string
  domain: string
  nginxConfigPath: string
  proxyTarget: string
  projectPath?: string
  pathSource: RemoteManagedProjectPathSource
  serviceName?: string
  runtimeType?: "node" | "pm2" | "docker" | "unknown"
  status: "ok" | "warning" | "unknown"
  statusText: string
}

export type RemoteManagedProjectScanInput = {
  connectionId: string
}

export type RemoteManagedProjectScanResult = {
  connectionId: string
  projects: RemoteManagedProject[]
  scannedAt: string
}
```

```ts
export const remoteManagedProjectScanSchema = z.object({
  connectionId: connectionIdSchema,
})
```

```ts
scanRemoteProjects: (payload) =>
  wrapInvoke(() => requireMethod(api.projects.scanRemoteProjects, "远程项目扫描接口")(payload)),
```

- [ ] **Step 4: Run focused test and typecheck**

Run: `npm test -- src/main/ipc/__tests__/schemas.test.ts && npm run typecheck`
Expected: PASS for schema test and no TypeScript errors from the new contracts.

- [ ] **Step 5: Commit**

```bash
git add src/shared/projects.ts src/main/ipc/schemas.ts src/renderer/src/lib/desktop-api.ts src/main/ipc/__tests__/schemas.test.ts
git commit -m "feat: add remote managed project contracts"
```

### Task 2: Add Main-Process Remote Scanner

**Files:**
- Create: `src/main/services/remote-managed-projects.ts`
- Create: `src/main/services/__tests__/remote-managed-projects.test.ts`
- Modify: `src/main/ipc/register-project-handlers.ts`

- [ ] **Step 1: Write the failing scanner tests**

```ts
import { describe, expect, it } from "vitest"
import {
  parseNginxProxyServers,
  chooseProjectPath,
} from "../remote-managed-projects"

describe("parseNginxProxyServers", () => {
  it("extracts server_name and proxy_pass from nginx config", () => {
    const config = `
server {
  server_name app.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}
`
    expect(parseNginxProxyServers("/etc/nginx/conf.d/app.conf", config)).toEqual([
      expect.objectContaining({
        domain: "app.example.com",
        nginxConfigPath: "/etc/nginx/conf.d/app.conf",
        proxyTarget: "http://127.0.0.1:3000",
      }),
    ])
  })
})

describe("chooseProjectPath", () => {
  it("prefers systemd over pm2 and docker", () => {
    expect(
      chooseProjectPath({
        systemdPath: "/srv/app",
        pm2Path: "/var/www/app",
        dockerPath: "/opt/app",
        heuristicPath: "/home/deploy/app",
      }),
    ).toEqual({
      projectPath: "/srv/app",
      pathSource: "systemd",
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/services/__tests__/remote-managed-projects.test.ts`
Expected: FAIL because `src/main/services/remote-managed-projects.ts` does not exist yet.

- [ ] **Step 3: Implement a focused scanner service**

```ts
export function parseNginxProxyServers(configPath: string, content: string): RemoteManagedProject[] {
  const blocks = content.match(/server\s*\{[\s\S]*?\}/g) ?? []
  return blocks
    .map((block, index) => {
      const serverName = block.match(/server_name\s+([^;]+);/)?.[1]?.trim().split(/\s+/)[0]
      const proxyPass = block.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim()
      if (!serverName || !proxyPass) {
        return null
      }
      return {
        id: `${configPath}:${index}:${serverName}`,
        connectionId: "",
        domain: serverName,
        nginxConfigPath: configPath,
        proxyTarget: proxyPass,
        pathSource: "unknown",
        runtimeType: "unknown",
        status: "unknown",
        statusText: "已识别反向代理站点，尚未推断项目路径",
      } satisfies RemoteManagedProject
    })
    .filter((item): item is RemoteManagedProject => item !== null)
}

export function chooseProjectPath(paths: {
  systemdPath?: string
  pm2Path?: string
  dockerPath?: string
  heuristicPath?: string
}): { projectPath?: string; pathSource: RemoteManagedProjectPathSource } {
  if (paths.systemdPath) return { projectPath: paths.systemdPath, pathSource: "systemd" }
  if (paths.pm2Path) return { projectPath: paths.pm2Path, pathSource: "pm2" }
  if (paths.dockerPath) return { projectPath: paths.dockerPath, pathSource: "docker" }
  if (paths.heuristicPath) return { projectPath: paths.heuristicPath, pathSource: "heuristic" }
  return { pathSource: "unknown" }
}
```

```ts
registerIpcHandle(ipcMain, "projects:scanRemoteProjects", async (_event, rawPayload) => {
  const payload = parseOrThrow(remoteManagedProjectScanSchema, rawPayload)
  const connection = requireConnection(payload.connectionId)
  return await scanRemoteManagedProjects(resolveStoredPayload(connection))
})
```

- [ ] **Step 4: Run the new test and the related project IPC test set**

Run: `npm test -- src/main/services/__tests__/remote-managed-projects.test.ts src/main/ipc/__tests__/schemas.test.ts`
Expected: PASS with the new parser and IPC contract wired.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/remote-managed-projects.ts src/main/services/__tests__/remote-managed-projects.test.ts src/main/ipc/register-project-handlers.ts
git commit -m "feat: scan remote nginx managed projects"
```

### Task 3: Switch Renderer Data Flow to Remote Scan Results

**Files:**
- Modify: `src/renderer/src/store/project-store.ts`
- Modify: `src/renderer/src/lib/desktop-api.ts`
- Modify: `src/renderer/src/components/app-settings-page.tsx`

- [ ] **Step 1: Write the failing store test**

```ts
import { describe, expect, it, vi } from "vitest"
import { getDesktopApi } from "@/lib/desktop-api"
import { useProjectStore } from "../project-store"

vi.mock("@/lib/desktop-api", () => ({
  getDesktopApi: vi.fn(),
}))

describe("project store remote scan", () => {
  it("loads remote projects for the selected connection", async () => {
    vi.mocked(getDesktopApi).mockReturnValue({
      projects: {
        scanRemoteProjects: vi.fn().mockResolvedValue({
          connectionId: "conn-1",
          scannedAt: "2026-06-17T00:00:00.000Z",
          projects: [
            {
              id: "p1",
              connectionId: "conn-1",
              domain: "app.example.com",
              nginxConfigPath: "/etc/nginx/conf.d/app.conf",
              proxyTarget: "http://127.0.0.1:3000",
              projectPath: "/var/www/app",
              pathSource: "heuristic",
              status: "ok",
              statusText: "已识别项目目录",
            },
          ],
        }),
      },
    } as never)

    await useProjectStore.getState().scanRemoteProjects("conn-1")

    expect(useProjectStore.getState().projects).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/store/project-store.ts`
Expected: FAIL because `scanRemoteProjects()` is not part of the store yet.

- [ ] **Step 3: Replace local-project loading actions with remote scan actions**

```ts
type ProjectStoreState = {
  projects: RemoteManagedProject[]
  scannedAt?: string
  isLoading: boolean
  error?: string
  info?: string
  scanRemoteProjects: (connectionId: string) => Promise<void>
  clearFeedback: () => void
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  projects: [],
  scannedAt: undefined,
  isLoading: false,
  error: undefined,
  info: undefined,
  scanRemoteProjects: async (connectionId) => {
    set({ isLoading: true, error: undefined, info: undefined })
    try {
      const result = await getDesktopApi().projects.scanRemoteProjects({ connectionId })
      set({
        projects: result.projects,
        scannedAt: result.scannedAt,
        isLoading: false,
        info: `已扫描 ${result.projects.length} 个远程项目`,
      })
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "远程项目扫描失败",
      })
    }
  },
  clearFeedback: () => set({ error: undefined, info: undefined }),
}))
```

```ts
const projects = await getDesktopApi().projects.scanRemoteProjects({
  connectionId: selectedConnectionId,
})
```

- [ ] **Step 4: Run typecheck and the focused store test**

Run: `npm run typecheck && npm test -- src/main/services/__tests__/remote-managed-projects.test.ts`
Expected: PASS and no remaining references to removed store actions in active renderer code.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/project-store.ts src/renderer/src/lib/desktop-api.ts src/renderer/src/components/app-settings-page.tsx
git commit -m "refactor: drive project store from remote scans"
```

### Task 4: Remove CMS Navigation and Rebuild the Project Page

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/project-management-panel.tsx`
- Test: `src/main/services/__tests__/remote-managed-projects.test.ts`

- [ ] **Step 1: Add a focused rendering expectation for the new page copy**

```ts
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProjectManagementPanel } from "../project-management-panel"

describe("ProjectManagementPanel", () => {
  it("shows remote scan empty state copy", () => {
    render(
      <ProjectManagementPanel
        connections={[]}
        selectedConnectionId={undefined}
      />,
    )

    expect(screen.getByText("请先选择一台 VPS")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/components/project-management-panel.tsx`
Expected: FAIL because the new empty state copy and simplified props are not implemented yet.

- [ ] **Step 3: Remove CMS and local project entry points from the UI**

```tsx
type NavKey = "monitor" | "deps" | "projects" | "files" | "settings"

const navItems = [
  { key: "monitor", label: "主机概览", icon: Server },
  { key: "deps", label: "运行环境", icon: HardDriveDownload },
  { key: "projects", label: "项目管理", icon: FolderKanban },
  { key: "files", label: "文件管理", icon: FolderOpen },
] as const
```

```tsx
if (!selectedConnectionId) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/20 px-8 py-16 text-center">
      <div className="space-y-2">
        <p className="text-2xl font-semibold text-foreground">请先选择一台 VPS</p>
        <p className="text-sm text-muted-foreground">项目管理页会自动扫描这台服务器上由 Nginx 反向代理的网站项目。</p>
      </div>
    </div>
  )
}
```

```tsx
<Button type="button" variant="outline" onClick={() => void scanRemoteProjects(selectedConnectionId)}>
  <RefreshCw className="size-4" />
  刷新扫描
</Button>
```

- [ ] **Step 4: Run the focused UI test and a full typecheck**

Run: `npm run typecheck`
Expected: PASS with no remaining imports of `CmsOverviewPage`, `FileText`, `importFromPicker`, `createProjectScaffold`, or local-project-only renderer actions in live code paths.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/project-management-panel.tsx
git commit -m "feat: replace local project page with remote project management"
```

## Self-Review Checklist

- [ ] Spec coverage check: verify the plan covers CMS removal, project page rename, remote scan data source, Nginx proxy detection, path inference priority, and removal of local import/scaffold actions.
- [ ] Placeholder scan: search this plan for `TODO`, `TBD`, `appropriate`, `later`, and remove any vague wording before execution.
- [ ] Type consistency check: make sure `RemoteManagedProject`, `RemoteManagedProjectScanInput`, `RemoteManagedProjectScanResult`, and `scanRemoteProjects()` use the same names across shared types, IPC, store, and renderer.
