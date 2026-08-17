# D48 调查 04 — cch 代理模型支持面线上实证

> 2026-08-16，阶段 3（D48）调查轮第 4 篇。用户拍板「拿 key 实测」。
> key 来源 = 本机存量凭据（`~/.claude/settings.json` env / `~/.codex/auth.json`，同一把 sk-4b06…，D47 收编不清理故仍在）。
> 目标 = `https://cch-jyw.pipidan.qzz.io`；探测均为最小 payload（max 8~16 tokens）或只读端点。

## 1. `GET /v1/models` 双轴响应体（只读实测）

**codex 轴**（Bearer，OpenAI list 形状）——**10 条**：

`codex-auto-review` · `gpt-5.3-codex-spark` · `gpt-5.4` · `gpt-5.4-mini` · `gpt-5.5` · `gpt-5.6-luna` · `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-image-1.5` · `gpt-image-2`

与本地静态目录（调查 01 §1 的 8 slugs）对照：**少 `gpt-5.2`，多 `gpt-5.3-codex-spark` + 两个 image 模型**——证实「本地静态表 ≠ 代理实况」的担忧成立，目录必须以代理查询为准或可配置。

**claude 轴**（x-api-key，Anthropic list 形状）——**15 条全长名**：

`claude-fable-5` · `claude-haiku-4-5`(+dated) · `claude-opus-4-1-20250805` · `claude-opus-4-5`(+dated) · `claude-opus-4-6` · `claude-opus-4-7` · `claude-opus-4-8` · `claude-opus-5` · `claude-sonnet-4-20250514` · `claude-sonnet-4-5`(+dated) · `claude-sonnet-4-6` · `claude-sonnet-5`

**列表里没有 `sonnet`/`haiku`/`opus` 短名。**

## 2. 探测回合结论（七发）

| # | 探测 | 结果 |
|---|---|---|
| A | codex 轴 `/v1/chat/completions` model=gpt-5.4-mini | ❌ `no_available_providers` —— **completions 端点无供应商**，cch 是严格同格式路由，codex 供应商只配了 responses 格式 |
| B | claude 轴 `/v1/messages` model=**`sonnet` 短名** | ❌ `no_available_providers` —— **短名别名不被 cch 接受**（重要：本仓 `CHAT_MODELS` 三短名靠 SDK/CLI 层翻译成全名才能用；直接下发短名到代理会失败） |
| C | claude 轴 `/v1/messages` model=`claude-sonnet-5` 全名 | ✅ 正常回复 |
| D | codex 轴 **`/v1/responses`** model=`gpt-5.6-sol`（codex CLI 真实端点） | ✅ 正常回复；响应 `reasoning: {effort:"medium", mode:"standard"}`（默认档回声） |
| E | `/v1/responses` + `reasoning:{effort:"low"}` | ✅ 回声 `effort:"low"` —— **effort 参数被透传且生效** |
| F | `/v1/responses` model=`gpt-5.5` | ✅ 正常回复（第二档模型可用性证实） |
| G | 越界 `reasoning:{effort:"ultra"}` | ❌ 明确报错：`level "ultra" not supported, valid levels: low, medium, high, xhigh, max` —— **effort 词表实证 = 五档**（与本仓 `CHAT_EFFORTS` 五档完全一致；本地 codex 静态目录声称的六档 ultra 在代理侧不可用） |
| H | 目录外模型 `gpt-5.2` | ❌ 中文报错「所有供应商暂时不可用」—— **`/v1/models` 列表外的模型确实打不通**，列表可信 |

## 3. 对阶段 3 设计的直接输入

1. **模型目录必须从代理查询**（双轴 `GET /v1/models` 都实现且可信：列表外模型实测打不通）——本仓 Claude 轴静态 3 短名表与 Codex 轴本地 8 slugs 表都与实况不符。
2. **claude 轴 UI 下发全名**：cch 不认短名别名。现链路能跑是因为 SDK/CLI 层做了短名→全名翻译；若 UI 目录改为代理查询结果（全名），直接下发全名即可，绕开翻译依赖。
3. **codex 轴 effort 五档词表已实证**（low/medium/high/xhigh/max），与 Claude 轴 `CHAT_EFFORTS` 一致 → 「统一五档抽象」有了实证基础，**D40 Codex 半边的丢弃理由（词表未知）已消除**（至少对经 cch 的部署形态）。
4. **越界行为友好**：错模型/错档都是显式报错非静默降级，UI 可以放心把代理列表当真源。
5. 残留：`thread/settings/update` schema 与 SDK `setPermissionMode` 失败模式仍未实证（权限半边，见调查 02 §6）——属规格轮后的探针项，不阻塞目录设计。
