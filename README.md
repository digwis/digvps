<div align="center">

# 🏔️ CloudRoost / 云栖

**轻量级 VPS 远程服务器管理面板**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-green.svg)]()

[English](#english) · [中文](#中文)

</div>

---

<a id="english"></a>

## 🌐 English

CloudRoost is an open-source desktop application for managing remote Linux VPS servers. Connect via SSH and monitor, inspect, and manage your servers through a clean, modern GUI — no more juggling terminal windows.

### ✨ Features

- **📊 Server Monitoring** — Real-time CPU, memory, disk, network, and load metrics with auto-refresh. Color-coded alerts when thresholds are exceeded.
- **🖥️ Remote Terminal** — Built-in xterm.js SSH terminal. Connect to your server directly without leaving the app.
- **📁 File Browser** — Full remote file management: browse, create, edit, rename, delete, upload, and download. Tree and card views with hidden file toggle.
- **🔐 Permission Management** — Visual chmod with quick presets (standard/collaborative/secure/private) and manual octal input.
- **🗑️ Trash System** — Soft-delete with restore and purge, so you never accidentally lose remote files.
- **📦 System Upgrades** — One-click `apt upgrade` with reboot support. See pending upgrade count at a glance.
- **🚀 Project Deployment** — Scaffold and deploy Next.js projects (with Payload CMS, Directus, or plain templates). Configure databases, SSL, domains, and environment variables.
- **🔑 SSH Config Import** — Import connections from `~/.ssh/config`. Auto-discover known hosts.
- **🔍 Command Palette** — `Cmd+K` / `Ctrl+K` to search across servers and projects instantly.
- **🌙 Dark Mode** — System-aware theme with light/dark toggle.
- **🌍 i18n** — English and Chinese (简体中文) with lazy-loaded locale files.

### 📸 Screenshots

> *Screenshots coming soon*

### 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| Frontend | React 19 · TypeScript · Tailwind CSS 4 |
| UI Components | Radix UI · Lucide Icons |
| State | Zustand |
| i18n | i18next |
| Terminal | xterm.js |
| SSH | ssh2 · ssh2-sftp-client |
| Database | better-sqlite3 |
| Build | electron-vite · Vite 7 |

### 📦 Installation

Download the latest release for your platform:

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon & Intel) | `.dmg` |
| Linux | `.AppImage` / `.deb` |
| Windows | `.exe` (NSIS installer) |

### 🔨 Development

```bash
# Clone the repository
git clone https://github.com/zhaofilms/CloudRoost.git
cd CloudRoost

# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests
npm run test

# Type check
npm run typecheck

# Build for production
npm run build

# Package for current platform
npm run dist:mac
```

### 📄 License

[MIT](LICENSE) — Free and open source.

---

<a id="中文"></a>

## 🏔️ 中文

云栖是一个开源的桌面应用，用于管理远程 Linux VPS 服务器。通过 SSH 连接，在简洁现代的图形界面中监控、检查和管理你的服务器——不再需要来回切换终端窗口。

### ✨ 功能特性

- **📊 服务器监控** — 实时 CPU、内存、磁盘、网络和负载指标，自动刷新。超过阈值时颜色告警。
- **🖥️ 远程终端** — 内置 xterm.js SSH 终端，无需离开应用即可连接服务器。
- **📁 文件浏览器** — 完整的远程文件管理：浏览、创建、编辑、重命名、删除、上传和下载。树形和卡片视图，支持显示隐藏文件。
- **🔐 权限管理** — 可视化 chmod，提供快捷预设（标准/协作/安全/私有）和手动八进制输入。
- **🗑️ 回收站** — 软删除支持恢复和彻底清除，避免误删远程文件。
- **📦 系统升级** — 一键 `apt upgrade`，支持重启。一目了然查看待升级数量。
- **🚀 项目部署** — 脚手架创建和部署 Next.js 项目（支持 Payload CMS、Directus 或纯模板）。配置数据库、SSL、域名和环境变量。
- **🔑 SSH 配置导入** — 从 `~/.ssh/config` 导入连接，自动发现已知主机。
- **🔍 命令面板** — `Cmd+K` / `Ctrl+K` 即时搜索服务器和项目。
- **🌙 深色模式** — 跟随系统主题，支持亮色/暗色切换。
- **🌍 国际化** — 英文和简体中文，按需加载语言文件。

### 📸 截图

> *截图即将添加*

### 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 41 |
| 前端 | React 19 · TypeScript · Tailwind CSS 4 |
| UI 组件 | Radix UI · Lucide Icons |
| 状态管理 | Zustand |
| 国际化 | i18next |
| 终端 | xterm.js |
| SSH | ssh2 · ssh2-sftp-client |
| 数据库 | better-sqlite3 |
| 构建 | electron-vite · Vite 7 |

### 📦 安装

下载适用于你平台的最新版本：

| 平台 | 格式 |
|------|------|
| macOS (Apple Silicon & Intel) | `.dmg` |
| Linux | `.AppImage` / `.deb` |
| Windows | `.exe` (NSIS 安装包) |

### 🔨 开发

```bash
# 克隆仓库
git clone https://github.com/zhaofilms/CloudRoost.git
cd CloudRoost

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 运行测试
npm run test

# 类型检查
npm run typecheck

# 生产构建
npm run build

# 打包当前平台
npm run dist:mac
```

### 📄 许可证

[MIT](LICENSE) — 免费开源。

---

<div align="center">

Made with ☕ by [西山懒懒翁](https://github.com/zhaofilms)

</div>
