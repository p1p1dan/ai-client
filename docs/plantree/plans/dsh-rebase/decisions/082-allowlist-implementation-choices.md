# 决策 082：P1-10a 白名单与构建期审计的实现取舍

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：P1-10a 实现（`ad999a0f`）与实验 E2、[决策 058](058-plugins-preinstalled-no-pnpm.md)、[059](059-allowlist-verification-and-audits.md)、[060](060-first-allowlist-pilot-office-tools.md)。

## 规则

1. **清单字段比决策 059 多三项**：
   - `dependencies`：插件带进来的依赖逐包登记，并核对 integrity；
   - `installScripts`：有安装脚本的包默认拒绝，登记「为什么不跑也能用」之后才放行。方案原意是「不执行，靠冒烟证明」，改成了先拒绝、登记后放行；
   - `limits`：超过单插件默认额度（5 MiB / 500 个文件）时，经审批的额度写在这里，同时要有审查记录。

   另外，`aiclient-` 前缀留给我方产品自己的行，清单里的插件不能用。
2. **插件只收 registry 上的 tarball**。方案里「仓库内插件用目录哈希代替 integrity」这一条没有实现，等真有仓库内插件时再做。
3. **插件的 peer 用 `overrides` 钉到宿主版本**。实验 E2（npm 10.9.8 与 11.20.0 结果相同）：
   - 插件 peer 写 `^0.1.0-rc.6` 或 `>=0.1.0-rc.6` 时，`npm ci` 报 `ERESOLVE`：semver 的范围匹配不到预发布版 `0.1.7-rc.2`；
   - 真实插件 `dsh-office-tools@1.0.4` 的 peer 虽然是 optional，也报 `ERESOLVE`；
   - `--legacy-peer-deps` 会从锁文件里删掉 44 个包，不能用。

   所以在 `src/dsh-host/package.json` 里用 `overrides` 把白名单插件的 `@deepseek-ai/*` peer 钉到宿主版本，锁文件只多一条。preflight 限定了三点：只能给白名单插件写，只能钉 `@deepseek-ai/*`，版本必须等于宿主版本。插件原来声明的 peer 仍然交给 DSH 自己的 `evaluatePluginCompatibility` 判定，所以 overrides 盖不住真正的不兼容。
4. **构建库经 Node 的类型剥离加载 `.ts`**。`scripts/dsh-host-build-lib.mjs` 直接 import `src/shared/dshPluginAllowlist.ts`，`afterPack` 和 `verify-packaged-app` 也会间接加载它。这要求构建机的 Node ≥ 22.18（类型剥离默认开启）。CI 用的是 Node 24，本机是 22.23，都已实测可用。
5. **敏感 API 扫描只出报告，不拦构建**，结果写进审查记录，交给人工审查。
6. **去掉 pnpm 分两步走**：
   - 这一次只删依赖和产物（`ad999a0f`），产物里任何层级出现 `pnpm` 或 `@pnpm` 都判构建失败；
   - `host.ts` 里的 `packageManager` 块和 `AICLIENT_DSH_PNPM_CLI` 暂时保留。直接删掉的话，plugin-manager 会回落到 PATH 上的 `pnpm`（DSH 的逻辑是 `profile.packageManager ?? {command: 'pnpm'}`）。
   - 正确的顺序：先在 bundle 补丁里把 `plugin-manager` 设成 disabled（顺带删掉 registry 配置），把 `plugin-manager`、`tool-plugin-manager` 加进 `REQUIRED_DISABLED` 并由 overlay 重申，最后再删 `packageManager`。这一步排在 P1-5 落地之后，作为 P1-10a 的收尾。
   - 在这之前，安装一旦被调用就会失败（`pnpm.mjs` 已经不在产物里）。但 `tool-plugin-manager` 本来就关着，模型够不到安装入口。

## 取舍

- 实测：去掉 pnpm 后，linux-x64 产物从 97.9 MiB、10,194 个文件、365 个包，降到 82.1 MiB、9,760 个文件、342 个包。
- 上机包探针里的 G-pnpm-install 检查（`tools/goal-probe.ts`、`tools/p0-4-probe.ts`）已经失效，[P1-13 手册](../topics/p1-13-encrypted-machine-runbook.md)里的对应项也要改成「预装插件由随包 node.exe 读回明文」。与收尾一起做。

## 实施补记（2026-09-28，收尾 `fc6061c6`）

第 6 条的第二步已经做完：
- bundle 补丁里把 `plugin-manager` 设成 disabled，并删掉了它的 registry 配置；
- `plugin-manager`、`tool-plugin-manager` 进了 `REQUIRED_DISABLED`；
- `host.ts` 删掉了 `packageManager` 和 `AICLIENT_DSH_PNPM_CLI`；
- 构建校验新增一条：产物里的 `plugin-manager` 行必须是 disabled，并且不能残留 registry 配置。

施工中另外改了三处，都跟着上面这些改动走：
1. **探针 bundle 的 `pluginManager` 改为可选获取**。Cordis 的 `inject` 依赖一旦满足不了，整条行就会一直挂起、不执行。plugin-manager 关掉以后，`aiclient-probe` 行会连带卡死，p0-4-probe、goal-probe、bridge-record 都会停在第一步。
2. **goal-probe 的 OFFICE 场景改名为 PLUGIN-OFF**。原来它经 plugin-manager 装 `dsh-office-tools` 再重启宿主，现在改为断言两行都没加载、`install-bundle` 会被拒绝。
3. **上机包的 G-pnpm-install 拆成两项**：
   - G-no-plugin-install：安装入口已关，产物里没有 pnpm；
   - G-preinstalled-plugin-readback：用随包 node.exe 逐个读回白名单插件，白名单为空时记为「无预装插件」。

   Linux 预演结果：44 项，通过 40、跳过 1（本机没有 PowerShell）、记录 3，失败 0。
