# 决策 006：DSH 会话身份沿用桩文件，DSH 会话 id 取 `aiclient-<逻辑 id>`

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-1 方案 §4 R2 / §5 D2](../topics/p1-1-engine-cutover.md#5-需要拍板的决策点)。

## 规则

1. 索引行的 `runtimeIdentity` 指向一个我方私有的桩文件：`$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`。这个位置沿用 P0-3，`DSH_HOME` 的取值见[决策 008](008-private-dsh-home.md)。
2. 桩文件内容：`engine: 'dsh'`、`version`、`dshSessionId`、`logicalSessionId`、`cwd`、`createdAt`。写入要原子（先写临时文件再改名）。
3. DSH 会话 id 由我方给定，取 `aiclient-<逻辑 id>`，不用 DSH 进程内的计数 id。桩丢失时，可以从逻辑 id 反推出 DSH 会话。
4. 索引与事件里的 `agent` 写 `dsh`：`AGENT_WIRE_NAMES` 追加为 `['pi', 'dsh']`，这是 ABI，只能追加；新建、恢复、fork 一律写 `dsh`。`pi` 只在读旧行、导入和 TUI 时出现。界面显示名为 `DSH`。
5. 恢复时校验桩里的 `cwd`，与请求的工作区不一致就拒绝（`session_cwd_mismatch`）。DSH 会话的 cwd 写在 header 里，不能改。

## 取舍

- 不选「直接用 DSH 日志路径」：文件名随格式代际变化，而且首回合之前文件不存在。
- 不选「合成 URI（`dsh:<id>`）」：Main 里依赖文件路径语义的地方都要改，包括路径归一化、`stat`、只读回放、TUI、fork 清扫。
- 桩是可变指针：P1-4 如果用 DSH 种子子会话实现回退或重试，只改桩里的 `dshSessionId`，索引行和会话键都不动。
- 代价：多一个私有小文件，以及一次反查逻辑。

## 影响

- P1-1：bridge 写桩和读桩；`agentWire.ts`、WorkerManager 的 5 处 agent 写入、`commitResumed` / `commitPiLeaf`，以及相关静态守卫。
- P1-4：fork 子会话的 id 规则在 P1-4 定。建议由 Main 预先铸好新逻辑 id，随 `worker.fork` 一起传过去。

## 实施补记（2026-09-26，P1-1 `100ebcf1`）

- 额外的错误映射：桩文件缺失报 `dsh_session_missing`；桩不是 JSON，或者 `engine` 不是 `dsh`，报 `session_invalid`，渲染层落到「会话已损坏」卡片。
- 桩丢失的 DSH 行不做自动修复，直接报 `dsh_session_missing`。按逻辑 id 反查、重建桩的工具留给 P1-3 的日志清理与收尾。
