# Ledger: 文件管理重命名确认后文件消失（数据丢失级） (P-20260703-001)

## [2026-07-03T09:58:28] understand -> decide
- Satisfied: 根因锁定。主进程 `src/main/ipc/files.ts:606` FILE_LIST 返回 `path: join(dirPath, name)`，win32 下 `node:path.join` 产出反斜杠分隔符（如 `C:\repo\src\a.txt`）；渲染层建树（useFileTree.ts）全程不规范化分隔符。重命名链路 `FilePanel.tsx:675` 用 `path.substring(0, path.lastIndexOf('/'))` 求父目录，Windows 路径无 `/` → `lastIndexOf` 返回 -1 → `substring(0,-1)` 得空串 → `newPath='/newName'` → 主进程 `fs.rename` 把文件移到盘符根目录，表现为"文件消失"。同源潜伏点：拖拽移动 targetDir（FileTree.tsx:410/805/865）、缓存刷新键（useFileTree.ts:393，parentPath='' 使 invalidate 键失配）。
- Decision: 采用「局部分隔符无关」修法（KISS/never break userspace）——新增 `getParentPath` 分隔符无关工具（复用 `getPathBasename` 同款 `/[\\/]/` 语义），替换重命名+拖拽链路的父目录/basename 运算；不改 IPC 边界，对其他消费者零风险。范围含拖拽移动（同一数据丢失潜伏漏洞，一并修）。修 bug 先写复现测试（红）再转绿。（用户 gate 已确认两项选择）

## [2026-07-03T10:35:17] decide -> build
- Satisfied: spec_refs 已声明（common/testing.md 修 bug 先写复现测试+新公共接口配单测；common/error-handling.md 参数合法性由函数自身负责）。scope 已定：Windows 分隔符无关化文件管理路径运算。拆 4 个执行项 E-001~E-004。

## [2026-07-03T10:36:00] build -> check
- Satisfied: 全部执行项完成。E-001 新增 `getParentPath`（双 lastIndexOf 取 `/` 与 `\` 较大索引）+ `src/shared/utils/__tests__/path.test.ts` 9 例（含旧 `lastIndexOf('/')` 塌空的 bug 红证据）。E-002 修复重命名链路：`FilePanel.handleRename` 父目录（数据丢失根因）、`useFileTree.ts` 5 处 invalidate 失效键、`FileTree` basename 守卫改 `getPathBasename`。E-003 拖拽/粘贴全部 targetDir：handlePaste(410)、冲突粘贴(655)、drag onInternalDrop(805/865)、节点 drop 落点(1547/1608)。E-004 vitest 109/109 绿；biome 仅剩全仓库 CRLF format 债务（基线已存在），无 lint/organizeImports 问题。git diff 外科式 +33/-17（4 文件）。

## [2026-07-03] check -> done（用户验收）
- 迁移后复验：仓库迁至 D:\Projects\AiClientWorktree、worktree 已 repair 重连、分支 fix/recentBug 完整；在 D: 重跑 `src/shared/utils/__tests__/path.test.ts` 9/9 绿，坐实迁移后测试链路可用。
- 范围外同类残留（选中文件时新建/Ctrl+V 粘贴落到仓库根，FileTree.tsx:353/967）已拆分为独立提案 P-20260703-009（已建档，根因+站点+修复入口写入其 ledger），不阻塞本提案闭环。
- 用户在对话中明确批准「独立验收归档 P-001」，经 ai_relay 执行 accept --user-approved。
