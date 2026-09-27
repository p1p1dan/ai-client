# P1-2 DSH 宿主转正与打包：方案

Role: topic。建立：2026-09-26。上位：[roadmap P1-2](../roadmap.md)；依据[决策 003](../decisions/003-p0-closeout-enter-p1.md)（钉 `0.1.7-rc.2`、锁文件入库）与[决策 004](../decisions/004-branch-isolated-dsh-only.md)（分支内整体替换）。状态：只读调研已完成（worktree HEAD `5e1385e7`，未改代码），**方案待拍板**（§4 的 D1～D8）。

明细分片：[01 打包链路](p1-2-host-packaging/01-packaging-chain.md) · [02 裁剪、原生模块与体积](p1-2-host-packaging/02-natives-and-size.md) · [03 入口、锁文件与文件判定](p1-2-host-packaging/03-entry-lock-files.md) · [04 许可](p1-2-host-packaging/04-licenses.md) · [05 改动清单与验证](p1-2-host-packaging/05-changes-and-verification.md)。

约定：行号指上述 HEAD；DSH 包（`dsh-app-boot` 等）的行号指 `src/dsh-host/node_modules` 里装好的 `0.1.7-rc.2`。「实测」是本次在开发机上量的，「推断」是按实测或证据换算、没上机的。

## 1. 结论先行

1. **能做，没有硬阻塞，照 agent-host 的样子加第三件载荷即可。** 安装包里已有「构建脚本出 `out-*` → afterPack 整目录拷到 `resources/` → verify 用随包 node 冒烟」这条链（`scripts/afterPack.mjs:43-125`、`scripts/verify-packaged-app.mjs:138-218`）。DSH 宿主新增 `out-dsh-host/` → `resources/dsh-host/`，由已随包的 `node-runtime/node(.exe)` 拉起。P0-4 工具包已在 Windows CI 上证明，「`npm ci --ignore-scripts` + 裁剪 + 校验」得到的树能跑全套工具。
2. **三处不改就进不了包或不安全：**
   - bridge 行靠 URL 动态 import 仓库里的 TS（`src/dsh-host/bundle/lib/bridge.js:40-43`、`shared-bridge.js:162-163`），安装包里没有这些源码；`node_modules` 下的 `.ts` 也不许类型剥离（实测 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。→ 用 esbuild 把 bridge 打成 JS。
   - 产品 bundle 里的 `aiclient-probe` 会把所有审批自动答成 allowed-once（`bundle/lib/index.js:21-22`），只要没设 bridge 环境变量就是启用的（`bundle/cordis.patch.yml:109-111`）。→ 不能进安装包。
   - Main 现在只在未打包时拉 DSH（`src/main/services/agent-host/devDshEngine.ts:51-56`），找不到随包 node 会退到 PATH 上的 `node`（`:79`）。→ 打包态入口与载体要和 P1-1 对齐，缺失即失败（ARD D11 第 2 条）。
3. **体积**：推荐的 B 档裁剪后，宿主目录解压约 96～106 MiB、约 1.02 万个文件（Linux 实测 98.5 MiB；Windows、macOS 推断），压缩后约 17～26 MB（Linux 实测 xz 16.7 MB、gzip 25.6 MB）。与 agent-host（85 MiB）并存期间，Windows 安装包从约 180～188 MB 涨到约 200～215 MB（推断）；P1-12 若能整体删掉 `resources/agent-host`，解压净增约 15 MiB（推断）。建议硬上限：每平台 128 MiB、1.2 万个文件。
4. **原生模块**全部是 npm 预编译包，按平台的可选依赖安装；CI 本来就在各平台原生 runner 上打包，不做交叉。要手工处理的只有：node-pty 与 pnpm 把全平台塞在一个包里；npm 10 会多装 sharp 的 wasm32 与 musl 变体；macOS 的 `spawn-helper` 要补可执行位。**陷阱**：CI 里 agent-host / runtime 用的 `npm ci --omit=optional`（`.github/workflows/build.yml:67,219,223`）照抄到 DSH，会把全部原生包丢掉。
5. **许可**以 MIT / Apache-2.0 为主，没有 GPL / AGPL。要专门处理的是 sharp 带的 libvips 一组（LGPL-3.0-or-later、cairo 的 MPL-2.0、aom 专利许可）、10 个没带许可文件的包、DeepSeek 与 cordis 的版权声明。
6. **验证**：Linux 开发机上能做到构建产物、结构与格式校验、从产物起宿主并跑 bridge 工具回合、换目录 / 只读目录 / 模块解析不越界、`electron-builder --linux --dir` 后跑 verify，还能在 Linux 上静态演练 win32 与 darwin 产物。在真 Windows、macOS 上跑只能靠 CI，要推分支，推送前需用户确认。

## 2. 现状

### 2.1 打包链路（[分片 01](p1-2-host-packaging/01-packaging-chain.md)）

- 应用本体进 `app.asar`（`electron-builder.yml:9-74`）；根依赖里的原生件经 extraResources 进 `resources/node_modules/`（`:90-152`）。
- agent-host（内含被 esbuild 打进 `worker.js` 的 `src/runtime`）由 `scripts/build-agent-host.mjs` 构建、afterPack 整目录拷到 `resources/agent-host/`；不用 extraResources，因为那条路会被注入 node_modules 排除（`afterPack.mjs:36-63`）。
- 随包 node 钉 24.18.0（`scripts/node-runtime-pin.mjs:12`），afterPack 按目标平台拷到 `resources/node-runtime/`（`afterPack.mjs:78-125`）。worker 只在 Windows 打包态用它（`PiWorkerProcess.ts:79-93`），pi TUI 在三平台打包态都用它（`PiTuiPty.ts:157-160`）。
- 平台：Windows NSIS、Linux AppImage 走 tag 发布；macOS 只在 dispatch 时构建未签名 arm64 包（`build.yml:420-432`）。不做交叉打包（`scripts/assert-build-target.mjs`）。CI 的 gate 里没有任何 DSH 步骤。
- 模块解析会沿父目录找 `node_modules`，宿主上一级正好是装着 node-pty 1.1.0、ws 等的 `resources/node_modules/`；裁剪误删一个依赖，Node 会静默用上应用那一份。

### 2.2 P0-4 工具包（[分片 02 §1](p1-2-host-packaging/02-natives-and-size.md#1-p0-4-工具包做了什么srcdsh-hostp0-4build-kitmjs)）

以锁文件为准 `npm ci --ignore-scripts [--os --cpu]` → 把 npm 11 留下的 `file:` 链接物化 → 删 `.bin`、外平台 prebuilds、`.map/.d.ts` → 按文件头校验格式与必需原生件 → 出清单（`src/dsh-host/p0-4/build-kit.mjs:102-278`）。CI 版 122.6 MiB、10,861 个文件。能直接搬的是安装、物化、裁剪、校验与清单；要改的是只装产品文件、多删 `.pdb` / `.md` / musl / wasm32、补 macOS 可执行位与 Mach-O 判定、加许可保留。

### 2.3 宿主入口（[分片 03 §1](p1-2-host-packaging/03-entry-lock-files.md#1-宿主入口在打包态怎么跑)）

- 随包 node v24.18.0 直接跑 node_modules 之外的 `.ts` 不报警告；node_modules 之内报错；asar 里读不到。`--expose-internals` 不许写进 `NODE_OPTIONS`，写在 argv 里可以（以上均为实测）。
- `--expose-internals` 不是必需的：加载器缺它时改用原生 addon（`cordis-plugin-loader/src/internal.ts:108-118`），app-boot 本来就只用 addon（`dsh-app-boot/lib/index.js:1573-1579`）；但 P0 全部证据都带着它。
- DSH 按 node_modules 布局找 bundle（`dsh-app-boot/lib/index.js:881-906`），与 `file:./bundle` 写法无关；profile 清单里的 bundles 只在首次启动时写入，以后以清单为准（`:575-591,919-920`）。

### 2.4 原生模块（[分片 02 §2～3](p1-2-host-packaging/02-natives-and-size.md#2-原生二进制逐个)）

NARB（`node-addon-require-builtin`，启动即用）、`@deepseek-ai/node-addon-system`（flock 与 Linux 的 `landlock-run`，无 win32 包）、koffi、node-pty（单包全平台，Windows 带 10.1 MiB `.pdb`）、`@vscode/ripgrep`、sharp + libvips（`read_image` 懒加载，不能删），外加 pnpm 自带的 reflink / fastlist。锁文件里 68 个平台包全是可选依赖；5 个包带安装脚本，`--ignore-scripts` 下只需补 `spawn-helper` 的可执行位。

### 2.5 锁文件与 pnpm（[分片 03 §2](p1-2-host-packaging/03-entry-lock-files.md#2-锁文件安装与-pnpm)）

子包用 npm，`package-lock.json`（v3，npm 10.9.8 生成）已入库，直接依赖全是精确版本。pnpm 11.7.0 是运行时依赖：plugin-manager 没配 `packageManager` 时会跑 PATH 上的 `pnpm`（`dsh-plugin-manager/lib/index.js:1354,1530`），而 `host.ts` 只在设了 `AICLIENT_DSH_PNPM_CLI` 时才指向随包的那份（`host.ts:116-126`）。

### 2.6 文件判定（[分片 03 §3～4](p1-2-host-packaging/03-entry-lock-files.md#3-文件逐个判定)）

转正：`host.ts`、`bridge/dshSessionRuntime.ts`、`bundle/{package.json, cordis.patch.yml}`、`bundle/lib/bridge.js`（改成开发垫片）、三个 `package*.json` / `tsconfig.json`。暂留到 P1-3：`bundle/lib/shared-bridge.js`。移到 `tools/`：`aiclient-probe` 插件、`bridge-smoke` / `goal-probe` / `p0-6-probe` / `measure`、P0-4 上机包（P1-13 前必须保留）、`lib/kit.ts`、`lib/probe-hooks.mjs`。删除：`lib/select-community-plugin.mjs`。`package.json`：名字不变，version `0.0.0-p0.1` → `0.1.0`，description 去掉「Throwaway」。

## 3. 方案

### 3.1 产物布局

```
resources/
  node-runtime/node(.exe)            载体（已有）
  dsh-host/                          新增，afterPack 整目录拷入，不进 asar
    package.json                     安装锚点（@aiclient/dsh-host）
    host.js                          esbuild 转译自 host.ts
    dsh-host-manifest.json           平台、版本、git 提交、体积、文件数、原生件 sha256
    THIRD_PARTY_LICENSES.json        按最终产物生成的逐包许可清单
    node_modules/
      @aiclient/dsh-app/             实拷贝；lib/bridge.js 是 esbuild 打包的 bridge
      @deepseek-ai/…、pnpm/、…       只带本平台，B 档裁剪
```

### 3.2 构建流水线（新 `scripts/build-dsh-host.mjs`）

1. 预检：直接依赖全是精确版本、锁文件在、bundle 的 peer 等于钉的 DSH 版本。
2. 暂存到 `out-dsh-host/`：只拷 `package.json`、`package-lock.json`、`bundle/`。
3. 编译：`host.ts` → `host.js`（只转译）；`bridge/plugin.ts` 连同 `src/agent-host/piWorkerRpcServer.ts`、`src/shared/types/*` 打成 `bundle/lib/bridge.js`，npm 包全部外置（`packages: 'external'`）。
4. 安装：`npm ci --ignore-scripts --no-audit --no-fund`，默认构建机平台，不加 `--omit=optional`。
5. 物化 `file:` 链接为实拷贝，删暂存的 `bundle/`；darwin 给 `spawn-helper` 设 0755。
6. 删除式裁剪（B 档），保留全部许可文件与 libvips 的 README / `versions.json`。
7. 校验：无符号链接；原生件按文件头是目标平台与架构；本平台必需件齐全；可执行位；体积与文件数上限；许可清单齐全。写两份清单。

### 3.3 接入点

构建脚本与 `dist:prereq`；afterPack 的 `copyDshHost`（核对清单平台与目标一致，Windows TSD 修复目标加 `resources/dsh-host`）；verify 与体积预算；build.yml 的 gate 与三个打包 job；Main 打包态启动（P1-1）；许可声明；`.gitignore` / `biome.json`；静态测试。逐项见[分片 01 §5](p1-2-host-packaging/01-packaging-chain.md#5-dsh-宿主要接入的-8-处)。

### 3.4 与其他任务的接口

- **P1-1**：打包态 `command = resources/node-runtime/node(.exe)`，`args = ['--expose-internals', 'resources/dsh-host/host.js']`，stdio 带 `ipc`，缺失抛错不回落。P1-1 写解析函数与单测（其调研稿已按此预留「P1-2 定的宿主入口」），P1-2 在打包冒烟里验证。
- **P1-3**：启动环境；建议 `NARB_NATIVE_CACHE_DIR` 指向应用私有目录（P0-4 的 B3 形态，Windows CI 已过；加密机以 P1-13 为准），原生件副本不会锁住安装目录；profile 清单冻住 bundles 的问题；宿主须先于 NSIS 覆盖安装退出。
- **P1-5**：bundle 里的假模型与 `AICLIENT_DSH_GATEWAY_*` 是 P0 写法，冒烟暂用，P1-5 换掉后跟着改。
- **P1-10**：见 D6；构建脚本对预装插件走同一套裁剪、校验与许可流程，届时重定体积上限。
- **P1-12 / P1-13 / P1-14**：删 agent-host 后体积回落；上机包在 P1-13 前保留；Windows 标准用户一路在 P1-14。

## 4. 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 宿主以什么形态进包 | A 构建产物：`host.js` + esbuild 打包的 bridge；B 源码直跑：把 `host.ts`、`bridge/`、`src/agent-host`、`src/shared` 的 TS 一起拷进包，改 import 路径 | A | B 在 node_modules 下不能类型剥离，还要把两棵源码树搬进安装包；A 复用 agent-host 的 esbuild 做法；TSD 修复只认 `.js`（`afterPack.mjs:147`） | 开发态跑源码、打包态跑产物，两条路靠产物冒烟对齐；bridge 逻辑要从 `bridge.js` 挪到 `bridge/plugin.ts` |
| D2 | Linux / macOS 上宿主跑在哪 | A 随包 node（三平台同一载体）；B Electron 充当 node（官方 DSH Desktop 的做法）；C utilityProcess | A | P0 全部证据都在随包 v24.18.0 上；app-boot 经原生 addon 改 Node 内部加载器，在 Electron 里没验过；随包 node 三平台早已进包 | 与 ARD D11 表（非 Windows 走 electron-utility）不一致，P1-14 回写 ARD |
| D3 | 依赖怎么装、怎么裁 | A 干净暂存区 `npm ci` + 删除式裁剪 + 必需件校验（P0-4 做法）；B 复用 `src/dsh-host/node_modules`，按白名单走查拷贝（agent-host 做法） | A | 不受开发机本地树影响（本 worktree 的树是 npm 10 装的，带全平台 prebuilds 与 wasm32）；裁剪出错表现为「多带了」，由体积与外平台检查兜住，避开「walker 先问目录、只答文件就整包跳过且测试全绿」的旧坑 | 每次构建联网装一次（约 1 分钟，推断）；要维护按平台的必需件清单 |
| D4 | 裁到哪一档、预算多少 | A 工具包档（Linux 131.8 MiB）；B 档（再删 `.md` / `.pdb` / musl / wasm32 / 原生源码，98.5 MiB）；C 档（B 再删 OpenTelemetry，92.2 MiB） | B；硬上限 128 MiB / 1.2 万文件；目标解压 ≤110 MiB、安装包增量 ≤30 MB | B 删的都确定用不到；C 要先证明被关掉的行不会 import 其包，DSH 每次升级都得重证 | 约 6 MiB 的 OpenTelemetry 留在包里 |
| D5 | `aiclient-probe` 探针插件 | A 移出产品，做成测试专用 bundle `@aiclient/dsh-probe`，由探针脚本放进 profile 目录（DSH 的第二解析锚点）；B 留在产品 bundle，改为显式开启 | A | 它自动批准全部审批；A 让安装包里物理上没有这段代码 | `goal-probe`、`measure`、`p0-4-probe` 与上机包要改启动方式（`p0-6-probe` 为了 compaction 开关也要叠加）；A 这条路径只读过代码没跑过，不通就用 B |
| D6 | pnpm 是否随包 | A 随包，打包态默认指向随包 `pnpm.mjs`；B 现在就去掉 | A，最终由 P1-10 定 | 不配就会去跑 PATH 上的 pnpm；P1-10 的离线安装很可能仍要 pnpm | 约 16 MiB；P1-10 之前没有安装入口，靠 dsh-base 的 `tool-plugin-manager` 默认关闭 |
| D7 | 打包冒烟做到哪一层 | L0：起到 ready、组合审计通过、停止退出码 0；L1：再经 bridge 建会话，跑 read / grep / shell 工具回合（假网关） | L1 | 打包最容易坏的是 rg、pty / conpty、koffi、沙箱启动器这些「用到才加载」的原生件，L0 碰不到；现有 native worker 冒烟也跑 read + bash | 约 300 行跨平台脚本；P1-3 改共享宿主、P1-5 改路由时要跟着改 |
| D8 | macOS 的验收口径 | A dispatch 构建的 arm64 未签名候选包过冒烟即算；B 等签名发布恢复再算 | A | macOS 09-23 起不在发布链，只在 dispatch 时构建未签名包 | 签名、公证、x64 不在 P1-2 覆盖内 |

## 5. 改动清单（逐文件见[分片 05 §1](p1-2-host-packaging/05-changes-and-verification.md#1-改动清单按文件)）

- **子包**：`package.json` / 锁文件 / `tsconfig.json`；`host.ts`（打包态 pnpm 默认值、清单版本）；新 `bridge/plugin.ts`，`bundle/lib/bridge.js` 改垫片；`cordis.patch.yml` 去探针行；探针与上机包挪进 `tools/`，新建 `tools/probe-bundle/`；假网关复制一份维护版进 `tools/`；删 `select-community-plugin.mjs`。
- **构建**：新 `scripts/dsh-host-build-lib.mjs`、`scripts/build-dsh-host.mjs`、`scripts/packaged-dsh-host-smoke.mjs`；改 `afterPack.mjs`、`verify-packaged-app.mjs`、`packaging-budget.mjs`；新单测 `dsh-host-build-lib.test.mjs`，改 `packaging-config.test.mjs`、`packaging-budget.test.mjs`。
- **根与 CI**：根 `package.json` 加脚本并进 `dist:prereq`；`.gitignore`、`biome.json`；`build.yml` 的 gate 与三个打包 job；`THIRD_PARTY_NOTICES.md`。
- **Main**：P1-1 的打包态布局解析；P1-3 的启动环境。P1-2 不直接改 Main。

## 6. 验证方案（步骤与判据见[分片 05 §2](p1-2-host-packaging/05-changes-and-verification.md#2-验证)）

- **本机不推送**：V1 单测与类型；V2 构建 linux-x64 产物并校验；V3 在 Linux 上静态演练 win32 与 darwin 产物（格式与必需件）；V4 / V5 从产物起宿主跑 L0、L1；V6 模块解析不越界、零外连；V7 拷到带空格与中文的只读目录再跑；V8 NARB 三种形态；V9 `electron-builder --linux --dir` 后跑 verify（`pnpm build` 设了 4 GB 堆，开发机要单独跑）。
- **只能 CI**：windows-2022（NSIS、带空格路径或静默安装目录下的冒烟、pwsh / conpty / koffi / ACL 沙箱）、ubuntu（AppImage）、macos-14 dispatch（arm64、`spawn-helper`、Seatbelt）；三份产物清单、冒烟报告与安装包大小写进 `evidence/p1-2-host-packaging-<日期>.md`。
- **退出判据落地**：「三平台安装包里能起 DSH 宿主」＝三个打包 job 的 L1 冒烟全过；「体积记入证据」＝三平台产物清单与装前装后安装包大小。

## 7. 风险与未覆盖

- **DSH 仍是 developer preview**：升版本就要重建产物、重跑冒烟，bundle 的 peer 要同步改（决策 003 的升级流程要把「打包冒烟」加进去）。
- **Windows 路径**：产物内最长相对路径 158 字符，比现有 agent-host 的 169 短，不比现状差；但 CI 的 `win-unpacked` 路径不带空格，而真实安装目录 `Programs\PiLab Ai` 带空格，所以 Windows CI 要在带空格的目录里再跑一次冒烟（分片 05 的 C3）。中文用户名、客户端版 Windows、杀软对 1 万个文件的扫描时间都没测。
- **更新时的文件占用**：`koffi.node`、`conpty.node` 从安装目录原地加载，宿主没退出时 NSIS 覆盖会失败；靠 P1-3 保证宿主先退，NARB 缓存目录只能解决 NARB 这一个。
- **macOS**：只有未签名 arm64；签名与公证时 `resources/dsh-host` 里约 10 个 Mach-O 文件（推断：各原生 `.node`、libvips 的 dylib、`rg`、`spawn-helper`）能否全部签上、x64 包，都没覆盖。
- **许可**：libvips 一组的 LGPL / MPL / aom 专利许可需要用户或法务确认；pnpm 打包进去的第三方代码没核。
- **CI 耗时**：每个打包 job 约 +3～4 分钟（推断：`npm ci`、压缩多出的约 100 MiB、冒烟），在现有 20 / 25 分钟超时之内。
- **Linux CI 与桌面不同**：runner 上可能没有 bwrap 与 `systemd-run --user`，DSH 会走降级路径，桌面用户走的那条 CI 覆盖不到。
- **加密机**（P1-13）：安装目录里的原生件由 node.exe 加载、NSIS 写出的文件在 TSD 策略下的形态，都不在 P1-2 范围。
- **本次没能确认的事实**：Loader 会不会 import 被关掉的行所在的包（决定能否裁 OpenTelemetry）；Windows 上 node-pty 运行时从哪取 `OpenConsole.exe`（决定能否删 `third_party` 重复件）；测试 bundle 从 profile 目录装载（D5-A）；npm 11 不带 `--cpu` 时是否还装 sharp 的 wasm32；Windows NSIS、AppImage、dmg 的实际压缩增量（只量了 Linux 的压缩率）；P1-1 最终的启动函数形态（并行调研中）。
