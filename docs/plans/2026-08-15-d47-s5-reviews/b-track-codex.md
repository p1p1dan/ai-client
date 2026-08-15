> D47 S5 规格 rev.1 双盲对抗评审 · B 轨（Codex，证据与可验证性镜头，2026-08-15）。原文归档。

结论先行：当前 rev.1 不可直接开工。规格存在 5 个 blocker：AuthState/IPC 字段契约自相矛盾、I9 对 S34 现结构的描述失实、Usage 的 Cookie 重试事实与 E5 实测相反、所谓“E5 双臂 fixture”并不存在机器可驱动形态、三入口 spawn 门禁遗漏 agent-host 的静默 revive 新进程路径。另有 4 组必选变异按现规格无法可靠区分正确态与变异态。

本次全程只读。最终 `git status --short` 和目标文件 `git diff --exit-code` 均无输出，未修改规格、代码或测试。

## 1. Blocker（阻塞开工的问题）

### B1. AuthState 的权威字段、IPC 快照和 `lastEmail` 数据路径互相矛盾，无法据此实现共享类型

【规格位置】

- S5a 要求扩展 S1 `AuthStateService`：[S5 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:13)，第 13–18 行。
- IPC 快照被定义为 `kind/email/remoteHealth/reason`，明确未列 `lastEmail`：[S5 规格第 23–25 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:23)。
- spawn 门禁却读取 `getState().kind`：[S5 规格第 31–33 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:31)。
- renderer 又要求从 `auth.getState().lastEmail` 预填邮箱：[S5 规格第 39–52 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:39)。

【对应 file:line 证据】

- S1 已落地的权威判别字段是 `status`，不是 `kind`；三个联合臂分别为 `signed_out`、`authenticated`、`credentials_invalid`：[AuthStateService.ts:25](/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts:25)，尤其第 29–32 行。
- 当前 `authenticated` 状态只有 `remoteHealth`，没有 `email`；`signed_out`/`credentials_invalid` 也没有 `lastEmail`：[AuthStateService.ts:29](/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts:29)。
- `getState()` 只是返回现有内存快照：[AuthStateService.ts:79](/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts:79)。
- vault 在登出后的 `payload:null` 状态会把磁盘上的 `lastEmail` 丢出 `read()` 结果，只返回 `{status:'absent'}`；源码还明确写着需要未来切片增加专用 accessor：[CredentialVault.ts:207](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:207)。
- S1 as-built 也明确登记“lastEmail 取回留待 S5 专用 accessor”：[S1 规格 §6 第 181–184 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s1-vault-spec.md:181)。

【核验结论】

规格所述与实际不符。S1 的状态字段实际是 `status`，规格却同时使用 `kind`；规格一处定义 IPC 快照没有 `lastEmail`，另一处又要求 renderer 读取 `auth.getState().lastEmail`。当前 Vault API 也无法在正常登出后的 `absent` 状态取回磁盘上保留的 `lastEmail`。

这不是措辞问题，而是共享类型、Main 门禁、IPC、Root、UserProfileCard 和 OnboardingView 都要依赖的中心协议无法确定。若不同施工点分别猜测，会直接形成 `status`/`kind`、`email`/`lastEmail` 的多套协议。

【建议改法】

在规格中先给出唯一、完整的共享判别联合，例如：

```ts
type AuthState =
  | {
      status: 'signed_out';
      reason: 'never' | 'logout';
      lastEmail: string | null;
    }
  | {
      status: 'authenticated';
      email: string;
      remoteHealth: 'unknown' | 'valid';
    }
  | {
      status: 'credentials_invalid';
      reason: 'rejected' | 'corrupt' | 'decrypt_failed';
      lastEmail: string | null;
    };
```

随后明确：

1. 全仓继续使用 S1 已落地的 `status`，禁止另引 `kind`。
2. `auth.getState` 和 `auth.stateChanged` 使用同一个共享联合类型。
3. Vault 增加明确的 `readLastEmail()` 或等价 envelope-metadata accessor；不能假设 `read()` 在 `payload:null` 时会返回 `lastEmail`。
4. `refresh()` 保持 S1 的无参兼容签名，或者明确给出新签名、调用点及旧调用迁移方式。
5. 为 `email` 与 `lastEmail` 分别定义语义：前者是当前已认证身份，后者是失效/登出后的表单预填信息。

---

### B2. I9 规格把“host shutdown await”错误描述成 S34 已有的独立步骤；现实现中它嵌套在 regenerate 之后，不能只在 IPC handler 中重排

【规格位置】

- S5 声称 `onboarding.ts` LOGOUT handler 可直接重排成七步，并把第 ③ 步描述为“S34 已有”的 host shutdown await：[S5 规格第 26–30 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:26)。
- 母规格 I9 的真实要求是：关 gate → 终止会话 → shutdown host → 清 vault → regenerate → 清 cookie → 广播：[母规格 I9](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:28)。
- S34 只承诺“登出在 IPC handler 内 await”，并明确“完整 I9 七步仍归 S5”：[S34 规格第 83–87 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:83)。

【对应 file:line 证据】

当前 IPC 顺序是：

1. `terminateAllSessions()`；
2. 同步调用 `onboardingService.logout()`；
3. `awaitPendingLogoutRegenerate()`；
4. `clearServerAuthCookie()`；
5. 返回。

见 [main/ipc/onboarding.ts:110](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:110)，尤其第 114–136 行。

而 `logout()` 内部实际顺序为：

- 先 `removeClaudeCredentials()`；
- 立即启动 `regenerateManagedHomesForLogout()` 的异步 Promise；
- `removeCodexConfig()`；
- 写 onboarding false；
- fire-and-forget `clearVaultShadowCopy()`。

见 [OnboardingService.ts:340](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:340)，尤其第 342–363 行。

更关键的是，S34 的 host shutdown 位于 regenerate 之后：

```text
regenerateManagedClaudeHomeSettings(null)
→ regenerateManagedCodexHomeConfig(null, 'logout')
→ shutdownAgentHostAfterRegenerate()
```

证据为 [OnboardingService.ts:382](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:382)，第 388–395 行。

Vault clear 仍是不可等待的 fire-and-forget：

- `void getCredentialVault().clear({keepLastEmail:true})`：[OnboardingService.ts:397](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:397)，尤其第 403–405 行。

【核验结论】

规格所述与实际不符。

S34 已落地的不是“可在 handler 中自由移动的 host shutdown 步骤”，而是“handler 等待一个内部顺序固定为 regenerate → shutdown 的 Promise”。按 rev.1 字面只改 `onboarding.ts`，无法得到 I9 的 host-before-vault-before-regenerate 顺序。

如果另在 handler 中提前调用 shutdown，而不拆除旧链，后续 `logout()` 仍会再启动 regenerate→shutdown，形成重复 shutdown 和所有权混乱。若只保留当前 `awaitPendingLogoutRegenerate()`，顺序依然反着。

【建议改法】

规格必须明确重构所有权，而非只写“handler 重排”：

1. 把 `OnboardingService.logout()` 的复合副作用拆成可等待步骤，或新增单一 `performLogoutSequence()` 纯编排入口。
2. `beginLogout()` 必须先同步关闭 spawn gate。
3. 明确暴露并等待 host shutdown；移除 `regenerateManagedHomesForLogout()` 内部尾部的旧 shutdown。
4. 将 Vault clear 改为真正 `await` 的操作；“不影响 logout 布尔结果”可以通过捕获错误实现，不能继续 fire-and-forget。
5. regenerate 必须在 vault clear 完成之后开始。
6. 七步测试必须驱动真实生产编排函数，不得另写规则副本。
7. 测试除精确调用数组外，还要用 deferred Promise 证明每一步没有越过前一步的异步 barrier。

---

### B3. UsageService 的“cookie 重试链”行为事实失实；现测试把 `auth-token` 当 Bearer，正好与 E5 真机结果相反

【规格位置】

- S5 说现有链是“bearer 401 → cookie login 重试”，并表示 `/api/actions` 债务本片不动：[S5 规格第 19–22 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:19)。
- S5 的 GUI 验收又要求 UserProfileCard 用量可用：[S5 规格第 71–74 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:71)。
- E5 最终真机结论明确：有效 bearer 调 actions 仍为 401，只有 `auth-token` Cookie 才为 200：[E5 第 325–334 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:325)。

【对应 file:line 证据】

现有链前半段属实：

- 首次 actions 请求带 API key Bearer：[UsageService.ts:205](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:205)。
- 401/403 后调用 `/api/auth/login`：[UsageService.ts:216](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:216)。

但“cookie 重试”不属实：

- 登录函数提取 `Set-Cookie` 中的 `auth-token` 值：[UsageService.ts:105](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:105)。
- `postAction()` 的 token 参数只会变成 `Authorization: Bearer ...`：[UsageService.ts:111](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:111)，尤其第 120–128 行。
- 登录成功后把提取到的 session cookie 值作为 bearer 再请求 actions：[UsageService.ts:224](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:224)。
- 只有 fetch 不暴露 `Set-Cookie`、即 `sessionId` 为空时，才会无 Authorization 地依赖 cookie jar 重试：[UsageService.ts:234](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:234)。

现有测试甚至将错误行为钉死：

- fixture 返回 `Set-Cookie: auth-token=opaque-session-1`：[UsageService.test.ts:227](/home/dan/projects/ai-client/src/main/services/usage/__tests__/UsageService.test.ts:227)。
- 随后断言第 3 次 actions 请求必须是 `Authorization: Bearer opaque-session-1`：[UsageService.test.ts:268](/home/dan/projects/ai-client/src/main/services/usage/__tests__/UsageService.test.ts:268)。

E5 的对应真实结果则是：

- 有效 login 为 200，并设置 `auth-token` Cookie；
- 有效 bearer 请求 actions 仍 401；
- 带 Cookie 重试才 200。

见 [E5:327](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:327)。

【核验结论】

规格所述与实际不符。代码确实有 login 分支，但没有正确的 Cookie 重试；现测试固化的是被 E5 推翻的假协议。

这会造成两个直接后果：

1. 有效用户登录成功后，UsageService 仍可能返回 401，S5 的 UserProfileCard 用量 GUI 验收无法通过。
2. 如果施工者相信“cookie 链已经存在、actions 债务不动”，只加 KEY_INVALID 上报而不修重试载体，会保留已证伪行为。

【建议改法】

在 S5 施工范围中显式加入：

- login 成功后，actions 重试必须使用 Electron session cookie jar，或明确发送 `Cookie: auth-token=...`；不得把 cookie value 转成 Bearer。
- 修改现有 `opaque session` 测试，使第三次请求断言“不含 Authorization”并实际消费 cookie，或断言显式 Cookie header。
- 加负控：有效 bearer 401 + login 200 + cookie actions 200，最终返回 usage 且不调用 `markRejected()`。
- 加失效臂：业务 401 + login 401/`KEY_INVALID`，才调用 `markRejected()`。
- 删除或改写“`/api/actions` 债不动”的措辞：端点迁移到 `/api/v1` 可以不做，但当前 Cookie 载体错误必须在本片修正。

---

### B4. 规格声称存在“E5 双臂 fixture”，但仓内只有 Markdown 人读证据，没有独立机器 fixture 或测试加载路径

【规格位置】

- S5 把失效权威称为“E5 双臂 fixture”：[S5 规格第 61–65 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:61)。
- 验证计划要求“probe 双臂 fixture（E5 字节）”：[S5 规格第 78–81 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:78)。

【对应 file:line 证据】

E5 文件确实包含真实证据，但只是 Markdown 代码块和文字：

- invalid login 字节在 [E5:174](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:174)，响应为第 181–188 行的 401 JSON。
- valid arm 只在文档末尾以三条摘要记录：[E5:325](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:325)。
- 文档内分类器也只是伪码代码块：[E5:263](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:263)。

全仓测试搜索没有找到 `KEY_INVALID`、E5 fixture 加载、`beginLogout`、`auth_required` 或对应 S5 fixture 测试。

与之相反，S34 的 E4 给出了真正可执行的先例：

- S34 明确要求独立 JSONL 文件，并禁止 vitest 解析 Markdown：[S34 规格第 57–60 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:57)。
- 实际 E4 JSONL 位于 [e4-missing-envkey.jsonl:1](/home/dan/projects/ai-client/src/agent-host/__tests__/fixtures/codex/e4-missing-envkey.jsonl:1)。
- 测试通过 `replay(..., 'e4-missing-envkey.jsonl')` 驱动生产 normalizer：[codexNormalizer.test.ts:602](/home/dan/projects/ai-client/src/agent-host/__tests__/codexNormalizer.test.ts:602)。
- fixture README 还登记了来源、帧数和用途：[fixtures/codex/README.md:222](/home/dan/projects/ai-client/src/agent-host/__tests__/fixtures/codex/README.md:222)。

【核验结论】

规格声称的机器 fixture 在仓内不存在。现有 E5 Markdown 是事实底稿，但不能被测试直接稳定驱动；S5 也没有指定：

- fixture 文件路径；
- schema；
- header/body/status 如何编码；
- 生产分类函数的注入接缝；
- 测试如何证明消费的是 fixture 而非手抄规则副本。

按照本次评审约束，“声称存在但无法找到的引用”本身是 blocker。

【建议改法】

比照 E4 建立独立 fixture，例如：

```text
src/main/services/auth/__tests__/fixtures/e5-auth-login-valid.json
src/main/services/auth/__tests__/fixtures/e5-auth-login-key-invalid.json
src/main/services/auth/__tests__/fixtures/e5-actions-valid-bearer-unauthorized.json
src/main/services/auth/__tests__/fixtures/e5-actions-cookie-success.json
```

每个 fixture 至少包含：

```ts
{
  request: {
    endpoint: "/api/auth/login",
    authMode: "json-key" | "bearer" | "cookie"
  },
  response: {
    status: number,
    headers: Record<string, string>,
    bodyText: string
  }
}
```

测试必须：

1. `readFileSync` 加载独立 fixture，而不是从 Markdown 抽取。
2. 把 fixture 响应传给生产 `classifyAuthLoginResponse()` 或真实 `loginForActionsSession()` 接缝。
3. 断言 valid/invalid 两臂各至少加载一个样本，避免空集合通过。
4. 保留业务 401 fixture，证明它不会直接进入 `markRejected()`。
5. README 标明字节来源为 E5 文档相应段落。

---

### B5. “只拦三个 Main 入口、不拦 agent-host 内部路径”与现有 Codex 静默 revive 冲突，也违反母规格“失效必须 shutdown Host”

【规格位置】

- S5 只列三处门禁：`CHAT_CREATE_SESSION`、`CHAT_RESUME_SESSION`、`SessionManager.create`：[S5 规格第 31–33 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:31)。
- §4.c 主动提出“只拦三入口，不拦 agent-host 内部路径”：[S5 规格第 90–94 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:90)。
- 母规格 I5 明确要求登录、登出、失效都必须 `agentHostManager.shutdown()`：[母规格 I5](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:24)。

【对应 file:line 证据】

三个 Main 外部入口确实是当前 S2 trust 的三个咽喉：

- Chat create：trust → record → Host create：[chat.ts:66](/home/dan/projects/ai-client/src/main/ipc/chat.ts:66)，第 85–90 行。
- Chat resume：trust → record → Host resume：[chat.ts:131](/home/dan/projects/ai-client/src/main/ipc/chat.ts:131)，第 145–150 行。
- Terminal/session local create：remote 分支之后，trust → `createLocal`：[SessionManager.ts:127](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:127)。

但 agent-host 内部另有真实的新进程入口：

- 当 idle sweeper 已回收 Codex 进程时，下一次 `send()` 会在任何后续状态检查之前调用 `reviveSweptSession()`：[codexRuntime.ts:2313](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2313)，尤其第 2315–2324 行。
- `reviveSweptSession()` 明确执行“spawn、handshake、thread/resume”：[codexRuntime.ts:2446](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2446)。
- 它直接调用 `openConnection({why:'session.revive'})`，即真实启动新 Codex 连接/进程：[codexRuntime.ts:2462](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2462)，尤其第 2470–2474 行。

S5 的 `markRejected()` 描述只写入 invalidatedAt 并转状态，没有要求在失效转移中 await Host shutdown：[S5 规格第 13–18 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:13)。

【核验结论】

规格所述“三个入口覆盖 spawn”只对 Main 外部 create/resume/terminal create 成立；对整个产品的“新进程产生面”不成立。

已存在的 Codex revive 会在用户对旧会话再次发送时静默重开进程。如果 AuthState 已转为 `credentials_invalid`，但 Host 没有被 shutdown，Main 的三个门禁不会经过这条内部路径。

这同时暴露了另一个缺口：母规格 I5 明确要求“失效必 shutdown Host”，S5 rev.1 没有把 `markRejected()` 与 Host shutdown 接起来。

【建议改法】

二选一，并在规格中明确裁定：

1. 推荐：`markRejected()` 的编排调用方在状态广播前 `await agentHostManager.shutdown()`，使现有 Host 和 revive 资格一起消失；随后 Main 三入口 gate 阻止重新创建。这样无需让 agent-host 读取 Main AuthState。
2. 若允许 Host 在 invalid 状态继续存在，则必须将 auth epoch/gate 下发 agent-host，并在 revive/openConnection 前拦截；这会扩大协议面，不如方案 1 简洁。

必须新增测试：

- 先建立可 revive 的 swept session；
- 触发 `credentials_invalid`；
- 再 send；
- 断言没有第二个 connection/process；
- 断言用户收到 `auth_required` 或等价可操作错误；
- 断言不能仅因外部 create/resume 测试通过而判定整个 spawn gate 完成。

---

### B6. “变异六必选”中至少四组没有可执行的唯一红断言，存在明显假绿

【规格位置】

- S5 要求变异至少 8 对，必须包含六项：[S5 规格第 85–86 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:85)。
- 同一规格却明确排除组件 render 级测试：[S5 规格第 56–59 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:56)。

【对应 file:line 证据】

- 当前项目没有 Testing Library/renderHook 依赖；`package.json` 只列 Vitest：[package.json:30](/home/dan/projects/ai-client/package.json:30)、[package.json:110](/home/dan/projects/ai-client/package.json:110)。
- `useManagedMode` 测试明确承认没有 renderHook 基建，只测试纯常量形状：[useManagedMode.test.ts:4](/home/dan/projects/ai-client/src/renderer/hooks/__tests__/useManagedMode.test.ts:4)。
- `OnboardingView` 的 email 当前固定初始化为空字符串：[OnboardingView.tsx:163](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:163)，第 169–170 行。
- 现有 `shellSwitchStatic` 有典型的空集合扫描：收集 offenders 后断言 `[]`：[shellSwitchStatic.test.ts:43](/home/dan/projects/ai-client/src/renderer/App/__tests__/shellSwitchStatic.test.ts:43)。这种形态适合禁止项扫描，但不能天然证明 S5 的正路径确实被驱动。
- S34 的合格变异格式会逐对给出“正确态输入 / 变异改动 / 唯一红断言”：[S34 规格第 120–131 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s34-codex-terminal-spec.md:120)；S5 只有六个变异名称，没有这一层定义。

【核验结论】

规格当前没有把必选变异转为可执行测试契约。具体结果见本文第 5 节：六项中只有“业务 401 直接上报”在补齐 fixture 后较容易形成强判定；其余多项可能两态都绿、两态都红，或根本没有测试接缝。

【建议改法】

像 S34 一样，为每一对写出四列：

| 正确态输入 | 生产变异 | 必须变红的唯一断言 | 非空/接缝证明 |
|---|---|---|---|

特别要求：

- spawn 变异必须是“入口 × 状态”矩阵，不是只测四个状态。
- 预填变异必须抽出纯函数，例如 `deriveOnboardingEntry(authState)`，再由静态接线测试证明 Root/OnboardingShell 实际使用该函数；否则不允许以“无 render 测试”为由宣称变异已杀死。
- 所有扫描必须先断言扫描文件数或候选数 `> 0`。
- mutation runner 必须修改生产 helper，而不是测试里的规则副本。

## 2. Major（严重但不阻塞开工的问题）

### M1. Root 双轨的首帧模式选择没有定义；直接复用 `useManagedMode` 会把 flag-off 首帧误当 flag-on

【规格位置】

- Root flag-on 走 `auth.getState`，flag-off 走旧两 query：[S5 规格第 39–43 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:39)。
- §4.d 声称“门禁收回无 flag、Root 收敛有 flag”的过渡需要评审：[S5 规格第 92–94 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:92)。

【对应 file:line 证据】

- 当前 Root 确实有四条 query：
  - onboarding：[Root.tsx:138](/home/dan/projects/ai-client/src/renderer/Root.tsx:138)
  - cli：[Root.tsx:146](/home/dan/projects/ai-client/src/renderer/Root.tsx:146)
  - credentialsHealth：[Root.tsx:160](/home/dan/projects/ai-client/src/renderer/Root.tsx:160)
  - runtime：[Root.tsx:171](/home/dan/projects/ai-client/src/renderer/Root.tsx:171)
- 现成 renderer 模式 hook 在 IPC 返回前故意默认 `{managed:true}`：[useManagedMode.ts:8](/home/dan/projects/ai-client/src/renderer/hooks/useManagedMode.ts:8)，第 16、18–30 行。
- S1 AuthState 在真实 flag-off 下恒 `signed_out`，且不会读旧链：[AuthStateService.test.ts:144](/home/dan/projects/ai-client/src/main/services/auth/__tests__/AuthStateService.test.ts:144)。

【问题描述】

这是评审者推断，但由上述代码直接导出：如果 Root 用 `useManagedMode().data.managed` 立即选择双轨，真实 flag-off 的首帧仍会走 flag-on `auth.getState`；而 S1 AuthState flag-off 必然返回 `signed_out`。结果可能短暂显示登录页、发出错误 query，随后 managedMode IPC 返回 false 又切回旧链。

【建议改法】

Root 必须在模式 query resolve 前停留于 `LoadingShell`，不能使用 Provider UI 那个安全默认直接选 auth 轨；更好的办法是新增一个 Main 原子返回：

```ts
auth.getGateSnapshot(): {
  managed: boolean;
  state: AuthState | null;
}
```

从同一次 Main 判定中决定轨道和状态，避免先取 managedMode、后取 authState 的竞窗。至少要有纯状态机测试覆盖：

- 未 resolve；
- resolve managed on；
- resolve managed off；
- resolve 前收到 auth.stateChanged；
- resolve off 后不得消费 S1 的恒 signed_out 快照。

---

### M2. `resolveSkipAuthGate(env)` 的签名不足以表达 renderer/Main 两套打包条件，静态测试“改锚”也没有定义语义断言

【规格位置】

- 常量退役为 `resolveSkipAuthGate(env)`，renderer 用 `import.meta.env.DEV`，Main 用 `!app.isPackaged`：[S5 规格第 44–48 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:44)。

【对应 file:line 证据】

- 当前 shared 文件只是无参数硬编码常量：[devFlags.ts:1](/home/dan/projects/ai-client/src/shared/devFlags.ts:1)。
- 当前生产读者只有：
  - Root import/分支：[Root.tsx:127](/home/dan/projects/ai-client/src/renderer/Root.tsx:127)
  - MainWindow import/分支：[MainWindow.ts:6](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:6)、[MainWindow.ts:28](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:28)
- `shellSwitchStatic.test.ts:86` 的原断言确实是精确字面量：
  - [shellSwitchStatic.test.ts:84](/home/dan/projects/ai-client/src/renderer/App/__tests__/shellSwitchStatic.test.ts:84)。

【核验结论】

“Root/MainWindow 是全部生产读者”和“第 86 行需要改锚”均属实；没有发现第三个生产读者。测试中的其他 `SKIP_ONBOARDING_GATE` 命中只是注释/静态扫描。

但 `resolveSkipAuthGate(env)` 单靠 `env` 无法知道 renderer 的 `import.meta.env.DEV` 或 Main 的 `app.isPackaged`，除非调用方另传条件。规格没有定义这一参数，也没有定义第 86 行要锚到什么语义。

【建议改法】

定义纯函数：

```ts
resolveSkipAuthGate({
  env,
  isDevelopment,
}): boolean
```

调用方分别传：

- renderer：`isDevelopment: import.meta.env.DEV`
- Main：`isDevelopment: !app.isPackaged`

测试矩阵至少为：

| isDevelopment | env 值 | 结果 |
|---|---:|---:|
| false | `1` | false |
| false | 其他 | false |
| true | `1` | true |
| true | `true`/`yes`/空 | false |

`shellSwitchStatic` 不应只把一个字面量换成另一个字面量；应同时断言 Root 调用 resolver、Root 不直接读取环境变量、MainWindow 调同一个 resolver，并断言生产读者集合恰为预期文件。

---

### M3. UI 改动面漏列 `OnboardingShell` 和 `WindowTitleBar` 接线，且“预填/三态”没有可执行的组件级或纯模型测试

【规格位置】

- UserProfileCard 三态：[S5 规格第 49–50 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:49)。
- OnboardingView 增 `reason` 与邮箱预填：[S5 规格第 51–52 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:51)。
- 组件 render 测试本片不做：[S5 规格第 56–59 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:56)。

【对应 file:line 证据】

- UserProfileCard 当前 props 只有 `email`、`onRequestClose`：[UserProfileCard.tsx:60](/home/dan/projects/ai-client/src/renderer/components/user/UserProfileCard.tsx:60)。
- usage 任意错误目前统一显示“暂不可用”：[UserProfileCard.tsx:81](/home/dan/projects/ai-client/src/renderer/components/user/UserProfileCard.tsx:81)，第 85–119 行。
- WindowTitleBar 自己查询旧 `onboardingState`，并只在 `registered` 时显示 UserProfileCard：[WindowTitleBar.tsx:42](/home/dan/projects/ai-client/src/renderer/components/layout/WindowTitleBar.tsx:42)、[WindowTitleBar.tsx:119](/home/dan/projects/ai-client/src/renderer/components/layout/WindowTitleBar.tsx:119)。
- 它只给 UserProfileCard 传 email：[WindowTitleBar.tsx:143](/home/dan/projects/ai-client/src/renderer/components/layout/WindowTitleBar.tsx:143)。
- OnboardingView 当前没有 `reason` 或 `lastEmail` props，email 初始值恒为空：[OnboardingView.tsx:123](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:123)、[OnboardingView.tsx:169](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:169)。
- Root 实际渲染的是 `OnboardingShell`；Shell props 也没有 `reason`/`lastEmail`，且只转发四个旧 props：[OnboardingShell.tsx:6](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingShell.tsx:6)、[OnboardingShell.tsx:29](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingShell.tsx:29)。

【问题描述】

仅改 OnboardingView 不足以让 Root 传入 `reason`/`lastEmail`；`OnboardingShell` 是必改接线层，却不在 S5 文件清单中。UserProfileCard 三态也要求 WindowTitleBar 停止独立读取旧 onboarding query，转为消费 AuthState，否则 Root 收敛后标题栏仍保留第二套旧登录镜像。

【建议改法】

把以下文件明确加入交付物：

- `OnboardingShell.tsx`
- `WindowTitleBar.tsx`
- 可能的纯 UI 模型模块，例如 `authPresentation.ts`

抽纯函数测试：

```ts
deriveUserProfilePresentation(authState)
deriveOnboardingEntry(authState)
```

然后补静态接线测试，证明 Root、WindowTitleBar、UserProfileCard、OnboardingShell 使用这些生产 helper。这样即使没有 RTL，也能对三态、文案和预填实现有咬合力。

---

### M4. `auth_required` 当前只能作为错误文本进入通用错误卡；不存在可保真的具名错误码或“重新登录”动作

【规格位置】

- S5 称门禁返回“具名错误码 `auth_required`”，并说 renderer 已有报错卡通道：[S5 规格第 31–33 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:31)。

【对应 file:line 证据】

“已有可见错误卡”属实：

- preload 对 `chat.createSession` 只是直接 `ipcRenderer.invoke`，没有错误码转换：[preload/index.ts:1369](/home/dan/projects/ai-client/src/preload/index.ts:1369)。
- renderer 的 `sendMessage` catch 将 `err.message` 写入 `lastError`，并追加 `role:'error'` 消息：[chatSessions.ts:1062](/home/dan/projects/ai-client/src/renderer/stores/chatSessions.ts:1062)。
- MessageTimeline 将 error role 渲染成 `<Alert variant="error" role="alert">`：[MessageTimeline.tsx:751](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:751)。

但“具名错误码通道”不属实：

- 当前通路只可靠使用 `Error.message`；
- 没有 `auth_required` 的共享判别类型；
- 没有 renderer 分支识别它；
- 错误卡没有重新登录按钮，也不 dispatch `AUTH_OPEN_ONBOARDING_EVENT`。

【建议改法】

若只是显示文本，就不要把它描述为“具名错误码”；若确实需要代码语义，应定义可序列化结果或共享 IPC error envelope，例如：

```ts
{ ok: false, error: { code: 'auth_required', message: string } }
```

renderer 应对该 code：

1. 显示通用错误卡；
2. 提供“重新登录”按钮；
3. dispatch 共享 onboarding-open 事件；
4. 不能用英文内部码直接当用户文案。

## 3. Minor（细节、措辞与边界问题）

### m1. “四 query 收敛”表述容易误解为四条都删除

【规格位置】

- [S5 规格第 39–41 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:39)。

【证据】

当前四条确实是 onboarding、cli、credentialsHealth、runtime：[Root.tsx:138](/home/dan/projects/ai-client/src/renderer/Root.tsx:138) 至 [Root.tsx:176](/home/dan/projects/ai-client/src/renderer/Root.tsx:176)。

【问题描述】

实际目标是把 onboarding+credentialsHealth 两条替换为一条 authState，同时保留 cli/runtime，最终 flag-on 为三条，而不是“四条收成一条”。

【建议改法】

改写为：“四条 query 中，onboardingState 与 onboardingCredentialsHealth 合并为 authState；cliStatus/runtime 保留，flag-on 共三条。”

---

### m2. S1 的 flag-off 零 IO 与 S5 的“flag-off 走旧链”并不冲突，但规格应明确两者作用域

【规格位置】

- S5 Usage flag-off 读旧 Codex auth 文件：[S5 规格第 19–22 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:19)。
- Root flag-off 走旧 onboarding/health query：[S5 规格第 39–40 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:39)。
- flag-off 等价说明：[S5 规格第 66–69 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:66)。

【证据】

- S1 要求 AuthState flag-off 恒 signed_out、零文件 IO：[S1 规格 §2.4](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s1-vault-spec.md:88)。
- 实现确实在 `vault.read()` 前短路：[AuthStateService.ts:84](/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts:84)。
- 测试明确覆盖空 env 和 `'true'` 伪真值：[AuthStateService.test.ts:144](/home/dan/projects/ai-client/src/main/services/auth/__tests__/AuthStateService.test.ts:144)。

【判定】

规格所述基本属实，没有直接冲突。S5 的旧链应由 Usage/Root/MainWindow 自己走，不能通过 AuthStateService 去读取 legacy 文件。

【建议改法】

增加一句硬约束：“flag-off 不调用 AuthStateService 取得 legacy 登录状态；AuthStateService 保持 S1 的 signed_out/zero-IO，旧链由各兼容分支直接执行。”

---

### m3. E5 文档的旧伪码允许 `body.ok===false`，若被脱离 endpoint 复用会误判业务 401

【规格位置】

- S5 已正确收紧为 login 端点的 `401 + errorCode==='KEY_INVALID'`：[S5 规格第 63–65 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:63)。

【证据】

- E5 旧伪码仍写成 `errorCode === KEY_INVALID or body.ok == false`：[E5:270](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:270)。
- 业务端点的正常未带 Cookie 401 正是 `{ok:false,...}`：[E5:210](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:210)。
- E5 最终结论则明确 login 的 `401 KEY_INVALID` 才是唯一权威：[E5:331](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:331)。

【建议改法】

fixture/classifier 名称必须带 endpoint 语义，例如 `classifyAuthLoginResponse`；不要实现一个可接收任意业务响应的泛化 `classifyAuthProbe`，也不要保留 `body.ok===false` 作为 rejected 条件。

---

### m4. Usage 的上报挂点“概念上存在”，但当前 helper 丢失了 KEY_INVALID 判别数据

【规格位置】

- [S5 规格第 20–22 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:20)。

【证据】

- 现结构确有 `if (!login.ok)` 分支，可作为上报位置：[UsageService.ts:218](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:218)。
- 但 `loginForActionsSession()` 失败结果只有 `{ok:false,error:string}`，没有 status/errorCode：[UsageService.ts:81](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:81)、[UsageService.ts:96](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:96)。
- 现测试也只断言错误文本和两次 fetch：[UsageService.test.ts:154](/home/dan/projects/ai-client/src/main/services/usage/__tests__/UsageService.test.ts:154)。

【建议改法】

规格应钉死 helper 结果联合，而非只写“上报”：

```ts
type LoginForActionsResult =
  | { ok: true }
  | { ok: false; rejection: 'key_invalid'; error: string }
  | { ok: false; rejection: 'unknown'; error: string };
```

只有 `rejection:'key_invalid'` 可以调用 `markRejected()`。

## 4. 规格 §4 裁定 a~e 逐条判定

### a) “失效信号只挂 usage 心跳，不自建轮询”

判定：部分真。

支撑证据：

- `useUsageStats` 当前确实有 5 分钟 `refetchInterval`：[useUsageStats.ts:4](/home/dan/projects/ai-client/src/renderer/hooks/useUsageStats.ts:4)，尤其第 13–17 行。
- 调查文档也确认这是现成 5 分钟链：[调查 03:27](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-mgmt-investigation/03-login-ui-ipc-surface.md:27)，尤其第 30–34 行。

保留意见：

- 当前 Usage Cookie 重试实际错误，见 B3；在修正前它不能作为可靠心跳。
- “同一 unknown 期不重复打”的退避与“每 5 分钟 heartbeat”之间需要明确状态机：是每轮业务请求仍发生、只抑制额外 probe，还是整个 Usage 请求都退避。S5 第 65 行只写结果，没有定义定时关系。
- 登录/登出应主动 refresh；不能等待 5 分钟心跳，这一点规格第 14 行已有意图，但需要测试钉死。

因此“不另建轮询”可以成立，但必须先修复 Cookie 链并明确退避范围。

---

### b) “checkCredentialsHealth IPC 保留兼容，renderer 契约不动，S6 清”

判定：真，但需补映射表。

支撑证据：

- 当前 handler 确实存在并直接返回 `onboardingService.checkCredentialsHealth()`：[onboarding.ts:65](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:65)。
- Root 当前实际消费它：[Root.tsx:160](/home/dan/projects/ai-client/src/renderer/Root.tsx:160)。
- 调查文档列出的主要消费路径与当前代码相符：[调查 03:62](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-mgmt-investigation/03-login-ui-ipc-surface.md:62)。

兼容方案技术上可行，但规格应明确 AuthState 到旧 `{claudeEnvOk,codexAuthOk,reason?}` 的逐态映射，并保证 flag-off 仍调用原 service；否则“renderer 契约不动”只是口号。

---

### c) “spawn 门禁只拦三入口，不拦 agent-host 内部路径”

判定：伪。

支撑/反驳证据：

- 三个 Main trust 咽喉确实存在：[chat.ts:66](/home/dan/projects/ai-client/src/main/ipc/chat.ts:66)、[chat.ts:131](/home/dan/projects/ai-client/src/main/ipc/chat.ts:131)、[SessionManager.ts:127](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:127)。
- 但 Codex `send()` 可在 state 不存在、session 可 revive 时先静默重开进程：[codexRuntime.ts:2313](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2313)。
- revive 明确执行 spawn/handshake/thread-resume：[codexRuntime.ts:2446](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:2446)。
- 母规格 I5 要求凭据失效必须 shutdown Host：[母规格:24](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:24)，S5 没有落这一条。

只有在 `markRejected` 保证先 shutdown 整个 Host、从而消灭内部 revive 可能性的前提下，“不在 agent-host 内再加门禁”才可成立。rev.1 没有这个前提，因此裁定为伪。

---

### d) “门禁收回无 flag，而 Root 收敛有 flag，两层过渡态自洽”

判定：部分真。

支撑证据：

- `SKIP_ONBOARDING_GATE` 当前确实完全绕过 Root gate：[Root.tsx:127](/home/dan/projects/ai-client/src/renderer/Root.tsx:127)。
- MainWindow 有平行读者：[MainWindow.ts:28](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:28)。
- S1 AuthState flag-off 恒 signed_out/零 IO：[AuthStateService.test.ts:144](/home/dan/projects/ai-client/src/main/services/auth/__tests__/AuthStateService.test.ts:144)。

逻辑上可以自洽：

- 门禁逃生舱是环境/构建层决策；
- managed credentials flag 决定 Root 使用新 AuthState 还是旧 onboarding/health；
- 两者本来就是两个维度。

但 rev.1 没定义 Root 在 managedMode 尚未 resolve 时如何选轨；现有 hook 默认 managed:true：[useManagedMode.ts:8](/home/dan/projects/ai-client/src/renderer/hooks/useManagedMode.ts:8)。因此首帧可能错误进入 AuthState 轨，过渡态还没有闭合。修复 M1 后可判为真。

---

### e) “GUI 七项足以充当 D47 全链首次真跑验收”

判定：伪。

现清单只覆盖：

- 登录进入主界面；
- Claude 会话；
- Claude 终端；
- Codex 会话；
- UserProfileCard 用量；
- 登出；
- 重登预填。

见 [S5 规格第 71–74 行](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:71)。

缺失的承重场景至少包括：

1. 有效 bearer 业务 401 + login/cookie 成功不得误判失效——E5 的核心反直觉路径：[E5:327](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md:327)。
2. 网络错误/5xx 后保持 authenticated+unknown，不跳回登录——母规格判定表：[母规格 §4:120](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:120)。
3. 真实 KEY_INVALID 后立即路由回登录，并停止/关闭旧 Host。
4. 登出过程中并发 create/resume/terminal/revive 全部被拒。
5. 重启后 AuthState、lastEmail 和托管 home 状态一致。
6. flag-off 旧链。
7. dev escape 与 packaged false 的双轮。
8. 失效/登出后 renderer/IPC/日志无 key。
9. MainWindow close-confirm 判定与 Root 同步。

因此七项适合作为 happy-path GUI smoke，不足以称为“D47 全链首次真跑验收”。

## 5. 变异六必选逐对可判性核验结果

| 必选变异 | 当前规格可判性 | 两种变异态分析 | 需要补的唯一红断言 |
|---|---|---|---|
| probe 把网络错判 rejected | 有条件可判，但当前不完整 | 正确态应保持 authenticated+unknown；变异态转 credentials_invalid。若只断 remoteHealth，错误实现可能同时写 `invalidatedAt` 但表面仍 unknown；两态未完全区分 | 注入 transport error；断言状态仍 authenticated/unknown、`markRejected` 0 次、vault `invalidatedAt` 字节不变、stateChanged 不发 invalid |
| 业务 401 直接上报 | 理论可判，当前 fixture 不可执行 | 规格第 80–81 行已给“业务 401 + login 200 不上报”，方向正确；但当前没有 E5 机器 fixture，现有测试还把 cookie 当 Bearer | 加载非空 E5 业务 401、login 200、cookie actions 200 fixture；断言 login 被调用、最终 usage 成功、`markRejected` 0 次 |
| I9 序反转 | 当前不可判 | 规格只说“顺序断言”，没有说明异步 barrier；当前 host shutdown 嵌套于 regenerate 后，简单 spy 数组可能测规则副本或测不到真实跨 await 顺序 | 驱动真实 logout 编排；每步 deferred Promise；断言下一步在前一步 resolve 前调用数为 0，最终顺序精确等于七步且数组长度为 7 |
| spawn 门禁漏 resume 臂 | 当前不可判，容易假绿 | “四臂”被写成 authenticated/invalid/logout/off 四状态，不等于 create/resume/terminal 三入口矩阵。只在 create 上跑四状态时，删除 resume gate 两态都会绿 | 至少 `3 入口 × 4 状态`；每入口分别断言下游 spawn mock 调用数；resume invalid/logout 必须在 `recordResumed` 和 Host resume 之前失败 |
| 打包版逃生舱放行 | 有条件可判 | 若 resolver 可注入 `isDevelopment=false`，正确/变异可区分；但当前规格函数只收 env，无法纯测 `app.isPackaged`/`import.meta.env.DEV` | 将构建态作为显式参数；断言 packaged + env=1 仍 false，并断言 Root/MainWindow 都调用生产 resolver |
| 预填漏 `lastEmail` | 当前不可判 | 规格要求这一 mutation，同时排除 render 测试；当前 email 恒 `useState('')`。若仅扫描“lastEmail”字符串，生产接线缺失也可能空集合假绿 | 抽生产纯函数 `deriveOnboardingEntry()`，invalid fixture 必须得到 `{initialStep:'register-email',reason:'expired',initialEmail:lastEmail}`；再用静态接线断言 Root→OnboardingShell→OnboardingView 真实转发三个字段 |

补充判定：

- 六组中，没有一组在 rev.1 中按 S34 的标准写出“正确态输入 / 变异改动 / 唯一红断言”。
- “业务 401 直接上报”最接近可执行，但仍被 E5 fixture 缺失和 Cookie fixture 错误阻断。
- “spawn 漏 resume”和“预填漏 lastEmail”是最明显的假绿风险。
- 规格还要求总数 `≥8`，但没有指定其余至少两对。允许施工者自选本身没问题，但验收记录必须列出全部实际 mutation、修改点、红灯测试名和恢复后绿灯，不得只报“8/8”。

## 6. 总判语

明确结论：有条件可以——但当前 rev.1 不可以开工。

“只修复 blocker 后”可以进入施工的前提是，必须先把以下内容真实写回规格并通过再次只读核验：

1. 统一 AuthState 的 `status` 判别联合，补齐 `email/lastEmail` 和 Vault accessor。
2. 将 I9 从“handler 重排”改成明确的可等待编排重构，解除当前 regenerate→shutdown 和 fire-and-forget clear。
3. 把 Usage 的 Cookie 会话载体修复纳入 S5，撤销现有 Bearer-session 假 fixture。
4. 落独立 E5 机器 fixture，并由生产分类/登录接缝直接加载驱动。
5. 对凭据失效接入 Host shutdown，或在 agent-host revive 前增加等价 gate；不能继续声称三个 Main 入口覆盖全部 spawn。
6. 将六组必选 mutation 全部改写为两态可判、带唯一红断言和非空证明的测试契约。

这些 blocker 修复后，M1–M4 可以在施工中按明确建议同步处理，不必再次阻塞整个切片；但其中 Root 首帧双轨、resolver 构建态参数和 OnboardingShell 接线必须在相关文件动工前先由施工者按规格选定方案，不能留给各模块自行猜测。

已验证且不构成阻塞的事实包括：

- Root 当前确实是四条 query，判定顺序与调查文档基本吻合：[Root.tsx:138](/home/dan/projects/ai-client/src/renderer/Root.tsx:138)、[Root.tsx:242](/home/dan/projects/ai-client/src/renderer/Root.tsx:242)、[Root.tsx:353](/home/dan/projects/ai-client/src/renderer/Root.tsx:353)、[Root.tsx:395](/home/dan/projects/ai-client/src/renderer/Root.tsx:395)。
- `SKIP_ONBOARDING_GATE` 的生产读者只有 Root 和 MainWindow；`shellSwitchStatic.test.ts:86` 原文与规格所述吻合。
- S1 `refresh()` 当前无参，flag-off 恒 signed_out 且 zero-IO；S5 的旧链双轨只要不让 AuthStateService 读取 legacy，就与 S1 兼容。
- 三个 S2 trust 咽喉位置属实。
- renderer 确实有通用可见错误卡，但没有结构化 `auth_required` 处理。
- UserProfileCard、WindowTitleBar、OnboardingView、OnboardingShell 当前都没有 S5 所需的 AuthState/reason/lastEmail props。
- `useManagedMode` 确实默认 `managed:true`，且现测试只钉常量形状，没有 Root 首帧交互测试。


Codex session ID: 01a006bf-498d-7973-b669-1a73016765a2
Resume in Codex: codex resume 01a006bf-498d-7973-b669-1a73016765a2
