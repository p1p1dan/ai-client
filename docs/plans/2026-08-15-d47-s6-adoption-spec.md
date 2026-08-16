# D47 S6 施工规格 — 存量收编与停双写（rev.2 评审合取版，收官片）

> 2026-08-15。母规格 §6（U1 修订版）；S0~S5 + GUI 14/14 已落。
> **rev.2 = rev.1 全面重写**：双盲评审合取——A 轨 Opus（迁移语义 + 真机取证，5B/8M/9m）+ B 轨 Codex
> （证据与可验证性，5B/5M/3m），原文归档 [reviews/](./2026-08-15-d47-s6-reviews/)。两轨同判 rev.1 不可开工。
> 真机取证改写输入契约：本机 `~/.codex` 是 `[model_providers.OpenAI]` 表（非 jyw）；2026-04-27 前老机器的
> `onboarding.serverUrl` 存的是 onboard 地址非 cch（commit `2354a6b` 才改）；本机 legacy 现场已被 GUI
> 登出事故清空（`env:{}`）。

## §1 收编（adoption）

### 1.1 输入契约表（A-B1 核心重写：源分「必需/推导/旁证」，不再四源硬要）

| 项 | 级别 | 取值与判定 |
|---|---|---|
| legacy `registered===true` | **必需** | 经新解耦 reader（§1.2），`registered:false`/absent/malformed → skip |
| claude token + baseUrl | **必需** | 读 **OS home** `~/.claude/settings.json` env（**硬编码 homedir，禁用任何 env-aware helper**——`$CLAUDE_CONFIG_DIR` 相①已指托管 home，复用即「自我收编」，A-m3）；三态判：无 env 键 / `env:{}` / 值为空串 均 = 缺失 → skip（A-m6，本机现状即 `env:{}`） |
| `cchBaseUrl` | **推导** | `deriveCchBaseUrl(claude.baseUrl)`（去 `/v1`）——**不再取 legacy serverUrl**（A-B2：旧口径机器存的是 onboard 地址，取它 = probe 打 404 + 用量链废） |
| `codex.baseUrl` | **推导** | `cchBaseUrl + '/v1'`（§5 源码定论同 base） |
| `codex.apiKey` | **推导** | = claude token（同 key 口径：源码 + E1-lite 线上双证） |
| `~/.codex/auth.json` key | **旁证** | 与 claude token 相等 → diagnostic 记「corroborated」；不等/缺失/无该字段（ChatGPT OAuth 形态）→ 记「divergent/absent」**不否决**（A-B1：个人 OpenAI key 机器不误杀，probe 会以正确的 claude-token 验真） |
| `[model_providers.jyw]` 表 | **不作源** | 真机可为 OpenAI 表名（用户手改/复原版） |
| legacy `email`/`serverUrl` | 旁证 | email 供守卫失败后的预填（§1.4）；serverUrl 仅作网关集合成员（§1.3） |

`identity.userId` = **null**：`VaultPayload.identity.userId` 类型放宽为 `number|null`（B-B2 定论 + A-m2：
零运行时校验触 payload 内部、全仓零消费者、纯 TS 放宽零迁移；roundtrip 双测——null 保持 / 数字登录不丢）。
「probe 200 回填 id」**删除**（probe 不解析 body user，A-m2）。

### 1.2 legacy reader（B-M1）

```ts
type LegacyOnboardingReadResult =
  | { status:'absent' } | { status:'invalid' }
  | { status:'present'; registered:boolean; email:string|null; serverUrl:string|null };
```
与 `checkRegistration()` 解耦（后者在 `registered:false` 时连 email 都不回）；malformed JSON 不崩溃不写
marker。「升级免重登」承诺收窄为「**来源仍完整的已注册机器**免重登」（被旧版 logout 抹过 serverUrl/email 的
机器按缺失路径走，B-M1）。

### 1.3 守卫（A-B2 重写）

```ts
adoptionGatewayGuard(claudeBaseUrl, legacyServerUrl|null): 'match'|'mismatch'|'invalid_url'
```
- 判据：`new URL(claudeBaseUrl)` 的 **origin** 命中「公司网关集合」= `{ 注入常量 __ONBOARDING_SERVICE_URL__
  的注册域族（`*.pipidan.qzz.io` 后缀，https 限定）} ∪ { legacy serverUrl 的 origin（若可解析）}`；
- **比 origin 不比 host**（http 明文同 host 不放行）；任一 URL parse 抛错 = 不收编（invalid_url）；
- B-M2 矩阵：同 origin 带 `/v1` 路径差 ✓ / host 异 ✗ / 端口异 ✗ / http vs https ✗ / 非法 URL ✗ /
  userinfo 或非 http(s) scheme ✗。
- **对母规格 §6 的修订登记**：原文「与 legacy serverUrl 一致」窄化有误（旧口径机器系统性误杀），改「公司
  网关集合」；此为评审改判非漂移。

### 1.4 守卫/来源不过的落地（A-M1）

`AuthState.credentials_invalid.reason` 增第四枚 **`migration_incomplete`**（`authGate` 折算并入 expired 同
文案臂 + 预填 legacy email——reader 的 email 经 IPC 兜底进 `deriveOnboardingEntry`）；仅在「registered=true
但必需源缺/守卫拒」时产生；母规格 §4/DTO 连带修订登记。来源整体 absent（从未注册机器）→ 维持 signed_out
first_run，不造新态。

### 1.5 编排（A-B3 重写：收编 = guards + save + marker，零网络）

- 插入点：`main/index.ts` `openLocalWindow()` 之后（crypto 升格已闩）、`regenerateFromVault()` **之前**；
  自带 `resolveManagedCredentialsEnabled()` 前置（flag-off 零 FS IO，A-m4）。
- `ensureVaultAdoption()` 只做：vault.read 穷举 switch（**只有 `absent` 进收编**；`cleared/rejected/locked/
  unsupported/invalid/ok` 全 skip 且 `assertNever` 封口——B-M5：禁复用 dev-seed 的 absent|cleared 合并）→
  marker 存在即 skip → legacy 读 + 守卫 → `vault.save()`（唯一写手，模块结构上**不得**获得 vaultPath/fs
  写 API——B-B5⑥）→ save ok 即写 marker。
- **regenerate/refresh/probe 全部交回既有启动链**（`index.ts` 既有两调用原位不动）；probe 由 refresh →
  onChange 桥自动触发（S5 既有）；**probe 拒绝绝不回滚 vault**（写死：回滚 = absent + 无 marker = 开机
  重收编重拒死循环；现设计 vault 转 rejected 态天然免疫，此句防实施者「清理失败残留」造出循环——A-B3）。
- `auth.getGateSnapshot` handler 前置 `await adoptionLatch`（handler 本 async；消掉「收编未完时 renderer
  闪 first_run/cli-check 页」——A-B3-3）。
- **crypto 不可用时**：与 `save()` 现语义一致（enc:'none' 降级 + encReason 诊断），**不加跳过重试逻辑**
  ——与真实登录同语义优先（登录在 keyring 锁定时同样降级）；A-M6 顾虑登记：收编发生在开机瞬间，Linux
  桌面登录后 keyring 通常已解锁，且 adoption 在窗后（升格已尝试）。合取记录注明此处改判 A 轨建议。
- marker：**`<userData>/.adopted-v1`**（移出 credentials/——与 vault 同目录会同批被人工删除，A-M4②）；
  内容 `{"version":1,"adoptedAt":ISO}`、0600、tmp+rename 原子（B-m2）；并发双启动只有一次 save（队列已保）。
  profile 化限制登记（A-M4③：userData 按 profile 隔离而 legacy 全局，B profile 首启会再收编——单账号
  内部工具下行为可接受，登记）。
- probe 三态 × marker 矩阵（B-B1）：save-ok 即 marker（200/KEY_INVALID/网络未知**都不影响** marker——
  已与网络解耦；KEY_INVALID → 既有 markRejected 链转 rejected 态重登，**不算收编失败不重试**）。

## §2 停双写与登出

- **停双写**：flag-on 时 `persistCredentialFiles()` 整链（`writeClaudeConfig`/`writeCodexConfig`/
  `ensureClaudeOnboardingComplete` 三写手）不执行；flag-off 逐字节现状。**注意 `saveOnboardingState` 不在
  三写手内**（A-M3：`onboarding.serverUrl` 每登录仍写——留置，flag-off 回退与收编旁证依赖它）。
- **登出拆分（A-M2/c-半真 + B-B3 合取）**：`performLogoutSequence` 继续调 `onboardingService.logout()`
  （返回值语义不变）；只给 `removeClaudeCredentials`/`removeCodexConfig` 两私有方法加 flag 门控
  （flag-on 跳过——U1 留置）；`mergeSettingsPatch` 的 `registered:false` **恒执行**（它是收编第二道闩 +
  flag-off 回退门禁，跳过 = 登出后被静默收编回登录，§1.5 穷举的 cleared-skip 是第一道，此为第二道）；
  顺手补 re-paste `serverUrl`/`registeredAt`（A-m7：浅合并现仍抹这两键，本机实测中招）。
- **rmSync 外科修（flag-off 路径，A-M5 + B-M3）**：纯函数 `removeOpenAiApiKey(authObj)`（只删该字段保文件
  与其余字段）+ `removeJywProviderFromToml(toml)`（只摘 `[model_providers.jyw]` 表；**仅当
  `model_provider === "jyw"` 才删该 root 行**——否则留行删表会硬报错/删行非 jyw 会静默回落 api.openai.com；
  表名非 jyw = 完整空操作）。fixtures 含用户自有键/另一 provider 表/注释与空行哨兵/`.codex/sentinel-user-file`；
  **重锚既有断言**（点名：`OnboardingService.test.ts:286-287` 两条「文件不存在」重写为外科断言；
  `OnboardingServiceManagedHome.test.ts:223` 补 flag-on 臂）。
- **登出文案已知限制**（A-m9）：flag-on 登出后公司 token 仍留 `~/.claude`（U1 拍板结果），app 外终端照常
  可用——登出确认弹窗文案注明「不影响系统终端里的 CLI 登录」，防「以为登出了」的安全错觉。

## §3 兼容清理与迁移件

- `ONBOARDING_CHECK_CREDENTIALS_HEALTH` 通道**退役**（A-B4：方法无 flag 分支、折算实在 `deriveLegacyAuthState`
  且仅 !managed 臂；S5b 后 renderer 零消费者；停双写后 flag-on 恒 degraded 会误导新消费者）——连带
  preload 绑定删除；`OnboardingService.checkCredentialsHealth()` 方法保留（flag-off 内部仍用）。
  顺手清真死面：`ONBOARDING_LIVE_CREDENTIALS_STATUS` 的 preload/shared 残留（A-m5）。
- **UsageService**（A-M3 + B-M4）：`UsageAuthTarget` 单权威对象——flag-on = vault 单快照出 `{serverUrl:
  cchBaseUrl, apiKey}`（legacy reader 零参与，调用数断言 0）+ 准入门迁 AuthState（不再看 legacy
  registered/serverUrl）；flag-off = legacy 现状（vault 读数 0）；vault cleared/rejected/locked/invalid →
  unavailable **不回退 legacy**（防停双写后旧凭据复活）。
- **S1 承重断言处置**（A-B5，点名）：`vaultIntegration.test.ts:91-119`（§3-1g）改锚为「vault payload ↔
  `generateClaudeSettings()`/`generateManagedCodexConfigToml()` 生成物」比对；`:120-152`（§3-5a token 不入
  日志）补 flag-off 轮保发射半边。
- 投影链物理删除：**注册为独立退役批**（roadmap 阶段 4 附注 + S34 四处注记与母规格 S4 行连带改判——
  A-m8 点名 `s34-spec:44/91/142/164`；flag-off 回退依赖，母规格裁定 #3 回退安全态）。

## §4 分发纪律解除（A-M8 加严）

解除条件 = S6 落地 **+ 一条真机证据**：带真实 legacy 凭据的机器 flag-on 冷启动**零重登**直进主界面
（D47 教训：3874 例单测 + 44 对变异都没抓到接线缺席型缺陷）。**本机造场前置步**：GUI 事故已清空本机
legacy（`env:{}`、serverUrl 被抹）——先 flag-off 真实登录一轮造回 legacy 现场（需一枚验证码），再跑
flag-on 冷启动收编证据。§6 验收清单含此两步。

## §5 测试与变异（四列表，B-B5 全采）

测试面：输入契约表逐行（含 `env:{}` 三态、旧口径 serverUrl、OpenAI 表名、ChatGPT OAuth auth.json）·
守卫 origin 矩阵六格 · vault 穷举 switch（七臂）· 编排 trace（`adoption-read → vault-save → marker` 且
regenerate/refresh/fetch 各恰一次——驱动真实启动编排）· getGateSnapshot latch（收编未完不回 first_run）·
停双写 mutation-trace（B-B4 全套：七种 fs 调用 spy + 路径过滤 `~/.claude/**`+`~/.claude.json`+`~/.codex/**` +
`toEqual([])` + 成功旁证四条防提前失败假绿 + spy 与被测模块同实例验证）· flag-off 四文件 golden ·
外科修 fixtures · UsageService 双轨三态。

变异 **7 对**（四列：正确态输入 / 生产变异 / 唯一红断言 / 非空证明——每对照 B-B5 表实现）：
① cleared 进收编（trace=`read:cleared→skip` 红；前置断言真实 clear 产出 cleared + legacy 源非空）
② marker 不幂等（前置 existsSync(marker) 且内容非空）③ 守卫 origin 比较反转/删除（`guard_rejected` 且
无 save 事件；前置全字段非空证明拒因非缺字段）④ 停双写漏 `.claude.json` 写手（`.claude.json` 预置
`hasCompletedOnboarding:false` 使写手必然执行；mutation-trace 红）⑤a auth 外科退化整删（post-bytes golden）
⑤b config 外科退化整删（独立 golden——拆两对保唯一红）⑥ adoption 旁路写 vault（save port 恰一次 +
静态扫描禁 adoption 模块 import fs 写 API）。

## §6 验收清单（收官）

四门串行 + 变异 7 对留痕 + **真机双步**（flag-off 登录造场【验证码 ×1】→ flag-on 冷启动零重登收编证据 +
probe valid + 用量卡）→ as-built + 台账 + plantree + baseline 分发纪律标注解除 → **D47 全落**。

## §7 评审合取记录

| 项 | 裁定 |
|---|---|
| 独立同判（编排所有权 A-B3≡B-B1 / logout 拆分 A-M2≡B-B3 / 变异四列 B-B5≡A 矩阵格 / marker 语义 A-M4≡B-B1 矩阵） | 全采 |
| A 轨真机取证独有 | B1 输入契约重写（源分级）/ B2 守卫锚点改公司网关集合 + origin / B3 零网络编排 + latch + 不回滚 / B4 health 通道退役 / B5 S1 断言处置 / M5 表名非 jyw / M8 造场前置与解除证据 / m3 OS-home 硬编码 / m9 登出文案 |
| B 轨独有 | B2 userId schema 编译失败实锤（→1.1 定论）/ B4 mutation-trace 完整形态 / M1 legacy reader / M2 origin 矩阵 / M4 UsageAuthTarget / m2 marker 内容与原子性 |
| 改判 A 轨建议一处 | crypto 不可用时不加跳过重试——与登录 save() 降级语义一致优先（§1.5，登记 A-M6 顾虑） |
| rev.1 裁定 | a 半真（位置对、链重构）；b 真（marker 语义补齐）；c 半真（`~/.aiclient` 切出）；d 伪→类型放宽定论；e 真（连带 5 处注记 + 退役批注册） |
| 母规格连带修订 | §6 守卫措辞（网关集合）；§4 reason 加 `migration_incomplete`；S4 行投影链删除归属；「免重登」承诺收窄 |
