> D47 S3+S4 规格 rev.1 双盲对抗评审 · B 轨（Codex，证据与可验证性镜头，2026-08-15）。原文归档。

结论：rev.1 目前有 6 个 blocker。最核心的问题不是实现细节，而是规格定义的状态机本身不可落地：它无法区分“托管模式开启但凭据不存在”和“回退模式”，因此 `credentials_missing` 在正常 Main 注入路径上基本不可达，登出终端也无法稳定得到规格承诺的 `Missing environment variable`。此外，生成模式没有定义如何删除历史遗留的 `auth.json`，E4 也尚未变成能够驱动真实生产分类接缝的测试夹具。

本次严格只读；`git status --short` 与 `git diff --stat` 均为空，没有修改任何文件。

## 1. blocker（阻塞写码，必须先返工才能开工）

### B1 — §1 S3b + §2.1：模式信号与凭据缺失状态互相矛盾，正常链路无法产生 `credentials_missing`

规格位置：

- [施工规格 §1 S3b](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:33)规定 vault 非 `ok` 时“两键不注入”，并称 Host 会“自然 `credentials_missing`/回退”。
- [施工规格 §2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:53)又规定生成模式判据是 `AICLIENT_CODEX_BASE_URL` 存在；base 缺席就进入投影回退。
- [施工规格 §2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:55)明确只有“有 base、无 key”才是 `credentials_missing`。
- [母规格 I5 与 Codex 凭据降级](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:84)要求无凭据时产生第四 reason，而不是偷偷恢复 legacy 投影认证。

仓内实证：

- 当前 Host registry 的短路只有 `flag_off → entry_missing → home_prepare_failed`，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:96)；reason 联合也只有三项，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:52)。
- 当前 Main→Host 合同只有五个固定键，[hostEnv.ts](/home/dan/projects/ai-client/src/main/services/agent-host/hostEnv.ts:29)与返回对象 [hostEnv.ts](/home/dan/projects/ai-client/src/main/services/agent-host/hostEnv.ts:37)。
- Host 子进程不是只收到 `buildAgentHostEnv` 的返回值，而是先继承整个 `process.env`，再覆盖显式 env，[AgentHostProcess.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostProcess.ts:43)。因此所谓“不注入”并不等于“Host 中不存在”：shell、dev 环境或 Main 进程里已有的 `AICLIENT_CODEX_BASE_URL/API_KEY` 会继续穿透。
- S2 的共享剥离清单只剥 `ANTHROPIC_*` 和七个 Claude/AWS/GCP 键，[credential-env-keys.mjs](/home/dan/projects/ai-client/scripts/credential-env-keys.mjs:17)；`dev.js` 的实际删除条件同样不包含任何 `AICLIENT_CODEX_*`，[dev.js](/home/dan/projects/ai-client/scripts/dev.js:194)。
- 现有 registry 首次构建后永久返回同一对象，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:121)；测试明确断言环境翻转后仍返回同一对象且不重探测，[agentSupport.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:176)。

具体错误场景：

1. `AICLIENT_MANAGED_CREDENTIALS=1`，但 vault 为 `absent/locked/invalid`。
2. Main 按规格同时省略 base 和 key。
3. Host 因 base 缺席判为“回退模式”。
4. registry 不会落入 `credentials_missing`，反而继续执行 entry probe、投影旧 `~/.codex/config.toml`、拷贝旧 `auth.json`。
5. 用户可能在“已登出/凭据失效”状态继续使用遗留 Codex 凭据；这与母规格的凭据纪元及无凭据 reason 相反。

而且规格声称“登出态终端跑 codex 报 Missing env”，见 [施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:41)，但同一段又要求 vault 非 `ok` 时 `CODEX_HOME` 和 API key 两键都缺席。没有托管 `CODEX_HOME`，终端 Codex 会回到自己的默认 home；它不一定读取含 `env_key="AICLIENT_CODEX_API_KEY"` 的生成配置，因此也不一定产生 E4 的 Missing-env 错误。这个承诺在状态机层面不成立。

具体改法建议：

- 增加独立、非秘密、Main 拥有的显式模式标记，例如 `AICLIENT_CODEX_MANAGED=1`；不要再拿 base URL 的存在性兼任模式位。
- Host 状态矩阵应明确为：

  - Codex feature flag off → `flag_off`，不 probe、不碰 fs；
  - feature flag on + managed marker 缺席 → legacy 回退；
  - feature flag on + managed marker 存在 + key 缺席 → `credentials_missing`，在 entry/home 之前短路；
  - marker + key + base 都存在 → 生成模式；
  - marker + key 存在但 base 缺失 → 应定义为配置损坏，是 `credentials_missing` 还是独立 reason 必须拍板，不能静默回退。

- Main 启动 Host 时必须先从继承 env 删除/遮蔽 `AICLIENT_CODEX_MANAGED`、`AICLIENT_CODEX_BASE_URL`、`AICLIENT_CODEX_API_KEY`，再按当前 vault 快照显式赋值；“省略字段”不能作为删除继承值的手段。
- 把矩阵写进 `buildAgentHostEnv`/Host registry 的测试：每个 case 都要预置相反的继承值，证明 Main 的显式状态优先，而不是只在干净 `{}` env 上测试。
- 对登出终端另行裁定：如果必须稳定呈现 Missing-env，则 managed flag on 时应继续注入 `CODEX_HOME`，并保证其中存在生成配置，只省略 key；如果 fresh signed-out 状态无法获得 base URL，就必须撤回“必然 Missing env”的承诺或定义非 vault 的可信 base 来源。

---

### B2 — §1 S4a：只规定“生成模式不执行 auth 拷贝”，没有删除回退模式遗留的 `auth.json`

规格位置：

- [施工规格 §1 S4a](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:15)要求保留整个投影/auth 拷贝回退链。
- [施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:18)只说生成模式下“拷贝链不执行”，随后断言 codex-home 不存在 `auth.json`。
- [母规格 I4](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:23)要求 `<userData>/codex-home` 下不存在 `auth.json`，不是“本次没有新拷贝”。

仓内实证：

- 当前目标文件固定为 `<homeDir>/auth.json`，[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:621)。
- 只要源文件更新或目标不存在，就会复制并 chmod 0600，[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:624)。
- 目标目录是长期复用的 `<userData>/codex-home`，当前 `ensureCodexHome` 只 `mkdir -p`，不会清空目录，[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:612)。
- 当前测试只覆盖初次拷贝、第二次不拷、源凭据轮换，[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:456)、[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:486)、[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:542)，没有“回退模式留下 auth → 下一次切生成模式”的迁移臂。

具体错误场景：

1. 用户先在回退模式运行一次，`codex-home/auth.json` 被复制。
2. 后续打开托管生成模式。
3. 新代码仅跳过 `copyFileSync`。
4. 旧 `auth.json` 仍留在同一个 home。
5. I4 失败；Codex 还可能读取旧认证状态，使 env-key 缺失测试被历史凭据遮蔽。

具体改法建议：

- 生成模式必须显式删除目标 `auth.json`，且删除失败应阻断生成模式可用性，不能只写日志继续。
- 测试必须预置目标 home 中已有哨兵 `auth.json`，调用生成模式后断言文件被删除；仅用全新空目录测试没有咬合力。
- 将必选变异从“生成模式仍拷 auth.json”扩成两对：

  1. 生成模式仍执行 source→target copy；
  2. 生成模式不 copy、但不删除历史 target auth。

- 回退模式测试仍应验证 auth mtime 刷新链完全保留，以免清理动作误伤 flag-off 行为。

---

### B3 — §1 S3b：规格称 I5 已由 S2 接线，但当前登录链并没有建立可等待的 Host 凭据纪元屏障

规格位置：

- [施工规格 §1 S3b](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:36)称 I5 已由 S2 接线，“登录/登出 regenerate 后 shutdown → 下次 ensureStarted 重建即拿新值”。
- [母规格 I5](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:24)要求 Host 生命周期等于凭据纪元。

仓内实证：

- 登录成功后虽然等待 Claude home regenerate，但调用 Host shutdown 使用 `void`，不会等待 shutdown 建立完成，[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:194)、[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:204)。
- `shutdownAgentHostAfterRegenerate()` 在真正调用 shutdown 前先 `await import(...)`，[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:222)。因此 `void` 调用会在动态 import 处立即让出，用户可在旧 Host 尚未 shutdown 时创建会话。
- 登出同样是 fire-and-forget promise 链，[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:290)。
- `AgentHostManager.ensureStarted()` 若当前 state 为 ready 且 process 仍运行，会直接返回，[AgentHostManager.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts:94)。
- Host registry 在一个 Host 进程内记忆化且不重探测，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:121)。

具体错误场景：

1. 旧 Host 已启动，并缓存为 `credentials_missing` 或缓存旧 key。
2. 用户登录成功；登录方法启动异步 shutdown，但立即向调用方返回。
3. renderer 立刻创建 Codex 会话。
4. `ensureStarted()` 看到旧 Host 仍 ready，继续使用旧 registry/env。
5. 新凭据本轮仍不可见；或者登出后旧 key 仍可被旧 Host 使用。

具体改法建议：

- S3 施工范围必须收编“凭据纪元屏障”，不能继续把它写成 S2 已完成事实。
- 登录是 async 链，应在向 renderer 返回成功前 `await agentHostManager.shutdown()`。
- 登出若必须维持同步 `boolean` 公共签名，应建立 Main 级 spawn gate/epoch promise：新的 Host/session 创建必须等待本轮 regenerate+shutdown 完成；不能只 fire-and-forget。
- 增加真实时序测试：

  - 先启动旧 Host；
  - 切换 fake vault 快照；
  - 在 shutdown promise 未完成时发 create；
  - 断言 create 不得落到旧 process；
  - 完成 shutdown 后只启动一个新 Host，并读取新快照。

- registry 测试除现有“同一进程不随 env 翻转”外，还要有 Main 级“新进程/新纪元重新探测”的接缝断言。

---

### B4 — §1 turn 错误映射 + §2.4 E4：规格没有钉生产分类接缝，也没有可执行的 E4 fixture

规格位置：

- [施工规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:26)称在“切片 6 的 protocolErrors 双臂模块”加 pattern。
- [施工规格 §2.4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:93)只写“E4 fixture 断言 turn 级映射”。

仓内实证：

- 仓内没有生产 `protocolErrors.ts` 模块；现有的是集成测试文件 `protocolErrors.test.ts`。
- 该文件所谓双臂位于 [protocolErrors.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/protocolErrors.test.ts:455)，内容是 Host flag/entry gate，而不是 Codex turn error 分类。
- 现有 fixture 通过临时目录和 `writeFileSync` 现场生成，[protocolErrors.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/protocolErrors.test.ts:483)；没有读取 `docs/plans/...e4...md`。
- Codex normalizer 的已处理通知表没有 `error`，[codexNormalizer.ts](/home/dan/projects/ai-client/src/agent-host/codexNormalizer.ts:51)。
- `ingest()` 对未知通知进入 default/onUnhandled，[codexNormalizer.ts](/home/dan/projects/ai-client/src/agent-host/codexNormalizer.ts:278)；因此 E4 的 `method:"error"` 当前不会形成具名凭据错误。
- `turn/completed.turn.error` 当前直接 `String(turn.error)`，[codexNormalizer.ts](/home/dan/projects/ai-client/src/agent-host/codexNormalizer.ts:505)。E4 里的 error 是对象，所以当前结果是泛化的 `"[object Object]"`，而不是 `Missing environment variable...`。
- E4 明确给出了两份相同 error 对象：

  - `error` 异步通知：[E4 fixture](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:129)；
  - `turn/completed.turn.error`：[E4 fixture](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:141)。

- E4 还明确说明 `turn/start` RPC 本身成功，[E4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:101)。测试若只驱动请求拒绝路径，会测错层。

具体错误场景：

- 实现者只在 `protocolErrors.test.ts` 加一个字符串匹配测试，却没有修改 `CodexNormalizer`/`CodexRuntime`。
- 或者只处理 `error` 通知，随后 `turn/completed` 又发出第二个泛化 `session.failed`。
- 或者只处理 `turn/completed`，用户要等终态才能看到错误，且前一帧仍被记为 unknown notification。
- 测试内联一个手写 `{message: ...}` 对象，根本没有引用 E4 中的双承载形状，形成“规则副本测试规则副本”的假绿。

具体改法建议：

- 将 E4 的 missing 与 present 两臂提取为真正的机器 fixture，例如：

  `src/agent-host/__tests__/fixtures/codex/e4-missing-envkey.jsonl`  
  `src/agent-host/__tests__/fixtures/codex/e4-present-envkey.jsonl`

  测试必须通过 `readFileSync` 读取该 fixture；docs 只做报告，不应在 Vitest 里解析 Markdown 代码块。
- 定义一个生产纯函数，例如 `classifyCodexTurnError(error): {code,message}|null`，同时供 `error` 通知和 `turn/completed.turn.error` 使用。
- 匹配条件至少应钉：

  - `message` 包含或以 `Missing environment variable:` 开头；
  - 且明确包含固定变量名 `AICLIENT_CODEX_API_KEY`；
  - `codexErrorInfo === "other"`；
  - 对通知臂可同时要求 `willRetry === false`。

- 规格必须裁定 exactly-once：

  - 第一份 `error` 通知产生具名 `codex_credentials_missing` 后；
  - 后续相同 `turn/completed` 只负责关闭 turn，不得再产生第二个不同错误。

- 必测三臂：

  1. E4 missing：两种 carrier 都命中同一 code，最终只对 renderer 发一次错误；
  2. E4 present/network：`Reconnecting...` + `responseStreamDisconnected` 不得误判凭据缺失；
  3. 泛 `codexErrorInfo:"other"` 但 message 不匹配：不得误判。

---

### B5 — §2.4 `--strict-config`：所谓“复用仓内 Codex 0.145.0”不实，当前验收无法在干净环境稳定执行

规格位置：

- [施工规格 §2.4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:85)要求生成配置实际执行 `--strict-config`，并称“复用仓内 codex 0.145.0”。

仓内实证：

- 根测试命令只是 `vitest run`，[package.json](/home/dan/projects/ai-client/package.json:30)。
- 根依赖中没有 `@openai/codex`；独立 Agent Host 依赖也只有 Claude SDK 与 Cometix，[src/agent-host/package.json](/home/dan/projects/ai-client/src/agent-host/package.json:17)。
- build workflow 仅安装根依赖并构建，[build.yml](/home/dan/projects/ai-client/.github/workflows/build.yml:40)；Linux Agent Host 也只是 `npm ci` 后构建，[build.yml](/home/dan/projects/ai-client/.github/workflows/build.yml:218)。所有 workflows 中均没有 Codex 安装、版本检查或 Vitest 门禁。
- 仓内 fixture 只记录它们来自 0.145.0，例如 [fixtures README](/home/dan/projects/ai-client/src/agent-host/__tests__/fixtures/codex/README.md:13)；fixture provenance 不等于仓内拥有可执行文件。
- 当前机器确实有 Codex，本次实跑：

  ```text
  /home/dan/.nvm/versions/node/v24.18.0/bin/codex
  codex-cli 0.145.0
  ```

  但命令同时出现只读文件系统 PATH alias warning。该本机安装不是仓库依赖，不能作为 CI/新开发机前提。
- 仓内有 Vitest 调外部命令的先例，但只是依赖 CI 必有的 Git：`execFileSync('git', ['ls-files', ...])`，[moduleCaseCollisions.test.ts](/home/dan/projects/ai-client/src/shared/__tests__/moduleCaseCollisions.test.ts:56)。ShellDetector 的 spawn 则是 mock，不是实跑外部 Codex。

具体改法建议：

- 规格先决定 hermetic 策略，以下二选一：

  1. 将 `@openai/codex@0.145.0` 固定为测试依赖，测试通过仓内已安装包解析 `bin/codex.js`，并在启动前断言 `codex --version` 精确为 0.145.0；
  2. 增加专用、版本固定的测试资源获取脚本和缓存，CI 明确安装后再跑 strict-config。

- 禁止“找得到就跑、找不到就 `it.skip`”；那会让最需要验证的干净 CI 正好跳过承重断言。
- 测试应使用临时 `CODEX_HOME`，生成配置写入其中，执行真实 `--strict-config`；同时断言子进程退出状态和 stderr 中没有 `unknown configuration field`。
- workflow 必须实际加入该门禁；否则“测试写了”仍不代表验收链会执行。

---

### B6 — §1 S3b + §2.4 PTY：没有规定 Main 注入相对 renderer `options.env` 的覆盖顺序，且 flag-off“全缺席”与现有环境继承契约冲突

规格位置：

- [施工规格 §1 S3b](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:39)只说在本地 PTY 分支向 `options.env` 注入 key/home，没有规定合并方向。
- [施工规格 §2.4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:91)要求 finalEnv 三键在、renderer payload 无 secret、flag off 全缺席。
- 必选变异又要求“PTY 注入走 renderer payload”可被杀死，[施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:94)，但没有给生产接缝测试形状。

仓内实证：

- `SessionCreateOptions.env` 是共享 IPC 类型，可由 renderer 传入任意 `Record<string,string>`，[session.ts](/home/dan/projects/ai-client/src/shared/types/session.ts:4)。
- IPC handler 原样把 renderer options 交给 SessionManager，[main/ipc/session.ts](/home/dan/projects/ai-client/src/main/ipc/session.ts:28)。
- 当前本地分支又原样把同一个 options 交给 PtyManager，[SessionManager.ts](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:371)。
- Pty finalEnv 的顺序是：

  `process.env → proxy env → options.env → TERM/COLORTERM/LANG/LC_ALL`

  见 [PtyManager.ts](/home/dan/projects/ai-client/src/main/services/terminal/PtyManager.ts:377)。

因此：

- 如果实现写成 `{...managedEnv, ...options.env}`，renderer 提供的同名值会覆盖 Main 的 `CODEX_HOME/API_KEY`。
- 如果 flag off 只是不向 `options.env` 增键，`process.env` 中原有的 `CODEX_HOME` 或 `AICLIENT_CODEX_API_KEY` 仍会出现在 finalEnv；“全缺席”并不成立。
- 反过来，如果为了满足“全缺席”而无条件删除用户原有 `CODEX_HOME`，又会破坏 flag-off 的今天行为。
- `CLAUDE_CONFIG_DIR` 更明确：dev.js 在 managed flag 为 0 时仍可能生成隔离目录并放进 child env，[dev.js](/home/dan/projects/ai-client/scripts/dev.js:229)；S2 已把 flag-off 等价性限定为“且 `CLAUDE_CONFIG_DIR` 未设置”，[S2 规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:113)。S3 rev.1 的无条件“flag off 全缺席”与此既有裁定冲突。

具体改法建议：

- 明确区分：

  - “本切片没有新增/覆盖该键”；
  - “最终 env 中该键绝对不存在”。

  flag-off 应采用前者，保持原 env 字节/键集，不应把用户已有 `CODEX_HOME` 删除掉。
- managed-on + vault-ok 时，Main 注入必须最后覆盖 renderer 同名值：

  ```ts
  env: {
    ...options.env,
    CODEX_HOME: managedCodexHome,
    AICLIENT_CODEX_API_KEY: vaultKey,
  }
  ```

- 不得修改传入的 `options`/`options.env` 对象；生成新对象并交给 PtyManager，这样可断言 IPC 输入仍无 secret。
- 生产接缝测试必须同时检查：

  1. fake IPC 输入对象不含哨兵 secret；
  2. `SessionManager` 调用 `localPtyManager.create` 时的新 options 含 Main 哨兵 secret；
  3. 输入对象调用后仍未被 mutation；
  4. renderer 预置冲突的 `CODEX_HOME/API_KEY` 时，Main 值胜出；
  5. remote path 不进入 local injection；
  6. flag off 时输出相对输入零变异，而不是武断断言所有相关键不存在。

## 2. major（不阻塞开工但显著影响咬合力/可验证性，需在本切片内补）

### M1 — §2.4 变异计划数量不足：规格要求至少 8 对，但只命名了 6 对，剩余两对无法预审 old/new 唯一性

规格位置：

- [施工规格 §2.4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:94)写“变异 ≥8 对”，括号中只有六项：

  1. 模式信号误读 flag；
  2. 生成模式仍拷 auth.json；
  3. 上下文键写进 provider 表；
  4. 剥 env 漏 `ANTHROPIC_`；
  5. PTY 注入走 renderer payload；
  6. `credentials_missing` 子串包含既有子串。

对六个已命名变异的两态可判性结论：

1. **模式信号误读 flag：当前不可判。**

   “flag”没有指明是 `AICLIENT_AGENT_CODEX` 还是 `AICLIENT_MANAGED_CREDENTIALS`，且 rev.1 拒绝给 Host 透传 managed flag。必须给 mode resolver 构造相互矛盾输入，例如“feature flag on、managed marker off、base 存在”和“feature flag on、managed marker on、base 缺失”，才能杀死误读。仅测试 base 有/无，不能证明实现没偷读某个 flag。

2. **生成模式仍拷 auth.json：部分可判，但漏了历史 target。**

   fresh home + source auth 存在能杀死继续 copy 的实现；不能杀死“没有 copy、但遗留 target auth 未删除”。须补 B2 所述第二变异。

3. **上下文键写进 provider 表：可判，但断言必须扫全文件。**

   生成模式正确态应在整个 TOML 中都不存在 `model_context_window` 和 `model_auto_compact_token_limit`；不能只断言 root 没有。调查实证说明放在 provider 表时 strict-config 会报 unknown field，[02-codex-side-seams](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-mgmt-investigation/02-codex-side-seams.md:49)。

4. **剥 env 漏 `ANTHROPIC_`：可判，但需任意前缀键。**

   不应只测已知 `ANTHROPIC_API_KEY`。至少加入 `ANTHROPIC_FUTURE_SENTINEL`，否则实现若只列举今天两个键也会假绿。现有共享清单的语义就是前缀匹配，[credential-env-keys.test.mjs](/home/dan/projects/ai-client/scripts/__tests__/credential-env-keys.test.mjs:22)。

5. **PTY 注入走 renderer payload：按 rev.1 不可判。**

   单独断言 finalEnv 有 key，只能证明“有 key”，无法证明 key 在 IPC 之后才加入。须采用 B6 的输入对象/输出对象双面接缝或静态 ban + 接缝测试合取。

6. **reason 子串碰撞：可判，但当前测试先例不够。**

   现有测试只断言三个完整字符串的 `Set.size===3`，[agentSupport.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:157)。这不能杀死 `"credentials missing"` 与 `"managed credentials missing"` 这种完整字符串不同、但一方包含另一方的实现。新测试必须遍历所有 ordered pairs，断言 `a.includes(b) === false`。

具体改法建议：

- 在施工规格中列全至少 8 对，不把最后两对留给施工后临时决定。
- 建议补成：

  7. 生成模式未删除历史 target `auth.json`；
  8. Host/PTy 只“省略显式注入”但未清除/覆盖继承的 app-reserved env；
  9. E4 只处理 `error` 通知、不处理 `turn/completed` 或产生双错误；
  10. registry 在凭据纪元切换后仍复用旧 process/旧 registry。

- 每一对都应记录：正确态输入、变异态改动、唯一红灯断言。不能只写变异名称。

---

### M2 — §1 `credentials_missing`：缺少 probe/输入合同与凭据纪元测试，容易把 process.env 读取散到多个层次

仓内现状：

- `BuildHostAgentRegistryInput` 目前只注入 `env`、`probeEntry`、`prepareHome`，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:78)。
- 当前顺序测试实际检查 probe 调用次数与短路副作用，[agentSupport.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:77)。
- 真实接线 `getHostAgentRegistry()` 只注入 entry/home probe，env 默认读 `process.env`，[index.ts](/home/dan/projects/ai-client/src/agent-host/index.ts:214)。

问题：

rev.1 只给出目标顺序，没有决定凭据检查是：

- 在 `agentSupport.ts` 直接解析 env；
- 注入 `probeCredentials()`；
- 还是由 `prepareCodexHome()` 间接抛错。

第三种会把 `credentials_missing` 错折叠成 `home_prepare_failed`；直接散读 env 又容易使 mode resolver、runtime env 和 registry 各自形成一套判断。

具体改法建议：

- 定义一个纯解析函数，返回判别联合，而不是多个 boolean：

  ```ts
  type CodexCredentialMode =
    | { mode: 'fallback' }
    | { mode: 'managed'; baseUrl: string; apiKey: string }
    | { mode: 'managed_missing_credentials' };
  ```

- registry 与 `codexHome`/`codexRuntime` 都消费这一个解析结果或同一个解析 helper。
- 短路测试必须断言：

  - `flag_off` 不调用 credential/entry/home；
  - `credentials_missing` 不调用 entry/home；
  - `entry_missing` 不调用 home；
  - 成功才调用 home。
- registry memo 测试保留现有“同一 Host 环境翻转无效”断言，并新增 Main 凭据纪元重启断言；不要在同一模块测试里伪造 reset 代替真实重启链。

---

### M3 — §2.3 flag-off 等价断言需要拆成“回退功能等价”与“无新副作用”，不能只靠既有测试全绿

规格位置：

- [施工规格 §2.3](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:78)要求 flag off 逐字节回到今天行为。
- 当前 `codexHome` 的回退链已有较强测试，包括 allowlist、姿态、幂等、auth 轮换等。

已核实的现有覆盖：

- 精确 root/table allowlist：[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:190)、[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:334)。
- 多行/triple-quote 防泄漏：[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:260)。
- 强制 posture 的值、唯一性和 root 层级：[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:376)。
- 物化、0600 auth、幂等、轮换：[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:456)、[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:486)、[codexHome.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexHome.test.ts:542)。

但“既有测试零改动即绿”只能证明旧样本继续通过，不能证明新 mode 分支没提前触发、没删除 legacy auth、没改变 env。

具体改法建议：

- 回退测试应明确把 `AICLIENT_CODEX_MANAGED`、base、key 全设成有干扰性的组合，再断言 marker 缺席时仍走旧函数。
- 对同一 fake fs 输入分别跑“改造前 golden”和新 fallback，比较：

  - `config.toml` bytes；
  - `auth.json` bytes/mode；
  - writes/copies/chmods 调用序；
  - `EnsureCodexHomeResult` 旧字段。
- spawn env 回退臂应全对象比较，而不只检查某两个键仍存在。

---

### M4 — §2.4 spawn env：测试可以落在现有 connect harness，但规格应钉住该接缝，避免只测纯 helper 副本

仓内实证：

- create 路径在 [codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1263)进入共同 `openConnection`。
- revive 在 [codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2399)进入同一函数。
- cold resume 在 [codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2641)进入同一函数。
- 共同 env 构造点是 [codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1380)，当前全量继承 `process.env`。
- 最终真实 child spawn 原样使用传入 env，[codexConnection.ts](/home/dan/projects/ai-client/src/agent-host/codexConnection.ts:444)。
- 现有 runtime 测试已经能捕获 `connectInputs`，但目前只断言 `CODEX_HOME`，[codexRuntime.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/codexRuntime.test.ts:848)。

具体改法建议：

- 新测试直接断言 `connectInputs[0].env`，不要只测一个另写的 `buildCodexEnv()` helper。
- 生成模式测试输入至少包括：

  - `ANTHROPIC_API_KEY`；
  - `ANTHROPIC_BASE_URL`；
  - `ANTHROPIC_FUTURE_SENTINEL`；
  - 普通 `PATH/HOME`；
  - managed API key。

- 断言前三者全部不存在、普通变量保留、`CODEX_HOME` 和 managed key 精确覆盖。
- fallback 对同一 env 断言前三者逐字节保留。
- create/resume/revive 不必三套重复全矩阵，但至少需要结构断言三者都汇入同一个 env builder/openConnection，或各走一次 smoke，防后续某一路旁路共同接缝。

---

### M5 — §2.4 `hostEnv` 旧键集断言必须从“固定五键相等”升级成状态矩阵，而不是直接改掉旧测试期望

现有测试：

- [hostEnv.test.ts](/home/dan/projects/ai-client/src/main/services/agent-host/__tests__/hostEnv.test.ts:14)把返回对象钉成恰好五键。
- [hostEnv.test.ts](/home/dan/projects/ai-client/src/main/services/agent-host/__tests__/hostEnv.test.ts:25)明确断言不注入 Codex feature flag。
- 实际 AgentHostManager 调用只传固定五个输入，[AgentHostManager.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts:418)。

问题：

规格说“契约加两键”同时又说“hostEnv 旧键集断言不变”。如果只是把现有期望改成七键，就丢掉 flag-off 基线；如果完全不改旧测试，又可能根本没有测试 on/vault 矩阵。

具体改法建议：

- 保留当前五键 case 原样，作为 unmanaged/fallback golden。
- 增加 managed 输入联合后测试：

  - managed off，即使输入带 vault 值也只返回旧五键；
  - managed on + vault ok 返回旧五键 + marker/base/key；
  - locked/absent/invalid 返回的精确形状按 B1 新状态机执行；
  - inherited env 中有假 base/key 时，最终 child env 仍由本次状态决定。
- `AICLIENT_AGENT_CODEX` 仍不得由 `buildAgentHostEnv` 二次决定；它与 managed marker 必须在命名和测试中明确区分。

## 3. minor（可留待后续，附带一提）

### m1 — §2.2 sidecar 被列入配置形状，但验证计划没有任何 sidecar 断言

- [施工规格 §2.2](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:60)写“sidecar `.aiclient-generated` 记来源”。
- §2.4 的生成器验收只覆盖 TOML、strict-config、幂等和无 auth，[施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:85)，没有 sidecar 内容、权限、幂等或回退模式行为。

建议至少补：生成模式创建、fallback 不误创建、重复调用字节/mtime策略、模式切换是否保留/删除。它不是认证主链承重点，可以后补，但当前属于未验收交付物。

### m2 — `describeHostAgentReason` 的“既有纪律”被规格表述得比现有测试更强

- 生产三个字符串确实不同，[agentSupport.ts](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:151)。
- 但现有测试只验证完整字符串去重和各自含关键词，[agentSupport.test.ts](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:157)，并没有“任意一条都不包含另一条”的纪律。

因此“既有纪律”作为历史事实不准确；应改成“本片新增并升级为两两互不包含纪律”。不影响设计方向，但应避免施工者误以为已有 helper/断言可直接扩一项。

### m3 — `scripts/credential-env-keys.mjs` 当前不会剥掉两个 Codex 模式键；风险方向与规格关注相反

逐点结论：

- `AICLIENT_CODEX_API_KEY`：不会被共享清单匹配。
- `AICLIENT_CODEX_BASE_URL`：不会被共享清单匹配。
- `dev.js` 也不会额外剥它们。

证据见 [credential-env-keys.mjs](/home/dan/projects/ai-client/scripts/credential-env-keys.mjs:17)和 [dev.js](/home/dan/projects/ai-client/scripts/dev.js:194)。

因此“模式信号被 dev 剥死”按当前仓库是伪风险；真正风险是 B1：它们会从 shell/dev.env 被意外继承进 Host/PTy。若未来修改共享清单，现有“精确键集”测试 [credential-env-keys.test.mjs](/home/dan/projects/ai-client/scripts/__tests__/credential-env-keys.test.mjs:9)会红，但施工规格仍应明确这两个 app-internal 键由 Main 单独 sanitize，不要混入 Claude 凭据共享清单。

## 4. §3 裁定 a~f 逐条判真/伪

### a) “模式信号用 `AICLIENT_CODEX_BASE_URL` 存在性，而非透传 flag”

**裁定：伪。**

不是因为“误设 env 会误入生成模式”这一已知代价，而是因为它无法表达必要状态：

- base 缺席同时代表“legacy fallback”和“managed-on 但 vault 无凭据”；
- rev.1 又要求后者得到 `credentials_missing`；
- Main 对非 `ok` vault 同时省略 base/key，[施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:36)；
- 但 `credentials_missing` 只在 base 存在时定义，[施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:53)。

此外，Host spawn 全继承 `process.env`，[AgentHostProcess.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostProcess.ts:48)，所以“Main 注入即选型”也不是当前进程合同的真实描述。必须增加独立 managed marker 并清理继承值。

### b) “生成模式不写 `model` root 键，模型选择走 D40 会话协议”

**裁定：真。**

仓内 Codex runtime 已支持把会话模型放进 `thread/start`：

- `buildThreadStartParams` 接受 `model` 并仅在非空时写入 RPC，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:210)；
- create 路径把 `input.model` 传给 thread/start，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1479)。

因此托管配置不写 root `model` 是可执行的产品裁定。无显式会话模型时会使用 Codex 自己的默认模型，而不会保留用户 legacy config 的模型偏好；规格已如实登记该行为变化。

### c) “posture 每会话重生成节奏保留；agent-host 内跨进程写手唯一，无需队列”

**裁定：真，但只对 AiClient 的 `config.toml` 写手成立。**

证据：

- create 使用共同 `openConnection`，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1280)；
- revive 使用同一入口，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2407)；
- cold resume 使用同一入口，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2660)；
- `openConnection` 每次调用 `ensureCodexHome` 并传同一 posture 常量，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1355)；
- 当前配置写入是同步字节比较后同步写，[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:614)。

同一个 Host JS 进程中的同步写不会产生 managedFileWriter 那种 async read-modify-write 交错，因此无需同类队列。此裁定不等于“整个 codex-home 没有并发风险”；后者属于 e。

### d) “只在生成模式剥 `ANTHROPIC_*`；回退模式维持全继承”

**裁定：真。**

当前全继承是刻意为用户自定义 `model_providers.<id>.env_key` 保留的，[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1380)。回退模式继续投影用户 provider 表，也就必须继续支持任意用户 env_key。生成模式则把 env_key 固定为 `AICLIENT_CODEX_API_KEY`，[施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:66)，原保留理由消失。

前提是测试按 M4 同时证明：

- generated：全前缀剥离；
- fallback：逐字节全继承。

### e) “终端 Codex 与 app 会话共用 codex-home；跨进程并发与原生 `~/.codex` 场景同构”

**裁定：伪。**

“共用 codex-home”是明确产品决定，但“并发同构”不成立：

- App Host 在每次 create/resume/revive 前都会主动比较并可能重写 `config.toml`，[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:614)。
- 终端 Codex 同时把该目录作为自己的 `CODEX_HOME`，见施工规格的 PTY 注入要求 [施工规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:39)。
- 原生多个 Codex 进程共同使用 `~/.codex`，并不天然包含“另一个宿主在每次 app session 前重新生成 config.toml”的额外写手。
- 母规格自己也把 codex-home 并发列为风险 R7，[母规格](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:212)。

当前同步写和字节幂等可降低风险，但不能把两者称为同构。建议改为：“接受共享 home；AiClient 只在内容变化时原子/同步改写配置，终端并发风险作为已知限制并补并发 smoke。”生成实现若仍用普通 `writeFileSync`，还应考虑写临时文件后 rename，避免终端进程读取到半写内容。

### f) “turn 级错误映射只能靠 message 子串，因为 `codexErrorInfo` 无结构化缺凭据码”

**裁定：真，但 rev.1 的落地描述不完整。**

E4 实证：

- 缺变量错误的 `codexErrorInfo` 是字符串 `"other"`，[E4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:129)；
- present/network 对照则是结构化 `responseStreamDisconnected`，[E4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:171)；
- initialize/thread-start/turn-start 均成功，错误只在异步 turn 通知出现，[E4 结论](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:8)。

所以 message 匹配是当前版本不可避免的。但不应只匹配宽泛的 `"Missing environment variable"`；应同时钉固定变量名、`codexErrorInfo:"other"`，并覆盖 `error` 与 `turn/completed` 两个 carrier 及 exactly-once 去重。

## 5. 收口判语

**只改 blocker 能否开工：是。**

理由：六个 blocker 修完后，模式/凭据状态机、历史 auth 清理、凭据纪元屏障、PTY 覆盖顺序、E4 生产分类接缝和 strict-config 执行环境都将具备可实现且可验收的闭环；major 可以在本切片施工时同步补足测试咬合力，但不再要求重新推翻总体方案。


Codex session ID: 01a0067f-9924-7e32-990e-e3237ff76c4f
Resume in Codex: codex resume 01a0067f-9924-7e32-990e-e3237ff76c4f
