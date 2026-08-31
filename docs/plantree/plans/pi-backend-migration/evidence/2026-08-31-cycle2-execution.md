# Evidence — Cycle 2 权限 UI、扩展能力与模型体验

> 日期：2026-08-31
> 范围：T08-b、T09、T10、T17 第一切片、T25
> 施工基线：`feat/pi-primary-backend`，与未提交的 Cycle 1 收口改动同工作树并行；本批未覆盖或回退 Cycle 1 文件预览/消息队列实现。

## 1. 结论

Cycle 2 计划内五个任务节点已落地：

- **T08-b Done**：会话内联审批取代窗口级模态；后台会话只显示所属行待审批徽标。
- **T10 Done**：Portable / Semantic no-op / TUI-only 单一能力表、fire-and-forget 独立状态、runtime reset 与 Main 阻断路由修复。
- **T09 Done**：notify / setStatus / setWidget 的 toast/OS 通知、状态 chip、纯文本 widget 与限额。
- **T17 第一切片 Done**：按 session+runtime+method 聚合的非阻断 TUI-only 提示；真实切换动作仍按计划留给 Cycle 4。
- **T25 Done**：模型 tags/capability 全链透传、首标签单归组、搜索/兜底组、模型级 effort 过滤与非法旧值降级。

Cycle 2 不新增依赖，不触碰生产打包链；本批无需 Agent Host build。`extensionUi.reset` 是协议增量，主仓与 Agent Host typecheck 均已覆盖。

## 2. T08-b — 内联审批

### 落地

- `ExtensionUiDialog.tsx` 的审批内容改为聊天列内的非模态 dock/card：
  - 零 `AlertDialog`、零遮罩、零 focus trap；
  - select / confirm / input / editor 共用一份内容与发送逻辑；
  - keyed remount、发送中禁用、IPC 失败原位重试、dismiss fallback 保持；
  - session-local FIFO：后台请求不再挡住活动会话的队头。
- `extensionUiModel.ts` 新增：
  - `currentExtensionUiDialogForSession()`；
  - `currentUnscopedExtensionUiDialog()`；
  - `extensionUiPendingCountForSession()`。
- `LeftNav.tsx` 的 Recent 与 repository 两条 `SessionRow` 路径都显示待审批计数徽标。
- 极少数无 session 的 bind 请求也走非模态 dock，不恢复全局 modal。

### 既有桥接语义保持

`useExtensionUiStore` 与 Host response 协议未重写：

- Yes / Yes for session / No / No with reason 原字符串透传；
- dismiss 仍发送 `ok:false` 且不带 value；
- Host ACK 前卡片不消失；
- Stop / timeout / session close 的 `extensionUi.cancelled` 仍清理待决请求。

## 3. T10 — 能力分层与生命周期

### 单一能力表

`src/shared/types/runtimeEvents.ts` 新增 `EXTENSION_UI_CAPABILITIES`：

- `portable`：四种 blocking primitive + notify/setStatus/setWidget；
- `semantic-noop`：working/title/editor/theme 等能安全返回稳定本地语义的接口；
- `tui-only`：footer/header/custom/autocomplete/tools-expanded 等；
- 未知未来方法默认 `tui-only`，Proxy 不抛 `is not a function`。

### display 状态与阻断 FIFO 分离

新增：

- `extensionUiDisplayModel.ts`：status/widget/unsupported/notification 纯 reducer；
- `stores/extensionUiDisplay.ts`：app-lifetime runtime event listener。

状态键包含 `sessionId + runtimeId + key/method`，并具备：

- runtime 隔离；
- session retirement gate；
- session tree prune；
- unrelated event reference short-circuit。

### runtime reset

新增 `extensionUi.reset` RuntimeEvent。bridge 在 reload/dispose 时即使没有 blocking dialog，也会明确清除旧 runtime 的：

- status；
- widget；
- unsupported 聚合；
- 尚未消费的 notify。

### Main 路由修复

`extensionUiRouting.ts` 现在只为 `isExtensionUiDialogMethod(method)` 建立 `requestTarget`。此前 notify/status/widget/unsupported 永远不会收到 answer/cancel，却被当作阻断请求长期记账；该增长路径已关闭。

## 4. T09 — notify / status / widget

### notify

- 活动窗口：Base UI toast；
- 失焦窗口：warning/error 发 Electron OS notification；
- 失焦 info 暂存到重新聚焦后显示，不冒充系统警告；
- 发送前从 store 原子领取，StrictMode 重放不会双提醒；
- OS notification 点击只切换仍存活的 chat session；
- 过滤 permission plugin 的 `Legacy extension config found at ...` 误导性迁移提醒。

### setStatus

- 按 `session + runtime + key` 覆盖/删除；
- 活动会话显示紧凑 chip；
- 每 runtime 最多 8 项，单项最多 256 UTF-8 bytes。

### setWidget

- bridge 和 renderer 两端都只接受 `string[]`；组件对象或对象数组降级为 TUI-only；
- 支持 `aboveEditor` / `belowEditor`，同 key 替换和 `undefined` 删除；
- 每 runtime 最多 6 个 widget；每个最多 12 行、单行 512 bytes、总计 4096 bytes；
- React 文本节点渲染，零 `dangerouslySetInnerHTML`。

## 5. T17 第一切片

- `unsupported` 记录 method、session、runtime、首次/最后时间与次数；
- 同 runtime/method 聚合，跨会话隔离；
- 活动会话显示非阻断信息条：GUI 不支持，可在 Pi TUI 使用；
- 不提供假“切换”按钮。真实 TUI 可用性与切换动作仍归 Cycle 4 T16/T17 第二切片。

## 6. T25 — 标签分组与模型级 effort

### schema/catalog

- `PiManagedModelDefinition.tags?: string[]`；旧配置不含 tags 继续可读；
- validation 保留 tag 配置顺序、去重、拒绝空/非字符串 tag；
- `AgentModelOption` 透传：
  - `tags`；
  - `reasoning`；
  - `thinkingLevelMap`。
- 本机用户自有 `models.json` 的宽松 reader 只采纳已知 thinking level 的 string/null 值，不把任意对象带入 renderer。
- Pi catalog 保持 provider/model 配置顺序，不再按 locale 重排，以保证标签组的稳定首次出现顺序。

### picker

- `Automatic` 与当前 unverified leftover 保持顶层可达；
- 其余模型按**首标签**唯一归组；次标签只参与搜索，不重复模型；
- 无标签进入“其他模型”；
- group 顺序按 catalog 中首次出现；
- Base UI submenu 显示模型，当前模型在顶层 group 与子菜单内均可定位；
- 搜索覆盖 label / id / 所有 tags。

### model-level effort

- `reasoning:false`：只显示 Default；
- 有 `thinkingLevelMap`：只显示非 null 且明确声明的 low/medium/high/xhigh/max；
- legacy / 非 Pi / `reasoning:true` 且无 map：保持既有五档兼容行为；
- 切模型或 catalog 晚到后，非法旧 effort 回到 `default`；
- fallback 同时更新 session pair 与 agent template，create/send/resume 继续从相同 store 解析，UI / mirror / wire 不分叉。

## 7. 自动验证

### 类型与静态门禁

```text
NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ PASS

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ PASS

pnpm exec biome check src scripts
→ Checked 1094 files · no fixes

git diff --check
→ PASS
```

### Cycle 2 scoped Vitest

主批：

```text
16 files / 260 tests PASS
```

覆盖：shared Extension UI contract、bridge、Pi 多会话 runtime、Main routing、Pi model config、renderer dialog/display model、session lifecycle、模型/effort/menu、sidebar width budget。

追加批：

```text
extensionUi store + runtimeEventBus: 2 files / 28 tests PASS
最终变更复跑: 3 files / 16 tests PASS
```

## 8. 真机 dev + CDP 点验

启动：

```text
AICLIENT_SKIP_AUTH_GATE=1 \
AICLIENT_NODE24_PATH=$PWD/out-node-runtime/node \
node scripts/dev.js --remote-debugging-port=9222 --open-path=$PWD
```

资源约束下未跑整套 production build；dev 的 Main/Preload 构建与 Renderer 启动成功。点验使用 live renderer store 注入合成 Extension UI 状态，走真实 React/Zustand/布局/主题渲染；Host bridge 的真实 approve/deny/Stop 生命周期由既有真机链路与本批 35 条 bridge + 16 条 store 测试共同覆盖。

CDP 读数：

```text
dialogs = 0
approval = true
background badge labels = 4（Recent + repository 两套行，各会话一枚）
statusVisible = true
widgetVisible = true
unsupportedVisible = true
model search = true
Other models group = true
```

截图：

- [内联审批 + status/widget/unsupported + 后台徽标](./cycle2-screenshots/inline-approval-and-extension-surfaces.png)
- [模型搜索 + 标签/兜底子菜单 + effort](./cycle2-screenshots/model-group-menu.png)

点验后 dev/Electron/Vite/esbuild 进程已退出；RAM 恢复至约 1.6 GiB available，Swap 从 2.1 GiB 回落至约 1.4 GiB used。

## 9. 出口与后续

- Cycle 2 功能与本机门禁完成。
- Cycle 1 的真账号 queue GUI 复点与完整 packaged preview smoke 仍是**环境验收欠项**，不属于本批回退或冒充完成的范围。
- 下一主目标：Cycle 3 的 Pi history reader → 真实 resume → session tree → rewind → fork。
- T17 的“切换到 TUI”按钮仍按原计划依赖 Cycle 4 T16，不在第一切片伪接空动作。
