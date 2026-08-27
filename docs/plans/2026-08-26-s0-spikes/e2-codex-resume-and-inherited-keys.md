# E2 — S0' codex 侧施工前欠的两发实测

> plan `unified-credentials` S0' codex 侧的开工前置（[roadmap](../../plantree/plans/unified-credentials/roadmap.md)）·
> 承接 [E1](./e1-codex-no-home.md) 结尾标注的两处 **[推断]**，本轮把它们改成 **[实测]**。
> 只做实验，**未改动 `src/` 下任何产品代码**。
> 与 E1 的差别：E1 全程离线靠「错误形状」判别；本轮为了让回合**真正跑完**（跨进程 resume 需要一份 rollout，
> `developer_instructions` 需要看到真实出向报文），起了一个**本机假网关**
> （`127.0.0.1` 随机端口，回一段合法的 Responses SSE）。仍然零外网。

## 结论（≤12 行）

1. **两问都答完，且答案都对 S0' 有利：**
   - **跨进程 resume 的 posture：`-c` 扛得住**（A-P2 实测）。
   - **`developer_instructions` / `notify` / 全局 `AGENTS.md`：确实会一并生效**（B-C1 实测），E1 的推断成立。
2. **`profiles` 这一问的前提没了**：codex 0.149.1 **不再支持** `profile = "x"` 写法，
   而 `app-server` **根本没有** `--profile` 参数 ⇒ profile 这条路在我们的调用形态下不存在。
3. **⚠️ 捞出一条会把用户机器搞挂的东西（不在 E1 覆盖范围）**：
   用户 `~/.codex/config.toml` 里只要有一行遗留的 `profile = "x"`，或有 TOML 语法错，
   **`thread/start` 直接失败**，而且 **`-c` 救不回来**（D2/D6/C2）。
   今天靠隔离 home 屏蔽掉了，S0' 之后就直通用户文件 ⇒ **这是 S0' 引入的回归，须有对策**（见 §对设计的含义 ③）。
4. **⚠️ 捞出一条与仓内注释矛盾的事实**：`approval_policy` 在 resume 时**由 rollout 决定**，
   `-c` 和 `config.toml` **谁都改不动**（A4-Q1/Q2/Q3 三路同为 `never`）。
   `codexHome.ts` 「改常量会 RE-POSTURE 老线程」的说法在 0.149.1 上**不成立**。
   好消息是这不构成 S0' 的回归（新旧两法在此**同样无力**），但它会让 `assertResumePosture` 抛错（见 §④）。
5. **`sandbox_mode` 与 `approval_policy` 不同**：sandbox 在 resume 时**照当前配置层重新推导**，
   `-c` 说了算（A3-P8 / A-P3 双向咬住）。

## 环境 / 版本

- codex：随包原生二进制 **0.149.1**
  （`src/agent-host/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`）。
- 驱动：NDJSON JSON-RPC 2.0 over stdio，`initialize` → `initialized` → `thread/start` → `turn/start`
  → 换进程 → `thread/resume`。脚本在 scratchpad `e2/`（`mockgw.mjs` + `probeA/A2/A3/A4/B2/D.mjs`），非产品代码。
- 假网关：`mockgw.mjs`，监听 `127.0.0.1:<随机端口>`，把每条请求体落盘，回
  `response.created` → `response.output_item.done` → `response.completed` 三帧 SSE。
  作用有二：让回合跑完从而**写出 rollout**；让我们能**读到真实出向报文**去判 `developer_instructions`。

---

## A 组 — 跨进程 resume 的 posture

固定手法：进程 1 建线程 + 跑一个真回合（写出 rollout）→ **杀掉进程 1** → 进程 2/3 用同一个 `threadId` resume。
`thread/start` **不传** posture 参数，确保档位的唯一来源就是被测的那一层。

### A-1：`-c` 能不能扛过跨进程（主问题）

用户 `config.toml` 写死 `approval_policy = "never"` / `sandbox_mode = "danger-full-access"`，我们的 `-c` 给 `on-request` / `workspace-write`。

| # | 场景 | approvalPolicy | sandbox | 判定 |
|---|---|---|---|---|
| P1 | 进程 1，`thread/start`（不带 posture 参数） | `on-request` | `workspaceWrite` | `-c` 对新线程生效 |
| **P2** | **换进程 resume，带我们的 `-c`** | **`on-request`** | **`workspaceWrite`** | ✅ **`-c` 扛得住跨进程** |
| P3 | 换进程 resume，**不带** posture `-c`（对照） | `on-request` | **`dangerFullAccess`** | sandbox 回落到用户文件 |

P3 的 sandbox 变了而 approvalPolicy 没变 —— 这个不对称触发了下面 A-2/A-3。

### A-2：那条不对称是什么

| # | 场景 | 结果 | 判定 |
|---|---|---|---|
| P4 | **新**线程，完全不带 `-c` | `never` / `dangerFullAccess` | 用户文件的 `approval_policy` 对**新线程**是生效的 |
| P5 | resume，完全不带 `-c` | **报错** `Model provider 'jyw' not found` | rollout 记着线程出生时的 provider id，resume 会去解析它 |

⇒ P3 里的 `on-request` 不是「用户文件被读了」，而是「**rollout 记着线程出生时的 approval_policy**」。

### A-3 / A-4：决定性对照 —— rollout、`-c`、`config.toml` 三者谁大

线程在**弱档位**下出生并跑完一个回合，然后用三种方式在 resume 时要求收紧到 `on-request` / `workspace-write`：

| # | 出生档位来源 | resume 时怎么要求收紧 | approvalPolicy | sandbox |
|---|---|---|---|---|
| A3-P7/P8 | `-c` 给 `never`/`danger-full-access` | `-c` 给 strong | **`never`**（没收紧） | `workspaceWrite`（收紧了） |
| A4-Q1 | **文件**写死 weak | `-c` 给 strong | **`never`** | `workspaceWrite` |
| A4-Q2 | **文件**写死 weak | **改写文件**为 strong（**今天的做法**） | **`never`** | `workspaceWrite` |
| A4-Q3 | **文件**写死 weak | 文件 strong **且** `-c` strong | **`never`** | `workspaceWrite` |

**两条结论**：

- **`approval_policy` 一旦定在 rollout 里，谁都改不动** —— `-c` 改不动，改写 `config.toml` 也改不动。
  ⇒ 这不是 S0' 的回归：**新旧两法在这一维上同样无力**。
- **`sandbox_mode` 完全相反**：resume 时照当前配置层重新推导，`-c` 与文件都说了算。

---

## B 组 — 取消隔离后，被 projection 丢弃的键会不会生效

用户 `config.toml` 里放 `developer_instructions`（含哨兵串）与 `notify`（touch 一个哨兵文件），
`CODEX_HOME` 放全局 `AGENTS.md`（含另一个哨兵串），provider 与 posture 全走 `-c`（**production 的形态**）。
判别靠假网关抓到的**真实出向报文**里有没有哨兵串。

| # | 场景 | 结果 | 判定 |
|---|---|---|---|
| **C1** | 合法用户配置，provider/posture 走 `-c` | 报文 49,518 B：`developer_instructions` 哨兵 **命中** · 全局 `AGENTS.md` 哨兵 **命中** · `notify` 程序 **真的被执行** | ✅ **E1 的推断成立，三样都会生效** |
| C4 | 同上，另加 `-c developer_instructions="OVERRIDDEN_BY_US"` | 用户哨兵**消失**，我们的串**命中** | `-c` **能**覆盖这个标量键（与 `mcp_servers` 整表清空不同） |
| C3 | `app-server --profile userprof` | `error: unexpected argument '--profile' found` | **`app-server` 没有这个参数** |

⇒ `profiles` 这一问在我们的调用形态下**不存在**：旧写法被 0.149.1 拒绝（见 D6），新写法我们够不到。

---

## D 组 — 用户配置有毛病时的爆炸半径（S0' 新增风险）

C2 撞出「用户配置里一行遗留写法就让 `thread/start` 失败」。这一组量它是**一个键**还是**任何毛病**。
provider/posture 全走 `-c`，只跑到 `thread/start`（不需要网络）。

| # | 用户 `config.toml` 里的毛病 | `thread/start` | 判定 |
|---|---|---|---|
| D0 | 干净基线 | ✅ started | — |
| D1 | 没人发明过的根键 `foo_bar_nobody_invented = 1` | ✅ started | 未知键**无害** |
| D3 | 已知键给错类型 `approval_policy = 42` | ✅ started | 类型错**无害** |
| D4 | 已知表里的未知键 `[tui] nonsense_key` | ✅ started | 无害 |
| D5 | 有 `[profiles.userprof]` 表但**没有** `profile =` 根行 | ✅ started | **无害**（这是常见形态） |
| **D2** | **TOML 语法错** | ❌ **START_FAILED** `failed to load configuration: …:2:10: extra '=' …` | **致命** |
| **D6** | **遗留 `profile = "userprof"` 根行** | ❌ **START_FAILED** `legacy 'profile = …' is no longer supported` | **致命** |
| D7 | 整个文件不是 TOML | ❌ START_FAILED | 致命（D2 同类） |
| D8 | D1 + `--strict-config` | 未测（探针超时） | 挂账，不影响结论 |

两个致命项**都无法用 `-c` 救**：`-c` 是在配置**加载成功之后**合并进表的，加载本身失败就没有合并这一步。
codex 会先在 `initialize` 阶段推一条 `configWarning` 通知（含具体原因与行号），随后 `thread/start` 回 `-32600`。

---

## 复现

```bash
B=src/agent-host/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
$B --version              # codex-cli 0.149.1
$B app-server --help      # 确认有 -c/--strict-config，没有 --profile

cd <scratchpad>/e2
CODEX_BIN=<上面的 B 的绝对路径> PROBE_ROOT=$PWD node probeA.mjs    # A-1
CODEX_BIN=… PROBE_ROOT=$PWD node probeA2.mjs                       # A-2
CODEX_BIN=… PROBE_ROOT=$PWD node probeA3.mjs                       # A-3
CODEX_BIN=… PROBE_ROOT=$PWD node probeA4.mjs                       # A-4（决定性对照）
CODEX_BIN=… PROBE_ROOT=$PWD node probeB2.mjs                       # B 组
CODEX_BIN=… PROBE_ROOT=$PWD node probeD.mjs                        # D 组
```

每个探针把完整报文落进同目录的 `results*.json`，假网关抓到的请求体落进 `capture*.ndjson`。

⚠️ **一处返工留痕**：B 组第一版把 provider 写进用户 `config.toml`、并带了 `profile = "userprof"` 根行，
结果整份配置被拒 ⇒ provider 一起消失 ⇒ 四个用例全超时，**测出来的什么都不是**。
改成「provider 走 `-c`」（production 形态）后才拿到 C1 的正结果。
教训：**探针的配置注入形态必须与产品一致**，否则失败点会跑到被测点前面。

---

## 对 S0' 设计的含义

① **主问题放行**：`-c` 承载 posture 跨进程成立（A-P2），
`codexHome.ts` 里「resume 会从 config 文件重新推导 posture」那条注释所担心的场景，`-c` 覆盖得住。
⇒ roadmap S0' codex 侧的第一发前置**已清**。

② **第二问放行，且范围比问的更大**：`developer_instructions` / `notify` 生效已实测（C1），
外加**全局 `AGENTS.md` 生效**也一并实测到了 —— 后者正是 [D60](../openchamber-chat-refactor-ledger.md) 取消隔离想要的效果，
现在有了正面证据而不只是「取消隔离后应该会回来」。
`profiles` 一问作废（C3 + D6）。⇒ 第二发前置**已清**，[D61](../openchamber-chat-refactor-ledger.md)「全部继承」的拍板依据由推断升为实测。

③ **⚠️ S0' 必须新增一条防线（本轮新发现）**：取消隔离后，用户 `~/.codex/config.toml` 变成承重件，
而 **TOML 语法错**或**遗留 `profile =` 根行**会让 `thread/start` 直接失败、`-c` 无从补救（D2/D6）。
今天隔离 home 把这类问题**整个屏蔽**了，所以这是 S0' **引入**的回归，不是既有问题。
`profile =` 尤其阴：它在老版本 codex 里是**合法且常见**的写法，用户系统里装的 codex 可能还认，
于是现象会是「我终端里 codex 好好的，AiClient 里起不来」。
建议的最小对策（施工时定）：`thread/start` 的 `-32600` 里若含 `failed to load configuration`，
**不要**降级成通用会话失败，而是把 codex 自己给的**文件路径 + 行号 + 原因**原样带到 UI，并给出「改哪一行」的指引；
codex 在 `initialize` 阶段推的 `configWarning` 通知可以更早拿到同一份信息。

④ **⚠️ 一条与仓内注释矛盾的事实，须连带处理**：`approval_policy` 在 resume 时由 rollout 定死（A-4 三路对照）。
- 对 S0' **不构成回归**：改写 `config.toml`（今天）与 `-c`（新方案）在这一维上**同样无力**。
- 但 `codexHome.ts` 头注释「改常量会 RE-POSTURE 老线程 / 被 resume 的线程绝不会弱于当前构建承诺」
  在 0.149.1 上**是错的**，注释须订正。
- 且 `verifyResumePosture()` 是拿回显与「我们这次要的 policy」逐项比对的
  ⇒ 一个在别的 approval 档位下出生的线程，resume 时回显必然对不上，
  `assertResumePosture` 会抛 `CodexResumePostureError`，**该线程变成不可 resume**（fail-safe，不是静默走弱档）。
  **本轮已顺带查清现网可达性**（`codexRuntime.ts:3712`）：冷 resume 的期望档位取自
  `input.permissionPreference`，即**该会话自己存下来的偏好**，与线程出生时同源 ⇒ **常规路径对得上，不会撞**。
  两条可达的例外，须在 S0' 施工时确认：
  ① 会话建好之后**改过**它的权限偏好（D48 权限管理面若允许），下次冷 resume 就会对不上；
  ② **没有存偏好的老会话**（pre-D48）解析成 `CODEX_PERMISSION_DEFAULT` 常量
  ⇒ 一旦该常量的 `approvalPolicy` 在某次升级里改了值，**所有老线程一起变成不可 resume**。
  注意这正是 `codexHome.ts` 注释写反的地方：改常量**不会**把老线程重新收紧，而是**让它们打不开**。

**不构成阻塞**：两发前置都是「可以按原计划做」的答案；③ 是要在 S0' 施工里多做一件事，④ 是要多改一处注释加一次确认。
