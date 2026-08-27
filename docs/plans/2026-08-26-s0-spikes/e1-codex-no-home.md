# E1 — codex 能否完全不经 app-owned `CODEX_HOME` 拿凭据与 posture

> plan `unified-credentials` S0' 取证前置（[roadmap](../../plantree/plans/unified-credentials/roadmap.md)）·
> 方向由 **[D60](../openchamber-chat-refactor-ledger.md)** 拍板：隔离 home 降级为「只隔离凭据」。
> 只做实验，**未改动 `src/` 下任何产品代码**。
> 离线成立：所有 `base_url` 指向 `http://127.0.0.1:9`（必然拒连），判别靠**错误形状**，
> 沿用 D47 S0 [E4](../2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md) 的同一手法。

## 结论（≤10 行）

1. **E1 = 是。** `codex app-server` 支持 `-c key=value`（TOML 覆盖，`--help` 实测），
   凭据、provider、posture **三样都能不落文件**地注入，`CODEX_HOME` 可以就是用户自己的 `~/.codex`。
2. **凭据纯 env 已成立**：`-c model_providers.<id>.env_key="AICLIENT_CODEX_API_KEY"` + 进程 env 带该变量 ⇒ 认证通过，
   失败点后移到网络层（R3）。隔离目录下无 `auth.json` 这一半 D47 E4 已证，本轮把它搬到**用户自己的 home** 里复验通过。
3. **用户 `auth.json` 不会遮蔽我们的 env_key**：文件里放真实形状的 `OPENAI_API_KEY` 字符串，
   我们的 env 变量在 ⇒ 仍走我们的 provider（R6）；我们的 env 变量不在 ⇒ **仍报 `Missing environment variable`**（R7）。
   ⇒ 文件凭据**不是**静默兜底，`ensureManagedCodexHome` 今天「删 auth.json 防遮蔽」这一步在新方案下不再必要。
4. **posture 可以纯 `-c` 强制**：用户 config 写死 `approval_policy="never"` + `sandbox_mode="danger-full-access"`，
   `-c` 覆盖成 `on-request` / `workspace-write` 后，`thread/start` 回显的就是我们的值（R5，且该用例**未**传 thread/start posture 参数）。
5. **`-c` 是「合并进表」，不是「替换表」**：`-c mcp_servers={}` **不生效**（R9，用户 MCP 照常拉起）；
   `-c mcp_servers.<name>.enabled=false` **生效**（R10）；覆盖单个 server 的 `command` 也生效（R11）。
   ⇒ 整表 deny 做不到，逐条 deny 做得到，但**需要先读用户 config 枚举名字**。
6. **⚠️ 新发现（不在 D60 覆盖范围）**：取消隔离后，今天 projection 刻意丢弃的
   `mcp_servers` / `developer_instructions` / `notify` / `profiles` **会流回来生效** ——
   R8 实测用户 `[mcp_servers.usermcp]` 被真实拉起（sentinel 文件落地）。
   posture 那半 `-c` 补得回来，这半补不回来，**是一条要单独拍板的策略问题**（见 §对设计的含义）。

## 环境 / 版本

- codex：随包原生二进制 `0.149.1`
  （`src/agent-host/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`，`codex-cli 0.149.1`）。
- 驱动：NDJSON JSON-RPC 2.0 over stdio，`initialize` → `initialized` → `thread/start` → `turn/start`，
  仿 E4 的客户端裁剪而成（scratchpad `e1/probe*.mjs`，非产品代码）。
- 判别口径（沿用 E4）：
  - `Missing environment variable: X.`（`willRetry:false`）= 认证在**发网络请求之前**就失败 ⇒ 该 provider/env_key 生效中。
  - `Reconnecting... waiting for network`（`willRetry:true`）= 认证**已通过**，失败点在网络层 ⇒ 凭据被接受。

## 用例与实测结果

`CODEX_HOME` 一律指向一个**模拟用户自己的 `~/.codex`** 的目录（内含用户自己的 `config.toml`、`AGENTS.md`，
部分用例含 `auth.json`）。`initialize.result.codexHome` 每次都回显该目录，确认没有隐藏重定向。

| # | 场景 | 结果 | 判定 |
|---|---|---|---|
| R1 | 用户 home，无 `-c`，无任何 key | `Missing environment variable: USER_OWN_KEY` · `modelProvider:"userprov"` | 基线：用户 config 在生效 |
| R2 | 用户 home + 我们的 `-c`，我们的 env 变量**缺** | `Missing environment variable: AICLIENT_CODEX_API_KEY` · `modelProvider:"jyw"` | **覆盖抵达了 provider 解析** |
| R3 | 同上，env 变量**在** | `Reconnecting... waiting for network`（`willRetry:true`） | **凭据纯 env 被接受，无需落盘** |
| R4 | R3 + 用户 `auth.json`（token 形状） | 同 R3 | 文件未遮蔽 |
| R5 | 用户 config 写死 `never` / `danger-full-access`，posture 只经 `-c`，thread/start **不带** posture 参数 | 回显 `approvalPolicy:"on-request"` · `sandbox:{type:"workspaceWrite",…}` | **posture 可纯 `-c` 强制** |
| R6 | 用户 `auth.json` 内含 `OPENAI_API_KEY` 字符串 + 我们的 env 变量在 | `Reconnecting...` | **真实形状的文件 key 也不遮蔽** |
| R7 | 同 R6 但我们的 env 变量**缺** | `Missing environment variable: AICLIENT_CODEX_API_KEY` | **文件 key 不是静默兜底** |
| R8 | 用户 config 带 `[mcp_servers.usermcp]`，不做压制 | sentinel 落地 = **用户 MCP 被真实拉起** | 取消隔离 ⇒ 用户 MCP 生效 |
| R9 | R8 + `-c mcp_servers={}` | sentinel 仍落地 | **整表清空无效** |
| R10 | R8 + `-c mcp_servers.usermcp.enabled=false` | sentinel 未落地 | **逐条压制有效** |
| R11 | R8 + `-c mcp_servers.usermcp.command="/bin/true"` | sentinel 未落地 | 覆盖单条有效 |

`developer_instructions` / `notify` / `profiles` **未单独探针**：它们与 `mcp_servers` 同在一个 config 文件、
走同一条读取路径，R8 已经证明该路径在无 projection 时是通的 —— 按同机制推断会一并生效，
但**这是推断不是实测**，若要作为拍板依据需补一发。

## 复现

```bash
B=src/agent-host/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
$B --version            # codex-cli 0.149.1
$B app-server --help    # 确认 -c/--config 存在

# 隔离目录 = 模拟用户 ~/.codex，内含用户自己的 config.toml（provider=userprov, env_key=USER_OWN_KEY）
# 我们的覆盖（每项一个 -c）：
#   model_provider="jyw"
#   model_providers.jyw.{name,base_url,wire_api,requires_openai_auth,env_key}
#   approval_policy="on-request"  sandbox_mode="workspace-write"
CODEX_HOME=<模拟用户 home> AICLIENT_CODEX_API_KEY=sk-dummy-e1 \
  $B app-server -c 'model_provider="jyw"' -c 'model_providers.jyw.env_key="AICLIENT_CODEX_API_KEY"' …
# stdin 依次写入 NDJSON：initialize → initialized → thread/start → turn/start
```

MCP 用例的探测手法：把用户 MCP server 的 `command` 设成 `/bin/sh -c "touch <sentinel>; sleep 30"`，
`thread/start` 后等 3s 检查 sentinel 是否存在 —— 离线、无网络、无歧义。

## 对 S0' 设计的含义

**可以按 D60 的方向做，且比预想干净**：

1. `CODEX_HOME` 不再指向 `<userData>/codex-home`，**就用用户的 `~/.codex`**
   ⇒ 用户全局 `AGENTS.md`、`agents/`、`hooks/`、`skills/`、`plugins/` 整棵树**结构性地恢复**（无需投影、无需收养）。
2. 凭据与 provider 经 `-c` + 一个 env 变量注入，**不写用户任何文件** ——
   `ensureCodexHome` 的 projection 写盘、`config.toml` 生成、`auth.json` 删除三件事**全部可以下线**。
3. posture 用 `-c approval_policy` / `-c sandbox_mode` 强制，与今天写进 config.toml 的效果等价（R5）。
   ⚠️ 但 `codexHome.ts` 注释称「resume 会从该文件重新推导 posture」—— 新方案下 `-c` 是**进程级**参数，
   同一个 app-server 进程内 resume 自然带着；**跨进程 resume 是否仍成立未测**，S0' 施工时须补一发。
4. **要新拍一条策略**：用户的 `mcp_servers` / `developer_instructions` 等，今天被 projection 丢弃，
   新方案下会生效。三个选项：① 全部继承（与「用户环境原样生效」一致，也是取消隔离的初衷）；
   ② 读用户 config 枚举后逐条 `enabled=false` 压制 MCP（做得到，但等于又开始读写用户配置的语义）；
   ③ 只继承、但在 UI 明示。**本条已登记为 open-q #7。**

**不构成阻塞**：E1 的原始问题（能不能不经 app-owned home）答案是**能**，
codex 侧不再需要「投影 / 直写 `~/.codex`」那两个退化方案，roadmap 里那条分支可以关掉。
