# CLAUDE.md

## 当前任务

**`main` 已是 DSH 主线（2026-10-14 合入并发布 `v1.1.0`）**。聊天引擎是 DeepSeek Harness 宿主（`src/dsh-host/`），所有会话共用一个宿主进程；1.0.x 线不再维护（决策 160）。**2026-10-20 发布 `v1.2.0`**：路线 B（Anthropic 协议的模型走 Claude Agent SDK 宿主 `src/claude-sdk-host/`，计划见 `docs/plantree/plans/claude-sdk-engine/`）与决策 189～206 一并合入 main；1.1.1-test.* 测试包流程结束。原开发分支 `feat/dsh-p0-probe` 已快进合入 main，此后直接在 main 上工作。推送与发版前需用户确认。

- **新会话先读** `docs/plantree/plans/dsh-rebase/implementation-status.md` 的 Current Phase 与 Next Target（当前状态与下一步：P1-14 发版后的收尾项），再看 `decision-review-4.md`（待审批决策）。`handoff-2026-09-28.md` 已过期，只有其中的工作规则仍可参考。
- **进度与计划**：`docs/plantree/plans/dsh-rebase/`，看 `implementation-status.md`（进度看板）、`roadmap.md`（任务 P1-0～P1-16）、`topics/`（各任务方案）、`decisions/`（005 起是自主决定、待用户审批）。
- **代码入口**：
  - `src/dsh-host/`：宿主 `host.ts`、bridge（`bridge/`，含 RPC 服务端 `bridgeRpcServer.ts` 与错误类型 `bridgeErrors.ts`），以及几个宿主行：`credentials/`、`permissions/`、`loopGuard/`、`encryptedRead/`、`fsSearch/`（决策 190：DSH 的 glob 与我方 grep）；工具脚本在 `tools/`，加密机上机包在 `tools/p0-4/`、`tools/p1-13b/`。
  - `src/main/services/agent-host/`（目录名沿用，未改）：`DshHostSupervisor`、`WorkerManager`、`DshCredentialBroker`、`createDshChatSlot`。
  - `src/shared/` 下的纯库：`dshModelPlan/`（模型计划）、`dshHistory/`（历史投影）、`legacyPiSession/`（pi 解码与迁移转换）、`permissions/`（权限）、`skills/`、`mcp/`、`subagentCatalogRoots.ts`（后三者从 runtime 搬来）、`dshPluginAllowlist.ts`（插件白名单审计）、`stderrRedaction.ts`（stderr 脱敏，从 `src/agent-host` 搬来）。
  - 自有 runtime（`src/runtime/`）与 `src/agent-host/` 已在 P1-12 删除；Codex 导入的映射搬到了 `src/main/services/legacyImport/`。
- **推送**：仓库是公开的。加密机的原始现场报告不入库，只放脱敏摘要；2026-09-28 已改写历史删掉曾经入库的那份，见 `docs/plantree/plans/dsh-rebase/evidence/history-rewrite-2026-09-28.md`。
- **2026-09-28 用户裁决**（决策 090）：默认跟随 DSH 的做法，不再为与 1.0.x 一致而移植；只做 Linux 与 Windows，macOS 暂不做。下一步从 `implementation-status.md` 的 Next Target 接着做。
- **本地验证**：两套 tsc（根 `pnpm typecheck`、宿主 `pnpm typecheck:dsh-host`，后者要先在 `src/dsh-host` 里 `npm ci`）；`src/dsh-host/tools/bridge-smoke.ts` 与 `bridge-record.ts --check`；真宿主集成测试 `AICLIENT_DSH_INTEGRATION=1`；模型只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`。
- **ARD**：`docs/plans/2026-09-08-runtime-evolution-ard.md`。2026-10-18 已回写：每条决策末尾有「现状」注记，现行架构见 §2.3，DSH 偏离见 §10，路线 B 见 §11。

## 工程规范（Agent 项目）

本项目遵循 **Agent Project Engineering Standard**（可验证 · 可回归 · 可对比 · 可被另一个 Agent 接管开发与测试）。
**动工前（新建或改造）先完整阅读**：`docs/agent-project-engineering.md`（16 条规范 + 最小落地清单）。

## 设计规范

UI 开发必须遵循 `docs/design-system.md`（**设计规范 v2，2026-10-21 重立**；旧规范归档在 `docs/archive/design-system-2026-10-21.md`，不再生效）。界面正在按 v2 做整体风格迁移，计划见 `docs/plantree/plans/ui-cohesion/README.md`。核心要点：

- **只认一个参考**：open-claude-ui（Claude 桌面版的界面规则），代码可以直接拿来改用
- **框只包一层**：有外框的东西里面不再套框，分区只用单向细线；助手正文不进容器
- **底色分四层**（侧栏 → 画布 → 卡片 → 输入框与浮层），配色是中性暖灰加陶土色，品牌色只用在少数几处
- **同类东西一种画法**：状态用 `StatusIcon`，停靠卡用 `DockCard`，错误用 `Alert`
- **组件优先**：优先使用 [@coss/ui](https://coss.com/ui) 组件，禁止手动实现已有组件；图标只用 Lucide
- **Token 分档**：颜色、字号、圆角、阴影、动效只用规范里的档位，不写任意值、不写死颜色
- **文本截断**：`min-w-0 flex-1 truncate` + 固定元素 `shrink-0`
- **Monaco**：本地 worker、主题同步终端配色

## 代码注释规范

- **语言**：所有代码注释必须使用英文
- **风格**：简洁明了，避免冗余描述

## 提交信息规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范，Release Notes 会根据前缀自动分类。

### 格式

```
<类型>[可选作用域]: <描述>
```

### 类型

| 类型 | 说明 | Release Notes 分类 |
|------|------|-------------------|
| `feat` | 新功能 | ✨ 新功能 |
| `fix` | 问题修复 | 🐛 问题修复 |
| `ci` | CI/CD 配置 | 🔨 CI/CD |
| `build` | 构建相关 | 🔨 CI/CD |
| `docs` | 文档更新 | - |
| `style` | 代码风格（不影响逻辑） | - |
| `refactor` | 重构（无功能变化） | - |
| `perf` | 性能优化 | - |
| `test` | 测试相关 | - |
| `chore` | 杂项维护 | - |

### 示例

```bash
feat: 添加暗色主题支持
feat(terminal): 支持自定义字体大小
fix: 修复窗口关闭时崩溃问题
fix(editor): 解决中文输入法兼容问题
ci: 优化 GitHub Actions 构建流程
chore: 版本更新至 0.1.8
```

### 注意事项

- 描述使用中文
- 作用域可选，用于标注影响范围（如 `terminal`、`editor`、`main` 等）
- 仅 `feat`、`fix`、`ci`、`build` 前缀的提交会出现在自动生成的 Release Notes 中
