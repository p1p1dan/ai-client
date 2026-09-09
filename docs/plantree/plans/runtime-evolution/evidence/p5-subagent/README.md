# P5 subagent 调研证据

2026-09-09 · **仅调研与规划完成，P5-2 未实现**。
[源码调研](../../topics/p5-2-subagent-research.md) · [完整契约](../../topics/p5-2-subagent-contracts.md) · [任务矩阵](../../topics/p5-2-subagent-tasks.md)

## 固定参考

- PI-Desktop：`948ee676bdb7b31d496f6603aa03dd12eb95be35`，本地 `/home/pi/code/PI-Desktop`；未修改参考仓，未读取其未跟踪 RequirementNote.md。
- 源码、测试与 ADR 的不可变链接和 SHA-256：[reference-sources.json](reference-sources.json)。这是参考清单，不代表其中每套测试都已执行。
- Pi core/ai 0.85.0 与本仓 0.84.4 的版本差列入适配门禁；用户确认组织内部测试、不对外分发，可直接复用。本轮不新增版权、许可证或来源版本记录，不设许可证审批。未修改依赖或许可证。
- pi-app 的 worker dispose/incomplete recovery 仅作退出语义参考；pix session-dir/session test 的整包目录自动回落不采用。二者不替代本批主参考 PI-Desktop。

## 实际执行

在参考仓，Node 24.20.0、768 MiB 堆、单文件并发：

```bash
NODE_OPTIONS=--max-old-space-size=768 node --experimental-strip-types \
  --test --test-concurrency=1 \
  apps/desktop/test/subagent-topology.test.mjs \
  apps/desktop/test/subagent-transcript.test.mjs \
  apps/desktop/test/subagent-wiring.test.mjs
```

**3 文件 32 项通过**，exit 0。[完整输出](reference-tests.txt)
11 项是纯 topology 的状态/归属/时长归约；21 项是源码接线和 UI 结构断言。
不能据此宣称父子 Agent、provider 重试、Rust 管理服务、真实 GUI 或打包载体已通过。
未安装依赖、未访问线上模型、未跑重型构建。其余 runtime/定义/锁/重试测试已读对应案例并纳入 SA01～22，留给实现期复跑。

## 文档核对

当前活跃 D10/P5-2 已不再使用旧并发 4、idle/duration 杀任务或“渲染层不用动”作为施工条款；旧内容保留在历史快照并明确已替代。
D17 和契约明确完整复制先于优化；BrowserPreview、管理 UI、legacy 迁移、长任务、usage/历史与取消均有责任节点和验收行。
并行 P4-1～3 在调研期间由 Claude 提交，现行看板进度保留；本批没有修改其源码、提交或回退其工作。

文档检查：[document-checks.json](document-checks.json)。11 份文档、8 批任务和 22 项验收编号核对通过；新增链接无缺失、49 份参考文件哈希一致。
旧调研文档有两条指向本 checkout 未包含的其他计划的历史链接，已在检查记录中单独列出，本轮没有迁移那些独立计划。

## 用户补充：执行约束

用户确认仅组织内部测试、不对外分发；适合直接搬用的代码、提示词和测试直接复用。执行过程中不新增版权、许可证或来源版本记录，不设置许可证审批或阻塞。
部门内部实验由用户自行组织，不列入本计划、TODO 或验收矩阵；本计划只负责子系统实现与功能验证。
