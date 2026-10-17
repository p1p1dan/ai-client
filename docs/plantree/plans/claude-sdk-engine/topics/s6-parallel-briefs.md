# S-6 反馈：可以并行交给另一个代理做的三项（2026-10-17）

这三项与 [S-6 反馈清单](s6-feedback.md) 里正在做的其余各项（SDK 宿主 `src/claude-sdk-host/` 的第 1、4、9 条）不改同一批文件，可以单独开分支做，做完交回来合并验收。

## 通用约定（三项都适用）

- **起点**：本地分支 `claude/s6-feedback` 上提交本文件的那个提交。每项各开一个分支，例如 `git worktree add -b gpt/s6-dev-mode <目录> <该提交>`。不要直接在 `claude/s6-feedback` 上提交，不要推送。
- **先读**：仓库根的 `CLAUDE.md`（代码注释用英文、提交信息用 Conventional Commits 加中文描述）、`docs/design-system.md`（UI 组件优先用 `@/components/ui/*`，颜色用 CSS 变量，尺寸档位），以及本目录的 [S-6 反馈清单](s6-feedback.md) 对应条目与 §3 用户裁决。
- **文案**：界面文字走 `src/shared/i18n.ts`（英文原文作键，中文译文），不要在组件里写死中文。
- **验收**：根目录 `pnpm typecheck` 0 错；相关目录的 vitest 全过（这台 Windows 机器上 `src/shared/permissions` 有 4 条符号链接与 8.3 短名用例本来就失败，与改动无关，不算）；新行为有单测或挂载测试覆盖。
- **交回时写清**：改了哪些文件、怎么验证的、哪些没验证（比如没有实机点界面）。

## 任务 A：开发人员模式开关（反馈第 10 条，README 裁决 26）

**要做什么**：设置里加一个"开发人员模式"开关，默认关。关着时，下面三项设置不显示，而且一律按默认值生效：

- "缓存工具定义"（`ExperimentalCacheControlSection.tsx`，设置键 `experimentalCacheControlOnTools`）；
- "Agent SDK 引擎"开关（`ClaudeSdkEngineSection.tsx`，键 `claudeSdkEngineEnabled`，默认值 `DEFAULT_CLAUDE_SDK_ENGINE_ENABLED`）；
- "请求标识（User-Agent）"（`RequestUserAgentSection.tsx`，键 `requestUserAgentMode` / `requestUserAgentCustom`）。

Web Inspector 不收进去。三项现在都挂在 `src/renderer/components/settings/PiModelManagementSettings.tsx`。

**要点**：
- 开关明着放在设置里（建议放在"高级"页 `AdvancedSettings.tsx`），不用藏起来的打开方式。
- "按默认值生效"不只是隐藏界面：已经存过非默认值的用户，开发人员模式关着时这些值也不能再生效。在读取这三个值的地方统一判断（设置 store 在 `src/renderer/stores/settings/`，`claudeSdkEngineEnabled` 的读取点在 `ChatComposer.tsx`；另外两项去找它们的读取方，可能在主进程读设置文件的地方）。存储的值保留，打开开发人员模式后恢复原样。
- 新设置项要走现有的持久化与迁移（`stores/settings/types.ts`、`index.ts`、`migration.ts`）。

**验收**：单测覆盖"关着时三项读到的都是默认值、打开后读到存的值"；挂载测试覆盖"关着时三项不显示、打开后显示"。

## 任务 B：SDK 对话的模型菜单显示其他模型为灰色（反馈第 3 条，README 裁决 25）

**要做什么**：Agent SDK 引擎的对话开始后，模型菜单现在只列同一路由的模型（`src/renderer/components/chat/models.ts` 的 `modelCatalogForEngine`，`ComposerModelTrigger.tsx` 里的 `offeredCatalog`）。改成：其他模型也列出，但显示为灰色、不可选，悬停提示"Agent SDK 对话只能换同一服务的模型，换其他模型请新建对话"（文案可调，走 i18n）。

**要点**：
- 只是显示上的变化：选不了的项不能被选中，发送路径不变（主进程对跨路由仍会拒绝 `model_engine_mismatch`）。
- DSH 对话的菜单不受影响。
- 用 `@/components/ui/*` 里现有的菜单项禁用与提示方式，不要手写。
- 以后做完跨引擎换模型再放开，见 [issue #23](https://github.com/p1p1dan/ai-client/issues/23)，代码注释里引用它。

**验收**：`composerModelEngineFilter.test.ts` 一类的测试补上：SDK 对话菜单里其他路由的模型存在但禁用、带提示；点它不改变选中值；DSH 对话一切照旧。

## 任务 C：DSH 全自动模式少问人（反馈第 11c 条，issue #19，README 裁决 27）

**要做什么**：DSH 引擎的"全自动"档位现在只在两种情况下还问人：命令里有解析不了的参数（变量、子命令等，`request.unresolvedPaths`），以及碰到敏感文件或工作区外的路径。前一种最常见，所以日常 Bash 命令老是要人点。裁决是：**工作区内解析不了参数的命令也放行，只有删除、强推这类危险命令和明确碰到工作区外的路径才问**。

**入口**：`src/shared/permissions/gate.ts`（`gear === 'auto' && !request.unresolvedPaths` 那一段，以及之后 `if (request.unresolvedPaths) return 'ask'`）；命令解析在 `bashWalker.ts`、`pwshAnalysis.ts`、`shellTools.ts`。

**要点**：
- 所有 deny（策略、内置敏感文件、deny 范围、计划模式、工具白名单）的顺序与效果不变，只放宽 `auto` 档对"解析不了参数"的处理。
- 危险命令要有明确清单（至少：`rm -rf`/`rm -r`、`Remove-Item -Recurse`、`del /s`、`rd /s`、`git push --force`/`-f`、`git reset --hard`、`git clean -f`、`format`、`mkfs` 一类），这类命令在全自动下即使参数能解析也要问。先看现有代码是否已有类似清单（例如完全放行与全自动的说明文案里提到的"全自动仍会停下确认的命令"），有就复用。
- 明确解析出工作区外路径的仍然要问。
- `bypass`（完全放行）的行为不变。
- 把裁决与改法写进 `docs/plantree/plans/dsh-rebase/decisions/` 下的一份新决定，并在 [S-6 反馈清单](s6-feedback.md) 第 11c 条记一笔。

**验收**：`src/shared/permissions/__tests__` 补用例：全自动下 `echo $HOME`、`npm test $FLAGS` 这类工作区内命令不问；危险命令问；明确指向工作区外的命令问；deny 规则仍然拒绝；完全放行不变。
