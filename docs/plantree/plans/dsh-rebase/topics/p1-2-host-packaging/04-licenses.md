# P1-2 分片 04 · 随包分发 DSH 的许可与第三方声明

Role: detail shard。上位：[P1-2 方案](../p1-2-host-packaging.md)。回答调研问题 8。依据：`src/dsh-host/package-lock.json` 各条的 `license` 字段（全部平台，共 403 个包），以及本 worktree 里装好的 Linux 树（约 340 个包）的许可文件。结论是工程侧的整理，**LGPL / MPL / 专利许可的合规结论需要用户或法务确认**。

## 1. 许可分布（锁文件，含全部平台变体）

| 许可 | 包数 | 说明 |
|---|---|---|
| MIT | 287 | 全部 `@deepseek-ai/dsh-*`、cordis 系列、koffi、node-pty、pnpm、`@anthropic-ai/sdk`、`@earendil-works/pi-ai` 等 |
| Apache-2.0 | 75 | AWS SDK 一族、`@google/genai`、`openai`、`sharp` 等 |
| BSD-3-Clause | 18 | `@deepseek-ai/node-addon-system` 及其平台包、protobufjs 一族 |
| LGPL-3.0-or-later | 10 | `@img/sharp-libvips-<plat>`，每个平台只带一个 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 | `@img/sharp-win32-*`（libvips 的 DLL 就在包里） |
| ISC | 4 | picocolors、semver、signal-exit、yaml |
| BSD-2-Clause / Python-2.0 / Unlicense / 0BSD | 各 1 | `@mixmark-io/domino` / `argparse` / `fast-sha256` / `tslib` |
| 其他 | 2 | `@img/sharp-wasm32`（三许可，B 档裁掉）；我方 `@aiclient/dsh-app`（无字段，补上） |

没有 GPL、AGPL 一类强 copyleft；弱 copyleft 只有 libvips 这一组。

## 2. 要专门处理的几处

1. **DeepSeek 的版权声明**：`dsh-base` 等包的 LICENSE 是「MIT License / Copyright (c) 2026 DeepSeek」。MIT 要求随副本保留版权与许可声明，`THIRD_PARTY_NOTICES.md` 需要新增 DSH 段，`verify-packaged-app.mjs` 的必需署名（`:84-92`）加上这一行。
2. **cordis 系列**：LICENSE 是「Copyright (c) 2021-present Shigma」（MIT），虽然以 `@deepseek-ai/cordis` 名义发布，要单列。
3. **libvips 一组（随 sharp）**：`@img/sharp-libvips-linux-x64` 的 README 列出所含库及其许可：libvips、glib、fribidi 等为 LGPLv3，cairo 为 MPL-2.0，aom 为 BSD-2-Clause 加 AOM 专利许可，其余为 MIT / BSD 类；各库版本记在同包的 `versions.json`（vips 8.18.6、glib 2.89.4、cairo 1.18.4 等）。这些库以独立的 `.so` / `.dylib` / `.dll` 形式分发、可被替换，工程上需要做到：保留该 README 与 `versions.json`（B 档删 `.md` 时要豁免它们）；在声明里写明所含库、许可与上游源码位置。是否还需要书面源码提供承诺、aom 专利许可是否可接受，请用户或法务确认。
4. **许可元数据不一致**：`@deepseek-ai/node-addon-system` 的 `package.json` 写 BSD-3-Clause，包内 LICENSE 却是 MIT（DeepSeek）；它的 Linux 平台包 LICENSE 是 BSD-3-Clause（「node-addon-landlock-run contributors」）。两份都按原文保留、都写进声明。
5. **没带许可文件的包**（Linux 树实测 10 个第三方包）：`@aws-sdk/credential-provider-http`、`@aws-sdk/credential-provider-login`、`@aws-sdk/nested-clients`（Apache-2.0）；`@earendil-works/pi-ai`、`@earendil-works/pi-telemetry`、`@koromix/koffi-linux-x64`、`data-uri-to-buffer`、`standardwebhooks`（MIT）；`@img/sharp-libvips-linux-x64`、`@img/sharp-libvips-linuxmusl-x64`（LGPL，许可写在 README 里）。Windows、macOS 上对应的平台包名不同，由构建脚本按最终产物重新列。这些包在声明里补上许可原文或指明许可名称与来源。
6. **conpty**：node-pty 在 Windows 上带的 `conpty.dll`、`OpenConsole.exe`（来自微软 Windows Terminal，MIT）没有许可文件。根依赖里的 node-pty 1.1.0 也经 extraResources 带了同样的文件（`electron-builder.yml:90-95`），现有 `THIRD_PARTY_NOTICES.md` 里没有这一项，属于既有缺口，这次一并补上。
7. **pnpm**：包里只有 pnpm 自己的 MIT LICENSE，`dist/pnpm.mjs` 是打包过的，里面合进了多少第三方代码、需不需要额外声明，本次没核。

## 3. 建议的做法

- **构建时保留**：所有 `LICENSE*`、`LICENCE*`、`COPYING*`、`NOTICE*` 文件，不论在哪一层；`@img/sharp-libvips-*` 的 `README.md` 与 `versions.json`。
- **构建时生成**：`resources/dsh-host/THIRD_PARTY_LICENSES.json`，按最终产物逐包记名称、版本、`license` 字段、许可文件相对路径（没有则为 null）。
- **`THIRD_PARTY_NOTICES.md` 新增「DeepSeek Harness host」段**：DeepSeek 与 cordis 的 MIT 原文；说明逐包许可文件原样保留、清单见上面的 JSON；列出非 MIT / Apache 的几组（libvips 一组、landlock-run 的 BSD-3、Python-2.0、Unlicense、0BSD、BSD-2）；补齐 §2 第 5、6 条的原文或出处。现有「Other bundled dependencies」段（`THIRD_PARTY_NOTICES.md:103-110`）要把 `src/dsh-host/package-lock.json` 加进它点名的锁文件。
- **校验**：`verifyDshArtifact` 要求许可清单存在、每个包都有 `license` 字段；DeepSeek、cordis、koffi、node-pty、sharp、pnpm、`@vscode/ripgrep` 必须带许可文件；`checkLegalNotices` 加 DeepSeek 署名。
- 依据：DSH 仓库本身是 MIT，`0.1.0-rc.2` 起全部包为 MIT（[可行性调研 §2](../../../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)），可闭源二开，只需保留版权声明。
