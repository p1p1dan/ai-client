# Evidence — U12 会话级权限档可行性

> 2026-09-03 取证。触发：U09-2 要求底栏左侧放「权限管理」chip，但本仓 Composer 没有任何信任态/权限控件。
> 追查发现这是一段**被删除的历史**，且 pix 的对应物是未接线的 UI。本文件锁定事实与实现边界。

## 一、为什么本仓现在没有权限控件

**做过，被 Pi-only 收窄时删掉了。**

- D48 S4（2026-08-17，commit `d34be631`）落地过 Composer 实时权限 chip：
  `ComposerPermissionTrigger.tsx`(500 行) + `composerPermissionModel.ts`(673 行) +
  `shared/models/permissionTiers.ts`(137 行)，含档位菜单、危险档二次确认、在途态、
  `session.updatePermission` IPC 双通道。
- Pi-only T31 行为重挂（commit `65061ccf`）整体删除。**原因不是功能不好**：那套档位是
  **Claude 五档**（`plan`/`default`/`acceptEdits`/`dontAsk`/`bypassPermissions`）加
  **Codex 两组三档**（approval × sandbox），全部是 SDK 专属词汇；Claude/Codex runtime 一删，
  档位模型和它的 IPC 落点同时消失。
- **残留**：`shared/i18n.ts:1643-1704` 的整段 i18n 键仍在，含 chip 的组装文案模板
  （`'Permissions: {{tier}} — click to change ({{scope}})'` 等）。重建时可直接复用。

教训与 [pi 词汇表漂移] 同源：跟 runtime 词汇绑死的 UI，换 runtime 就整片作废。
本轮的档位定义因此**只使用本仓自己的权限规格**（`allow`/`ask`/`deny` + 受控面），不引入任何 SDK 专属词汇。

## 二、pix 的权限管理与我们不是一回事

| | pix | ai-client |
|---|---|---|
| 项目信任（pi SDK 自带） | 有，`resolvePixProjectTrust`（`agent-runtime/src/index.ts:366-378`），读 `trust.json` | 有，接到凭据路线：托管路线传 `projectTrusted: false`，经环境变量 `AICLIENT_PI_TRUST_PROJECT_CONFIG` 传给 Host（`shared/piModelConfig.ts:10-28`） |
| 工具调用审批 | **无**。未装任何权限扩展；`agent-runtime` 全文 `approval`/`permissionRequest` 零命中 | 有。随包固定 `@gotgenes/pi-permission-system`（commit `d877d540`），fail-closed：扩展加载不了就不返回运行时（`piAgentSessionBootstrap.ts:330`） |
| 三档 chip | `AccessMode = default \| autoReview \| full`（`settings-prefs.ts:3`）。文件头注释自承 "Desktop-only settings UI prefs (**not agent/pi config**)"。`applyAccessMode`（`main.tsx:460-479`）只写 localStorage；仅 `full` 额外调 `trust.set(true)` | 无（本轮要建） |

**关键前提**：pi SDK 本身没有权限概念——`dist/core/*.d.ts` 搜 `permission` 零命中，只有 `project-trust.d.ts`。
工具审批必须靠扩展实现。pix 没装，所以 pix 的 `autoReview`（文案写「自动处理权限提示」）在它自己的代码里没有对应物。

**结论**：不存在「把 pix 三档搬过来」这件事——那边没有可搬的实现。我们的权限模型比 pix 多一整层。

## 三、我们的权限规格（档位的原料）

- **动作值三个**（`shared/piPermissionPolicy.ts:41`）：`allow` / `ask` / `deny`。
- **受控面十一个**（`settings/permissionPolicyView.ts:121-191`），随包默认见下。
- **跨切面 `path` 规则**优先级最高，`path` 的 deny 不可被 per-tool allow 覆盖。
- **两个全局开关**：`yoloMode`（默认 false，打开后连 `sudo`/`bash -c`/`xargs`/`find -exec`/`eval`
  的包装器地板都失效）、`permissionReviewLog`（默认 true）。
- **作用域三层**：随包默认 < 用户/受管 agentDir < 仓库 `.pi/`；托管路线丢弃第三层。

随包默认「务实档」（`agent-host/permissionPolicy.mjs:131-164`，D-Q9 决定一，原则「读免问，改要确认」）：

| 面 | 默认 | 危险 |
|---|---|---|
| `read` / `grep` / `ls` / `find` | allow | |
| `write` / `edit` | ask | ⚠ |
| `bash *` | ask（20 条只读命令白名单为 allow） | ⚠ |
| `external_directory *` | ask（`~/.pilab/*` 为 allow，避免重复弹窗） | ⚠ |
| `mcp *` | ask（4 个发现类调用为 allow） | ⚠ |
| `skill *` | ask | ⚠ |
| `*`（兜底） | ask | ⚠ |
| `path` | `*: allow`，逐条挖掉 `*.env` / `*.env.*` / `~/.ssh/*` / `*.pem` / `*.key` / `id_rsa*` / `~/.aws/credentials` 为 deny；`~/.pilab/*` 为 ask；`*.env.example` 为 allow | |

## 四、会话级怎么做到（核心取证）

**可行。机制是插件自带的实时授权链（ADR 0007）。**

1. 插件把服务按 sessionId 挂在 `globalThis`（`Symbol.for()`，`service.ts:15`）：
   `getPermissionsService(sessionId)` 取到**该会话自己**的服务实例。会话级是这套机制的原生语义。
2. `PermissionsService.registerAuthorizer(name, authorize)`（`service.ts:195-211`）：
   注册一个 link，审查每一次 `ask`，返回 `allow` / `deny`（带可选理由）/ `defer`。
3. **注册不等于授权**：link 必须被 `authorizerChain` 配置显式点名才生效（`config-schema.ts:239`）。
   我们在随包 `config.json` 里写入即可，属于我们拥有的作用域。
4. 注入点已存在：`piAgentSessionBootstrap.ts:348` 的 `extensionFactories` 已经在注入
   `aiclient-permission-activity` 内联扩展，加 link 是同一处。

### 两条不可越过的边界

**边界一：`path` 与 `external_directory` 上 link 永不可放行。**
`authority/delegation-envelope.ts:20-24` 的 `DELEGATION_EXCLUDED_SURFACES` 写死这两个面；
link 在其上返回 `allow` 会被降级为 `defer` 落回弹窗。注释明示不变式：checkpoint 只收紧、永不放松，
且无法判定 surface 时按排除处理（更多提示，绝不更少）。

→ **「完全放开」档做不到真 yolo**：密钥 deny 与跨目录 ask 仍然生效。
真 yolo 只有配置文件的 `yoloMode`，那是全局开关，没有会话级版本，本轮不做。

**边界二：link 只看得到 `ask`。**
已是 `allow` 的（read/grep/ls/find、bash 白名单、mcp 发现调用）不进链。
→ 「只读档」收不紧这些。它们都是只读操作，语义不冲突，但边界要写进文案。

## 五、四档定义（用户 2026-09-03 拍板四档 + 会话级）

| 档 | link 行为 | 实际效果 |
|---|---|---|
| **只读** | `write` / `edit` / `bash *` 的 ask → `deny` | 能读能搜，不能改文件、不能跑非白名单命令 |
| **务实**（默认） | 全部 `defer` | 等同现状：随包策略 + 逐次确认 |
| **放手** | `write` / `edit` → `allow`；bash 仍 `defer` | 改文件不问，跑命令仍问 |
| **完全放开** | 非排除面的 ask 全 `allow` | 仅剩密钥防线与跨目录仍问 —— **文案必须写明这一点** |

## 六、实现路径（五处）

1. **扩展侧**：`extensionFactories` 注册 authorizer link（名 `aiclient-session-tier`），从 worker 进程内的会话档位状态读值。
2. **随包 config**：`agent-host/permissionPolicy.mjs` 加 `authorizerChain: ['aiclient-session-tier']`。
3. **Worker RPC**：`piWorkerRpcServer.ts` 加设档命令（形态参照已有的 `worker.extensionUi.respond`）。
4. **Main**：IPC 转发 + 会话快照同步。
5. **渲染层**：Composer 底栏 chip + 四档菜单 + 危险档二次确认（复用 `i18n.ts:1643-1704` 既有键），
   档位存会话偏好（参照 `sessionPreferenceStore.ts` 的 effort 模式），立即生效（link 实时读值），新会话默认「务实」。
