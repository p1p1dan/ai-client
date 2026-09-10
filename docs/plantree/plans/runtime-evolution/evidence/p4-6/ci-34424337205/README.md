# test.13 CI 固定核对记录

Role: evidence。核对日期 2026-09-10；当前进度见[核心任务树](../../../README.md)。
通过 gh run view 与 artifacts API 只读查询，未触发新构建、未下载大型安装包。

- [CI 34424337205](https://github.com/p1p1dan/ai-client/actions/runs/34424337205)：completed / success，源码 `c0ae2a34c6e6c855668000f0b407f9bd516fa678`。
- 包版本：1.0.0-test.13，版本提交 `913e9812`。
- gate（类型检查/lint/test/runtime smoke/metadata）、build-app、remote-runtime-linux x64/arm64、Windows/Linux/macOS 构建成功。
- 三平台 Verify packaged Pi worker 步骤成功；本次未下载各 worker 原始 JSON，不扩写其断言细节。generate-release-notes skipped。
- Windows [installer](https://github.com/p1p1dan/ai-client/actions/runs/34424337205/artifacts/10132331987)、[portable](https://github.com/p1p1dan/ai-client/actions/runs/34424337205/artifacts/10132334791)、[unpacked](https://github.com/p1p1dan/ai-client/actions/runs/34424337205/artifacts/10132347481) 查询时存在且未过期。
- 未找到该包的现场复验记录；已存在现场报告针对 test.11 / test.12。

## 源码覆盖

包含 EFFORT-1、默认 medium、TUI-1 方案 C、PERM-1、F2-a/c、F7f。
不包含 `a3debdf6` 的 F7b 去重、`db175931` 的结构化权限链、`f62b6af4` 的权限卡重画。
源码已提交、包已生成与现场通过分别记账。
