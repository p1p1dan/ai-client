# S04 失效设置清理

日期：2026-09-07。实现已写入工作区，验证进行中，尚未合入。

## 删除范围与行为

| 设置 | 处理 | 兼容行为 |
| --- | --- | --- |
| `agentNotificationEnabled` / `agentNotificationDelay` / `agentNotificationEnterDelay` | 删除 General 通知分段、选项数组、类型、默认值、setter 与专用闲置翻译 | 扩展系统通知入口保持现有行为；旧键在水合及磁盘清理时移除 |
| `fileTreeAutoReveal` | 删除类型、默认值、setter 与 FilePanel 设置订阅 | 旧壳文件树固定保留此前默认的自动定位行为 |
| `terminalInput` 两个增强输入字段 | 删除类型、默认值、setter、旧迁移转换和 AgentPanel 的增强输入挂载与测高链路 | 删除唯一挂载的 EnhancedInputContainer；旧 profile 中的 terminalInput 及 claudeCodeIntegration 不再恢复增强输入设置 |

`EnhancedInput` 本体与其他旧壳组件的进一步清理仍属于 S05；本次没有删除旧壳。

## 回归覆盖

新增 `src/renderer/stores/settings/__tests__/removedSettings.test.ts`：

- 静态不变量：类型、默认值、store、通知设置 UI 不得恢复已删除字段与 setter。
- 使用实际 Settings Store 初始状态验证旧 profile 水合，覆盖语言、终端回滚、编辑器、代理与 Pi 模型配置保留。
- 验证水合不修改输入 profile，重复迁移结果一致，缺失 profile 保持默认状态。
- 验证磁盘清理仅移除废弃字段，保留持久化版本和其他命名空间，第二次清理不重复写入。

## 验证环境

- 当前主机 RAM 约 1.9 GiB，初次检查可用约 940 MiB；根分区可用约 11 GiB。
- checkout 初始没有 node_modules，也没有全局 pnpm。
- 使用 npm exec 运行 packageManager 指定的 pnpm 10.26.2，按 frozen lockfile 安装依赖；跳过安装脚本，不运行原生模块或 Electron 构建。
- 基础依赖按锁文件安装；S01 随后增加 happy-dom 测试依赖，详见对应证据。
- 相关测试：removedSettings、migration、defaults 三文件，5 个测试全部通过；使用单 worker、禁用文件并行。
- 改动涉及的 9 个源码文件通过 Biome，`git diff --check` 通过。
- 全量 `tsc --noEmit` 通过，Node 堆限制 896 MiB；检查结束后进程正常退出。
- 首次全仓 Biome 的唯一错误是既有 `src/renderer/components/chat/extensionUiDisplayModel.ts:354` 格式问题；后续单行等价格式修正后，全仓检查通过。
- 全仓测试已分批执行，剩余环境相关失败见 implementation-status；S04 保持 In Progress，未声称完整门禁通过。
