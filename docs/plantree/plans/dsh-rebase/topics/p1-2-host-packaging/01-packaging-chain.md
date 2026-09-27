# P1-2 分片 01 · 现有打包链路与 DSH 接入点

Role: detail shard。上位：[P1-2 方案](../p1-2-host-packaging.md)。回答调研问题 1：两个子包与随包 node 怎么进安装包、各平台差异、CI 步骤、DSH 宿主要在哪几处接入。行号指 worktree HEAD `5e1385e7`。

## 1. 现在安装包里的几件载荷

| 载荷 | 来源与构建 | 进包方式 | 包内位置 | 运行载体 |
|---|---|---|---|---|
| 应用本体 | `out/**`（electron-vite，`pnpm build`）+ 根 `node_modules/**`（pnpm，`node-linker=hoisted`） | `files` 清单进 `app.asar`（`electron-builder.yml:9-68`）；`asarUnpack` 解出 ripgrep、sqlite3、@parcel/watcher、node-pty（`:69-74`）；`npmRebuild: false`（`:75`），根 `postinstall` 跑 `electron-builder install-app-deps` 按 Electron ABI 重编 | `resources/app.asar`、`app.asar.unpacked/` | Electron |
| 根依赖里的原生件 | node-pty 1.1.0、sqlite3、@parcel/watcher、ws、picomatch、ripgrep、isbinaryfile 等 | `extraResources` 按过滤表拷（`electron-builder.yml:90-152`） | `resources/node_modules/…` | Electron Main |
| Pi worker（agent-host） | `src/agent-host` 与 `src/runtime` 两个独立 npm 子包。`scripts/build-agent-host.mjs`：esbuild 把 `worker.ts`（连同 `src/runtime`）打成 `worker.js`，target node22，带 createRequire banner（`:57-67`）；再按 `shouldCopy` 走查拷贝 `src/agent-host/node_modules`，平台取构建机的 `process.platform/arch`（`:34-35,91-112`）；写权限策略；`verifyArtifact`（`agent-host-build-lib.mjs:223-279`） | afterPack `copyAgentHost` 用 `fs.cpSync` 整目录拷（`scripts/afterPack.mjs:43-63`）。不用 extraResources，因为 electron-builder 会在那条路径上注入 node_modules 排除（`:36-42`）；静态测试锁住这一点（`scripts/__tests__/packaging-config.test.mjs:160-168`） | `resources/agent-host/`（85 MiB，Linux，worktree 09-25 构建，`du --apparent-size`） | Windows 打包态用随包 node.exe（`src/main/services/agent-host/PiWorkerProcess.ts:79-93`），其余平台与开发态用 utilityProcess（`:94-104`） |
| 随包 Node | 官方包，钉 24.18.0 与 sha256（`scripts/node-runtime-pin.mjs:12,28-64`），`scripts/fetch-node-runtime.mjs --platform <key>` 取到 `out-node-runtime/` | afterPack `copyNodeRuntime`：按 `context.electronPlatformName` 查 pin，拷二进制与 `PIN.json`，非 Windows 断言可执行位（`afterPack.mjs:78-125`） | `resources/node-runtime/node(.exe)` | 被 worker（Windows）与 pi TUI 使用；pi TUI 在三平台打包态都用它（`src/main/services/terminal/PiTuiPty.ts:157-160`） |

`src/runtime` 没有自己的包内目录，它的代码被 esbuild 打进 `worker.js`；它的 npm 依赖在构建时从 `src/runtime/node_modules` 解析进 bundle。

## 2. 平台差异

| | Windows | Linux | macOS |
|---|---|---|---|
| 目标 | NSIS x64，可执行名 `PiLabAi`（`electron-builder.yml:189-212`） | AppImage x64（`:214-235`） | dmg + zip（`:159-187`）；hardenedRuntime，entitlements 含 allow-jit、allow-unsigned-executable-memory、disable-library-validation，且 `entitlementsInherit` 相同（`build/entitlements.mac.plist`） |
| 资源目录 | `resources/` | `resources/`（运行时在 AppImage 的只读挂载点里） | `<App>.app/Contents/Resources/`（`afterPack.mjs:128-135`） |
| worker 载体 | 随包 node.exe | utilityProcess | utilityProcess |
| TSD 修复 | 仅当构建机是 Windows：`app.asar.unpacked` 与 `resources/agent-host` 下的 `.js/.cjs/.mjs` 经 PowerShell 重写（`afterPack.mjs:23-33,144-178`） | 无 | 无 |
| CI | `windows-2022`，tag 与 dispatch 都跑 | `ubuntu-latest`，tag 与 dispatch 都跑；verify 要 `xvfb-run` | `macos-14`（arm64），**只在 workflow_dispatch 时跑**，未签名；2026-09-23 起不在发布链（`build.yml:420-432`） |
| 交叉打包 | 不做。本地打包只允许本机平台（`scripts/assert-build-target.mjs:1-44`），跨平台一律走 CI 原生 runner | 同左 | 同左；`build:mac` 只校验平台不校验架构 |

## 3. CI（`.github/workflows/build.yml`）

- **gate**（`:26-106`）：pnpm install；`src/agent-host` 跑 `npm ci --omit=optional`（`:66-68`）；`src/runtime` 跑 `npm ci --omit=optional --ignore-scripts`（`:74-76`）；typecheck ×3、lint、test、runtime 离线冒烟 ×2、release 元数据。**没有任何 DSH 步骤**，`src/dsh-host` 的类型检查只在开发机上跑。
- **build-app**（`:108-149`）：`pnpm build`，上传 `out/`。
- **build-windows**（`:151-309`）：下载 `out/` → pnpm install → 两个子包 `npm ci --omit=dev --omit=optional`（`:218-224`）→ `build-agent-host.mjs`（`:235-236`）→ 缓存并取随包 node（`:246-253`）→ `electron-builder --win --x64`（`:259-260`）→ `verify-packaged-app.mjs --app-dir dist/win-unpacked`（`:268-269`）→ 上传冒烟报告、安装包、（dispatch 时）win-unpacked。
- **build-linux**（`:311-418`）：同上，linux-x64，verify 在 `xvfb-run` 下跑（`:397-400`）。
- **build-macos**（`:420-565`）：同上，按 runner 架构选 pin（`:490-501`），未签名构建（`:529-533`），verify（`:535-537`）。
- 静态测试 `scripts/__tests__/packaging-config.test.mjs` 锁着这些接线：agent-host 的 `npm ci` 参数（`:348-354`）、每个 job 的 setup-node 都是 `'24'`（`:356-371`）、不许加 npm 缓存（`:337-346`）、随包 node 的缓存键（`:269-282`）等。改 build.yml 必须同步改它。
- 另有 `.github/workflows/dsh-p0-windows.yml`：在 ubuntu-24.04 上用 Node 24.18.0 构建 P0-4 工具包（`:25-49`），再在 windows-2022 上以管理员、标准用户两路跑。

## 4. `verify-packaged-app.mjs` 现在查什么

- `app.asar` 存在；`licenses/LICENSE` 与 `THIRD_PARTY_NOTICES.md` 存在且含指定署名（`:73-93`）。
- `resources/agent-host` 过 `verifyArtifact`；`worker.js` 不能带 TSD 头；总体积不超 256 MiB（`:160-197`，上限在 `scripts/packaging-budget.mjs:10`）。
- 随包 node `--version` 等于 pin（`:49-71,199`）。
- 冒烟：用 Electron 起 `scripts/packaged-worker-smoke.cjs`，本地桩模型让真实会话跑 read 与 bash 两个工具，再 dispose、确认退出码 0 且进程消失（`packaged-worker-smoke.cjs:31-65,180-249`）。Windows 走 node.exe，其余走 utilityProcess（`:116-138`）。

## 5. DSH 宿主要接入的 8 处

1. **新构建脚本** `scripts/build-dsh-host.mjs`（与构建库、单测），产物目录 `out-dsh-host/`；加进根 `package.json` 的 `dist:prereq`（`package.json:28`）。
2. **`scripts/afterPack.mjs`**：新增 `copyDshHost`，照 `copyAgentHost` 整目录拷到 `resources/dsh-host/`，并核对产物清单里的平台 / 架构与 `context.electronPlatformName` / `context.arch` 一致；Windows TSD 修复目标加上 `resources/dsh-host`。
3. **`scripts/verify-packaged-app.mjs` 与 `packaging-budget.mjs`**：DSH 产物结构校验、体积与文件数上限、DSH 冒烟（纯 node，不需要 Electron）。
4. **`build.yml`**：gate 加 `src/dsh-host` 的安装与类型检查；三个打包 job 在 electron-builder 之前加「构建 DSH 宿主产物」；上传产物清单。
5. **Main 打包态启动**（P1-1 实现）：入口 `resources/dsh-host/host.js`，载体 `resources/node-runtime/node(.exe)`，缺失即失败。
6. **许可**：`THIRD_PARTY_NOTICES.md` 加 DSH 段，产物里带许可清单，verify 的必需署名加上 DeepSeek（见[分片 04](04-licenses.md)）。
7. **忽略规则**：`.gitignore` 加 `out-dsh-host/`（现有 `out-agent-host/` 在 `:6`）；`biome.json` 的 `files.includes` 加 `!**/out-dsh-host`（`:55-56` 旁）。
8. **静态测试**：`packaging-config.test.mjs` 跟着改（dsh-host 不进 extraResources、依赖精确版本、CI 步骤顺序、DSH 安装不许 `--omit=optional`）。

## 6. 一个接入时容易踩的坑：模块解析会越出宿主目录

DSH 按 `createRequire(anchor).resolve.paths(name)` 找包（`dsh-app-boot/lib/index.js:881-887`），Node 会沿父目录逐级找 `node_modules`。宿主放在 `resources/dsh-host/` 时，上一级正好有 extraResources 拷进去的 `resources/node_modules/`（node-pty 1.1.0、ws、picomatch 等，`electron-builder.yml:90-152`）。只要裁剪误删了宿主自己的某个依赖，Node 就会静默用上应用那一份，版本不同、有的还是按 Electron ABI 编的。P0-1 已经见过同类现象（`bufferutil` 向上探到了主检出，[P0-1 证据](../../evidence/p0-1-host-probe-2026-09-25.md)风险第 10 条）。换个目录名不能解决（父目录链里总有 `resources/`），所以要靠冒烟时记录全部已加载模块的路径，凡是落在宿主目录之外的（`node:` 内置除外）一律判失败。
