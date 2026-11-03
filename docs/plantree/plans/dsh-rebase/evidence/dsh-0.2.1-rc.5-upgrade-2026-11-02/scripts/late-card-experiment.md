# 子代理回合外权限卡实验（决策 207 第 8 节）

不入库为脚本：做法是临时复制 `src/dsh-host/tools/bridge-record.ts` 为 `exp-late-card.ts`，
只改 `permSubagentScenario`：父回合结束后再等 45 秒，期间出现的每张 `permission.requested`
都答 `allow`，最后把通道上的全部事件按「类型 | requestId | 状态 | kind | 角色 | 工具 | agentId |
parentToolCallId | 输出前 90 字」逐行写出。运行：

    out-node-runtime/node src/dsh-host/tools/exp-late-card.ts --check --only perm-subagent --out-dir /tmp/dsh021/exp

跑完即删除临时文件（工作区无改动）。结果摘录见证据第 6 节。
