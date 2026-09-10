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

- [ ] L1：vault schema 扩展。新增用户组 `providers` 数组与读写路径，托管组不动；补 schema 版本与拒绝降级的测试。
- [ ] L2：主进程服务。用户组的增删改查、连通性测试、从 `/models` 拉模型列表；合并两组后派生 `models.json`/`auth.json`（0600），登出与切模式时清理。
- [ ] L3：设置页「AI 服务」区块与添加/编辑表单。预设选择器（过滤掉不支持的 API 风格）、自定义服务、baseURL 规范化、header 编辑、模型选择、默认模型。
- [ ] L4：本地模式首次进入后自动弹出该设置页；设置菜单里常驻同一入口。
- [ ] L5：自动化与本机验证，边界与限制如实记录。

## 验证案例

1. 本地模式首次进入弹出设置页；关闭后可从设置菜单重新打开；托管模式不强制弹出但入口同样可用。
2. 加一个预设服务（填 key）与一个自定义服务（名称/URL/key/API 风格），两者都能拉到模型列表并被选为默认模型；填错 URL、key 无效、服务不可达分别给出可区分的提示。
3. 托管同步执行后，用户自加的服务仍在；同名冲突时用户组生效并有提示；登出后用户组与托管组都被清掉。
4. legacy 后端下用户自加的服务真实可用（派生文件生效）；native 后端下同样可用。
5. safeStorage 不可用时（模拟）仍可保存，但界面明确显示未加密。
6. pi-ai 支持的 10 种 API 风格都能选中并保存；`opencode_go` 这类 pi-ai 没有的不出现在选择器里。

## 范围外

不做 OAuth 登录流程（PI-Desktop 的 `OAuthLoginDialog`）、不做 vendor account 概念、不做模型价格/能力目录编辑。派生文件的删除归 P6-2。
