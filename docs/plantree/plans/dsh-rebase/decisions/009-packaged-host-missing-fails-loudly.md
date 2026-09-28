# 决策 009：去掉「仅未打包」限制；打包态找不到 DSH 宿主就明确报错，不回退

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-1 方案 §5 D5](../topics/p1-1-engine-cutover.md#5-需要拍板的决策点)、[决策 004](004-branch-isolated-dsh-only.md) 第 1 条（不留开关）。

## 规则

1. 从 P1-1 起，聊天会话无论是否打包都只拉 DSH 宿主。代码里不再出现 `AICLIENT_DEV_ENGINE`，也没有任何回退开关。
2. 宿主解析：
   - 未打包：`out-node-runtime/node` + `src/dsh-host/host.ts`。
   - 打包：`resources/node-runtime/node(.exe)` + `resources/dsh-host/host.js`。路径常量在 P1-1 定，产物由 P1-2 交付；如果 P1-2 定了不同的布局，以 P1-2 为准，改常量即可。
3. 缺随包 node 或宿主入口任何一个，都抛 `DSH_HOST_MISSING`。删掉「回退到 PATH 上的 node」。
4. `AICLIENT_DSH_NODE`、`AICLIENT_DSH_HOME`、`AICLIENT_DSH_GATEWAY_URL/KEY` 只在未打包时读取；网关两项在 P1-5 删除。

## 取舍

- 不选「保留仅未打包直到 P1-2」：与 roadmap P1-1 的文字冲突；而且打包态会静默地没有引擎可用。
- 加密机约束（ARD D11）：读文件与执行工具只能跑在白名单载体，也就是随包 node 上。回退到 PATH 上的 node 会在加密机上悄悄读到密文，所以必须明确失败。
- 代价：P1-2 之前打出的包不能聊天，但会明确报错。本分支在 P1-3 之前不出包（[P1-1 方案 §9](../topics/p1-1-engine-cutover.md#9-风险与未覆盖)）。

## 影响

- P1-1：`devDshEngine.ts` 换成 `DshHostProcess.ts`；`createPiWorkerSlot.ts` 固定走 DSH；新增静态守卫，钉住「不引用 native fork、不读 `isPackaged` 做门控」。
- P1-2：按这里的路径交付产物，或者回改常量。
