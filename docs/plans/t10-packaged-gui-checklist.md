# T-10 打包版 GUI 手工点验清单（M1 后半）

> 由 C-02 移交。执行人：👥 团队。完成后逐项勾选，结果（含截图/记录位置）回填 [`ledger-team-track.md`](./ledger-team-track.md)，达成 M1 → CP2。
> 前置：C-02 自动化断言已绿（`pnpm verify:packaged`，产物在 `dist/win-unpacked`；便携版为 `dist/AiClient-<version>-portable.exe`）。

## 凭证准备（统一约定，见执行计划 §4）

```powershell
# 生成测试网关配置目录（可附加要信任的工作区路径作为参数）
pnpm prepare:test-config D:\你的\测试工作区

# 按脚本输出设置 CLAUDE_CONFIG_DIR 后再启动应用，例如：
$env:CLAUDE_CONFIG_DIR='C:\Users\<你>\AppData\Local\Temp\aiclient-gui-test-config'
.\dist\AiClient-<version>-portable.exe
```

原理：Main 进程以 `{...process.env}` 启动 Host，Host 认 `CLAUDE_CONFIG_DIR`——无需改动 `~/.claude/settings.json`。

## 点验项

| # | 项 | 操作 | 通过标准 | ✔ |
|---|---|---|---|---|
| 1 | 启动 | 双击便携版（或安装版装完启动） | 应用正常启动，无白屏/报错弹窗 | |
| 2 | Beta 壳 | Settings → Appearance → 打开 **OpenChamber Workspace Shell** | 四区壳出现 | |
| 3 | Host 就绪 + PONG | 选 **Live Agent Host** 新建会话，发 `Reply with exactly: PONG. Do not use tools.` | 时间线出现 user + assistant 流式文本，内容含 PONG | |
| 4 | 权限卡 Allow | 发 `Create PING.txt with content pong`（工作区内） | tool_call → 权限卡 → Allow → tool_result；`PING.txt` 真实生成且内容为 pong | |
| 5 | 权限卡 Deny | 再次触发写文件请求 → Deny | 会话不崩，模型收到拒绝并正常收尾 | |
| 6 | Stop | 发长任务（如「Count from 1 to 200 slowly」）→ 运行中点 Stop | 流终止，状态回 idle，可继续发新消息 | |
| 7 | 退出无孤儿 | 关闭应用 → 任务管理器搜 `node.exe` | 无残留 Host/cli 进程（对比启动前快照） | |
| 8 | 全新机器添加仓库（T-24 真机残留，2026-08-04 并入） | 无既有仓库状态首启（不带 `--open-path`）：① 左栏空态 CTA / 头部入口添加本地仓库；② 从资源管理器拖文件夹到窗口 | ① 弹窗添加成功；② 出「Add Repository」高亮遮罩、松手弹窗预填路径；两路添加后左栏均立现 Project/Workspace | |
| 9 | Win10 字重真机核（T-23/T-32 点验残留，2026-08-05 并入；开发机为 Linux 无法采集） | 顶栏会话标题（15px semibold）与正文并列对比；另核 0-nonies ⑪ 的 D25 §6.2 五项真机指标 | 标题明显比正文醒目；**粗细无差即字重回退 bug**（Win10 常缺 500 字重，故用 semibold） | |

## 注意

- 全程走测试网关（第 3 项时间线正常即证明凭证注入生效；如需核对可看诊断/日志中 `baseHost: cch-jyw.pipidan.qzz.io`）。
- 加密机相关项**不在本清单**：T-11 现场执行，开发机不得代标通过。
- 任一项不过：截图 + 复现步骤记入团队台账，@主线（Claude）跟进。
