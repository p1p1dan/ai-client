# PiLab 插件机制：任务阶段清单

分支 `feat/mobile-remote`。方案见 [README](README.md)；手机远程是第一个插件，见 [../mobile-remote/](../mobile-remote/tasks.md)。

- **当前阶段**：插件机制全部完成（只差加密机现场验证）；下一步做第一个插件「手机远程」
- **最近落地**（2026-10-23）：合入 `feat/ui-cohesion`（界面建在新样式上）`d2da194e`；插件页 `9581ff93`；桌面接管 `fe7386f7`；接口 `4af2e5b4`；对话接管主进程 `4921decd`；插件包与安装 `c3f6518f`；插件进程 `5d343403`；宿主 API 分发 `5fcc5105`；插件管理 `af8f65d2`；接入应用与打包 `c5593d30`
- **约定**：每完成一个大阶段，本地提交一次，并更新本表与 README；推送与出测试包先问用户

## 待办

1. 当前：手机远程插件 `pilab.remote-access`（见 ../mobile-remote/tasks.md）
2. 加密机现场验证（随下一个 Windows 测试包）

| 主任务节点 | 节点子任务 | 完成状态 | 简要内容 |
|---|---|---|---|
| **0 方案** | 参考 PI-Desktop、定差异 | ✅ | 插件进程用打包 Node；第一版只做 settings / services 贡献点 |
| | 用户确认 | ✅ | 2026-10-23 |
| **1 接口** | 清单 schema v1、宿主 API v1、帧协议、插件页 IPC | ✅ | `src/shared/plugins/`；对话调用分三类：只认操作方的改动、插件可读、插件可改 |
| **2 运行时（A）** | 安装与校验 | ✅ | `.pilabplug` 自写解包（路径穿越、条目数、大小、校验和）；新装默认停用；更新保留启用状态与数据 |
| | 插件进程与 RPC 桥 | ✅ | 打包 Node 启动 `src/plugin-host/pluginHost.ts`（打包后 `resources/plugin-host/pluginHost.mjs`）；只传白名单环境变量；启动 15s、服务 5s 时限 |
| | 宿主 API 分发 | ✅ | 声明的权限 → 参数检查 → 改动写审计 `plugins/audit.jsonl`；每个客户端单独的负数 owner id |
| | 常驻服务监管 | ✅ | 崩溃后 1/2/4/8/16s 重启，5 次后停在失败；连续运行 60s 重新计数；对话日志只在有 `chat.read` 插件运行时记录 |
| | 接入应用 | ✅ | 启动时运行已启用插件（不挡窗口）、退出时停止；`window.electronAPI.plugins` |
| **3 对话接管（C）** | 主进程操作方与拦截 | ✅ | 改动类调用只认操作方，停止和只读两边都行；`chat:takeOverSession`、操作方变化推送给窗口与插件 |
| | 桌面只读与「接管」 | ✅ | 用户选方案 A：输入框换成一条「正在 xx 上使用，这里只能看进度 · 停止 · 接管」；待回答的卡片只读（inert）；侧栏行尾手机图标 |
| **4 插件页（B）** | 安装、启停、卸载、权限、服务状态、设置表单 | ✅ | 设置 → 插件：从文件安装、启用前确认权限与网络、展开看设置项（口令不回显）、服务状态、出错原因与重新启动、卸载确认 |
| **5 开发标准** | 示例插件、打包脚本、开发说明 | ✅ | `plugins/example-hello/`（测试里真跑）、`scripts/pack-plugin.ts`、`docs/plugins/developing-plugins.md` |
| **6 现场验证** | 加密机上插件文件可读、打包后的插件宿主 | ⬜ | 见 README §7，随下一个 Windows 测试包 |
