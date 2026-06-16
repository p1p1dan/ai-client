# Electron 项目 native modules 打包要点

> 适用：本项目（jyw-ai-client）使用 electron-builder 打包，含 sqlite3 / node-pty / @parcel/watcher 等 native dependencies
> 来源：06-16 v0.3.0-v0.3.4 事故复盘

## 三种 native module 模式（修任何一处前必须分清当前是哪一种）

### 1. `node-pre-gyp` 模式 —— 代表：sqlite3

- `pnpm install` 时**只装 JS 入口与 `binding.gyp`**，`node_sqlite3.node` 不在这步下载
- 触发 native 二进制下载的是 `electron-builder install-app-deps`（由 `package.json` 的 `postinstall` 调用）：它内部走 `@electron/rebuild`，识别 sqlite3 的 node-pre-gyp 配置 → 从 prebuilt host 拉对应 Electron version + OS + arch 的预编译 `.node`；缺 prebuilt 才本地编译
- `electron-builder.yml` 的 `asarUnpack: - "node_modules/sqlite3/**"` 是把**已存在**的 .node 文件从 asar 里拷出来到 `app.asar.unpacked/`，**不是它负责下载**
- **关键推论**：CI 上跳过 `install-app-deps` = 发行包里 sqlite3 必然没有 `.node` binding → 用户启动 Electron main process 立即崩 `Could not locate the bindings file`

### 2. npm `optionalDependencies` 走 OS+arch 包模式 —— 代表：@parcel/watcher

- 包本身在 `optionalDependencies` 里声明多个 OS+arch 变种（`@parcel/watcher-win32-x64` / `-darwin-arm64` / 等），`pnpm install` 时只装当前平台那个
- 该平台变种是纯 prebuilt（无 source），不需要本地 build
- 然而 `@electron/rebuild` 默认仍试图 rebuild 它（忽略已有 prebuilt），需要 VS C++ toolchain → 在 windows-2025 image 上找不到 VS → 整个 `install-app-deps` 失败 → 顺带让 sqlite3 也下载不了

### 3. 自带 prebuilt 二进制 —— 代表：node-pty

- 包内 `prebuilds/win32-x64/` 直接含 `.node`，`pnpm install` 后就在位
- 不需要 install-app-deps 做任何额外工作
- 同样会被 `@electron/rebuild` 默认 rebuild 一遍（除非该包标注了 prebuild-install 兼容信号）

## `electron-builder.yml` 的几个配置容易混

- `npmRebuild: false` 控制的是 electron-builder **build/packaging 阶段**是否再 rebuild native，**不影响**外部 postinstall 的 install-app-deps 行为。这是两条独立的 rebuild 链
- `asarUnpack` 只决定"把哪些 native 文件从 asar 抽出来到 app.asar.unpacked/"，文件本身必须先存在；它不会"创造"二进制
- `extraResources` 拷贝顶级目录到发行包 resources/ 下，跟 native rebuild 完全无关

## 修改打包链路前必读检查表

修 `package.json` 的 `postinstall` / `.github/workflows/build.yml` 的 install dependencies step / `electron-builder.yml` 之前：

1. 我打算"跳过 / 替换 / 优化"的这个命令，原本做了哪几件事？逐项列出
2. 列表里哪些是"发行包正确性"必需的（如 sqlite3 binding 下载）？哪些是"本地 dev 体验"必需的（如 rebuild 让 pnpm dev 正常起 Electron）？哪些是"CI 不需要"的？
3. 我的改动只影响其中一种场景吗？如果同时跨多场景，是不是应该用 `if (process.env.CI)` 之类的环境分支而不是统一覆盖？
4. 验证方法：本地跑 `pnpm install && pnpm build:win` 后，检查 `dist/win-unpacked/resources/app.asar.unpacked/node_modules/sqlite3/build/Release/node_sqlite3.node` 是否存在 + 大小 > 0；启动产物 .exe，确认 main process 不崩

## 已知踩过的坑（不要再踩）

- **v0.3.2**：把 `postinstall` 改成 CI 上跳过 `electron-builder install-app-deps`，绕开 windows-2025 上 node-gyp 找不到 VS 的问题。结果发行包缺 `node_sqlite3.node`，用户启动崩。**教训**：跳过整条 install-app-deps 是错的；正确做法是修底层（pin runner image / 给 node-gyp 找 VS 工具），让 install-app-deps 完整跑通
- **v0.3.1**：尝试给 Install dependencies step 注入 `npm_config_msvs_version=2022` env。**无效**，因为 `@electron/rebuild` 内嵌的 node-gyp 9.x 在更早的 vswhere detection 阶段就 fail 了，根本没机会读这个 env
- **v0.3.4 (修复方案)**：`runs-on: windows-2022` 显式 pin 旧 runner image。简单、可靠、可回退；未来升级 node-gyp / electron-rebuild 后再考虑回到 windows-latest
