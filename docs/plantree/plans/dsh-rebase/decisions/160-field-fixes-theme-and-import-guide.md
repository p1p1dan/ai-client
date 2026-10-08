# 决策 160：1.0.4 现场两个「重启后又回来」的缺陷——主题「跟随系统」被改回浅色、导入引导每次都弹

日期：2026-10-08。**状态：第 1 节是用户裁决；第 3 节的实现取舍是自主决定，待用户审批。**

来源：一位测试者在 1.0.4（加密机）上反馈：①每次打开都要重新设置外观；②已经导入过 Claude Code / Codex 历史对话，每次打开还问要不要导入。用户确认 `%USERPROFILE%\.pilab\PiLabAi\settings.json` 用记事本打开是正常 JSON。

## 1 用户裁决（2026-10-08）

1. 这批修复**只放进 DSH 分支 `feat/dsh-p0-probe`**，不在 main 上发 1.0.5。
2. DSH 分支测试完毕后，直接推 DSH 分支作为主线。

调查与修复先在基于 `origin/main`（1.0.4，`3140db5c`）的本地 worktree `fix-1.0.x-persist`（分支 `fix/1.0.x-settings-import`，未提交，移植后按用户要求连同分支删除）里做，再原样移植到本分支；`migration.ts` 一处因本分支删了 `presentationMode` 行而手工合入，其余文件补丁直接应用。

## 2 根因（均为代码缺陷，与设备无关，有复现测试）

1. **主题「跟随系统」每次启动被改回「浅色」**：`src/renderer/stores/settings/migration.ts` 里 `persisted.theme === 'system' ? 'light' : persisted.theme`。来源 `4019fedf`（07-30），本意是把旧的未选默认值一次性迁到新默认 light，但它在 persist 的 `merge` 里，每次 hydrate 都跑，也没有「已迁移」标记。用户显式选的「跟随系统」下次启动在内存里变成 light，之后任何一次保存都把 light 写回磁盘。1.0.1～1.0.4 与本分支都有。外观页其余字段（字体、背景 10 个字段、light / dark / sync-terminal）重启往返正常。
2. **导入引导每次都弹**：`AgentMigrationPrompt.tsx` 的 `hasLegacyConversations` 与弹窗本体都只看 `projects.length > 0`，完全不看导入状态；`listProjects` 不读 manifest，`LegacyImportProject` 上也没有导入信息。「已询问」标记只有「不再询问」和 Pi 复制成功会写，而 Pi 复制被 `PI_MIGRATION_DISABLED` 屏蔽，所以只要本机有历史就一直弹。manifest 本身落盘与读回正常；TSD 对判定无影响（判定只用 manifest 记录与来自文件名的会话 id）。

已排除：persist `version` 冲突（两条线都是 0）、`session-state.json` 快照覆盖（只写不读）、旧版迁移重跑（有标记门控）、退出流程（正常退出走 `before-quit` 落盘；只有异常退出丢最后 500 ms）。

## 3 改动与自主决定（待审批）

1. **主题：删掉这条迁移，不改成带标记的一次性迁移。** 07-30 以后磁盘上的 'system' 几乎只可能是用户显式选的；加标记的话已受影响的用户升级后还会再被重置一次。代价：极老的、从没写过设置的安装保留旧默认 'system'。替代方案：state 里加标记；或升 persist `version` 写 migrate（版本不一致时 zustand 会丢弃整份设置，风险更高）。
2. **非法 theme 值回落默认（light）**，避免 `applyAppTheme` 拿不到明暗结论。
3. **导入引导规则：导入过任意一条就不再弹**，而不是「全部导入才停」——用户会有选择地导入，还在用 Claude Code 时新会话会不断出现，后者永远不停。不写永久「已询问」标记（与 Pi 迁移共用）；点「导入对话」也不算已处理，保持「暂不」语义。
4. **计数放在 Main**：`listProjects` 从 manifest 按「源会话 id 去重」统计每个项目已完成的导入（`importedSessionCount`，可选字段，旧 Main 没有时等同旧行为）；manifest 读失败计 0，不隐藏项目。判定是渲染层纯函数 `legacyGuideWanted`。
5. **诊断日志（只记形状，不记内容与路径）**：
   - 设置写入失败按文件记 `code` / `syscall` 与连续失败次数，恢复后记一行；以前被 `atomicWriteSettings` 静默吞掉，且缓存已先更新，看起来像保存成功。
   - 每次启动记一行 settings.json 摘要（`outcome` / `bytes` / 首字节类别 brace·bom·tsd-header·empty·other / `renderer-state` / `persist-version` / `legacy-marker`），放在 `registerSettingsHandlers`（第一次读文件早于 `initLogger`）。
   - 渲染层 hydrate 失败记一行 `console.error`，只记错误名（JSON SyntaxError 的 message 会带出文件片段）。
   - `[legacy-import] Listed N project(s): S source session(s), I with a completed import, manifest=ok|unavailable.`
6. **读 settings.json 时容忍 UTF-8 BOM**：只影响原先整份解析失败（全部设置变默认）的文件。
7. **改名失败只加诊断，不加重试或回退**：未经现场确认，同步重试会阻塞主线程。日志确认 `syscall=rename` + EPERM/EBUSY/EACCES 后再加 win32 有限重试。
8. **刻意没动**：`writeSharedSettings`「先写缓存再写盘」的顺序；hydrate 失败时不禁止写盘。两者都是行为改动。
9. TSD 魔数在 `SharedSessionState.ts` 本地定义一份，不导入 `tsdSafeRead`（后者在模块顶层 `promisify(execFile)`，部分 mock 了 `child_process` 的测试会出错）。

## 4 验证

- 1.0.x worktree（代理）：设置 store 12 例、诊断与 Main 私有键 10 例、`LegacyImportService` 28 例、legacyImport 与设置组件 295 例、Static / Scan / Wiring 605 例、shared 257 例、`pnpm typecheck` 与 `typecheck:agent-host`、lint；编排者复跑新增与改动的 5 个文件 63 例。
- 本分支（编排者移植后，代码提交 `c373d02d`）：设置、诊断、导入相关 10 个文件 92 例；Static / Scan / Wiring + shared 104 个文件 1181 例；根 `pnpm typecheck`；改动文件 biome。

## 5 测试者复测

- 选「跟随系统」重启仍是「跟随系统」；再试「深色」。若非「跟随系统」的选择仍丢，在日志目录 `aiclient-YYYY-MM-DD.log` 搜 `[settings] settings.json at startup:`（正常为 `outcome=ok head=brace renderer-state=present persist-version=0 legacy-marker=present`）、`[settings] Failed to save`、`[settings] Settings rehydrate failed`；看同目录有没有残留 `settings.json.tmp`。
- 导入过任意一条后启动不再弹；日志搜 `[legacy-import] Listed`，I>0 就不弹。

## 6 遗留（未修）

- 1.0.x 的 `matchesImportSessionFileName` 不认本分支的 `.dsh.json` 导入记录，同机两版交替使用时会忽略并在下次写 manifest 时丢掉这些记录。DSH 成为主线后 1.0.x 不再发版，影响限于交替使用期间。
- `resolveHome()` 优先 `HOME` 再 `USERPROFILE`；设置了 `HOME` 的 Windows 上应用实际读写的根目录不在 `%USERPROFILE%\.pilab`，main.log 的 `Shared state paths` 行可确认。
