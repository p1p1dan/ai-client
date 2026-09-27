# 决策 025：宿主生命周期：空闲关停，凭据变更与更新前先关宿主，启动时重申 bundles

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-3 方案 §4 D9](../topics/p1-3-shared-host.md#4-需要拍板的决策点)、[P1-2 方案 §7](../topics/p1-2-host-packaging.md#7-风险与未覆盖)。

## 规则

1. 空闲关停：没有会话满 10 min，就优雅关停宿主（省约 180 MB），下次按需冷启动（约 0.8 s）。
2. `invalidateAll()`：登录、登出、模型或插件变更时，除了处理会话，还要优雅关停宿主，保证凭据和路由不会残留在宿主进程里。
3. 应用退出：发宿主级 `shutdown`，DSH 会 dispose 全部 agent 并落盘；3 s 不退就 SIGKILL，等进程退出。同步兜底路径直接 SIGKILL。
4. 自动更新：`quitAndInstall` 之前先等宿主关停。否则 Windows 上 NSIS 覆盖安装时，`koffi.node`、`conpty.node` 还被宿主占用，安装会失败。
5. bundles：每次启动都重申产品 bundle，避免升级后被首次启动时写下的 profile 清单卡住。插件带来的 bundle 加载失败只告警、不拒绝启动；产品 bundle 失败仍然明确报错。

## 取舍

- 省内存、凭据不残留、升级可靠。
- 代价：
  - 空闲后的第一条消息要多等一次冷启动，Windows 上的耗时没测。
  - 宿主关停会结束后台 jobs，回收会话时要参考 pong 里的 `busy`，与 P1-7 联动。

## 实施补记（2026-09-27，P1-3d `b3b58f2b`，待用户审批）

- 空闲关停按 supervisor 的通道数算（含进行中的 `openChannel`），不按 WorkerManager 的 entry 数：error 态的 entry 没有通道，不该让宿主常驻。有后台 job 的会话（pong 的 `busy`）不驱逐、不回收。
- 更新：`quitAndInstall` 之前先关会话，再 `shutdown('app-quit')`，最多等 5 s，超时照装；只装一次，不抛错。已知遗留：引擎关停后如果 `quitAndInstall` 本身失败，应用在重启前没有聊天引擎。
