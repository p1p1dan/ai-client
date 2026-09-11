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

D4（英文残留）、D6（重复公告）、D7（模态堆叠）本轮未动，按原计划归入各自已登记的摊子。

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
