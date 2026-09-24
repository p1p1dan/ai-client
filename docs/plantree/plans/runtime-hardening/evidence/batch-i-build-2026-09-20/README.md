# 批次 I 打包构建（2026-09-20）

Role: evidence。记录批次 I 十三项修复推送后的打包事实。上位：[批次 I 证据](../batch-i-user-feedback-2026-09-19/README.md)。前一次打包：[batch-h-build-2026-09-19](../batch-h-build-2026-09-19/README.md)（`1.0.0-test.14`）。

## 推送

分支 `feat/runtime-evolution` 从 `058fc70f` 推进到 `156b038e`，共 14 个提交（批次 I 的 13 个 + 版本号提交）。推送前按用户要求先递进版本：`156b038e chore: 版本更新至 1.0.0-test.15`。

## 构建

| 项 | 值 |
|---|---|
| 运行 | [35478806840](https://github.com/p1p1dan/ai-client/actions/runs/35478806840)（`workflow_dispatch`，分支 `feat/runtime-evolution`） |
| 源码 | `156b038e`（批次 I T091～T103 全部 + 版本号） |
| 版本 | `1.0.0-test.15` |
| 首次结果 | gate 4m02s / build-app / remote-runtime-linux x64 + arm64 / build-linux 5m36s / build-windows 7m41s 全部 success；**build-macos failure**：应用已打好，最后一步 DMG 制作 `hdiutil: create failed - Device not configured`（GitHub macOS runner 的偶发问题，与源码无关；同 job 前面「Failed to read package.json for node_modules/.pnpm/…」是 electron-builder 的告警，上一版也有）。release-notes 按设计跳过（非 tag 运行） |
| 重跑 | `gh run rerun --failed`，结果见末尾追记 |

## 产物（首次运行）

| 产物 | 大小 |
|---|---|
| `windows-installer`（`AiClient-Setup-1.0.0-test.15.exe` + `.blockmap`） | 180 MB |
| `windows-portable`（`AiClient-1.0.0-test.15-portable.exe`） | 179 MB |
| `windows-unpacked` | 262 MB |
| `linux-packages` | 362 MB |
| `remote-runtime-linux-x64` / `-arm64` | 45 / 45 MB |
| `app-build` | 7 MB |
| macOS | 见追记 |

## 打包态 worker 冒烟

Windows 与 Linux 的 `Verify packaged Pi worker` 均 `failures=[]`、报告项 `ok=true`、`backend=native`。原文见同目录 `worker-smoke-Windows.json` / `worker-smoke-Linux.json`。macOS 见追记。

## 本次打包携带的 runtime 变化（Windows 复验时注意）

- 首字节 / 空闲超时默认 120 秒（设置 → Pi → 模型请求超时可调可关），worker 启动时读一次；判据是主日志 `provider retry n/3 in … after Nms (status=none code=TIMEOUT)`。
- 工具行在参数流式期即出现（`AICLIENT_STREAM_TOOL_ROWS=0` 可回旧行为）。
- 查看历史会话不再起 worker（有活 worker 时仍走老路）。
- undici dispatcher 打进 `worker.js`（+约 1MB）；打包脚本的 `WORKER_BUNDLE_BANNER` 不能去掉，否则超时静默失效。

## 下一步

Windows 复验批次 I 十三项（尤其 #1 处理中新建、#3 结束对话 / 看历史、#5 超时与倒计时、#7 文件树、#9 迁移面板、#10 工具行）。

## 追记（2026-09-24 补登）

本目录此前一直是未跟踪文件，2026-09-24 随批次 M 收口一并提交；两份 worker 冒烟 JSON 按仓库 Biome 规则重新格式化，内容未变。macOS 重跑的结果当时没有回填，现已无从核对；此后 `d0d129bc`（2026-09-23）已停止 macOS 版本发布。
