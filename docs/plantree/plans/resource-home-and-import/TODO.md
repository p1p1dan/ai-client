# TODO — 资源归位与会话导入（B 组）

> 勾选视图。任务身份与判据以 [roadmap.md](./roadmap.md) 为准。

## B1-a · 前置取证（半天，**最先做**）

- [x] `~/.agents/skills/<临时名>/SKILL.md` 放一个最小技能文档
- [x] 写探针进 `scripts/probes/`（参照 `scripts/run-t29c-worker-probe.mjs` 的形状）
- [x] 读 `resourceLoader.getSkills()`，确认技能在列并记下 `sourceInfo.scope`
- [x] 托管模式跑一次
- [x] 本地模式跑一次
- [x] TUI 真实 PTY 验证（自动探针采用 `PiTuiPty` packaged launch 形状）
- [x] **结论写进 evidence，无论正反**；若为负，同时修正设置页那句无据的承诺

## B1-b · 技能默认安装位（S，取证后）

- [x] 系统提示或内建命令给出明确的安装路径
- [x] `PiResourcesSettings.tsx` 文案「推荐」→「默认」
- [x] 「打开技能目录」按钮 + `piResources.ts` 的 IPC（比照 `openPromptTemplates`）
- [x] 臂：`HOME` 被覆盖时 `paths.sharedSkills` 跟着走
- [x] 臂：设置页文案静态断言
- [x] 门禁 + evidence

## B2 · 借读面对齐（S~M，B1-a 之后）

- [x] **先读** `userResourcePaths.ts` 模块头与 `piAgentSessionBootstrap.ts:427` 两段注释
- [x] `resolveBorrowedResourcePaths` 扩出 `~/.pi/agent/AGENTS.md` 一路
- [x] `resolveManagedPiWorkerEnv` 传参
- [x] 按 B1-a 结论决定要不要借 `~/.agents/subagents`
- [x] 臂：不存在的路径被丢弃
- [x] 臂：借用源 == 活动 agentDir 时返回空
- [x] 臂：全局指令存在/不存在两臂
- [x] **回归臂**：返回值里永远没有扩展路径字段
- [x] 门禁 + evidence

## B3 · 随包扩展表驱动（M，可并行）

- [x] `bundledPlugins.mjs` 的清单提成 Main 可读形态
- [x] `resolvePiSubagentsEnabled` → `resolveOptInFeatures()`
- [x] `src/shared/piModelConfig.ts` 给 `PiResourceSettings` **追加**字段（只追加不重排）
- [x] `PiResourcesSettings.tsx` 改为遍历清单渲染
- [x] 每个条目都有「它花你什么」的一句话（无成本说明不许进清单）
- [x] 臂：清单解析
- [x] 臂：**旧 key 迁移** —— `enablePiSubagents: true` 的存量用户不被静默关掉
- [x] 臂：未知 feature id 被忽略且不使读取失败
- [x] 臂：空清单 → 不下发 `PI_OPT_IN_EXTENSIONS_ENV`
- [x] 门禁 + evidence

## B4 · Codex 会话导入（M，可并行）

- [x] `LegacyImportSourceKind` 加 `'codex'`；`LEGACY_IMPORTER_VERSION` 升位
- [x] `{ source, scan(), convert() }` 三方法形状落于 Main `LegacyImportSources.ts`（README 已登记落点适配）
- [x] 复用 `codexHistoryReader.ts` / `codexItemMapper.ts`
- [x] **保留**我们的指纹机制，只把 source 加进 id 组成（不换成裸确定性 id）
- [x] 扫描扇出时单源抛错降级为空数组
- [x] 臂：用 `__tests__/fixtures/codex/` 的真实文件做夹具
- [x] 臂：幂等 —— 同一会话导两次不产生新会话
- [x] 臂：跨来源 id 不碰撞
- [x] 臂：codex 目录不可读时 claude-code 扫描结果仍完整
- [x] 门禁 + evidence

## 收尾

- [x] GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验
- [x] 四项全部 Done 后，在根注册表把本计划移入 Archived 并改写本 README 状态行
