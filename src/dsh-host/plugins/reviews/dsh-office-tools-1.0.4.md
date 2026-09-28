# 审查记录：`dsh-office-tools@1.0.4`

- 审查日期：2026-09-28
- 审查人：dsh-rebase P1-10d 代理（自主审查，待用户审批，见[决策 115](../../../../docs/plantree/plans/dsh-rebase/decisions/115-p1-10d-pilot-plugin-choices.md)）
- 依据：[P1-10 / P1-16 分片 03 §6.2 审查单](../../../../docs/plantree/plans/dsh-rebase/topics/p1-10-p1-16-extensions/03-design.md#62-审查单每个包的每个版本一份记录)，[决策 059](../../../../docs/plantree/plans/dsh-rebase/decisions/059-allowlist-verification-and-audits.md)、[060](../../../../docs/plantree/plans/dsh-rebase/decisions/060-first-allowlist-pilot-office-tools.md)、[082](../../../../docs/plantree/plans/dsh-rebase/decisions/082-allowlist-implementation-choices.md)
- 审查对象：registry 上的 tarball 本身（`npm pack` 取回，与安装目录里的文件逐字节相同），不是 GitHub 源码
- 钉住的 DSH：`0.1.7-rc.2`
- 安装过程：[证据 p1-10d-office-tools-install-2026-09-28](../../../../docs/plantree/plans/dsh-rebase/evidence/p1-10d-office-tools-install-2026-09-28.md)

## 结论：有条件通过

可以作为**默认关闭**的试点随包（`defaultEnabled: false`）。条件：

1. 默认关闭；用户在设置里手动打开才参与组合（决策 060 第 2 条、D5）。
2. 过闸分类按本记录第 7 节：3 个读工具按「读」、5 个写工具按「写」，写工具出审批卡；**不按目录标注的「只读」处理**。
3. 下列任何一项发生都要重审：插件升版；DSH 升版（peer 与 `@deepseek-ai/schemastery` 的解析都要重核，见第 3 节）；`package.json` 的 `overrides` 变化。
4. 已知风险在第 8、9 节列出，接受的理由写在各条下面。其中「超大或构造的 Office 文件会同步占用共享宿主的事件循环」这一条，在插件默认关闭、单文件 50 MiB 上限的前提下接受；如果以后要默认开启，先重新评估。

## 1 身份与许可

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-office-tools@1.0.4`（`latest`，发布于 2026-09-22） |
| integrity | `sha512-Q1jvlhjKDHjoZBX54WkT0zCblUGACPwiCQJfS/cgU5jVLzI3q66bU/MR5QEsERd9QJQhtgOdH89opZtvga6uxA==`（registry 元数据、`npm pack`、锁文件三者一致；本地对 tarball 重算 sha512 也一致） |
| shasum | `a4591cb3cfdb6ba5c48e9d8d5e2293a44e416349` |
| 来源 | `https://registry.npmjs.org/dsh-office-tools/-/dsh-office-tools-1.0.4.tgz` |
| 发布者 / 维护者 | npm 账号 `kw767`（唯一维护者）；源码仓库 `github.com/kw78/dsh-office-tools`，`gitHead 44224c3c…`（本次只联网访问 npm registry，没有核对 GitHub 上的提交与 tag；审查以 tarball 为准） |
| 出处证明 | registry 报告带 SLSA v1 provenance 与 npm 签名；本次没有联网独立验证证明链 |
| 许可 | MIT，包内带 `LICENSE`（Copyright 2026 kw78），在插件许可名单内（`PLUGIN_LICENSES`） |
| 历史版本 | 0.1.0、0.2.0、1.0.0、1.0.2、1.0.3、1.0.4，首发 2026-08-15 |

判断：个人维护的社区包，发布历史短，单一维护者。这正是「审查是唯一硬防线」的情形，所以下面逐行读了源码，而不是只看扫描报告。

## 2 安装期

- `scripts` 只有 `test`、`build`、`check`、`types`、`test:e2e`、`typecheck`，**没有** `preinstall` / `install` / `postinstall` / `prepare`；锁文件条目没有 `hasInstallScript`。`--ignore-scripts` 安装后原样可用（P0-2 与本次冒烟都证明了）。
- **没有原生件**：17 个文件里没有 `.node`、`.wasm`、二进制；运行期只用 Node 内置的 `node:zlib`、`node:path`。
- **没有 `bin`**，没有 `dsh.client`（纯宿主插件）。
- tarball 17 个文件、解包 157,076 B：`lib/index.js`（118,064 B，esbuild 打出的单文件，带 sourcemap 注释但包里没有 `.map`）、`lib/types/*.d.ts` 10 个、`package.json`、`cordis.patch.yml`、`dsh.plugin.json`、`LICENSE`、两份 README。

## 3 依赖闭包

- **运行期依赖为 0**：`dependencies`、`optionalDependencies` 都没有；`xlsx`、`jszip` 等只在 `devDependencies`，没有打进 `lib/index.js`（ZIP 与 OOXML 是插件自带的实现）。
- **peer**（全部 optional）：`@deepseek-ai/cordis ^4.0.1`，以及 `dsh-fs`、`dsh-llm`、`dsh-agent`、`dsh-tools`、`dsh-session` 五个 `^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.5-alpha.0`。
  - DSH 自己的 `evaluatePluginCompatibility`（含预发布匹配）判定与 `0.1.7-rc.2` 兼容，构建期审计会再判一次，不许豁免。
  - npm 的匹配不含预发布，五个 dsh peer 报 `ERESOLVE`（与 P1-10a 实验 E2 相同），所以按决策 082 第 3 条在宿主 `package.json` 写了 `overrides`，把这五个 peer 钉到宿主版本 `0.1.7-rc.2`。`cordis` 的 `^4.0.1` 本来就满足 `4.0.4`，没有钉。
- **未声明的依赖**：`lib/index.js` 第 2 行 `import z from "@deepseek-ai/schemastery"`，而 `schemastery` 既不在 `dependencies` 也不在 `peerDependencies`（只在 `devDependencies`）。它靠宿主树顶层提升的 `node_modules/@deepseek-ai/schemastery@3.18.4`（DSH 自己的依赖）解析。
  - 现在能用，打包冒烟（插件开启）验证了行在活动、模块都从产物内解析；
  - 风险：DSH 升级后如果这个包不再提升到顶层，插件行会起不来（宿主照常，报 `inactiveRows`）。列入复审触发条件。
- 其余 import：`@deepseek-ai/dsh-tools`（`defineTool`），均来自钉住的 DSH 树。

## 4 组合（bundle 补丁）

`package.json` 的 `dsh.bundle.patch` 是 `./cordis.patch.yml`，全文：

```yaml
- insert:
    - id: dsh-office-tools
      name: dsh-office-tools
```

- 只 `insert` 一行，行 id `dsh-office-tools`，模块就是本包；没有 `id` 定位、没有改任何已有行、没有 `!!js` 表达式、没有 `config`。
- 白名单 `rows` 声明 `["dsh-office-tools"]`，构建期 `auditBundlePatches` 与宿主装载审计都用这一份。
- `dsh.compatibility` 字段（`dsh >=0.1.0-rc.6`、`dshReleases` 只列到 0.1.5-rc.2）DSH 准入不读，只作参考。
- 插件的 `Config` 只有 `enablePptTools`（默认 `true`），我方不配置，8 个工具都注册。

## 5 敏感 API

构建库的静态扫描（`scanSensitiveApis`，13 类）对这个包**零命中**。人工逐行读 `lib/index.js`（2353 行）后，它用到的全部外部接口如下：

| 接口 | 位置（`lib/index.js` 行号） | 用途 |
|---|---|---|
| `ctx.tools.register` | 826、904、979、1684、1790、1907、2183、2269 | 注册 8 个工具 |
| `ctx.effect` | 2338 | 注册与注销（dispose 时注销全部工具） |
| `ctx.fs.resolve` / `contains` / `processPath` | 403–408 | 把 `path` 解析成 DSH 的文件目标，并确认在工作区内 |
| `ctx.fs.stat` / `readBytes` | 410、419、426、438、1260、1264 | 读 Office 文件（上限 50 MiB），`ppt_create` 读图片头部取尺寸 |
| `ctx.fs.writeText` | 432（`saveOfficeText`，唯一的写入点） | 写出生成的文件 |
| `ctx.fs.sandboxMode`、`ctx.get("sandboxPolicy").resolve({session})` | 366–372 | 取写入策略（工作区根）；只读，不改策略 |
| `node:zlib` 的 `inflateRawSync` | 8、244 | 解压 docx / xlsx / pptx 的条目，带 `maxOutputLength` |
| `node:path` | 361 | 路径运算 |

逐项结论：

- **凭据**（`ctx.credentials`、`credentials` 服务）：无。
- **`process.env`**，以及 `process` 的任何属性：无。
- **IPC**（`process.send` / `process.on('message')`）：无。
- **子进程**（`child_process`、`ctx.subprocess`、`spawnTerminal`、`execFile`）：无。
- **网络**（`fetch`、`http(s)`、`net`、`tls`、`dns`、`ws`、`undici`）：无。文件里出现的 `http://schemas.openxmlformats.org/…`、`http://purl.org/…` 都是写进 XML 的命名空间字符串，不是请求。
- **越界写**：唯一的写入点是 `ctx.fs.writeText`，不直接用 `node:fs`。写入前插件自己做两道工作区检查：词法上 `relative(root, candidate)` 不许 `..` 或绝对路径（`assertLexicallyWithin`，385–390）；再用 `ctx.fs.contains(工作区, 目标)` 按 DSH 的规范路径检查（403–406）。越界一律抛错。读取也走同一个 `resolveOfficePath`，同样限制在工作区内。
- **`eval` / `new Function` / 计算出来的动态 `import()` / `require`**：无。
- **`vm`、`worker_threads`**：无。
- **猴子补丁**（`Module._load`、`require.cache`、改全局对象、`Object.defineProperty(globalThis…)`）：无；也没有 `Reflect`、`Proxy`、`__proto__`、`import.meta`。
- **遥测或上报**：无。生成的文件里 `docProps/app.xml` 的 `Application` 写的是 `dsh-office-tools`，只是文件元数据。
- **计时器**（`setTimeout` / `setInterval`）：无，不会在工具调用之外留下后台活动。

## 6 钩子

- 没有监听任何事件：没有 `ctx.on`，所以没有 `tools/pre-execute`、`approval/request`、`agent/request`、`llm/*`、`system-prompt/assemble` 监听者，**不会自动应答审批**（不是 `aiclient-probe` 那一类问题，决策 015）。
- 它注入 `tools`、`fs` 两个服务（`inject = ["tools", "fs"]`），另经 `ctx.get` 只读取 `sandboxPolicy`。

## 7 工具与过闸分类

目录（P0-2 当时看到的标注）写的是只有 `fs-read`；包自己的 `package.json` 里 `dshWorkshop.permissions` 其实写了 `files:workspace-read` 和 `files:workspace-write`。**实测：8 个工具里 5 个写文件。**

| 工具 | 实际行为 | 过闸分类 | 路径参数 |
|---|---|---|---|
| `word_read` | 读 `.docx`，返回文本或 Markdown | 读 | `path` |
| `excel_read` | 读 `.xlsx`，返回各 sheet 的行 | 读 | `path` |
| `ppt_read` | 读 `.pptx`，返回文本、备注、形状几何 | 读 | `path` |
| `word_create` | 新建 `.docx`；`overwrite: true` 时覆盖 | **写** | `path` |
| `word_update` | 读出已有 `.docx`，追加内容后整份重写 | **写** | `path` |
| `excel_create` | 新建 `.xlsx`；`overwrite: true` 时覆盖 | **写** | `path` |
| `excel_update` | 读出已有 `.xlsx`，替换 sheet 或写单元格后整份重写 | **写** | `path` |
| `ppt_create` | 新建 `.pptx`；另外**读**参数里各张图片（`slides[].images[].path`）的头部取尺寸，图片以外部链接方式引用 | **写** | `path` |

- 插件自己的 `presentCall` 也把创建与更新标成 `kind: "edit"`、读标成 `kind: "read"`，与上表一致。
- 落地（`src/dsh-host/permissions/classification.ts` 的 `PLUGIN_TOOL_CLASSES`，白名单 `tools` 与之相同）：
  - 读：按 DSH 的 `read` 过闸，路径取 `path` 参数；工作区内的读在 ask / accept-edits / auto 档不出卡，plan 模式可用；
  - 写：工具名保持插件自己的（卡片、会话授权按「这个工具 + 这个文件」记），路径取 `path` 参数，卡片预览整份参数；`write` 的路径规则同样适用；ask 档出卡，accept-edits 档在工作区内放行（与 `write` / `edit` 相同），plan 模式拒绝。
- `ppt_create` 读取的图片路径不在路径参数里，闸门不单独问；插件对图片路径做同样的工作区限制（`resolveOfficePath`），而且只读头部取尺寸、不把图片内容交给模型，所以接受。

## 8 数据去向

- **不往外发任何数据**，不需要自己的凭据（P1 也不提供）。
- **写到哪里**：只写会话工作区内、模型在 `path` 里指定的那一个文件，经 DSH 的文件服务发布：新建时先写到临时目录再硬链接到目标，覆盖时 rename（Windows 上用 ReplaceFile），与 DSH 自己的 `write` 相同。不写 `DSH_HOME`，不写安装目录，不写工作区外。
- **生成文件的内容风险**：
  - `excel_*` 把 `=` 开头的字符串写成真正的公式。模型可以写出在 Excel 打开时求值的公式（含外部链接一类）。缓解：每次写入都出审批卡，卡片预览完整参数；这与模型用 `write` 写任何文件的风险同级。
  - `ppt_create` 以外部链接引用工作区内的图片；PowerPoint 默认阻止外部内容，需要用户手动启用。
- **读取的资源占用**（接受的已知风险）：读和更新时，插件在宿主进程内同步解压、用正则解析 XML。上限是单文件 50 MiB、单条目解压后 256 MiB、全包 512 MiB、10 万个条目，并拒绝 `DOCTYPE` / `ENTITY`（没有 XXE）。但一个构造过的文件仍可能让共享宿主（所有会话共用一个进程，决策 019）同步占用几百 MiB 内存和数秒 CPU，期间别的会话的流式输出会停顿。插件默认关闭、只处理用户工作区里的文件，本次接受；默认开启前要重新评估。

## 9 平台与加密机

- **Windows**：路径全部走 `node:path` 与 `ctx.fs`，没有 POSIX 专属写法；`ppt_create` 生成图片链接时把 `\` 换成 `/`。不起任何外部可执行文件，不用 koffi，不依赖 PowerShell。Windows CI 的打包冒烟覆盖一次开启状态下的创建与读回（本机跑不了，见决策 115）。
- **Linux**：本机真宿主冒烟、集成测试、打包冒烟都覆盖。
- **加密机（P1-13）**：插件的读写全在宿主进程（随包 `node.exe`）里经 `ctx.fs` 完成，不派生子进程，所以加密驱动按进程放行的问题与 DSH 自己的 `read` / `write` 完全相同。按 P1-13b 矩阵：
  - `.docx`、`.pptx` 被随包 node 读到的是密文，`word_read` / `ppt_read` / `word_update` 会报「不是可读的 zip」，不会把乱码交给模型；
  - `.xlsx` 读到的是明文，`excel_read` / `excel_update` 可用；
  - 新建文件走临时文件 + 硬链接，按矩阵是不加密的（与 DSH `write` 相同，决策 089 的推翻结论与决策 090 一致）；`excel_update` 覆盖一个加密的 `.xlsx` 后，文件可能变成不加密，这是 DSH 写法的既有行为。
  - P1-13 检查单要补一项「开启试点插件后，在加密机上跑一次 `word_create` / `word_read`、`excel_create` / `excel_read`」。

## 10 复审触发条件

- 插件升版（新版本另写一份记录）；
- DSH 升版：peer 兼容、`overrides` 的钉版本、`@deepseek-ai/schemastery` 的顶层解析；
- 白名单里的 `tools` 或 `classification.ts` 的分类变化；
- 想把 `defaultEnabled` 改成 `true`。
