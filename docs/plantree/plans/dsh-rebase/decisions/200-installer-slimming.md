# 决策 200：安装包瘦身——app.asar 只带运行时要用的包，去掉原生模块副本与杂物，Windows 只留中英文语言包

日期：2026-10-18（北京时间）。**状态：用户 2026-10-18 批准五项（「这五项按建议做」），已实现，本地提交，未推送。** 分支 `claude/s6-feedback`。

编号说明：199 是 DSH 宿主瘦身（`claude/recursing-davinci-376b4a`），用户裁决先不改、主线不采用，编号仍算占用。登记在会话组共享笔记的 `decision-number-claims.md`。

## 1 起因与量法

- 用户问安装包和软件体量有没有优化空间，要求先按实际产物测量，再列出每项删减的功能和影响，由用户逐项拍板。
- 基线：Build run 39117960980（`f4fe890b`）的 `windows-unpacked`，解压后 1,034 MiB、10,142 个文件。安装包 `windows-installer` 约 283 MB。
- 「安装包减少」一栏是用 xz -9 压各组文件的估算，NSIS 是整体 LZMA 压缩，重复内容可能已被部分压掉，实际会略少。
- 单独的 Node 运行时（88 MiB）、Claude CLI（262 MiB）按用户要求不动。DSH 宿主（84 MiB）见决策 199，不动。

## 2 五项

| # | 内容 | 安装后 | 安装包（估） |
|---|---|---|---|
| 1 | Electron 语言包只留 zh-CN、zh-TW、en-US（原 55 个） | −43 MiB | 约 −7 MB |
| 2 | app.asar 的 node_modules 只留主进程运行时加载的包（原 8,539 个条目） | −62 MiB | 约 −7 MB |
| 3a | 去掉 `resources/node_modules` 整份副本（124 个文件） | −84 MiB | 约 −10 MB |
| 3b | 去掉 `@napi-rs/canvas`（pdf.js 纯 Node 环境用的画布） | −36 MiB | 约 −9 MB |
| 3c | 去掉原生模块的编译杂物、源码与 ARM64 文件 | −36 MiB | 约 −7 MB |

### 2.1 语言包

- `win.electronLanguages: [zh-CN, zh-TW, en-US]`，只作用于 Windows；Linux 由用户自己定。
- 这些 `.pak` 只是 Chromium 自带界面文字的翻译（右键菜单、文件选择框等），PiLab 自己的界面文字在 `shared/i18n.ts`。
- 多留 zh-TW：界面默认语言取 `navigator.language`（`normalizeLocale`：`zh*` 为中文）。只留 zh-CN 时，繁体中文系统上 Chromium 会退回 en-US，PiLab 就默认英文。zh-TW 只有 0.5 MiB。
- 影响：其他语言的系统上，Chromium 自带的少量文字显示英文。

### 2.2 app.asar 只带运行时要用的包

- 主进程、preload、渲染进程都由 electron-vite 打成 `out/` 下的成品（主进程 `externalizeDeps: false`）。运行时只从 node_modules 加载五个入口：
  - Main 构建的外部包 `node-pty`、`sqlite3`（`electron.vite.config.ts` 的 `runtimeNativePackages`）；
  - `createRequire` 加载的 `@parcel/watcher`、`@vscode/ripgrep`、`isbinaryfile`。
- 加上它们自己运行时要的：`bindings`、`file-uri-to-path`（sqlite3），`detect-libc`、`picomatch`、`is-glob`、`is-extglob`、`@parcel/watcher-<平台>`（@parcel/watcher）。
- 清单只在 `scripts/runtime-packages.mjs` 写一处。
- **写法**：electron-builder 拷依赖时，`files` 里只有排除规则对 node_modules 起作用，包含规则会被忽略，所以写成「排除清单以外的所有包」：顶层一条，每个 scope 一条，带 extglob。
- **踩过的坑**：
  - 起初在 `win.files` 里放排除规则，electron-builder 26 对应用目录就丢掉了顶层的 `files`，整个仓库（docs、src）都进了 app.asar。现在 `files` 只写在顶层，测试禁止平台级 `files`。
  - 原来那些 monaco、mermaid、lucide、shiki、pdfjs 的单独排除已经用不上，删了。

### 2.3 原生模块

- **3a**：`extraResources` 里那组 node-pty、sqlite3、@parcel/watcher、ripgrep、ws 等拷贝来自 4 月的一次快照提交。
  - 实测没被加载：启动打包版，进程里 sqlite3 和 watcher 的 `.node` 都在 `app.asar.unpacked`。
  - 按 Node 的查找顺序，app.asar 里有这些包时轮不到 `resources/node_modules`；DSH 宿主和 Claude 宿主也不引用这些包。
  - 那份里大部分是调试符号（.pdb）和编译中间文件。
- **3b**：`@napi-rs/canvas` 是 pdfjs-dist 的可选依赖，只在 pdf.js 的 `NodeCanvasFactory` 里用。PiLab 的 PDF 预览在渲染进程，用浏览器的 canvas。它随第 2 项一起出局（不在运行时清单里）。
- **3c**：排除 MSVC 的 .iobj、.ipdb、.obj、.tlog、.lib、.exp 等，以及：
  - node-pty 的 `build/Release/obj`、`build/deps`；
  - Windows ARM64 的预编译与 conpty；
  - sqlite3 的 `deps`、`src`（源码压缩包 3 MiB）；
  - `@parcel/watcher` 自己的 `build`、`src`（加载的是平台包 `@parcel/watcher-win32-x64`）。
- **保留**：
  - node-pty 的 `prebuilds/win32-x64` 与 `third_party/conpty`（x64），与 `build/Release` 有重复但很小，不值得冒险；
  - macOS 的预编译（0.2 MiB），免得影响 mac 构建。

## 3 防回归

- **单测** `scripts/__tests__/runtime-packages.test.mjs`：
  - YAML 的排除规则与 `runtimeFilePatterns()` 一致；没有 node_modules 包含规则，没有平台级 `files`；
  - 没有拷到 `node_modules` 的 `extraResources`；入口都是生产依赖；
  - `runtimeNativePackages` 和 `src/main` 里每个 `createRequire(...)('x')` 都在清单里；
  - 语言包三项；load check 用的可执行文件名与 YAML 一致。
- **打包后**（`verify-packaged-app.mjs`，CI 的 Windows、Linux、macOS 作业都跑）：
  - app.asar 里每个包都在清单里，清单里每个包都在；
  - `out/main`、`out/preload` 留给运行时的裸引用都在清单里；
  - 用打包出的可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行 `scripts/runtime-load-probe.cjs`，按主进程的查找路径加载五个入口：node-pty 加载原生模块，ripgrep 检查 `app.asar.unpacked` 里的 rg。macOS 跳过这一步。

## 4 验证

- 旧包（run 39117960980）上跑新检查：只报 350 个「主进程从不加载」的包；运行时引用扫描、五个入口的加载都通过。
- 本机打目录包（`electron-builder --win --dir`，跳过 afterPack，所以不含两个宿主和 Node 运行时）：
  - app.asar 105 → 41 MiB（只剩 `out/` 与 7 个小包），`app.asar.unpacked` 84 → 13 MiB；
  - `resources/node_modules` 没有了，`locales` 只剩三个；
  - 新检查通过，五个入口在打包版里加载成功；
  - 启动打包版，sqlite3 与 watcher 从 `app.asar.unpacked` 加载，日志无找不到模块的错误。缺 `app-update.yml` 是因为只打了目录包（electron-builder 只在有 nsis 目标时写它），与本决策无关。
- 单测：`runtime-packages`、`packaging-config` 等 4 个文件 92 条通过。

- **CI**（用户同意后推送 `1ab51ffe`，Build run 39124636224）：
  - Windows、Linux 作业通过，打包后检查与五个入口的加载在两个平台都通过；
  - Windows 回归套件 10 组全过，DSH 冒烟 44 项通过；
  - `windows-installer` 产物 283.4 → 234.7 MB（−48.6 MB，比估算多，安装包里重复内容并没有被压掉多少）；`windows-unpacked` 压缩包 403.5 → 331.1 MB。

## 5 还要做的

- 装上新包后点一遍：终端、文件监听、搜索、git、PDF 预览、自动更新检查。
- **加密机**：开一次终端、改一次文件看监听；第 3a 项删掉的是兜底副本，要在那里确认一次。
