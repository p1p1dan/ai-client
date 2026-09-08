# B1–B3 实现检查点

> 历史检查点。最终状态见 [完成记录](./completion.md)，下文的当时未完成项或阻塞已由后续证据替代。

日期：2026-09-08。工作区修改，未提交，任务尚未完整验收。

## 实现

- B1：设置页 Default 与打开共享技能目录入口，Main 建目录后打开，HOME 覆盖路径测试；bootstrap 追加默认技能安装提示，保留已有 append prompt。
- B2：仅借 `AGENTS.md` 文本，保留来源路径并放在已有 context files 前；同目录跳过、缺失跳过、去重、源内容保持不变。Main 既有 borrowFrom 传参无需扩展。
- B3：`bundledPlugins.mjs` 清单带 label/cost/defaultEnabled/legacySettingKey；Main 解析通用 `piOptInFeatures`，旧 `enablePiSubagents` 仍被读取；UI 遍历清单。新 key 与旧 key 加入 Main-owned keys，避免旧 renderer 快照覆盖。
- 权限 gate 和验证路径保持原逻辑，bootstrap 仅资源选项接缝已登记。

## 实际命令与结果

测试命令共同前缀：`NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/vitest run`；共同后缀：`--maxWorkers=1 --no-file-parallelism`。以下均独立串行批次：

1. `src/agent-host/__tests__/userResourcePaths.test.ts src/agent-host/__tests__/piAgentSessionBootstrap.test.ts`：2 files / 25 tests。
2. `src/main/ipc/__tests__/piResources.test.ts src/main/services/piModelConfig/__tests__/piWorkerEnv.test.ts src/renderer/components/settings/__tests__/piResourcesSettingsStatic.test.ts`：3 files / 39 tests（当时 IPC 为 14 tests）。
3. 补回归后的 `src/main/ipc/__tests__/piResources.test.ts src/main/ipc/__tests__/settingsMainOwnedKeys.test.ts src/main/services/piModelConfig/__tests__/optInFeatures.test.ts`：3 files / 25 tests。
4. `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit`：exit 0。
5. `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json`：exit 0，B3 清单修改后已再次通过。
6. `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/biome check .`：exit 0，1000 files，27 warnings / 17 infos。

## B4 发现与适配方向

已读 PI-Desktop `apps/desktop/electron/main/importers/{index,codex}.ts`：适配其三方法来源接口和单源失败隔离，不移植裸确定性 ID 或无界读取。
本仓 reader 处理的是 thread/resume JSON-RPC，fixtures/codex README 明确是报文夹具；不能当磁盘格式使用。
只读抽样本机 Codex rollout 的字段名（不输出正文），确认 session_meta、response_item、turn_context、event_msg、token_usage_record 等记录。
还存在 custom_tool_call/custom_tool_call_output 与 encrypted reasoning；转换不能只处理 function_call 或将加密字段写入上下文。

## 尚未验证

- B1 真实 utility worker / TUI PTY、GUI 点验。
- `.agents/subagents` 的产品支持结论与完整 B2 验收。
- B3 空清单环境变量注入臂、GUI 与更广回归。
- B4 尚未实现。
- 所有测试的完整小批门禁、生产构建；不将局部通过写成全量通过。

收尾静态检查：`git diff --check` 通过；无遗留 tsc/vitest/npm ci 进程。约 2.4 GiB 可用 RAM、7.3 GiB 可用磁盘。
