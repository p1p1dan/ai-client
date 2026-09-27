# P1-2 分片 02 · P0-4 裁剪复用、原生模块与体积

Role: detail shard。上位：[P1-2 方案](../p1-2-host-packaging.md)。回答调研问题 2（P0-4 工具包的裁剪）、4（原生模块与三平台）、7（体积预算）。「实测」指 2026-09-26 在开发机上量的；「推断」指按实测或证据换算、未上机。

## 1. P0-4 工具包做了什么（`src/dsh-host/p0-4/build-kit.mjs`）

| 步骤 | 做法 | 行号 |
|---|---|---|
| 暂存 | 拷 `package.json`、`package-lock.json`、`host.ts`、两个探针、`lib/kit.ts`、`lib/probe-hooks.mjs`、`bundle/`（不含 node_modules）、假网关；`run-p0-4.ps1` 转成 UTF-8 BOM + CRLF | `:102-130` |
| 安装 | `npm ci [--os=win32 --cpu=x64] --install-links --ignore-scripts --no-audit --no-fund` | `:133-144` |
| 物化 | `node_modules` 顶层指回暂存区的符号链接换成实拷贝。npm 11 不再按 `--install-links` 复制锁文件里 `link: true` 的 `file:./bundle`（CI 运行 36257516912 因此失败） | `:146-167` |
| 裁剪 | 删 `.bin`、node-pty 外平台 prebuilds、非 Windows 时整个 `node-pty/third_party`（Windows 只留 `win10-x64`）、pnpm 自带的外平台 `@reflink/*`、`pnpm/dist/vendor`（非 Windows 全删，Windows 删 x86）、全部 `.map/.d.ts/.d.mts/.d.cts/.tsbuildinfo` | `:169-205` |
| 校验 | 不得有符号链接；每个 `.node/.dll/.exe` 与 `bin/rg` 读文件头判 PE32+ / ELF64 与架构；本平台必需原生件齐全，缺一个就失败 | `:207-238` |
| 清单 | 版本、文件数、字节数、最长相对路径、每个原生件的格式与 sha256 | `:241-278` |

结果：开发机（npm 10）版 zip 40.2 MB、解压 126 MB、10,880 个文件、最长相对路径 181 字符（[工具包证据](../../evidence/p0-4-kit-2026-09-25.md)）；CI（npm 11）版 122.6 MiB、10,861 个文件，14 个原生件 sha256 与开发机版完全相同（[Windows CI 证据](../../evidence/p0-4-windows-ci-2026-09-26.md)）。

**可以直接搬进正式打包的**：以锁文件为准 `npm ci --ignore-scripts`（Windows CI 与 Linux 预演都证明跳过安装脚本不影响运行）；`--os/--cpu` 用于在 Linux 上演练别的平台；链接物化；上表的裁剪项；按文件头判格式；按平台的必需原生件清单；产物清单。

**要改的**：只暂存产品文件（探针、假网关、ps1 不进）；裁剪再加 `.pdb`、非许可类 `.md`、sharp 的 musl / wasm32 变体与 `@emnapi`、node-addon-system 的 musl 变体、原生件的 C/C++ 源码目录；补 macOS 的可执行位（见 §3）；格式判定补 Mach-O 的架构与无后缀可执行件（`spawn-helper`、`landlock-run`）；加 darwin 的必需清单；保留许可文件；加 bridge 编译步骤；不打 zip；输出到 `out-dsh-host/`；平台默认取构建机。

**不要沿用的**：依赖 `--install-links` 的行为（npm 10 / 11 不一致，P0-4 修复清单第 7 条已提醒）。

## 2. 原生二进制逐个

锁文件里有 68 个带 `os/cpu` 字段的平台包，全部是可选依赖。

| 包（版本，许可） | 三平台上是什么文件 | 谁用、何时加载 |
|---|---|---|
| `node-addon-require-builtin` 0.1.6（MIT），平台包 `-win32-x64-msvc` / `-linux-x64-gnu` / `-darwin-arm64` / `-darwin-x64` | `prebuilt/<triple>-napi-v9.node` | 启动即用：`dsh-app-boot` 经它拿 Node 内部 ESM/CJS 加载器（`dsh-app-boot/lib/index.js:1573-1579`）；经 `node-addon-native-custom-loader` 先复制到缓存再加载，受 `NARB_DISABLE_NATIVE_CACHE` / `NARB_NATIVE_CACHE_DIR` 控制 |
| `@deepseek-ai/node-addon-system` 0.1.2（`package.json` 写 BSD-3-Clause，包内 LICENSE 是 MIT），平台包只有 linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64，**没有 win32** | Linux：`bin/{glibc,musl}/system.node` 与可执行的 `bin/landlock-run`；macOS：`system.node` | 会话日志写锁（flock，首次落盘时加载）；Linux 沙箱在 bwrap 不可用时退到 landlock（`dsh-sandbox-local/lib/index.js:6,174`） |
| `koffi` 3.3.1（MIT），平台包 `@koromix/koffi-<plat>` | `koffi.node` | fs-local、sandbox-windows-acl、会话写锁（Windows 命名信号量）、subprocess-local、win32-process。Windows CI 与 Linux 预演都记到它被加载 |
| `node-pty` 1.2.0-beta.15（MIT），**单个包里带全平台 prebuilds** | Linux：`prebuilds/linux-x64/pty.node`；macOS：`pty.node` + `spawn-helper`（要可执行位）；Windows：`conpty.node`、`conpty_console_list.node`、`conpty/OpenConsole.exe`、`conpty/conpty.dll`，另有两个 `.pdb` 共 10.1 MiB，以及 `third_party/conpty/1.25.260303002/win10-x64/` 下的一份重复 | subprocess-local 起终端与 shell 工具；第一次用到时加载 |
| `@vscode/ripgrep` 1.18.0（MIT），平台包 `-<plat>` | `bin/rg` / `bin/rg.exe` | fs-search 的 grep / glob，每次调用起子进程 |
| `sharp` 0.35.4（Apache-2.0），平台包 `@img/sharp-<plat>`；Linux / macOS 另有 `@img/sharp-libvips-<plat>`（LGPL-3.0-or-later），Windows 的 DLL 在 `sharp-win32-x64/lib` 里 | `.node` + libvips 的 `.so` / `.dylib` / `.dll`，每平台约 18～19 MiB | `dsh-attachment-local` 懒加载（`:118`），`read_image` 工具经它处理图片（`dsh-tool-fs/lib/index.js:791-797`）。**不能删**，删了读图就坏 |
| `pnpm` 11.7.0 自带 | `dist/node_modules/@reflink/reflink-<plat>`（本次安装里只有 darwin 与 win32 变体），`dist/vendor/fastlist-0.3.0-x64.exe`（Windows） | 只在装插件时用 |
| Node 内置 `node:sqlite` | 无额外文件 | `dsh-session-query-sqlite`，Node 24 自带 |

实际加载记录：Windows CI 的 K-natives 是 NARB、`koffi.node`、`conpty.node`；Linux 预演是 NARB、`system.node`、`koffi.node`、`pty.node`（`evidence/p0-4-kit-2026-09-25/linux-dryrun-summary.txt:70`）。

用到但不随包的系统程序：Linux 的 `bwrap`（优先）与 `systemd-run --user`（进程收容，先探测、不行就降级，`dsh-subprocess-local/lib/index.js:73-94`）；macOS 的 `sandbox-exec`；Windows 的 pwsh / Windows PowerShell（DSH 在 Windows 上只有 pwsh 工具）。

## 3. 怎么只带本平台的

- **本项目本来就不做交叉打包**，每个平台在自己的原生 runner 上打（[分片 01 §2](01-packaging-chain.md#2-平台差异)）。所以在 runner 上 `npm ci`，npm 只装 `os/cpu/libc` 匹配的可选平台包；需要手工处理的只有两类：
  - 一个包里塞了所有平台的：node-pty 的 `prebuilds/`、pnpm 的 `@reflink` 与 `vendor/`，按平台删。
  - npm 的多装：本 worktree 的树是 npm 10.9.8 装的，Linux 上多出 `@img/sharp-wasm32`（约 9 MiB）、`@emnapi/runtime` 和 linuxmusl 变体（约 18 MiB）。npm 11 在 `--cpu=x64` 下不装 wasm32（Windows CI 证据），但不带 `--cpu` 时的行为没验证。统一按规则删，不依赖 npm 版本。
- **afterPack 再核一次**：产物清单里记下构建平台与架构，afterPack 与 `context.electronPlatformName`、`context.arch` 比对，不一致就失败（`copyNodeRuntime` 同样按目标平台而不是构建机取文件，`afterPack.mjs:78-88`）。
- **`--omit=optional` 是陷阱**：所有平台原生包都是可选依赖。CI 里 agent-host / runtime 的写法 `npm ci --omit=optional`（`build.yml:67,219,223`）一旦照抄到 DSH，就会把 koffi、ripgrep、sharp、NARB、node-addon-system 的平台包全部丢掉。
- **安装脚本**：锁文件里有 5 个包带安装脚本：`dsh-subprocess-local`（postinstall 给 node-pty 的 `spawn-helper` 设可执行位，`scripts/ensure-spawn-helper.mjs`）、`@google/genai`（prepare，注册表安装不跑）、`koffi`（有平台包时不需要）、`node-pty`（检查 prebuilds；Windows 上把 conpty 拷进 `build/Release`，prebuilds 里本来就有）、`protobufjs`（CLI 依赖检查）。`--ignore-scripts` 下只需要补第一个：构建脚本对 darwin 的 `prebuilds/darwin-*/spawn-helper` 设 0755，并在校验里检查 `spawn-helper`、`rg`、`landlock-run` 的可执行位。本次在 Linux 树里看到 `spawn-helper` 已是 0775（npm 解包时就带了执行位），但 macOS 上没验证过。

## 4. 体积

**测量方法（实测）**：对本 worktree 的 `src/dsh-host/node_modules`（npm 10.9.8 于 2026-09-25 装的 linux-x64 树）逐文件求和（字节，按 MiB 报），按下列规则模拟裁剪；压缩率用 `tar -c -T <清单> | gzip -6 | wc -c` 与 `| xz -6 -T2 | wc -c` 流式测，不落盘。

| 档位 | 规则 | Linux x64 解压 | 文件数 |
|---|---|---|---|
| 安装原样 | — | 214.8 MiB（`du` 占盘 285 MiB） | 22,133 |
| A 工具包档 | P0-4 的裁剪规则 | 131.8 MiB | 10,876 |
| **B 档（推荐）** | A + 非许可 `.md`（5.4 MiB）+ `.pdb` + sharp musl / wasm32 与 `@emnapi` + node-addon-system musl + 原生源码目录 | **98.5 MiB** | **10,179** |
| C 档 | B − `@opentelemetry/*` 与 `dsh-session-telemetry-otel` | 92.2 MiB | 8,532 |

B 档里：pnpm 15.8 MiB、`@img`（sharp 与 libvips）18.2 MiB、OpenTelemetry 6.3 MiB、`dsh-host-webserver` 及其依赖 0.3 MiB。B 档压缩后：gzip 25.6 MB，xz 16.7 MB（实测）。去掉 `.map` / `.d.ts` 后最长相对路径 158 字符（OpenTelemetry 嵌套依赖里的一个 `.js`），比现有 agent-host 产物的 169 字符短。

| 平台 | B 档解压 | 依据 |
|---|---|---|
| Linux x64 | 98.5 MiB，约 1.02 万文件 | 实测 |
| Windows x64 | 约 100～106 MiB | 推断：CI 工具包 122.6 MiB 减 `.pdb` 10.1 MiB、`.md` 约 5.4 MiB、原生源码约 1 MiB、探针与假网关约 0.2 MiB，约 106 MiB；按 Linux B 档换成 Windows 原生件，约 99 MiB |
| macOS arm64 | 约 96 MiB | 推断：Linux B 档减 Linux 原生件约 26.4 MiB，加 darwin 原生件约 23.9 MiB（npm 注册表 `dist.unpackedSize`：libvips 18,176,351 B、sharp 292,231 B、ripgrep 4,530,213 B、koffi 1,224,817 B、NARB 232,031 B、node-addon-system 55,932 B，另加 node-pty 与 pnpm reflink 的 darwin 件） |

**安装包增量（推断）**：按 Linux 实测压缩率，LZMA 类（NSIS 的 7z、xz）约 +17 MB，deflate 类（zip、gzip）约 +26 MB。基线：Windows 安装包 CI 产物 179～188 MB（[批次 H / I 构建证据](../../../runtime-hardening/evidence/batch-i-build-2026-09-20/README.md)、`batch-e-build-2026-09-18/artifacts.tsv`），加上后约 200～215 MB，涨 10%～15%。与 agent-host（85 MiB）并存到 P1-12；若 P1-12 能整体删掉 `resources/agent-host`，解压净增约 +15 MiB。

**预算建议**：
- 硬上限（verify 失败）：每平台宿主目录 128 MiB、1.2 万个文件。能拦住的回退：忘删 `.map/.d.ts`（+55.6 MiB）、外平台 node-pty prebuilds（约 +23 MiB）、sharp 的 musl / wasm32 变体（约 +27 MiB）。`.pdb` 一类体积不大的回退由「禁止文件」规则单独拦。
- 目标：解压 ≤110 MiB，安装包增量 ≤30 MB。P1-10 预装白名单插件时重新定上限。
- 证据：每个打包 job 上传产物清单（体积、文件数、最长路径、原生件 sha256、版本），P1-2 证据记三平台数字与装前装后的安装包大小。

**可裁但暂不建议的**：

| 项 | 省多少 | 为什么先不裁 |
|---|---|---|
| OpenTelemetry（C 档） | 6.3 MiB | 要先证明 Loader 不会 import 被关掉的行所在的包；DSH 每次升级都得重证 |
| pnpm | 15.8 MiB | 见方案决策 D6，P1-10 定 |
| sharp 与 libvips | 18～19 MiB | `read_image` 依赖它 |
| Windows 的 `third_party/conpty` 重复件 | 1.1 MiB | 没确认 node-pty 运行时从 `prebuilds/win32-x64/conpty/` 还是 `third_party/` 取 `OpenConsole.exe`，要在 Windows CI 上验证后再删 |
