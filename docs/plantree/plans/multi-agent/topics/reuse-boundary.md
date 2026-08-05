# Topic — 现有代码的 agent 无关面 vs Claude 专属面

> 这张边界决定 Codex 接入的真实成本。结论产生于 2026-08-04 会话（当轮实测），2026-08-05 补落库。

## 问答卡：只有最底下 303 行是 Claude 专属

```
QuestionCard.tsx / PendingQuestionDock / questionCardModel   ← 零 Claude 耦合（当轮实测）
        ↑
chatSessions store 的 question.requested 处理                ← 通用，只认 questionId + questions[]
        ↑
IPC chat:respondQuestion + RuntimeEvent 协议                 ← 通用
        ↑
questionBridge.ts（✅ 复核 303 行，钩 Claude SDK 的 canUseTool） ← 只有这一层是 Claude 专属
```

**上面的 UI、协议、store 全部 agent 无关。** 这不是巧合，是 **D2「自建协议不拷别人 store」**的红利。

**推论**：Codex 接进来要做的不是「再写一套问答卡」，而是**一个薄适配**——
把 Codex 那侧的提问接住转成我们的 `question.requested`，把用户答案转回去。
卡片长什么样、怎么点、怎么存，一行都不用改。

### 一个曾经的错判，已收回

2026-08-04 中途曾建议照 codeg 那样自建统一伴生进程（方案 B），**当轮即收回**。
codeg 需要它是因为要撑 12 个 agent、其中多数**没有结构化提问能力**，需要一个「塞进去就能用」的统一机制；
我们只有 Claude 和 Codex，两个都自带提问通道——它的理由在我们这里不成立。

### 未验的一处

**Codex 侧的提问长什么形状没实测。** codeg 为它写了分类器（`classify_elicitation`），
说明形状不止一种（提问式 / 审批式 / 链接式）。「薄」到什么程度，得跑一次才知道
→ 已列进 [roadmap](../roadmap.md) 的 spike 第 3 项与 [open-questions #2](../open-questions.md)。

## 其余各层的初判（待 spike 校正）

| 层 | 判断 | 依据 / 待核 |
|---|---|---|
| 侧栏「文件夹 → 会话」两级结构 | **已具备**，缺的只是 CLI 维度 | `sidebarTree.ts`（T-26 / D21）；会话行已有 chip 机制（branch/kind），加 agent chip 是同构扩展 |
| 会话 ↔ agent 绑定 | **缺**，需红线 store 加字段 + 持久化口径 | `chatSessions.ts` 属红线，走加法纪律；参照 codeg 把 `agent_type` 存进 conversation 行 |
| 模型 / 推理档 | **单轨**，现为 Claude 口径 | `useSessionModel` / `useSessionEffort`；Codex 有自己的模型目录，codeg 为此专门做了运行时目录抓取（见 codeg-reference） |
| 权限模式 | **只读展示**，无管理面 | T-14 刚接的 `permissionMode` 只进 context surface 显示 |
| 工具行渲染 | 大概率通用 | `toolCard.ts` 按工具名分派；Codex 工具名不同需补映射，非重写 |
| 历史重放 | **有协议缺口** | `HistoryBlock` 无 agent 归属概念，与 C-17 / 子 agent 归属是同一个缺口 |

> 表内除前两行外均为**初判未实测**，spike 的产出之一就是校正这张表。
