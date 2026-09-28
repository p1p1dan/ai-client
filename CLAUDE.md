# CLAUDE.md

## 当前任务

**本分支 `feat/dsh-p0-probe`：DSH 二开（B 路线）P1「分支内整体替换为 DSH」**。聊天引擎已换成 DeepSeek Harness 宿主（`src/dsh-host/`），所有会话共用一个宿主进程；不做双引擎，测试完毕合入 main 即切换（决策 004）。main 只做 1.0.x 缺陷修复，本分支不推送、不发版，推送前需用户确认。

- **进度与计划**：`docs/plantree/plans/dsh-rebase/`，看 `implementation-status.md`（进度看板）、`roadmap.md`（任务 P1-0～P1-16）、`topics/`（各任务方案）、`decisions/`（005 起是自主决定、待用户审批）。
- **代码入口**：
  - `src/dsh-host/`：宿主、bridge，以及几个宿主行：`credentials/`、`permissions/`、`loopGuard/`；工具脚本在 `tools/`，加密机上机包在 `tools/p0-4/`、`tools/p1-13b/`。
  - `src/main/services/agent-host/`：`DshHostSupervisor`、`WorkerManager`、`DshCredentialBroker`。
  - `src/shared/` 下的纯库：`dshModelPlan/`（模型计划）、`dshHistory/`（历史投影）、`legacyPiSession/`（pi 解码与迁移转换）、`permissions/`（权限）、`skills/`、`mcp/`、`subagentCatalogRoots.ts`（后三者从 runtime 搬来）、`dshPluginAllowlist.ts`（插件白名单审计）。
  - `src/runtime/` 是待退役的自有引擎，P1-12 删除。
- **推送**：仓库是公开的，分支里有加密机现场报告，推送前先脱敏（2026-09-28 用户决定暂不推送）。
- **本地验证**：四套 tsc（根、`src/agent-host`、`src/runtime`、`src/dsh-host`）；`src/dsh-host/tools/bridge-smoke.ts` 与 `bridge-record.ts --check`；真宿主集成测试 `AICLIENT_DSH_INTEGRATION=1`；模型只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`。
- **ARD**：`docs/plans/2026-09-08-runtime-evolution-ard.md`（DSH 相关的偏离在 P1-14 回写）。

## 工程规范（Agent 项目）

本项目遵循 **Agent Project Engineering Standard**（可验证 · 可回归 · 可对比 · 可被另一个 Agent 接管开发与测试）。
**动工前（新建或改造）先完整阅读**：`docs/agent-project-engineering.md`（16 条规范 + 最小落地清单）。

## 设计规范

UI 开发必须遵循 `docs/design-system.md`，核心要点：

- **组件优先**：优先使用 [@coss/ui](https://coss.com/ui) 组件，禁止手动实现已有组件
- **颜色**：使用 CSS 变量（`text-primary`、`bg-accent`、`text-muted-foreground`）
- **Design Tokens**：圆角/阴影/字号/字重/动画时长遵循 `docs/design-system.md` 的 Token 分档（避免任意值）
- **尺寸**：Tab 栏 `h-9`、树节点 `h-7`、小按钮 `h-6`
- **间距**：紧凑 `gap-1`、标准 `gap-2`、缩进 `depth * 12 + 8px`
- **图标**：Lucide React，目录黄色、TS 蓝色、JS 黄色
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
