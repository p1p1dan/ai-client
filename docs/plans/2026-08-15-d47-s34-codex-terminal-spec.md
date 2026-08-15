# D47 S3+S4 施工规格 — Codex 生成模式与终端注入（rev.2 评审合取版）

> 2026-08-15。母规格 §3.B/§7 S3/S4 行；S1/S2 已落。
> **rev.2 = rev.1 大改**：双盲评审合取——A 轨 Opus（协议与时序，5B/10M/9m，判「不能整片开工」）+
> B 轨 Codex（证据与可验证性，6B/5M/3m），原文归档 [reviews/](./2026-08-15-d47-s34-reviews/)。
> 四处独立同判（状态机矛盾 / 存量 auth.json / I5 纪元竞态 / normalizer 落点）。
> **架构拍板（A 轨 B1 方案 1，合取裁定）**：codex-home 的 `config.toml` 物化**归 Main**——B 轨 c 裁定核实
> posture 是常量（`codexRuntime.ts:1355` 同一 posture 常量传入）非每会话变量，Main 静态生成可行，
> 连解 A-B1/A-B2/A-M4/A-M8。子批重划：**S4a（agent-host 侧）/ S3b（Main 侧）文件集不相交仍可并行**。

## §1 模式状态机（B 轨 B1 三态 resolver + A 轨 B3 显式 undefined 语义，唯一权威）

新显式标记 **`AICLIENT_CODEX_MANAGED`**（`'1'` 才算 on；不复用 base URL 存在性——rev.1 裁定 a 被两轨同判为伪）。

```
resolveCodexCredentialMode(env):
  env.AICLIENT_CODEX_MANAGED !== '1'            → { mode:'fallback' }          # 今天行为逐字节
  marker on ∧ env.AICLIENT_CODEX_API_KEY 非空    → { mode:'managed', apiKey }
  marker on ∧ key 缺/空                          → { mode:'managed_missing_credentials' }
```
- **单一 resolver**（落 `agentSupport.ts` 导出，Host 四读者——registry/codexHome/codexRuntime/spawn env——
  只准调它；静态断言 `AICLIENT_CODEX_MANAGED` 字面量在 agent-host 只出现于此 + hostEnv.ts）。
- **继承污染防御（A 轨 B3）**：`buildAgentHostEnv` **恒返回三键** `AICLIENT_CODEX_MANAGED` /
  `AICLIENT_CODEX_API_KEY` / `AICLIENT_CODEX_HOME_MANAGED_DIR`（值 `string|undefined`，照同文件
  `ELECTRON_RUN_AS_NODE: undefined` 先例；spawn 丢 undefined 键 → 杀掉 shell/dev 继承值）。
  flag-off 臂 = 三键全 undefined（`hostEnv.test` 既有五键 `toEqual` 因 undefined 被忽略而**零改动继续绿**——
  A 轨 m2，规格点明防误改成 toMatchObject）。矩阵测试全部**预置相反继承值**再断言（B 轨 B1 要求）。
- 这两个 app-internal 键**不进** `credential-env-keys.mjs` 共享清单（B 轨 m3：语义不同，由 Main 显式
  undefined 语义单独 sanitize）。
- registry 短路序：`flag_off → credentials_missing → entry_missing → home_prepare_failed`；
  `credentials_missing ⟺ mode==='managed_missing_credentials'`；负控：`{flag:'1', marker 缺}` ⇒
  `available:true` 走 fallback（**不是** credentials_missing）。第四子串与既有三条**成对互不包含**
  （两轨同证这是**新增纪律**非既有——现测试只 `Set.size===3`，须新写 ordered-pairs 断言）。

## §2 范围与交付物

### S4a（agent-host 侧）

- `src/agent-host/codexHome.ts` — managed 模式分支：**不投影、不拷贝、不写 config**（config 由 Main 物化，
  见 S3b）；改为：**删除存量 `auth.json`**（幂等 unlink，吞 ENOENT；删除失败 → 该次判 home_prepare_failed
  阻断，不许只记日志——两轨 B2 同判，I4 从「断言」变「动作」）+ 校验 `config.toml` 存在（缺 →
  `home_prepare_failed`，诚实归因）。fallback 分支整链现状保留（投影/拷贝/幂等/mtime——既有测试零改动）。
  `EnsureCodexHomeResult` 改判别联合 `{mode:'projected', projection, authCopied} | {mode:'managed'}`
  （A 轨 M9：不许拿空数组冒充投影审计）；日志两套口径。投影链彻底删除归 **S6**（A 轨 m4 归属点名）。
- `src/agent-host/codexRuntime.ts` — spawn env：managed 模式 `{...stripCredentialEnv(process.env),
  CODEX_HOME, AICLIENT_CODEX_API_KEY}`（剥离用 S2 共享清单语义的 agent-host 侧实现——`ANTHROPIC_` 前缀
  整前缀剥，测试含 `ANTHROPIC_FUTURE_SENTINEL` 哨兵防枚举式假绿，B 轨 M1-4；若跨 tsconfig 引 `.mjs` 不过
  `typecheck:agent-host`，在 `src/shared/` 落镜像常量 + 同源断言——A 轨 M7 预案）；fallback 全继承现状。
  断言接缝 = 既有 `connectInputs[0].env` harness（B 轨 M4：禁只测另写 helper），create/resume/revive
  三路至少各一 smoke 证共汇 openConnection。
- `src/agent-host/codexNormalizer.ts` — 两轨同判的落点修正（rev.1 的「protocolErrors 模块」不存在）：
  ① **修既有 bug**：`turn.error` 是对象时 `String()` 产出 `[object Object]`（`:504-521`）——改读
  `turn.error.message`（兼容旧字符串形态）；② 新纯函数 `classifyCodexTurnError(error)`：
  `message` 含 `Missing environment variable` **且**含 `AICLIENT_CODEX_API_KEY` 且 `codexErrorInfo==='other'`
  → `codex_credentials_missing`；`willRetry:true` 臂**绝不**升终态（E4 present 组 `Reconnecting` 同帧证）；
  ③ `method:"error"` 通知从 unknown 计数移入 handled，与 `turn/completed.turn.error` 共用 classify，
  **exactly-once**（首个具名错误后，同 turn 终态帧只关闭不再发第二错）；④ E4 双臂提取为**机器 fixture**
  `src/agent-host/__tests__/fixtures/codex/e4-{missing,present}-envkey.jsonl`（readFileSync 驱动，
  禁在 vitest 里解析 docs markdown——B 轨 B4）。三臂必测：missing 双 carrier 同码单发 / present 网络臂
  不误判 / 泛 other 不匹配不误判。
- `src/agent-host/agentSupport.ts` — §1 的 resolver + `credentials_missing` + 短路序 + 子串 pairs 断言。

### S3b（Main 侧）

- `src/shared/codexManagedConfig.ts`（新，纯函数）— `generateManagedCodexConfigToml({baseUrl})`：形状见 §3；
  posture 常量与 agent-host `CODEX_PERMISSION_DEFAULT` **同源断言**（值相同的 vitest 钉子，防两侧漂移）。
- `src/main/services/auth/`（扩展 S2 的启动/regenerate 编排）— codex-home 物化并入 claude-home 同一生命周期：
  启动相 ③（首窗后）/ 登录 regenerate（当场凭据对象）/ 登出 regenerate 三点，经 **managedFileWriter**
  原子写 `<userData>/codex-home/config.toml`（A 轨 M4：终端进程是新增跨进程读者，tmp+rename 必须）+
  sidecar `.aiclient-generated`（mode/来源/时间，含验收断言——B 轨 m1）+ **删除 codex-home/auth.json**
  （Main 侧也删，双保险）；vault 非 ok：config **保留既有字节**（与 claude-home locked 语义对齐）；
  登出：config 重写为无凭据形态？——**否**：config 本就不含 key（env_key 间接），登出只需 host/PTY 不再
  注 key，config 保留（B 轨 B1 登出承诺修正：登出态终端 codex 得到「配置在但 `Missing environment
  variable: AICLIENT_CODEX_API_KEY`」——正是 E4 实测形态，承诺兑现且不依赖 `~/.codex`）。
- `src/main/services/agent-host/hostEnv.ts` + `AgentHostManager.ts` — §1 三键恒发（managed dir 键供
  ensureCodexHome 校验用）；值出自 vault 快照。
- `src/main/services/session/SessionManager.ts` — 本地 PTY 分支：flag-on ⇒ 新建 env 对象
  `{...options.env, CODEX_HOME: managedDir, AICLIENT_CODEX_API_KEY: key}`（**Main 值最后覆盖 renderer
  同名值**——B 轨 B6 合并向；不 mutate 传入 options；vault 非 ok ⇒ 注 `CODEX_HOME` 不注 key）；
  flag-off ⇒ **零变异**（不增不删，保用户自有 `CODEX_HOME` 继承——「本片没动该键」≠「键不存在」，
  B 轨 B6 语义区分）；remote 不注入。claude 侧 pin：flag-on finalEnv 含 `CLAUDE_CONFIG_DIR=托管 home`。
  六面接缝测试照 B 轨 B6 清单（输入无 secret/输出有/未 mutate/Main 胜出/remote/off 零变异）。
- **I5 纪元屏障（B 轨 B3 升格，本片收编）**：登录链在向 renderer 返回成功前 **await** host shutdown；
  登出走 IPC handler 内 await（`OnboardingService.logout()` 同步签名不动）；`AgentHostManager.ensureStarted`
  加 shutdown-in-flight 闸（在飞则先 await）。时序测试照 B 轨 B3 五步（旧 host 在跑 → 换 vault → shutdown
  未完时 create → 断言不落旧进程 → 新 host 读新快照）。完整 I9 七步序仍归 S5（A 轨 M1 登记）。
- **Main 侧凭据门禁（A 轨 M5）**：显式移交 S5，「不做」列表点名。

### 不做（本片）

UsageService 改读 vault（S5）；I9 七步全序（S5）；投影链物理删除（S6）；`session.listHistory` 死链（登记）。

## §3 生成 config.toml 形状（Main 物化，静态）

```toml
model_provider = "jyw"
approval_policy = "on-request"        # 与 agent-host CODEX_PERMISSION_DEFAULT 同源断言
sandbox_mode    = "workspace-write"

[model_providers.jyw]
name = "jyw"
base_url = "<vault.codex.baseUrl>"
wire_api = "responses"
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```
- `model` root 键不写——**B 轨 b 裁定 CONFIRMED**（`buildThreadStartParams` 支持会话级 model，
  `codexRuntime.ts:210/1479`）；A 轨 M6 的申报补足：无会话 model 时 = codex 二进制内置默认（0.145.0 实测
  `gpt-5.6-sol`），codex 升级会静默换默认——登记已知行为 + e4 fixture 版本 pin。上下文两键不写（O4）。
- **strict-config 验收（B 轨 B5 裁定）**：不引入 codex 为测试依赖（300MB 级）；改为**一次性 blessing spike**
  （本机 codex 0.145.0 实跑 `--strict-config` 通过后，把生成字节存为 blessed fixture 入库），vitest 断言
  生成输出 == blessed fixture 字节（hermetic）；codex 升级时重跑 blessing（写进 fixtures README 惯例）。
- 终端行为差清单（A 轨 M2，登记已知限制）：员工自有 `~/.codex` 的 model/effort/status_line/
  developer_instructions/features/danger-full-access 等在托管终端全部不生效；逃生舱口径 =
  `CODEX_HOME=~/.codex codex`（文档化）。历史混入（终端线程写共享 sessions/——A 轨 m6）与登出前已开 PTY
  持有 key 到关窗（A 轨 m7）一并登记。
- 模式漂移（A 轨 M3）：sidecar 记 mode；启动时 mode 翻转记 Host 日志；跨模式 resume 不拒绝（H9 posture
  两态同写照过），登记为已知行为 + m8 的 `modelProvider` 可观测量测试。

## §4 验证与变异（10 对，两态可判性经 B 轨 M1 逐对整改）

承重测试面：§1 矩阵（含污染预置）/ §2 各接缝（connectInputs、SessionManager 六面、hostEnv 矩阵、
normalizer 三臂、时序五步）/ blessed fixture 字节 / flag-off 双档（B 轨 M3：回退功能等价 golden 对比 +
无新副作用——marker/base/key 干扰组合下仍走旧函数、旧字节、旧调用序）。

变异对（每对记正确态输入/变异改动/唯一红断言）：
① resolver 误读 feature flag（矛盾输入杀）② managed 仍执行 source→target copy ③ managed 不删存量
target auth.json ④ 上下文键写进 provider 表（全文件扫描断言）⑤ 剥离漏 `ANTHROPIC_FUTURE_SENTINEL`
⑥ PTY 注入并 mutate 传入 options（双面接缝杀）⑦ renderer 同名值胜出（合并向反转杀）⑧ classify 只处理
error 通知漏 turn/completed（双 carrier 杀）⑨ 子串 pairs 包含（ordered-pairs 杀）⑩ ensureStarted 无闸
（时序测试杀）。

## §5 评审合取记录

| 项 | 裁定 |
|---|---|
| 独立同判四处（状态机 / 存量 auth / I5 竞态 / normalizer 落点+[object Object] 既有 bug） | 全采 |
| A 轨 B1 架构题 | **方案 1：config 物化归 Main**（B 轨 c 裁定证 posture 恒常量，可静态生成；连解 B2/M4/M8；S3 终端可用性不再依赖「开过 app 会话」） |
| B 轨独有 | 显式 marker 三态 resolver / undefined 语义矩阵 / PTY 合并向六面接缝 / strict-config hermeticity（裁定：blessing fixture 而非引依赖）/ E4 机器 fixture / exactly-once |
| A 轨独有 | 存量 auth 真机取证 / M2 终端行为差清单 / M3 模式漂移 sidecar / M6 model 默认申报 / M9 结果联合 / m1~m9 全收 |
| rev.1 裁定 a~f | a **伪**（两轨同判→§1 重设计）；b 真（M6 申报补足）；c 真但限 config 写手（原子写仍加，M4）；d 真（哨兵前缀测试）；e **伪**（「同构」撤回，改「接受共享+原子写+已知限制」）；f 真（落点改 normalizer+双 carrier） |
| 母规格连带 | §3.B「删投影链净减」归属改 S6；§7 S3/S4 行合并断言更新；R7 引用补齐 |
