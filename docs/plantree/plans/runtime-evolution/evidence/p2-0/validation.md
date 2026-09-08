# P2-0 验收与交接

日期：2026-09-08 · 状态：P2-0 完成，尚未提交

正式产物：[基线报告](baseline-20260908/report.md) · [机器汇总](baseline-20260908/summary.json) ·
[原始数据复核结果](baseline-20260908/verification.json) · [版本与来源](baseline-20260908/manifest.json)
· [采集与复核工具源码快照](baseline-20260908/tooling-source.tar.gz)（采集器哈希与 manifest 一致）

- 六个独立固定会话已真实执行成功，普通模型调用 28 次；另有一次真实压缩摘要调用。
- 普通调用累计 input=9599、cacheRead=182929、cacheWrite=79406；
  `182929 / (9599 + 182929) = 0.9501423169616887`，展示为 **95.01%**。
- B05 原生 compaction record 存在，SDK 上下文统计 16104 → 3909，压缩后两轮事实核验成功。
- B06 dispose 后由 `SessionManager.open` 重建，session id/file 和消息快照一致，
  两轮续聊成功；原始 JSONL 与 usage 逐条对应，恢复历史没有重复累计。
- B04 原始工具结果明确报告按 bytes 截断，输出 51136 bytes；第二次按 offset 读取确实包含
  `TAIL_MARKER=AMBER`，不是仅靠提示词中的“截断”字样判定通过。
- 选取原则为输入及运行配置相同的逐场景首次成功。共保留 14 次场景尝试，其中 4 次失败：
  edit 样本参数一次、压缩材料布局一次、连接错误两次。失败不并入 token 比率，全部保留在
  原始 run 与 `summary.attempts`。suite v3 的六场景均有逐字一致的来源 suite 证明。

验证命令（均已通过）：

```bash
node --test --test-concurrency=1 scripts/runtime-baseline/metrics.test.mjs
node scripts/runtime-baseline/collect.mjs docs/plantree/plans/runtime-evolution/evidence/p2-0 docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908
node scripts/runtime-baseline/verify.mjs docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908
biome check scripts/runtime-baseline
git diff --check
```

collect 的目标目录必须新建；上面记录的是已执行命令，重新收集时换一个输出目录。
单测 5/5；另外执行了 Markdown 目标检查、199 份文本产物的实际密钥与密钥形状扫描。
未把凭据放入仓库、auth.json 或请求 headers 归档；费用因无可信单价而标记未知。

所有在线会话串行，默认固定临时工作目录已清理。结束资源快照：available RAM 约 2.3 GiB、
Swap 428 MiB、根分区余量 6.5 GiB；采集进程已退出。未执行 Electron 生产构建。

本轮变更归属为 `scripts/runtime-baseline/`、P2-0 文档与证据、plantree 入口及 Q4；
`src/runtime/`、根依赖/锁文件、CI 与其他既有改动属于并行任务，本轮未修改它们。

P2-6 前的明确限制：

1. 按 [Q4](../../open-questions.md)处理旧 SDK 实际 Pi 两包 0.84.3 与新 runtime 0.84.4 的差异；
   不能把协议包升级影响直接归因给新 runtime。
2. 复用最终 suite、模型、参数和固定工作路径。当前关闭自动压缩，B05 使用固定小保留窗口的
   手工压缩；不构成默认参数/自动阈值验收。
3. 这是指定网关与模型的一组成功场景基线，不保证冷缓存，不是所有 provider 的普遍水平。
   后续对比同时报告失败率与工具序列，不能只比较命中率。
4. SDK 摘要调用不触发请求 body 观察钩子；其压缩前输入、指令、原生 record 和 usage 已保留，
   没有宣称归档其原始 wire body。普通模型调用的请求 body 都可从 trace 读取。
