# P1-2 DSH 宿主转正与打包：本机验证（2026-09-27，Linux 开发机）

Role: evidence。对应 [roadmap P1-2](../roadmap.md)，按[方案](../topics/p1-2-host-packaging.md)与决策 011～018 施工。代码提交 `2788952f`（44 个文件，其中 10 个识别为改名）。原始报告与三平台产物清单（已去掉本机路径）在同名目录 [p1-2-host-packaging-2026-09-27/](p1-2-host-packaging-2026-09-27/)。

**状态：本机部分（V1～V9）全部通过。** 三平台打包 job 上的 L1 冒烟，是退出判据「三平台安装包里能起 DSH 宿主」的最终依据，要推分支或手动触发 CI，推送前需要用户确认。

## 本机验证

| 项 | 结果 | 报告 |
|---|---|---|
| V1 单测与类型 | 四套 tsc 全过；相关单测全过（实现代理 5 个文件 137 例；编排器复跑 4 个文件 115 例）；biome 干净 | — |
| V2 linux-x64 产物 | 96.0 MiB（100,672,732 B），10,166 个文件，361 个包，8 个原生件全是 ELF64 x64，最长相对路径 158 字符；gzip 25.4 MB，xz 16.6 MB | `manifest-linux-x64.json` |
| V3 静态演练 | win32-x64：99.1 MiB，10,167 个文件，14 个原生件全是 PE32+ x64，xz 17.2 MB。darwin-arm64：94.7 MiB，10,168 个文件，9 个原生件全是 Mach-O arm64，`spawn-helper` 为 0755，xz 15.7 MB。两者必需件都齐 | `manifest-win32-x64.json`、`manifest-darwin-arm64.json` |
| V4 / V5 从产物起宿主 | L0 约 0.7 s 到 ready，组合里没有 inactive 行，退出码 0。L1 一轮 12 次工具调用全部成功（read、edit、write、grep、glob、bash），审批往返后工作区外写入成功，dispose 后退出码 0。共 31 项检查全过 | `smoke-v45.json` |
| V6 不越界、不外连 | 1,682 个模块全部从宿主目录加载；原生件从产物加载（NARB 走缓存）；rg 从产物起；没有非回环连接，也没有 DNS 查询 | `smoke-v45.json` |
| V7 带空格和中文的只读目录 | 拷到 `/var/tmp/p1 2 测试/PiLab Ai/resources`，整个目录只读；上一级 `node_modules` 放了一个一加载就报错的假包，31 项全过，产物目录没有多出文件 | `smoke-v7.json` |
| V8 NARB 三种形态 | 实际加载路径都与判据一致 | `smoke-v8-*.json` |
| V9 electron-builder | `--linux --dir` 用时 78 s；`verify --skip-smoke` 通过，其中包括在 resources 里跑的 DSH L1 冒烟 | `smoke-v9.json`、`verify-report.json` |
| 编排器复跑 | 在构建产物上跑打包冒烟 L1，31 项全过，sharp / libvips 8.18.6、pty 都从产物加载；`tools/bridge-smoke.ts` 18 项判定全部为真 | `smoke-orchestrator-rerun.json` |

## 与方案的偏离（都已按事实调整）

1. **修了 P1-1 bridge 的潜伏竞态**：bridge 改为静态 import 之后，首个 bootstrap 报 `no agent factory registered`。以前是动态 import 的耗时把它掩盖了。现在两个 bridge 行的 inject 都加了 `agentLoop`。
2. `.md` 只删文档类（README、CHANGELOG，以及 `doc/`、`docs/` 目录下的）。`dsh-skill-badge/assets/dsh-badge.md` 运行时要读，已列为必需件。
3. 原生源码按扩展名删，不删整个 `src/` 目录，因为 `koffi/src/koffi/*.js` 是运行时代码；pnpm 自带的 node-gyp 源码保留。
4. 额外删了 koffi 的 musl 构建（1.2 MiB），与方案里其他 musl 变体同类。
5. `shared-bridge` 同样改成垫片、用 esbuild 打包；它那一行仍留在产品补丁里，靠环境变量关闭，Main 从不设。P1-3a 转正。
6. 开发态也默认用宿主自己 `node_modules` 里的 pnpm（决策 016 只要求打包态）。
7. 冒烟多加一步：直接从产物加载 sharp、libvips，并跑一次 node-pty。原因是在 Linux 上，L1 的工具回合碰不到这两样。
8. 两个 bundle 和宿主的 `package.json` 补了 `"license": "MIT"`，锁文件用 npm 11.20.0 重新生成，只改了 version 和 license 几行。
9. 没复用 agent-host 的构建库，因为 P1-12 会删掉 agent-host。
10. CI 超时调大：gate 12→14，windows 20→30，linux 20→25，macos 25→35 分钟。
11. 决策 015 走的是 A：探针插件放进测试专用 bundle `tools/probe-bundle/`，`tools/measure.ts smoke` 验证过。

## 只能在 CI 上验的（推送或手动触发前需用户确认）

- windows-2022：npm 11 装的原生件；`resources/dsh-host` 的 TSD 改写；NSIS 包；在 `win-unpacked` 和带空格的 `C:\p12app\PiLab Ai` 两处跑 L1（pwsh、conpty、ACL 沙箱）；安装包大小。
- ubuntu：AppImage 大小；runner 上有没有 bwrap 和 `systemd-run`。
- macos-14（dispatch）：`spawn-helper` 的可执行位经 dmg / zip 之后是否保留；Seatbelt。
- gate 里新加的步骤。

## 仍未确认

- 各平台安装包的实际增量。
- Windows 上 node-pty 用的是 conpty 的哪一份（prebuilds 和 third_party 两份都保留了）。
- goal-probe 没有全量重跑；profile 里的 `file:` 依赖只验证了 pnpm 离线安装。
- pnpm 内部自带 21 个包，其中 BlueOak-1.0.0 等几个包没有许可文件，已写进 NOTICES；LGPL / MPL / aom 专利许可见 [Q007](../open-questions.md)。

## 给后续任务的接口

- bridge 源码现在在 `src/dsh-host/bridge/`，`bundle/lib/*.js` 只是垫片。新增 bridge 模块要登记到 `BRIDGE_ENTRIES`，否则构建会拒绝。运行时允许外置的 npm 包，目前只有 `@deepseek-ai/dsh-llm`。
- 打包态布局与 Main 的 `DSH_HOST_LAYOUT`（P1-1）一致，Main 不用改。
- P1-6 落地后，打包冒烟要显式设 bypass 档或应答卡片（P1-6 方案 §6）。

## CI 安装包大小（2026-10-07 补记）

上文「只能在 CI 上验的」里的安装包大小，后来在三次整包 `build.yml` 上拿到了。数据取自[看板](../implementation-status.md) Last Landed 的 10-01、10-04 两条，口径是 GitHub Actions artifact 压缩后的大小，只作 artifact，不建 Release。

| 产物 | `1.1.0-dsh.2`（run 36651305647，`a3a25495`） | `1.1.0-dsh.3`（run 36895051539，`13bc19f5`，P1-12 第 1 步） | `1.1.0-dsh.4`（run 37170324111，`f847f66d`，P1-12 第 3 步） |
|---|---|---|---|
| Windows 安装包 | 209.7 MB | 197.8 MB | 191.7 MB |
| Windows 解包目录 | 303.9 MB | 288.1 MB | 279.2 MB |
| Linux 包 | 204.8 MB | 196.6 MB | 189.8 MB |
| macOS 包 | 459.2 MB | 435.9 MB | 417.1 MB |

- 宿主产物本身（`resources/dsh-host`）：`dsh.3` 那次 Windows 85.1 MiB、Linux 82.6 MiB。
- 三次的全部 job 都通过；Windows、Linux 的打包验证与 L1 冒烟都绿，Windows 带空格路径的 L1 冒烟 44 项通过。
- 后两次变小，来自 P1-12 删掉旧 native worker、`src/runtime` 与根依赖里的 pi 包。
- 仍未确认：相对 1.0.x 安装包的增量，本证据没有同口径的 1.0.x 数字；P1-12 第 4 步之后的改动还没经过整包构建，随 P1-14 的下一次推送复跑。
