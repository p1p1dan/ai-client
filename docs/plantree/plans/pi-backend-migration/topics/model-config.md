# Topic — 模型配置：来源、同步与管理页

> 2026-08-28 立项。触发：T06 冒烟通过后发现 **GUI 模型菜单对 pi 完全错位**（只显示 3 个 Claude 种子模型，而 TUI `/model` 显示 3 provider × 8 模型）。
> 决策见 [D8](../decisions/008-model-config-strategy.md)。

## 一、现状诊断（GUI 菜单错位的根因）

GUI 模型菜单取数链路是 D48 为 Claude/Codex 两轴建的：

```
ComposerModelTrigger → useAgentModelCatalog(agent)
  → IPC → AgentCatalogService.list({agent})
    → requestRuleFor(agent)          ← AgentCatalogService.ts:130，pi 掉进 Claude 规则
    → 公司网关凭据 GET /v1/models
    → filterAgentModelCatalog(agent) ← familyWhitelist.ts:263，GLM/DeepSeek 全被滤掉
    → 失败回落 seedCatalog（Claude 3 + GPT 3）
```

三个环节对 pi 全错位：`requestRuleFor` 无 pi 分支（拿 Claude 凭据查网关）、家族白名单只认 Claude/Codex（pi 的模型全被滤掉）、种子表是 Claude 的。

**而 pi 后端真实的模型源是 `~/.pi/agent/` 下的 `models.json`（providers × models，含 baseUrl/apiKey/contextWindow/maxTokens/thinkingLevelMap/reasoning/cost）+ `settings.json`（defaultProvider/defaultModel/defaultThinkingLevel）+ `auth.json`（凭据）**。本机实测：3 个 provider（dan/commandcode/glm）共 8 个模型。

回合底部标注（`dan/claude-opus-4-8`）走 `message.started` 的 `model.provider/model.id`，是通的——错位只在菜单链路。

## 二、pi-app 参考架构（2026-08-28 调查）

pi-app 的模型管理分读、写两半：

**读：`ipc:model.list` 单入口，三 scope，多级 fallback**（`src/main/ipc/handlers/model-runtime.ts`）：

| scope | 源 | fallback |
|---|---|---|
| `available`（选模型菜单） | ① worker 会话快照 → ② SDK `ModelRuntime.create({modelsPath, allowModelNetwork:true}).getAvailable()` | ③ 磁盘直读 models.json → ④ 空 |
| `catalog`（设置面板） | SDK ModelRuntime（含 auth 投影：每模型带 `auth:{configured,source,type}`） | 磁盘直读 |
| `settings` | worker 运行态快照 | 同 catalog |

渲染端 `available-models-cache.ts`：模块级快照 + 去重 in-flight + 订阅失效。选模型走 `model.set` 把 `provider/modelId` 写进 worker 会话（**不是**每条 prompt 传参）。

**写：两条路径，均落 `~/.pi/agent/` 两文件**：

- `models.json`：设置面板 CRUD → `writeModelsConfigWithSdk()` —— SDK 校验（临时文件跑 `ModelRuntime.create().getError()`）→ 与磁盘上未管理的字段 merge 保留 → 原子写（tmp+rename）→ 错误消息脱敏。
- `settings.json`：`pi.settings.set` patch 写 `defaultProvider`/`defaultModel`/`defaultThinkingLevel`。

**可复用的第三件**：`fetchRemoteModelIds()` —— 从远端 baseUrl 拉 OpenAI 兼容 `/v1/models` 裸 id 列表（x-api-key/Bearer 双头、`$ENV_VAR`/`!` key 解析）。pi-app 用它在设置面板"从渠道导入"；我们管理页同步的客户端半边就是它。

## 三、pi SDK 关键能力（本仓 node_modules 实测声明）

- `getAgentDir()` 读 `PI_CODING_AGENT_DIR` env（`config.js:421`，常量 `ENV_AGENT_DIR = "PI_CODING_AGENT_DIR"`）——**目录重定向不需要写用户文件**，方案 B 的技术基础。
- `ModelRuntime`（`core/model-runtime.d.ts`）：`create({modelsPath, authPath, allowModelNetwork})`；`getModels()/getAvailable()/getModel(provider,id)/getError()`；**`setRuntimeApiKey(providerId, key)` 运行期注入 key，不必写 auth.json**；`getProviderAuthStatus()` 出认证投影。
- `createAgentSessionServices({cwd, agentDir, settingsManager})` 已支持显式传 agentDir —— piRuntime.ts 现在就是这么用的。

## 四、目标架构（按 D8 拍板）

```
阶段一（现在）：GUI 菜单读本地 pi 配置
  AgentCatalogService 对 'pi' 走本地分支：
    agent-host 进程内 ModelRuntime/models.json 磁盘直读 → AgentModelOption[]
    （不经公司网关、不经 Claude 家族白名单；那两样留给 Claude/Codex 轴）

阶段二（已落地）：登录模式受管同步
  公司管理页面（url/model/渠道/思考/上下文等通用配置，无 key）
        │ 登录模式启动后拉取
        ▼
  Main：拉取 → 校验 → 写入隔离 agentDir（方案 B，PI_CODING_AGENT_DIR 指向 ~/.pilab 下受管目录）
        │ 凭据：登录拿到的公司 key 经运行期注入（setRuntimeApiKey / 隔离 auth.json），
        │       不落 models.json —— 管理页只吐模型元数据（D8-c）
        ▼
  同步失败 → 本地缓存 → 默认配置（复用 D48 四级 fallback 骨架，换 fresh 源）
```

**方案 B 的两态影响**（D8-a）：

| 模式 | 公司模型可用性 |
|---|---|
| GUI 气泡（utilityProcess，env 我们控制） | ✅ 直接可用 |
| TUI 直通（T16，跑在应用内终端） | ✅ [D10](../decisions/010-tui-managed-pi-config.md)：登录模式 agent PTY 注入 `PI_CODING_AGENT_DIR`，key 从隔离 `auth.json` 读取；普通 terminal/local/remote 不注入 |

**"Use my own setup" 模式**不受影响：不注入 env，pi 自然读用户自己的 `~/.pi/agent/`，GUI 菜单的本地读取分支同样适用（读的就是 SDK 会读的那个目录）。

## 五、与既有决策的衔接

- D47/vault：公司 key 已按 agent 分存，"加 pi 即加第三个 arm"——注入路径复用。
- D60/D61（只隔离凭据不隔离人格）：pi 侧与 Claude/Codex 不同——pi 有 env 重定向原生支持，隔离目录不劫持用户任何东西（用户的 `~/.pi/agent` 原样不动）。
- D48 四级 fallback：`AgentCatalogService` 的 fresh→stale-cache→seed→Automatic 骨架保留，pi 分支换 fresh 源（阶段一本地文件、阶段二管理页）。
- D66 先例：终端 codex 无法仅靠 env 改 base_url；pi 原生支持 agentDir 重定向，因此 [D10](../decisions/010-tui-managed-pi-config.md) 选择让登录模式 TUI 与 GUI 共用公司 Pi 配置。
