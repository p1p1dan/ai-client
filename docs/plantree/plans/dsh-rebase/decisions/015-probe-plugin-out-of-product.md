# 决策 015：`aiclient-probe` 探针插件移出产品 bundle

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-2 方案 §4 D5](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)。

## 规则

1. `aiclient-probe` 会把所有审批自动答成「允许一次」（`bundle/lib/index.js:21-22`），而且只要没设 bridge 环境变量就是启用的（`bundle/cordis.patch.yml:109-111`）。**安装包里不能有这段代码。**
2. 做法 A：把它移到测试专用 bundle `tools/probe-bundle/`（`@aiclient/dsh-probe`）。探针脚本启动时把它放进 profile 目录，这是 DSH 的第二个解析锚点。产品 bundle 的 `cordis.patch.yml` 删掉探针行。
3. 如果 A 实测走不通，退而用 B：留在产品 bundle，但改成只能显式开启，默认关闭，并用打包冒烟和静态测试钉住「默认关闭」。选了 B 要在本决策里补记。
4. 同时整理：
   - 探针和上机包相关的脚本移进 `src/dsh-host/tools/`，包括 `bridge-smoke`、`goal-probe`、`p0-6-probe`、`measure`、`lib/kit.ts`、`lib/probe-hooks.mjs` 和 P0-4 上机包。上机包在 P1-13 之前必须保留。
   - 删掉 `lib/select-community-plugin.mjs`。

## 取舍

- A 让安装包里物理上没有自动批准的代码，这是安全底线。B 只是靠配置关闭。
- 代价：`goal-probe`、`measure`、`p0-4-probe` 和上机包都要改启动方式。A 这条路径目前只读过代码，没有实际跑过。
