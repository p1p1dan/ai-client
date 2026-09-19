# 批次 H + T090 打包构建（2026-09-19）

Role: evidence。记录 T033 第二轮上机前的打包事实。上位：[批次 H 证据](../batch-h-field-fixes-2026-09-18/README.md)、[09-19 点验证据](../batch-h-devbox-pointcheck-2026-09-19/README.md)。前一次构建见 [batch-e-build-2026-09-18](../batch-e-build-2026-09-18/README.md)。

## 构建

| 项 | 值 |
|---|---|
| 运行 | [35442564448](https://github.com/p1p1dan/ai-client/actions/runs/35442564448)（`workflow_dispatch`，分支 `feat/runtime-evolution`） |
| 源码 | `e451aca8`（含批次 G / H 全部、T090 四修复、版本号提交 `d2c63372`、门禁修复 `e451aca8`） |
| 版本 | `1.0.0-test.14`（从 `test.13` 递进，避免再出现同名产物只能靠 SHA256 区分） |
| 结果 | gate / build-app / remote-runtime-linux x64 + arm64 / build-linux / build-windows / build-macos 全部 success；release-notes 按设计跳过（非 tag 运行） |

前一次尝试 [35441375128](https://github.com/p1p1dan/ai-client/actions/runs/35441375128)（源码 `d2c63372`）在 Gate 4/7 lint 失败：归档的点验探针 `.mjs` 有 Biome 错误，而 lint-staged 的匹配不含 `mjs`，本地提交时未被拦下。`e451aca8` 逐条修正并把 `mjs` / `cjs` 加进钩子匹配，证据 `artifacts` 目录整体排除检查以免改写原始字节。

## 产物

| 产物 | 大小 |
|---|---|
| `windows-installer`（`AiClient-Setup-1.0.0-test.14.exe` + `.blockmap`） | 179 MB |
| `windows-portable`（`AiClient-1.0.0-test.14-portable.exe`） | 178 MB |
| `windows-unpacked` | 261 MB |
| `linux-packages` | 362 MB |
| `macos-arm64-packages-unsigned` / `macos-arm64-unpacked-unsigned` | 401 / 440 MB |
| `remote-runtime-linux-x64` / `-arm64` | 45 / 45 MB |
| `app-build` | 7 MB |

## 打包态 worker 冒烟

三平台 `Verify packaged Pi worker` 均 `failures=[]`、报告项 `ok=true`、`backend=native`。原文见同目录 `worker-smoke-Windows.json` / `worker-smoke-Linux.json` / `worker-smoke-macOS.json`。

## 下一步

T033 第二轮上机：用 `windows-installer`（或 portable）验证批次 H 十项 + T090 四项，以及只能在 Windows 加密机做的 MODEL-33～36 / WIN-37。执行单 [t033-field-day-runbook.md](../../topics/t033-field-day-runbook.md)。
