# D8 — 模型配置策略：先本地、后管理页，key 永不进 models.json

> 用户拍板 2026-08-28（T06 冒烟后讨论 GUI 模型菜单错位 + 管理页计划）。背景与调查见 [topics/model-config.md](../topics/model-config.md)。

## 拍板内容（四条）

**a. 落盘采用方案 B（隔离 agentDir）**：公司/受管配置写在应用自管的隔离目录（`~/.pilab` 下，经 `PI_CODING_AGENT_DIR` env 指向），不共享用户的 `~/.pi/agent/models.json`。理由：公司配置与用户手配界限干净，贴合 D72「入口决定模式」脉络；pi SDK 原生支持 env 重定向（已核实 `config.js:421`），用户自己的 `~/.pi/agent` 原样不动。落选方案 A（共享用户目录 + merge 保留）：需要 pi-app 式 merge-retained 纪律防互相覆盖，公司/自备两套语义易混。**连带已由 [D10](./010-tui-managed-pi-config.md) 收口**：登录模式 agent PTY 同样注入该目录，TUI 使用公司模型。

**b. 同步失败降级链 = 本地缓存 → 默认配置**：复用 D48 `AgentCatalogService` 四级 fallback 骨架（fresh→stale-cache→seed→Automatic），pi 分支的 fresh 源换成管理页端点。不做"失败即拦人"。

**c. 管理页只给通用配置，key 经登录注入配合**：管理页配 url/model/渠道/思考/上下文等**模型元数据**；公司 key 不写进 models.json，仍走登录获取 + vault（D47 范式），运行期注入（`setRuntimeApiKey` 或隔离 auth.json）。管理页与 key 两条线在客户端汇合。

**d. 阶段顺序 = 先读本地，管理页就绪后再切换**：阶段一 GUI 菜单对 pi 改读本地 pi 配置（agent-host 进程内读 `~/.pi/agent/models.json` / SDK 列举），绕过公司网关与 Claude 家族白名单（那两样留给 Claude/Codex 轴）；阶段二管理页建好后把 fresh 源改为管理页同步，落盘进隔离 agentDir。

## 范围声明

本决策只定方向，不授权开工。实施切片见 roadmap T19~T23；管理页本身是公司服务端的独立工程，不属本仓范围，本仓只做客户端拉取与落盘。
