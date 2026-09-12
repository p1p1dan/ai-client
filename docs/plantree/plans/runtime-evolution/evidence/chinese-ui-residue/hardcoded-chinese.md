# 反方向的那一半：硬编码中文改走词典

Role: evidence。日期：2026-09-11。与[中文界面英文残留](README.md)是同一件事的两个方向。

用户当日决定：**界面上出现英文可以接受，只要意思清楚、用户看得懂。** 所以这批不是把
中文抠掉，而是把中文从代码里挪进词典——英文当键、中文当值，切语言时它们才会跟着变。

## 为什么这是个缺陷，而不是「反正没人用英文」

语言在**设置 · 通用**里是用户可以选的。选了英文之后，这些写死的中文一个字都不会变。
被影响最重的是输入框旁边那个权限档控件：`PERMISSION_GEAR_LABELS`、
`RUNTIME_MODE_LABELS`、三个档位的说明、「启用全自动？」确认面板——**整块都是中文字面量**，
而它恰好是 PERM-1 复验时盯着看了半天的那个控件。

第 4 批清的是反方向（中文界面里的英文），它的扫描器只认字面 `t('…')`，因此**看不见这一半**。
2026-09-11 扫出来：`src/renderer` + `src/shared` 共 **15 个文件、82 条中文字面量**，
另外还有一批是 JSX 里的裸文本（不是字符串字面量，第一版扫描器同样漏了）。

## 改了哪些面

| 面 | 文件 | 之前英文界面显示 |
|---|---|---|
| 权限档控件 | `runtimePermission.ts`、`ComposerPermissionTrigger.tsx` | 每次询问 / 自动接受编辑 / 全自动 / 规划 / 执行、三条档位说明、「启用全自动？」确认面板、失败提示 |
| 历史读取失败通知 | `historyError.ts` + `MessageTimeline.tsx` | 八个错误码的 guidance 与 continuationHint，加上重试提示 |
| 模型缺失 / 需要重新登录 | `modelMissingError.ts`、`authRequiredError.ts` | 三处文案 + 按钮 |
| Host 状态条 | `hostStatus.ts` + `HostStatusBanner.tsx` | 出错 / 已停止 / 正在启动 与两条 Retry 指引 |
| 登录流程 | `OnboardingView.tsx` | 十二条服务端错误映射 + 整屏界面（注册 / 邮箱 / 验证码 / 登录完成） |
| 历史导入 | `SessionManagerView.tsx`、`SessionItem.tsx`、`time.ts` | 导入历史、全选、导入报告、空态、网格/列表视图、「昨天」与 M月D日 |
| 运行时检测失败页 | `Root.tsx` | 无法检测 Pi 运行时 + 整段说明 |
| PDF / Mermaid 预览 | `PdfPreview.tsx`、`mermaid-renderer.tsx` | 加载中、渲染失败、适应宽度 |
| 面板占位 | `surfaceRegistry.ts` + `SurfacePlaceholder.tsx` | `pendingTask: '后置'` 被当作任务名插进一句已翻译的话里 |

共 **108 条新词条**写进 `zhTranslations`，零重复键。

### 三种改法，按模块性质选

- **组件里直接 `t('English')`**，中文进词典。多数是这一类。
- **纯 `.ts` 模块吐「键」，渲染那一层翻**。`historyError` / `hostStatus` /
  `modelMissingError` / `authRequiredError` 都没有翻译器在作用域里，它们的 `title`
  本来就已经是英文键了——这次只是让 `guidance`、`continuationHint` 等字段跟上，
  并在 `MessageTimeline` / `HostStatusBanner` 里补上 `t()`。
- **要拼数字/路径的收一个 `t` 参数**，默认 `englishTranslate`。`sessions/time.ts` 的
  `formatActivityLabel` 和 `OnboardingView` 的 `describeOnboardingError` 是这一类：
  它们要拼「{{count}} 次」「{{month}} 月 {{day}} 日」，没法整句当键。默认值是英文本身，
  所以**没接线的老调用点输出一个字节都不变**。

## 边界：什么故意没动

- **发给模型的提示词**（`stores/settings/defaults.ts` 的 commit / code-review /
  分支命名三段）与 code-review 的输出语言值 `'中文'`。那是**发给模型的指令**，不是给
  用户看的字；翻译它等于改变我们要求模型做什么。
- **代码注释**。全仓还有 **230 行中文注释**（`src/renderer` + `src/shared` + `src/main`，
  不含测试）。项目规范要求注释用英文，但那是另一摊活，本轮只顺手清了
  `PdfPreview.tsx` 这一个已经在改的文件。

## 守卫：`src/shared/__tests__/noHardcodedChinese.test.ts`

扫 `src/renderer` + `src/shared` 的所有 `.ts` / `.tsx`，去掉注释后**不允许出现任何中文**，
白名单三条、每条写明理由（词典本身、模型提示词、code-review 语言值）。另外两条断言防止
这个扫描自己失效：文件数 > 300（走空了的 walker 会让主断言在零个文件上通过），
以及白名单里的每个路径都还存在（指向已删文件的豁免是个没人会发现的洞）。

**反向验过**：把 `hostStatus.ts` 的一条改回中文，立刻挂并精确报出文件与行号；改回来即绿。

## 验证

- 全量 **378 文件 / 5320 测试通过**；根目录与 runtime 两套 tsc 通过；Biome 回到既有基线
  （仓库里另有 4 处此前就存在的问题，`git stash` 后同样复现）。
- 顺带修了 20 处因这次改动失效的旧断言。其中 `composerPermissions.test.ts` 值得单说：
  它把 `useI18n` 打桩成 `(key) => key`，于是断言检查的是键而不是用户读到的字——正是第 4 批
  在 `questionCardInteraction` 里发现的同一个陷阱。换成**真的 zh 翻译器**之后，那几条
  中文断言反过来又成了「词条确实存在」的证明。
- **真机确认**（开发机 Electron + CDP，`node scripts/run-perm1-probe.mjs`）：权限档弹层
  读回来仍是「规划 / 勘察并提交实现计划，等待批准。/ 执行 / 每次询问 / 自动接受编辑 /
  全自动 / 立即生效，作用于当前线程。」一字不差，触发器标签仍是「执行 · 每次询问」，
  PERM-1 的全部判据仍然通过。

## 还没做的

- **英文界面没有逐屏点验过。** 自动化只证明「中文来自词典」；把语言切到英文再走一遍
  登录流程和历史通知，属于后续 GUI 点验。
- 230 行中文注释未清理。
- 未打包、未在加密 Windows 上回归。
