> D47 规格 S0 spike E4（2026-08-15）。回答 open-q O2 / 调查报告 `02-codex-side-seams.md` 风险清单 #7 的
> [未证实] 项：`codex app-server`（JSON-RPC，非 `codex exec`）在 `requires_openai_auth=false` +
> `env_key` 配置好、但对应环境变量缺失时，报错发生在哪一帧、精确形状是什么。
> 只做实验，**未改动 `src/` 下任何产品代码**。

## 结论（≤10 行）

1. `initialize` 成功——app-server 初始化不检查凭据，返回 `codexHome`/`userAgent` 等信息。
2. `thread/start` 成功——回显完整 posture（`approvalPolicy`/`sandbox`/`modelProvider` 等），同样不检查凭据。
3. `turn/start` 这个 **JSON-RPC 请求本身也成功应答**（`result.turn.status:"inProgress"`）；缺变量不会让这个请求返回 JSON-RPC error。
4. 报错出现在 `turn/start` 应答之后的异步通知序列里：`item/started`→`item/completed`（回显用户消息）→`thread/status/changed{status.type:"systemError"}`→**`error` 通知**（无 `id`，`method:"error"`）→`turn/completed`（`turn.status:"failed"`）。
5. `error` 通知精确形状：`params.error = {message:"Missing environment variable: \`AICLIENT_CODEX_API_KEY\`.", codexErrorInfo:"other", additionalDetails:null}`，外层 `{willRetry:false, threadId, turnId}`。`codexErrorInfo` 是字符串字面量 `"other"`，不是结构化对象——协议未把"缺 env var"细分成独立错误码。
6. `turn/completed.params.turn.error` 与上条 `error` 通知的 `error` 对象**字节相同**；`turn.status:"failed"`，`durationMs≈27ms`（本地静态校验，未发出网络请求，几乎瞬时）。
7. 对照组（同配置 + `AICLIENT_CODEX_API_KEY=sk-dummy`）：请求序列与帧顺序相同，但 `error` 通知延迟到 ~3.3s 才出现（网络重试耗时），形状换成 `codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}`、`message:"Reconnecting... 1/5"`、`additionalDetails` 提到 `http://127.0.0.1:9/v1/responses` 连接失败、`willRetry:true`——证明认证检查已经通过，失败点后移到了网络层，`turn/completed` 未在此窗口内出现（仍在重试，非终态）。
8. stderr 无并行的、与 env_key 相关的输出；两组唯一的 stderr 都是同一条"CODEX_HOME 建在 /tmp 下时无法创建 PATH 别名"的无关警告（因为本次隔离目录选在 `/tmp` 之下，与凭据检查无关，生产环境 `<userData>/codex-home` 不在 tmp 下不会触发）。
9. 对 Host 侧设计的含义：`credentials_missing` 降级判据应挂在**turn 级 `error` 通知 / `turn/completed.turn.error`**上，用 `message` 子串 `Missing environment variable` 识别（`codexErrorInfo` 目前不区分"缺变量"和其他"other"类错误，无法只靠 code 分类）；不能指望在 `initialize`/`thread/start` 阶段提前拦截，也不能只监听 `turn/start` 请求的 JSON-RPC 响应（该响应本身是"成功"的）。

## 环境 / 版本

- codex-cli 版本：**0.145.0**（`codex --version` 输出 `codex-cli 0.145.0`）。
- 入口：遵循 `src/agent-host/codexNodeEntry.ts` 的规则（node 版本，非原生二进制）：
  - node: `/home/dan/.nvm/versions/node/v24.18.0/bin/node`
  - codex.js: `/home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/bin/codex.js`
  - 该机 `which codex` → realpath 恰好落到上面这个 `codex.js`（与 `codexNodeEntry.ts` 注释里记录的 [实测] 一致）。
- 驱动方式：仿照 `src/agent-host/spikes/s1-codex-direct-probe.ts` 的 `AppServer` 客户端（newline-delimited JSON-RPC 2.0 over stdio，`request()`/`notify()`/等待通知），裁剪到 E4 只需要的 `initialize`→`thread/start`→`turn/start` 三步。

## 隔离 config.toml（两组实验完全相同，唯一差异是进程 env 是否带 `AICLIENT_CODEX_API_KEY`）

```toml
# GENERATED (E4 spike fixture, mirrors D47 generated-mode shape)
model_provider = "jyw"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.jyw]
name = "jyw"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```

隔离 `CODEX_HOME` 目录下**没有 `auth.json`**（生成模式 Q4 路径 A：纯 env 注入，不落盘凭据文件）。`base_url` 指向本机必然连不上的 `127.0.0.1:9`，因为认证检查发生在网络请求之前，指向哪里不影响缺变量这一支的结果；只在对照组（认证通过后）用来确认失败点确实后移到了网络层。

## 复现命令

```bash
# 1. 建隔离目录，写入上面的 config.toml 到 <CODEX_HOME>/config.toml，不放 auth.json
# 2. spawn（不设 shell，不走 PATH）：
NODE=/home/dan/.nvm/versions/node/v24.18.0/bin/node
CODEX_JS=/home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/bin/codex.js
CODEX_HOME=<隔离目录> "$NODE" "$CODEX_JS" app-server
# 环境变量：missing 组不设 AICLIENT_CODEX_API_KEY；present 组设 AICLIENT_CODEX_API_KEY=sk-dummy-...
# 3. stdin 依次写入换行分隔的 JSON-RPC 2.0 帧（无 Content-Length，纯 NDJSON）：
```

请求帧（两组完全一致，逐字，仅供 S4 断言引用报文形状）：

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"e4-appserver-missing-envkey","title":"D47 S0-E4 spike","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"<workdir>","approvalPolicy":"on-request","sandbox":"workspace-write"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"<echoed thread id>","input":[{"type":"text","text":"Reply with exactly PONG and nothing else. Do not use any tools."}]}}
```

驱动脚本产出的原始逐帧记录（`{dir,tMs,raw}`，`dir: '->'`=Host→codex，`'<-'`=codex→Host，`'!!'`=stderr/子进程事件）落在会话 scratchpad `e4/missing/frames.jsonl` 与 `e4/present/frames.jsonl`（scratchpad 易失，不作为长期依据；本文档下方的逐帧 fixture 才是权威留存）。

## 逐帧 fixture —— missing 组（`AICLIENT_CODEX_API_KEY` 未设置）

时间戳 `tMs` 为相对进程启动的毫秒偏移，用于观察顺序与耗时，不代表绝对时间。

### `initialize` 请求/响应

```json
// -> tMs=4
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"e4-appserver-missing-envkey","title":"D47 S0-E4 spike","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}

// <- tMs=202  (JSON-RPC response, ok, no credential check)
{"id":1,"result":{"userAgent":"e4-appserver-missing-envkey/0.145.0 (Ubuntu 26.4.0; x86_64) VTE/8400 (e4-appserver-missing-envkey; 0.0.1)","codexHome":"<CODEX_HOME>","platformFamily":"unix","platformOs":"linux"}}
```

### `thread/start` 请求/响应（成功，回显 posture）

```json
// -> tMs=203
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"<workdir>","approvalPolicy":"on-request","sandbox":"workspace-write"}}

// <- tMs=270  (JSON-RPC response, ok)
{"id":2,"result":{
  "thread":{"id":"01a005e2-cd90-7e71-8757-08da2149138d","modelProvider":"jyw","status":{"type":"idle"},"cwd":"<workdir>","cliVersion":"0.145.0","turns":[]},
  "model":"gpt-5.6-sol",
  "modelProvider":"jyw",
  "approvalPolicy":"on-request",
  "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}
}}

// <- tMs=270  (notification)
{"method":"thread/started","params":{"thread":{"id":"01a005e2-cd90-7e71-8757-08da2149138d","modelProvider":"jyw","status":{"type":"idle"},"cwd":"<workdir>","cliVersion":"0.145.0","turns":[]}},"emittedAtMs":1786805145013}
```

### `turn/start` 请求/响应（请求本身成功，`status:"inProgress"`）

```json
// -> tMs=271
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","input":[{"type":"text","text":"Reply with exactly PONG and nothing else. Do not use any tools."}]}}

// <- tMs=274  (JSON-RPC response, ok — NOT where the error surfaces)
{"id":3,"result":{"turn":{"id":"01a005e2-cdb9-7852-903e-83605ee07161","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
```

### 异步通知序列 —— 报错的实际位置

```json
// <- tMs=286
{"method":"thread/status/changed","params":{"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","status":{"type":"active","activeFlags":[]}},"emittedAtMs":1786805145028}

// <- tMs=286
{"method":"turn/started","params":{"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","turn":{"id":"01a005e2-cdb9-7852-903e-83605ee07161","status":"inProgress","startedAt":1786805145}},"emittedAtMs":1786805145028}

// <- tMs=296  (echoes the user input as an item — not an error signal by itself)
{"method":"item/started","params":{"item":{"type":"userMessage","id":"01a005e2-cdd0-7af0-b55f-560276a3e5d0","content":[{"type":"text","text":"Reply with exactly PONG and nothing else. Do not use any tools."}]},"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","turnId":"01a005e2-cdb9-7852-903e-83605ee07161"},"emittedAtMs":1786805145041}

// <- tMs=296
{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a005e2-cdd0-7af0-b55f-560276a3e5d0"},"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","turnId":"01a005e2-cdb9-7852-903e-83605ee07161"},"emittedAtMs":1786805145041}

// <- tMs=304  (thread flips to systemError right before the error notification)
{"method":"thread/status/changed","params":{"threadId":"01a005e2-cd90-7e71-8757-08da2149138d","status":{"type":"systemError"}},"emittedAtMs":1786805145048}

// <- tMs=304  *** THE ERROR FRAME — S4 assertions should match against this shape ***
{"method":"error","params":{
  "error":{
    "message":"Missing environment variable: `AICLIENT_CODEX_API_KEY`.",
    "codexErrorInfo":"other",
    "additionalDetails":null
  },
  "willRetry":false,
  "threadId":"01a005e2-cd90-7e71-8757-08da2149138d",
  "turnId":"01a005e2-cdb9-7852-903e-83605ee07161"
},"emittedAtMs":1786805145048}

// <- tMs=327  (turn terminates as failed, carrying the SAME error object)
{"method":"turn/completed","params":{
  "threadId":"01a005e2-cd90-7e71-8757-08da2149138d",
  "turn":{
    "id":"01a005e2-cdb9-7852-903e-83605ee07161",
    "status":"failed",
    "error":{
      "message":"Missing environment variable: `AICLIENT_CODEX_API_KEY`.",
      "codexErrorInfo":"other",
      "additionalDetails":null
    },
    "startedAt":1786805145,"completedAt":1786805145,"durationMs":27
  }
},"emittedAtMs":1786805145071}
```

stderr（全程仅此一条，与凭据无关，见结论 #8）：

```
WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf("<CODEX_HOME>"))
```

## 逐帧 fixture —— present 组对照（`AICLIENT_CODEX_API_KEY=sk-dummy-...`）

`initialize`/`thread/start`/`turn/start` 三帧与 missing 组同形状（仅 `threadId`/`turnId` 值不同），略。差异从 `turn/started` 之后开始：

```json
// <- tMs=193
{"method":"turn/started","params":{"threadId":"01a005e2-e28c-7873-8f41-847954312624","turn":{"id":"01a005e2-e2a7-7383-bed5-b04bec2d296e","status":"inProgress","startedAt":1786805150}},"emittedAtMs":1786805150381}

// <- tMs=3272  *** error 帧延迟到 ~3.1s 后才出现（网络重试耗时），形状完全不同 ***
{"method":"error","params":{
  "error":{
    "message":"Reconnecting... 1/5",
    "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}},
    "additionalDetails":"stream disconnected before completion: error sending request for url (http://127.0.0.1:9/v1/responses)"
  },
  "willRetry":true,
  "threadId":"01a005e2-e28c-7873-8f41-847954312624",
  "turnId":"01a005e2-e2a7-7383-bed5-b04bec2d296e"
},"emittedAtMs":1786805153460}
```

`willRetry:true` 且窗口内未见 `turn/completed`——这不是终态，是重试中，符合"认证已过、卡在网络层"的预期，证明缺变量分支报的确实是认证错误而非别的什么。

## 附：一次性驱动脚本（供复现，未入库到 `src/`）

脚本原件在会话 scratchpad（易失，仅备查）：`/tmp/claude-1000/-home-dan-projects-ai-client/8139279c-c4ed-416e-b915-6d3470238954/scratchpad/e4/e4-driver.mjs`，用法 `node e4-driver.mjs missing|present`。核心逻辑与仓内 `s1-codex-direct-probe.ts` 的 `AppServer` 类同构（NDJSON JSON-RPC 2.0，`request()`/`notify()`/`waitFor()`），本文档"复现命令"一节的请求帧序列已经是脚本发出的逐字副本，若脚本文件丢失，按上文的 config.toml + 请求帧序列即可用任意语言重新驱动。
