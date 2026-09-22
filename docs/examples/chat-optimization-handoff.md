# Chat 内容显示优化（Q1）交接

> 当前范围以本次会话用户最新明确要求为准。旧稿及原型中“最终回复绿色边条、底色、突出显示”的方案已取消，不能继续作为实现依据。
> 状态：展示逻辑与测试更新已完成，最新 205 项聊天测试与八文件定向 Biome 检查通过；typecheck 仅有下述两项预存错误。开发版界面实测尚未完成。

## 当前需求

1. 区分最终回复与中间说明文本。最终回复沿用现有普通 answer 样式，不加颜色强调、边框、背景或额外缩进。
2. 移除“已处理 N 个步骤”头部，改为具体文字 chips：`思考 · N 次工具调用 · N 段说明`。不存在的类别省略。
3. 中间说明使用现有 `text-muted-foreground` 降亮，并归入过程区折叠，不使用斜体。

过程区点击展开/收起、未决授权强制展开、notice 独立可见的规则保留。Q2（Automatic 模型选项）、Q3（/compact）不在范围内。`chatSessions.ts`、`App.tsx`、全局主题未改动。

## 实现现状

- `turnProcessFold.ts`：最后一个 answer 段成为 `finalAnswer`；中间 answer 与相邻 process 归入 `processGroup`。notice 在有 answer 的场景保持原序且独立；无 answer 时保留原有 process 合组、notice 在后的排序。最终回复后的 process 独立分组。新增思考与说明计数，工具计数复用既有函数。
- `MessageTimeline.tsx`：头部使用 `useI18n()` 输出三类 chips；最终回复调用普通 `renderSegment`；组内文本通过 `renderSegment(segment, true)` 降亮。删除了交接初稿中的最终回复装饰包装与相关 import。
- `chatTimelineLayout.ts`：只新增中间说明 tone，删除 `turnFinalAnswerClass`，未修改任何主题变量。
- `i18n.ts`：新增 `Thinking chip`、说明单复数 key，移除旧 `steps processed` key。
- 测试：更新 wiring 与旧进度头目录守卫；修复 WG-8 测试的 TypeScript 收窄；增加中间说明/普通回复样式与 chips 中文翻译断言。

## 验证记录与边界

最新一轮成功的五个聊天测试文件合计 **205 项通过**：

| 测试 | 通过数 |
| --- | ---: |
| `messageTimelineWiring.test.ts` | 61 |
| `turnProgress.test.ts` | 25 |
| `chatTimelineLayout.test.ts` | 36 |
| `turnProcessFold.test.ts` | 41 |
| `chatTurn.test.ts` | 42 |

之后 WG-8 类型修复的定向复测通过（wiring 61 + fold 41）。成功执行的最后一次 `tsc --noEmit` 只报告交接中已有的两项错误：

- `src/renderer/components/settings/__tests__/userProvidersSettings.test.ts:362`：`Element.click` 类型问题。
- `src/runtime/host/httpDispatcher.ts:118`：缺少 `undici` 模块/类型。

`i18nCoverage.test.ts`：1/2 通过；失败为 `ProviderSetupDialog.tsx` 的六个非本次 key：Image、Input、Output limit、Per-model metadata、Reasoning、Text。本次未修改该设置界面。

提交前已复测新增的两项测试（布局 +1、翻译 +1）、wiring/WG-8 断言及 chips key 调整，五文件共 205 项通过。八个源代码/测试文件的定向 Biome 检查通过，已修复长行格式；typecheck 再次确认仅有上述两个预存错误。此前权限超时阻塞已解除。

## 剩余验收

1. [x] 八个文件定向 Biome 检查与格式修复。
2. [x] 五个聊天测试文件串行复测，205 项通过。
3. [x] 串行复查 typecheck，仅两项预存错误。
4. [ ] 开发版 Electron 实测：混合思考/工具/中间说明的 turn、chips 省略与计数、过程区开合、二级工具/思考折叠状态、未决授权强制展开、notice 可见、普通最终回复样式。静态原型不能代替实测。

当前环境为 Windows + Git Bash。资源检查使用显式调用 `powershell.exe`，测试/typecheck/构建不得并行；不运行整套生产构建，不终止用户的正常客户端进程。
