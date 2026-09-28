# 证据：P1-10d 联网安装试点插件 `dsh-office-tools@1.0.4`（2026-09-28）

Role: evidence。上位：[roadmap P1-10](../roadmap.md)、[P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md) §6 的 P1-10d 行；授权见[决策 110](../decisions/110-user-rulings-2026-09-28-batch2.md)「联网装包」行与[决策 090](../decisions/090-user-rulings-2026-09-28.md)「060」行；审查记录 [`src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md`](../../../../../src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md)；取舍见[决策 115](../decisions/115-p1-10d-pilot-plugin-choices.md)。

**结论：装包干净。**
- 是 DSH bundle（`dsh.bundle.patch` 指向 `./cordis.patch.yml`，只插一行 `dsh-office-tools`）；
- 运行期依赖为 0，没有安装脚本，没有原生件；
- 锁文件只新增这一个包，**已有条目 0 变化**；来源是公共 npm registry，带 sha512 integrity，与 registry 元数据、`npm pack` 取回的 tarball 三者一致；
- 5 个 dsh peer 的预发布范围在 npm 下报 `ERESOLVE`（与 P1-10a 实验 E2 相同），按决策 082 第 3 条用 `overrides` 钉到宿主版本后，peer 全部由钉住的树满足。

## 1 环境与前提

- 分支 `feat/dsh-p0-probe`，HEAD `a9441c69`，加本任务未提交的改动；Linux 开发机。
- npm 10.9.8，系统 Node v22.23.2。npm 对宿主包 `engines: node >=24` 报 `EBADENGINE`，只是提示；宿主运行用随包 Node v24。
- registry：只用 `src/dsh-host/.npmrc` 的 `registry=https://registry.npmjs.org/`，没有改动，没有用镜像或私有源。
- 本任务的联网只有对这一个包的四次 npm 访问：`npm view`、`npm pack`（取回 tarball 到临时目录做安装前审查）、`install --package-lock-only`、`install`。之后的宿主构建用 `npm_config_offline=true` 跑，全部来自本机缓存，没有联网。

## 2 安装前核对（`npm view` + `npm pack`）

| 项 | 结果 |
|---|---|
| 版本 | `1.0.4`，即 `latest`；发布于 2026-09-22 |
| integrity | `sha512-Q1jvlhjKDHjoZBX54WkT0zCblUGACPwiCQJfS/cgU5jVLzI3q66bU/MR5QEsERd9QJQhtgOdH89opZtvga6uxA==`；对取回的 tarball 本地重算 sha512，一致 |
| 是否 bundle | 是：`dsh.bundle.patch: ./cordis.patch.yml`，补丁只 `insert` 一行 `id: dsh-office-tools`、`name: dsh-office-tools` |
| `dsh.client` / `bin` | 都没有 |
| 运行期依赖 | `dependencies`、`optionalDependencies` 都没有 |
| 安装脚本 | 没有（`scripts` 只有 test / build / check / types / typecheck / test:e2e） |
| 原生件 | 没有：17 个文件，`lib/index.js` 118,064 B，其余是类型声明、README、LICENSE、清单 |
| peer | 全部 optional：`@deepseek-ai/cordis ^4.0.1`；`dsh-fs`、`dsh-llm`、`dsh-agent`、`dsh-tools`、`dsh-session` 为 `^0.1.0-rc.6 \|\| ^0.1.1-rc.0 \|\| ^0.1.2-alpha.0 \|\| ^0.1.5-alpha.0` |
| 许可 | MIT |

## 3 第一步：只写锁文件

```bash
npm --prefix src/dsh-host install --package-lock-only --save-exact --ignore-scripts --no-audit --no-fund dsh-office-tools@1.0.4
```

1. **第一次：退出码 1，`ERESOLVE`**。npm 报 `Conflicting peer dependency: @deepseek-ai/dsh-fs@0.1.5-rc.3`，原因是 `peerOptional @deepseek-ai/dsh-fs@"^0.1.0-rc.6 || … || ^0.1.5-alpha.0"` 在 npm 的规则下匹配不到预发布版 `0.1.7-rc.2`。这与 P1-10a 实验 E2 的结果完全相同。核对过：失败时 `package.json` 与锁文件都没有被改动。
2. **按决策 082 第 3 条加 `overrides`**：在 `src/dsh-host/package.json` 里把这个插件的五个 dsh peer 钉到宿主版本 `0.1.7-rc.2`。`@deepseek-ai/cordis` 的 `^4.0.1` 本来就满足 `4.0.4`，没有钉。
3. **第二次：退出码 0**（「up to date」）。

与改动前的锁文件逐条比对（脚本读两份 `packages`）：

| 项 | 结果 |
|---|---|
| `packages` 条目数 | 409 → 410 |
| 新增 | 1 条：`node_modules/dsh-office-tools` |
| 删除 | 0 |
| 已有条目内容变化 | 0（根条目只多了这一个依赖） |
| `package.json` | `dependencies` 多一行 `"dsh-office-tools": "1.0.4"`（精确版本）；新增 `overrides` 块，钉 5 个 peer |

新增条目：`resolved` 为 `https://registry.npmjs.org/dsh-office-tools/-/dsh-office-tools-1.0.4.tgz`，`integrity` 同上，`license: MIT`，没有 `dependencies`，没有 `hasInstallScript`。所以没有新的依赖闭包。

**全锁文件核对**：除了原有的本地 `bundle`（`@aiclient/dsh-app`，`file:./bundle` 的链接目标，本来就没有 `resolved`）以外，每一条的 `resolved` 都以 `https://registry.npmjs.org/` 开头，并且都带 `integrity`。

**peer 结论**：

| peer | 声明 | 树里的版本 | 满足方式 |
|---|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | 4.0.4 | 直接满足 |
| `@deepseek-ai/dsh-agent` | 预发布范围 | 0.1.7-rc.2 | `overrides` 钉住 |
| `@deepseek-ai/dsh-fs` | 同上 | 0.1.7-rc.2 | 同上 |
| `@deepseek-ai/dsh-llm` | 同上 | 0.1.7-rc.2 | 同上 |
| `@deepseek-ai/dsh-session` | 同上 | 0.1.7-rc.2 | 同上 |
| `@deepseek-ai/dsh-tools` | 同上 | 0.1.7-rc.2 | 同上 |

DSH 自己的兼容判定（`evaluatePluginCompatibility`，含预发布匹配）另在构建期审计里判，结果是兼容，没有豁免（第 5 节）。

## 4 第二步：真正安装

```bash
npm --prefix src/dsh-host install --save-exact --ignore-scripts --no-audit --no-fund dsh-office-tools@1.0.4
npm --prefix src/dsh-host ls dsh-office-tools
npm --prefix src/dsh-host ls --all
```

- 安装：「added 1 package」。锁文件与第一步写出的逐字节相同（git 统计：锁文件 +38 行，`package.json` +10 行）。npm 解包时按锁文件的 integrity 校验 tarball。
- 安装目录里的 17 个文件与 `npm pack` 取回的 tarball 解包结果 `diff -r` 相同。
- `ls dsh-office-tools`：`dsh-office-tools@1.0.4 overridden`（`overridden` 是 `overrides` 的标注）。
- `ls --all`：退出码 0，没有 missing、invalid。仍有两条 `extraneous`：`@emnapi/runtime@1.11.3`、`@img/sharp-wasm32@0.35.4`，早于本次（P1-4d3 证据第 3 节已记），与本次无关。
- 顶层还有未声明依赖要注意：插件 `import` 了 `@deepseek-ai/schemastery`，它不在插件的依赖或 peer 里，由宿主树顶层的 `@deepseek-ai/schemastery@3.18.4`（DSH 的依赖）解析。现在能用（第 5、6 节的冒烟里行在活动），DSH 升级时要复核（审查记录第 3 节）。

## 5 构建（同一工作区，离线）

```bash
npm_config_offline=true node scripts/build-dsh-host.mjs
```

- 通过。预检的钉版本、锁文件、双键（白名单 ↔ `package.json` ↔ 锁文件）、`overrides` 规则都通过；`npm ci` 装了 348 个包，全部来自本机缓存。
- 插件审计：`plugins: dsh-office-tools@1.0.4 (0.1MiB, 5 files)`。DSH peer 判定兼容，补丁审计通过，许可 MIT，敏感 API 扫描零命中，写进 `dsh-host-manifest.json` 的 `plugins` 段（带 `rows`、`tools`、审查信息、体积）。
- 产物（linux-x64）：86,261,736 B / 9,765 个文件 / 343 个包 → **86,388,208 B / 9,770 个文件 / 344 个包**，即 +126,472 B、+5 个文件、+1 个包，在体积预算之内。
  - 插件本身占 124,685 B、5 个文件：`lib/index.js`、`package.json`、`cordis.patch.yml`、`dsh.plugin.json`、`LICENSE`（类型声明和 README 按 B 档裁掉）；
  - 其余增量来自 `bundle/lib/permissions.js`（分类表与请求构造）；
  - 许可清单 `THIRD_PARTY_LICENSES.json` 有它的条目。

## 6 冒烟与实验（Linux）

| 项 | 命令 | 结果 |
|---|---|---|
| 打包冒烟 L1 | `node scripts/packaged-dsh-host-smoke.mjs --level 1 --host-dir out-dsh-host --node out-node-runtime/node` | **PASS，44 项**（原 41 项 + 3 项试点插件检查）。L0 默认关：`ready.plugins` 报 `disabled`，活动行 78；L1 经 Main 的覆盖开启：`loaded`，组合为 `dsh-base`、`dsh-app`、`dsh-office-tools`，活动行 79、未激活 0；`word_create` 出一张卡、答允许后写出 7,190 B 的 `.docx`（`PK` 开头），`word_read` 不出卡、读回正文。全程零非回环连接、零 DNS，安装目录没有新增或删除文件 |
| bridge-smoke | `out-node-runtime/node src/dsh-host/tools/bridge-smoke.ts` | **50 项全过**，其中 4 项是本次新增：默认关时模型的工具表 23 个、不含任何 office 工具；宿主 I 开启后 31 个，8 个全在；`word_create` 一张卡（卡上路径为工作区内的 `p0-report.docx`、预览整份参数、「本会话允许」的范围是这个文件），`word_read` 无卡；文件是 zip，读回正文 |
| 集成测试 | `AICLIENT_DSH_INTEGRATION=1 npx vitest run …/dshSharedHost.integration.test.ts` | **30/30**，新增 PLG-6：按构建的方式列出已提交白名单的条目，默认报 `disabled`、组合里没有；Main 覆盖开启后报 `loaded`，首个请求的工具多 8 个 |
| E1 | `out-node-runtime/node src/dsh-host/tools/e1-plugin-manager-off.ts` | 通过（7 项），白名单有了默认关的条目后结论不变 |
| E3 | `out-node-runtime/node src/dsh-host/tools/e3-readonly-plugin-install.ts` | 通过（10 项）。产物副本的 manifest 里有试点插件（默认关），夹具插件的开启与关闭判据不受影响 |

Windows 上的同一份打包冒烟由 CI 跑（`scripts/packaged-dsh-host-smoke.mjs` 已含试点插件的开启与读写），本机跑不了，需要推送后看结果（决策 115 第 9 条）。
