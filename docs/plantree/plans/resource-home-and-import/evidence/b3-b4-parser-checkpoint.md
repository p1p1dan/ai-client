# B3 补验与 B4 rollout 解析层

> 历史检查点。最终状态见 [完成记录](./completion.md)，下文的当时未完成项或阻塞已由后续证据替代。

日期：2026-09-08。工作区未提交，B 组没有完成。

## 本轮实现与证据

B3 修正重复 generic 设置导致 Worker 无条件重启的问题；实际值不变时不保存、不重启。
保存一个开关保留其他存量偏好；空 registry 即使有旧 enablePiSubagents=true 也不下发扩展变量。

B4 新增 `CodexRollout.ts`，解析磁盘 session_meta/turn_context/response_item，
不重复读取镜像 event_msg。用户/助手文本进入对应条目；工具调用和结果仅 display；
reasoning summary 保留，加密部分省略并记诊断；损坏 JSON/缺元数据/超限拒绝。
共用工具脱敏从 Claude adapter 提取到 `legacyImportSanitization.ts`，原有行为通过回归。

真实本机 rollout 抽取并脱敏的夹具：`src/agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl`。
它与已有协议抓包明确分开；记录选择、字段保留和脱敏范围见 fixture README。

## 实际验证

测试共同前缀 `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/vitest run`，
共同后缀 `--maxWorkers=1 --no-file-parallelism`，串行执行。

- `src/main/ipc/__tests__/piResources.test.ts`：18 tests 通过。
- `src/main/services/piModelConfig/__tests__/piWorkerEnv.test.ts`：21 tests 通过。
  首次新增 spy 在 resetModules 前捕获旧 module 实例而失败；改为 reset 后动态 import，复测通过。
- `src/main/services/legacyImport/__tests__/CodexRollout.test.ts src/main/services/legacyImport/__tests__/ClaudeSourceAdapter.test.ts`：2 files / 11 tests 通过。
- `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit`：exit 0。
- 本轮 7 个修改源码/测试文件 `biome check`：通过，无修改、无诊断。
- `git diff --check`：通过。

## 下一步与未验证

解析层尚未接入 LegacyImportService，不声称用户现在可导入 Codex。
继续实现 bounded scanner、fingerprint source adapter、来源接口和 UI、原子发布与幂等回归。
还需复用已有 protocol reader 的可用映射能力；本次磁盘 parser 不假装直接适用 thread/resume 数据。
B1 真实 worker/TUI、B2 subagents 目录结论、累计 GUI、最终小批回归仍未完成。
