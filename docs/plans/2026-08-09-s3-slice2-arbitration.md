# S3 切片 2「Codex 客户端骨架」— 双轨合流仲裁与施工契约

> **2026-08-09 落库。** plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> 前置：[S2 设计档](./2026-08-06-s2-codex-integration-design.md)（本档**取代**其 §3「切片 2」在冲突面上的表述）·
> [S1 spike 报告](./2026-08-06-s1-acp-codex-spike-report.md)（wire 事实）。
>
> 产生方式：Opus（deep-reasoner，xhigh）与 Codex 双盲同题，各出一份切片 2 施工设计 → 编排者仲裁合流。
> 两轨互不见对方答案。**双轨独立收敛的条目按本仓惯例可当定论；分歧逐条仲裁并记理由。**
>
> 标注纪律：`[实测]` = 有报文/源码证据且经复核 · `[读码]` = 源码可证 · `[推测]` = 仍是推测，**不得升格**。

---

## 0. 用户裁定（本轮新增两条，均不可由编排者推翻）

### ① Codex 部署口径 = **随 Agent Host 一起打包**（2026-08-09）

施工档从头到尾**没裁定过**这件事，是 Codex 轨挖出来的真缺口：`@openai/codex` 既不在根
`package.json` 也不在 `src/agent-host/package.json`（[读码]），而 `electron-builder.yml` 的注释还写着
「使用 system-installed CLIs」。用户裁定**随包**，不走「依赖用户全局 npm 装」。

**体积代价（编排者 2026-08-09 实测，写下来免得出包时才发现）**：

| 项 | 实测 |
|---|---|
| `@openai/codex@0.145.0` 本体 | ~20KB（`bin/codex.js` 是纯 launcher） |
| 嵌套平台包（本机为 `@openai/codex-linux-x64`） | **347MB** |
| 其中 `vendor/…/bin/codex` 单文件 | **310,730,800 字节（296 MiB）** |
| `vendor/…/bin/codex-code-mode-host` | **46,139,288 字节（44 MiB）** |
| `optionalDependencies` | 六个平台包，**npm 按平台只装一个** → Windows 出包只带 win32-x64 |

→ 当前 portable **141MB → 随包后约 480MB（3.4×）**。与 open-q **#1**（C-15 的 +21MB 体积可接受性，
用户至今未拍板）**直接冲突**，本档只登记，不代拍。

**与 §0.5-④' 的关系（不矛盾，别误读）**：用户的原话是「得用 node 版本，不能用打包好的版本」——
指的是**入口必须是 node wrapper（`codex.js`）**，不是「不带原生二进制」。`codex.js` 本身就是个 launcher，
它 spawn 的正是那个 296MiB 原生二进制（S1 实测三级进程链）。**随包 = wrapper + 原生二进制都带**，
我们 spawn 的仍是 `node <codex.js> app-server`，④' 的约束照样成立。

### ② 授权 transcript → 仓库夹具（2026-08-09）

用户被明确问及并逐字授权：从 `~/.claude/projects/**.jsonl` 抽取 **Codex 协议报文**（不含对话正文）
→ 按 T-35 口径脱敏 → 落 `src/agent-host/__tests__/fixtures/codex/`。范围仅限协议报文。

---

## 1. 双轨独立收敛（可当定论，不再复议）

两轨互不见对方答案却给出同一结论的 6 条：

| # | 结论 | 备注 |
|---|---|---|
| 1 | **CODEX_HOME 按字面「隔离成空目录」不可实现** | 空 home = 无 `auth.json`（S1 [实测]「无需 authenticate，凭据取自 `~/.codex/auth.json`」）+ 无 `model_provider/base_url`（本机是第三方代理）→ 每个回合必失败，且会被误诊成「直连接入做错了」。**施工档 §3 只写了「隔离」两个字，按字面做必然踩空。** |
| 2 | **`networkAccess:false` 我们其实下发不了** | `thread/start` 入参是 `sandbox: 'workspace-write'` **字符串**；只有**回显**才展开成 `{type:'readOnly', networkAccess:false}`（S1 §1.5 [实测]）。即 networkAccess 是 sandbox 档的**服务端默认子维度**，不是我方入参 → `session.created.permissionPolicy.networkAccess:false` 是一句**我们无法自证的声明**，与 §0.5-⑤「显式下发」的措辞不符。 |
| 3 | **验收句「`thread/start` 参数 == `session.created` 回显」按现有类型字面不成立** | `thread/start` 至少含 cwd/model/approvalPolicy/sandbox；`SessionCreatedEvent.payload` 只有 runtimeIdentity/permissionMode/agent/permissionPolicy（`runtimeEvents.ts:511`）——cwd/model **没有回显字段**。 |
| 4 | **pending 表最危险的失效是「清了表但没回帧」** | `Map.clear()` 能让 `size===0` 的表面验收通过，却把 codex 永久留在 `waitingOn*`。验收必须同时断言「每条挂起请求都收到过恰好一次 settle」。 |
| 5 | **Node 入口解析绝不许回落原生二进制/PATH `codex`** | 这是唯一会违反用户不可逆裁定的失效路径，且**开发机（Linux + nvm）永远复现不出来**。 |
| 6 | **flag 的 env 不需要显式注入** | `AgentHostProcess.ts:46-52` 已是 `{...process.env, ...options.env}` 全量继承（[读码]），施工档 §0.5 证据表多写了一步。 |

---

## 2. 分歧与单轨独有发现的仲裁

### 2.1 分歧逐条裁定

| 分歧 | Opus | Codex | **裁定与理由** |
|---|---|---|---|
| 两 flag 并发时 status 取谁 | `waiting_permission` | `waiting_permission` | **取 `waiting_permission`**。两轨同判，但两轨都标了「这是工程裁定不是实测」。编排者补强依据：仓内先例 `claudeRuntime.ts:234-246` 的 `resolveCompensationStatus` 就是 permission 先于 question 检查（[读码]）；且审批阻断执行、携带破坏性后果。**自纠正性**：审批答完服务端会再发一条全量快照，mapper 无状态即刻改判。 |
| flag 读取时机 | reader 每次调用读 env（可单测），`index.ts` 只在模块初始化调一次 | Main 显式规范化为 `'1'`/`'0'`，Host 再读规范值 | **两者合取**（不是二选一）。Opus 解决可测性，Codex 解决 `true`/`yes` 等非规范值在测试环境的分歧——互补，无冲突。 |
| `SUPPORTED_AGENTS` 怎么加 codex | flag on 时 push | **改为 initialize 时建 `HostAgentRegistry`** | **取 Codex**。理由是它给的事实：codex 可用性不只取决于 flag，还取决于 Main 解析出的 entry 与隔离 home 准备结果，而 `index.ts:34` 是**模块级常量**（[读码]）——模块加载时这些都还不知道。 |

### 2.2 Codex 轨独有（Opus 未见），全部采纳

| # | 发现 | 施工后果 |
|---|---|---|
| C-a | **`NodeRuntimeResolver` 实际优先级与施工档不符**：档写 `bundled → env → nvm → PATH`，实际是 `explicit → env → bundled → extra → nvm/fnm/volta → PATH`（`NodeRuntimeResolver.ts:68` [读码]）。**不是行号漂移，是顺序实质不同。** | **切片 2 不擅自改 resolver 顺序**（改了会删掉「坏的 bundled 可被 env 覆盖」这个逃生口）。Codex 复用 Main 已解析出的结果。要改需另行裁定。 |
| C-b | **`build-agent-host.mjs` 无 Codex 规则**：只 pin/verify Cometix 与 Claude SDK，external 列表也只有两者（`:44` / `:98` [读码]）。 | 随包决定 ⇒ preflight / external / copy-prune / mustExist / packaged verifier **整条都要改**。「只在 package.json 加依赖」是不完整施工。→ 见 §3 切片拆分。 |
| C-c | **`capabilities.agents` 会被 Main/renderer 丢掉**：`AgentHostManager.getStatus()` 只保存 settings（`:57`）、renderer `hostStatus.ts:60` 只折叠 thinking（[读码]）。 | 只改 Host 广告不足以支撑 flag UI；晚挂载 renderer 与 poll prime 看不到 agents。**capabilities snapshot 要整条补齐**。 |
| C-d | **聊天轴没有 agent selector**：`AgentPickerMenu.tsx`/`SessionBar.tsx` 操作的是终端 `BuiltinAgentId` 轴；`chatSessionActions.ts:20` 也没有 agent 参数（[读码]）。 | §4 的「renderer 禁用 Codex 选项 + tooltip」**无处落地**。切片 2 只落 availability model 并登记 UI 接线为前置；**直接改旧 `AgentPickerMenu` 会违反三轴隔离**。 |
| C-e | **onboarding 只写 `~/.codex/config.toml` + `auth.json`**（`OnboardingService.ts:335` [读码]），与「禁止继承该 config」没有接缝。 | 应用私有 Codex profile 必须成为**新的权威来源**，这是切片 2 的正式前置，不能留给运行时猜。 |
| C-f | **切片 4 的「permissions 自动拒绝」与 C10「共享 pending 表」易被误读为矛盾** | 切片 2 **保留 `approval_permissions` kind 的登记能力**；切片 4 收到时立即以 `unsupported` settle 并 fail-safe 拒绝——**不是「不实现就不回 JSON-RPC response」**。 |
| C-g | **`clientInfo.title` 是否外泄无本地证据** | 能安全定下的只有「不放工作区信息、固定 `AiClient`」。**不得声称已证明 title 不上送**——`clientInfo.name` 进 User-Agent 有原始报文证据，两者证据等级不同。 |

### 2.3 Opus 轨独有（Codex 未见），全部采纳

| # | 发现 | 施工后果 |
|---|---|---|
| O-a | **切片 2 无法诚实实现 `session.resume`** | Claude 侧是 `session.resumed → session.history → session.status(idle)`；Codex 若只发 `session.resumed` 不跟历史，渲染端停在空白转录且无错误提示。而 `history_unsupported` 全链路被划给 5a。→ **切片 2 的 `resumeSession` 直接回 `host.error{agent_unsupported, fatal:false}`**，由 5a 整条替换。**已知且有界的限制**：切片 2 期间建的 Codex 会话重启后恢复不了，必须写进台账。 |
| O-b | **pending 表 key 必须分类型**：两个探针都写 `pending.get(Number(msg.id))`（`s1-codex-direct-probe.ts:176`），而 JSON-RPC 2.0 允许字符串 id，`Number('1')===1` 会让 `'1'` 与 `1` 撞成同一条。 | key = `` `n:${id}` `` / `` `s:${id}` ``。3 行成本的根治。 |
| O-c | **分类判据的两条禁令** | 绝不看 `jsonrpc` 字段（直连响应帧省略它，S1 [实测]）；绝不写 `if (msg.id)`（服务端 id **从 0 起**，`0` falsy，[实测]）。 |
| O-d | **连接意外退出也必须 drain** | 施工档没点名，但与「清了表没回帧」同属一个失效族：进程崩了而挂起请求还在表里 → 渲染端卡片永远等不到 `question.resolved`。 |
| O-e | **C2 的字面量扫描保护不到 `'codex'`，且同形规则套不上去** | `BuiltinAgentId` 的值恰好也是 `'codex'`（`cli.ts:1`），朴素扫描会把整条终端轴照亮——正是 C2 当初推翻 b 原案的同一失效模式。**处置**：补 `CODEX_AGENT` 常量，靠既有 Rule 1/Rule 3 兜底，**不新增 `'codex'` 扫描**，并**显式登记这条缺口**，不装作被覆盖了。 |

---

## 3. 切片 2 拆分（因随包裁定而新增）

用户裁定随包后，切片 2 的工作量超出原估（Codex C-b：整条打包链要改）。**拆为 2a / 2b，2a 先行**：

| 片 | 内容 | 为什么这么切 |
|---|---|---|
| **2a — 客户端骨架**（本轮主体） | `codexWire.ts` / `codexPending.ts` / `codexStatus.ts` / `codexNodeEntry.ts` / `codexHome.ts` 五个叶子 + `codexRuntime.ts` 壳 + `index.ts` 分派 + `HostAgentRegistry` | 全部可离线单测、零额度、不碰打包链。**Node 入口解析写成「候选表 + 注入式 fs 探测」的纯函数**，随包与全局装两种口径都只是候选表多一项，2b 不会推翻 2a。 |
| **2b — 打包链**（随后） | `src/agent-host/package.json` 加 `@openai/codex` · `build-agent-host.mjs` 的 preflight/external/copy-prune/mustExist · `electron-builder.yml` · `verify-packaged-app.mjs` 断言 · CI Windows 作业体积与缓存 | 触及出包，风险面与 2a 正交；且它会让包体涨 3.4×，**应与 open-q #1 一并向用户交待后再落**。 |

**2a 的验收（把施工档那句两义的话拆成两条可执行的）**：

1. **门禁项（纯单测、零额度）**：`thread/start` 实际下发的 `approvalPolicy`/`sandbox` 投影
   **== `session.created.payload.permissionPolicy`**——即「权限姿态的共同子集必须单一真相」。
   范式照 `claudeRuntimeOptions.test.ts:151-219`：**把两个 capture 互相比对，不比对字面量**。
   *不* 为了满足字面验收给 `session.created` 加 cwd/model（那会无必要地扩宽切片 0 已冻结的事件形状）。
2. **零额度预检脚本**（非门禁）：`spikes/s3-codex-home-preflight.ts` —— 用刚播种好的隔离 home 起
   `node <codex.js> app-server`，**只发 `initialize`**（S1 实测 178–188ms，不花额度），断言
   ① 回包 `codexHome` == 我们的隔离目录；② `<home>/auth.json` 存在且非空；
   ③ `<home>/config.toml` 有 `model_provider` 且**没有** `developer_instructions`/`approval_policy`/`sandbox_mode`。
3. `session.close` 后 pending 表 `size===0` **且每条挂起请求都收到过恰好一次 settle**（带具体 reason）。
4. status mapper 覆盖 `activeFlags` **四种组合** + 未知 flag + 畸形 params。
5. `codexNodeEntry` 的候选表断言 **每一个候选都 `.endsWith('codex.js')`** ——
   这条就是「不许回落原生二进制」的可执行版本，任何人加回落分支立刻红。

---

## 4. CODEX_HOME 的落地配方（两轨合流后的唯一口径）

**不是「空目录」，是 deny-by-default 白名单投影**。这套配方**有实测出处**：S2 探针头注
`s2-codex-question-probe.ts:82-86`「keeps model_provider / base_url / model / auth.json and drops everything else」——
施工档 §3 把它压缩成了「隔离」两个字，实施者按字面做必然踩空。

- **目录**：`AICLIENT_CODEX_HOME` = `path.join(app.getPath('userData'), 'codex-home')`，由 **main 注入**
  （Host 算不出 userData）。**Host 侧不设兜底默认**：env 缺失 → 显式 `agent_unsupported`，不猜。
  依据：§附3「默认字面量全仓只有一处」，加兜底就是第二个默认值。
- **config.toml 由我们生成，从不整份拷贝**。根键白名单 `model` / `model_provider`；表前缀白名单 `model_providers.`。
  其余一律丢弃，点名必丢：`developer_instructions`（S1 §6.2 C5 [实测] 三次白跑的真因）·
  `approval_policy` · `sandbox_mode`（本机实测 `danger-full-access`，继承 = 静默关掉全部审批）·
  `mcp_servers` · `notify` · `profiles` · `projects` · `history`。
- **多行值一律丢弃**：只放行 `^key = <单行值>$`。`developer_instructions = """…"""` 这类三引号块
  按行过滤会漏掉续行；「只放行单行」是构造性安全的——最坏结果是少了某个 provider 键、**报错很响**，
  而不是静默降级安全档。
- **auth.json 拷贝**（非 symlink，Windows symlink 需提权/开发者模式），`mode 0o600`，
  仅当源存在且目标缺失/更旧。日志**只打路径与被丢弃的键名，永不打内容**（T-35 立场）。
- **谁清理**：无人自动清理。里面有凭据副本，且切片 5 的 Codex 历史会长在这个 home 下——自动删 = 删用户历史。

> **登记为待用户拍板项**：凭据被复制到第二个磁盘位置（`userData/codex-home/auth.json`）与本仓
> T-35「密钥不许进 UI」的立场方向相反，且用户轮换 `~/.codex/auth.json` 后我们的副本会变成
> **过期但仍有效的凭据残留**。备选是「不隔离，改用 `codex -c key=value` 逐项覆盖」——
> 这是安全取向，不该由编排者默认。**本档按拷贝方案实现，同时把这条摆出来。**

---

## 5. 未闭合项（不得当成已知事实写进代码）

| # | 项 | 现状 | 闭合手段（零额度优先） |
|---|---|---|---|
| U-a | `turn/interrupt`（`session.stop` 用）的确切拼写 | [未测] | `codex app-server generate-json-schema --experimental --out DIR`（S1 [实测] 产 47 schema + 300 类型，**零额度**），把 `CODEX_METHOD` 每个值对着 schema 索引核一遍，并把索引落成夹具 + `codexWireContract.test.ts`。这同时把 S1 建议的「契约漂移 CI 快照 diff」落了地。 |
| U-b | `thread/resume` 拼写 | [实测·经转述] | 同上 |
| U-c | `thread/start` 是否接受**对象型** sandbox（决定 `networkAccess:false` 到底是我方下发还是服务端默认） | [未测]，且仓库未保存 `generate-ts` 产物 | 同上。**未核实前不许猜字段名。** 现阶段处置：照发 `sandbox` 字符串 + 纯函数 `compareSandboxEcho(sent, echo)` 核对回显，mismatch 打 WARN（**不 fatal**——硬约束 7 禁止因校验挂死回合）。 |
| U-d | 四种 `activeFlags` 组合是否都能真实观测到 | 取证抢救进行中 | 若夹具只覆盖部分组合，**如实标注哪些是构造用例**，不得声称四种都有真实报文。 |

---

## 6. 与既有台账的接缝

- 本档**取代** [S2 设计档](./2026-08-06-s2-codex-integration-design.md) §3「切片 2」段落在冲突面上的表述；
  该档其余部分（协议增量总表、切片 0/1/3/4/5 定义、§附硬约束）**继续有效**。
- 切片 2a 落地后回填：[multi-agent roadmap](../plantree/plans/multi-agent/roadmap.md) S3 切片表 ·
  [主线台账](./ledger-claude-mainline.md) 加行（证据 + hash）。
- 新增待用户拍板两项：**随包体积 480MB 与 open-q #1 的关系** · **凭据副本落 userData 的安全取向**。
