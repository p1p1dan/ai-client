# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-13
**Commit:** ccc93c2
**Branch:** main

## OVERVIEW

AiClient 正在收敛为 Pi-only Git Worktree + AI coding desktop application。Electron 39 + React 19 + TypeScript 5.9 + Tailwind 4。当前 checkout 仍含 Claude/Codex legacy runtime，删除边界由 Pi migration T28/T35 管理。

## STRUCTURE

```
jyw-ai-client/
├── src/
│   ├── main/          # Electron 主进程 (IPC, Services, Menu)
│   ├── preload/       # Electron 预加载脚本 (Context Bridge)
│   ├── renderer/      # React 前端 (Components, Stores, Hooks)
│   └── shared/        # 跨进程共享类型定义
├── resources/         # 静态资源 (Ghostty themes 438个)
├── scripts/           # 构建脚本 (dev.js 进程管理)
├── docs/              # 设计文档 (design-system.md 关键)
└── build/             # Electron Builder 图标资源
```

## WHERE TO LOOK

| 任务 | 位置 | 备注 |
|------|------|------|
| IPC 通信 | `src/main/ipc/*.ts` | 17 个 handler 模块，按功能分离 |
| 状态管理 | `src/renderer/stores/*.ts` | Zustand stores，settings.ts 最大(37KB) |
| UI 组件 | `src/renderer/components/ui/` | @coss/ui 组件，52 个文件 |
| Git 操作 | `src/main/services/git/` | simple-git 封装 |
| 终端 | `src/main/services/terminal/` + `src/renderer/hooks/useXterm.ts` | node-pty + xterm.js |
| Pi runtime/worker | `src/main/services/agent-host/` + `src/agent-host/` | 过渡态仍含 singleton PiHost 与 Claude/Codex；目标是 Main WorkerManager + per-slot utilityProcess |
| 类型定义 | `src/shared/types/*.ts` | 15 个类型文件，ipc.ts 最重要 |
| 设计规范 | `docs/design-system.md` | **UI 开发必读** |

## MANDATORY REFERENCE REPOSITORIES（Pi 迁移必读）

Pi Backend Migration 不是从零设计。任何相关新会话、实现切片或复审必须先打开对应本地参考仓源码与测试，并明确“直接移植 / 适配移植 / 不采用”：

| 仓库 | 本地路径 | 上游 | 主要用途 |
|---|---|---|---|
| pi-app | `/home/ai/code/pi-app` | `https://github.com/justhil/pi-app` | **WorkerManager/WorkerSlot 主参考**；Pi-native history/resume、session tree、rewind/fork、时间线与竞态测试 |
| pix | `/home/ai/code/pix` | `https://github.com/num-scope/pix` | **Pi TUI/PTY/CLI packaging 主参考**；single-writer guard、stale output、资源提取与 terminal tests |

两者均为 MIT。大量直接复制须保留对应 copyright/license notice。详细文件地图与复用规则见 `docs/plantree/plans/pi-backend-migration/topics/reference-repositories.md`。目标边界以 D14/D15 为准：renderer → preload → Electron Main WorkerManager → bounded WorkerSlot → one utilityProcess/Pi AgentSession per slot；Pi SDK 不直接进 Main，不保留额外 singleton supervisor。参考实现冲突时，以本仓已拍板产品语义、安全边界和 Cycle 1/2 已验证行为为准。

## CONVENTIONS

### 工具链（非标准配置）
- **Biome** 替代 ESLint/Prettier — `biome.json` 配置
- **Tailwind 4** 新语法 — `@theme` 块定义在 `globals.css`
- **OKLCH 色彩空间** — 非传统 HEX/HSL

### 路径别名
```typescript
@/*      → src/renderer/*
@shared/* → src/shared/*
```

### 提交规范（CLAUDE.md 已定义）
- Conventional Commits 格式
- 描述用中文
- `feat|fix|ci|build` 才进 Release Notes

## ANTI-PATTERNS (禁止)

| 禁止 | 原因 |
|------|------|
| `as any` / `@ts-ignore` | Biome 规则明确禁用类型逃逸 |
| 手动实现 UI 组件 | 必须优先用 `@coss/ui`，见 `docs/design-system.md` |
| CDN 加载 Monaco worker | CSP 限制，必须本地 worker import |
| 直接修改 `globals.css` 主题 | 使用 Ghostty themes 同步机制 |

## UNIQUE STYLES

### UI 尺寸常量
```
Tab 栏:   h-9 (36px)
树节点:   h-7 (28px)
小按钮:   h-6 (24px)
缩进:     depth * 12 + 8px
```

### Flexbox 截断模式
```tsx
// 固定元素
<Icon className="h-4 w-4 shrink-0" />
// 可截断文本
<span className="min-w-0 flex-1 truncate">{text}</span>
```

### 图标颜色映射
- 目录: `text-yellow-500`
- TypeScript: `text-blue-500`
- JavaScript: `text-yellow-400`

## RESOURCE SAFETY（当前主机强制约束）

当前开发主机资源有限（约 3.3 GiB RAM，根分区约 30 GiB）。所有 Agent 必须把避免 OOM、Swap 抖动和磁盘耗尽作为硬性执行约束：

1. **重任务前先检查资源**：运行 `free -h`、`df -h . /tmp`，并确认没有遗留的 `vite`、`vitest`、`tsc`、`esbuild`、Electron Builder 或 Agent Host 构建进程。
2. **禁止并行运行重任务**：全量 Vitest、Agent Host 构建/打包、Electron 打包、全量 typecheck/lint 必须串行执行；不得放入并行 tool call，也不得同时启动多个重型子 Agent。
3. **测试必须小批次**：优先单文件或少量相关测试，并强制 `--maxWorkers=1 --no-file-parallelism`。不得在本机直接运行一次性全量 Vitest；全量门禁应拆成多个小批次，批次之间复查资源。
4. **本机禁止整套生产构建**：不得直接运行 `pnpm build` 或 `dist:prereq`。确需构建证据时，必须拆分 Main、Preload、Renderer/资产或 Agent Host 阶段，逐阶段执行、检查和清理；无法安全拆分时记录待由 CI/高资源主机验证，不能硬跑。
5. **构建限制 Node 堆**：获准执行的单阶段 Node 构建默认使用 `NODE_OPTIONS=--max-old-space-size=1536`；若该上限不足，必须停止并重新评估，不能直接无上限重跑。
6. **每个批次后复查并清理**：确认进程已退出，检查 RAM/Swap/磁盘；及时删除临时 probe、失败的临时打包目录和不再需要的大型产物，但不得删除需要验证或属于用户的文件。
7. **资源不足时不得硬跑**：可先执行静态检查、进一步拆分测试或记录待验证项；不能用并行或反复重试的方式把主机拖垮。

## COMMANDS

```bash
# 开发
pnpm dev              # electron-vite dev (自定义 scripts/dev.js 包装)

# 构建
pnpm build            # electron-vite build
pnpm build:mac        # 构建 macOS (签名+公证)
pnpm build:win        # 构建 Windows
pnpm build:linux      # 构建 Linux

# 质量检查
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check
pnpm lint:fix         # biome check --write
```

## NOTES

- **有自动化测试** — Vitest 覆盖 main/renderer/agent-host contracts 与纯逻辑；当前低资源主机必须小批串行运行
- **原生模块** — `node-pty`, `@parcel/watcher` 需 `postinstall` 编译
- **Settings Store 巨大** — `settings.ts` 37KB，修改前仔细阅读结构
- **Claude IDE Bridge** — `src/main/services/claude/ClaudeIdeBridge.ts` 是 MCP 集成核心
- **进程清理** — `scripts/dev.js` 处理 SIGINT/SIGTERM，确保 PTY 正确退出
