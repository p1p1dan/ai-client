# 发布与构建流程

> 适用：所有需要 CI 出发行包的项目（electron / npm package / native binary 等）

1. 【规】构建系统出错时，优先"回退到已知工作状态"而非"修补新状态"。Runner image / toolchain / SDK 升级常引入兼容性 regression，在没找到根因前 pin 旧版本（如 `runs-on: windows-2022` 而非 `windows-latest`）远比尝试 patch 新环境更可靠。修复完后再单独立项升级。(源:vflow / 06-16 v0.3.0-v0.3.4 事故)

2. 【规】发布 tag 前必须在**不创建 release** 的模式下验证 CI 完整链路。具体做法：`build.yml` 配 `on: workflow_dispatch`，用 `gh workflow run` 触发 dry-run 验证 build 全绿后**再**打 tag 推送触发"真发布"。杜绝"CI 一过就立即 published 推用户"事故。(源:vflow / v0.3.2 broken release 事故)

3. 【规】对发行包做任何"跳过 / 简化 / 优化"前，必须先写出**这一步原本做了什么**的全列表，逐项检查"我要改的优化会破坏其中哪一项"。打包链路的命令往往兼有多个副作用，看名字直觉判断"它只是 rebuild"是典型陷阱。(源:vflow / v0.3.2 事故：跳过 `electron-builder install-app-deps` 导致 sqlite3 native binding 缺失)

4. 【规】对已 published 的 release 立即下线的应急方法：`gh release edit <tag> --draft=true` 把它从 latest 摘下来，electron-updater 即刻停止把它当更新源；配合 `gh release edit <prev-tag> --latest` 强制旧版本重新标 latest；最后 `gh release delete <tag> --cleanup-tag` 彻底清掉 release + tag。这一组操作是发布事故的标准急救流程。(源:vflow / v0.3.2 事故急救)

5. 【建】CI 失败时，失败 commit + 它的修复 commit 不要混用版本号或复用 tag。每个修复 commit 都 bump patch version（0.3.1 / 0.3.2 / 0.3.3...），不要 amend 也不要 `git tag -f`。版本号增长成本极低，但可追溯性极高，事故复盘时定位窗口非常重要。

6. 【建】当多个不同根因的失败同时出现（如同一次 CI build 中 Linux 一种死法、Windows 另一种死法），先把每个失败的根因独立诊断清楚，分开打补丁。捆绑修复一旦其中一处反复出错，难以分清是新引入还是旧问题。
