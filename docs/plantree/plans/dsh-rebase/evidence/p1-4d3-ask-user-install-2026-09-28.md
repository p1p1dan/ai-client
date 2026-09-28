# 证据：P1-4d3 联网安装 `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2`（2026-09-28）

Role: evidence。上位：[P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §8 第 3 条（官方包的 peer 能否解析）；授权见[决策 110](../decisions/110-user-rulings-2026-09-28-batch2.md)「联网装包」行；装法与挂载的取舍见[决策 114](../decisions/114-p1-4d3-ask-user-choices.md)。

**结论：装包干净，§8 第 3 条的实验通过。**
- 锁文件只新增这一个包，没有任何已有包的版本或内容变化；
- 来源是公共 npm registry，带 sha512 integrity；
- 四个 peer 都由已钉住的树满足，**不需要 `overrides`**。原因是它的 peer 写的是精确版本，不是 P1-10 实验 E2 里那种会触发 `ERESOLVE` 的预发布范围。

另有一个与方案前提不符的发现：**这个包不是 DSH bundle**（没有 `dsh.bundle`，也没有 `cordis.patch.yml`），P1-10 的白名单流程收不了它，改为由产品 bundle 挂一行（第 4 节，决策 114 第 1 条）。

## 1 环境与前提

- 分支 `feat/dsh-p0-probe`，HEAD `ebdf8abc`，加本任务未提交的改动；Linux 开发机。
- npm 10.9.8，系统 Node v22.23.2。npm 对宿主包的 `engines: node >=24` 报了 `EBADENGINE` 警告：只是提示，宿主运行用的是随包 Node v24.18.0。
- 钉版本核对：`src/dsh-host/package.json` 里 `@deepseek-ai/dsh-base` 为 `0.1.7-rc.2`，与要装的版本相同。
- registry：只用 `src/dsh-host/.npmrc` 里的 `registry=https://registry.npmjs.org/`，没有改动，也没有用镜像或私有源。本任务的联网只有下面这两条 npm 命令。

## 2 第一步：只写锁文件

```bash
npm --prefix src/dsh-host install --package-lock-only --save-exact --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2
```

退出码 0（「up to date in 9s」）。与改动前的锁文件逐条比对（脚本读两份 `packages`）：

| 项 | 结果 |
|---|---|
| `packages` 条目数 | 408 → 409 |
| 新增 | 1 条：`node_modules/@deepseek-ai/dsh-tool-ask-user` |
| 删除 | 0 |
| 已有条目内容变化 | 0（根条目只多了这一个依赖） |
| `package.json` | `dependencies` 多一行 `"@deepseek-ai/dsh-tool-ask-user": "0.1.7-rc.2"`（精确版本） |

新增条目：

- `resolved`：`https://registry.npmjs.org/@deepseek-ai/dsh-tool-ask-user/-/dsh-tool-ask-user-0.1.7-rc.2.tgz`
- `integrity`：`sha512-qOdhDY9GD6ibSKFNNcRN3i/FHj1csnStK3DHg/5Gagz4W4i3YmpfK+5bOPp/wrhPgzRDCh/wLYjRo4SiyKujWA==`
- `license`：MIT
- 没有 `dependencies` / `optionalDependencies`，没有 `hasInstallScript`，所以没有新的依赖闭包。

**peer 结论**：

| peer | 声明 | 树里的版本 |
|---|---|---|
| `@deepseek-ai/cordis` | `~4.0.4` | 4.0.4 |
| `@deepseek-ai/dsh-agent` | `0.1.7-rc.2` | 0.1.7-rc.2 |
| `@deepseek-ai/dsh-tools` | `0.1.7-rc.2` | 0.1.7-rc.2 |
| `@deepseek-ai/dsh-user-questions` | `0.1.7-rc.2` | 0.1.7-rc.2 |

四个 peer 全部满足。

**全锁文件 integrity 核对**：除了原有的本地 `bundle`（`@aiclient/dsh-app`，`file:./bundle` 的链接目标，本来就没有 `resolved`）以外，每一条的 `resolved` 都以 `https://registry.npmjs.org/` 开头，并且都带 `integrity`。

## 3 第二步：真正安装

```bash
npm --prefix src/dsh-host install --save-exact --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2
npm --prefix src/dsh-host ls @deepseek-ai/dsh-tool-ask-user
npm --prefix src/dsh-host ls --all
```

- 安装：「added 1 package in 1s」。锁文件与 `package.json` 的差异与第一步完全相同（锁文件 +13 行，`package.json` +1 行）。npm 解包时按锁文件的 integrity 校验了 tarball。
- `ls @deepseek-ai/dsh-tool-ask-user`：`└── @deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2`。
- `ls --all`：退出码 0。
  - 没有 missing、invalid；
  - 标为 `UNMET OPTIONAL DEPENDENCY` 的都是其他平台的二进制包和可选 peer，本来就有；
  - 另有两条 `extraneous`：`@emnapi/runtime@1.11.3`、`@img/sharp-wasm32@0.35.4`。**它们早于本次安装**：目录时间是 2026-09-25，也就是最初那次 `npm ci`；两条的锁文件条目在本次前后完全相同。它们是 sharp 给 wasm32 的可选依赖，`npm ci` 装上了，但在 linux-x64 上 `npm ls` 把它们判为多余。与本次安装无关，没有处理。

## 4 包的内容：不是 bundle

- `package.json`：`type: module`，`main: lib/index.js`；没有 `dsh` 字段，也就是没有 `dsh.bundle`、没有 `dsh.client`；没有 `bin`；没有 `cordis.patch.yml`。
- `lib/index.js`（116 行）：一个普通的 Cordis 插件。
  - `name = "tool-ask-user"`，`inject = ["tools", "userQuestions"]`；
  - 注册一个工具 `ask_user_question`，把模型参数（`multi_select` 改名为 `multiSelect`）交给 `ctx.userQuestions.ask({questions, agent, signal})`，再把答复原样整理成 `{answers:[{id, selected, custom?}]}`；
  - 只 import 了 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-user-questions`。敏感 API 快速检查（`process.`、`require(`、`fetch`、`child_process`、写文件、`eval`、`Function(`）没有任何命中。
- 影响：P1-10 的白名单要求插件是 bundle，并且只能 insert 自己声明的行。具体有三处拦截：
  - `dshPluginAllowlist.ts` 的 `rows` 必填；
  - 构建期 `auditInstalledPlugins` 会报「is not a DSH bundle (no dsh.bundle.patch)」；
  - 宿主的 `judgeInstalled` 会判为 `rejected: declares no dsh.bundle.patch`。

  所以这个包进不了白名单。改为照 DSH 发行版的做法，由发行版自己的 bundle（我方的 `@aiclient/dsh-app`）插一行 `tool-ask-user` 挂载它，包本身列为宿主依赖（决策 114 第 1 条）。

## 5 构建与冒烟（同一工作区）

- `node scripts/build-dsh-host.mjs`：通过。预检的钉版本检查、锁文件检查、双键检查都通过；npm ci 装了 347 个包。
  - 产物（linux-x64）：86,219,333 B / 9,761 个文件 / 342 个包 → **86,261,723 B / 9,765 个文件 / 343 个包**，即 +42,390 B、+4 个文件、+1 个包，在体积预算之内；
  - 其中这个包在产物里占 8,651 B、4 个文件：`lib/index.js`、`LICENSE`、`package.json`、`README.i18n.yaml`（类型声明和 README 按 B 档裁掉了）；其余增量来自 host.js 与 bridge.js；
  - 许可清单 `THIRD_PARTY_LICENSES.json` 有它的条目，并带 LICENSE 文件；
  - 产物里 `@aiclient/dsh-app/cordis.patch.yml` 带 `tool-ask-user` 行。
- `node scripts/packaged-dsh-host-smoke.mjs --level 1 --host-dir out-dsh-host --node out-node-runtime/node`：**PASS，41 项**。
  - ready 时活动行由 77 个变为 78 个，多出的正是新行；inactive 为 0。
