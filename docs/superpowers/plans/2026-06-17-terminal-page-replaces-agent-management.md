# 终端页面替换代理管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除代理管理与 OpenClaw 入口，用一个基于当前选中 VPS 的独立远程终端页面替换原导航位。

**Architecture:** 在主进程新增独立的 `remote-terminal` 会话服务，使用 `ssh2` 交互式 shell 维护单个远程终端会话；在渲染端新增 `TerminalPage` 和 `terminal` API 命名空间，原 `projects` 导航位只保留位置，不再承载代理管理逻辑。实现时优先删除入口和依赖，再接入终端能力，最后补足状态与回归测试。

**Tech Stack:** Electron, TypeScript, React, Zustand, ssh2, Vitest

---

## File Map

**Create:**

- `src/main/services/remote-terminal.ts` - 主进程远程终端会话管理，负责创建 SSH shell、写入输入、关闭会话、派发输出事件
- `src/main/services/__tests__/remote-terminal.test.ts` - `remote-terminal` 的最小单元测试
- `src/renderer/src/components/terminal-page.tsx` - 新的独立终端页
- `src/renderer/src/components/__tests__/terminal-page-state.test.ts` - 终端页状态纯函数测试
- `src/renderer/src/components/terminal-page-state.ts` - 终端页连接状态与文案映射纯函数
- `docs/superpowers/plans/2026-06-17-terminal-page-replaces-agent-management.md` - 当前计划文件

**Modify:**

- `src/shared/vps.ts` - 扩展 `DigwisApi`，增加 `terminal` 命名空间的类型定义
- `src/preload/index.ts` - 暴露 `terminal` IPC 调用与事件订阅
- `src/renderer/src/lib/desktop-api.ts` - 包装 `terminal` API 并清理 OpenClaw 暴露
- `src/main/ipc/register-project-handlers.ts` - 删除 `openclaw:*` IPC，新增 `terminal:*` IPC
- `src/renderer/src/App.tsx` - 导航文案改为 `终端`，原 `projects` 位置改渲染 `TerminalPage`
- `src/renderer/src/store/project-store.ts` - 移除 OpenClaw 相关状态，只保留远程项目扫描或进一步瘦身

**Delete:**

- `src/renderer/src/components/agent-management-panel.tsx`
- `src/renderer/src/components/openclaw-install-dialog.tsx`
- `src/renderer/src/components/openclaw-install-dialog-state.ts`
- `src/renderer/src/components/openclaw-instance-card.tsx`
- `src/renderer/src/components/openclaw-log-drawer.tsx`
- `src/renderer/src/components/__tests__/openclaw-install-dialog-state.test.ts`

**Potential Later Cleanup (not in this plan unless referenced by compiler):**

- `src/main/services/openclaw-installer.ts`
- `src/main/services/__tests__/openclaw-installer.test.ts`
- `debug-openclaw-install-status.md`
- `.dbg/*`

---

### Task 1: Add Terminal API Types

**Files:**
- Modify: `src/shared/vps.ts`
- Test: none

- [ ] **Step 1: Add terminal types to shared API contract**

Add the following types near the existing API-related types in `src/shared/vps.ts`:

```ts
export type TerminalCreateInput = {
  connectionId: string
}

export type TerminalCreateResult = {
  sessionId: string
}

export type TerminalWriteInput = {
  sessionId: string
  data: string
}

export type TerminalResizeInput = {
  sessionId: string
  cols: number
  rows: number
}

export type TerminalCloseInput = {
  sessionId: string
}

export type TerminalDataEvent = {
  sessionId: string
  data: string
}

export type TerminalExitEvent = {
  sessionId: string
  code?: number
  signal?: string
}

export type TerminalErrorEvent = {
  sessionId: string
  message: string
}
```

- [ ] **Step 2: Extend `DigwisApi` with `terminal` namespace**

In the same file, extend the `DigwisApi` type with:

```ts
terminal: {
  createSession: (payload: TerminalCreateInput) => Promise<TerminalCreateResult>
  writeInput: (payload: TerminalWriteInput) => Promise<void>
  resize: (payload: TerminalResizeInput) => Promise<void>
  closeSession: (payload: TerminalCloseInput) => Promise<void>
  onData: (handler: (event: TerminalDataEvent) => void) => () => void
  onExit: (handler: (event: TerminalExitEvent) => void) => () => void
  onError: (handler: (event: TerminalErrorEvent) => void) => () => void
}
```

- [ ] **Step 3: Sanity check type names for consistency**

Verify that these names are used consistently and exactly as follows:

```ts
TerminalCreateInput
TerminalCreateResult
TerminalWriteInput
TerminalResizeInput
TerminalCloseInput
TerminalDataEvent
TerminalExitEvent
TerminalErrorEvent
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/vps.ts
git commit -m "feat: add terminal api types"
```

### Task 2: Expose Terminal APIs Through Preload and Desktop Wrapper

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/lib/desktop-api.ts`
- Test: none

- [ ] **Step 1: Wire terminal IPC methods in preload**

In `src/preload/index.ts`, import the new terminal types from `../shared/vps` and add:

```ts
terminal: {
  createSession: (payload) => ipcRenderer.invoke("terminal:create", payload),
  writeInput: (payload) => ipcRenderer.invoke("terminal:write", payload),
  resize: (payload) => ipcRenderer.invoke("terminal:resize", payload),
  closeSession: (payload) => ipcRenderer.invoke("terminal:close", payload),
  onData: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => {
      handler(payload)
    }
    ipcRenderer.on("terminal:data", listener)
    return () => {
      ipcRenderer.removeListener("terminal:data", listener)
    }
  },
  onExit: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => {
      handler(payload)
    }
    ipcRenderer.on("terminal:exit", listener)
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener)
    }
  },
  onError: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalErrorEvent) => {
      handler(payload)
    }
    ipcRenderer.on("terminal:error", listener)
    return () => {
      ipcRenderer.removeListener("terminal:error", listener)
    }
  },
},
```

- [ ] **Step 2: Add terminal wrapper methods in desktop API**

In `src/renderer/src/lib/desktop-api.ts`, add a `terminal` block in `createWrappedApi(api)`:

```ts
terminal: {
  createSession: (payload) => wrapInvoke(() => api.terminal.createSession(payload)),
  writeInput: (payload) => wrapInvoke(() => api.terminal.writeInput(payload)),
  resize: (payload) => wrapInvoke(() => api.terminal.resize(payload)),
  closeSession: (payload) => wrapInvoke(() => api.terminal.closeSession(payload)),
  onData: (handler) => api.terminal.onData(handler),
  onExit: (handler) => api.terminal.onExit(handler),
  onError: (handler) => api.terminal.onError(handler),
},
```

- [ ] **Step 3: Remove OpenClaw wrapper exposure from preload**

Delete these entries from `src/preload/index.ts`:

```ts
listOpenClawInstances
precheckOpenClawInstall
installOpenClaw
uninstallOpenClaw
restartOpenClaw
fetchOpenClawLogs
```

- [ ] **Step 4: Remove OpenClaw wrapper exposure from desktop API**

Delete these entries from `src/renderer/src/lib/desktop-api.ts`:

```ts
listOpenClawInstances
precheckOpenClawInstall
installOpenClaw
uninstallOpenClaw
restartOpenClaw
fetchOpenClawLogs
```

- [ ] **Step 5: Run typecheck for preload-facing code**

Run:

```bash
npm run typecheck
```

Expected: no new type errors caused by `terminal` namespace wiring

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/renderer/src/lib/desktop-api.ts src/shared/vps.ts
git commit -m "feat: expose terminal api through preload"
```

### Task 3: Write Failing Tests for Remote Terminal Service

**Files:**
- Create: `src/main/services/__tests__/remote-terminal.test.ts`
- Test: `src/main/services/__tests__/remote-terminal.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/main/services/__tests__/remote-terminal.test.ts` with:

```ts
import { afterEach, describe, expect, test, vi } from "vitest"
import { closeTerminalSession, createTerminalSession, writeTerminalInput } from "../remote-terminal"

const mockShellWrite = vi.fn()
const mockShellSetWindow = vi.fn()
const mockClientEnd = vi.fn()

vi.mock("../ssh-runtime", () => {
  return {
    connectSshClient: vi.fn(async () => ({
      shell: (options: unknown, callback: (error: Error | undefined, stream: any) => void) => {
        callback(undefined, {
          write: mockShellWrite,
          setWindow: mockShellSetWindow,
          on: vi.fn().mockReturnThis(),
          stderr: { on: vi.fn() },
        })
      },
      end: mockClientEnd,
    })),
  }
})

describe("remote-terminal", () => {
  afterEach(() => {
    mockShellWrite.mockReset()
    mockShellSetWindow.mockReset()
    mockClientEnd.mockReset()
  })

  test("creates a terminal session", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    expect(result.sessionId).toBeTruthy()
  })

  test("writes input to existing session", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    await writeTerminalInput({ sessionId: result.sessionId, data: "ls\n" })

    expect(mockShellWrite).toHaveBeenCalledWith("ls\n")
  })

  test("throws when writing to missing session", async () => {
    await expect(writeTerminalInput({ sessionId: "missing", data: "pwd\n" })).rejects.toThrow(
      "终端会话不存在",
    )
  })

  test("closes session and ends client", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    await closeTerminalSession({ sessionId: result.sessionId })

    expect(mockClientEnd).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/main/services/__tests__/remote-terminal.test.ts
```

Expected: FAIL because `../remote-terminal` does not exist yet

- [ ] **Step 3: Commit the failing test**

```bash
git add src/main/services/__tests__/remote-terminal.test.ts
git commit -m "test: add failing remote terminal service tests"
```

### Task 4: Implement Remote Terminal Service

**Files:**
- Create: `src/main/services/remote-terminal.ts`
- Test: `src/main/services/__tests__/remote-terminal.test.ts`

- [ ] **Step 1: Create minimal session registry implementation**

Create `src/main/services/remote-terminal.ts` with:

```ts
import { randomUUID } from "node:crypto"
import type { BrowserWindow } from "electron"
import type { Client, ClientChannel } from "ssh2"
import type { TerminalCloseInput, TerminalCreateResult, TerminalResizeInput, TerminalWriteInput, VpsConnectionInput } from "../../shared/vps"
import { connectSshClient } from "./ssh-runtime"

type SessionRecord = {
  client: Client
  stream: ClientChannel
}

const sessions = new Map<string, SessionRecord>()

export async function createTerminalSession(
  payload: VpsConnectionInput,
  webContents?: Electron.WebContents,
): Promise<TerminalCreateResult> {
  const client = await connectSshClient(payload, { readyTimeout: 10_000 })
  const sessionId = randomUUID()

  await new Promise<void>((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (error, stream) => {
      if (error) {
        client.end()
        reject(error)
        return
      }

      sessions.set(sessionId, { client, stream })

      stream.on("data", (chunk: Buffer | string) => {
        webContents?.send("terminal:data", { sessionId, data: chunk.toString() })
      })
      stream.stderr.on("data", (chunk: Buffer | string) => {
        webContents?.send("terminal:data", { sessionId, data: chunk.toString() })
      })
      stream.on("close", (code?: number, signal?: string) => {
        sessions.delete(sessionId)
        webContents?.send("terminal:exit", { sessionId, code, signal })
        client.end()
      })

      resolve()
    })
  })

  return { sessionId }
}

export async function writeTerminalInput(payload: TerminalWriteInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) {
    throw new Error("终端会话不存在")
  }
  session.stream.write(payload.data)
}

export async function resizeTerminalSession(payload: TerminalResizeInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) {
    throw new Error("终端会话不存在")
  }
  session.stream.setWindow(payload.rows, payload.cols, 0, 0)
}

export async function closeTerminalSession(payload: TerminalCloseInput): Promise<void> {
  const session = sessions.get(payload.sessionId)
  if (!session) return
  sessions.delete(payload.sessionId)
  session.stream.close()
  session.client.end()
}
```

- [ ] **Step 2: Run the remote terminal test file**

Run:

```bash
npm test -- src/main/services/__tests__/remote-terminal.test.ts
```

Expected: PASS

- [ ] **Step 3: Add a cleanup helper for window/session teardown**

Extend the service with:

```ts
export async function closeAllTerminalSessions(): Promise<void> {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map((sessionId) => closeTerminalSession({ sessionId })))
}
```

- [ ] **Step 4: Commit**

```bash
git add src/main/services/remote-terminal.ts src/main/services/__tests__/remote-terminal.test.ts
git commit -m "feat: add remote terminal service"
```

### Task 5: Register Terminal IPC and Remove OpenClaw IPC

**Files:**
- Modify: `src/main/ipc/register-project-handlers.ts`
- Test: `src/main/services/__tests__/remote-terminal.test.ts`

- [ ] **Step 1: Import terminal service functions**

At the top of `src/main/ipc/register-project-handlers.ts`, add imports:

```ts
import {
  closeTerminalSession,
  createTerminalSession,
  resizeTerminalSession,
  writeTerminalInput,
} from "../services/remote-terminal"
```

- [ ] **Step 2: Register terminal IPC handlers**

Add the following handlers near the other connection-bound handlers:

```ts
registerIpcHandle("terminal:create", async (event, payload: unknown) => {
  const parsed = parseOrThrow(connectionIdSchemaSafe, (payload as { connectionId?: unknown })?.connectionId)
  const connection = requireConnection(parsed)
  return createTerminalSession(resolveStoredPayload(connection), event.sender)
})

registerIpcHandle("terminal:write", async (_event, payload: unknown) => {
  const parsed = payload as { sessionId: string; data: string }
  return writeTerminalInput(parsed)
})

registerIpcHandle("terminal:resize", async (_event, payload: unknown) => {
  const parsed = payload as { sessionId: string; cols: number; rows: number }
  return resizeTerminalSession(parsed)
})

registerIpcHandle("terminal:close", async (_event, payload: unknown) => {
  const parsed = payload as { sessionId: string }
  return closeTerminalSession(parsed)
})
```

- [ ] **Step 3: Remove OpenClaw IPC registrations**

Delete these handlers entirely:

```ts
registerIpcHandle("openclaw:list", ...)
registerIpcHandle("openclaw:precheck", ...)
registerIpcHandle("openclaw:install", ...)
registerIpcHandle("openclaw:uninstall", ...)
registerIpcHandle("openclaw:restart", ...)
registerIpcHandle("openclaw:logs", ...)
```

- [ ] **Step 4: Run targeted test and typecheck**

Run:

```bash
npm test -- src/main/services/__tests__/remote-terminal.test.ts
npm run typecheck
```

Expected: remote terminal tests pass; typecheck shows no new IPC typing regressions

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/register-project-handlers.ts
git commit -m "feat: register terminal ipc handlers"
```

### Task 6: Replace Agent Navigation With Terminal Page

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/components/terminal-page-state.ts`
- Create: `src/renderer/src/components/__tests__/terminal-page-state.test.ts`
- Create: `src/renderer/src/components/terminal-page.tsx`

- [ ] **Step 1: Write failing terminal page state tests**

Create `src/renderer/src/components/__tests__/terminal-page-state.test.ts` with:

```ts
import { describe, expect, test } from "vitest"
import { deriveTerminalPageView } from "../terminal-page-state"

describe("deriveTerminalPageView", () => {
  test("shows empty state when no server is selected", () => {
    expect(deriveTerminalPageView({ hasConnection: false, phase: "idle" })).toMatchObject({
      title: "先选择一台 VPS",
      canReconnect: false,
    })
  })

  test("shows reconnect action on error", () => {
    expect(
      deriveTerminalPageView({ hasConnection: true, phase: "error", message: "认证失败" }),
    ).toMatchObject({
      title: "终端连接失败",
      detail: "认证失败",
      canReconnect: true,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/renderer/src/components/__tests__/terminal-page-state.test.ts
```

Expected: FAIL because `terminal-page-state.ts` does not exist yet

- [ ] **Step 3: Implement minimal terminal page state helper**

Create `src/renderer/src/components/terminal-page-state.ts` with:

```ts
export type TerminalPagePhase = "idle" | "connecting" | "connected" | "error" | "closed"

export function deriveTerminalPageView(args: {
  hasConnection: boolean
  phase: TerminalPagePhase
  message?: string
}) {
  if (!args.hasConnection) {
    return {
      title: "先选择一台 VPS",
      detail: "在右上角选择服务器后即可打开远程终端。",
      canReconnect: false,
    }
  }

  if (args.phase === "connecting") {
    return {
      title: "正在连接远程终端…",
      detail: "请稍候，正在建立 SSH 会话。",
      canReconnect: false,
    }
  }

  if (args.phase === "error") {
    return {
      title: "终端连接失败",
      detail: args.message ?? "连接失败，请重试。",
      canReconnect: true,
    }
  }

  if (args.phase === "closed") {
    return {
      title: "终端会话已断开",
      detail: args.message ?? "可以点击重连重新建立会话。",
      canReconnect: true,
    }
  }

  if (args.phase === "connected") {
    return {
      title: "终端已连接",
      detail: "当前会话已连接到所选 VPS。",
      canReconnect: false,
    }
  }

  return {
    title: "准备连接终端",
    detail: "进入页面后会自动连接当前选中的 VPS。",
    canReconnect: false,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/renderer/src/components/__tests__/terminal-page-state.test.ts
```

Expected: PASS

- [ ] **Step 5: Implement `TerminalPage`**

Create `src/renderer/src/components/terminal-page.tsx` with:

```tsx
import { useEffect, useMemo, useRef, useState } from "react"
import { LoaderCircle, RotateCw, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDesktopApi } from "@/lib/desktop-api"
import { deriveTerminalPageView, type TerminalPagePhase } from "./terminal-page-state"
import type { VpsConnectionRecord } from "../../../shared/vps"

export function TerminalPage({
  connections,
  selectedConnectionId,
}: {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
}) {
  const selectedConnection = useMemo(
    () => connections.find((item) => item.id === selectedConnectionId),
    [connections, selectedConnectionId],
  )
  const [phase, setPhase] = useState<TerminalPagePhase>("idle")
  const [message, setMessage] = useState<string>()
  const [sessionId, setSessionId] = useState<string>()
  const [output, setOutput] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!selectedConnectionId) {
      setPhase("idle")
      setSessionId(undefined)
      setOutput("")
      return
    }

    let disposed = false
    setPhase("connecting")
    setMessage(undefined)
    setOutput("")

    const offData = getDesktopApi().terminal.onData((event) => {
      if (event.sessionId === sessionId || !sessionId) {
        setOutput((current) => current + event.data)
      }
    })
    const offExit = getDesktopApi().terminal.onExit((event) => {
      if (event.sessionId === sessionId) {
        setPhase("closed")
        setMessage(event.code != null ? `远端会话已退出（code ${event.code}）` : "远端会话已关闭")
      }
    })
    const offError = getDesktopApi().terminal.onError((event) => {
      if (event.sessionId === sessionId) {
        setPhase("error")
        setMessage(event.message)
      }
    })

    void getDesktopApi().terminal
      .createSession({ connectionId: selectedConnectionId })
      .then((result) => {
        if (disposed) return
        setSessionId(result.sessionId)
        setPhase("connected")
      })
      .catch((error) => {
        if (disposed) return
        setPhase("error")
        setMessage(error instanceof Error ? error.message : "终端连接失败")
      })

    return () => {
      disposed = true
      offData()
      offExit()
      offError()
      if (sessionId) {
        void getDesktopApi().terminal.closeSession({ sessionId })
      }
    }
  }, [selectedConnectionId])

  const view = deriveTerminalPageView({
    hasConnection: Boolean(selectedConnection),
    phase,
    message,
  })

  const sendLine = async () => {
    const value = inputRef.current?.value ?? ""
    if (!value.trim() || !sessionId || phase !== "connected") return
    await getDesktopApi().terminal.writeInput({ sessionId, data: `${value}\n` })
    if (inputRef.current) inputRef.current.value = ""
  }

  return (
    <div className="flex h-full min-h-[min(520px,70svh)] flex-col gap-4 rounded-3xl border border-border/70 bg-card/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {selectedConnection ? `${selectedConnection.name} 的终端` : view.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {selectedConnection ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}` : view.detail}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!selectedConnectionId || phase === "connecting"}
          onClick={() => window.location.reload()}
        >
          {phase === "connecting" ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          重连
        </Button>
      </div>

      {phase !== "connected" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 text-center">
          <TerminalSquare className="size-8 text-muted-foreground" />
          <p className="text-base font-medium text-foreground">{view.title}</p>
          <p className="max-w-md text-sm text-muted-foreground">{view.detail}</p>
        </div>
      ) : (
        <>
          <pre className="flex-1 overflow-auto rounded-2xl bg-black p-4 text-xs leading-relaxed text-green-400">
            {output || "# 已连接，等待远端输出...\n"}
          </pre>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="flex-1 rounded-2xl border border-border bg-background px-4 py-2 text-sm outline-none"
              placeholder="输入命令后回车，例如：pwd"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void sendLine()
                }
              }}
            />
            <Button onClick={() => void sendLine()} disabled={!sessionId}>
              发送
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Replace nav label and panel in `App.tsx`**

Make these changes in `src/renderer/src/App.tsx`:

```ts
import { SquareTerminal } from "lucide-react"
import { TerminalPage } from "@/components/terminal-page"
```

Replace:

```ts
{ key: "projects", label: "代理管理", icon: Bot },
```

With:

```ts
{ key: "projects", label: "终端", icon: SquareTerminal },
```

Replace:

```tsx
<AgentManagementPanel
  connections={connections}
  selectedConnectionId={selectedConnectionId}
/>
```

With:

```tsx
<TerminalPage
  connections={connections}
  selectedConnectionId={selectedConnectionId}
/>
```

Remove the `AgentManagementPanel` import.

- [ ] **Step 7: Run renderer tests**

Run:

```bash
npm test -- src/renderer/src/components/__tests__/terminal-page-state.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/terminal-page.tsx src/renderer/src/components/terminal-page-state.ts src/renderer/src/components/__tests__/terminal-page-state.test.ts
git commit -m "feat: replace agent page with terminal page"
```

### Task 7: Remove Agent Management UI and OpenClaw Store State

**Files:**
- Modify: `src/renderer/src/store/project-store.ts`
- Delete: `src/renderer/src/components/agent-management-panel.tsx`
- Delete: `src/renderer/src/components/openclaw-install-dialog.tsx`
- Delete: `src/renderer/src/components/openclaw-install-dialog-state.ts`
- Delete: `src/renderer/src/components/openclaw-instance-card.tsx`
- Delete: `src/renderer/src/components/openclaw-log-drawer.tsx`
- Delete: `src/renderer/src/components/__tests__/openclaw-install-dialog-state.test.ts`

- [ ] **Step 1: Shrink `project-store` back to remote project scan only**

Replace `src/renderer/src/store/project-store.ts` with:

```ts
import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type { RemoteManagedProjectScanResult } from "../../../shared/projects"

type ProjectStoreState = {
  scanResult?: RemoteManagedProjectScanResult
  isScanning: boolean
  scanError?: string
  scanForConnection: (connectionId: string) => Promise<void>
  clearScan: () => void
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  scanResult: undefined,
  isScanning: false,
  scanError: undefined,
  scanForConnection: async (connectionId) => {
    set({ isScanning: true, scanError: undefined })
    try {
      const result = await getDesktopApi().projects.scanRemoteProjects({ connectionId })
      set({ scanResult: result, isScanning: false })
    } catch (error) {
      set({ isScanning: false, scanError: error instanceof Error ? error.message : "远程项目扫描失败" })
    }
  },
  clearScan: () => set({ scanResult: undefined, scanError: undefined }),
}))
```

- [ ] **Step 2: Delete agent/OpenClaw renderer files**

Delete exactly these files:

```bash
rm src/renderer/src/components/agent-management-panel.tsx
rm src/renderer/src/components/openclaw-install-dialog.tsx
rm src/renderer/src/components/openclaw-install-dialog-state.ts
rm src/renderer/src/components/openclaw-instance-card.tsx
rm src/renderer/src/components/openclaw-log-drawer.tsx
rm src/renderer/src/components/__tests__/openclaw-install-dialog-state.test.ts
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: no remaining imports or symbol references to deleted renderer-side OpenClaw UI files

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/project-store.ts src/renderer/src/App.tsx src/renderer/src/components
git commit -m "refactor: remove agent management ui"
```

### Task 8: Final Validation and App Smoke Test

**Files:**
- Modify: none expected
- Test: `src/main/services/__tests__/remote-terminal.test.ts`
- Test: `src/renderer/src/components/__tests__/terminal-page-state.test.ts`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- src/main/services/__tests__/remote-terminal.test.ts
npm test -- src/renderer/src/components/__tests__/terminal-page-state.test.ts
```

Expected: both PASS

- [ ] **Step 2: Run project typecheck**

Run:

```bash
npm run typecheck
```

Expected: no new type errors from terminal feature

- [ ] **Step 3: Start app and smoke-test navigation**

Run:

```bash
npm run dev
```

Expected UI smoke checks:

- 左侧导航显示 `终端`，不显示 `代理管理`
- 选中 VPS 后进入终端页，出现“正在连接远程终端…”或已连接状态
- 未选中 VPS 时出现“先选择一台 VPS”
- 不再出现 OpenClaw 安装、日志、实例卡片入口

- [ ] **Step 4: Commit final integration**

```bash
git add src/main/services/remote-terminal.ts src/main/services/__tests__/remote-terminal.test.ts src/main/ipc/register-project-handlers.ts src/preload/index.ts src/renderer/src/lib/desktop-api.ts src/renderer/src/App.tsx src/renderer/src/store/project-store.ts src/renderer/src/components/terminal-page.tsx src/renderer/src/components/terminal-page-state.ts src/renderer/src/components/__tests__/terminal-page-state.test.ts
git commit -m "feat: add remote terminal page"
```

---

## Self-Review

- Spec coverage: covered navigation replacement, terminal page, terminal IPC/service, deletion of agent management entrypoints, and testing. Deferred items from spec remain explicitly out of scope.
- Placeholder scan: removed all TBD/TODO language; each task has concrete files, code, commands, and expected outcomes.
- Type consistency: `terminal` namespace and `Terminal*` type names are used consistently across shared types, preload, desktop wrapper, IPC, service, and renderer plan tasks.
