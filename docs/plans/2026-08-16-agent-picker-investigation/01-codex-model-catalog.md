# D48 调查 01 — Codex 模型目录半边 + cch 代理线索 + D40 落地状态

> 2026-08-16，阶段 3（D48）调查轮第 1 篇。只读调查（主仓 + onboard 仓），file:line 已核实。
> 承接 [multi-agent open-q #5 模型目录半边](../../docs/plantree/plans/multi-agent/open-questions.md)。

## 1. 三套模型目录实测原始数据（权威出处 = S1 spike 报告）

出处：`docs/plans/2026-08-06-s1-acp-codex-spike-report.md:120-141`（§1.4）。

| 来源 | 条数 | 字段风格 | 内容 |
|---|---|---|---|
| `codex debug models` | **8** slugs | snake_case | gpt-5.6-sol / -terra / -luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.2 / codex-auto-review；每条带 display_name / description / default_reasoning_level / **supported_reasoning_levels（low,medium,high,xhigh,max,ultra 六档）** / service_tiers / 完整 base_instructions（296,131 字节） |
| app-server `model/list` | **5** | camelCase + `nextCursor` | 滤掉 gpt-5.4 / gpt-5.4-mini / codex-auto-review；`{id, model, displayName, description, hidden, supportedReasoningEfforts, defaultReasoningEffort, inputModalities, supportsPersonality, serviceTiers, isDefault}` |
| ACP `session/new` 回包 | **25** 档位 | `模型[effort]` 合成单 id | `currentModelId="gpt-5.6-sol[medium]"`；25 ≈ 5×5（**推测·未闭合**，:140） |

- :130 两处目录都是**本地静态内置表，不向第三方代理查询**［实测］。
- :131 `gpt-5.6-sol` 内置目录第 1 条（priority=1）。
- :133 codeg 走 ACP 也**自建目录抓取**（`codex_catalog_source.rs`，live→磁盘 cache TTL 24h→编译内置 snapshot 三级回落）。
- :139 直连与 ACP **都答不出代理真实支持哪些模型**，不构成路线差异。
- S2 设计档无新增模型目录数据；S1 spike 是唯一权威出处。

## 2. 主仓 Claude 轴模型目录 = 静态硬编码短名表

- `src/renderer/components/chat/models.ts:17-21` — `CHAT_MODELS = [sonnet, haiku, opus]`，`DEFAULT_CHAT_MODEL_ID = 'sonnet'`；:1-10 头注自述 "fixed short-name list + Host-reported default prepended when not in catalog"。
- :29-45 `defaultModelId`/`ensureModelOptions`：Host 默认值不在表中即前插第 4 条，**无合法性校验（不查代理）**。
- `efforts.ts:24-30` — 静态五档 `low/medium/high/xhigh/max`；:8-12 自述不做 per-model 过滤，靠 SDK 静默降级。
- 消费方：`ComposerModelTrigger.tsx:21,104-138` + `composerModel.ts:103-172`（:94-96 明写「不做 per-model 过滤，因为拿不到 per-model 能力」）。
- 存储层：`useSessionModel.ts:12-13,51-71` / `sessionEffortStore.ts:14-16,42-59` — localStorage per-session map，renderer-only 不落 Host。

**结论**：Claude 轴与 Codex 轴是同构问题（本地静态表、不知代理实况），只是规模更小。

## 3. onboard 仓（jyw-cch-onboarding）里的 cch 代理线索

**cch 代理本体源码不在本仓**（README:5-6 本仓 = vanilla claude-code-hub 的 Bun+Hono 注册 sidecar；`deploy/docker-compose.fragment.yaml:1-13` 注释明确 cch app 容器 `claude-code-hub-app-ea8i` 由 1Panel 独立编排；无 submodule/vendor）。

- **无模型白名单/映射表**：全仓 `model` 命中仅两处——`src/cch.ts:118` `pingProxyWithKey` 的 `GET /v1/models` **只读状态码不读 body**；`mock-cch/server.ts:45-55` 测试桩回空数组。
- **双轴转发口径**（`src/routes/register.ts:108-127` 与 `verify-and-register.ts:127-138` 同一模式）：`claudeBaseUrl = ONBOARDING_BASE_URL`；`codexBaseUrl = ONBOARDING_BASE_URL + '/v1'`；同一把 apiKey。commit `d0e6da3` 印证 `/v1` 拆分是刻意修过的。`ONBOARDING_BASE_URL = https://cch-jyw.pipidan.qzz.io`（`.env.example:13`）。
- cch 管理面 API 只封装了 user/key 四个 action（`src/cch.ts:79-137`），**从未调用模型相关端点**。

## 4. D40（会话中途 model/effort 下发）落地状态

票据：总台账 D40（拍板 2026-08-15，源头 open-q #19 建于 2026-07-30）。

**Claude 轴：已完整落地（早于台账拍板日期）**

1. 协议：`src/shared/types/agentHost.ts:116-133` `SessionSendCommand.payload` 可选 `effort`/`model`（注释 "Round-2 P0 fix"；model 字段 commit `b159e4a` 2026-07-30，effort 随 `3622c19`）。
2. Host 解析：`src/agent-host/index.ts:531,600-611` — `session.send` 透传 effort/model。
3. Claude 运行时：`claudeRuntime.ts:453-522` — per-turn 覆盖优先、:514-521 新 model 写回 session 默认、:780-783 作为 SDK `query()` 顶层选项发出。
4. Renderer：`ChatComposer.tsx:857-860,1308-1314` — 每次 `sendAndWait()`（含 `'direct'` 分支）都带当前 model/effort → **open-q #19 的原始缺口已堵上**。

**Codex 轴：未落地，字段接收后显式丢弃**

- `codexRuntime.ts:2304-2311` `send()` 接受 `effort?`/`model?`，但 `buildTurnStartParams`（:258-265，调用点 :2393）只有 `{threadId, text}`。
- :250-256 注释明写丢弃理由：effort 是 per-model 词表（从未读过 `model/list`），盲映射会 fail turns；model 已在 `thread/start` 钉死（`buildThreadStartParams` :211-224，会话建立时生效一次）。
- → **会话中途 model/effort 对 Codex 轴完全无效，是阶段 3 的直接技术负债**，根因与「目录不查代理」同链条。

## 5. 必须线上实证的问题清单（仓内答不出）

1. **cch 真实支持哪些模型 slug**：需真实 key `curl {base}/v1/models`（双轴各看一次响应体）。
2. **cch 对 codex 轴接受的 model 参数格式**：8 个 snake_case slug 原样透传？还是映射/重命名？（cch 本体源码不在任一仓）
3. **cch 对 claude 轴的模型白名单**：3 短名是否全部？是否接受 `claude-opus-4-8[1m]` 类真实名（`claudeRuntime.ts:189` 注释出现过）？
4. **cch 对 effort/reasoning 参数的转发行为**：原样透传/降级/报错？需真实回合逐档测试；且 `model/list` 的 per-model `supportedReasoningEfforts` 词表本身也未读取过。
5. **25=5×5 算术关系**：S1 报告自标「推测·未闭合」，需读 codex-acp 源码或探针复核（优先级低——ACP 已按 D45 不接）。
6. **cch 管理面是否有模型配置端点**：onboard 仓从未调用，需翻 claude-code-hub 项目文档/源码或登录管理后台确认。

## 6. 上游源码线索（2026-08-16 web 调查补充）

- **vanilla 版 [zsio/claude-code-hub](https://github.com/zsio/claude-code-hub) 已归档（2025-11-25）且只支持 Claude Code 格式**（README 常见问题明写「仅支持 Claude Code 格式」，OpenAI 格式需外挂 claude-code-router 转换）——但线上 cch 实际在转 codex 双路（D47 GUI 点验 codex 双路实转 PASS），**故部署版不是 vanilla zsio**，onboard 仓 README 的 "vanilla claude-code-hub" 表述已过时或另有所指。
- **候选真身 = [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub)**（基于 zsio 深改，MIT）：自述支持 Claude / Codex / Gemini CLI / OpenAI Compatible 四类端点；OpenAI 兼容端点 = `/v1/chat/completions`；**严格同格式路由，无跨格式转换**；**「模型重定向」是供应商级配置**（权重/成本系数/并发限制/代理/模型重定向）；核心链 `src/app/v1/_lib/proxy-handler.ts`（Auth → SessionGuard → RateLimitGuard → ProviderResolver → Forwarder → ResponseHandler）。README 未见 `GET /v1/models` 实现证据（onboard 仓 `pingProxyWithKey` 打的这个端点实际返回什么需实证）。
- **推论（改判实证问题 1/2/3/6 的性质）**：模型可用面**不取决于 cch 源码，而取决于部署实例的供应商配置**（管理后台里各 provider 的格式类型 + 模型重定向表）。→ 最省的实证路径是**运维侧直接看 cch 管理后台**（用户自有部署），其次才是真实 key 打 `GET /v1/models` 与逐模型探测。
