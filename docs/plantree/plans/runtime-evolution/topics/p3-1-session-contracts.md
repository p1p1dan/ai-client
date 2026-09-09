# P3-1 / P2-4 会话存储契约

2026-09-09 · execute-ready · [看板](../README.md) · [TODO](../TODO.md)

## 范围与格式

- 新会话采用当前 pin 的 pi-agent-core 0.84.4 JSONL v4：`kind: header, version: 4`；
  后续按单调 seq 追加 `kind: entry, lane: main`，Entry 保留 id/parentId/timestamp。
  自有 plugin-session 通过 runtimeHostIo 读写，不使用 SDK JsonlSessionRepo 代替自有存储。
- D6 的“兼容”需区分：Pi v4 是本批读写互通格式；PI-Desktop Rust transcript schema 1
  不是同一种 wire 格式，本批移植其完整消息与 checkpoint 分离的恢复语义。
  Pi v1/v2/v3 / PI-Desktop schema 1 导入及旧 tier 映射已由 P3-3 实现（[后续契约](p3-completion-contracts.md)）；非 v4 文件禁止原地追加，迁移到独立 v4 副本。
- 保留其他 Pi v4 lane/record/fact 行及其 seq；恢复 main 的 parent 链。含未完成 SDK operation 的文件明确拒绝自动续跑。
  P3-2 已补齐 branch/fork/rewind API，P3-5 已接 Main 索引 adapter；生产 worker/GUI 接线仍归 P4。

## 生命周期与错误边界

- createRuntime 的可选 session 配置明确 file、cwd 和 create/resume/import，不默认落盘；无 session 的离线探针行为不变。
- 创建使用 createOnly；同一文件以伴随锁文件独占写入，不自动抢占遗留锁。正常 dispose 先排空写入并释放锁，再关闭 HostIo。
- 同一 runtime 不接受重叠 run（共享 context/checkpoint 的并发会串会话）；另一个会话必须另建 runtime。
- 写入串行，成功后才更新内存；任一写入失败后本实例拒绝继续写，必须关闭并重新打开。
- 读取有明确字节上限，超过上限报错，不能以截断文件冒充完整会话。
- 完整行 JSON/seq/parent/id 损坏明确报错。仅未换行的非法 JSON 尾片可在持锁后原子恢复有效前缀；
  不跳过文件中段损坏。合法末行缺换行时补分隔符再追加。
- HostIo 当前没有 fsync 契约，因此“落盘成功”表示写入 Promise 完成，覆盖进程退出/重开；不承诺断电级 durability。

## 压缩与运行

- 保存原始 message_end 消息，内部容量提醒不写入用户 transcript；checkpoint 以独立 compaction Entry 追加。
- 在工具批次后的安全边界排空消息写入，压缩结果写入成功后才安装新请求上下文。
- run 成功返回前所有消息写入必须完成；磁盘失败不得返回 success。
- 新 run/resume 从最新 compaction 的 summary + retainedTail + 后续消息恢复；保留历史原始消息用于展示。
- ContextPlugin 恢复真实 compaction Entry 和摘要身份，使第二次压缩更新 previous-summary，不重复摘要摘要。
- 新输入先检查自身预算；历史过大则先压缩已完成历史，再拼接新输入，不把新任务误当作已完成消息丢弃。
- 未完成工具调用不自动重放；恢复时补给模型明确失败结果，要求重新判断，避免重复执行有副作用的操作。

## 验证与参考复用

- Pi v4 官方 codec/storage 源码作 wire 格式依据；用 SDK reader 打开本实现产物作互通验证。
- PI-Desktop `transcripts.rs` 的 compaction roundtrip 测试、session-context 源码与测试：适配移植恢复语义；
  保留消息、最新 checkpoint 优先、过滤 error/aborted assistant。
- pi-app incomplete-session-recovery 源码/测试：适配中断恢复边界；pix session-dir 源码及 session 测试：本批不采用整包 SDK 的目录自动推断，由 host 显式传入文件路径。
- 必测：两轮与重开续聊、两种压缩家族、重开后再次摘要、全历史完整、写失败、重复 writer/run、损坏行、官方 Pi 互读。
