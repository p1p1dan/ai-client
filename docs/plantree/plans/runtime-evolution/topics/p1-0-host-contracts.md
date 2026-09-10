# P1-0 · IO/exec 出口契约草案

日期：2026-09-08 · 版本：draft v1 · 核对基点：`2eb11bfb`
Role: contract。节点当前状态与现场完成度统一见[核心任务树 P1-0](../README.md#p1)和[用户进度看板](../../../进度看板.md)。
权威：[ARD D11/D12](../../../../plans/2026-09-08-runtime-evolution-ard.md)；节点：[P1-0](../README.md)；交接：[P1](p1-handoff.md)。
阅读时机：实现 P1-0，或 P1/P2/P3 需要文件、子进程与 trace 接口时。

## 1. 目标与本轮 TODO

为 runtime 建立两个真正可调用的 Cordis service：`runtimeHostIo` 是插件的文件访问出口，
`runtimeExec` 是插件及 IO 回落的子进程出口。载体适配集中在这层；工具层保留自己的行为和权限策略。
本文的 TypeScript 只描述建议契约，不代表 `contracts.ts` 已有这些导出，也不新增 ARD 决策。

- [x] 核对 D11、现有 P0 调用点和本地参考源码/测试。
- [x] 起草类型、IO/exec 行为、生命周期及错误语义。
- [x] 列出 P0 迁移面、后续节点边界和确定性验收项。
- [x] 用户确认第 10 节建议；Q6 按 pipe + adapter 挂载点收口。
- 本文件只描述 IO/exec 契约、边界和验收方法；历史实现与现场证据见[核心任务树 P1](../README.md#p1)。

**已拍板约束**：生产 worker 只有 `bundled-node` / `electron-utility` 两种 carrier；
Windows 安装版缺少随包 Node 必须失败；worker RPC 仍由 WorkerTransport 负责；普通 stdout 必须排空。
**本次建议**：异步 IO、字节上限、一次性 exec 接口、stdio adapter 接入方式及独立冒烟的载体标记。
用户已确认这些建议作为 P1 实施口径；不代表已通过载体验收。

## 2. 配置与 service 边界

```ts
export const HOST_IO_SERVICE = 'runtimeHostIo';
export const EXEC_SERVICE = 'runtimeExec';

export type WorkerCarrier = 'bundled-node' | 'electron-utility';
export type RuntimeCarrier = WorkerCarrier | 'standalone-node';

export interface RuntimeNodeExecutable {
  path: string;
  source: 'bundled' | 'explicit' | 'current-process';
}

export type RuntimeExecPolicy =
  | { mode: 'pipe' }
  | { mode: 'host-adapter'; adapter: RuntimeExecAdapter };

export interface RuntimeHostConfig {
  carrier: RuntimeCarrier;
  node?: RuntimeNodeExecutable;
  tsdReadFallback: 'disabled' | 'configured-node';
  exec: RuntimeExecPolicy;
  childEnv: Readonly<Record<string, string>>;
  cleanupTimeoutMs: number;
}
```

- 配置由 bootstrap/worker 入口传入。插件不按 `process.platform` 自行选择 carrier，不访问 worker IPC。
  `standalone-node` **仅建议用于当前非 Electron 冒烟/CLI**，避免将本机 Node 冒烟误标为随包载体验收。
- `node.path` 必须是绝对路径。`bundled-node` 必须提供 `source: 'bundled'`；
  `current-process` 只允许 standalone 使用，不能把 Electron 的 `process.execPath` 当成 Node。
  入口负责按平台和打包状态选路径；出口验证配置和可用性，不重新搜索 PATH/nvm。
- `configured-node` 必须有 `node`，且是部署方明确选择用于 TSD 读取的进程；
  配置本身不能证明企业驱动已放行。默认关闭回落也必须探测 TSD，发现密文就明确报错。
- `childEnv` 是入口明确传入的子进程环境快照，与模型适配的凭据环境分开；
  exec 不隐式复制整个 `process.env`，不改变父进程环境。
- `cleanupTimeoutMs` 为正的有限毫秒数，约束取消后的清理等待；它与命令正常运行的 `timeoutMs` 分开。
  具体默认数值在实现配置中集中声明并写入版本戳，本文不散布多套隐式默认值。

两个 service 供受信的内部插件使用，**不构成文件系统沙箱**。权限插件负责授权，工具先完成
scope 校验/审批再调用出口；出口不提供 `permission: true` 一类绕过字段，也不弹审批 UI。
在 `contracts.ts` 的 Cordis `Context` 扩展中分别声明 `runtimeHostIo: RuntimeHostIoService`、
`runtimeExec: RuntimeExecService`；`RuntimeBootstrapOptions` 增加 `host` 配置，`RuntimeHandle` 暴露
`hostIo` / `exec` 两个接口实例，释放仍统一走 runtime 的 `dispose()`。

## 3. `runtimeHostIo`：文件契约

```ts
export type RuntimeFileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface RuntimeFileInfo {
  kind: RuntimeFileKind;
  size: number;
  mtimeMs: number;
}

export interface RuntimeReadOptions {
  maxBytes: number;
  overflow: 'error' | 'truncate';
  offset?: number;
  signal?: AbortSignal;
}

export interface RuntimeReadResult {
  bytes: Uint8Array;
  truncated: boolean;
  source: 'direct' | 'node-fallback';
}

export interface RuntimeWriteOptions {
  mode?: number;
  createOnly?: boolean;
}

export interface RuntimeHostIoService {
  readFile(path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult>;
  writeFile(path: string, bytes: Uint8Array, options?: RuntimeWriteOptions): Promise<void>;
  appendFile(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeFileInfo>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): AsyncIterable<{ name: string; kind: RuntimeFileKind }>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

**路径与大小。** 所有输入路径为宿主系统的绝对路径，不隐式使用 `process.cwd()`、展开 `~` 或改变大小写。
工具负责把用户相对路径解析到明确 cwd，并在授权时考虑 symlink；`realpath` 只用于已存在路径。
`stat` 默认跟随 symlink，`false` 返回链接本身；`size` 是当前载体看到的大小，不能当作 TSD 明文长度。
`readDirectory` 不递归，按底层顺序逐项返回；消费者提前退出时关闭目录句柄。

**读取。** `offset` 默认为 0，是返回明文的非负有限整数字节偏移；`maxBytes` 是正的有限整数。
服务最多保留 `maxBytes + 1` 个目标窗口字节判定溢出，按固定大小分块读取，不能先整文件入内存再截断。
`overflow: 'error'` 超限报 `io_limit`，适用于配置/完整 JSON；`truncate` 返回前 `maxBytes` 字节及标志，
适用于 Read 分页。偏移超过 EOF 返回空字节且不截断。文本解码、行号和对模型的截断提示由调用方负责。

**TSD 回落。** 无论 offset 是否为 0，先检查文件起始 `%TSD-Header-###%`；
正常读取的探测和目标窗口使用同一打开的文件，退出时关闭句柄。发现 TSD 后仅允许一次回落：
通过 `runtimeExec` 调用配置的 Node，运行固定读取 helper，以独立 argv 传路径、offset 和上限。
helper 必须先检查它读到的文件起始字节仍是否为 TSD，再从明文字节流跳过 offset，限制内存和输出；
不能只检查偏移后的结果，也不依赖密文文件的 stat 大小/随机偏移等于明文布局。
helper 读到的文件头仍是 TSD 视为失败，不能返回给模型，也不能继续换别的 Node 重试。
helper 的路径不得拼进脚本文本或 shell 命令；业务报错写 stderr，stdout 保持原始字节。

**写入。** `writeFile` 覆盖内容；`createOnly` 使用独占创建语义，文件已存在时报 `EEXIST`。
`appendFile` 对同一规范路径按提交顺序串行，避免 trace/JSONL 字节交错；这不提供跨进程写锁。
`mode` 作用于新建文件并受 umask 影响，不顺带 chmod 已有文件。每个写入 Promise 在写入/关闭完成后兑现，
不承诺 fsync 持久化或多文件事务。`rename` 沿用宿主同文件系统语义，跨文件系统错误不偷偷改成复制删除。
`unlink` 不递归删除目录。Edit 的匹配、路径锁和临时文件替换策略属于 P1-2，出口不重新实现这些策略。

**写后密文风险。** 本草案只定义读取回落；不自动把写入切到另一个进程，也不声称回落读取解决了写入兼容。
同载体 Write→Read 明文往返由 P1-8/P4-6 验证，worker→Main 的反向读取风险仍归 [Q5](../open-questions.md)。

## 4. `runtimeExec`：一次性命令契约

```ts
export interface RuntimeExecRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  overflow: 'truncate' | 'terminate';
  signal?: AbortSignal;
}

export interface RuntimeExecResult {
  exitCode: number | null;
  signal: string | null;
  termination: 'exit' | 'timeout' | 'aborted' | 'output-limit' | 'disposed';
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export interface RuntimeExecService {
  readonly mode: 'pipe' | 'host-adapter';
  readonly adapterId: string;
  run(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
}

export interface RuntimeExecAdapter {
  readonly id: string;
  run(request: RuntimeExecRequest, cleanupTimeoutMs: number): Promise<RuntimeExecResult>;
  dispose(cleanupTimeoutMs: number): Promise<void>;
}
```

**命令与环境。** `cwd` 必须为绝对路径；`command` 是绝对可执行路径或单独命令名，不接受含相对目录的路径。
普通命令名按合成后的 PATH 查找；读取 helper 始终使用 `node.path`。
出口不隐式启用 shell，bash 工具自行解析 shell 后传 `shellPath` 与 `['-lc', commandText]`。
`env` 在 `childEnv` 上覆盖，`undefined` 删除键，随后把已配置 Node 的目录放到 PATH 首位；
Windows 合并 `Path`/`PATH` 为一个键，避免大小写重复。此规则不阻止用户显式执行别的绝对路径，授权仍归权限层。

**stdio。** P1-0 建议先提供真实 `pipe` 实现，stdin 未提供时关闭/忽略，提供时写完关闭；
stdout、stderr 从启动起同时消费，不转发到 worker RPC，也不能让调用方不读取就堵塞。
`host-adapter` 是宿主替换 stdio 实现的挂载点，必须有实际实现和稳定 `id` 才能注册。
adapter 收到已合成环境的请求，履行相同的字节、时限、退出与清理语义，并通过同一组契约测试；
它不导入工具/权限插件，不反向注入 HostIo，不增加 WorkerSlot 或常驻 supervisor。
需要私有临时文件时，只能复用 host 实现目录内的底层文件驱动；上层仍只有 HostIo 一个文件出口。

**兼容限制。** 原生 PTY 会影响换行、stdout/stderr 分离，不能直接冒充上述无损字节 adapter。
本草案不预设文件重定向或 PTY 已可用；实际选择见 Q6。无适配实现时报 `exec_stdio_unsupported`，
不根据 `Bad file descriptor` 文本自动重跑命令，因为第一次可能已产生写入副作用。
pipe 单测通过只能证明该实现；不能据此签收加密机 bash。

**输出。** `maxOutputBytes` 为每次调用 stdout 与 stderr **合计保留**的正整数上限，
按收到数据的顺序保留每个流的前缀，不保证两个流之间的业务时间顺序。
`stdoutBytes` / `stderrBytes` 是出口实际消费的字节数；强制终止时不代表进程本来会产生的全部输出。
`truncate` 到上限后继续排空两个流但不再保留数据；`terminate` 超限触发清理，适用于读取 helper 等完整字节协议。
TSD helper 自身只输出至多 `maxBytes + 1` 字节，exec 为其设置匹配的 stdout 加有限 stderr 预算；
helper 非零退出/输出超限均不能被 HostIo 当作完整文件。长期 MCP 协议流不能采用静默截断。

**时限与返回。** `timeoutMs` 是正的有限整数，从受理请求开始计时，包括启动和 stdin 写入。
已取消的请求不得 spawn。进程的正常非零退出通过 `exitCode` 返回，不包装成启动失败；
终止原因采用第一次生效的终止事件，后续 abort/timeout 不重复清理。
子进程及受管理后代退出、stdout/stderr 排空/关闭、定时器/监听器清理后才结算 Promise。
根进程提前退出而后代仍持有 stdio 时仍受原 deadline 约束。
清理宽限用尽报 `exec_cleanup_failed`，保留已收集输出和终止原因，不能假报完成。

**进程清理。** adapter 必须管理本次命令的进程组/进程树，取消、超时和 dispose 都使用同一套清理路径。
POSIX 进程组与 Windows 进程树清理分别验证；单独断言 `child.kill()` 被调用不够。
刻意脱离宿主管理的进程不属于安全隔离保证；P1-0 不提供后台任务句柄。

**P5-3 边界。** 这里先提供 `run`。长期双向 MCP 进程在 P5-3 为同一 service 增加受管会话接口，
届时定义背压、stdin 生命周期、协议输出及 watchdog；现在不注册空 `spawn/openStdio` 方法。

## 5. 错误和释放语义

错误继续使用带 `code` 的 Error，保存底层 `cause`；不为每种错误建立一个类。
原生 IO 的 `ENOENT`、`EACCES`、`EEXIST` 等代码保留，上层按已有配置/工具错误模型解释。

| code / 结果 | 含义 | 处理原则 |
|---|---|---|
| `invalid_host_config` / `invalid_host_request` | 缺失载体配置、非绝对路径、非法上限或时限 | 有副作用之前拒绝 |
| `io_limit` | 要求完整内容的读取超限 | 不把部分 JSON 当完整内容 |
| `io_tsd_unavailable` | 命中 TSD 但未配置可用回落 | 明确失败，不返回密文 |
| `io_tsd_unreadable` | helper 失败或读回仍是 TSD | 一次回落后失败，保留底层原因 |
| `exec_spawn_failed` / `exec_stdio_unsupported` | 启动失败或没有所需 stdio 实现 | Promise 拒绝，不伪造退出码 |
| `termination: timeout/aborted/output-limit/disposed` | 已启动命令因明确原因结束 | 清理完成后返回收集到的结果 |
| `exec_cleanup_failed` | 期限内未完成清理 | Promise 拒绝，附部分结果 |
| `runtime_disposed` / `io_aborted` | 释放后新请求 / IO 读取取消 | 拒绝请求，不转成空文件 |

读取取消必须关闭句柄，并取消在跑的 helper；已经提交的写入不承诺取消或回滚。
Cordis dispose 先拒绝新业务请求并终止在跑的命令，等待已提交写入/trace flush，再释放 HostIo 和 exec。
dispose 可重复调用；启动到一半失败也清理已创建资源。清理失败必须可见，不能吞掉挂住的子进程。

## 6. 依赖图、trace 与 P0 迁移

依赖方向：`runtimeHostIo → runtimeExec`；`runtimeTrace / runtimeModel → runtimeHostIo`；
`runtimeLoop → runtimeTrace + runtimeModel`。Exec 不依赖 HostIo service 或 Trace，避免 TSD/stdio/日志循环。
两个出口的日志由调用者记录；底层错误不通过 trace 再写一次自己正在失败的文件。

建议实现目录 `src/runtime/host/`：封装文件驱动、exec、TSD helper 和两个 Cordis service，
其余生产 runtime 模块不直接导入 `node:fs`、`fs/promises`、`child_process`、`node-pty` 或等价启动封装。
Node 自身的模块加载不在应用 IO 范围；测试 fixture、隔离 spike 与冒烟启动器读取固定用例可显式豁免。
TSD helper 内部文件读取属于出口实现，必须随包可定位，不在工具层生成任意程序。

| 当前位置 | P1-0 建议迁移 | 验收重点 |
|---|---|---|
| [`contracts.ts`](../../../../../src/runtime/contracts.ts)、[`index.ts`](../../../../../src/runtime/index.ts) | 公布两个 service、HostConfig 和结果类型；保留 P0_SERVICES 历史清单，新增当前必需服务清单 | bootstrap 真实注册，未实现的后续服务继续留在 deferred |
| [`bootstrap.ts`](../../../../../src/runtime/bootstrap.ts) | 增 host 配置；先 exec/IO，再读版本信息/模型目录，后 trace/loop；反向释放 | 注入未满足或配置错误要失败并清理，不能返回半活 runtime |
| [`catalog.ts`](../../../../../src/runtime/plugins/model-adapter/catalog.ts)、[`model-adapter/index.ts`](../../../../../src/runtime/plugins/model-adapter/index.ts) | 文件读取改 async；解析保持纯函数；构造 service 前或可等待生命周期中完成加载 | 公共 `readPiCatalog` 签名变化同步入口/测试；模型、auth、header 解析语义保持 |
| [`trace.ts`](../../../../../src/runtime/trace.ts) | 版本读取走 IO；`TraceRun.finish` 建议改 `Promise<RunTrace>`，调用者 await；加入 `TraceService.flush()` | run 返回前本条落盘尝试完成；失败保留内存 trace 并暴露持久化错误，不改模型成功结果 |
| [`agent-loop/index.ts`](../../../../../src/runtime/plugins/agent-loop/index.ts) | 等待 async finish，更新相关测试 | P0 singleTurn 和模型请求内容保持；不提前引入工具循环 |
| [`smoke/runOnce.ts`](../../../../../src/runtime/smoke/runOnce.ts) | 明确 standalone 配置，并断言 trace carrier | 用例读取豁免不能扩散到生产插件 |

P0 当前把 models 读取错误统一映射为 missing，把 optional auth 的所有失败映射为空。
迁移时保留可选 auth 缺失/既有 JSON 解析规则，但 TSD 回落失败、大小超限和取消必须透出明确原因，
不能伪装成“尚未登录”。这是出口新增的错误语义，需在 P0 迁移测试中显式覆盖。

`TraceService.flush(): Promise<void>` 等待此前已提交写入，失败拒绝；
建议 `RunTrace.persistence_error?: { code: string; message: string }` 只记录落盘错误，供 smoke 断言，
不覆盖已有模型 `error`。先完成一次落盘尝试再返回 trace，调用方不用凭“文件存在”猜写入状态。

`version_stamp` 至少新增 `carrier`、`exec_stdio`、`exec_adapter`、`tsd_read_fallback` 和 `cleanup_timeout_ms`；
配置 Node 时另记 `node_source`、`node_exec_path`。不记录 `childEnv`、auth 内容或命令环境中的凭据。
载体标记来自入口，不能被通用 `extra` 字段覆盖；旧证据中的 stamp 不回填、不改写。
`RUNTIME_CONFIG_VERSION` 记录本次宿主契约修订，但不得声称系统提示词或缓存基线因此发生变化。

## 7. 参考复用与取舍

本节依据本地源码及测试的只读核对；没有复制外部实现，也没有运行参考仓测试。

| 来源 | 已读源码/测试 | 建议取舍 |
|---|---|---|
| 本仓 TSD 读取 | [`tsdSafeRead.ts`](../../../../../src/main/utils/tsdSafeRead.ts) | **适配移植**：保留头识别规则；替换 PATH 中的 `node`、整文件缓存和独立 exec，保持 Main 原调用点不动 |
| 本仓 Node 解析 | [`NodeRuntimeResolver.ts`](../../../../../src/main/services/agent-host/NodeRuntimeResolver.ts) 及其 `__tests__/NodeRuntimeResolver.test.ts` | **不采用**其广泛搜索/回落作为 Windows 安装版策略；入口传已选定路径，沿用“路径来源可追溯”的检查思路 |
| pi-app | `/tmp/aiclient-b-reference-pi-app/src/main/wsl/wsl-exec.ts`、`src/main/__tests__/wsl-exec.test.ts` | **适配移植**输出上限/失败收敛的测试思路；不搬 WSL 包装，单个 child.kill 不当作整树清理证明 |
| pix | `/home/pi/code/pix/apps/desktop/src/main/pi-tui-session.ts` 及同目录测试 | **不采用**TUI 会话 ownership 作为 exec 生命周期；保留其已有单 writer 产品边界，本切片不迁入 PTY |
| PI-Desktop | `/home/pi/code/PI-Desktop/packages/agent-runtime/src/host-client.ts` 及同目录测试 | **适配移植**退出时结算 pending/清除监听器的约束；**不采用**常驻 Rust host 与额外 RPC 拓扑 |

以上参考没有提供可直接移植的企业加密机 stdio adapter；Q6 的选择仍需本仓证据。

## 8. 验收草案

以下为实现后的验收要求，**本轮均未执行**；修改 Markdown 不需要运行模型或生产构建。

| 层级 | 用例 | 必须断言 |
|---|---|---|
| P1-0 普通 IO | 临时目录 write/read/append、独占创建、目录迭代提前退出、缺失路径 | 字节一致、append 顺序、EEXIST/ENOENT 保留、句柄释放 |
| P1-0 读取上限 | 精确上限、多 1 字节、偏移/EOF、多字节文本、大文件 | 完整读取与截断分支分开，内存不随整文件增长 |
| P1-0 TSD | 固定 TSD 头 + 注入 helper 成功/失败/仍密文、带空格与特殊字符路径 | 一次回落、argv 传参、明文字节偏移、输出有界、取消可清理；替身不冒充现场解密 |
| P1-0 exec | 本地 Node fixture 输出两流、stdin EOF、非零退出、缺失命令、输出洪水 | 字节/退出语义正确，双流同时排空，上限生效，不把溢出数据留在内存 |
| P1-0 清理 | 取消/超时/dispose、根进程先退出、产生普通后代的 fixture | 命令树终止、Promise 有界结算、重复终止不竞态；Windows 分支需 Windows runner |
| P1-0 入口 | 两个 service 存活、启动失败释放、PATH 键合并、Node 缺失 | 无隐式换 carrier/Node，adapter 无实现就失败，真实 stdout 不混进 worker RPC |
| P1-0 架构回归 | 生产代码导入边界 + P0 类型检查/既有测试/离线冒烟 | 现存 catalog/trace IO 经出口，stamp 真实，JSONL 可解析，落盘失败可见 |
| P1-8 / P4-6 | 真 bundled-node 与真 electron-utility 各跑工具用例 | Read 明文、bash stdout、写后读一致；仅修改 carrier 字符串的替身不计通过 |
| P3-5 / P6-3 | 加密机 worker 写→Main 读及现场完整清单 | Q5 单独核实；普通 CI 不能代签 |

本机实现验证继续按 AGENTS.md：先查资源，相关测试小批串行，Vitest 单 worker；不跑整套生产构建。
P1-0 完成只签其接口/出口和 P0 回归，P1-8、P4-6、P6-3 分别保留载体与现场状态。

## 9. 落地顺序与回退

1. 实现 `host/` 和两个 service 的独立契约测试，再注册到 bootstrap；新增 service 不用空实现占位。
2. 迁移 P0 catalog/trace，更新异步调用者和导出，验证 P0 既有行为；启用导入边界检查。
3. 更新配置 stamp、README 和 P1 交接；提供测试证据后才把 P1-0 标为实现完成。

这是一份文件归属建议，补充看板原先只提 `contracts.ts` 的范围；需在代码执行前确认，
避免 P2/P3 同时修改公共接口。P1-1 至 P1-8、P4-0 平台 worker 合并和 Main 读取改造不包含在本次实现切片。
若实现需要回退，整体撤回 host 注册与 P0 async 迁移，并同步撤回依赖它的新插件；不能只删除两个 service。
不改变现有 legacy 后端选择，不写用户会话迁移，不修改已采集的 P2-0 证据。

## 10. 评审重点与未决项

| 项目 | 草案建议 | 收口条件 |
|---|---|---|
| P0 改动范围 | 同次收敛 catalog/trace，采用 async IO/finish；不另建同步兼容 API | 接受第 6 节迁移面后才能按“全 runtime IO 收敛”实现 |
| 独立冒烟标记 | `standalone-node` 仅为测试/CLI 标记，产品 WorkerCarrier 仍是 D11 两种 | 认可不会把 standalone smoke 记成产品载体验收 |
| Q6 stdio 的首版实现范围 | 先交付 pipe + 可注入且受同契约约束的 adapter；禁止失败后自动重跑 | 确认 P1-0 是否需同时交付一种非 pipe 实现；若需要，先用隔离探针选择可行方案 |

Q6 在 [未决问题](../open-questions.md) 登记。后续若选择 PTY、文件重定向或额外 helper，
必须先补齐字节语义、资源上限与清理证据再改本契约；不要在工具实现中临时加入回落。

2026-09-08 用户授权：可以改代码，按上述建议收口草案，从 P1-0 开始执行 P1，维护 TODO。第 10 节三项采用建议方案；Q6 不要求首批交付非 pipe 实现。执行状态见 [P1 TODO](../TODO.md)。

## 实施回写（2026-09-08）

[本机代码及验证证据](../evidence/p1/README.md)已落地并随 `27ff2020` 提交。已增加保留进程树根身份的 Node runner，并通过 Linux 根命令先退出后的后代清理测试；Windows 分支仍待实测，P1-0 保持进行中。HostIo 为字节窗口，Read 工具为 1 起始行号；补充 `exec_stdio_failed` 错误。TSD 与 OS 沙箱/完整 shell 解析边界见证据文件。Q5 已按 D13 收口，不沿用草案中的待现场确认状态。
