# Onboarding 重构:注册优先(register-first)

## 核心决策(用户已确认)

**Bedrock 拆分**:
- **必经主干(人人必走)**:注册 + 写配置(`~/.claude`、`~/.codex` 凭证)。
- **可选末端**:配置完之后要不要在本机用 AiClient。要 → 需要 CLI;不要 → 拿配置去 VSCode 等用。

**推翻的旧模型**:现在是 CLI 优先(`cli-check → 注册 → result`),CLI 检测被摆最前当门槛。
**新模型**:注册优先。CLI 安装从"入口门槛"降级为"点【进入 AiClient】且缺 CLI 时"的按需动作。

**用户确认的四个细节**:
1. 两个入口并列按钮的旧模型(仅注册 / 一键安装)取消 —— 配置是默认必做,不是可选项之一。
2. vscode 独立壳合并进主干,成功屏条件显示"可返回 VSCode"提示。
3. 完成屏点【进入 AiClient】但缺 CLI 时:**先提示"需要安装,确认后再装"**,不当场静默安装。
4. 欢迎 = **独立一屏在前**(非邮箱屏标题)。

## 目标链路

```
启动 → gate
  ├ 未注册 ──────────► 欢迎屏 → 邮箱 → 验证码 → 【配置完成】屏
  │                                              ├【进入 AiClient】
  │                                              │   ├ CLI 在 → 主页
  │                                              │   └ CLI 缺 → 提示"需安装 CLI" →确认→ 安装 → 主页
  │                                              └【退出】(拿配置去用 VSCode)
  └ 已注册
       ├ CLI 在 + 凭证健康 ─► 主页
       ├ CLI 缺 ───────────► 【配置完成】屏(检测到 VSCode 扩展则多显示"可返回 VSCode")
       └ 凭证损坏 ─────────► 自愈回注册
```

## 结构性改动

### gate 决策树(useGateStatus.ts)
- **删** `vscode-only` stage:`vscode-extension-only` 不再短路成独立壳,归入"缺 CLI"。
- **改顺序**:注册检查(`!registered → register`)提到 runtime 类型分支之前(register-first)。
- runtime kind 只需回答"CLI 在不在":
  - node-compatible / bun-incompatible → CLI 在(bun 仍带降级 banner)
  - vscode-extension-only / not-installed → CLI 缺 → onboarding 岔口
- **保留**:`credentials-unhealthy` 自愈、`runtime-failed` 重试、bun 降级 banner。
- 新增/改 variant:已注册但缺 CLI 时,携带"是否检测到 vscode 扩展"给渲染层条件提示。

### 渲染层
- **删** `ClaudeVsCodeOnlyShell.tsx`(101 行)+ Root 里 vscode-only 分支 + 4 个 vscode 子流程状态(vscodeRegisterFlow/InstallFlow/RecheckPending/RecheckError)。
- **新增 Step**:`welcome`(独立欢迎屏)+ 改造 `result` 为"配置完成/进入 AiClient 岔口屏"。
- OnboardingView Step 顺序:`welcome → register-email → register-code → result`(cli-check 不再是起点)。
- 完成屏两个按钮:【进入 AiClient】【退出】;缺 CLI 时【进入 AiClient】先弹"需安装 CLI"确认,确认后走现有 handleInstall → 主页。
- 检测到 vscode 扩展 → 完成屏多显示一句"配置已写入,可返回 VSCode 使用"。

### 测试
- 改 gate 18 测试里 vscode-only 相关:未注册 vscode 用户现在应走 `register`;已注册缺 CLI 走对应岔口。
- 新增:register-first 顺序断言(未注册 + 任意 runtime kind → register)。

## 保留不动
- credentials-unhealthy 自愈、runtime-failed 重试、bun-incompatible banner。
- 我之前加的关 autoAdvance / 成功 banner / 流动按钮(会随 cli-check 降级而调整落点)。
- Phase 1 的三个 dev 注入开关(仍可用来测各岔口)。

## 分阶段(每阶段停下等验收,不连做)

- **Phase A — gate 决策树 + 测试**:改 useGateStatus 顺序、删 vscode-only stage、更新测试跑绿。纯逻辑层,先锁正确性。
- **Phase B — 渲染层链路**:新增 welcome 屏、改造 result 岔口屏、删 ClaudeVsCodeOnlyShell、Root 简化。
- **Phase C — 文案 & 细节打磨**:欢迎屏说明、完成屏两按钮措辞、vscode 条件提示、安装确认弹窗。

每阶段一个 commit(显式文件列表)。
