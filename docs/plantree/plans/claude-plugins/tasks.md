# Claude 插件与 MCP：任务阶段清单

分支 `feat/claude-plugins`（worktree `../ai-client-claude-plugins`），从 main `14628143` 开出。方案见 [README](README.md)。

- **当前阶段**：5 验收
- **下一步**：真模型跑一遍插件命令；Windows、加密机。分支已推送（未开 PR、未触发 CI），暂不合入 main
- **约定**：每完成一个大阶段，本地提交一次并更新本表；推送、出测试包前先问用户

| 主任务节点 | 节点子任务 | 完成状态 | 简要内容 |
|---|---|---|---|
| **0 方案** | 随包 CLI 插件子命令实测 | ✅ | 2.1.300 全流程跑通，JSON 形状记在 README §2 |
| | 交互预览 | ✅ | `docs/design/2026-10-29-claude-plugins-preview.html` |
| | 用户选定 | ✅ | 官方市场不预置；MCP 只做 Claude；内核只升 Claude SDK；插件与 MCP 全放「插件」页（2026-10-29） |
| **1 升级 Claude SDK** | 0.3.300 → 0.3.312 | ✅ | 内置 CLI 2.1.312；依赖集合不变（112 个） |
| | 宿主 typecheck、单测、probe-suite、event-record | ✅ | 单测 224 过；probe-suite 11 组全过（改了探针里的 sleep，见 README §7）；event-record 的差异 main 上 0.3.300 同样有，与升级无关 |
| **2 Main 服务** | `ClaudePluginService` 调 CLI | ✅ | 配置目录、代理、串行执行、超时（`src/main/services/claudePlugins/`） |
| | 读插件目录得到「里面有什么」 | ✅ | 技能、命令、子代理、钩子、MCP 服务 |
| | IPC、预加载、共享类型 | ✅ | `claudePlugins.*`、`claudeMcp.*` |
| | 改动后清斜杠菜单缓存 | ✅ | `ClaudeSdkCommandCatalog.clear()` |
| | 测试 | ✅ | 15 个，含本机目录假市场 + 真 CLI |
| **3 界面** | 「Claude 插件」一节 | ✅ | 已装插件、仓库声明的插件、生效提示 |
| | 浏览对话框、市场对话框、卸载确认 | ✅ | 「⋯」菜单改成两个图标按钮（检查更新、卸载） |
| | 中文词条 | ✅ | 挂载测试 7 个 |
| **4 MCP（Claude 对话）** | 去掉 `strictMcpConfig`，照官方读三层配置 | ✅ | README §6.1：仓库 `.mcp.json` 的服务器打开即启动 |
| | 「Claude MCP 服务」一节，CLI `claude mcp` 管理 | ✅ | 只显示环境变量与请求头的名字 |
| | MCP 工具的审批卡与工具行实测 | ✅ | 探针里出卡、允许后有结果；界面待真机看 |
| | 假 MCP 服务器探针 | ✅ | probe-suite 新增 `mcp` 组 |
| **4b 调整** | 插件、MCP、Pi 插件搬到「插件」页；去掉侧栏「能力」按钮 | ✅ | 用户 2026-10-29 |
| | 修配置目录函数自己调自己（栈溢出） | ✅ | 新增 `claudeSdkConfigDir.test.ts` |
| | 「扩展」页改名「技能」，侧栏入口改为「技能」 | ✅ | 用户 2026-10-29 |
| **5 验收** | 本机真机 | ⬜ | 装官方市场插件，新对话里能用它的命令；加一个 MCP 服务，新对话里能调它的工具 |
| | Windows、加密机 | ⬜ | git 克隆、插件缓存读写 |
| | 合入 main | ⬜ | 先问用户 |
