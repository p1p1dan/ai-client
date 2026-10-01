# 决策 147：P1-12 退役自有 runtime——用户裁决与实现取舍

日期：2026-10-01。**状态：第一节为用户裁决；第二节起是实现方的自主决定，待用户审批。**

依据：[决策 130](130-user-rulings-2026-09-29-batch3.md)（P1-12 已授权）；施工方案 [topics/p1-12-retire-runtime.md](../topics/p1-12-retire-runtime.md)（清点、四步施工、风险）。

## 一、用户裁决（2026-10-01，答复「按建议」）

1. **Q1 第 4 步**：先做第 1～3 步；Windows 整包 CI 通过后再做第 4 步（删掉整个 `src/agent-host`、内部改名）。改名只改内部标识符和文件名；`pi_session_*` 错误码、`AICLIENT_PI_WORKER_CAPACITY`、IPC 名、设置键、会话索引里的 `agent: 'pi'` 都不改。
2. **Q2 整包 CI**：第 1 步和第 3 步之后各推送一次并手动触发 `build.yml`（属于决策 130 已批准的「推送 + Windows CI」）。
3. **Q3 `models.json`**：P1-12 不动，需要时另开小任务。
4. 第 3 步改写 `THIRD_PARTY_NOTICES.md` 前，把改动给用户过目。

## 二、实现取舍（各步实现方追加）
