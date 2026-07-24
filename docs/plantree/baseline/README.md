# Baseline — 项目全局事实

> 与具体计划无关的稳定事实。计划文档链接这里，不复制。
> 术语表在仓库根 [`CONTEXT.md`](../../../CONTEXT.md)。

| 文件 | 内容 |
|---|---|
| [module-map.md](./module-map.md) | 四进程/分层模块图与红线区域 |
| [runtime-flows.md](./runtime-flows.md) | 聊天发送 / Permission / Question / Resume / 看门狗事件流 |
| [storage-and-state.md](./storage-and-state.md) | 持久化位置与状态归属 |
| [test-and-release-gates.md](./test-and-release-gates.md) | 三绿 / Host smoke / 打包断言 / CI / 提交规范 |
| [risk-hotspots.md](./risk-hotspots.md) | 加密机、格式漂移、网关、SDK 不变量 |

技术栈：Electron 39 + React 19 + TS 5.9 + Tailwind 4 + zustand + vitest + biome；
Agent Host 为外部 Node 24 进程（Agent SDK 0.3.218 + Cometix pin 2.1.212）。
