# PERM-1 与权限链复验

Role: evidence。日期：2026-09-11。对应[执行顺序](../../../README.md#执行顺序)第 5 批第 4 项，
以及[现场缺陷与修复](../../../README.md#现场缺陷与修复)的 PERM-1 行与 [P1-6 审批流](../../../README.md#p1)。

> **2026-09-15 时点注记**：legacy 引擎随 P6-5（`fe246bd6`，2026-09-14）整体退役，`PERM1_NATIVE=1`
> 变体已被 T028 删除（`scripts/run-perm1-probe.mjs` 现在只剩一套输出文件名）；扩展 UI 审批通道
> 也随 T036（`ce7f3b3a`，2026-09-15）整链退役。下面第 16 行记录的插件英文弹窗、第 104 行
> 「是否接管」的未决项，描述的都是已经不存在的通道，仅作历史存档读，不再是待决策项。
> **复跑须知**：探针把输出写死到本目录（`perm1-report.json` 与四张 `perm1-*.png`），T032 要求的
> PERM-1 复跑会原地覆盖下面这套被标为 legacy 的历史证据，覆盖前请先把本目录现有文件复制进一份
> 按日期命名的子目录（如 `2026-09-11/`）留档，再执行复跑。

`node scripts/run-perm1-probe.mjs`。两个后端曾经各跑一趟（另一趟经 `PERM1_NATIVE=1` 触发），
下表保留两栏是当年真实跑出的结果；探针现在只跑得动 native 一种形态。
两趟都在开发机 Electron 上用真实点击与真实回合跑。

## 为什么要跑两趟

**两个后端给的审批界面根本不是同一张。** 这件事以前没在记录里写清楚，而它会直接决定
点验的结论：

| 后端 | 审批长什么样 | 语言 |
|---|---|---|
| legacy | pi 的 permission-system 插件自己用 `ui.select` 提的问，经扩展 UI 通道原样渲染 | **全英文**（`Permission Required` / `tool` / `rule` / `Yes` / `No`），是插件写死的 |
| native | 结构化权限卡（`9cf6bbde`），走我们自己的 permission 事件 | 全中文，含高风险徽标与倒计时 |

第一版探针只找「权限」两个字，在 legacy 下就把插件那张英文弹窗读成了「压根没弹审批」。
现在探针两种都认，并把命中的是哪一种记进报告。开发机 dev.env 没写
`AICLIENT_RUNTIME_BACKEND`，而 `readRuntimeFlags` 把「不是 native」一律读成 legacy，
所以 native 那趟要另换一份 dev.env 副本。

## 结果

| 判据 | legacy | native |
|---|---|---|
| 弹层列出两个模式 + 三个档位 | ✅ | ✅ |
| 选普通档后弹层立刻关闭 | ✅ | ✅ |
| 触发器标签跟着变 | ✅ | ✅ |
| 选「全自动」弹层**留着**并换成确认面板 | ✅ | ✅ |
| 确认面板点「取消」什么都不应用 | ✅ | ✅ |
| 换模式同样选完即关 | ✅ | ✅ |
| 复位回「执行 · 每次询问」 | ✅ | ✅ |
| 真实回合弹出审批 | ✅（插件英文弹窗） | ✅（结构化中文卡） |
| 卡片文案走词典（第 4 批回归） | — 不适用 | ✅ |
| 允许之后请求消失、命令真的执行 | ✅ | ✅ |

原始输出（2026-09-11 采集，legacy/native 各跑一次，legacy 侧文件名未加后缀）：
[perm1-report.json](perm1-report.json)（legacy）、[perm1-native-report.json](perm1-native-report.json)（native）。
探针的 `PERM1_NATIVE=1` 变体已被 T028 删除，现在只输出 `perm1-report.json` 与不带后缀的
`perm1-*.png` 这一套名字——下次复跑产出的是 native 结果，但会落在这份记录标为「legacy」的
同名文件里，见文件顶部「复跑须知」。

native 那张卡整屏读回来是这样，**倒计时在**：

```
权限
高风险

bash — 在工作区运行命令

echo perm-probe-ok

工作目录：/home/ai/code/ai-client
项目：/home/ai/code/ai-client

若 119 秒内未响应将自动拒绝
直接允许   本会话内允许   直接拒绝
```

点「直接允许」之后请求消失，`perm-probe-ok` 真的出现在时间线里
（[截图](perm1-native-after-allow.png)）。legacy 那趟点插件自己的 `Yes`，同样落地。

档位弹层截图：[perm1-popup.png](perm1-popup.png)、[全自动确认面板](perm1-auto-confirm.png)。

## 探针踩的一个坑：「关掉了」不等于「从 DOM 里消失了」

第一版把判据写成 `document.querySelector('[role="menu"]') === null`，于是量到一次
「2.5 秒还没关掉」，差点被写成 PERM-1 回归。

实测下来不是：**Base UI 关闭弹层之后节点还留在 DOM 里**，只是把 `data-open` 换成
`data-closed`，`display` 仍然是 `flex`。按「节点还在不在」判断，量的是**卸载**——那受
退场动画和上一轮残留节点的影响，读数在同一台机器上时好时坏（重复八轮，六轮读成没关）。

判据改成 `[data-slot="menu-popup"][data-open]` 之后稳定了：点完档位到 `data-open`
消失是 **100 毫秒以内**。PERM-1 的修法（关闭交给按下通道，不等 IPC）在真实点击下成立。

## 顺带记两件事

- **「worker 永不回执时弹层也必须关」没法在真实应用里造**，由单测钉住（`1e1e4469`
  带的两项用例）。这份记录不覆盖那一条。
- **`拒绝并停止` 这一档本轮没出现**：这次的请求只给了三个选项（直接允许 / 本会话内允许 /
  直接拒绝）。选项集合是按请求给的，不是固定四个，所以这不是缺失。要验第四个得造一个
  带 `cancel` 决策的请求。

## 点验中发现、**未修**的问题

**权限档控件整块是硬编码中文，切到英文界面也不会变。**
`PERMISSION_GEAR_LABELS` / `RUNTIME_MODE_LABELS`（`src/shared/types/runtimePermission.ts`）
和 `ComposerPermissionTrigger.tsx` 里的七条文案（「启用全自动？」「当前轮次结束后可修改
模式和权限。」等）都没经过 `t()`。语言在设置 · 通用里是用户可选的，所以这条是能撞到的。

顺手扫了一遍全仓，**`src/renderer` + `src/shared` 共 15 个文件、82 条硬编码中文字面量**，
前几名是 `OnboardingView.tsx`(24)、`historyError.ts`(17)、`ComposerPermissionTrigger.tsx`(7)、
`surfaceRegistry.ts`(6)、`runtimePermission.ts`(5)。另外 `LeftNav.tsx` 的行内按钮
`aria-label="Archive session"` / `"Close session"` 是反过来的——硬编码英文，中文界面下
读屏器读到的是英文。

这和第 4 批是同一类问题的两个方向，第 4 批只清了「中文界面里的英文」那一半。
**没有在本轮修**：它是一摊独立的活，不属于 PERM-1 的范围，量级也值得单独排一批。

## 还没验的

- **未打包，未在加密 Windows 上回归。** 按用户 2026-09-11 的规矩并入最后一次上机。
- **超时自动拒绝没等满**：卡上写着「若 119 秒内未响应将自动拒绝」，本轮在倒计时走完前
  就点了允许。倒计时到底的那条路仍只有单测覆盖。
- legacy 那张插件弹窗的英文是否要接管，属于产品取舍，未决。
