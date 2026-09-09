# P5-2 完整复刻任务与验收矩阵

2026-09-09 · Role: implementation-plan · Status: 范围确定、尚未实现
[看板](../README.md) · [ARD D10/D17](../../../../plans/2026-09-08-runtime-evolution-ard.md) · [调研](p5-2-subagent-research.md) · [契约](p5-2-subagent-contracts.md)

## 顺序与责任

Claude 当前负责 P4；本次只做 P5 调研/文档。P5-2-0 的只读差异核对可并行；生产实现等 P4 接缝稳定后开展。
实施按下表逐批落地，但交付目标是**整个 subagent 子系统**。后面的 UI/兼容性/验收是同一工作体，不属于可省略的“优化”。
P5-1/P5-3/P5-5 独立演进；subagent 的必需定义/模型解析不能等待模型目录最终切源才提供，无需导入整个插件平台。

| 批次 | 状态 | 责任范围/建议落点 | 必交产物与完成条件 |
|---|---|---|---|
| P5-2-0 基线冻结与适配勘察 | ⬜（本轮已完成源码调研） | docs + 独立探针 | 固定测试输入与执行配置（不新增版权、许可证或来源版本记录，不设许可证审批）；0.85→0.84.4 的事件/afterToolCall/并行/取消探针；P4 接缝、BrowserPreview/Bash/旧插件差异明确。不得未经记录升级 D12 |
| P5-2-1 定义与模型目录 | ⬜ | shared 定义协议、runtime/plugins/subagent/definitions、model-adapter | 四内置角色完整迁移；字段/限制/模型优先级/诊断/快照；global > builtin、禁项目自动加载；显式 model 失败不回落 |
| P5-2-2 子 Agent 与后台编排 | ⬜ | runtime/plugins/subagent、agent-loop、context | 独立 Agent、registry、四工具、10 并发、wait all/any、Stop 收敛、自动报告交回、无 idle/duration 终止、maxTurns、完整提示词 |
| P5-2-3 权限、工具及重试依赖 | ⬜ | permissions/tools、HostIo/Exec、必要 Main preview 门面 | 七工具适配（含 BrowserPreview 和角色所需正则检索）；长命令显式超时能力；inherit/显式 gear、审批归属/取消、共用写锁；重试共预算、禁止工具重放 |
| P5-2-4 会话、事件与 usage | ⬜ | session/events、shared DTO、Main 索引桥 | 子行归属/独立结算、父上下文隔离、完整历史与终态、成本恰计一次；关闭/崩溃/重开不伪续跑；内部报告不变成用户任务 |
| P5-2-5 定义管理与旧资源迁移 | ⬜ | Main 管理服务/IPC/preload、资源管理/设置 UI | 创建/编辑/重命名/删除/启停/搜索/定位；字段往返、原文件保护、下一 run 热加载；旧全局迁移预览，legacy/native 工具互斥 |
| P5-2-6 运行/历史展示闭环 | ⬜ | subagent.activity store/model、Chat UI/历史投影 | fan-out 与单任务卡、真实状态/时长、权限等待、报告一次、完整历史按需读取、滚动跟随、重载恢复；不能以已有 T34 面板替代验收 |
| P5-2-7 全量等价门禁 | ⬜ | 本批全部调用面、离线集成、GUI/打包载体 | 下表全部逐项签收；所有适配差异有理由/测试/证据；完成完整基线后才关闭 P5-2 |

依赖：0→1→2；3 与 2 的具体工具/权限接线需协调；4 依赖 2/3；5 可在定义协议冻结后独立施工；6 依赖 4；7 等 1–6 全部完成。
若多人实施必须按文件归属协调，不同时改同一个 bootstrap/contracts/agent-loop；不能以“P4 已有人改”删掉未来必须接通的行为。

## 必须验收的场景

| ID | 对照场景 | 必须得到的结果/证据 |
|---|---|---|
| SA01 | 四角色与全字段定义解析 | 工具集/60,50,40,80 turns/模型与权限精确；none/0/未声明无限轮；坏文档诊断且其余可用 |
| SA02 | 来源/库存与目录限额 | 全局覆盖 builtin、重复确定顺序、管理 64/runtime 16/provider 8/32KiB；禁项目自动加载；清理不存在文件的状态 |
| SA03 | Task 后主代理继续自身工作 | ack 在子完成前返回；工具 ack ok 不等于子 completed；同名任务有独立 id |
| SA04 | 并发准入/注册表回收 | fake Agent 同时 10 个，第 11 个明确失败；释放可再启动，失败请求不占名额；仅已结束项按 100 回收 |
| SA05 | all/any/minCompleted/重读 | 等待条件精确、输入/未知 id 可诊断；超时不 cancel；结果可按 id 再读且不重新执行 |
| SA06 | 父 idle 时子任务未完成 | 主 run/槽保持 busy、无 completed/idle；完成后自动回父；不需要用户输入“继续” |
| SA07 | 交付竞态 | 子先完成、边界同时完成、TaskWait 已消费、报告裁剪后再读；不漏最终报告、不重复启动/结算/计费 |
| SA08 | Stop 与完成/等待/审批竞态 | 子停止实际完成后稳定结果；用户 Stop 不再自动调用父模型；取消不影响另一会话，重复 Stop 幂等 |
| SA09 | 长任务与 maxTurns | 假时钟越过旧 idle/duration 不杀 Agent；长 bash 按显式工具 timeout；maxTurns 截断有报告/状态；无上限定义可被 Stop |
| SA10 | 权限与模式 | agent 的三 gear×inherit/显式 override；plan 无 Task*；deny/路径/工具集不越界；并发不同 gear 不串；审批来源正确 |
| SA11 | 写序与 stale read | 父子同路径 Write/Edit 顺序明确，失败释放锁，Linux 大小写/符号链接正确；不同路径并行；不得称 Bash 有全仓事务保护 |
| SA12 | 模型与 thinking | Task override > pin > parent；明确不可用不回落；相同 pin 复用绑定、能力裁剪；密钥不出现在事件/定义 UI |
| SA13 | 瞬态/429/流中失败 | setup+stream 共预算；非恢复错误直接失败；恢复消息不重复、已执行工具不重放；退避可停止 |
| SA14 | 归属与父终态隔离 | 子 text/thinking/tool/result/失败不进入父消息流；子 agent_end 不结束父 run；子过程保存但不进父压缩输入 |
| SA15 | usage 与报告限额 | 父 provider 原数不变、子成本恰计一次；12k/50k、details/IPC 限额明确；截断不丢终态/完整历史入口 |
| SA16 | 保存/恢复/切分支 | 正常关闭排空；硬退出未结算标中断、不重放 Task/工具；历史报告/归属/成本还原；活跃期不导航 |
| SA17 | 管理 UI 全链路 | CRUD/改名/启停/模型清空/无限轮/搜索/定位；失败回滚、逐行 busy、刷新不闪空、重启状态保留；permission 未编辑不丢 |
| SA18 | 运行 UI 与重载 | Task immediate ack、fan-out、多同名、晚到终态、权限等待、非尾部更新、报告只一次；局部滚动、退出自动跟随；历史重载状态正确 |
| SA19 | 旧插件/定义迁移 | legacy 保持原目录/开关语义，native 不重复注册；显式迁移预览、冲突与不可兼容字段可见、原文件不覆盖 |
| SA20 | BrowserPreview 依赖 | 自定义子代理声明并预览工作区 HTML，编辑自动刷新，后台不抢前台；禁用/不可用明确错误；不能始终报 unsupported 代签 |
| SA21 | SDK/两载体/退出 | Pi 0.84.4 实际循环与完整事件；electron-utility/Windows bundled-node 均跑后台委派/审批/写入/取消；无残留子命令进程 |
| SA22 | 完整功能基线验收 | 固定输入、定义、模型替身与验收标准；保留 trace、录屏或截图及成功、失败、取消、性能数据；SA01～21 逐项关联实现与测试证据，不存在无解释缺项；不新增版权、许可证或来源版本记录 |

## 验证分层

1. 上游案例迁移为可执行行为测试；纯源码字符串断言只能证明接线，不能签收生命周期。
2. 每批小量串行 Vitest（maxWorkers=1、no-file-parallelism、Node 堆上限）；10 并发采用轻量闸门，不在本机跑十个真实重任务。
3. fauxProvider/本地 HTTP SSE 桩跑真实父子 Agent，验证请求顺序、工具只执行一次、完整会话持久化及索引终态。
4. 管理 UI 与聊天 UI 做实际交互/重载，最后在两载体打包环境补新增 subagent 专项。P4 老结果不能代签 P5 新代码。
5. 证据逐行标 implemented/tested/GUI/carrier/Done；缓存性能优化和真实多模型成本对比在完整基线后另开批次。

## 下一阶段：完整基线上优化（未开工）

整体基线签收后，再讨论并发资源自适应、报告/前缀成本、调度公平性、历史分页性能；不预先改变 10 并发/角色/等待和管理能力。
优化需提供对照 trace、收益、行为差异和回退；不得把“只实现一部分”包装成优化。
