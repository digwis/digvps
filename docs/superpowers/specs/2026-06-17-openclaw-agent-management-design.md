# 代理管理 + OpenClaw 一键安装设计

## 背景与目标

我们已经把“项目部署”改成了“项目管理”，用 Nginx 反向代理扫描来呈现 VPS 上现成跑着的项目。本轮要把它再往前推一步：

- **更名**：`项目管理 → 代理管理`。心智从“项目列表”变成“VPS 上跑着的代理 / 进程”。
- **承载 AI Agent 一键安装**：用户选中一台 VPS，点一下就能把 OpenClaw（小龙虾）装上去、跑起来、自启、能在 Telegram/微信里调用。
- **代理运行态**：和现有 Nginx 站点扫描并列展示，让用户“一屏看到这台 VPS 上所有的代理 / 进程”。
- **整套依然本地 + SSH**：VPS 凭据不出本机，不开新公网端口，不依赖第三方 SaaS。

## 范围

包含：
- 左侧导航 `项目管理` 改名为 `代理管理`
- 代理管理页布局：上半部分 “Nginx 反向代理站点” + 下半部分 “已安装的 OpenClaw 实例”
- OpenClaw 一键安装：探测 → 预检 → 安装 Node ≥ 20 → 全局 npm 装 OpenClaw → 写 systemd unit → 开机自启 → 注册到 Digwis 本地
- 多实例支持：同一台 VPS 可装多只 OpenClaw，端口错开（默认 18789，可指定）
- 本地代理元数据管理：把“已安装的代理”保存在 Digwis 本地（SQLite），不污染 VPS
- 实时状态：从 VPS 拉取 `systemctl status`、`journalctl`、`pm2 jlist`、`ss -ltnp`、`node --version` 等，得到运行状态

不包含（本期延后）：
- 在 Digwis 内配置 Telegram / 微信 / 飞书等渠道的 Token（提示用户在 VPS 上跑 `openclaw onboard` 完成）
- 自动绑定 ClawHub Skills / Marketplace
- 多用户、团队权限

## 用户故事

1. **新装一只龙虾**：在代理管理页选中一台 VPS → 点“一键安装 OpenClaw” → 客户端检测 Node 版本、内存、已装的实例数 → 提示用户确认 → 自动安装 → 自动写 systemd unit → 完成后在“已安装的代理”列表里能看到。
2. **多只龙虾**：用户同一台 VPS 上想养第二只 → “一键安装” → 端口自动 +1（例如 18790）→ systemd unit 名带端口后缀（如 `openclaw@18790.service`）。
3. **查看运行情况**：点开“已安装的代理”卡片 → 看到 Node 版本、OpenClaw 版本、systemd 状态、最近 50 行日志、监听端口、内存占用、已用 Skills 数。
4. **卸载 / 停止 / 重启**：在卡片上点操作 → 通过 SSH 跑对应命令 → 状态实时刷新。

## 架构

### 共享类型（`src/shared/projects.ts`）

在已有 `RemoteManagedProject` 之外新增：

```ts
export type OpenClawInstanceStatus =
  | "running"
  | "stopped"
  | "failed"
  | "unknown"

export type OpenClawInstance = {
  id: string                // 本地 UUID
  connectionId: string      // VPS 连接 id
  host: string              // VPS host（仅显示用）
  listenPort: number        // 默认 18789
  dataDir: string           // VPS 上的工作目录（默认 ~/.openclaw）
  serviceName: string       // systemd unit 名
  nodeVersion?: string      // VPS 上 Node 版本
  openclawVersion?: string  // OpenClaw 版本
  status: OpenClawInstanceStatus
  lastCheckedAt?: string    // ISO 时间
  lastLog?: string          // 最近 50 行日志（前端展示用）
}

export type OpenClawPrecheck = {
  ready: boolean
  reasons: string[]
  nodeVersion?: string
  memoryAvailableMb?: number
  existingInstances: number
  portInUse: boolean
}

export type OpenClawInstallInput = {
  connectionId: string
  listenPort: number        // 默认 18789，多实例时 +1
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
  lines: number             // 默认 50
}
```

`ManagedProjectsApi` 增加：

```ts
scanRemoteProjects: ...
listOpenClawInstances: (connectionId: string) => Promise<OpenClawInstance[]>
precheckOpenClawInstall: (payload: OpenClawInstallInput) => Promise<OpenClawPrecheck>
installOpenClaw: (payload: OpenClawInstallInput, onProgress: (msg: string) => void) => Promise<OpenClawInstance>
uninstallOpenClaw: (payload: OpenClawUninstallInput) => Promise<{ ok: true }>
restartOpenClaw: (payload: OpenClawRestartInput) => Promise<{ ok: true }>
fetchOpenClawLogs: (payload: OpenClawLogsInput) => Promise<string>
```

### 主进程服务（`src/main/services/openclaw-installer.ts`）

暴露以下函数：

- `precheckOpenClaw(payload)`：通过 SSH 跑一组 `uname -m`, `node --version || echo MISSING`, `free -m`, `ss -ltn | grep :PORT`, `systemctl list-unit-files | grep openclaw`。返回 `OpenClawPrecheck`。
- `installOpenClaw(payload, onProgress)`：串行执行
  1. 探测包管理器（apt / dnf / yum），输出到进度
  2. 若 Node < 20 或缺失：装 Node（用 NodeSource `setup_20.x`）
  3. `npm i -g openclaw@latest`
  4. 写 systemd unit：`/etc/systemd/system/openclaw@<port>.service`（带环境变量 `OPENCLAW_PORT`, `OPENCLAW_HOME`）
  5. `systemctl daemon-reload && systemctl enable --now openclaw@<port>`
  6. `systemctl status openclaw@<port>` 校验
- `uninstallOpenClaw(payload)`：`systemctl disable --now` → 删除 unit → `rm -rf ~/.openclaw-<port>` → `npm rm -g openclaw`（不删除其它 npm 包）。
- `restartOpenClaw(payload)`：`systemctl restart openclaw@<port>`。
- `fetchOpenClawLogs(payload)`：`journalctl -u openclaw@<port> -n <lines> --no-pager`。
- `listOpenClawInstances(connectionId)`：扫本地 SQLite + 用 SSH 跑 `systemctl list-units --type=service openclaw@*.service` 拉取每个实例的 status。

### 本地元数据存储（`src/main/services/db.ts`）

新增 `openclaw_instances` 表：

```sql
CREATE TABLE openclaw_instances (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  data_dir TEXT NOT NULL,
  service_name TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  UNIQUE(connection_id, listen_port)
);
```

迁移在现有 `db.ts` 里加一个 `runOpenClawMigrations(db)`。

### 渲染端

`src/renderer/src/store/project-store.ts` 扩展：

```ts
useProjectStore.getState().scanForConnection(connectionId)
useProjectStore.getState().loadOpenClawInstances(connectionId)
useProjectStore.getState().installOpenClaw(payload, onProgress)
useProjectStore.getState().uninstallOpenClaw(payload)
useProjectStore.getState().restartOpenClaw(payload)
useProjectStore.getState().fetchOpenClawLogs(payload)
```

`src/renderer/src/components/project-management-panel.tsx` 改名为 `agent-management-panel.tsx`：

- 顶部：`VPS 上下文信息条`（连接名 / 内存 / 已装实例数）
- 一键安装按钮：未装 → 显示 “一键安装 OpenClaw”；已装 ≥ 1 → 显示 “再加一只”
- 中间分两个 section：
  - **Nginx 反向代理站点**：复用现有 `RemoteManagedProject` 卡片（中量版信息）
  - **已安装的代理**：每只 OpenClaw 一个卡片，包含：
    - 监听端口 / 状态徽章
    - Node 版本 / OpenClaw 版本 / 内存占用
    - systemd service 名
    - 操作按钮：查看日志 / 重启 / 卸载
- 选中某个实例时，下方打开日志抽屉（最近 50 行）
- 所有状态信息都用“自动刷新 + 手动刷新”两种方式触发
- 安装过程通过进度条 + 步骤提示呈现

## 关键技术决策

### 单 VPS 多实例的端口管理
- 第一只默认 18789
- 后续只允许 `18789 + N`，N >= 1，最多到 4 只（与前面给的“入门级最多 1 只”建议保持一致，但在 ≥ 2 GB RAM 的 VPS 上允许更多）
- 写入数据库前要 `precheck` 端口空闲

### 多实例 systemd unit 模板
- 使用 `openclaw@<port>.service`，unit 文件用 `%i` 接收端口
- 服务命令：`ExecStart=/usr/bin/env OPENCLAW_PORT=%i OPENCLAW_HOME=/root/.openclaw-%i /usr/bin/openclaw gateway --port %i`
- 端口冲突时 `%i` 自动从 `ListenStream` 中解析（systemd socket activation 不必，直接使用环境变量即可）

### 升级策略
- OpenClaw 升级通过 `npm i -g openclaw@latest && systemctl restart openclaw@<port>`，UI 提供 “升级” 操作
- Node 升级不自动触发，避免大版本变更

### 安全约束
- 不在 UI 暴露任何 Telegram / 微信 Token
- 日志抓取只读取 `journalctl`，不做全量 dump
- 安装脚本幂等：再次安装时若 service 已存在，直接返回当前状态

## 风险与回退

| 风险 | 缓解 |
|---|---|
| NodeSource 安装在某些精简镜像上失败 | 预检时打印 OS 镜像类型，失败提示用户手动装 Node |
| systemd 不存在（容器 / 非 systemd VPS） | 预检 `pidof systemd || command -v systemctl`，不支持时直接报错 |
| OpenClaw 安装包被官方改结构 | 单元测试覆盖 `precheck` / `parseServiceList`，主流程若失败输出原始日志 |
| 端口被非 OpenClaw 服务占用 | 预检 `ss -ltn` 报告冲突，给出明确端口提示 |

## 不做（明确剔除）

- 不做 Telegram / 微信 / 飞书的渠道配置（用户在 VPS 上跑 `openclaw onboard`）
- 不做 ClawHub Skills 浏览 / 安装（用户自己用 `openclaw skills`）
- 不做多用户 / 团队权限
- 不做 OpenClaw 之外的其它 AI Agent（保留 OpenClaw 一项）
- 不动现有“主机概览 / 运行环境 / 文件管理”等模块