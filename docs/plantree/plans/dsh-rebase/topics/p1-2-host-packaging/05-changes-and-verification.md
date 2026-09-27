# P1-2 分片 05 · 改动清单与验证步骤

Role: detail shard。上位：[P1-2 方案](../p1-2-host-packaging.md)。回答调研问题 9。按推荐选项（D1～D8 全取推荐）列；选了别的选项时，对应条目在方案 §4 里标了代价。

## 1. 改动清单（按文件）

### A. 子包 `src/dsh-host/`

| # | 文件 | 改什么 |
|---|---|---|
| A1 | `package.json` | version `0.1.0`、description、`measure` 脚本改指 `tools/`（[分片 03 §4](03-entry-lock-files.md#4-packagejson-怎么改)） |
| A2 | `package-lock.json` | 改版本后用 npm 11 跑 `npm install --package-lock-only` 重生成，入库 |
| A3 | `tsconfig.json` | `include` 加 `tools/**/*.ts` |
| A4 | `host.ts` | 头注释去 P0；打包态默认用产物里的 pnpm；`ready` 带产物版本；组合审计保留 |
| A5 | `bridge/plugin.ts`（新） | `aiclient-bridge` 行逻辑，静态 import |
| A6 | `bundle/lib/bridge.js` | 改成一行 re-export 的开发垫片（`shared-bridge.js` 同法） |
| A7 | `bundle/cordis.patch.yml` | 删 `aiclient-probe` 行与探针专用的 compaction 开关 |
| A8 | `bundle/package.json`、`bundle/lib/index.js` | version、description；`lib/index.js` 换成最小模块 |
| A9 | `tools/`（新目录） | `git mv` 探针与测量脚本、`lib/kit.ts`、`lib/probe-hooks.mjs`、`p0-4/`；新建 `tools/probe-bundle/`（`@aiclient/dsh-probe`，装 `aiclient-probe` 行与 compaction 开关）；各脚本的 `hostEntry` 改 `../host.ts`；用到探针行或 compaction 开关的 `goal-probe`、`measure`、`p0-4-probe`、`p0-6-probe` 在启动前把探针 bundle 放进 profile 目录（`bridge-smoke` 不用） |
| A10 | `lib/select-community-plugin.mjs` | 删除 |
| A11 | 假网关 | 从 `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs` 复制一份维护版到 `src/dsh-host/tools/`，探针、上机包与打包冒烟都改用它；证据目录里那份作为归档不再改 |
| A12 | `.npmrc`（新，可选） | `registry=https://registry.npmjs.org/` |

### B. 构建与打包 `scripts/`

| # | 文件 | 改什么 |
|---|---|---|
| B1 | `dsh-host-build-lib.mjs`（新） | 裁剪规则（按平台）、按文件头判格式与架构（PE / ELF / Mach-O，含无后缀可执行件）、各平台必需原生件清单、可执行位检查、许可清单生成、`verifyDshArtifact()`、产物清单写入；`dirSize`、`findLicenseFile` 复用 `agent-host-build-lib.mjs` |
| B2 | `build-dsh-host.mjs`（新） | 预检（精确版本、锁文件、bundle peer 等于钉的版本）→ 暂存 → esbuild（`host.js`、`bundle/lib/bridge.js`）→ `npm ci --ignore-scripts --no-audit --no-fund` → 物化链接 → darwin 补 `spawn-helper` 可执行位 → 删除式裁剪 → 校验 → 写清单。参数 `--platform/--arch/--out` 只用于在 Linux 上做静态演练 |
| B3 | `afterPack.mjs` | `copyDshHost(context)`：检查产物关键文件、核对清单平台与目标一致、整目录拷到 `resources/dsh-host`；Windows TSD 修复目标加 `resources/dsh-host` |
| B4 | `packaging-budget.mjs` | `DSH_HOST_ARTIFACT_MAX_BYTES = 128 MiB`、`DSH_HOST_ARTIFACT_MAX_FILES = 12000` 与判定函数 |
| B5 | `verify-packaged-app.mjs` | 对 `resources/dsh-host` 跑 `verifyDshArtifact`、`host.js` 不得有 TSD 头、体积与文件数上限、跑 DSH 冒烟；加 `--skip-dsh-smoke`；DeepSeek 署名 |
| B6 | `packaged-dsh-host-smoke.mjs`（新，跨平台） | L0：随包 node + `--expose-internals host.js`，全新 `DSH_HOME`（0700），等 `ready`、组合审计通过、停止退出码 0、无残留子进程。L1：bridge 模式 `worker.bootstrap` → `worker.send`（假网关的 `P0-FS` 场景驱动 read、grep、shell；Windows 用 pwsh，其余 bash）→ 审批往返 → 回到 idle → `worker.dispose`。全程 `--import` 断网钩子并记录已加载模块，宿主目录之外的模块与非回环连接一律判失败。报告写 JSON |
| B7 | 单测 `scripts/__tests__/dsh-host-build-lib.test.mjs`（新） | 裁剪规则对**目录路径**与文件路径都要问到（旧坑：walker 先问目录，只答文件就整包跳过，测试照样全绿）；在夹具树上完整走一遍，断言必需件都在；校验会拒绝符号链接、外平台二进制、`.pdb`、缺必需件、缺许可清单；esbuild 打出的 bridge 在只剩外部依赖时能 import |
| B8 | `packaging-config.test.mjs`、`packaging-budget.test.mjs` | dsh-host 不进 extraResources；依赖名单精确、全是精确版本；锁文件里 `@deepseek-ai/dsh-*` 全等于钉的版本；bundle peer 等于钉的版本；三个打包 job 都在 electron-builder 之前构建 DSH 产物；DSH 安装不带 `--omit=optional`；预算常量 |

### C. 根配置、CI、许可

| # | 文件 | 改什么 |
|---|---|---|
| C1 | 根 `package.json` | 加 `build:dsh-host`、`typecheck:dsh-host`；`dist:prereq` 加 `pnpm build:dsh-host`（`:28`） |
| C2 | `.gitignore`、`biome.json` | 忽略 `out-dsh-host/` |
| C3 | `.github/workflows/build.yml` | gate：`src/dsh-host` 跑 `npm ci --ignore-scripts`，加 `pnpm typecheck:dsh-host`（可选再加 `bridge-smoke`）；build-windows / linux / macos：electron-builder 之前加 `node scripts/build-dsh-host.mjs`，上传 `dsh-host-manifest.json` 与 DSH 冒烟报告；Windows 另把 `win-unpacked` 拷到带空格的路径（仿 P0-4 的 `C:\p04app\PiLab Ai`）或静默安装后，在那里再跑一次 DSH 冒烟；核对各 job 超时 |
| C4 | `THIRD_PARTY_NOTICES.md` | DSH 段（[分片 04](04-licenses.md)） |

### D. Main（P1-1 实现，P1-2 只验证）

| # | 位置 | 约定 |
|---|---|---|
| D1 | P1-1 的宿主布局解析（其调研稿叫 `resolveDshHostLayout`） | 打包态：`command = <resources>/node-runtime/node(.exe)`，`args = ['--expose-internals', '<resources>/dsh-host/host.js']`，stdio 带 `ipc`；缺任何一个直接报错，不回落 PATH 上的 `node`（现开发版会回落，`devDshEngine.ts:79`；ARD D11 第 2 条不允许） |
| D2 | 启动环境（P1-3） | 建议 `NARB_NATIVE_CACHE_DIR=<应用私有目录>/dsh-native-cache`（即 P0-4 的 B3 形态，Windows CI 已过），加密机上以 P1-13 结论为准 |

## 2. 验证

### 本机（Linux 开发机，不推送）

先停掉其他重进程（2 核 / 3.3 GB）。临时目录用 `/var/tmp`（`/tmp` 是 tmpfs）。

| # | 验什么 | 做法 | 判据 |
|---|---|---|---|
| V1 | 单测与类型 | `vitest run scripts/__tests__/dsh-host-build-lib.test.mjs scripts/__tests__/packaging-config.test.mjs scripts/__tests__/packaging-budget.test.mjs`；`pnpm exec tsc --noEmit -p src/dsh-host/tsconfig.json`；根 `pnpm typecheck` | 全过 |
| V2 | 构建 linux-x64 产物 | `node scripts/build-dsh-host.mjs` | 体积 ≤110 MiB（预期约 98.5 MiB）、文件数 ≤1.2 万、无符号链接、原生件全是 ELF64 x86-64、可执行位齐、许可清单齐 |
| V3 | 别的平台静态演练 | `--platform win32 --arch x64` 与 `--platform darwin --arch arm64`，输出到 `/var/tmp` | 格式分别是 PE32+ x86-64 与 Mach-O arm64，必需件齐全（不运行） |
| V4 | 引擎冒烟 L0 | `packaged-dsh-host-smoke.mjs --host-dir out-dsh-host --node out-node-runtime/node --level 0` | `ready`，`census.inactive` 为空，停止退出码 0 |
| V5 | 工具回合 L1 | 同上 `--level 1` | read、grep、bash 三个工具结果正确，审批往返，dispose 后进程消失 |
| V6 | 解析不越界、不联网 | V4、V5 的报告 | 宿主目录外没有加载任何模块；没有非回环连接与 DNS 查询 |
| V7 | 换目录与只读 | 把产物拷到 `/var/tmp/p1 2 测试/dsh-host`（带空格与中文）后 `chmod -R a-w`，用同一个 `DSH_HOME` 重跑 V4、V5 | 照常通过；产物目录里没有新文件 |
| V8 | NARB 三种形态 | V4 分别加 `NARB_DISABLE_NATIVE_CACHE=1`、`NARB_NATIVE_CACHE_DIR=<目录>`、都不加 | 报告里的实际加载路径与形态一致 |
| V9 | 打包态目录 | `pnpm build`（设了 4 GB 堆，开发机要单独跑；跑不动就用 CI 的 `app-build` 产物）→ `pnpm build:agent-host` → 取随包 node → `pnpm build:dsh-host` → `npx electron-builder --linux --dir` → `node scripts/verify-packaged-app.mjs --app-dir dist/linux-unpacked`（native worker 冒烟要 `xvfb-run`，没有就 `--skip-smoke`，DSH 冒烟不需要 Electron） | `resources/dsh-host` 在、verify 通过 |

### 只能在 CI 上做（要推分支、手动触发，推送前需用户确认）

| # | 验什么 |
|---|---|
| C-W | windows-2022：本机平台构建产物、NSIS、`win-unpacked` 与带空格路径（或静默安装目录）各跑一次 DSH 冒烟（pwsh、conpty、koffi 写锁、ACL 沙箱）；记录安装包大小 |
| C-L | ubuntu：AppImage，`linux-unpacked` 上跑 DSH 冒烟（runner 上 bwrap / `systemd-run --user` 的可用性与开发机不同，走的可能是降级路径）；记录 AppImage 大小 |
| C-M | macos-14（dispatch）：arm64 未签名候选包，DSH 冒烟（`spawn-helper` 可执行位、Seatbelt、darwin 原生件）；记录 dmg / zip 大小 |
| C-E | 证据：三份产物清单与三份冒烟报告，装前装后的安装包大小对比，写进 `evidence/p1-2-host-packaging-<日期>.md` |

P1-2 的 CI 只跑管理员账户；标准用户一路按 roadmap 放在 P1-14。
