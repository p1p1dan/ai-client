# dev-D4-reverify — 批次 D4 九项修补（T060～T068）的真机复验证据

2026-09-17 13:14～14:10，Linux 开发机（2 核 / 3.3 GB），HEAD `b3d751e3`，分支 `feat/runtime-evolution`，
**工作区带九项未提交修补**，dev 模式跑的就是工作区代码。三次起停、全程假网关、逐条还原。

结论草稿：`/tmp/t032/sections/D4-reverify.md`（九项各一节 + 未生效清单 + 环境交代）。

| 项 | 结论 | 主要证据 |
|---|---|---|
| T060 / DEV-2 + D6 | ✅ | `T060-t0-roots.txt`、`T060-t1-after-gui-change.txt`、`T060-D6-after-repo-removed.png` |
| T061 / DEV-33 | ✅ | `T061-01`～`T061-04` 截图、`T061-jsonl-attachment-names.txt` |
| T062 / DEV-32 | ⚠️ 半生效 | `T062-result.txt`、`T062-01-model-missing-composer.png` |
| T063 / DEV-3 | ✅ | `T063-t0`～`T063-t3`、`T063-01-delete-confirm.png` |
| T064 / DEV-4 | ✅ | `T064-result.txt`、`T064-01-draft-restored.png` |
| T065 / DEV-14 + DEV-16 | ⚠️ D18 与关窗文案成立，**D17 未生效** | `T065-D17-result.txt`、`T065-*.txt/png`、`T065-tui-events.txt` |
| T066 | ✅ | `T066-logs-run1.txt`、`T066-logs-run2-run3.txt` |
| T067 | ✅ | `T067-02`～`T067-06` 截图 |
| T068 | ✅ | `T068-01/02` 截图、`T068-question-card-computed.json`、`T068-permission-card-computed.json` |

环境与还原：`env-teardown.txt`。
