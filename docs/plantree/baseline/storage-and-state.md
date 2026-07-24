# Storage & State

| 数据 | 位置 | 归属/说明 |
|---|---|---|
| 会话索引 | `userData/session-index.json` | Main `SessionIndexService`；原子写（tmp+rename）、懒加载、串行 flush；损坏 JSON warn 后空索引启动 |
| 会话历史正文 | `~/.claude/projects/**/*.jsonl`（CC 原生） | **Host（白名单 Node）读**，Main 不读——加密机上是 TSD 密文（决策 D11）；本地只存索引 |
| Chat 运行态 | renderer zustand `chatSessions.ts` | messages 按 sessionId 分桶；pendingPermission/pendingQuestion 单槽；historyErrors 按会话 |
| 消息元数据 | renderer `messageMetadata.ts` 侧表 | 团队侧注册表模式（不进红线 store）；latency/model/usage |
| 会话→模型映射 | localStorage `aiclient:chat:session-models` | `useSessionModel`，守卫 JSON.parse |
| Host 凭证 | `~/.claude/settings.json` env 段 | Host 启动加载并注入自身 process.env；诊断脱敏进 `host.ready.settings` |
| 测试凭证 | 临时 `CLAUDE_CONFIG_DIR`（网关） | 执行计划 §4 统一约定；spikes 自动注入；**禁改用户本机 settings.json** |
| 打包产物 | `resources/agent-host/`（87MB 明文不入 asar）+ `resources/node-runtime/node.exe`（随包 Node 24.18.0） | afterPack 串行拷贝；TSD `.tmp.bin` 修复同钩子 |
