# P2-0 旧后端基线采集

计划与验收口径见 [plantree](../../docs/plantree/plans/runtime-evolution/topics/p2-0-cache-baseline.md)。
这是独立测试工具，使用现有 `bootstrapPiAgentSession` 和旧版 SDK；无需构建 Electron。

Node 24 下运行，`--sdk-host` 指向已安装依赖的 `src/agent-host` 目录：

```bash
read -rsp 'Test API key: ' P20_BASELINE_API_KEY
export P20_BASELINE_API_KEY
NODE_OPTIONS=--max-old-space-size=768 node scripts/runtime-baseline/run.mjs \
  --sdk-host /home/pi/code/ai-client/src/agent-host \
  --base-url https://maxapi.hanyue.xyz \
  --out docs/plantree/plans/runtime-evolution/evidence/p2-0/NEW_RUN_ID
unset P20_BASELINE_API_KEY
```

六场景按顺序串行执行；失败立即结束并留下 `validBaseline: false` 的证据。输出目录必须是
新目录，不能覆盖原有 run。`--case B01` 可单独诊断，该结果永远不会成为六场景完整基线。
工具执行限定为当前步骤定义的合成文件操作；权限扩展仍参与，测试桥只回答一次性批准。
凭据在模块初始化后从环境删除，通过内存传给 SDK，工具子进程不会继承测试密钥。

固定工作目录默认 `/tmp/aiclient-p2-0-work`，存在时拒绝启动，防止多个写入者。
运行结束在 `finally` 中清理此目录；若强制终止留下目录，先确认无进程占用、保留需要的失败
证据再清理。可以通过 `--work` 改路径，但该路径会进入系统提示，P2-6 对比必须使用同一路径。

独立验证：

```bash
node --test --test-concurrency=1 scripts/runtime-baseline/metrics.test.mjs
node scripts/runtime-baseline/verify.mjs docs/plantree/plans/runtime-evolution/evidence/p2-0/RUN_ID
```

网关不稳定时，可用 `--case B04` 等参数在新目录重跑独立场景。六场景齐备后收集：

```bash
node scripts/runtime-baseline/collect.mjs \
  docs/plantree/plans/runtime-evolution/evidence/p2-0 \
  docs/plantree/plans/runtime-evolution/evidence/p2-0/NEW_BASELINE_ID
```

收集器要求运行参数、采集器及旧后端源码哈希和实际依赖一致，并对来源 suite 中每个场景
与当前 suite 做深比较；suite 升版后仅未变场景可复用。按时间选取首次完整成功结果，保存
来源 manifest/suite、逐场景哈希和全部尝试索引，原样复制六份会话后自动调用 verifier。
因此不是把单个场景的失败轮删除后拼接成功轮，也不会挑选命中率最高的一次。

`verify.mjs` 从原生会话 JSONL、逐调用 usage 和执行 trace 重算比率，并核对 suite 哈希、
场景顺序、文件结果、压缩记录、resume 记录及每一步断言。它不访问 provider。

`suite.mjs` 的合成样本在 `suite.json` 展开存档。测试模型为 `claude-sonnet-5`，
`thinking=off`、输出上限 2048；模型窗口 200000 是固定测试配置，不是能力探测结果。
所有场景都关闭自动压缩，使用相同的压缩设置 `reserveTokens=4096`、`keepRecentTokens=1024`；
B05 显式调用真实 compact，再验证续聊。这样固定压缩时点和测试成本，不覆盖自动阈值触发。
P2-6 应复用相同 suite、模型、参数和工作路径。修改样本或参数须提升 suite 版本并重采基线。

`trace.jsonl` 保存普通会话调用的完整请求 body、系统提示、工具 schema、工具结果和 SDK 事件；`usage.jsonl`
只记每次 `turn_end` 和 compaction 摘要调用的原始 usage。请求 headers 和密钥不归档。
`manifest.json` 记录代码哈希、git 状态、实际依赖版本及参数。整个会话 JSONL 保留在 `sessions/`。
SDK 的压缩摘要路径不触发 `before_provider_request`，没有其原始 wire body；归档保留压缩前
消息、明确的 compact 指令、SDK 版本以及原生 compaction record/usage，可据此重建摘要输入。

比率用 token 总数加权，不能平均每轮百分比。compaction 单列，不混入既有 turn rollup 口径。
provider 缓存由网关管理，首次轮也计入，不能宣称冷缓存。没有可信定价时费用为未知；
SDK 原始 usage 中的零 cost 是测试模型的定价占位值，不代表免费。

注意使用 manifest 的**实际嵌套依赖版本**，不能用相邻目录的顶层 `pi-ai` 版本代替。
本机旧 SDK 加载的是 0.84.3，而 P0 新 runtime 为 0.84.4；P2-6 的处理要求见
[Q4](../../docs/plantree/plans/runtime-evolution/open-questions.md)。
