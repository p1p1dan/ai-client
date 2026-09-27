# P1-2 分片 03 · 宿主入口、锁文件与 pnpm、文件判定

Role: detail shard。上位：[P1-2 方案](../p1-2-host-packaging.md)。回答调研问题 3（打包态入口怎么跑）、5（锁文件与安装、pnpm 与 P1-10）、6（哪些是探针、哪些转正）。

## 1. 宿主入口在打包态怎么跑

### 事实

- 开发态：Main 用 `<node> --expose-internals src/dsh-host/host.ts` 拉起（`src/main/services/agent-host/devDshEngine.ts:96`），靠 Node 的类型剥离直接跑 TS。
- bridge 行 `@aiclient/dsh-app/bridge` 用 `new URL('../../../agent-host/piWorkerRpcServer.ts', import.meta.url)` 与 `../../bridge/dshSessionRuntime.ts` 动态 import 仓库里的 TS（`bundle/lib/bridge.js:40-43`，注释自称 dev-only，`:11-12`）；`shared-bridge.js:162-163` 同样。开发态能用，是因为 `node_modules/@aiclient/dsh-app` 是指向 `bundle/` 的符号链接，Node 按真实路径算 `import.meta.url`。
- 安装包里：①没有 `src/agent-host`、`src/shared` 的源码；②链接被物化成实拷贝后，`../../bridge/…` 指向不存在的 `node_modules/@aiclient/bridge/…`；③即使把 TS 拷进去，`node_modules` 下的 `.ts` 也不许类型剥离。
- **本机实测**（随包 node v24.18.0，2026-09-26）：
  - `node a.ts`（不在 node_modules 下）：直接运行，stderr 没有实验性警告。
  - 从 `node_modules/pkg/a.ts` 导入：`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
  - `NODE_OPTIONS=--expose-internals`：`--expose-internals is not allowed in NODE_OPTIONS`；放在 argv 里正常。
- asar：随包的是普通 node，读不了 `app.asar`（asar 读取是 Electron 给自己的 fs 打的补丁），所以宿主必须像 agent-host 一样放在 asar 之外。
- `--expose-internals` 不是必需的：cordis-plugin-loader 只在 argv 里有这个参数时才 `require` 内部模块，否则用原生 addon（`cordis-plugin-loader/src/internal.ts:108-118`）；dsh-app-boot 的运行时解析始终走 addon（`dsh-app-boot/lib/index.js:1573-1579`）；P0-1 实测去掉参数照常启动。但 P0 的全部证据（包括 Windows CI）都是带着参数跑的。
- DSH 找 bundle 与安装包，走的是 `createRequire(anchor).resolve.paths(name)`（`dsh-app-boot/lib/index.js:881-887,900-906`），也就是 node_modules 布局，不看 `file:./bundle` 这个写法；安装锚点是宿主目录的 `package.json`（`host.ts:91`），依赖名单来自它的 `dependencies` 与 `peerDependencies`（`dsh-app-boot/lib/index.js:676-722`）。
- profile 清单里的 bundles 列表只在第一次建 profile 时写入（`initProfile` 只在文件不存在时写，`dsh-app-boot/lib/index.js:575-591`），此后 `loadProfileDirectory` 以清单为准（`:919-920`），`host.ts` 的 `BUNDLES` 常量只起播种作用。

### 方案（对应决策 D1）

- `host.ts` → `host.js`：esbuild 只做转译（不打包），`format: esm`、`platform: node`、`target: node24`，放在产物根目录，`installAnchor` 仍是同目录的 `package.json`。根目录已有 esbuild 0.27.2（`build-agent-host.mjs` 就在用）。electron-vite 只管 main / preload / renderer 三个入口，不必为宿主扩它。
- bridge：把 `bundle/lib/bridge.js` 里的 `apply()` 逻辑挪进 `src/dsh-host/bridge/plugin.ts`，改为静态 import `PiWorkerRpcServer` 与 `DshSessionRuntime`；源码里的 `bundle/lib/bridge.js` 只剩一行 `export * from '../../bridge/plugin.ts'`（开发态真实路径不在 node_modules 下，类型剥离可用）。构建时 esbuild 以 `bridge/plugin.ts` 为入口、`bundle: true`、`packages: 'external'`（npm 包全部留到运行时由 DSH 的解析表解析，比如 `@deepseek-ai/dsh-llm`），输出覆盖暂存区的 `bundle/lib/bridge.js`。已查：bridge 与 `piWorkerRpcServer.ts` 不用 `import.meta`、`__dirname`，打包后路径不受影响；`src/shared/types/*` 只互相 import，没有 npm 依赖。`shared-bridge.js` 同法处理，P1-3 定共享宿主后只留一个。
- 打包态启动参数保留 `--expose-internals`（与全部 P0 证据一致），写在 argv 里。
- 开发态继续跑源码（改 bridge 不用重建），另加一个开发覆盖项（例如 `AICLIENT_DSH_HOST_DIR=out-dsh-host`），方便在开发机上复现打包态。

## 2. 锁文件、安装与 pnpm

- **子包用 npm**：`src/dsh-host/package-lock.json`，lockfileVersion 3，405 条（含根与 `bundle`），由 npm 10.9.8 生成，P0-1 起已入库；402 个 `resolved` 全部指向 `registry.npmjs.org`。根项目用 pnpm 10.26.2，互不相干。
- **版本**：直接依赖全部精确版本（`src/dsh-host/package.json:11-23`），锁文件里 dsh 包只有 `0.1.7-rc.2` 一个版本（P0-1）；bundle 的 peer 钉 `@deepseek-ai/dsh-llm 0.1.7-rc.2` 与 `@deepseek-ai/cordis ~4.0.4`（`bundle/package.json:20-23`）。DSH 装载 bundle 时会查 peer 兼容（`dsh-app-boot/lib/index.js:929-930`），所以升 DSH 时 bundle 的 peer 必须同步改。
- **CI 可复现安装**：构建脚本在干净暂存区里 `npm ci --ignore-scripts --no-audit --no-fund`，不加 `--omit=optional`；构建机 Node 是 setup-node 的 `'24'`（npm 11），静态测试要求所有 job 都是 `'24'`（`packaging-config.test.mjs:356-371`），所以脚本不能依赖 npm 的链接行为，要自己物化、自己校验。P1-2 改了 `package.json` 的版本号后，用 npm 11 跑一次 `npm install --package-lock-only` 重生成锁文件并入库。build job 里 `setup-node` 写的 `.npmrc` 只把 `@p1p1dan` 作用域指到 GitHub Packages，`@deepseek-ai` 仍走 npmjs。可选加固：`src/dsh-host/.npmrc` 写 `registry=https://registry.npmjs.org/`，防止开发机的镜像配置把镜像地址写进锁文件。
- **pnpm 是运行时依赖**：plugin-manager 装、卸插件时跑 pnpm；profile 没配 `packageManager` 时用 `pnpmCommand`，默认就是 PATH 上的 `pnpm`（`dsh-plugin-manager/lib/index.js:1354,1530,1602`）。`host.ts` 只在设了 `AICLIENT_DSH_PNPM_CLI` 时才把 `packageManager` 指向随包 node + 随包 pnpm（`host.ts:116-126`）。启动阶段不调 pnpm（P0-1）；pnpm 一旦运行，会写 `~/.cache/pnpm`、`~/.local/share/pnpm/store`（Windows 是 `%LOCALAPPDATA%\pnpm`），并访问 registry、自己做版本检查（[P0-2 证据](../../evidence/p0-2-goal-and-plugins-2026-09-25.md)第 182、264 行）。
- **P1-10（用户机不联网装包）对 P1-2 的影响**：
  1. pnpm 11.7.0 先随包（决策 D6）；打包态 `host.ts` 默认把 `packageManager` 指向产物里的 `node_modules/pnpm/bin/pnpm.mjs`，保证永远不会去跑 PATH 上的 pnpm。
  2. P1-2 不提供任何安装入口：dsh-base 里 `tool-plugin-manager` 行是字面关闭的（P0-1），界面也没接；产品补丁里 `plugin-manager.registry` 仍指向 npmjs（`bundle/cordis.patch.yml:100-103`），留给 P1-10 改。
  3. 构建脚本写成通用的：P1-10 若把白名单插件作为依赖预装进产物，或带一个离线 store，走同一套裁剪、格式与许可校验，体积上限到时重定。
  4. 打包冒烟断言宿主从启动到跑完工具回合没有任何非回环连接与 DNS 查询（复用 `lib/probe-hooks.mjs` 的钩子）。

## 3. 文件逐个判定

| 文件 | 判定 | 去向与说明 |
|---|---|---|
| `host.ts` | 转正 | 原位保留，构建成 `host.js`。改：头注释去掉 P0；打包态 pnpm 默认值（§2）；`ready` 里带上产物清单的版本信息；保留组合审计（`:130-149`）。拒绝真实 `~/.dsh` 的守卫（`:81-85`）先保留，`DSH_HOME` 放哪由 P1-1 / P1-3 定 |
| `bridge/dshSessionRuntime.ts` | 转正 | P1-4 在此扩展 |
| `bridge/plugin.ts` | 新增 | 从 `bundle/lib/bridge.js` 挪来的行逻辑，静态 import |
| `bundle/package.json` | 转正 | 改 version、description；`.` 导出指向一个最小的 `lib/index.js` |
| `bundle/cordis.patch.yml` | 转正 | 删掉 `insert` 块里的 `aiclient-probe` 一行（`:106-111`）与只给 P0-6 探针用的 `compaction-basic` 开关（`:92-97`），挪进探针 bundle（所以 `p0-6-probe` 也要叠加探针 bundle）；`llm-pi-ai` 的假模型与网关环境变量（`:66-90`）留给 P1-5 |
| `bundle/lib/bridge.js` | 转正（改为开发垫片） | 一行 re-export；产物里被 esbuild 输出覆盖 |
| `bundle/lib/shared-bridge.js` | 暂留 | P0-6 原型，含计量操作；P1-3 去掉计量后转正，P1-2 不在产品补丁里启用它 |
| `bundle/lib/index.js`（`aiclient-probe`） | 移到测试工具 | 会把所有审批自动答成 allowed-once（`:21-22`）。挪到 `tools/probe-bundle/`（决策 D5） |
| `bridge-smoke.ts`、`goal-probe.ts`、`p0-6-probe.ts` | 测试工具 | 决策 003 指定的升级回归；挪到 `tools/`，`hostEntry` 改成 `../host.ts` |
| `measure.ts` | 测试工具 | 挪到 `tools/`；P1-2 可用它量打包态启动与内存 |
| `p0-4-probe.ts`、`p0-4-report.ts`、`p0-4/build-kit.mjs`、`p0-4/run-p0-4.ps1`、`lib/kit.ts` | 测试工具，P1-13 前必须保留 | 加密机上机包；P1-13 时可改为「产品产物 + 探针叠加」 |
| `lib/probe-hooks.mjs` | 测试工具 | 打包冒烟复用它的断网、记录钩子（从仓库加载，不进包） |
| `lib/select-community-plugin.mjs` | 删除 | P0-2 一次性挑选脚本，结论已写进 P0-2 证据 |
| `package.json`、`package-lock.json`、`tsconfig.json` | 转正 | 见 §4；`tsconfig.json` 的 `include` 加 `tools/**/*.ts` |

产物里只装白名单文件（`package.json`、`host.js`、编译后的 bundle），探针放在哪都不会进包；挪进 `tools/` 只是为了一眼分清。

## 4. `package.json` 怎么改

`src/dsh-host/package.json`：

- `name`：保持 `@aiclient/dsh-host`（它同时是 DSH 的安装锚点名，改名没有收益）。
- `version`：`0.0.0-p0.1` → `0.1.0`；以后每次升 DSH 版本升一个 minor，产物清单另记应用版本与 git 提交。
- `description`：`ai-client DSH worker host: dsh-base + @aiclient/dsh-app booted by dsh-app-boot on the bundled Node runtime; packaged as resources/dsh-host.`
- `scripts`：保留 `host`；`measure` 改指 `tools/measure.ts` 或删掉。
- `private`、`type: module`、`engines.node >=24`、全部精确版本不变。加静态测试：依赖名单精确相等、全是精确版本、锁文件里 `@deepseek-ai/dsh-*` 全等于钉的版本、bundle 的 peer 等于钉的版本。

`src/dsh-host/bundle/package.json`：`version` → `0.1.0`；`description` → `ai-client worker-engine bundle over dsh-base: host-only composition, DeepSeek official endpoints and telemetry off, worker-RPC bridge rows.`；peer 不变。

新增 `tools/probe-bundle/package.json`：`@aiclient/dsh-probe`，private，`dsh.bundle.patch` 指向自己的补丁（插入 `aiclient-probe` 行与 compaction 开关）。探针脚本在启动宿主前把它放进 `<DSH_HOME>/profiles/aiclient/node_modules/@aiclient/dsh-probe`，并预写 profile 清单的三项 bundles；DSH 会从 profile 目录这个第二锚点解析到它（`dsh-app-boot/lib/index.js:900-906`）。产品宿主的 `BUNDLES` 不变，安装包里没有这个包。这条路径只读过代码、没跑过（P0-2 从 profile 目录装载的是插件行，不是 bundle），实现时先用 `measure.ts smoke`（走的就是 `aiclient-probe`）验一次；不通就退回决策 D5 的选项 B。
