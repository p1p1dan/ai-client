# 决策 141：模型计划对 anthropic-messages 的 adaptive-only 加固——不再对 forceAdaptiveThinking 的行输出 off

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：用户在真实网关上用 Claude Opus 5.5 时，1.0.4 的手动压缩收到上游 400：`"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`。派工提示词已从代码证实根因与两条仍会触发的路径，本决策只记录 DSH 分支这一侧的加固方案。

## 背景

- DSH 分支按现有模型计划**默认不会**触发这个 400：`translateReasoningEfforts`（`src/shared/dshModelPlan/build.ts`）从不输出 `null`，`off` 只有在 `thinkingLevelMap.off` 写了非空字符串时才会出现在计划里；不带档位的请求（压缩、一次性补全）不带 `thinking`，模型按 adaptive 默认 medium 运行。
- 但两种配置仍会触发（代码路径已证实）：
  1. `models.json` 里某一行的 `thinkingLevelMap.off` 写了非空字符串：`translateReasoningEfforts` 会输出 `off`，而 pi-ai（`@earendil-works/pi-ai` 的 `anthropic-messages.js`）对 anthropic 路径不看这个值是什么，只要 `model.compat?.forceAdaptiveThinking === true` 就用 adaptive、否则一旦 `thinkingLevel` 落到 `off` 就发 `thinking:{type:"disabled"}`——对一个只支持 adaptive 的模型，这就是 400 的直接原因。
  2. 该模型走 `openai-completions` 且 `compat.thinkingFormat === "zai"`：没有档时无条件发 `thinking:{type:"disabled"}`。这条是 GLM 类模型的正常行为（关闭思考对它们合法），本决策**不改**。
- 相邻风险：`api === 'anthropic-messages'`、`reasoning: true` 却没有声明 `compat.forceAdaptiveThinking` 的行，会话轮会发 `thinking:{type:"enabled", budget_tokens}`；对 Opus 5.5 这类只支持 adaptive 的模型，这同样会被上游拒绝，但我们无法仅凭模型 id 判断它是不是 adaptive-only。

DSH 自带（随包快照）的 `claude` provider 已经在 provider 级 `compat` 里声明了 `forceAdaptiveThinking:true`（见 `docs/plantree/plans/dsh-rebase/topics/p1-5-models-and-credentials/01-current-state.md`），且其 `thinkingLevelMap.off` 写的是 `null`——按现状本来就不输出 `off`，所以随包快照不受影响；真正会撞的是用户/管理员在 `models.json` 里给某个 anthropic-messages 模型手写了非空 `off`（例如照抄了别的协议 `off:"none"` 的写法）。

## 做了什么

1. **`src/shared/dshModelPlan/build.ts` 新增 `adaptiveThinkingCompat`**：对一行的 `api === 'anthropic-messages'`，取该行自己的 `compat.forceAdaptiveThinking`；行上没写就退到 provider 级 `compat.forceAdaptiveThinking`（逐字段合并，行覆盖 provider，照抄 `dsh-llm-pi-ai` 自己的 `resolveModelCompat` 合并规则——provider 级只声明一次、对该 provider 下所有模型生效的写法，是随包快照 `claude` provider 已经在用的真实形态）。返回 `{ declared, forced }`：
   - `forced === true` 时，`planModel` 在算出 `reasoningEfforts` 之后把 `off` 键摘掉（其余档位不动），并记一条 `{kind:'field', field:'reasoningEfforts.off', reason:'adaptive_thinking_forced'}` 诊断（走 `dropField`，与其余诊断同一套去重机制，`src/main/services/piModelConfig/dshModelPlan.ts` 已有的日志行会原样带出这条）。
   - `declared === false` 时才算「没声明」；行或 provider 哪怕显式写了 `forceAdaptiveThinking:false`，也算「声明过」，不算未声明——这是本行/该 provider 主动做过的选择，不是需要提醒的空白。
2. **advisory 诊断**：`api === 'anthropic-messages'`、`raw.reasoning === true`、且 `!declared`（行和 provider 都没写这个开关）时，记一条 `{field:'compat.forceAdaptiveThinking', reason:'adaptive_thinking_undeclared'}` 诊断，**不改任何下发内容**——模型 id 无法可靠判断是不是 adaptive-only，误判的代价（错误地摘掉一个真支持 disabled 的模型的 off 档）比漏判更大。
3. **`DshFieldDropReason`（`types.ts`）新增两个取值**：`adaptive_thinking_forced`、`adaptive_thinking_undeclared`。两者都是 `kind:'field'`，菜单侧的 `applyDshPlanToCatalog`（`menu.ts`）只读 `kind:'model'` 的丢弃，所以这两条新诊断不影响模型菜单的可用性判断，只影响该模型自己的 `reasoningEfforts`/`efforts`。
4. **单测**：`src/shared/dshModelPlan/__tests__/dshModelPlan.test.ts` 新增 `adaptive-only thinking hardening (decision 141)` 一组共 7 个用例，覆盖：行级声明生效并摘 off、provider 级声明的继承、行显式 `false` 覆盖 provider 的 `true`（不摘、不提示）、老模型无声明时行为不变但给出 advisory、非 reasoning 行与非 anthropic-messages 协议两种都不给任何诊断、zai 路径完全不受影响。

## 没做什么

- **不碰 `openai-completions` + `thinkingFormat:"zai"` 路径**：关闭思考对 GLM 类模型是合法状态，`off` 应当继续可下发，本决策没有触碰这条分支（`forcesAdaptiveThinking` 一开始就用 `api !== 'anthropic-messages'` 短路掉）。
- **不从模型 id / 名字猜测是否 adaptive-only**：没有可靠信号（同一个 `claude-opus` 前缀下既有旧的、支持 `disabled` 的版本，也有新的只认 adaptive 的版本），猜错的后果是让本来合法的 `off` 档消失。所以第 2 类风险只发诊断、不改行为，需要有人在 `models.json` 里显式声明 `compat.forceAdaptiveThinking`。
- **不追溯性改随包快照的 `models.json`**：随包快照的 `claude` provider 已经在 provider 级声明了 `forceAdaptiveThinking:true`，不需要改；本决策的 advisory 诊断不会对它触发。
- **不改 `resolveRoute`（`route.ts`）**：一旦 `off` 从 `reasoningEfforts`/`index[...].efforts` 里摘掉，`resolveRoute` 原有逻辑（显式选中一个模型不提供的档位就 `droppedEffort` 而不是硬发）已经会把用户显式选中的 `off` 挡掉，不需要额外改动。

## 对档位菜单的影响（代价）

- 档位菜单（渲染层可选档位）由 `DshPlanIndexEntry.efforts` 派生，而 `efforts` 就是 `effortsOf(reasoningEfforts)` 的结果——两者同源，`build.ts` 与 `menu.ts`/渲染层没有第二份独立的「off 是否可选」判断。
- 因此：一个 `api==='anthropic-messages'` 且有效 `compat.forceAdaptiveThinking===true` 的模型，**档位菜单里将不再出现「关闭思考」这一档**，即便 `models.json` 给它的 `thinkingLevelMap.off` 写了非空字符串。这是本决策的直接代价：用户对这些模型失去手动关闭思考的入口，换来的是不再对上游发出它拒绝的 `thinking:{type:"disabled"}`。

## 取舍

- 不选「翻译层完全不认 `compat`，只让宿主自己在真正发请求时兜底」：宿主侧的 `anthropic-messages.js` 是第三方包代码，不在本项目改动范围内，且即便改了也只能在真正发请求那一刻兜底，此时用户已经在菜单里看到并选中了一个必然 400 的档位，体验更差；在计划层直接不生成这个档位，让菜单本身诚实。
- 不选「无论有没有声明 `forceAdaptiveThinking` 都摘掉 anthropic-messages 的 off」：会连累老模型（`disabled` 合法）的用户体验，且违背派工提示词「先确认没有 `forceAdaptiveThinking` 的行行为不变」的要求。
- 不选「把 advisory 诊断做成阻断（丢模型或丢字段）」：我们只是不确定，不是确定出错；确定出错的（`forced===true` 时的 `off`）已经在做丢弃处理，不确定的只适合留痕提醒。
