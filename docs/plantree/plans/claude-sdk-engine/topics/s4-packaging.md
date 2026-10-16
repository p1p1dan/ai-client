# S-4 打包（设计）

Role: topic（S-4 方案，2026-10-16）。上位：[README](../README.md) §4 S-4，§7.4 #11、#12，§8.2 #27、#31。工作方式同 [S-2](s2-permission-modes.md)、[S-3](s3-project-config.md)：一般问题按推荐方案自行决定，自主决定列在 §1.2 供审阅。

## 0 范围

| 项 | 来源 | 本任务做什么 |
|---|---|---|
| 宿主构建 | §4 S-4 | 照 DSH 宿主的做法单独产出 `out-claude-sdk-host/`：esbuild 打包的 `host.js`、SDK 包与目标平台的 CLI 包、清单、许可证清单 |
| 随包 | §4 S-4、#12 | afterPack 把产物拷进 `resources/claude-sdk-host`；electron-builder 配置与根依赖里仍不出现 SDK 包（两条门禁照旧） |
| 一个 CLI 路径 | #31 | Main 定下 CLI 的路径，可用性检查只查它，并交给宿主作 `pathToClaudeCodeExecutable` |
| 开发覆盖 | #27 | `AICLIENT_CLAUDE_SDK_CLI`、`_RG_DIR`、`_SETTING_SOURCES` 只在未打包时读 |
| 体积门禁 | §4 S-4 | 产物有上限，构建与打包后核验都查；安装后增量不超过 0.6 GB |
| 自动更新 | §4 S-4 | `DISABLE_AUTOUPDATER` 已在 S-0/S-1 钉在 CLI 环境与 flag 层，本任务只核对 |
| CI | #11 | 装宿主的依赖（不下 CLI）、跑宿主 tsc；打包作业构建、核验、冒烟 |
| 冒烟 | §4 S-4 | 打包后从安装目录（`win-unpacked`）用随包的 node 拉起宿主，对假网关跑一个回合 |

不做：macOS（决策 090）；在加密机上核对落盘的 `claude.exe`（S-6）；安装包的签名与发布（发版前问用户）。

## 1 决定

### 1.1 用户裁决

无新增。沿用：只做 Linux 与 Windows（决策 090）；推送与发版前先问用户；只用本机假网关。

### 1.2 自主决定（待审阅）

| # | 决定 | 理由 |
|---|---|---|
| B-1 | **单独的产物目录**：`scripts/build-claude-sdk-host.mjs` 产出 `out-claude-sdk-host/`，afterPack 拷进 `resources/claude-sdk-host`（不经 extraResources，不进 app.asar） | 与 DSH 宿主同一做法（#12）：extraResources 会被 electron-builder 塞进 node_modules 的排除；根依赖不碰 SDK，两条门禁（`packaging-config.test.mjs`、`t31PiOnlyAbsence.test.ts`）不用改 |
| B-2 | **`host.js` 只把 SDK 留在外面**：esbuild 把 `host.ts` 与它用到的 `src/claude-sdk-host`、`src/shared`、`src/dsh-host/bridge` 源码打进一个 ESM 文件，运行时只 import `@anthropic-ai/claude-agent-sdk` 与 Node 内置模块；构建读 metafile，多出任何别的输入或外部包就失败 | 与 DSH 宿主同一检查；实测 23 个输入、约 147 KB |
| B-3 | **`node_modules` 只留 SDK 与目标平台的 CLI**：`npm ci --ignore-scripts --omit=peer`，再按白名单修剪：顶层只留 SDK 与目标平台的 CLI 包（Linux 只留 glibc 版），删 `.d.ts`、`.map`、说明文档；许可证与包的 `license` 字段指向的文件（SDK 的是 `README.md`）留着。锁文件里的 SDK 一旦有了自己的 `dependencies`，或 SDK 入口（`import` 它时加载的文件）import 了任何包（构建时用 esbuild 解析它的导入图），构建失败，等人重新看这一条 | SDK 的主入口 `sdk.mjs` 只 import Node 内置模块（实测），peer 依赖（Anthropic SDK、MCP SDK、zod）及其依赖运行时用不到；`--omit=peer` 只去掉带 peer 标记的包，它们自己的依赖照装（§4），所以要白名单；AppImage 面向 glibc 发行版 |
| B-4 | **Main 定一个 CLI 路径**（#31）：打包后是 `resources/claude-sdk-host/node_modules/@anthropic-ai/claude-agent-sdk-<平台>-<架构>/claude[.exe]`；未打包时是开发覆盖，或宿主 `node_modules` 里第一个存在的平台包。可用性检查只查这一个；启动宿主时经 `AICLIENT_CLAUDE_SDK_CLI` 交给宿主，宿主作 `pathToClaudeCodeExecutable` 交给 SDK | 不再依赖 SDK 自己按架构找平台包的办法（宿主 node 的架构、安装布局都可能与 Main 判断的不同）；查的与用的是同一个文件 |
| B-5 | **开发覆盖只在未打包时读**（#27）：打包后用随包的 CLI、CLI 自带的 rg、设置来源固定 `project,local` | 与 `AICLIENT_DSH_NODE`、`AICLIENT_DSH_HOME` 同一规矩（`resolveDshHostLayout`）：用户环境里的变量改不了安装包运行的程序与读取范围 |
| B-6 | **宿主对 CLI 路径照旧给 `executable: node`，不改代码**，只更正注释 | 初稿想只对 `.js` 的 CLI 给；实测 SDK 0.3.300 按扩展名判断（`.js`/`.mjs`/`.ts`/`.tsx`/`.jsx` 才经 `executable` 启动），原生二进制直接启动，原代码无害（§4） |
| B-7 | **体积门禁**：产物上限 350 MiB、500 个文件，目标 280 MiB（超目标只报告）；构建时与打包后核验时都查 | 实测 Windows 产物 262 MiB、19 个文件；计划的门槛是安装后增量 ≤ 0.6 GB。上限压在一份 CLI 的量级上，CLI 多带一份（约 +250 MiB）或 peer 依赖的依赖回来（2,786 个文件）都会失败 |
| B-8 | **清单** `claude-sdk-host-manifest.json`：目标平台、SDK 与 CLI 的版本、CLI 的相对路径与 sha256、文件数与字节数、锁文件 sha256、git 提交、构建时间；afterPack 拒绝目标平台不符的产物 | 与 DSH 宿主同一做法；安装包里能查到带的是哪一份 CLI |
| B-9 | **打包后冒烟**：随包的 node 跑 `src/claude-sdk-host/tools/host-probe.ts`（`text tools` 两个场景），宿主入口指向随包的 `host.js`、CLI 指向随包的二进制，对本机假网关（`--plan claude-sdk`）；先把宿主目录与随包的 node 拷到仓库外、带空格的 `<临时目录>/PiLab Ai/resources` 再跑（`--in-place` 不拷）；探针给宿主的环境与 Main 给的同一份白名单。并入 `verify-packaged-app.mjs`，可用 `--skip-claude-sdk-smoke` 跳过 | 计划要求"从安装目录拉起宿主 → 假网关一个回合"；探针已能驱动打包后的入口（`PROBE_HOST_ENTRY`）且自带断言。在仓库里跑时，缺的模块会从仓库的 `node_modules` 找到（审查实测 `zod` 就在那里），拷出去才验得出；安装目录本身也带空格 |
| B-10 | **CI**（#11）：检查作业在 `src/claude-sdk-host` 里 `npm ci --ignore-scripts --omit=optional`（只要类型，不下 CLI），加 `typecheck:claude-sdk-host` 门禁（门禁由 5 个变 6 个）；三个打包作业（Windows、Linux 与只在手动触发时跑的 macOS）构建产物、核验、冒烟并上传清单与冒烟报告 | 宿主依赖 DSH bridge 与 `src/shared` 的类型，原来 main 上改了 CI 发现不了；宿主的单测也要装好的 SDK 才能解析 |
| B-11 | Windows 的 afterPack 对 `resources/claude-sdk-host` 下的 `.js` 也做 TSD 改写；`claude.exe` 是二进制，落盘后是否被加密留给 S-6 在加密机上核对 | 与 DSH 宿主同一做法 |
| B-12 | **第三方声明**：`THIRD_PARTY_NOTICES.md` 加"Claude Agent SDK host"一节，原样引 SDK 与 CLI 包自带的声明（© Anthropic PBC，使用受其法律协议约束）；`verify-packaged-app.mjs` 要求安装包里的声明带这一句 | 与 DSH 宿主同一做法（它要求 DeepSeek 的 MIT 声明）；SDK 不是开源许可，声明原文就在两个包的 `LICENSE.md` 里 |
| B-13 | **CI 超时**：Windows 30 → 40、Linux 25 → 35、macOS 35 → 45 分钟 | 多一次 `npm ci`、约 260 MiB 要按 `compression: maximum` 压缩、多一个冒烟；按工作流里的规矩，等第一次全绿的运行再重算 |
| B-14 | **不带 linux-arm64**（README §3 原写了它） | 应用本身只出 x64（electron-builder 的 Windows 与 Linux 目标都只有 x64），带了也装不上 |
| B-15 | DSH bridge 的门禁工作流（`dsh-bridge-gate.yml`）也装 SDK 宿主的类型并跑它的 tsc | 宿主实现 bridge 的类型；那个工作流只在 `feat/dsh-*` 分支上跑，成本约 20 秒 |

## 2 契约

- 安装包布局：`resources/claude-sdk-host/{host.js, package.json, claude-sdk-host-manifest.json, THIRD_PARTY_LICENSES.json, node_modules/@anthropic-ai/claude-agent-sdk/, node_modules/@anthropic-ai/claude-agent-sdk-<平台>-<架构>/}`；宿主跑在随包的 `resources/node-runtime/node[.exe]` 上（与 DSH 宿主共用）。
- Main → 宿主：启动环境里总有 `AICLIENT_CLAUDE_SDK_CLI`（B-4 定下的路径）；打包后不读 `AICLIENT_CLAUDE_SDK_CLI`、`_RG_DIR`、`_SETTING_SOURCES` 三个开发覆盖。
- 宿主 → SDK：`pathToClaudeCodeExecutable` 为 Main 给的路径；宿主照旧同时给 `executable`（宿主自己的 node），SDK 只对 `.js`/`.mjs`/`.ts`/`.tsx`/`.jsx` 用它（B-6）。

## 3 验证（先定断言，再改代码）

### 3.1 单测

1. 构建库：metafile 检查（不许的输入、多出的外部包都报错）；修剪（非目标平台的 CLI 包、Linux 的 musl 包、`.d.ts`、`.map` 删掉，许可证与 SDK 本体留下）；各平台的 CLI 相对路径；体积判定；清单字段；必需文件缺了报错。
2. afterPack：没有产物、产物缺文件、目标平台不符都报错；正常时拷到 `resources/claude-sdk-host`。
3. Main：打包后入口与 CLI 在 `resources` 下、三个开发覆盖不起作用；未打包时覆盖生效；可用性检查只查 B-4 的那一个 CLI；启动环境带 `AICLIENT_CLAUDE_SDK_CLI`。
4. 宿主：代码不改（B-6）。产物里 `host.js` 只 import SDK 与 Node 内置模块（metafile 检查），SDK 入口只 import Node 内置模块（esbuild 检查，B-3）。

### 3.2 构建与打包（只用本机假网关）

| 项 | 断言 |
|---|---|
| 构建产物 | `build-claude-sdk-host.mjs` 通过自检；记下字节数、文件数、CLI 版本 |
| 打包 | `electron-builder --win --dir` 后 `resources/claude-sdk-host` 存在、清单目标为 `win32-x64`、体积在上限内 |
| 冒烟 | `verify-packaged-app.mjs` 的 SDK 冒烟：随包 node + 随包 `host.js` + 随包 CLI，对假网关跑 `text tools` 全过 |
| 原有 | 三套 tsc、全量 vitest 与基线一致、探针流程场景照常 |
| 体积 | 报告产物大小与 `win-unpacked` 的增量；安装后增量 ≤ 0.6 GB |

## 4 实测（2026-10-16，Windows，只用本机假网关）

- SDK 0.3.300 的主入口 `sdk.mjs` 只 import Node 内置模块；`core.mjs`（宿主不加载）import zod 与 MCP SDK。`package.json` 的 `exports["."]` 指向 `sdk.mjs`。
- `npm ci --omit=peer` 只去掉带 peer 标记的三个包（Anthropic SDK、MCP SDK、zod），它们自己的依赖（express、ajv 等 96 个目录、2,786 个文件）没有标记，照装。
- SDK 与 CLI 包的 `license` 字段是 `SEE LICENSE IN README.md` / `LICENSE.md`，声明原文：© Anthropic PBC，使用受其法律协议约束。
- SDK 按扩展名决定是否经 `executable` 启动 CLI（`.js`/`.mjs`/`.ts`/`.tsx`/`.jsx`），原生二进制直接 `spawn`。
- 产物（win32-x64）：262.2 MiB、19 个文件；CLI 0.3.300 一个文件 258.3 MiB；`host.js` 约 147 KB（23 个输入）；构建约 10 秒（`npm ci` 约 8 秒）。
- 打包（`electron-builder --win --x64 --dir`）：`win-unpacked` 共 1,017.8 MiB，其中 `resources/claude-sdk-host` 262.2 MiB（即安装后的增量，低于 0.6 GB 门槛），`dsh-host` 85.2 MiB、`node-runtime` 88.2 MiB、`app.asar` 105.0 MiB。把产物按 LZMA 最高压缩是 80.1 MiB，安装包约增大这么多（估算，未出安装包）。afterPack 对产物里 8 个 `.js`/`.mjs` 做了 TSD 改写。
- 本机打目录包时，electron-builder 解压 `winCodeSign`（给 exe 改资源用）因包里的 macOS 符号链接失败，与本任务无关；加 `-c.win.signAndEditExecutable=false` 跳过那一步即可（CI 的 Windows 机器没有这个问题）。
- `verify-packaged-app.mjs` 对 `win-unpacked`：两个宿主的结构、体积、声明都过；DSH 冒烟与 SDK 冒烟都过（SDK：随包 node + 随包 `host.js` + 随包 `claude.exe`，8 条断言）；SDK 冒烟从仓库外带空格的路径再跑一遍也过。
- 安装包强制登录（`resolveSkipAuthGate` 在打包后恒为假），本机没有测试用的登录凭据，所以没在打包后的程序界面里跑回合；Main 在打包时组出的启动参数由单测覆盖（下一节）。

## 5 实现记录

### 5.1 实现（2026-10-16）

- `scripts/build-claude-sdk-host.mjs` 与 `scripts/claude-sdk-host-build-lib.mjs`：暂存、esbuild 打包与 metafile 检查、`npm ci --omit=peer`、SDK 入口检查、白名单修剪、许可证清单、清单、自检（必需文件、只两个包、CLI 是目标平台的二进制且可执行、体积）。`package.json` 加 `build:claude-sdk-host`（并入 `dist:prereq`）与 `smoke:claude-sdk-host`；`.gitignore`、`biome.json` 排除产物目录；`packaging-budget.mjs` 加上限。
- `scripts/afterPack.mjs`：`copyClaudeSdkHost`，拷前拷后都自检；Windows 上 TSD 改写也覆盖它。
- `scripts/packaged-claude-sdk-host-smoke.mjs`（新）与 `verify-packaged-app.mjs`：产物自检、冒烟（`--skip-claude-sdk-smoke`、`--claude-sdk-report-file`）、声明里要有 Anthropic 的那句。
- Main（`claudeSdkEngine.ts`、`claudeSdkHostAvailability.ts`）：`claudeSdkHostLayout`、`claudeSdkCliPath`、`claudeSdkHostDevSettings`；可用性与启动用同一份布局与同一个 CLI；CLI 覆盖按 Main 的工作目录解析成绝对路径。
- 宿主：只改注释与 `package.json` 的描述；`host-probe.ts` 给宿主的环境改成与 Main 同一份白名单。
- CI：`build.yml` 检查作业装宿主的类型、加第 3 道门禁（共 6 道）；三个打包作业构建、核验、冒烟、上传清单与报告，超时调高。`dsh-bridge-gate.yml` 也跑宿主的 tsc。`THIRD_PARTY_NOTICES.md` 加一节。
- 验证：构建库 16 条、冒烟脚本 4 条、打包配置 60 条（新增 SDK 宿主的 afterPack、门禁、打包作业断言）、Main 29 条（新增打包与未打包两种启动参数）单测；变异检查：去掉打包时忽略覆盖、去掉交给宿主的 CLI、布局不分打包与否，各自让启动参数的用例失败。三套 tsc；全量 vitest 的失败文件与环境基线一致；本机打目录包后 `verify-packaged-app` 全过（§4）。

### 5.2 审查（2026-10-16）

三个维度（构建与打包、Main 与宿主运行时、CI 与测试与文档），共 14 条发现（两条被两个维度都报了），每条由独立复核员尝试推翻。确认的 8 条都已修：

1. Main 在打包时组出的启动参数没有任何测试：加了打包与未打包两种启动的单测（mock 掉传输层，看它收到的命令、参数与环境）。
2. 冒烟只在仓库里的 `dist/*-unpacked` 跑，缺的模块会从仓库的 `node_modules` 解析到：冒烟改为先拷到仓库外、带空格的路径（B-9）；另在构建时检查 SDK 入口只 import Node 内置模块（B-3）。
3. 相对路径的 CLI 覆盖，Main 查的与 SDK 起的不是同一个文件：改为按 Main 的工作目录解析成绝对路径（只影响开发）。
4. `biome.json` 没排除产物目录，本机构建后 `pnpm lint` 失败：已排除。
5. 在 Windows 上为 Linux 做静态预演时，可执行位检查必然失败：构建机是 Windows 时跳过这一项（目标平台的打包作业照查）。
6. 冒烟里探针的超时与外层相同，挂住时报告丢失、进程留下：探针 8 分钟，外层 10 分钟。
7. 设计文档 §2、§3 与 B-6 矛盾；README 的 S-4 行、§3、§7.2 与实际不符、缺 §11：已改。

被推翻的：CLI 能否运行只查存在（裁决 9 与 S-1 定的退回条件只含缺失与宿主起不来；加密机上 `claude.exe` 是否被加密留给 S-6）；`AICLIENT_GIT_BASH_PATH` 打包后仍可用（`PATH` 本来就决定用哪个 Git Bash）；探针给宿主的环境与 Main 不同（在 Linux 上未必出错，但改成同一份白名单成本低，已改）；#11 只在发版时查（已顺手加到 bridge 门禁工作流，B-15）。

