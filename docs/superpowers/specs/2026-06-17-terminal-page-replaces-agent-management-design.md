# 终端页面替换代理管理设计

## 背景与目标

当前产品已经有 `主机概览`、`运行环境`、`文件管理` 等围绕 VPS 的主能力，但 `代理管理` 方向不再符合当前需求。新的目标是：

- **彻底移除代理管理**：左侧导航不再出现 `代理管理`，不再提供 OpenClaw / 代理实例相关入口。
- **新增终端页面**：在原导航位置改为 `终端`，进入后直接面向当前选中的 VPS 提供远程 SSH 终端。
- **保持心智统一**：用户从“看代理状态”切回“直接操作服务器”，让 Digwis 更像一个本地 SSH 控制台。
- **控制范围**：第一版只做单页、单会话、远程 VPS 终端，不做本机终端、多标签终端或终端抽屉。

## 范围

包含：

- 左侧导航 `代理管理` 改为 `终端`
- 原 `AgentManagementPanel` 页面入口移除
- 新增独立 `TerminalPage`，基于当前选中的 VPS 建立远程 SSH 终端
- 页面内提供连接中、已连接、连接失败、断开后的状态反馈
- 提供手动重连入口
- 终端页和当前顶部 VPS 选择器联动，切换 VPS 后终端页切换目标主机

不包含：

- 本机终端
- 多标签终端 / 分屏终端
- 命令历史、收藏命令、快捷命令模板
- 终端抽屉模式
- 代理管理任何残留 UI
- OpenClaw 安装、日志、重启、卸载等代理能力的继续保留

## 用户故事

1. 用户打开 Digwis，选中一台 VPS，点击左侧 `终端`，直接看到该 VPS 的远程终端页面。
2. 用户在终端中输入命令，例如 `systemctl status nginx`、`pm2 list`、`tail -f /var/log/nginx/error.log`，立即得到远端输出。
3. 用户切换顶部 VPS 选择器后，终端页切换到新的目标主机，并清晰提示当前连接上下文。
4. 用户遇到 SSH 断开或认证失败时，终端页显示错误信息，并可点“重连”恢复。

## 方案对比

### 方案 A：独立终端页面（推荐）

- 左侧导航直接把 `代理管理` 替换成 `终端`
- 用户进入一个完整页面进行 SSH 操作
- 优点：
  - 与现有侧边栏导航模型最一致
  - 空间最大，后续扩展多标签/会话列表更自然
  - 不会和主机概览、文件管理等页面布局互相挤压
- 缺点：
  - 不是“随开随关”的轻量浮层

### 方案 B：顶部按钮 + 底部终端抽屉

- 在任何页面点一个终端按钮，底部滑出一个终端面板
- 优点：
  - 边看页面边执行命令
- 缺点：
  - 和当前页面布局耦合度高
  - 需要处理遮挡、收起、焦点和滚动冲突
  - 第一版实现复杂度更高

### 方案 C：独立终端页面 + 抽屉双入口

- 左侧有终端页，同时顶部也有快速终端按钮
- 优点：
  - 兼顾完整模式和快捷模式
- 缺点：
  - 超出本期范围
  - 容易出现两套终端状态同步问题

**结论**：

- 本期采用 **方案 A**
- 实现层面保留当前导航 key `projects`，仅替换其标签和渲染内容，降低改动面
- 用户层面完全视为“代理管理已删除，终端已上线”

## 信息架构

### 导航层

- 现有：
  - `主机概览`
  - `运行环境`
  - `代理管理`
  - `文件管理`
- 调整后：
  - `主机概览`
  - `运行环境`
  - `终端`
  - `文件管理`

### 页面结构

`TerminalPage` 分为四个区域：

1. **顶部上下文栏**
   - 当前 VPS 名称
   - 主机地址 / 端口
   - 连接状态
   - 重连按钮

2. **状态提示区**
   - 未选择 VPS
   - 正在连接
   - 连接失败
   - 已断开

3. **终端主体**
   - 远程 shell 输出区域
   - 输入区域
   - 自动滚动到底部

4. **底部辅助信息**
   - 当前会话的工作状态提示
   - 必要时提示“切换 VPS 会重建会话”

## 技术设计

### 渲染端

新增组件：

- `src/renderer/src/components/terminal-page.tsx`

职责：

- 接收 `selectedConnectionId`
- 读取当前连接记录，展示主机上下文
- 调用桌面 API 创建 / 输入 / 关闭远程终端会话
- 在页面内维护终端输出流和连接状态

状态模型建议：

```ts
type TerminalSessionState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected"; sessionId: string }
  | { phase: "error"; message: string }
  | { phase: "closed"; reason?: string }
```

交互规则：

- `selectedConnectionId` 为空：不建立连接，只显示“先选择一台 VPS”
- 首次进入终端页且已选中 VPS：自动连接
- 切换 VPS：关闭旧会话，重建新会话
- 点击“重连”：重新建立当前 VPS 会话

### 主进程

新增一个独立的远程终端服务，而不是复用 OpenClaw/代理逻辑：

- 建议文件：`src/main/services/remote-terminal.ts`

职责：

- 基于当前 VPS 连接信息创建交互式 SSH shell
- 维护会话 id 到 SSH client / shell stream 的映射
- 向渲染端持续推送 stdout / stderr / close / error 事件
- 接收渲染端输入并写回远程 shell

建议暴露接口：

```ts
createTerminalSession(connectionId: string): Promise<{ sessionId: string }>
writeTerminalInput(payload: { sessionId: string; data: string }): Promise<void>
resizeTerminal(payload: { sessionId: string; cols: number; rows: number }): Promise<void>
closeTerminalSession(payload: { sessionId: string }): Promise<void>
```

建议事件通道：

```ts
terminal:data
terminal:exit
terminal:error
```

### IPC 与 Preload

新增 IPC：

- `terminal:create`
- `terminal:write`
- `terminal:resize`
- `terminal:close`
- `terminal:on-data`
- `terminal:on-exit`
- `terminal:on-error`

在 `preload` 和 `desktop-api` 中新增 `terminal` 命名空间，避免继续把终端能力挂在 `projects` 下。

### 会话管理

第一版只允许页面层同时维护一个活动远程终端会话。

约束：

- 离开终端页时关闭会话
- 切换 VPS 时关闭旧会话
- 应用窗口关闭时由主进程兜底清理会话

## 删除与清理范围

以下内容从产品入口中移除：

- `App.tsx` 中 `AgentManagementPanel` 渲染
- 左侧导航中的 `代理管理`
- 与代理管理页直接绑定的 UI 组件：
  - `agent-management-panel.tsx`
  - `openclaw-install-dialog.tsx`
  - `openclaw-install-dialog-state.ts`
  - `openclaw-instance-card.tsx`
  - `openclaw-log-drawer.tsx`
  - `openclaw-install-dialog-state.test.ts`

以下内容从主流程能力中移除：

- `openclaw:*` IPC 注册
- 渲染端 `project-store` 中 OpenClaw 相关状态与方法
- preload / desktop-api 中 OpenClaw 暴露接口

以下内容可以保留但不再被入口使用，作为后续清理项：

- 若 SQLite 中已有 `openclaw_instances` 表，可暂时保留，不做迁移回滚
- `debug-openclaw-install-status.md` 及调试日志文件不属于本次产品功能，可在后续调试清理阶段统一处理

## 错误处理

终端页需要明确区分以下状态：

- 未选择 VPS：提示用户先选主机
- SSH 认证失败：显示清晰错误文案
- 连接超时：显示超时提示并给重连按钮
- 会话被远端关闭：提示“会话已断开”
- 输入失败：在页面内显示轻量错误，不直接崩整个终端页

## 安全约束

- 不缓存终端输入历史到磁盘
- 不自动执行任何预设命令
- 不因为进入终端页而修改远端环境
- 仅在用户显式选择 VPS 后建立 SSH 连接

## 测试策略

包含：

- `App.tsx` 导航切换测试或最小行为测试：确认 `代理管理` 消失、`终端` 出现
- `TerminalPage` 纯状态测试：未选中、连接中、失败、已连接
- 主进程远程终端服务的最小单测：
  - 创建会话
  - 关闭会话
  - 对不存在 sessionId 写入时报错

不包含：

- 真实 SSH 集成自动化测试
- PTY / xterm.js 级别的视觉快照测试

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 交互式 shell 与现有一次性 SSH 命令实现不同 | 新建独立 `remote-terminal.ts`，不污染现有 `runRemoteShellCommand` |
| 终端组件过重 | 第一版采用最小可用方案，优先稳定连接与输出 |
| 切换 VPS 导致会话残留 | 页面切换和主进程退出时都做会话关闭 |
| 完全移除代理管理导致残余引用报错 | 从 `App.tsx`、store、preload、desktop-api、IPC 五层同步清理 |

## 明确不做

- 不做代理管理保留入口
- 不做 OpenClaw 相关入口保留
- 不做顶部终端抽屉
- 不做本机终端
- 不做多标签终端
- 不做命令历史 / 收藏命令 / 快捷命令
