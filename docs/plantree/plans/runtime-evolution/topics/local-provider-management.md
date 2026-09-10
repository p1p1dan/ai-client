# 本地模式 AI 服务管理

Role: implementation-plan。日期：2026-09-10。依据：用户 2026-09-10 指定参考 `/home/ai/code/PI-Desktop`（v0.14.6，HEAD `ea6b9936`）的「设置 → 模型 → AI 服务 → 添加服务」，并明确要求托管与自用两种模式统一走自建存储 + 加密凭据。

## 现状与缺口

选择「使用我自己的配置」（`WelcomeView.tsx` 第二个按钮，记为 `local`）后，应用里**没有任何添加 AI 服务的入口**。设置里的 `PiModelManagementSettings` 只做托管同步（从 onboarding 服务拉 models 配置），非托管时仅显示一句「用你自己的配置，Pi 从 `~/.pi/agent` 读」。因此这是补一块空白，不是改造既有页面。

## 本轮决定

- **两种模式统一走 `CredentialVault`**（`src/main/services/auth/CredentialVault.ts`，safeStorage 加密、原子写、0600、区分 locked 与 invalid）。不新建第二套凭据存储，不移植 PI-Desktop 的 Rust secrets 实现。
- **vault 内分两组**：托管组（现有 `claude`/`codex`/`pi` 三个固定 arm，由 onboarding 下发）与用户组（新增可变长 `providers` 数组）。同步只整份替换托管组，用户组永不被碰；写给运行时时两组合并，同名以用户组优先并在界面提示。
- **不迁移旧字段**。`claude`/`codex`/`pi` 是公司网关签发的三份出口凭据，数量由 onboarding 协议钉死（`claude`/`codex` 必填，`pi` 缺省时从 codex 推导，`OnboardingService.ts:431-448`）；用户自加服务是任意多个第三方服务。两者语义不同，硬并成一个列表会让后续更难拆。schema 加新字段，老字段原样保留。
- **托管模式也开放手加服务**。由上一条的分组存储保证互不覆盖。
- **派生明文文件是共存期的临时措施，不是永久设计**。legacy 后端（当前默认）只能从 agent 目录读 `models.json` + `auth.json`，因此用户加的服务必须解密后以 0600 写出去才生效。native runtime 不需要：`createRuntime` 已支持进程内注入 `providers`（`src/runtime/bootstrap.ts:76`），走文件只是 ARD D7 为共存期定的只读约束（`src/runtime/plugins/model-adapter/catalog.ts` 文件头）。实现时把派生写入做成显式的临时分支，P6-2 摘除 pi-coding-agent 依赖后整体删除。

## 参考采用

PI-Desktop 对应实现（`apps/desktop/src/components/settings/`）：`ModelConfigPage.tsx`(572) 承载 AI 服务区块与添加按钮，`ProviderSetupDialog.tsx`(575) 是添加/编辑表单，配套 `ServicePicker`(221)、`VendorPickerDialog`(77)、`ProviderHeadersEditor`(170)、`useProviderModels`(188)、`ModelSelectionPanes`(786)、`OAuthLoginDialog`(291)。预设目录在 `packages/shared/src/provider-presets.ts`，22 个具名服务 + custom。

**采用**：页面结构与交互流程、预设服务目录、baseURL 规范化与校验（`normalizeBaseUrlInput`/`getBaseUrlIssue`，把粘贴进来的操作 URL 收敛成服务根）、从服务端 `/models` 拉模型列表、可搜索的服务选择器。

**不采用**：他们的 `ui.tsx` 与手写 CSS 类名（本仓用 @coss/ui + design token，见 `docs/design-system.md`）、Rust host-core 的 secrets 存储与 SQLite、`@pi-desktop/shared` 的类型。

## 已知约束（实现前必须按此设计）

- **API 风格白名单要按 pi-ai 的实际能力开放，不能沿用托管那 4 项**。`PI_MODEL_APIS`（`src/shared/piModelConfig.ts:147`）只有 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`，那是托管配置的校验白名单，当初只覆盖公司网关会下发的种类，不是能力上限。pi-ai 实际实现了 10 种（另有 `openai-codex-responses`、`azure-openai-responses`、`google-vertex`、`bedrock-converse-stream`、`mistral-conversations`、`pi-messages`）。用户组的校验必须独立于托管白名单，否则会无故砍掉一半能力。对照 PI-Desktop 的 7 种，真正接不了的只有它自有的 `opencode_go`。
- **`models.json` 不能存字面 secret**。`configValidation.ts` 拒绝任何非 `$` 前缀的 provider header 值，密钥只能走 `auth.json` 的 `{ type: 'api_key', key }`。用户自定义 header 若需带 token，要么走 `$NAME` 展开，要么明确不支持，不能悄悄写明文进 `models.json`。
- **safeStorage 不可用时会退化成明文**。现有 vault 在拿不到桌面钥匙串时写 `enc:'none'` 并标记 `encReason:'unavailable'`。统一之后用户自己的密钥也走这条路径，界面需要如实显示，不能让用户以为一定加密了。

## 执行清单

- [x] L1：vault schema 扩展。envelope 升到 v2，用户组作为独立的 `userProviders` + `userProvidersEnc` 两个字段，与托管 `payload` 各自加密、互不读取；`readUserProviders`/`saveUserProviders` 独立于托管侧的 `rejected`/`cleared` 判定，本地模式（从不登录）也能读写。auth 216 测试通过，含 `save()` 携带用户组的反向对照。
- [x] L2：主进程服务 `UserProviderService`（增删改查、连通性测试兼模型列表拉取）+ IPC。密钥不过 IPC：读只回 `hasApiKey`，编辑不传 key 即沿用。派生写入由 `PiModelConfigService` 的构造期 `userProviders` 供给器统一承担，托管同步无法漏掉用户组。
- [x] L3：设置页「AI 服务」区块 + 添加/编辑弹窗。16 个预设、自定义服务、pi-ai 十种 API 风格、baseURL 规范化与校验、拉取模型后勾选、启用开关、未加密与钥匙串锁定的提示。
- [x] L4：本地模式选择后自动打开设置页的 Pi 分页，仅在尚未配置任何服务时触发；设置菜单入口常驻。
- [x] L5：全量 362 文件 / 5161 测试通过，根目录 tsc 与改动文件 Biome 通过；含两处反向对照。

## 验证案例

1. 本地模式首次进入弹出设置页；关闭后可从设置菜单重新打开；托管模式不强制弹出但入口同样可用。
2. 加一个预设服务（填 key）与一个自定义服务（名称/URL/key/API 风格），两者都能拉到模型列表并被选为默认模型；填错 URL、key 无效、服务不可达分别给出可区分的提示。
3. 托管同步执行后，用户自加的服务仍在；同名冲突时用户组生效并有提示。**登出只清公司凭据，用户自加的服务保留**（用户 2026-09-10 决定：那是用户自己的第三方账号，退出工作账号不是销毁它们的理由）；钥匙串锁着时登出也不能碰用户组的密文。
4. legacy 后端下用户自加的服务真实可用（派生文件生效）；native 后端下同样可用。
5. safeStorage 不可用时（模拟）仍可保存，但界面明确显示未加密。
6. pi-ai 支持的 10 种 API 风格都能选中并保存；`opencode_go` 这类 pi-ai 没有的不出现在选择器里。

## 落地后的补充事实

- **派生文件写进本应用的 agent 目录，从不写 `~/.pi/agent`**。本地模式承诺「Pi 读你自己的配置」，那个目录里可能有用户手工维护的 `models.json`，合并进去就是覆盖。代价是：用户一旦加了服务，本地模式的 `PI_CODING_AGENT_DIR` 就指向本应用目录，因此同时打开借用开关，让 `~/.pi/agent` 里的 skills 与 prompt 模板继续加载。没加服务时行为完全不变。
- **服务在 `models.json` 里的 id 由显示名 slug 得来**（如 `My DeepSeek` → `my-deepseek`），不是 uuid：这个字符串是模型选择器里 `provider/model` 的左半边。名字 slug 为空时回落到 `user-<uuid 前 8 位>`。同名 slug 覆盖托管 provider，即「用户组优先」。
- **自定义 header 仅保留 `$` 前缀的环境变量引用**，字面值直接丢弃，界面本轮不提供 header 编辑。
- **登出只清公司凭据**，用户组保留（用户 2026-09-10 决定），钥匙串锁着时也能安全登出。
- 本 worktree 的根 `node_modules` 与 `src/runtime/node_modules` 此前都不完整，渲染层 DOM 测试因缺 `happy-dom` 完全跑不起来；已分别用 `pnpm install` 与 `npm ci` 装回。

## 范围外

不做 OAuth 登录流程（PI-Desktop 的 `OAuthLoginDialog`）、不做 vendor account 概念、不做模型价格/能力目录编辑。派生文件的删除归 P6-2。
