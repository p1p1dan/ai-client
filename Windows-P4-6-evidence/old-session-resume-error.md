# 旧会话点开报错 · 根因定性（已确认，需交回 Linux 侧修复）

> 生成：2026-09-09 · 应用 test.11（b6aa0844）· 状态：**根因已定性为产品缺陷**（`worker_resume_identity_mismatch`）

## 错误现象

用户点击任意 **v3 legacy 历史会话**，`chat:resumeSession` 报：
`WorkerManagerError: Pi worker did not open the requested exact session file`。
实测命中（`logs\aiclient-2026-09-09.log`）：14:05:51 / 14:06:00 / 14:06:02 / 14:24:24 / **15:48:46（复现，会话 = session-1788914946116-hczhs37）**。

## 根因（读码 + 索引数据实证）

**错误产生点**（`WorkerManager.ts:942-946`）：
```ts
if (!reopenedFile || sessionWorkerKey(reopenedFile) !== durableKey) {
  throw new WorkerManagerError('worker_resume_identity_mismatch',
    'Pi worker did not open the requested exact session file');
}
```
- `durableKey = sessionWorkerKey(input.sessionFile)` —— Main 把索引里的 `runtimeIdentity` 当作 sessionFile 归一化。
- `reopenedFile = normalizeWorkerPath(created.bootstrap.sessionFile)` —— worker 实际打开并回传的文件。

**为何 v3 必然对不上**（`src/runtime/plugins/session/legacy.ts` `prepareSessionConfig`，第 426 行起）：
```ts
if (config.mode === 'resume' && first?.kind === 'header' && first.version === 4) return config; // 仅 v4 原路返回
const requested = `${sourceFile}.native-v4.jsonl`;   // v3 → 落到 .native-v4.jsonl
...
return { ...config, file, mode: 'resume' };          // 回传 file = .native-v4.jsonl
```
即：native 后端 **resume 到 v3 文件时，会把它转换并写到 `<v3>.native-v4.jsonl`**，convert 后的文件有**新的 header.id**，`metadata.importedFrom = sourceFile`。于是：

| 侧 | 值 |
|---|---|
| Main 期望 durableKey | `session:<normalize(<v3 路径>)>` |
| worker 回传 sessionFile | `<v3 路径>.native-v4.jsonl` |
| 结论 | **必然不等** → `worker_resume_identity_mismatch` |

## 实证：所有 v3 会话全部 MISMATCH

用 `workerSessionKey` 逐条对比（索引 agent=pi）：

| runtimeIdentity 指向 | 数量 | 对比结果 |
|---|---|---|
| v3 文件（`--<workspace>--\<ts>_<uuid>.jsonl`） | 20 | **全部 MISMATCH**（worker 会转成 `.native-v4.jsonl`） |
| v4 文件（`session-<ts>-<suffix>.jsonl`） | 2 | MATCH（native 原路 resume，正常） |

其中 4 条 v3 的 `.native-v4.jsonl` 已存在（含报错的 `hczhs37`），但仍报错——因为**索引里 `runtimeIdentity` 始终指向 v3**，只要索引不改成 v4 路径，此错误必然持续。

**因此本缺陷与 worktree 无关**（推翻先前"worktree 特有"推断）。报错对象是"任何 runtimeIdentity 仍指向 v3 文件的会话"。

## 缺陷定性

**native 后端 resume v3 legacy 会话时，worker 回传路径（转换后的 `.native-v4.jsonl`）与 Main 按索引 `runtimeIdentity`（v3 路径）计算的 durableKey 不一致**，导致 `worker_resume_identity_mismatch` 静默阻断旧会话恢复。影响面：**所有 v3 会话**（本机 20 条）。

## 建议修复方向（交 Linux 侧）

1. **索引迁移**：legacy 会话首次经 native 转换产生 `.native-v4.jsonl` 后，把索引 `runtimeIdentity` 更新为该 v4 路径（`NativeSessionIndexAdapter` 或 resume 成功后写入），后续 resume 直接指向 v4，不再走转换。
2. **或分辨率兜底**：`prepareSessionConfig` 返回 `file` 为 v4 时，`WorkerManager.resumeSession` 的 durableKey 用**实际返回的 file** 而非请求路径计算；或 `isUnwrittenPiSession`/修复分支在"等价的 `.native-v4.jsonl` 已存在"时走 createSession 而非 resume。
3. 需要保证 v3 原文件不被误当"待写"而触发 `clearUnwrittenRuntimeIdentity` 泄漏。

## 现场证据与临时脚本

- 复现 trace 目录 `resume-repro-trace/`（本次复现，worker 未成功 bootstrap，为空）。
- 诊断脚本 `verify-v3-mismatch.cjs`（v3→v4 identity 对比）为只读，位于 `Windows-P4-6-evidence/`。
- 未修改任何产品源码 / 测试源码 / 索引数据 / 会话文件。
