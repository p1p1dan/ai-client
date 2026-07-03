# Ledger: 选中文件时新建/粘贴落到仓库根(getCreateTargetPath 与 Ctrl+V 未用分隔符无关父目录) (P-20260703-009)

## 2026-07-03 建档(pointer=understand)

来源:P-20260703-001 验收时发现的范围外同类残留,拆分独立提案(P-001 scope 明确只覆盖 rename/drag/paste-move,不含 create 与 paste 落点计算)。

**根因(与 P-001 同类):** `path.substring(0, path.lastIndexOf('/')) || rootPath` 在 Windows 反斜杠路径下,`lastIndexOf('/')` 返回 -1 → `substring(0, 0)` = `''` → 回退到 `rootPath`。因此选中一个文件时,新建文件/文件夹、以及 Ctrl+V 粘贴的落点被塌到仓库根,而非该文件所在目录。属于文件放错位置(非删除),但违反用户预期。

**残留站点(2 处):**
- `src/renderer/components/files/FileTree.tsx:353` — `getCreateTargetPath()`,工具栏/快捷键新建文件与目录的目标路径(用于 :1129/:1140)。
- `src/renderer/components/files/FileTree.tsx:967` — Ctrl+V 粘贴选中文件时的 `targetPath` 计算。

**修复入口:** 两处改用 P-001 已落库并测试的分隔符无关工具 `getParentPath(path) || rootPath`(该文件已 import 并在 410/655/805/865 使用)。`getParentPath` 无父段时返回 `''`,故保留 `|| rootPath` 兜底语义不变。

**验证约定:** 依 common/testing.md,`getParentPath` 边界已由 path.test.ts 覆盖;本提案 build 时补一个针对反斜杠路径下 create/paste 落点的复现证据(红→绿),避免回归。

## [2026-07-03] understand -> decide
- Scope 已定:FileTree.tsx `getCreateTargetPath`(:353)与 Ctrl+V 粘贴目标(:967)由裸 `substring(0,lastIndexOf('/'))||rootPath` 改为 `getParentPath()||rootPath`。spec_ref:common/testing.md。拆 E-001(改两站点)、E-002(验证)。
- **决策修正(相对 understand 的验证约定):** 不新增组件级复现测试。理由(KISS/外科式 + 与 P-001 一致):本次是把 P-001 已测的 `getParentPath` 外科式套用到剩余 2 站点,与 410/655/805/865 同款;根因(反斜杠 `lastIndexOf('/')` 塌空)的红→绿证据已在 `path.test.ts` 沉淀。为一处表达式复用做组件渲染测试/抽取纯函数属过度设计。残留局限:call-site 若被改回裸 substring,util 测试无法直接捕获——此点在 check 向用户显式披露,如需更强保护可另起抽取+测试的后续项。

## [2026-07-03] decide -> build
- E-001 完成:两处外科式替换。FileTree.tsx:353 `getCreateTargetPath` → `return getParentPath(selectedNode.path) || rootPath;`;:967 Ctrl+V 粘贴目标 → `getParentPath(selectedNode.path) || rootPath || ''`。git diff +2/-2(1 文件),grep 确认 FileTree.tsx 已无 `lastIndexOf('/')` 塌空模式。
- E-002 完成:`path.test.ts` 9/9 绿(getParentPath 未变,回归锚点仍稳);`tsc --noEmit` 对 FileTree.tsx 零类型错误(getParentPath 返回 string,`|| rootPath` 语义与类型均正确)。仅剩 2 个 tsc 报错在 `src/main/services/cli/__tests__/AgentInstaller.test.ts`(unused `@ts-expect-error`),属预存在基线、与本改动无关(未触碰该文件)。

## [2026-07-03] build -> check
- 自检:完整性 E-001/E-002 均 done;正确性 两站点均按 P-001 同款 `getParentPath()||rootPath` 修复,消除反斜杠塌空;一致性 符合 common/testing.md(根因红→绿证据已在 path.test.ts)、外科式(仅 +2/-2)。
- 已披露局限:未加组件级测试,call-site 回退风险靠 util 测试 + review 兜底(见 decide 决策修正)。
- 待用户验收。

## [2026-07-03] check -> done（用户验收）
- 用户在对话中明确「验收」,经 ai_relay 执行 accept --user-approved。
- 知识沉淀:同类根因(Windows 反斜杠 `lastIndexOf('/')` 塌空)已在 P-001 归档时写入 `.vflow/knowledge/jyw-ai-client.md`,本提案无新增知识 → knowledge skip。
- 文件管理「落到盘符根」数据错位类(rename/drag/paste-move by P-001 + create/paste-target by P-009)全部封闭。
