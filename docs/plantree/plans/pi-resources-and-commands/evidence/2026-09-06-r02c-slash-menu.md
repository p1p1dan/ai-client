# Evidence — R02-c 补全浮层与发送前拦截

**日期**：2026-09-06
**关闭**：roadmap R02-c（R02 整片完成）
**决定**：[D02](../decisions/002-builtin-slash-commands-only-where-no-control-exists.md)

## 一、`/` 不是 `@`

仓库里已经有一个补全浮层——T-07 的 `@` 文件引用，带方向键 / Enter / Esc 拦截。
交互形态复用了它，但**触发条件完全不同**，这是本片最容易做错的地方：

| | `@` 提及 | `/` 命令 |
|---|---|---|
| 位置 | 任意处，前面是空白 | **只在整条消息开头** |
| 需要工作目录 | 是（要搜文件） | **否** |
| 数据源 | 文件搜索服务 | agent 的配置 |

`extractSlashQuery` 因此只在「文本以 `/` 开头且光标还在第一个词内」时返回查询。
`look in /tmp` 是散文，pi 也是这么当散文处理的。

**「不需要工作目录」是承重的**：起始屏没有 cwd，而那正是有人要打 `/new` 的地方。
所以斜杠追踪写在 `handleContentChange` 的 cwd 守卫**之前**，
`onCompositionEnd` 同样。两条都有静态断言，因为这是纯粹的顺序事实。

## 二、内置命令不抢插件的名字

`resolveSlashAction` 第一行：

```ts
if (source && source !== 'builtin') return { type: 'runtime' };
```

`source` 来自目录，所以插件注册的 `new` 解析为 `runtime`，原样交给 pi。
`buildSlashCatalog` 同理——名字已被占用时不加自己的那条。

没有这一行，加一个内置命令就会**静默夺走**同名插件的命令，
而用户和插件作者都看不出发生了什么。

## 三、只有 `/compact` 留痕

用户拍板砍掉了 `/permission`（底栏已有控件），`/model` 同理砍掉。剩下四条：

| 命令 | 反馈 |
|---|---|
| `/new`、`/settings`、`/archive` | 界面变化本身 |
| `/compact` | 时间线系统提示 |

**打开面板不在聊天流里留痕。** 输入框清空了、面板开了——再写一条「已打开设置」
是噪音，而且会永久留在对话记录里。

`/compact` 的显示端**一行没写**：`piSessionTimeline.ts:116` 早就把
`entry.type === 'compaction'` 转成系统提示，pi 压缩完自己会写那条记录。
新加的只有一条 RPC 到 `session.compact()`，它是 mutation（pi 会先中止当前回合
且不恢复），所以在 `WorkerManager` 那侧走完整的 ready / idle / claim 三道闸——
与同一个类上 `getSlashCommands` 一道都不走恰成对照。

**拦截在 `decideSendAction` 之前**：这些是窗口里的动作，不是回合，
不该被排进正在跑的回合后面。带附件时不拦——`/compact` 加三个文件不是命令，
是一条用户打了一半的消息。

## 四、`/settings` 怎么跨层

`openSettings` 在 `App/hooks/useSettingsState` 里，输入框在它下面好几层。
一路传回调会让中间每个组件都多一个纯粹当管道用的 prop。

改用意图 store `stores/settingsIntent.ts`，形状照抄 `navigation.ts` 的
pending 请求：输入框记一个标志，App 层消费并清空。
**布尔而非计数器**——连打两次 `/settings` 应该开一次，不是两次。
清空写在打开之前，避免打开过程中的重渲染再触发一次。

## 五、门禁

| 项 | 结果 |
|---|---|
| `pnpm test`（全仓） | **284 files / 4304 tests pass** |
| `pnpm typecheck` | pass |
| `npx biome check src/` | 干净 |
| `git diff --check` | 干净 |

282/4278 → 284/4304：新增 26 条（`slashCommands` 17、`slashCommandWiringStatic` 9）。
**没有改写任何既有断言。**

## 六、变异验证

| 变异 | 结果 |
|---|---|
| 斜杠追踪移到 cwd 守卫之后 | `1 failed \| 8 passed` |
| 解析时硬传 `'builtin'`（不查目录来源） | `1 failed \| 8 passed` |
| 拦截移到 `decideSendAction` 之后 | `1 failed \| 8 passed` |

三处各自判红，恢复后全绿。

## 七、真机验证

CDP 探针（`--remote-debugging-port=9333`，`AICLIENT_SKIP_AUTH_GATE=1`），本机 profile：

| 步骤 | 实测 |
|---|---|
| 无会话时问 IPC | `{n: 0, truncated: false}`——**空列表，不报错** |
| 打 `/` | 菜单出现，4 条内置命令 |
| 打 `/ne` | 过滤到 1 条 `/new` |
| 打 `look in /tmp` | **0 条**，菜单不出现 |

截图见 [`2026-09-06-r02c-shots/01-slash-menu.png`](./2026-09-06-r02c-shots/01-slash-menu.png)。

**探针抓到一个 i18n 缺口**：四条命令里只有 `/settings` 显示中文，
另外三条和底部的键盘提示是英文——`shared/i18n.ts` 里没有词条。
补三条后复跑，四条全部中文（`Navigate` / `Select` / `Close` 已有词条，
我先加的重复条目被 `tsc` 判出 TS1117 后删掉）。

## 八、欠项

- **命令目录实测为空**。本机 profile 在托管模式下，agentDir 是
  `~/.pilab/pi-agent`，那里没有装任何技能或模板，所以 pi 那侧确实没有命令可报。
  **R01 的借用没有被这次探针覆盖到**——它只在托管模式生效，而要看到效果需要
  `~/.pi/agent/skills` 里真有技能且 worker 已启动。两条一起并入下次真机点验。
- **`truncated` 仍然无人显示**。字段诚实，但菜单上没有「列表被截断」的说法。
  256 条的上限在实践中极难触到，留到有人真的撞上。
- **`/compact` 与 `/archive` 未在真机跑过**。两者都会真的改动本机会话，
  探针只验到了菜单与过滤。执行路径由 `WorkerManager` 与
  `archiveSessionIndexEntry` 的既有断言覆盖，端到端没跑。
- **参数级补全没做**（SDK 的 `getArgumentCompletions`），
  pi 的 shell 注入语法（`!命令`）也没做，两者都在同一个位置，留作后续。
