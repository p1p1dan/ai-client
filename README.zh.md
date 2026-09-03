<p align="center">
  <img src="docs/assets/logo.png" alt="AiClient Logo" width="120" />
</p>

<h1 align="center">AiClient</h1>

<p align="center">
  <strong>面向 Git Worktree 的 Pi 原生 AI 编程桌面应用</strong>
</p>
<p align="center">
  在不同任务之间切换时，分别保留分支、终端、编辑器状态和 Pi 会话，
  无需反复 stash，也不会混淆上下文。
</p>

<p align="center">
  <a href="README.zh.md">中文</a> | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/p1p1dan/ai-client/releases/latest"><img src="https://img.shields.io/github/v/release/p1p1dan/ai-client?style=flat&color=blue" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Electron-39+-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

---

## AiClient 是什么

AiClient 是服务于 **Git Worktree + Pi** 工作流的 Electron 桌面应用。
每个 worktree 都能保留独立的 AI 会话、终端、文件与 Git 状态；有界 worker 池会回收
不活跃会话，避免资源无限增长。

![AiClient 终端](docs/assets/feature-terminal.png)

## 安装

请从 [GitHub Releases](https://github.com/p1p1dan/ai-client/releases/latest)
下载发布产物。

| 平台 | 产物 |
|---|---|
| Windows x64 | 安装版或便携版 `.exe` |
| Linux x64 | `.AppImage` 或 `.deb` |

当前候选版本尚未提供已签名、公证的 macOS 正式安装包。升级和回退说明见
[Pi-only 迁移指南](docs/pi-only-migration.md)。

### 从源码运行

```bash
git clone https://github.com/p1p1dan/ai-client.git
cd ai-client

# 需要 Node.js 24 与 pnpm 10
pnpm install
pnpm dev
```

打包只支持宿主平台；Windows、Linux、macOS 的原生构建应在对应系统或 Build workflow 中执行。

## 功能

### Pi 原生会话

- 随包提供 Pi SDK 与 CLI，不依赖全局安装
- 通过 Pi 配置供应商与模型
- 支持流式消息、工具/思考时间线、队列与 Stop
- 支持持久历史、分支树、回退和 fork
- 在桌面 GUI 中呈现 Extension UI 权限审批
- GUI ↔ Pi TUI 交接，并以单写锁保护同一会话文件
- worker 崩溃恢复、空闲回收和干净退出

### 旧会话导入

AiClient 可以只读扫描本地 Claude 历史，并将选中的对话原子、去重地导入为独立 Pi
会话；源转写不会被修改。Codex 历史导入要等真实本地格式完成验证后再开放。
详见 [迁移到 Pi-only AiClient](docs/pi-only-migration.md)。

### Git Worktree 管理

- 创建、切换 worktree 与分支
- 按 worktree 隔离工作区状态
- 查看改动、暂存/取消暂存文件、浏览提交历史
- 在 VS Code、Cursor 或其他已配置工具中打开当前工作区

### 编辑器与终端

- 基于 Monaco 的多标签编辑器与文件树
- 基于 xterm.js + node-pty 的终端
- 嵌入终端区域的 Pi TUI
- 与内置 Ghostty 主题同步

## 架构

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

Pi SDK 不直接进入 Electron Main。Claude/Codex 相关代码只在只读迁移和来源展示确有需要时保留。

## 升级与发版文档

- [Pi-only 迁移指南](docs/pi-only-migration.md)
- [灰度与回退手册](docs/pi-only-rollout-rollback.md)
- [待发布说明](docs/release-notes/unreleased.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## 技术栈

- Electron 39、React 19、TypeScript 5.9
- Tailwind CSS 4
- Monaco Editor、xterm.js、node-pty
- simple-git、sqlite3
- Pi coding agent SDK

## 开发检查

重任务必须串行执行：

```bash
pnpm typecheck
pnpm typecheck:agent-host
pnpm lint
pnpm test
```

仓库约定和低资源主机测试规则见 `AGENTS.md`。

## 许可证

AiClient 使用 [MIT License](LICENSE)。第三方源码与运行时声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
