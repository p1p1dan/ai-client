# P1 审查补修与 P2 接线验证

日期：2026-09-08 · 基础 HEAD：`6c004794` · **本批实现与证据随本次提交归档（2026-09-09）；P2 整体仍在进行中**。
[看板](../../README.md) · [TODO](../../TODO.md) · [P1 历史证据](../p1/README.md)

## 本批结果

- 补修容量提醒：使用 Pi `createCustomMessage('context-budget', ...)`。内部保持 custom，
  `convertToLlm` 才映射为 provider user；真实用户保留逻辑无需根据文本标签猜测消息身份。
  覆盖“工具循环 → 提醒 → new_context → summary/fresh_window”的完整链路，原任务仍在保留尾中。
- 补修首轮预算：首次 `agent.prompt()` 前检查用户输入、systemPrompt 和工具定义的估算预算。
  当前每 run 尚无历史可压缩，因此超限返回 `context_too_large`、0 次 provider 调用、0 assistant turn，
  trace 保留完整输入。沿用现有估算与模型窗口阈值，不宣称是 provider 的精确 tokenizer。
- P2-1：`runtimePrompt` 已注册并纳入 bootstrap 存活断言，移出 DEFERRED_SERVICES。
  `run({ prompt })` 默认装配；`systemPrompt` 显式值（包括空串）完整覆盖装配，供固定探针使用。
  base、工具贡献、项目指令、D14 两轴按原固定槽位排序；仅 skills 仍 deferred（P5）。
  trace 记录 assembled/override、槽位字节数和 staticPrefixBytes；配置版本改为 `runtime_p2_prompt_v1`。
- P2-2：InstructionSource 通过 HostIo 有界读取；UTF-8 跨字符截断不产生替代字符。
  托管 agent-dir/AGENTS.md 自动加入，借用全局文件由 `prompt.globals` 显式提供；不自行探测用户 HOME。
  项目根默认 tools.cwd，可由 prompt.root 指定；run.targetPath 指定目标文件的 root→leaf 链。
  每 run 重读，保留优先级、32 KiB 共享预算及 realpath 越界跳过。缺失/权限错误可跳过，
  TSD/生命周期等 HostIo 错误必须上抛，避免把不可解密的指令当成“没有文件”。

## 验证

所有 Vitest 批次均使用 `NODE_OPTIONS=--max-old-space-size=768` 和
`--maxWorkers=1 --no-file-parallelism`，依次执行，批次间检查资源。

| 检查 | 结果 | 日志 |
|---|---|---|
| 压缩/预算/工具配对/前缀度量 | 4 文件 52 项通过 | [context-tests.txt](context-tests.txt) |
| 指令链/装配/服务集成 | 3 文件 40 项通过 | [prompt-tests.txt](prompt-tests.txt) |
| Agent loop/bootstrap/catalog/契约 | 4 文件 26 项通过 | [runtime-tests.txt](runtime-tests.txt) |
| HostIo/边界/工具/Bash 策略 | 4 文件 77 项通过 | [host-tools-tests.txt](host-tools-tests.txt) |
| native runtime 总计 | **15 文件 195 项通过**；上述批次无重复文件 | 本批包含 4 条新增压缩/首轮回归、8 条服务集成回归；移除已实现服务/槽位的 deferred 参数化断言 |
| runtime 类型检查 | 通过，堆上限 768 MiB | `node node_modules/typescript/bin/tsc -p src/runtime/tsconfig.json --noEmit`，exit 0 |
| 修改 TypeScript 文件 Biome | 通过 | `biome check`，14 文件 |
| P0 离线冒烟 | 6 项断言通过 | [offline-smoke.txt](offline-smoke.txt) |
| standalone Node 工具探针 | Read/Edit/bash/Glob/Grep/trace 通过 | [standalone-tools.json](standalone-tools.json)；不等同 Windows 随包 Node |

源文件与测试哈希见 [sources.json](sources.json)，对应测试时的工作区快照，已核对与本次提交的源码一致；旧 P1 sources.json 保持历史快照。
只使用 fauxProvider，不消耗线上模型，也不从这些结果推导真实缓存命中率。

## 参考复用判定

- **适配移植**：PI-Desktop `packages/agent-runtime/src/runtime.ts` 的 prompt 首轮边界、
  `project-instructions.ts`/`project-instructions.test.ts`、`mode-prompts.ts`/`mode-prompts.test.ts`。
  通过 HostIo 取代裸 fs；不采用其 systemPrompt 尾部提醒，以维持 D9 前缀；不移植本产品未提供的 SubmitPlan/Goal 工具文案。
- **直接使用 SDK**：pi-agent-core 0.84.4 的 createCustomMessage/convertToLlm 和既有压缩预算估算，
  无另造消息协议。P2-0 的 0.84.3 旧基线按 D12 保留。
- **本切片不采用**：pi-app 的 shared/session-context-preview 源码及测试属于历史展示；
  pix 的 agent-runtime/src/index.ts 与 session-parity 测试仍依赖完整 SDK resource loader。
  本批只做自有 prompt/context，不引入历史展示或整包加载器；会话兼容由 P3 处理。

## 仍待完成

1. **P3-1 → P2-4**：JSONL 存储就绪后写入 compaction record，验证跨 run/resume。
   当前 checkpoint 仍只在一个 run 内，不能称为持久化完成。
2. **P3/P4 → P2-5/P2-6**：新后端跑 P2-0 同套会话，对比压缩效果与 provider 原始缓存指标，
   `cacheRead / (input + cacheRead)` 不低于 **95.01%**。本批未执行，不修改旧基线。
3. **P4 接线与现场**：worker 传递已有资源解析产生的 borrowed globals、目标文件路径；
   Windows bundled-node、加密机、GUI/真实项目策略验证仍归 P4-6/P6-3。本批未运行远端 CI 或产品打包。

下一代码节点为 **P3-1 会话存储及兼容契约**。
