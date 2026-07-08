# Ledger: 默认设置调整:外观同步终端/字号14,通用树状/集成模式/列表 (P-20260703-011)

## [2026-07-03] 建档(pointer=understand)

来源:用户需求「外观同步终端/字号14,通用树状/集成模式/列表」。

**已调研现状**(src/renderer/stores/settings/index.ts `getInitialState` L106-112 + defaults.ts L29-31):
- `theme`: 当前 `'system'` → 目标 `'sync-terminal'`(line 76-77 已有实现,调 `isTerminalThemeDark` 同步 terminalTheme)。**需改动 ✓**
- `fontSize`: 当前 `14` → 目标 `14`。**已符合 ✓**
- `layoutMode`: 当前 `defaultLayoutMode='tree'` → 目标 `'tree'`(集成模式)。**已符合 ✓**
- `fileTreeDisplayMode`: 当前 `defaultFileTreeDisplayMode='current'`(仅当前仓库) → 目标 `'tree'`(树状展开所有)。**需改动 ✓**
- `repositoryListDisplayMode`: 当前 `defaultRepositoryListDisplayMode='list'` → 目标 `'list'`。**已符合 ✓**

**结论**:实际改动仅 2 项:
1. `index.ts:106` `theme: 'system'` → `theme: 'sync-terminal'`
2. `defaults.ts:30` `export const defaultFileTreeDisplayMode: FileTreeDisplayMode = 'current'` → `'tree'`

字号 14、layoutMode tree、repositoryList list 已是默认值,无需改动。

## [2026-07-03] understand -> decide
- Scope 确认:仅 2 处字面量(theme、fileTreeDisplayMode),零逻辑改动。spec_ref:common/testing.md。拆 E-001(改 2 字面量)、E-002(验证)。
- 设计:直接改 `getInitialState` 与 `defaults.ts` 的导出字面量,不动其他逻辑(applyInitialSettings / theme 切换逻辑已支持 `'sync-terminal'`)。

## [2026-07-03] decide -> build
- E-001 完成:index.ts:106 `theme: 'system'` → `'sync-terminal'`;defaults.ts:30 `defaultFileTreeDisplayMode: 'current'` → `'legacy'`(用户"树状"对应类型定义的 `'legacy'`,而非不存在的 `'tree'` 字面量)。2 文件 +2/-2。
- E-002 完成:`tsc --noEmit` 零新增类型错误(仅剩预存在的 AgentInstaller 债);diff 外科式(仅 2 行字面量)。

## [2026-07-03] build -> check
- 自检:完整性 2/2 items done。正确性 `theme: 'sync-terminal'`(line 76-77 已有实现)、`fileTreeDisplayMode: 'legacy'`(对应用户"树状"需求,展开所有文件树)。一致性 仅 2 行字面量,零逻辑改动。
- 待用户验收。

## [2026-07-03] check -> done(用户验收)
- 用户在对话中「验收」,经 ai_relay 执行 accept --user-approved。
- 知识沉淀:改默认值字面量无新增知识 → skip。
- 后续清理:P-008 为同一需求的重复 T1 skeleton(会话早期手动建、从未推进),本提案(P-011 T2)为实际执行版本 → P-008 标记 duplicate 归档。
