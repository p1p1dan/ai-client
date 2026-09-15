# 决策 011：managed 模式下 TUI 只要求「公司渠道可用」，不封其他渠道；Q011 按现状结案

日期：2026-09-15。状态：已采纳（用户拍板，回答 Q011）。

## 背景

决策 009 落地时发现内嵌终端里的 pi CLI（TUI 路径）从不读我方的 `AICLIENT_PI_TRUST_PROJECT_CONFIG`，项目信任由 pi 自决（`--approve` / `--no-approve` → `trust.json` → `defaultProjectTrust` → 弹窗）。要让「managed 下不读项目 model 设置」对 TUI 生效只能加 `--no-approve`，代价是 pi 的单一开关会连项目 skills / prompts / extensions / themes / SYSTEM.md 一起挡掉。记为 Q011。

进一步核查还发现两条与网关无关的渠道：pi 内置的几十个厂商 provider 读进程环境变量（`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY` 等）点亮自己，我方 managed 的 PTY 凭据剥离清单只覆盖 `ANTHROPIC_*` 与几个 Claude 专用变量；TUI 的 `/login` 可走内置厂商 OAuth，凭据写进同一份 `auth.json`，到下次 managed 同步才被覆盖。

## 用户要求（原话要点）

managed 模式切到 TUI，用户能正常用公司下发的 key 和 URL，这是唯一硬要求。用户自己的 key、其他渠道有没有，不管。只要保证：没有其他渠道时，公司渠道可用。

## 决定

1. **不加 `--no-approve`**，TUI 的项目信任继续由 pi 自决。项目 `.pi/settings.json` 里的 model 设置、项目扩展注册的 provider，在 TUI 里按 pi 规则处理，不再视为需要堵的口。
2. **不扩凭据剥离清单，不写 `enabledModels` 限制列表**。pi 内置 provider 靠用户自己的环境变量或 `/login` 点亮，是用户自己的渠道，不封。
3. 决策 009 第 2 条「项目 model 相关设置不读」的适用范围收窄为 **GUI 会话（native runtime）**；TUI 不在其内。
4. 「公司渠道可用」由一条端到端回归测试守住：用仓库生产代码生成 `models.json` / `auth.json`，在清空凭据的环境里 spawn 真 pi CLI，断言模型列表只含公司模型、不带 `--model` 的一次请求打到公司 URL 并带公司 key。

## 已核实的事实（2026-09-15，实际跑出来的）

- 干净环境（`env -i` 只留 PATH / HOME / TERM + `PI_CODING_AGENT_DIR`）下，`--list-models` 只列公司 provider 的模型；`-p hi` 不带 `--model` 时假网关收到 `POST /v1/chat/completions`，`Authorization: Bearer <公司 key>`，User-Agent 为我方 `AICLIENT_PI_USER_AGENT` 展开值。带 `--model` 的对照跑出同一条请求。
- 我方写出的 `models.json` 通过 pi `core/model-config.js` 的 schema 校验；`auth.json` 的文件名、字段、`type: 'api_key'` 与 pi `core/auth-storage.js` 一致。
- 默认模型来自 pi `core/model-resolver.js` 的 `findInitialModel` 第五级「第一个有凭据的模型」：先按 pi 内置的 `defaultModelPerProvider` 表逐厂商找，都没命中才退回 `availableModels[0]`。公司 provider id 不在内置表里，走的是退回分支。**今天默认命中公司模型，是因为它是唯一可用模型**，不是有谁声明了它。
- 反例（同样实测）：环境里加一个 `OPENAI_API_KEY`，模型列表多出二十余条 OpenAI 行，且不带 `--model` 时 pi 默认选 `openai/gpt-5.5`、带用户私人 key、User-Agent 退回 pi 默认值。按本决策第 2 条，不处理。

## 未采纳的备选（留作日后可选）

- 在 `buildPiTuiArgs` 里为 managed 会话传 `--model <公司 provider>/<模型>`，或往托管 agentDir 的 `settings.json` 写 `defaultModel`，把「默认是公司模型」从推断变成声明。改动一行，不封任何渠道，但会改变用户在 TUI 里换过模型后的记忆行为，未拍板不做。
- `toPiModelsJson` 丢掉 provider 的 `name`，TUI 模型选择器只显示 provider id 而非管理端配的显示名。主动取舍，不是缺陷。

## 影响

- 无生产代码改动。新增测试见批次 B 落地记录补记。
- open-questions 移除 Q011；看板 Blocked By 移除 Q011 行。
- 决策 009 第 18 行的「记 Q011」指向本决策。
