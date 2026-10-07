# 决策 153：E8-A 的实现取舍——插件审查必拒三条与静态守卫

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [决策 149](149-user-rulings-2026-10-07.md) 第 4 条（用户裁决）：E8 缓解选 A，只加审查判据与静态守卫，运行期行为不变；三条必拒判据以该条原文为准。
- [决策 150](150-e8-plugin-credential-isolation.md)：结论第 1～4 条（插件与宿主凭据同权），§3（判据原稿），§5 存疑 3（两个试点插件碰没碰这些 API）。
- [证据：E8 插件与凭据的隔离边界](../evidence/e8-plugin-credential-isolation-2026-10-07.md)。
- [P1-10 / P1-16 分片 03](../topics/p1-10-p1-16-extensions/03-design.md) §3.2 第 7 项、§6.1、§6.2 第 5 项。
- [决策 059](059-allowlist-verification-and-audits.md)（白名单双键与依赖闭包）、[决策 114](114-p1-4d3-ask-user-choices.md)（`dsh-tool-ask-user` 由产品 bundle 挂一行）、[决策 115](115-p1-10d-pilot-plugin-choices.md) 与 `src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md`（试点插件审查记录）。

代码提交 `350aa1b1`：

- `scripts/dsh-plugin-review-guard.mjs`：扫描模块，只依赖 `node:fs` 与 `node:path`；
- `scripts/__tests__/dsh-plugin-review-guard.test.mjs`：守卫测试与反向样本，20 个用例。

运行期行为没有改动。**第 5 节第 1 条（`process.env` 不进必拒）、第 7 节（CI 覆盖面）请重点审批。**

## 1 判据写在哪

- 分片 03 §6.2 第 5 项下加「必拒三条」。
  - 与原有的敏感 API 参考项分开写：参考项由审查人读源码判断；必拒项命中任一条即拒绝，不做豁免，也不靠审查人解释放行。
  - 三条的文字照决策 149 第 4 条。第 1 条补一句「含 `inject` 里声明 `credentials`」。
- §3.2 第 7 项（构建期扫描报告只作参考）注明：必拒三条不在此列。
- §6.1 威胁表的「凭据」一行改成 E8 的实测结论。这是决策 150 §3 末段的建议，属于方案 A。

## 2 扫描范围：从哪派生、源码在哪

**扫描对象**由测试现算，代码里不写包名：

1. **白名单全部条目**（`src/dsh-host/plugins/allowlist.json`）。
   - `official` 与 `internal` 都扫。
   - 经 `preflightDshHost` 读取，与构建预检同一套规则。预检失败时测试直接失败。
2. **产品 bundle 挂载的非我方包**。
   - 用钉住的 `dsh-app-boot` 的 `loadOverlayPatches` 解析 `@aiclient/dsh-app` 的 `cordis.patch.yml`，与宿主读补丁的方言一致。
   - 取每个 `insert` 行（含 group 的子行）的模块名，归到包名。凡不是 `@aiclient/dsh-app` 的包都扫。
   - 目前只有 `@deepseek-ai/dsh-tool-ask-user`。它不是 bundle，白名单收不了，由产品 bundle 挂一行（决策 114）。
   - **不按 `@deepseek-ai/` 前缀豁免**：官方包挂到 dsh-base 之外，与第三方插件同进程同权。
3. **每个包连同它带进来的依赖闭包**。
   - 闭包用锁文件算，即 `hostBaseClosure` 加 `pluginClosure`，与决策 059 的双键同一套。宿主自己的树（dsh-base 及其闭包）不算插件闭包。
   - 目前两个包的闭包都是空的：运行期依赖为 0，peer 全在宿主树里。

**源码位置**：`src/dsh-host/node_modules`，也就是 `npm ci` 装出的宿主安装范围，打包产物 `out-dsh-host` 由它物化而来。

- 本机与 CI 的 gate 都有这份安装，见第 7 节。
- worktree 根目录的 `node_modules` 是软链，与这里无关：`src/dsh-host/node_modules` 是宿主自己的安装。
- 不用 `out-dsh-host`：开发机不跑整包构建，而且 gate 在打包作业之前跑。

**防止扫到错的、或者什么都没扫**：

- 装上的版本必须等于锁文件里的版本；白名单条目还必须等于清单版本。不一致就失败，提示重新 `npm ci`。
- 每个被扫的包（含闭包里的包）的入口模块必须在已扫描的文件里。跳过规则不能把入口跳掉，遍历出错也不能空转通过。
- 派生出的扫描对象不能为空，每个白名单条目都要在里面，而且都是宿主 `package.json` 装的包。

## 3 不扫什么：豁免规则

- **我方五行**：`aiclient-credentials`、`aiclient-bridge`、`aiclient-permissions`、`aiclient-loop-guard`、`aiclient-encrypted-read`。它们合法地使用凭据与 IPC。
  - 豁免是显式列表 `OWN_PRODUCT_ROWS`（冻结数组），测试核对三处：
    - 等于测试里手写的副本；
    - 等于产品 bundle 实际加载 `@aiclient/dsh-app/*` 的行；
    - 等于构建库 `BRIDGE_ENTRIES` 的行。
  - 下面几种情况测试都会失败：新增一个我方行而列表没改；列表里的行不再出现；某个我方行 id 改去加载别的包。
  - 所以要扩大豁免，必须同时改模块和测试两处，在评审里看得见。
- **DSH 核心**：没有豁免条目，靠派生集合的构成排除。
  - dsh-base 的行（含 `llm-*`）不是产品 bundle 的 `insert`，也不在白名单里。
  - `dsh-app-boot`、`dsh-launch-environment` 这类宿主直接引用的包也不是行。
- **插件本身没有任何豁免机制**。试点插件命中时不加豁免、不改判据：要么拿掉插件，要么报给用户裁决。

## 4 三条判据的静态近似

**预处理**：

- 按字节读文件，按 latin1 解码，裸 NUL 不截断任何内容。
- `\uXXXX`、`\u{X}`、`\xXX` 转义如果拼出的是字母、数字、`_`、`$`、`.`，先解码。这样 `process.on(...)` 也认得出来。
- 引号、斜杠、换行这类字符的转义不解码，因为它们会改变字符串与注释的边界。

**只认代码里的出现**：除 `cordis.original` 外，命中位置必须落在代码里，注释、字符串内容、模板字面量的文本段、正则字面量都不算。

- 判断靠一个小词法器，是近似。
- YAML 补丁文件只把 `#` 注释当非代码，`!!js` 表达式照扫，加引号的也扫。
- `cordis.original` 本身就是字符串，在任何位置出现都算。

| 判据 | 规则 | 认什么 |
|---|---|---|
| 1 凭据 | `ctx-credentials` | `ctx` / `context`（含 `this.ctx`）的 `.credentials`、`?.credentials`、`['credentials']` |
| | `ctx-get-credentials` | `ctx.get('credentials')`（任意引号） |
| | `inject-credentials` | `inject` 声明里出现 `credentials`：数组、对象、`ctx.inject([...])` |
| 2 宿主 IPC | `send` | `process.send`，任何用法 |
| | `prepend-listener` | `process.prependListener` / `prependOnceListener`，任何事件 |
| | `message-listener` | `process.on` / `once` / `addListener` / `off` / `removeListener` / `listeners` / `rawListeners` / `emit`，事件是 `'message'` |
| | `remove-all-listeners` | `process.removeAllListeners()`，无参或 `'message'` |
| 3 逃出代理 / 猴子补丁 | `cordis-original` | 字符串 `cordis.original`，任何位置 |
| | `property-write` | 对下列对象的任意属性链做赋值，`=` 与全部复合赋值都算，比较与箭头不算 |
| | `define-property` | `Object.defineProperty` / `defineProperties` / `assign` / `setPrototypeOf`、`Reflect.set` / `defineProperty` / `setPrototypeOf` / `deleteProperty`，以及 esbuild 的 `__defProp`，第一个参数是下列对象 |

**判据 2 里的 `process` 包括**：

- `globalThis.process`、`global.process`；
- 文件里绑定到 `process` 的名字：`const p = process`、`import p from 'node:process'`、`require('process')`；
- 方括号写法，例如 `process['send']`。

**判据 3 的「下列对象」**：

- `process`（`process.env` 除外，见第 5 节）。
- `globalThis`、`global`。
- Node 的模块系统：
  - 文件里从 `module` / `node:module` 取得的绑定，含 `{ Module }`、`{ Module: M }`；
  - `require('module')`、`module.constructor`、`require.cache`、`require.extensions`。
- `ctx.get(...)` 的返回值：
  - 直接链式写，例如 `ctx.get('fs').readText = …`；
  - 先 `const x = ctx.get(...)`，之后 2000 个字符内经 `x` 写（`SERVICE_ALIAS_WINDOW`）。
- 插件自己的文件里，`ctx.<服务>.<属性> = …` 以及 `const x = ctx.<服务>` 之后经 `x` 写：这和经 `ctx.get('<服务>')` 写是同一件事。
- `Object.prototype`、`Function.prototype`，以及从 `events` 取得的 `EventEmitter.prototype`。改 `EventEmitter.prototype.emit` 不用点名 `process` 就能截到 IPC 消息。

## 5 近似边界：有意不认的写法

1. **`process.env` 的写不进必拒**。**请审批。**
   - 原因：常见库 `debug` 会写 `process.env.DEBUG`，`google-logging-utils` 也会写环境变量。进必拒，带这些库的插件会一律被拒。
   - 代价：插件改代理类环境变量、把模型流量引到别处，只能靠审查单第 5 项人工看。构建期报告的 `process-env` 类已经会标出来。
   - 例外：经 `globalThis.process.env` 写时，按「全局对象的属性赋值」照样命中。
2. **裸标识符 `Module` 不认**，只认从 `module` 取得的绑定。
   - emscripten 生成的胶水代码用同名局部对象。宿主依赖里实测 1186 处，在 `sharp-wasm32`、`web-tree-sitter` 等 3 个包里。
3. **UMD 包装遮蔽 `global` 时不认 `global.x =`**。
   - 文件里有 `function (global, factory)` 这样以 `global` 为参数的写法时，这个文件里不认 `global.x =`，`globalThis` 照认。
   - 实测涉及 `turndown`、`web-streams-polyfill`。
4. **`ctx.<服务>.<属性> =` 只在插件自己的文件里认**，依赖闭包里不认。
   - Koa、zod 等把别的上下文也叫 `ctx`，zod 4 随包的测试里有 `ctx.jsonSchema.type = …`。
   - `ctx.get(...)` 的写在依赖里照认。
5. **`process.channel`、`process.disconnect` 不进必拒**。
   - 裁决原文没有这两项。
   - Node 的 `process.channel` 只暴露 ref / unref，读不到消息。execa 会合法地读它。
6. **内置原型只认 `Object`、`Function` 与 events 的 `EventEmitter`**。
   - `Promise`、`Buffer`、`Headers`、`Request` 等名字常被库自己的同名类占用，会误报，例如 bluebird、node-fetch、undici。
   - `buffer-equal-constant-time` 这类真改 `Buffer.prototype` 的库因此漏掉，归人工审查。
7. **不读的文件**：
   - 按扩展名：`.md`、`.json`、`.map`、`.d.ts`、许可证类文件、图片、字体、压缩包、`.html`、`.css`；
   - 按目录：包内的 `test(s)`、`__tests__`、`__mocks__`、`spec(s)`、`bench`、`example(s)`、`doc(s)`、`coverage`、`.github`、`.yarn`、`.history`；
   - 按文件名：`*.test.*`、`*.spec.*`、`*.bench.*`。
   - 原因：Node 不会加载这些文件。zod 4 随包的测试里有 `globalThis.Date = …`。
   - 跳过的文件在扫描结果里逐个列出；入口模块要是被跳过，测试就失败（第 2 节）。

**标定**：用同一套规则扫宿主自己的 332 个安装包。它们不是扫描对象，只用来估计误报面。

- 有命中的是 30 个包。DSH 核心以外的第三方命中，看下来全是真实的全局或 `process` 写：
  - undici 的 `install()` 写 `globalThis.fetch`；
  - signal-exit 改 `process.emit`；
  - formdata-polyfill 改 `global.fetch`；
  - fetch-blob 临时改 `process.emitWarning`；
  - web-tree-sitter、yaml 的命令行入口等写 `process.exitCode`；
  - node-pty 的子进程脚本用 `process.send`。
- **含义**：以后的插件只要打包了、或者依赖了这些库，守卫就会拒。这是裁决字面上的后果，不是误报；要放行只能由用户改裁决。

## 6 已知盲区：守卫是辅助，审查是主防线

- **动态拼出来的名字**：`process['se' + 'nd']`、`ctx.get(name)`（`name` 是变量）、`Symbol.for(key)`（`key` 是拼出来的）。
- **别名经函数参数或对象属性传递**：例如 `install({ service: ctx.get('fs') })`，再在另一个函数里写 `service.readText = …`。我方 encrypted-read 行正是这种写法，守卫看不见。
- **其他别名漏洞**：别名窗口之外的写；`process` 的其他取法，例如 `Object.getPrototypeOf(process)`、`createRequire` 得到的 `require` 的 `cache`。
- **混淆代码**：正则字面量与除号的歧义能让词法器把代码当成字符串。判据 1、2 与判据 3 的赋值规则会因此漏掉，`cordis.original` 不受影响。
- **运行期才有的代码**：`eval`、`new Function`、运行期加载的代码，`.node` 原生件，`.wasm`。
- **藏在跳过目录里的代码**：放在第 5 节第 7 条跳过的目录或文件里，再被主代码 `require` 进来。
- **结论**：守卫通过不等于审查通过。分片 03 §6.2 的逐行读源码仍是唯一的硬防线（决策 150 第 6 条）。守卫的作用是把判据钉住，让明显违规、或者无意中带进来的用法过不了 gate。

## 7 守卫放在哪、CI 会不会跑

- **测试位置**：`scripts/__tests__/dsh-plugin-review-guard.test.mjs`，属于根 vitest（`vitest.config.ts` 收 `scripts/__tests__/**/*.test.mjs`）。
  - `pnpm test`、`pnpm exec vitest run scripts` 都会跑它。
  - 文件名不含 Static / Scan / Wiring，`vitest run Static Scan Wiring` 的筛选跑不到它。
- **build.yml**：gate 的第 4 步 `pnpm test` 会跑到守卫。
  - 这一步之前已经在 `src/dsh-host` 跑过 `npm ci --ignore-scripts --no-audit --no-fund`，扫描源在场。
  - 打包作业（build-app、build-remote-runtime-linux 直接 `needs: gate`；build-windows、build-linux 经 build-app 间接依赖）都排在 gate 之后，守卫红了就不出包。
  - 但 build.yml 只在推 `v*` tag 和手动运行时触发。
- **dsh-bridge-gate.yml**（推 `feat/dsh-*` 时跑）**不跑这个守卫**：它只跑录制核对、宿主 typecheck 与两个指定套件。
  - 它也装了 `src/dsh-host`，扫描源同样在场。
  - 加一步 `pnpm exec vitest run scripts/__tests__/dsh-plugin-review-guard.test.mjs`（约 0.5 秒）就能覆盖。
  - **本次没有改 CI，加不加由用户定。**
- **不接进 `build-dsh-host.mjs`**：构建期审计目前只出参考报告。守卫已经在 gate 里、先于打包作业跑，效果相同。
  - 以后如果要在构建里再拦一道，模块没有额外依赖，可以直接引用。

## 8 试点插件与反向样本的结果

**两个试点插件都是零命中**，没有加豁免，也没有为它们调判据：

| 包 | 来源 | 扫描文件 | 跳过 | 闭包 | 命中 |
|---|---|---|---|---|---|
| `dsh-office-tools@1.0.4` | 白名单 | `lib/index.js`、`cordis.patch.yml` | 15（`.d.ts` 10 个、README 2 个、`package.json`、`dsh.plugin.json`、`LICENSE`） | 空 | 0 |
| `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2` | 产品行 `tool-ask-user` | `lib/index.js`、`README.i18n.yaml` | 5 | 空 | 0 |

- `dsh-office-tools` 里唯一的 `ctx.get("sandboxPolicy")` 被认作服务绑定，之后只调用了 `resolve`，没有写。`ctx.fs` 的两个别名也没有写。
- 这与审查记录第 5 节的人工结论一致。决策 150 的存疑 3 至此有了答案。

**反向样本**：

- **E8 探针插件**（`src/dsh-host/tools/credential-probe-plugin/`）：三条全中，共 16 处，包括 `inject = ['credentials']`、`ctx.credentials`、`process.on('message')`、`process.prependListener`、`process.send` 与 `process.send =`、`cordis.original`。
- **临时目录里的夹具插件**：
  - 三条判据各用一个文件，单独命中，失败信息含包名、文件、行、列、判据；
  - 判据 1 有 8 种写法，判据 2 有 11 种，判据 3 有 19 种，逐一命中；
  - 16 个近邻反例保持干净，对应第 5 节的边界；
  - 裸 NUL 与转义藏不住命中；
  - YAML 补丁跨过含 `/*` 的注释照扫；
  - 依赖目录里的 `ctx.<x>.<y> =` 不算、`process.on('message')` 算；
  - 跳过规则逐项验证。
- **变异验证（本机做过，没有入库）**：往装好的 `dsh-office-tools/lib/index.js` 末尾临时加一行 `ctx.get("credentials")`，守卫失败。失败信息是 `dsh-office-tools@1.0.4: dsh-office-tools/lib/index.js:2355:29 [credentials/ctx-get-credentials] …`。之后已还原，逐字节核对一致。

## 待用户审批

1. 第 5 节第 1 条：`process.env` 的写不进必拒。备选是进必拒，代价是带 `debug` 等库的插件一律被拒。
2. 第 7 节：要不要把守卫加进 `dsh-bridge-gate.yml`。现在推 `feat/dsh-*` 时不跑它。
3. **守卫没有豁免机制**。以后某个审过的插件，可能因为依赖库里真实的全局写（第 5 节「标定」）被拒。到那时只能换插件，或者由用户裁决改规则；改规则要另立决策。
4. 「出现」的解读：审查单照裁决写「出现」即拒；守卫只认代码里的出现，注释和字符串内容不算，`cordis.original` 例外。审查人读源码时也按「代码里的使用」判断。
