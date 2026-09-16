# H/21 现场点验（2026-09-11，开发机）

Role: evidence。对象：[H/21 P0 + P1](../../topics/external-agent-migration.md)，顺带覆盖 [H/19 迁移页](../../topics/unified-agent-directory.md#验证案例)的验证案例 2 与 3。
提交：P0 `22da278c`、P1 `f147059b`、三出口修正 `0a0df6d1`。驱动：`scripts/h21-cdp.mjs` + `scripts/h21-step.mjs`（真实 Electron + CDP，非模拟）。

## 场地

开发机 `dev.env` 把 `PI_CODING_AGENT_DIR` 指向 `~/.pilab/t37c-agent`，所以**迁移源是这个 dev 沙箱**，用户真正的 `~/.pi/agent` 全程未被读写。两侧起始状态恰好就是 H/19 点验记录的那个场景：

| | 内容 |
|---|---|
| 源 `~/.pilab/t37c-agent` | `models.json`（providers `cx2` / `maxapi`）、`sessions/` 74 条 |
| 目标 `~/.pilab/jyw-ai-client-dev/pi-agent` | 只有两个空的 `auth.json` / `models-store.json`，**没有 models.json** |
| 会话索引 | 87 条，其中 16 条记的模型是 `maxapi/grok-4.6`、56 条 `cx2/gpt-5.6-terra` |

## 通过的部分

| # | 检查 | 结果 |
|---|---|---|
| 1 | 首启提示只对有东西可搬的人弹 | ✅ 弹出；来源/去向路径正确；只列有内容的两类（AI services、历史对话），没有内容的三类不出现 |
| 2 | 五项默认全勾 | ✅ 两项都是 `aria-checked=true` |
| 3 | API key 说明随勾选出现/消失 | ✅ 取消勾选「AI services」后说明立刻消失，重新勾上后回来 |
| 4 | 三个出口都在 | ✅ 「不再询问」「以后再说」「复制选中项」 |
| 5 | **「以后再说」不写标记，下次还问** | ✅ 点完 flag 仍为 `null`，重载后提示回来 |
| 6 | **「不再询问」是唯一永久的** | ✅ 点完 flag = `"true"`，重载后不再出现 |
| 7 | P0 旧会话报错不再误报成读历史失败 | ✅ 显示「这个会话记录的模型不在本应用的模型目录里…」，没有出现「读取或解析历史文件时出错」 |
| 8 | P0 不给必然失败的重试按钮 | ✅ 通知里没有 Retry |
| 9 | P0 原始诊断保留在 Details 里 | ✅ 折叠区仍有 `Pi model not found: maxapi/grok-4.6` |
| 10 | P0 按钮真的能到达补救入口 | ✅ 点击后设置打开并直接落在 Pi 页 |
| 11 | H/19 案例 2：迁移真的复制 | ✅ 报告「AI services 复制 2 项 / 历史对话 复制 74 项」，磁盘上 `models.json` + 74 个 jsonl 到位，源目录未被改动 |
| 12 | H/19 案例 3：重复执行不重复导入 | ✅ 再次打开时「AI services」显示「已经有了」且复选框不可勾 |

截图：[三个模态堆叠](01-three-modals-stacked.png) · [模型缺失通知](02-model-missing-notice.png)

## 修复与复验（2026-09-11，`b7dacfb0`）

D1/D2/D3/D5 已修并**在真机上重跑一遍**：把应用 agent 目录复位成迁移前状态（删掉 `models.json` 与 `sessions/`、清空 vault 里的用户服务），重新走一遍完整流程。

| 缺陷 | 修复后实测 |
|---|---|
| D1 | 迁移后 `models.json` 的键是 `cx2` / `maxapi`（原来是 `cx2-gpt-5-6` / `maxapi-grok`）；**那条旧会话干净打开，映射文案、原始诊断一条不剩** |
| D5 | 提示框显示「历史对话 **74**」（原来是 6），与复制报告的 74 一致 |
| D3 | 迁移全部完成后手动清掉标记再重载，提示**不再出现** |
| D2 | 移走 `models.json` 重启复现故障：上方映射通知在、**下方红带换成了指路文案**，`WORKER_REQUEST_FAILED` 全屏无一处 |

截图：[修复后旧会话正常打开](03-after-fix-session-opens.png) · [composer 提示已映射](04-composer-hint-fixed.png)

复验中另外确认的两件事：渲染层 `location.reload()` **不重启 worker**，所以造模型故障必须整个重启应用；应用**不会**在启动时从 vault 重建 `models.json`，删掉就是删掉了。

### 第二轮：D4 / D6 / D7（2026-09-11，`d0332939`）

| 缺陷 | 处理 |
|---|---|
| D4 | **修了，且范围比 D4 大**。点验只看到迁移列表一处，量化后全渲染层有 57 处走 `t()` 却无词条。一次补齐并加 `i18nCoverage` 测试（扫 1078 个字面量）。真机验：迁移列表两行都是中文，Pi 设置页六处英文一处不剩 |
| D7 | **修了**。让 H/17 L4 的「无服务时自动开设置」在有迁移可提供时让位。真机验：入口进去从三层模态变成两层（公告 + 迁移提示） |
| D6 | **查证后不是缺陷，未改代码**，见下 |

**D6 的查证**（原登记「重载后重复公告与多开空会话」）：

- 公告：`shouldOpenAnnouncementsOnStartup` 明确不看已读状态，注释写着「每次启动都弹」是已确认的产品决定。磁盘上 `announcements-read.json` 确实已记录该条为已读——读状态只驱动铃铛的未读标记。
- 空会话：`createLiveSession` 只造渲染层对象，不调 Host、不起 worker；会话索引里 `Live Agent Host` 条数为 **0**，证明它从不落盘，重载后重建一个是种子逻辑的正常行为，不累积。
- 触发条件本身：`MenuBuilder.ts:94` 只在 `!app.isPackaged` 时挂 `reload`/`forceReload`，**打包版里用户够不到重载**。生产唯一路径是渲染进程崩溃后 `ErrorBoundary.tsx:92` 的按钮，那时公告重来一遍本就合理。
- 原初判的 `--open-path` 方向排除：`APP_TAKE_PENDING_OPEN_PATH` 取一次即清空。

**一条订正**：上一轮我把 D7 里的设置框写成「恢复的上次状态」，那是推断，错的——`useSettingsState` 里是 `useState(false)`，不持久化。真正的来源是 H/17 L4 在本地路线且无已配置服务时主动打开设置 Pi 页。

**另一条顺带发现**：`agentMigrationPrompt.ts` 与 `AgentMigrationPrompt.tsx` 只差首字母大小写，在 Windows/macOS 上互相解析。仓库自带的大小写守卫测试抓到的，已改名 `migrationPromptModel.ts`。

## 查出的缺陷

### D1（严重）迁移改掉了 provider 的 ID，旧会话迁完照样起不来

这是本轮最重要的一条，**它让 H/19 迁移的主要目的落空**，也让 P0 指向的那个「解药」实际不治病。

```
源   ~/.pilab/t37c-agent/models.json        providers: cx2            maxapi
迁后 …/jyw-ai-client-dev/pi-agent/models.json providers: cx2-gpt-5-6    maxapi-grok
会话记录的模型                                            maxapi/grok-4.6  → 仍然解析不到
```

链路：源 provider `cx2` 带显示名 `CX2 (GPT-5.6)` → 迁移按显示名建 vault 记录 → `PiModelConfigService.ts:595` 的 `userProviderId()` 把**显示名**重新 slug 成 `cx2-gpt-5-6` 写回 `models.json`，原始键 `cx2` 丢失。

后果：迁移「成功」，磁盘上什么都在，但每一条旧会话的模型引用依旧指向不存在的 provider。用户按了我们让他按的按钮，报错一字不变。

修法方向：迁移进来的 provider 要把源键带上并优先用它当 `models.json` 的 key，`userProviderId()` 的 slug 只作为没有源键时的回退。涉及 `UserProvider` 记录形状、`AgentDirMigrationService.importProviders`、`PiModelConfigService.userProviderId` 三处。

### D2 composer 上方的红色错误条仍是原始诊断

我 P0 接了四个界面，漏了第五个。同一屏上方是映射文案、下方是这条：

```
Error: Error invoking remote method 'chat:resumeSession': WorkerSlotError:
WORKER_REQUEST_FAILED: Pi model not found: maxapi/grok-4.6
```

见 [02-model-missing-notice.png](02-model-missing-notice.png) 底部。

### D3 一个空目录让提示永远回来

源 `sessions/` 下有 6 个目录，其中 `permission-forwarding` 是空的（0 个 jsonl），不会被复制。于是「历史对话」永远算作还有 1 项待复制 → `itemWouldCopy` 为真 → 迁移全部完成后，下次启动**仍然弹出**提示，提议复制一个空文件夹。

### D4 「AI services」没有中文

迁移列表里它和「历史对话」并排，一个英文一个中文。同一页的 AI 服务面板整片英文：`Add service`、`Configured`、`No AI services yet`、`Add one to use your own model provider in this app.`。属于已登记的「中文界面英文残留」。

### D5 计数单位是目录，不是会话

列表显示「历史对话 6」，实际复制了 74 条。P1 的计划里我写过「数量让人能判断这堆大不大」——按目录数显示时这句话站不住，6 个文件夹说明不了任何事。

### D6 重载后公告重复弹出

已登记的缺陷，本轮现场复现：每次 reload 公告都重新弹一次。

### D7 三个模态框同时堆叠

进入应用时设置框（恢复的上次状态）、公告、迁移提示三层叠在一起。迁移提示在最上层，渲染正确，但这一摞本身不该出现。

## 一条方法记录

断言 `innerText.includes('去 Pi 设置补上模型')` 失败过一次，不是按钮不在，而是**按钮组件把文字转成小写**，实际渲染是「去 pi 设置补上模型」。按钮文案做断言时要么比对小写形式，要么读 DOM 属性而不是 innerText。

## 未覆盖

- 内嵌 TUI 的模型缺失覆盖层（P0 的第四个界面）——没在本轮切到 TUI。
- H/19 案例 4/5（插件安装与卸载、托管模式下项目级插件）——插件页本轮只看到「暂无已安装插件」，没有真装一个。
- H/19 案例 7（GUI 与 TUI 都能列出迁移后的历史对话）——依赖 H/20。

## C1～C6 对话导入（2026-09-11）

对象：[对话导入施工计划](../../topics/conversation-import.md)。两段证据：先用**离线探针**读本机真实历史（不起 Electron、不写任何东西），再用**真机**走完整闭环。驱动：`scripts/run-h21-import-scan-probe.mjs`（离线）+ `scripts/h21-import-check.mjs`（CDP，复用 `h21-cdp.mjs`）。

场地与上一轮相同：dev 沙箱 agent 目录 `~/.pilab/jyw-ai-client-dev/pi-agent`，用户自己的 `~/.pi` 全程未被读写。导入的**源**是用户真实的 `~/.claude` 与 `~/.codex`——只读。

### 离线探针：真实历史读出来是什么样

本机扫出 3 个项目：Claude Code `/home/ai/code/ai-client` 49 条、Codex 同目录 9 条、Codex `/home/ai/code/pi-cli` 1 条。每个项目取最近 3 条转写，逐条检查有没有合成注入漏进正文：

| 结果 | |
|---|---|
| 合成注入泄漏 | **0**（查 `<local-command-caveat>` / `<system-reminder>` / `<command-name>` / `# AGENTS.md` / `You are Codex` 五种标记） |
| 标题 | 修 `ClaudeSourceAdapter` 之前，Claude 最近几条全是 `/clear`；修完取到真实首句（「1.先收尾然后提交H/19…」「开始第 2 批 H/19…」） |
| 工具调用 | 作为只读 `display` 条目保留，不进模型上下文（当时由已退役的 `piLegacyImport` 做泄漏检查；P6-5 之后同一检查在 `nativeImport.ts` 的 `assertUsable` 里，见下方 2026-09-15 注记） |

### 真机闭环

> **2026-09-15 时点注记**：下表第 4 行记录的落盘路径 `…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl`
> 是 2026-09-11 现场当时的 pi 写入器布局（按工作区分子目录、文件名带时间戳前缀）。
> fe246bd6（P6-5，2026-09-14）退役旧引擎之后，导入产物改由 native 写入器落盘，路径变为扁平的
> `<agentDir>/sessions/<targetPiSessionId>.jsonl`（`src/runtime/worker/nativeImport.ts:255-265`
> 的 `fileFor`/`sessionsDir`），与 native 普通会话同一布局（`nativeWorkerRuntime.ts` 的 `sessionFilePath()`）。
> 代码本身自洽，此处只是证据页的路径描述已过期；按这份记录去复验会在一个不存在的路径下找文件。
> **C1～C6 的验收结论不受影响，仍然成立**。

| # | 检查 | 结果 |
|---|---|---|
| 1 | 设置 · Pi 出现「从 Claude Code / Codex 导入历史对话」，列出三个项目 | ✅ 全中文；`pi-cli` 带「未匹配到仓库」徽标，两个 `ai-client` 没有 |
| 2 | 进项目后列出会话（首句 / id / 时间 / 模型） | ✅ 9 条 Codex 会话，首句是真实提问 |
| 3 | 导入一条 | ✅ 报告「新导入 1 个，已存在 0 个，失败 0 个」 |
| 4 | 文件落在统一 sessions 目录 | ✅ 2026-09-11 实测路径 `…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl`（与 GUI/TUI 共用目录，验证案例 6）；**该路径形态已过期，见上方 2026-09-15 注记** |
| 5 | 索引行 | ✅ `agent: pi`、`legacyImport.sourceKind: codex`、dedupeKey 带内容指纹 |
| 6 | **导入后出现在侧栏** | ✅ 置顶「now」，在 `ai-client` 仓库下 |
| 7 | **打开能看到历史** | ✅ 完整 Codex 对话渲染，工具调用折叠成「已处理 N 个步骤」 |
| 8 | 重复导入 | ✅ 列表先显示「已导入 1 个快照」，再导报告「新导入 0 个，已存在 1 个」 |
| 9 | 未匹配仓库的项目 | ✅ 导入前就有警告；导入后索引行 `unbound: true`、workspacePath 在 `…/temporary/unbound-sessions/<uuid>`，侧栏落在「临时对话」组、标「临时」 |
| 10 | **在导入的会话里发消息** | ✅ 代理修复后复验通过，见下 |

截图：[导入段落](08-import-pane.png) · [导入报告](05-import-pane-report.png) · [导入的会话打开](06-imported-session-open.png) · [未绑定导入](07-unbound-import-open.png)

### 第 10 条：已闭环（2026-09-11 代理修复后复验）

代理恢复后用用户 2026-09-11 指定的新凭据（`vllmproxy` provider + `claude-sonnet-5`）重跑，**两条导入的会话都拿到了真实回复**：

| 会话 | 提问 | 回复 |
|---|---|---|
| 绑定仓库的那条（Codex，claude-env-cleanup 安装） | 「用一句中文回答：你刚才在这个会话里做了什么？」 | 模型**引用了导入进来的历史内容**作答，并主动指出那些安装步骤不是它本人在本次会话里执行的——这恰好说明工具调用是以只读条目导入、没有伪装成它自己的行动记录 |
| 未绑定的那条（Codex，pi-install.sh 报错，落在临时对话组） | 「用一句话说出上面这段对话在讨论什么问题。」 | 「修复 pi-install.sh 脚本因未单独检测 npm、且用 sudo npm 导致 PATH 找不到 npm 而报错的问题」——**准确复述了导入的中文历史** |

所以「可续聊」这条硬验收现在是完整的：resume 成功 → 导入的历史真的进了模型上下文 → 模型据此作答。**未绑定的临时对话同样能续聊**，scratch 目录这条回退路径不影响发送。

截图：[续聊回复](09-continue-chat-reply.png) · [未绑定会话续聊](10-unbound-continue-reply.png)

**这之前那次失败是谁的账户**：失败回合在会话文件里记的是 `provider: maxapi`、`model: grok-4.6`、端点 `https://maxapi.hanyue.xyz/v1`；该 provider 的 key 与用户自己的 `~/.pi/agent/models.json` 完全一致（sha256 前 12 位三处相同），即**用户本人的 maxapi 账户余额用尽**，用户已确认属预期。dev.env 里的 `ANTHROPIC_AUTH_TOKEN` 走的是登录模式，本次点验全程没有参与。

**两条手段上的记录**：

- 换模型这一步，base-ui 的子菜单对不带坐标的合成事件不响应，隔着两次 CDP 调用又会先自行收起。最后走的是应用自己的会话模型偏好（`aiclient:chat:session-models` 里写 `vllmproxy/claude-sonnet-5`，重载后 composer 显示 Claude Sonnet 5），**发送仍走真实的 textarea + 「发送消息」按钮**，没有绕过 composer。
- worker 只在启动时读一次模型目录：新加 provider 或复制完 AI 服务都必须整个重启应用，`location.reload()` 不够。

### 顺带查出并当场修掉的两条

**D8 导入会话顶部的来源提示是英文。** 「Imported read-only history from codex session …」出现在一整屏中文之上。这行不走 `t()`——它在 worker 里由 `piSessionTimeline.ts` 生成，而 worker 没有渲染层的 locale。已改成中文并复验。**同一类问题还有别的**：同一个文件里的 `Context summary` 也是 worker 直出的英文，`i18nCoverage` 那道守卫扫不到这一层，属于已登记的「硬编码英文残留」。

**D9 旧会话打开时报模型缺失，是环境不是缺陷。** 第一次打开导入的会话弹「这个会话记录的模型不在本应用的模型目录里」，Details 里是 `Pi model not found: maxapi/grok-4.6`——dev 沙箱 agent 目录当时**没有 models.json**（上一轮复验把它删了）。在设置里把「AI 服务」复制过来、**重启应用**后消失。两条可复用的事实：worker 只在启动时读一次模型目录，复制完必须重启；P0 的映射文案在导入会话上同样生效（顺带复验）。

### 本轮未覆盖

- 空机器（没有 `~/.claude` / `~/.codex`）的表现只有单元测试覆盖，本机两份目录都在。
- Codex 旧格式（裸行）只有构造用例，本机 10 个 rollout 全是新格式。
- Claude 侧只导了历史里的会话做离线转写校验，真机导入验的是 Codex 两条（一条匹配仓库、一条未匹配）。
