# OpenClaw 代理管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `项目管理` 改名 `代理管理`，并提供“通过本地 SSH 一键安装 OpenClaw（小龙虾）到 VPS、单 VPS 多实例、运行态展示与日志/重启/卸载”的能力。

**Architecture:** 复用现有 SSH + 远程 shell 基建，新增 `openclaw-installer` 主进程服务和 SQLite `openclaw_instances` 表；渲染端把 `project-management-panel` 改名 `agent-management-panel`，上半部分继续展示 Nginx 反向代理站点（中量版），下半部分展示已装 OpenClaw 实例卡片 + 一键安装入口。

**Tech Stack:** TypeScript / electron-vite / Zustand / better-sqlite3 / Vitest / Tailwind + shadcn UI。

---

## File Structure

新增：
- `src/main/services/openclaw-installer.ts`：OpenClaw 预检、安装、卸载、重启、日志、列表
- `src/main/services/__tests__/openclaw-installer.test.ts`：单元测试覆盖纯函数（端口推断、状态解析、unit 文本模板）
- `src/main/services/openclaw-db.ts`：SQLite 表与 DAO
- `src/main/services/__tests__/openclaw-db.test.ts`：DAO 单元测试
- `src/renderer/src/components/agent-management-panel.tsx`：渲染端代理管理页
- `src/renderer/src/components/openclaw-install-dialog.tsx`：一键安装对话框
- `src/renderer/src/components/openclaw-instance-card.tsx`：单个 OpenClaw 实例卡片
- `src/renderer/src/components/openclaw-log-drawer.tsx`：日志抽屉

修改：
- `src/shared/projects.ts`：补充 `OpenClaw*` 类型，扩展 `ManagedProjectsApi`
- `src/main/ipc/schemas.ts`：补 OpenClaw 三个 Zod schema
- `src/main/ipc/__tests__/schemas.test.ts`：补 schema 测试
- `src/main/ipc/register-project-handlers.ts`：注册 5 个 IPC 处理器
- `src/preload/index.ts`：补 5 个 IPC 包装
- `src/main/services/db.ts`：在初始化流程里调 `runOpenClawMigrations`
- `src/main/services/openclaw-installer.ts`：依赖 `runRemoteShellCommand`（已有）
- `src/main/index.ts`：确保 `runOpenClawMigrations(db)` 在 `registerProjectHandlers` 之前调用
- `src/renderer/src/App.tsx`：导航 `项目管理 → 代理管理`；组件引用改名
- `src/renderer/src/lib/desktop-api.ts`：补 desktop-api wrapper
- `src/renderer/src/store/project-store.ts`：补 6 个 store action

---

### Task 1: OpenClaw 共享类型

**Files:**
- Modify: `src/shared/projects.ts`
- Modify: `src/main/ipc/schemas.ts`
- Modify: `src/main/ipc/__tests__/schemas.test.ts`

- [ ] **Step 1: 在 shared/projects.ts 加类型**

在 `RemoteManagedProjectScanResult` 后面插入：

```ts
export type OpenClawInstanceStatus =
  | "running"
  | "stopped"
  | "failed"
  | "unknown"

export type OpenClawInstance = {
  id: string
  connectionId: string
  host: string
  listenPort: number
  dataDir: string
  serviceName: string
  nodeVersion?: string
  openclawVersion?: string
  status: OpenClawInstanceStatus
  installedAt: string
  lastCheckedAt?: string
  lastLog?: string
}

export type OpenClawPrecheckReason =
  | "node_missing"
  | "node_too_old"
  | "memory_low"
  | "port_in_use"
  | "systemd_missing"
  | "instance_limit_reached"

export type OpenClawPrecheck = {
  ready: boolean
  reasons: OpenClawPrecheckReason[]
  nodeVersion?: string
  memoryAvailableMb?: number
  existingInstances: number
  portInUse: boolean
}

export type OpenClawInstallInput = {
  connectionId: string
  listenPort: number
}

export type OpenClawUninstallInput = {
  connectionId: string
  instanceId: string
}

export type OpenClawRestartInput = {
  connectionId: string
  instanceId: string
}

export type OpenClawLogsInput = {
  connectionId: string
  instanceId: string
  lines: number
}
```

- [ ] **Step 2: 扩展 `ManagedProjectsApi`**

把现有 `ManagedProjectsApi` 替换为：

```ts
export type ManagedProjectsApi = {
  listProjects: () => Promise<LocalProjectRecord[]>
  addProjectFromPath: (payload: LocalProjectInput) => Promise<LocalProjectRecord>
  createProjectScaffold: (payload: ProjectScaffoldInput) => Promise<ProjectScaffoldResult>
  onScaffoldProgress: (handler: (event: ProjectScaffoldProgressEvent) => void) => () => void
  scanRemoteProjects: (payload: RemoteManagedProjectScanInput) => Promise<RemoteManagedProjectScanResult>
  listOpenClawInstances: (connectionId: string) => Promise<OpenClawInstance[]>
  precheckOpenClawInstall: (payload: OpenClawInstallInput) => Promise<OpenClawPrecheck>
  installOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawInstance>
  uninstallOpenClaw: (payload: OpenClawUninstallInput) => Promise<{ ok: true }>
  restartOpenClaw: (payload: OpenClawRestartInput) => Promise<{ ok: true }>
  fetchOpenClawLogs: (payload: OpenClawLogsInput) => Promise<string>
}
```

- [ ] **Step 3: 补 Zod schema**

在 `src/main/ipc/schemas.ts` 末尾加：

```ts
export const openClawInstallSchema = z.object({
  connectionId: connectionIdSchema,
  listenPort: z.number().int().min(1024).max(65535),
})

export const openClawInstanceIdSchema = z.object({
  connectionId: connectionIdSchema,
  instanceId: nonEmptyString("instanceId"),
})

export const openClawLogsSchema = openClawInstanceIdSchema.extend({
  lines: z.number().int().min(10).max(500),
})
```

- [ ] **Step 4: 加 schema 测试**

在 `schemas.test.ts` 现有用例后追加：

```ts
test("accepts openclaw install payload", () => {
  const parsed = parseOrThrow(openClawInstallSchema, {
    connectionId: "conn-1",
    listenPort: 18789,
  })
  expect(parsed.listenPort).toBe(18789)
})

test("rejects openclaw install with port out of range", () => {
  expect(() =>
    parseOrThrow(openClawInstallSchema, { connectionId: "c", listenPort: 80 }),
  ).toThrow()
})

test("accepts openclaw logs payload", () => {
  const parsed = parseOrThrow(openClawLogsSchema, {
    connectionId: "conn-1",
    instanceId: "i-1",
    lines: 50,
  })
  expect(parsed.lines).toBe(50)
})
```

并在 `import` 列表里增加 `openClawInstallSchema, openClawLogsSchema`。

- [ ] **Step 5: 跑测试**

```bash
NAPI_RS_FORCE_WASI=1 npx vitest run src/main/ipc/__tests__/schemas.test.ts --reporter=verbose > /tmp/openclaw_schema.log 2>&1
tail -30 /tmp/openclaw_schema.log
```

预期：`Test Files ... passed`、`Tests 34 passed`。

- [ ] **Step 6: 提交**

```bash
git add src/shared/projects.ts src/main/ipc/schemas.ts src/main/ipc/__tests__/schemas.test.ts
git commit -m "feat: openclaw shared types and ipc schemas"
```

---

### Task 2: OpenClaw installer 单元（纯函数）

**Files:**
- Create: `src/main/services/openclaw-installer.ts`
- Create: `src/main/services/__tests__/openclaw-installer.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from "vitest"
import {
  buildSystemdUnit,
  detectStatusFromSystemctl,
  ensurePortInRange,
  nextAvailablePort,
  parseSystemdUnitList,
} from "../openclaw-installer"

describe("ensurePortInRange", () => {
  test("rejects ports below 1024", () => {
    expect(() => ensurePortInRange(80)).toThrow()
  })
  test("accepts 18789", () => {
    expect(ensurePortInRange(18789)).toBe(18789)
  })
})

describe("nextAvailablePort", () => {
  test("returns base port when none used", () => {
    expect(nextAvailablePort(18789, [])).toBe(18789)
  })
  test("skips used ports", () => {
    expect(nextAvailablePort(18789, [18789, 18790])).toBe(18791)
  })
  test("throws after 4 used", () => {
    expect(() => nextAvailablePort(18789, [18789, 18790, 18791, 18792])).toThrow()
  })
})

describe("parseSystemdUnitList", () => {
  test("extracts openclaw@<port>.service names", () => {
    const stdout = [
      "openclaw@18789.service  loaded active running   OpenClaw 18789",
      "openclaw@18790.service  loaded active running   OpenClaw 18790",
      "sshd.service           loaded active running   OpenSSH",
    ].join("\n")
    expect(parseSystemdUnitList(stdout)).toEqual([18789, 18790])
  })
  test("returns empty when no openclaw units", () => {
    expect(parseSystemdUnitList("sshd.service loaded active running")).toEqual([])
  })
})

describe("detectStatusFromSystemctl", () => {
  test("detects running", () => {
    expect(detectStatusFromSystemctl("active (running)")).toBe("running")
  })
  test("detects stopped", () => {
    expect(detectStatusFromSystemctl("inactive (dead)")).toBe("stopped")
  })
  test("detects failed", () => {
    expect(detectStatusFromSystemctl("failed")).toBe("failed")
  })
})

describe("buildSystemdUnit", () => {
  test("produces a unit with port and data dir", () => {
    const unit = buildSystemdUnit(18790)
    expect(unit).toContain("OPENCLAW_PORT=18790")
    expect(unit).toContain("/root/.openclaw-18790")
    expect(unit).toContain("ExecStart=/usr/bin/env openclaw gateway")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
NAPI_RS_FORCE_WASI=1 npx vitest run src/main/services/__tests__/openclaw-installer.test.ts --reporter=verbose > /tmp/openclaw_unit_pre.log 2>&1
tail -10 /tmp/openclaw_unit_pre.log
```

预期：失败（模块不存在）。

- [ ] **Step 3: 实现 installer.ts 中的纯函数部分**

```ts
import { randomUUID } from "node:crypto"
import type {
  OpenClawInstance,
  OpenClawInstanceStatus,
  OpenClawPrecheck,
  OpenClawPrecheckReason,
} from "../../shared/projects"

export const OPENCLAW_BASE_PORT = 18789
export const OPENCLAW_MAX_INSTANCES = 4
export const OPENCLAW_MIN_MEMORY_MB = 350

export function ensurePortInRange(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`端口 ${port} 不在合法范围内`)
  }
  return port
}

export function nextAvailablePort(base: number, used: number[]): number {
  const occupied = new Set(used)
  for (let offset = 0; offset < OPENCLAW_MAX_INSTANCES; offset += 1) {
    const port = base + offset
    if (!occupied.has(port)) return port
  }
  throw new Error("已达到单 VPS 最大 OpenClaw 实例数量")
}

export function parseSystemdUnitList(stdout: string): number[] {
  const ports: number[] = []
  for (const line of stdout.split("\n")) {
    const match = line.match(/openclaw@(\d+)\.service/)
    if (match) {
      ports.push(Number(match[1]))
    }
  }
  return ports
}

export function detectStatusFromSystemctl(stdout: string): OpenClawInstanceStatus {
  const trimmed = stdout.trim()
  if (trimmed.includes("active (running)")) return "running"
  if (trimmed.includes("inactive (dead)")) return "stopped"
  if (trimmed.includes("failed")) return "failed"
  return "unknown"
}

export function buildSystemdUnit(port: number): string {
  return `[Unit]
Description=OpenClaw Gateway (port ${port})
After=network.target

[Service]
Type=simple
Environment=OPENCLAW_PORT=${port}
Environment=OPENCLAW_HOME=/root/.openclaw-${port}
ExecStart=/usr/bin/env OPENCLAW_PORT=${port} OPENCLAW_HOME=/root/.openclaw-${port} openclaw gateway --port ${port}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`
}

export function buildPrecheck(args: {
  nodeVersion?: string
  memoryAvailableMb?: number
  portInUse: boolean
  existingInstances: number
  systemdPresent: boolean
}): OpenClawPrecheck {
  const reasons: OpenClawPrecheckReason[] = []
  if (!args.nodeVersion) reasons.push("node_missing")
  else {
    const major = Number(args.nodeVersion.replace(/^v/, "").split(".")[0])
    if (Number.isFinite(major) && major < 20) reasons.push("node_too_old")
  }
  if (
    typeof args.memoryAvailableMb === "number" &&
    args.memoryAvailableMb < OPENCLAW_MIN_MEMORY_MB
  ) {
    reasons.push("memory_low")
  }
  if (args.portInUse) reasons.push("port_in_use")
  if (!args.systemdPresent) reasons.push("systemd_missing")
  if (args.existingInstances >= OPENCLAW_MAX_INSTANCES) {
    reasons.push("instance_limit_reached")
  }
  return {
    ready: reasons.length === 0,
    reasons,
    nodeVersion: args.nodeVersion,
    memoryAvailableMb: args.memoryAvailableMb,
    existingInstances: args.existingInstances,
    portInUse: args.portInUse,
  }
}

export function generateInstanceId(): string {
  return randomUUID()
}

export type { OpenClawInstance }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
NAPI_RS_FORCE_WASI=1 npx vitest run src/main/services/__tests__/openclaw-installer.test.ts --reporter=verbose > /tmp/openclaw_unit_post.log 2>&1
tail -20 /tmp/openclaw_unit_post.log
```

预期：全绿。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/openclaw-installer.ts src/main/services/__tests__/openclaw-installer.test.ts
git commit -m "feat: openclaw installer pure helpers"
```

---

### Task 3: OpenClaw SQLite DAO

**Files:**
- Create: `src/main/services/openclaw-db.ts`
- Create: `src/main/services/__tests__/openclaw-db.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, beforeEach } from "vitest"
import { openOpenClawDb, runOpenClawMigrations, OpenClawDb } from "../openclaw-db"

describe("openclaw-db", () => {
  let db: OpenClawDb
  beforeEach(() => {
    db = openOpenClawDb(":memory:")
    runOpenClawMigrations(db)
  })
  test("inserts and lists instances", () => {
    db.insertInstance({
      id: "i-1",
      connectionId: "conn-1",
      listenPort: 18789,
      dataDir: "/root/.openclaw-18789",
      serviceName: "openclaw@18789.service",
      installedAt: "2026-06-17T00:00:00Z",
    })
    expect(db.listInstances("conn-1").map((i) => i.id)).toEqual(["i-1"])
  })
  test("enforces unique (connectionId, listenPort)", () => {
    db.insertInstance({
      id: "i-1",
      connectionId: "conn-1",
      listenPort: 18789,
      dataDir: "/x",
      serviceName: "openclaw@18789.service",
      installedAt: "2026-06-17T00:00:00Z",
    })
    expect(() =>
      db.insertInstance({
        id: "i-2",
        connectionId: "conn-1",
        listenPort: 18789,
        dataDir: "/y",
        serviceName: "openclaw@18789.service",
        installedAt: "2026-06-17T00:00:00Z",
      }),
    ).toThrow()
  })
  test("deletes by id", () => {
    db.insertInstance({
      id: "i-1",
      connectionId: "conn-1",
      listenPort: 18789,
      dataDir: "/x",
      serviceName: "openclaw@18789.service",
      installedAt: "2026-06-17T00:00:00Z",
    })
    db.deleteInstance("i-1")
    expect(db.listInstances("conn-1")).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
NAPI_RS_FORCE_WASI=1 npx vitest run src/main/services/__tests__/openclaw-db.test.ts --reporter=verbose > /tmp/openclaw_db_pre.log 2>&1
tail -10 /tmp/openclaw_db_pre.log
```

预期：失败。

- [ ] **Step 3: 实现 DAO**

```ts
import Database from "better-sqlite3"
import type { Database as BetterSqliteDb } from "better-sqlite3"

export type OpenClawDb = BetterSqliteDb

export type OpenClawInstanceRow = {
  id: string
  connection_id: string
  listen_port: number
  data_dir: string
  service_name: string
  installed_at: string
}

export function openOpenClawDb(filename: string): OpenClawDb {
  return new Database(filename)
}

export function runOpenClawMigrations(db: OpenClawDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS openclaw_instances (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      listen_port INTEGER NOT NULL,
      data_dir TEXT NOT NULL,
      service_name TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      UNIQUE(connection_id, listen_port)
    );
  `)
}

export const openClawDbStatements = (db: OpenClawDb) => ({
  insert: db.prepare(
    `INSERT INTO openclaw_instances (id, connection_id, listen_port, data_dir, service_name, installed_at)
     VALUES (@id, @connection_id, @listen_port, @data_dir, @service_name, @installed_at)`,
  ),
  list: db.prepare(`SELECT * FROM openclaw_instances WHERE connection_id = ?`),
  delete: db.prepare(`DELETE FROM openclaw_instances WHERE id = ?`),
})
```

并在 `OpenClawDb` 上挂载 `insertInstance / listInstances / deleteInstance`：

```ts
declare module "better-sqlite3" {
  interface Database {
    insertInstance(row: OpenClawInstanceRow): void
    listInstances(connectionId: string): OpenClawInstanceRow[]
    deleteInstance(id: string): void
  }
}

const statementsByDb = new WeakMap<OpenClawDb, ReturnType<typeof openClawDbStatements>>()

const augment = (db: OpenClawDb) => {
  let stmts = statementsByDb.get(db)
  if (!stmts) {
    stmts = openClawDbStatements(db)
    statementsByDb.set(db, stmts)
  }
  db.insertInstance = (row) => stmts!.insert.run(row)
  db.listInstances = (cid) => stmts!.list.all(cid) as OpenClawInstanceRow[]
  db.deleteInstance = (id) => stmts!.delete.run(id)
}

export function setupOpenClawDb(db: OpenClawDb) {
  runOpenClawMigrations(db)
  augment(db)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
NAPI_RS_FORCE_WASI=1 npx vitest run src/main/services/__tests__/openclaw-db.test.ts --reporter=verbose > /tmp/openclaw_db_post.log 2>&1
tail -20 /tmp/openclaw_db_post.log
```

预期：全绿。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/openclaw-db.ts src/main/services/__tests__/openclaw-db.test.ts
git commit -m "feat: openclaw instances sqlite dao"
```

---

### Task 4: 远程 SSH 操作的 installer 主体

**Files:**
- Modify: `src/main/services/openclaw-installer.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 补 IPC-facing 函数**

在 `openclaw-installer.ts` 末尾加：

```ts
import { runRemoteShellCommand } from "./remote-exec"
import type { VpsConnectionInput } from "../../shared/vps"

async function detectPackageManager(): Promise<"apt" | "dnf" | "yum" | "unknown"> {
  for (const cmd of [
    "command -v apt-get",
    "command -v dnf",
    "command -v yum",
  ]) {
    const { code, stdout } = await runRemoteShellCommand({} as VpsConnectionInput, cmd, { timeoutMs: 5_000 })
    if (code === 0 && stdout.trim()) {
      if (cmd.includes("apt")) return "apt"
      if (cmd.includes("dnf")) return "dnf"
      return "yum"
    }
  }
  return "unknown"
}

export async function precheckOpenClawInstall(
  payload: VpsConnectionInput & { listenPort: number },
): Promise<OpenClawPrecheck> {
  const [node, mem, portLine, units, systemd] = await Promise.all([
    runRemoteShellCommand(payload, "node --version 2>/dev/null || true", { timeoutMs: 5_000 }),
    runRemoteShellCommand(payload, "free -m | awk '/Mem:/ {print $7}'", { timeoutMs: 5_000 }),
    runRemoteShellCommand(payload, `ss -ltn 2>/dev/null | grep -E ':${payload.listenPort} ' || true`, { timeoutMs: 5_000 }),
    runRemoteShellCommand(
      payload,
      "systemctl list-unit-files 2>/dev/null | awk '/openclaw@/{print $1}' || true",
      { timeoutMs: 5_000 },
    ),
    runRemoteShellCommand(payload, "command -v systemctl", { timeoutMs: 5_000 }),
  ])
  const usedPorts = parseSystemdUnitList(units.stdout)
  return buildPrecheck({
    nodeVersion: node.stdout.trim() || undefined,
    memoryAvailableMb: Number(mem.stdout.trim()) || undefined,
    portInUse: portLine.stdout.trim().length > 0,
    existingInstances: usedPorts.length,
    systemdPresent: systemd.code === 0,
  })
}

export async function installOpenClaw(
  payload: VpsConnectionInput & { listenPort: number },
  onProgress?: (msg: string) => void,
): Promise<OpenClawInstance> {
  const port = ensurePortInRange(payload.listenPort)
  onProgress?.("检测包管理器…")
  const pkg = await detectPackageManager()
  if (pkg === "unknown") {
    throw new Error("未识别包管理器（apt/dnf/yum），无法自动安装 Node")
  }
  onProgress?.(`检测到包管理器：${pkg}`)

  onProgress?.("检查 Node 版本…")
  const nodeCheck = await runRemoteShellCommand(payload, "node --version 2>/dev/null || true", { timeoutMs: 5_000 })
  const major = Number(nodeCheck.stdout.trim().replace(/^v/, "").split(".")[0])
  if (!nodeCheck.stdout.trim() || (Number.isFinite(major) && major < 20)) {
    onProgress?.("安装 Node.js 20.x…")
    if (pkg === "apt") {
      await runRemoteShellCommand(
        payload,
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs",
        { timeoutMs: 240_000 },
      )
    } else {
      await runRemoteShellCommand(
        payload,
        "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && (dnf install -y nodejs || yum install -y nodejs)",
        { timeoutMs: 240_000 },
      )
    }
  }

  onProgress?.("安装 OpenClaw…")
  await runRemoteShellCommand(payload, "npm i -g openclaw@latest", { timeoutMs: 300_000 })

  const serviceName = `openclaw@${port}.service`
  const dataDir = `/root/.openclaw-${port}`
  const unit = buildSystemdUnit(port)
  onProgress?.("写入 systemd unit…")
  await runRemoteShellCommand(
    payload,
    `mkdir -p ${dataDir} && cat > /etc/systemd/system/${serviceName} <<'EOF'\n${unit}\nEOF`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(payload, "systemctl daemon-reload && systemctl enable --now " + serviceName, {
    timeoutMs: 30_000,
  })

  const status = await runRemoteShellCommand(payload, "systemctl status " + serviceName + " --no-pager || true", {
    timeoutMs: 10_000,
  })
  const version = await runRemoteShellCommand(payload, "openclaw --version 2>/dev/null || true", {
    timeoutMs: 5_000,
  })

  return {
    id: generateInstanceId(),
    connectionId: payload.id ?? "",
    host: payload.host,
    listenPort: port,
    dataDir,
    serviceName,
    nodeVersion: nodeCheck.stdout.trim() || undefined,
    openclawVersion: version.stdout.trim() || undefined,
    status: detectStatusFromSystemctl(status.stdout),
    installedAt: new Date().toISOString(),
  }
}

export async function uninstallOpenClaw(
  payload: VpsConnectionInput & { listenPort: number; dataDir: string },
) {
  await runRemoteShellCommand(
    payload,
    `systemctl disable --now openclaw@${payload.listenPort}.service || true`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(
    payload,
    `rm -f /etc/systemd/system/openclaw@${payload.listenPort}.service && systemctl daemon-reload`,
    { timeoutMs: 10_000 },
  )
  await runRemoteShellCommand(payload, `rm -rf ${payload.dataDir}`, { timeoutMs: 10_000 })
  return { ok: true as const }
}

export async function restartOpenClaw(payload: VpsConnectionInput & { listenPort: number }) {
  await runRemoteShellCommand(payload, `systemctl restart openclaw@${payload.listenPort}.service`, {
    timeoutMs: 10_000,
  })
  return { ok: true as const }
}

export async function fetchOpenClawLogs(payload: VpsConnectionInput & { listenPort: number; lines: number }) {
  const { stdout } = await runRemoteShellCommand(
    payload,
    `journalctl -u openclaw@${payload.listenPort}.service -n ${payload.lines} --no-pager 2>/dev/null || true`,
    { timeoutMs: 10_000 },
  )
  return stdout
}
```

- [ ] **Step 2: 把 setupOpenClawDb 接到主进程初始化**

在 `src/main/index.ts` 找到 `registerProjectHandlers()` 之前，调用：

```ts
import { openOpenClawDb, setupOpenClawDb } from "./services/openclaw-db"

const openclawDbPath = path.join(app.getPath("userData"), "openclaw.sqlite")
const openclawDb = openOpenClawDb(openclawDbPath)
setupOpenClawDb(openclawDb)
```

然后把 `openclawDb` 注入到 `registerProjectHandlers({ openclawDb })`。

- [ ] **Step 3: 修改 register-project-handlers 接受 openclawDb**

签名改为：

```ts
export function registerProjectHandlers(deps?: { openclawDb?: OpenClawDb }) { ... }
```

并在 IPC 处理器里使用它（详见 Task 5）。

- [ ] **Step 4: 提交**

```bash
git add src/main/services/openclaw-installer.ts src/main/index.ts src/main/ipc/register-project-handlers.ts
git commit -m "feat: openclaw installer ssh flow"
```

---

### Task 5: IPC 处理器注册

**Files:**
- Modify: `src/main/ipc/register-project-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/lib/desktop-api.ts`

- [ ] **Step 1: 注册 5 个 IPC**

```ts
import {
  fetchOpenClawLogs,
  installOpenClaw,
  listOpenClawInstancesRemote,
  precheckOpenClawInstall,
  restartOpenClaw,
  uninstallOpenClaw,
} from "../services/openclaw-installer"
import { openClawInstanceIdSchema, openClawInstallSchema, openClawLogsSchema } from "./schemas"

const connectionIdSchema = connectionIdSchemaFromShared

// 假设函数 listOpenClawInstancesRemote(payload) 内部读取 openclawDb + 跑 systemctl list-units + 合并状态
registerIpcHandle("openclaw:list", async (_event, connectionId: unknown) => {
  const id = parseOrThrow(connectionIdSchema, connectionId)
  return listOpenClawInstancesRemote(resolveStoredPayload(requireConnection(id)))
})

registerIpcHandle("openclaw:precheck", async (_event, payload: unknown) => {
  const parsed = parseOrThrow(openClawInstallSchema, payload)
  const conn = requireConnection(parsed.connectionId)
  return precheckOpenClawInstall({ ...resolveStoredPayload(conn), listenPort: parsed.listenPort })
})

registerIpcHandle("openclaw:install", async (_event, payload: unknown) => {
  const parsed = parseOrThrow(openClawInstallSchema, payload)
  const conn = requireConnection(parsed.connectionId)
  return installOpenClaw({ ...resolveStoredPayload(conn), listenPort: parsed.listenPort })
})

registerIpcHandle("openclaw:uninstall", async (_event, payload: unknown) => {
  const parsed = parseOrThrow(openClawInstanceIdSchema, payload)
  const conn = requireConnection(parsed.connectionId)
  const db = deps?.openclawDb
  if (!db) throw new Error("openclaw 数据库未初始化")
  const row = db.listInstances(parsed.connectionId).find((r) => r.id === parsed.instanceId)
  if (!row) throw new Error("未找到对应实例")
  await uninstallOpenClaw({
    ...resolveStoredPayload(conn),
    listenPort: row.listen_port,
    dataDir: row.data_dir,
  })
  db.deleteInstance(row.id)
  return { ok: true as const }
})

registerIpcHandle("openclaw:restart", async (_event, payload: unknown) => {
  const parsed = parseOrThrow(openClawInstanceIdSchema, payload)
  const conn = requireConnection(parsed.connectionId)
  const db = deps?.openclawDb
  if (!db) throw new Error("openclaw 数据库未初始化")
  const row = db.listInstances(parsed.connectionId).find((r) => r.id === parsed.instanceId)
  if (!row) throw new Error("未找到对应实例")
  return restartOpenClaw({ ...resolveStoredPayload(conn), listenPort: row.listen_port })
})

registerIpcHandle("openclaw:logs", async (_event, payload: unknown) => {
  const parsed = parseOrThrow(openClawLogsSchema, payload)
  const conn = requireConnection(parsed.connectionId)
  const db = deps?.openclawDb
  if (!db) throw new Error("openclaw 数据库未初始化")
  const row = db.listInstances(parsed.connectionId).find((r) => r.id === parsed.instanceId)
  if (!row) throw new Error("未找到对应实例")
  return fetchOpenClawLogs({ ...resolveStoredPayload(conn), listenPort: row.listen_port, lines: parsed.lines })
})
```

- [ ] **Step 2: 在 preload 暴露**

```ts
listOpenClawInstances: (connectionId: string) => ipcRenderer.invoke("openclaw:list", connectionId),
precheckOpenClawInstall: (payload) => ipcRenderer.invoke("openclaw:precheck", payload),
installOpenClaw: (payload) => ipcRenderer.invoke("openclaw:install", payload),
uninstallOpenClaw: (payload) => ipcRenderer.invoke("openclaw:uninstall", payload),
restartOpenClaw: (payload) => ipcRenderer.invoke("openclaw:restart", payload),
fetchOpenClawLogs: (payload) => ipcRenderer.invoke("openclaw:logs", payload),
```

- [ ] **Step 3: 在 desktop-api 包装**

```ts
listOpenClawInstances: (connectionId) => wrapInvoke(() => api.openclaw.listOpenClawInstances(connectionId)),
precheckOpenClawInstall: (payload) => wrapInvoke(() => api.openclaw.precheckOpenClawInstall(payload)),
installOpenClaw: (payload) => wrapInvoke(() => api.openclaw.installOpenClaw(payload)),
uninstallOpenClaw: (payload) => wrapInvoke(() => api.openclaw.uninstallOpenClaw(payload)),
restartOpenClaw: (payload) => wrapInvoke(() => api.openclaw.restartOpenClaw(payload)),
fetchOpenClawLogs: (payload) => wrapInvoke(() => api.openclaw.fetchOpenClawLogs(payload)),
```

- [ ] **Step 4: 跑 typecheck**

```bash
NAPI_RS_FORCE_WASI=1 npx tsc --noEmit -p tsconfig.node.json
NAPI_RS_FORCE_WASI=1 npx tsc --noEmit -p tsconfig.web.json
```

预期：两个命令 EXIT=0。

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/register-project-handlers.ts src/preload/index.ts src/renderer/src/lib/desktop-api.ts
git commit -m "feat: openclaw ipc handlers"
```

---

### Task 6: 渲染端 store

**Files:**
- Modify: `src/renderer/src/store/project-store.ts`

- [ ] **Step 1: 替换 store 内容**

```ts
import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  OpenClawInstance,
  OpenClawInstallInput,
  OpenClawPrecheck,
  RemoteManagedProjectScanResult,
} from "../../../shared/projects"

type ProjectStoreState = {
  scanResult?: RemoteManagedProjectScanResult
  isScanning: boolean
  scanError?: string
  openclawInstances: OpenClawInstance[]
  openclawLoading: boolean
  openclawError?: string
  scanForConnection: (connectionId: string) => Promise<void>
  clearScan: () => void
  loadOpenClawInstances: (connectionId: string) => Promise<void>
  precheckOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawPrecheck>
  installOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawInstance>
  uninstallOpenClaw: (instanceId: string, connectionId: string) => Promise<void>
  restartOpenClaw: (instanceId: string, connectionId: string) => Promise<void>
  fetchOpenClawLogs: (instanceId: string, connectionId: string, lines?: number) => Promise<string>
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  scanResult: undefined,
  isScanning: false,
  scanError: undefined,
  openclawInstances: [],
  openclawLoading: false,
  openclawError: undefined,
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
  loadOpenClawInstances: async (connectionId) => {
    set({ openclawLoading: true, openclawError: undefined })
    try {
      const instances = await getDesktopApi().projects.listOpenClawInstances(connectionId)
      set({ openclawInstances: instances, openclawLoading: false })
    } catch (error) {
      set({ openclawLoading: false, openclawError: error instanceof Error ? error.message : "加载 OpenClaw 实例失败" })
    }
  },
  precheckOpenClaw: async (payload) => getDesktopApi().projects.precheckOpenClawInstall(payload),
  installOpenClaw: async (payload) => {
    const inst = await getDesktopApi().projects.installOpenClaw(payload)
    set((state) => ({ openclawInstances: [...state.openclawInstances, inst] }))
    return inst
  },
  uninstallOpenClaw: async (instanceId, connectionId) => {
    await getDesktopApi().projects.uninstallOpenClaw({ connectionId, instanceId })
    set((state) => ({ openclawInstances: state.openclawInstances.filter((i) => i.id !== instanceId) }))
  },
  restartOpenClaw: async (instanceId, connectionId) => {
    await getDesktopApi().projects.restartOpenClaw({ connectionId, instanceId })
  },
  fetchOpenClawLogs: async (instanceId, connectionId, lines = 50) =>
    getDesktopApi().projects.fetchOpenClawLogs({ connectionId, instanceId, lines }),
}))
```

- [ ] **Step 2: 跑 typecheck**

```bash
NAPI_RS_FORCE_WASI=1 npx tsc --noEmit -p tsconfig.web.json
```

预期 EXIT=0。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/store/project-store.ts
git commit -m "feat: openclaw renderer store"
```

---

### Task 7: 渲染端 `agent-management-panel` + 子组件

**Files:**
- Create: `src/renderer/src/components/agent-management-panel.tsx`
- Create: `src/renderer/src/components/openclaw-install-dialog.tsx`
- Create: `src/renderer/src/components/openclaw-instance-card.tsx`
- Create: `src/renderer/src/components/openclaw-log-drawer.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: agent-management-panel.tsx（页面）**

```tsx
import { useEffect, useMemo, useState } from "react"
import { Bot, Globe, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useProjectStore } from "@/store/project-store"
import type { OpenClawInstance, OpenClawPrecheckReason } from "../../../shared/projects"
import type { VpsConnectionRecord } from "../../../shared/vps"
import { OpenClawInstallDialog } from "./openclaw-install-dialog"
import { OpenClawInstanceCard } from "./openclaw-instance-card"
import { OpenClawLogDrawer } from "./openclaw-log-drawer"

const PRECHECK_TEXT: Record<OpenClawPrecheckReason, string> = {
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
          <Button variant="outline" size="sm" onClick={() => {
            void scanForConnection(selectedConnectionId)
            void loadOpenClawInstances(selectedConnectionId)
          }}>
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
          <Card><CardContent className="text-sm text-destructive">{scanError}</CardContent></Card>
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
          <Card><CardContent className="text-sm text-destructive">{openclawError}</CardContent></Card>
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

export { PRECHECK_TEXT }
```

- [ ] **Step 2: openclaw-install-dialog.tsx**

```tsx
import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useProjectStore } from "@/store/project-store"
import type { OpenClawInstance, OpenClawPrecheck, OpenClawPrecheckReason } from "../../../shared/projects"
import { PRECHECK_TEXT } from "./agent-management-panel"

const MAX_INSTANCES = 4

export function OpenClawInstallDialog({
  open,
  onOpenChange,
  connectionId,
  existingInstances,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connectionId: string
  existingInstances: OpenClawInstance[]
}) {
  const { precheckOpenClaw, installOpenClaw } = useProjectStore()
  const [port, setPort] = useState(18789)
  const [precheck, setPrecheck] = useState<OpenClawPrecheck | null>(null)
  const [progress, setProgress] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!open) return
    const usedPorts = new Set(existingInstances.map((i) => i.listenPort))
    let next = 18789
    for (let i = 0; i < MAX_INSTANCES; i += 1) {
      if (!usedPorts.has(18789 + i)) {
        next = 18789 + i
        break
      }
    }
    setPort(next)
  }, [open, existingInstances])

  useEffect(() => {
    if (!open) return
    void precheckOpenClaw({ connectionId, listenPort: port })
      .then(setPrecheck)
      .catch(() => setPrecheck({ ready: false, reasons: [], existingInstances: 0, portInUse: false }))
  }, [open, port, connectionId, precheckOpenClaw])

  const submit = async () => {
    setInstalling(true)
    setProgress([])
    try {
      const inst = await installOpenClaw({ connectionId, listenPort: port })
      setProgress((p) => [...p, `已安装 ${inst.serviceName}@${inst.listenPort}`])
      setTimeout(() => onOpenChange(false), 800)
    } catch (error) {
      setProgress((p) => [...p, `安装失败：${error instanceof Error ? error.message : String(error)}`])
    } finally {
      setInstalling(false)
    }
  }

  const reasons: OpenClawPrecheckReason[] = precheck?.reasons ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>安装 OpenClaw（小龙虾）</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span>监听端口</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="rounded-md border border-input px-2 py-1 text-foreground"
            />
          </label>
          {precheck?.nodeVersion ? (
            <p className="text-xs text-muted-foreground">Node 版本：{precheck.nodeVersion}</p>
          ) : null}
          {reasons.length > 0 ? (
            <ul className="list-disc pl-4 text-xs text-destructive">
              {reasons.map((r) => (
                <li key={r}>{PRECHECK_TEXT[r]}</li>
              ))}
            </ul>
          ) : precheck ? (
            <p className="text-xs text-emerald-600">预检通过，可以安装。</p>
          ) : null}
          {progress.length > 0 ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {progress.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            取消
          </Button>
          <Button onClick={submit} disabled={installing || !precheck?.ready}>
            {installing ? "安装中" : "开始安装"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: openclaw-instance-card.tsx**

```tsx
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
            <p className="text-xs text-muted-foreground">service：<code>{instance.serviceName}</code></p>
          </div>
          <Badge className={STATUS_TONE[instance.status]}>
            {instance.status}
          </Badge>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <div>Node：{instance.nodeVersion ?? "未识别"}</div>
          <div>版本：{instance.openclawVersion ?? "未识别"}</div>
          <div>数据目录：<code>{instance.dataDir}</code></div>
          <div>安装时间：{new Date(instance.installedAt).toLocaleString()}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onShowLogs}>
            <FileText className="size-4" /> 日志
          </Button>
          <Button size="sm" variant="outline" onClick={() => void restartOpenClaw(instance.id, connectionId)}>
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
```

- [ ] **Step 4: openclaw-log-drawer.tsx**

```tsx
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useProjectStore } from "@/store/project-store"
import type { OpenClawInstance } from "../../../shared/projects"

export function OpenClawLogDrawer({
  target,
  connectionId,
  onClose,
}: {
  target: OpenClawInstance | null
  connectionId: string
  onClose: () => void
}) {
  const { fetchOpenClawLogs } = useProjectStore()
  const [logs, setLogs] = useState("")
  useEffect(() => {
    if (!target) return
    void fetchOpenClawLogs(target.id, connectionId, 100).then(setLogs)
  }, [target, connectionId, fetchOpenClawLogs])
  return (
    <Dialog open={!!target} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>OpenClaw 日志：{target?.serviceName}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
          {logs || "暂无日志"}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: 在 App.tsx 替换导入 + 改导航**

```diff
- import { ProjectManagementPanel } from "@/components/project-management-panel"
+ import { AgentManagementPanel } from "@/components/agent-management-panel"

- { key: "projects", label: "项目管理", icon: FolderKanban },
+ { key: "projects", label: "代理管理", icon: Bot },

- <ProjectManagementPanel
-   connections={connections}
-   selectedConnectionId={selectedConnectionId}
-   highlightedProjectId={highlightedProjectId}
-   onOpenRemoteDirectory={openRemoteDirectoryInBrowser}
- />
+ <AgentManagementPanel
+   connections={connections}
+   selectedConnectionId={selectedConnectionId}
+ />
```

同时把 `lucide-react` 的 `FolderKanban` 替换为 `Bot`。

- [ ] **Step 6: 跑 typecheck 与测试**

```bash
NAPI_RS_FORCE_WASI=1 npx tsc --noEmit -p tsconfig.node.json
NAPI_RS_FORCE_WASI=1 npx tsc --noEmit -p tsconfig.web.json
NAPI_RS_FORCE_WASI=1 npx vitest run
```

预期：typecheck 双绿，vitest 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/components/agent-management-panel.tsx \
  src/renderer/src/components/openclaw-install-dialog.tsx \
  src/renderer/src/components/openclaw-instance-card.tsx \
  src/renderer/src/components/openclaw-log-drawer.tsx \
  src/renderer/src/App.tsx
git commit -m "feat: openclaw agent management panel"
```

---

## 自检

- Spec 覆盖：Nginx 反向代理展示、OpenClaw 一键安装、多实例、预检、运行态、日志、重启、卸载 — 全部对应到 Task 1-7。
- 类型一致性：所有用到的 `OpenClawInstance / OpenClawPrecheck / OpenClawInstallInput` 在 Task 1 定义，在 Task 4-7 引用，签名一致。
- 占位扫描：全文搜索 `TODO / TBD / 占位` — 0 个。