# D4 — 认证双路径：企业自动注入 + 本地 GUI 配置窗口

> **状态：Revised（2026-08-31）**
>
> 双路径产品语义继续有效，但原文“企业/本地都写 `~/.pi/agent/settings.json`”已被实现事实修订：managed/login 使用 `~/.pilab/<profile>/pi-agent/` 的隔离 agentDir，`models.json` 与 `auth.json` 分离；local/BYOK 使用用户自己的 Pi setup，应用不接管其整棵配置。凭据 vault 位于 `~/.pilab/<profile>/credentials/vault.json`，key 不进入 models.json。
>
> WorkerSlot/TUI 启动按 credential mode 注入正确 agentDir/environment；Main-owned credential mode 不允许 renderer 整份 settings 写回覆盖。模型同步、catalog 和 effort 以 D8/T19–T25 已落实现为准。

**原状态**：已拍板（2026-08-28）

## 原决策（保留历史背景）

沿用现有双路径登录设计，适配 pi 后端：

### 企业登录路径
用户点主按钮 → 服务器返回 url + key + 可用模型列表 → 写入 `~/.pi/agent/settings.json`。
后期增加管理面板：管理员控制可配置模型、用户可用模型，每次启动拉取更新配置。

### 本地配置路径
提供 GUI 模型配置窗口，字段包括：
- 提供商（下拉：OpenAI / Anthropic / Google / Azure / 自定义）
- 接口地址（URL）
- API Key（带显隐切换）
- 模型名称
- 高级配置：工具调用 / 图片输入 / 思考模式 / 自定义协议 / 输入输出 token 限制

保存到 `~/.pi/agent/settings.json`，pi SDK 直接读取。

## 参考

用户提供的配置窗口截图（legacyvps.com 风格：提供商下拉 + URL + Key + 模型名 + 高级配置复选框 + token 限制按钮组）。

## 与 unified-credentials 的关系

现有 unified-credentials 计划的 S4（为 pi 预留 vault arm）对接此决策。企业路径的凭据注入机制需要与 `~/.pilab/<profile>/settings.json` 协同。
