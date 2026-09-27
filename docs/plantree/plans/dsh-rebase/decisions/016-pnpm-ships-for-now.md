# 决策 016：pnpm 先随包，打包态默认指向随包的那份；去留由 P1-10 定

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-2 方案 §4 D6](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、[分片 03 §2](../topics/p1-2-host-packaging/03-entry-lock-files.md)。

## 规则

1. `pnpm@11.7.0` 保留为宿主的运行时依赖，随包分发，约 16 MiB。
2. 打包态下，`host.js` 默认把 plugin-manager 指向随包的 `pnpm.mjs`，不再依赖 `AICLIENT_DSH_PNPM_CLI` 才生效。不配的话，plugin-manager 会去跑 PATH 上的 `pnpm`（`dsh-plugin-manager/lib/index.js:1354,1530`）。
3. P1-10 之前没有插件安装入口，因为 dsh-base 的 `tool-plugin-manager` 默认关闭。P1-10 定了离线预装方案后，再决定 pnpm 去留。

## 取舍

- 现在删掉，P1-10 的离线安装很可能还得加回来。留着则多约 16 MiB，已计入[决策 014](014-host-size-budget.md) 的预算。
- pnpm 的 `dist/pnpm.mjs` 是打包过的，里面合进了哪些第三方代码、需不需要额外声明，还没核，记入 [Q007](../open-questions.md)。

## 补记（2026-09-27）

由[决策 058](058-plugins-preinstalled-no-pnpm.md)（待审批）收口：插件在构建期预装进安装包，用户机上不再需要 pnpm，pnpm 从宿主依赖里去掉。
