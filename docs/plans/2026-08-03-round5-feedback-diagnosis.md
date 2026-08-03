# 第五轮 GUI 点验反馈 · 四路诊断汇总（2026-08-03）

> 产出：round5-feedback-diagnosis 工作流（3 sonnet 定位 + 1 opus 能力工单），HEAD `a0d60ab`。
> 编排者裁定见文末。参照图：`docs/design/refs/feedback-20260803-round5/`。
> 第 5 条（斜杠指令）用户明示低优先级，已入 plantree ideas，不在本文范围。

## diag:new-button-folder

This confirms the mechanism. `createChatSessionOnWorkspace` itself works correctly when given a proper `workspaceId`, and the per-folder "+" buttons (line 436, 461) already pass the correct `folder.newSessionWorkspaceId`. The bug is isolated to the global header "New" button's target-resolution logic.

## ROOT CAUSE

**`src/renderer/components/workspace-shell/LeftNav.tsx:124-144`**

```tsx
const activeSession = sessions.find((session) => session.id === activeSessionId);
// Selection of "where to run" moved to the Composer target bar (T-27); this
// is only a fallback target for the sidebar's own "New" / "+ new chat" affordances.
const effectiveWorkspaceId =
  activeSession?.workspaceId ?? workspaces.find((ws) => isUsableWorkspace(ws))?.id ?? null;
...
const handleNewSession = () => {
  if (!effectiveWorkspaceId || !canStartNewSession) return;
  createChatSessionOnWorkspace(effectiveWorkspaceId);
};
```

The global header "New" button (line 234-243) targets `effectiveWorkspaceId`, which is derived from `activeSession?.workspaceId` — the *last selected session's* workspace — with a fallback to `workspaces.find(isUsableWorkspace)`, i.e. the **first** usable workspace in store insertion order (in this repro, `ai-client`, since it was likely the first repo added / seeded).

T-26 deliberately removed `selectedWorkspaceId` from the sidebar (folder click no longer sets any store state — see `LeftNav.tsx:410-415`, the folder header button only toggles `expandedProjects`, a local UI state, it writes nothing to the store). Nothing in the sidebar tracks "which folder the user is currently looking at/clicked." So:

- If the user expands/collapses a folder or just visually browses `openchamber`/`aaa` without clicking into one of their sessions, `activeSessionId` never changes, and `effectiveWorkspaceId` stays pinned to whatever it was — which, on first load with no active session, is the first-usable-workspace fallback (`ai-client`).
- Even after clicking a session under another folder, this only works transiently — but the user's report ("always ai-client regardless of which folder is selected") indicates they are not landing on a session in that folder first, they're just visually targeting the folder (its header, or clicking to expand it, or the folder itself isn't showing an "active" affordance), so the header button keeps resolving to the stale/default `ai-client` workspace.

This is exactly the failure mode the inline comment at line 427-429 already flags for the *per-folder* case ("The header New button targets the active session's workspace only, so a repo that already has sessions needs its own entry point") — but that comment undersells it: even for a repo with **no** existing sessions and no per-row "+ new chat" reachable target, the header button is the only "New" affordance shown as primary, and it has no way to reflect the user's actual sidebar focus at all.

## FIX PROPOSAL

Reintroduce a lightweight, sidebar-local "target folder" concept (without resurrecting the old cross-cutting `selectedWorkspaceId` store field that T-26 intentionally removed):

1. **`LeftNav.tsx`**: add local state, e.g. `const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null)`, set it whenever a folder header is clicked (line ~410) and whenever a session inside that folder is selected (`handleSelectSession`, so it stays in sync). 
2. Change `effectiveWorkspaceId` resolution order to: `focusedProjectId`'s `newSessionWorkspaceId` (via `folders.find(f => f.projectId === focusedProjectId)?.newSessionWorkspaceId`) → `activeSession?.workspaceId` (existing fallback) → first usable workspace (existing fallback).
3. `handleNewSession` unchanged (still calls `createChatSessionOnWorkspace(effectiveWorkspaceId)`), only the resolution of `effectiveWorkspaceId` changes.
4. Optionally give the focused folder header a visible "active/focused" style (currently folders have "no selected state" per the comment at line 403-404) so the target is discoverable, not just functional.

No store/protocol changes needed — `createChatSessionOnWorkspace` (`src/renderer/stores/chatSessionActions.ts:20-51`) already takes an explicit `workspaceId` and is agnostic to caller. This keeps the fix confined to `LeftNav.tsx`'s local UI state, consistent with T-26's decision to keep folder-focus out of the global session store.

## RISKS

- Must keep `focusedProjectId` reset/reconciled when the folder list changes (e.g. project removed) to avoid pointing `effectiveWorkspaceId` at a stale/nonexistent project — reuse the existing `visibleFolders`/`folders` derivation to look this up on each render (don't cache the resolved workspace id itself) so it self-heals.
- Decide precedence when both a focused folder and a different active session exist simultaneously (e.g., user focuses `aaa`, then via search/Recent selects a session in `openchamber`) — the proposal above prioritizes explicit folder focus, which best matches "create under the folder the user targeted"; confirm this matches product intent before landing.
- `canStartNewSession`/`canCreateSessionOnWorkspace(effectiveWorkspaceId, workspaces)` gating (line 136) must be re-evaluated against the new resolution too, so the header "New" button correctly disables itself for a focused folder whose workspace path is unusable (e.g., empty temp workspace).

## TEST SURFACE

- `src/renderer/components/workspace-shell/__tests__/sidebarTree.test.ts` — no change needed if fix stays purely in `LeftNav.tsx`'s local state, but add coverage for `resolveNewSessionWorkspaceId` interaction if the fix touches folder→workspace mapping.
- New/extended component test for `LeftNav.tsx` (check if `__tests__/` exists there — none found in this pass, would need to add) asserting: click folder `aaa` header → click global "New" → `createChatSessionOnWorkspace` called with `aaa`'s workspace id, not `ai-client`'s; same for `openchamber`; and that selecting a session still updates the target session-first as before (regression guard for the existing `activeSession?.workspaceId` fallback path).
- Manual/E2E: three-folder repro from the bug report (ai-client / openchamber / aaa) — click each folder, hit "New", confirm session lands in the clicked folder.

---

## diag:archive-close-noop

# DEFECT 2 — Sidebar Archive/Close no-op for a freshly created session

## ROOT CAUSE

Two independent gaps that both collapse onto the same symptom for a brand-new session.

**Gap A — new sessions have no `session-index.json` entry until first send.**
`createChatSessionOnWorkspace` (`src/renderer/stores/chatSessionActions.ts:20-51`) is purely a renderer-side `useChatSessionsStore.setState` call — it never calls `window.electronAPI.chat.createSession`. That IPC (which drives `sessionIndexService.recordCreated`, `src/main/ipc/chat.ts:59` → `src/main/services/chat/SessionIndexService.ts:45-62`) is only invoked lazily, the first time the user sends a message on that session (`src/renderer/stores/chatSessions.ts:844-855`, gated on `hostBoundSessionIds`). So a "New" session that hasn't had a message sent yet — or even one that has, see Gap B below for why archive still fails there in some races — has **no persisted index entry at all**.

Because of that:
- `sessionIndexService.setArchived()` (`SessionIndexService.ts:95-104`) does `const existing = this.entries.get(sessionId); if (!existing) return false;` → returns `false`.
- `useSessionIndexMutations.archive()` (`src/renderer/components/chat/sessionIndex/useSessionIndex.ts:103-114`) only calls `refresh()` `if (ok)` — so on a live-only session the whole refresh/merge cycle never even runs. The click is a true no-op.
- Even if it did run, `mergeSessionIndex` (`src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts:126-129`) has an explicit fallback: *"Keep live-only sessions (created in this app run, not yet persisted) so a fresh 'New' session doesn't vanish between index refreshes."* Any session id not present in the fetched `entries` array is unconditionally re-pushed into `next`, so there is no way to represent "archived" for a session that was never indexed.

**Gap B — "Close" never removes a session from the list for anyone, old or new.**
`useSessionIndexMutations.close()` (`useSessionIndex.ts:116-129`) calls `window.electronAPI.chat.closeSession`, which maps to `agentHostManager.closeSession` (`src/main/services/agent-host/AgentHostManager.ts:62-73`) — this only sends a `session.close` command to the Host runtime process. It does not touch `session-index.json` (no delete/archive call), and it does not remove the session from the renderer's `useChatSessionsStore.sessions` array. The resulting `session.stopped` runtime event just flips status back to `idle` (`src/renderer/stores/chatSessions.ts:481-486`). So `close()`'s subsequent `refresh()` re-fetches the (still present, still non-archived) index entry and `mergeSessionIndex` re-adds the row exactly as before (`sessionIndexMerge.ts:80-95`). Close only detaches the runtime — it was never wired to remove the row from the sidebar for *any* session. For a persisted/older session this is easy to miss because the row's status simply reverts to idle, which can look like "it did something"; for a brand-new session sitting at `idle` already, clicking Close visibly does nothing, making it read as new-session-specific when it's actually a universal gap.

**Boundary confirmation:** Archive genuinely differs by session age — it works for any session that has an index entry (any session that has sent ≥1 message, or was resumed from a previous run) and silently no-ops for a session that has never been indexed. Close does not actually remove rows for indexed sessions either; it only stops the runtime, so the "works for older sessions" impression for Close is likely conflating it with Archive or with the Stop action elsewhere (e.g. `AgentTerminal`/`StatusLine`).

## FIX PROPOSAL

1. **Eagerly index new sessions** — in `createChatSessionOnWorkspace` (`chatSessionActions.ts`), fire `window.electronAPI.chat.createSession({ sessionId, workspacePath: workspace.path })` (or a lighter `sessionIndexService.recordCreated`-only IPC if starting the Host eagerly is undesirable) at creation time, not deferred to first send. This makes `hostBoundSessionIds` bookkeeping and the lazy-create-on-send path in `chatSessions.ts:844-855` redundant/needs reconciling — either drop the lazy branch or make it idempotent against an already-recorded index entry (recordCreated already upserts safely, `SessionIndexService.ts:52-60`).
2. **Make Archive/Close resilient to unindexed sessions** — in `useSessionIndexMutations` (`useSessionIndex.ts`):
   - `archive`: if the IPC returns `false` because the entry doesn't exist yet, fall back to removing the session directly from `useChatSessionsStore` (client-only sessions have no server truth to preserve), or auto-create the index entry first (`recordCreated`-equivalent) then retry `setArchived`.
   - `close`: after the IPC call, explicitly filter the closed session out of `useChatSessionsStore.sessions` (and `recentSessionIds`) in the renderer, rather than relying solely on `refresh()` + index state — Close's contract needs to be "detach + remove from nav," which today only "detach" is implemented.
3. Update the `mergeSessionIndex` doc comment/behavior (`sessionIndexMerge.ts:124-129`) once (1) lands — the "keep live-only sessions" fallback should stop being the only thing keeping a new session visible; it can stay as a safety net but must not be the sole mechanism blocking archive from ever working pre-index.

**Shape/protocol implications:** no new IPC channel required if reusing `chat.createSession`; if avoiding starting the Host eagerly, add a lighter-weight `chat.indexSession` (or similar) IPC that only calls `sessionIndexService.recordCreated` without touching `AgentHostManager`.

## RISKS

- Eagerly calling `createSession` on every "New" click changes Host-binding timing — verify it doesn't prematurely start the agent-host process or spawn a runtime session before the user types anything (may need a lighter index-only path per option above).
- Client-only removal fallback for `archive`/`close` must not race with an in-flight `recordCreated` from a just-sent first message (TOCTOU: archive-click right as the lazy-create in `sendMessage` fires) — need to serialize or check `hostBoundSessionIds` state.
- Changing Close to actually remove the row is a behavior change for existing/persisted sessions too — confirm this matches product intent (vs. Close being deliberately "stop only" and needing a rename/second affordance for "remove from list").

## TEST SURFACE

- `src/renderer/components/chat/sessionIndex/__tests__/` — add coverage for `useSessionIndexMutations.archive/close` against a session with no matching index entry.
- `src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts` unit tests — assert behavior once live-only sessions can be archived/closed (currently only covers the keep-alive fallback).
- `src/main/services/chat/SessionIndexService.ts` — unit test `setArchived`/`rename` returning `false` for missing entries; add a `recordCreated`-idempotency test.
- `src/renderer/components/workspace-shell/__tests__/sidebarTree.test.ts` — regression case: freshly created (unindexed) session, click Archive/Close, assert row disappears from `buildSidebarFolders`/`deriveRecentRows`.
- Manual/E2E: New → Archive immediately (before any send) must remove row; New → send message → Archive must also remove row; Close on an old/persisted session should remove it too (once fixed), not just reset status.

---

## diag:placeholder-align

## ROOT CAUSE

**File: `src/renderer/components/chat/middleColumnLayout.ts:209`** (`composerBarClass('session')` → `'flex min-w-0 items-center gap-2'`) combined with the textarea's uncertain natural height from **`middleColumnLayout.ts:405`** (`composerTextareaClass('session')`) and **`src/renderer/components/ui/textarea.tsx:14-43`**.

Mechanism, worked as box math:

1. **All non-textarea row children are exact 24px boxes.** `composerAttachButtonClass()` → `size-6` (middleColumnLayout.ts:236), `roundActionButtonClass()` → `size-6` (:596), `composerModelTriggerClass()`/`targetTriggerClass()` → `h-6` (:288, :336). For these, centering the *box* == centering the *content*, since box height is fixed at 24px.

2. **The textarea is the one child whose rendered box height is not pinned.** `<Textarea unstyled>` (ChatComposer.tsx:1880-1938) renders an outer `<span>` whose className comes *only* from `composerTextareaClass('session')` (textarea.tsx:14-22 — `unstyled` short-circuits the default chrome block, so no `flex`/`items-center` lands on that span either). The className string is `'min-w-32 flex-[2] p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-0 [&_textarea]:leading-6'`. This pierces `min-h-6`/`py-0`/`leading-6` onto the real `<textarea>` and **does** win over the element's own base classes at textarea.tsx:31 (`min-h-17.5 py-[calc(--spacing(1.5)-1px)]`) by CSS specificity (descendant-selector `[&_textarea]:` compiles to `(0,1,1)` vs. the base class's plain `(0,1,0)`) — so `sm:`/tailwind-merge survival is *not* the culprit here; I checked the repo's known gotcha and it's inert at desktop widths (`max-sm:min-h-20.5` never applies).
3. **`min-h-6` is a floor, not a target; `max-h-14` (56px) is far too loose to act as a ceiling.** Nothing in the class stack forces the *resting* (1-line/placeholder) box down to exactly `line-height` (24px). The raw `<textarea>` relies on `field-sizing-content` (textarea.tsx:31) to auto-size to content — a well-known browser behavior where an auto-sized textarea's intrinsic content-box height for one row is not guaranteed to equal exactly `1 × line-height`; any UA slack lands as extra height `H > 24`.
4. **`<textarea>` content is always top-anchored inside its own box** — already established fact in this same file's own comments (middleColumnLayout.ts:372-374, ChatComposer.tsx:1892-1893). So if `H > 24`, the extra space sits *below* the single text line, not split symmetrically.
5. **`items-center` on the row (middleColumnLayout.ts:209) centers each flex item's whole box.** The textarea's wrapping `<span>` has height `H`; centering it against the row's 24px reference puts the span's top at `(24-H)/2` relative to the button's top. Since the text sits flush to the span's top, the text's own optical centerline ends up at `12 - H/2` relative to the row's true center (12 for `H=24`). For any `H>24` this is negative → **the text visibly sits above the 24px controls' centerline** — exactly the reported defect, and the effect is independent of the exact magnitude of `H`.

Round 2-4's fixes (`rows={1}`, `[&_textarea]:leading-6`, `[&_textarea]:min-h-6`) were all validated only against the **class string**, never against the **rendered box height**, which is why the "42px total / 24px content" arithmetic in `composerFollowHeightBreakdown()` (middleColumnLayout.ts:185-195, asserting `content: COMPOSER_CONTROL_SIZE = 24` at :121/:193) can silently diverge from what actually renders.

## FIX PROPOSAL

Change `composerBarClass('session')` in `src/renderer/components/chat/middleColumnLayout.ts:209` from `items-center` to `items-start`:

```ts
// before
return 'flex min-w-0 items-center gap-2';
// after
return 'flex min-w-0 items-start gap-2';
```

Why this is the minimal, robust fix (not a magic-number nudge):
- For the fixed-24px siblings (button, model trigger, action buttons) `items-start` vs `items-center` is a no-op — their boxes are exactly 24px either way.
- For the textarea, this decouples alignment from the uncertain natural height `H`: the top-anchored first line's optical centerline becomes `row-top + 12px` by construction, matching the 24px controls, regardless of whatever `H` the browser actually computes (rest *or* grown state), and matches the standard chat-composer UX where the icon row stays pinned near the first line as the textarea grows multi-line rather than drifting to the geometric middle of a tall box.
- A narrower "only set `self-start` on the textarea's own span" alternative was considered and rejected: it fails when `H>24`, because the *row's* cross-size then grows to `H` and the other siblings (still `items-center` by default) would re-center within that taller line, reintroducing the same offset from the other direction.

Secondary, non-blocking follow-up: re-verify `composerFollowHeightBreakdown()`'s `content: COMPOSER_CONTROL_SIZE` (24) assumption (middleColumnLayout.ts:185-195) against the real rendered card height once `H` is known — if `H>24` at rest, the documented "42px resting height" contract may already be silently violated independent of this centering fix.

No store/IPC/protocol implications — pure CSS/class change in a pure function.

## RISKS

- `sessionStatusLineWrapperClass()` (middleColumnLayout.ts:438) and its sibling `'flex min-w-0 flex-1 items-center gap-1.5'` (empty-mode variant, ChatComposer.tsx:2245) are also children of this row. Their content (`Spinner size-3.5` + `text-meta` `<p>`, ChatComposer.tsx:1787-1795) is *not* a fixed 24px box (`text-meta` = 13px, no paired `--line-height` token, so it's shorter than 24px). Switching the row to `items-start` will move the status line/spinner from vertically-centered to top-flush — likely a small (~2px) but real visual shift that needs a manual check alongside the textarea fix.
- Any future same-row child that isn't exactly `h-6`/`size-6` will no longer be auto-centered; this trades "centering hides height mismatches" for "alignment now surfaces height mismatches," which is the intended tradeoff but should be called out in review.

## TEST SURFACE

- Extend `src/renderer/components/chat/__tests__/middleColumnLayout.test.ts` with a string assertion that `composerBarClass('session')` contains `items-start` (mirrors the existing class-string regression style in this file).
- The actual defect can only be closed with a **real-layout** check (jsdom has no layout engine): a Playwright/browser test asserting `textareaEl.getBoundingClientRect()`'s vertical center equals the attach button's, for both the empty/placeholder state and after typing 2-3 lines (confirming icons stay pinned to the first line rather than drifting to the box's new center). This is the verification gap that let rounds 2-4 all pass their own class-string tests while the visual defect persisted.
- Manual/visual re-check of the status-line row alignment per the RISKS note above.

---

## diag:attach-files-scope

## ITEM 4 — ⊕ 菜单 + 真附件选择：工作单

### ROOT CAUSE (current state, not a bug — capability gap)

**⊕ 当前行为**
- `src/renderer/components/chat/ChatComposer.tsx:1998-2012` — `attachButton`，`onClick={handleAddFileContext}`，`aria-label="Add file context"` / `title="Add file context (@)"`。同一节点在两模式各渲染一次：`:2223-2224`（session 档）与 `:2242-2243`（empty 档）。
- `ChatComposer.tsx:639-661` `handleAddFileContext` → `fileMention.ts:105` `insertMentionTrigger(value, caret)` 写 `@` + 置光标 + `extractMentionQuery` 唤起 popup。**唯一调用点**（全仓 grep 仅此处 + F-A12 测试）。
- 类：`middleColumnLayout.ts:234-243` `composerAttachButtonClass()`（`size-6 rounded-sm hover:bg-hover focus-visible:bg-hover`，无 border/shadow）。

**为什么当时只做了 @ 而不是附件**（注释与设计文档都写明了）：`ChatComposer.tsx:2004-2006`、`fileMention.test.ts:183-189`、`docs/plans/2026-07-31-t30b2-composer-form-design.md:470` — 「本仓无 renderer 侧读文件字节的 IPC」。**该判断至今成立**：

| 候选通路 | file:line | 为什么不能用 |
|---|---|---|
| `file:read` | `src/main/ipc/files.ts:442-491`，类型 `src/shared/types/file.ts:15-21` | 只返回**解码后的文本** `content: string`；二进制走 `:469-477` 直接返回 `content:''、isBinary:true` → **图片拿不到字节**；且 `readFileSafe` 无任何大小上限（2GB 文件直接进主进程内存） |
| `file:save-to-temp` | `files.ts:399-440` | 只写不读（EnhancedInput 贴图用） |
| `local-file://` | `src/main/index.ts:427-447` + `services/files/LocalFileAccess.ts` | 受 `isAllowedLocalFilePath` 根白名单管控，任选路径 403；要用就得把用户选中文件的**整个目录**注册为可读根 → 反而放大读权限，比新开一条定向通道更差 |
| `dialog:openFile` | 通道 `src/shared/types/ipc.ts:168`；主进程 `src/main/ipc/dialog.ts:32-52`；preload `src/preload/index.ts:539-545` | **只返回路径**，`properties:['openFile']` 单选，`return result.filePaths[0]`。现仓唯一消费者是 `AppearanceSettings.tsx:483`（背景图，拿路径给 `local-image://`）；`AddRepositoryDialog.tsx:402/416` 用的是 `openDirectory()`，不是它 |

**粘贴附件管线（T-18，要复用的那条）**
- 限额：`attachmentLimits.ts:37-42`（`maxCount 5` / 图 `5MB` / 文本 `512KB` / 单次总量 `10MB`）、`:66-101` `admitAttachment()`（顺序 empty→count→single→total，含全部拒绝文案）、`:116-143` `planImageAttachment()`（四格式白名单 + 8000px 边长）。
- 识别：`attachments.ts:150-178` `detectAttachmentKind(name, mime)` —— **MIME 缺失时按扩展名兜底**（`:146-148` 注释：Windows 上 `File.type` 常为 `''`），所以「只有路径没有 MIME」的选文件场景天然可用。
- IO 与状态：`useComposerAttachments.ts:83-184` `ingestFiles(files: File[])`（`reading` 计数 → 预检 → `arrayBuffer()` → 图片头解析 → 复检 → base64/解码 → `applyDrafts`），`:186-227` `handlePaste` 是它**唯一**入口；`:181` 用 `formatSkipNotice` 折叠所有跳过原因成一条 Alert。
- 送出：`ChatComposer.tsx:828` `toWireAttachments(drafts)` → `:1172` 挂 payload → `stores/chatSessions.ts:155` `sendMessage(text, attachments)` → `src/main/ipc/chat.ts:84-105` `CHAT_SEND` → Host。**这一段一个字不用改。**

**GAP 一句话**：缺的只是「路径 → 字节」这一跳；线协议（`ChatSendAttachment`，`stores/chatSessions.ts:16-21`）已经能载图片/文本。

**纪律归属（(c) 的裁定）**：执行计划 `docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md:165-170` 的「协议变更纪律」只覆盖 `shared/types/runtimeEvents.ts` / `agentHost.ts` / `sessionHistory.ts`（含 CP 与 `AGENT_HOST_PROTOCOL_VERSION` bump）。本改动**不碰这三个文件、不改 agent-host wire、不 bump 版本、不需 CP**。它落在 `:156` 的文件所有权表：`src/preload`、`src/main/ipc/*` 属 🤖 主线自持（team 若需新 IPC 才要提需求）；`src/renderer/components/chat/**` 名义归 👥，但 T-28/T-30 全批主线已在其中施工，沿用现状即可，落库时在总台账记一行（`:170` 第 3 条的通知义务）。

---

### FIX PROPOSAL

#### 1) shared（0.25d）
`src/shared/types/ipc.ts`
```
DIALOG_OPEN_FILES: 'dialog:openFiles',          // 多选，返回 string[]（取消 → []）
FILE_READ_ATTACHMENT: 'file:readAttachment',    // 路径 → 字节（带上限）
```
新 `src/shared/types/attachmentIo.ts`（main/preload/renderer 三端 `@shared` 均可 import，见 `electron.vite.config.ts:59-96` 与 `vitest.config.ts:5-10`）：
```ts
export const MAX_ATTACHMENT_READ_BYTES = 5 * 1024 * 1024;  // 主进程硬顶
export type AttachmentReadResult =
  | { ok: true; bytes: Uint8Array; byteLength: number }
  | { ok: false; reason: 'too-large' | 'not-a-file' | 'unreadable' | 'not-allowed';
      byteLength?: number };
```
> `MAX_ATTACHMENT_READ_BYTES` 必须 === `DEFAULT_ATTACHMENT_LIMITS.maxImageBytes`，用单测锁死（照抄 `attachmentLimits.ts:180-188` 的 mirror 手法）。**不要**让 renderer 的四个限额下沉到 shared——主进程只做「一个硬顶 + 每次调用传入的 maxBytes」，分档判断仍归 `admitAttachment`。

#### 2) main（0.5d）
`src/main/ipc/dialog.ts`：新增 `DIALOG_OPEN_FILES` handler，`properties:['openFile','multiSelections']`，`title: t('Select files')`（`shared/i18n.ts:661` 已有 `'Select file'`，补一条 `'Select files': '选择文件'`），返回 `result.filePaths`（取消 → `[]`）。**不动**现有 `DIALOG_OPEN_FILE`（`AppearanceSettings.tsx:483` 依赖其 `string|null` 返回型）。

`src/main/ipc/files.ts`：新增 `FILE_READ_ATTACHMENT`
```
stat(path) → !isFile() → {ok:false,'not-a-file'}
size > min(maxBytes, MAX_ATTACHMENT_READ_BYTES) → {ok:false,'too-large',byteLength:size}   // 读之前就拒
readFile(path)（普通 fs，不走 readFileTsdSafe、不跑 isBinaryFile —— 附件要原始字节）
→ {ok:true, bytes, byteLength}
```
**路径准入（建议采纳，+0.1d）**：`dialog:openFiles` 把本次选中的路径记入一个 per-`webContents` 的一次性 Set（复刻 `LocalFileAccess.ts:26-56` 的 owner/清理形态，`files.ts:229` 已有 `unregisterAllowedLocalFileRootsByOwner` 的清理点可挂），`FILE_READ_ATTACHMENT` 只服务集合内路径，否则 `'not-allowed'`。理由：`file:read`（`files.ts:442`）今天已能读任意路径的**文本**，但新通道会把「任意路径的原始字节（含二进制）」变成通用原语；用主进程签发的白名单把它钉死在「用户刚刚亲手选中的文件」上，成本约 20 行。

`src/main/ipc/index.ts:59/65` 已有注册调用，无需新增注册点。

#### 3) preload（0.25d）
`src/preload/index.ts`
- `dialog.openFiles(options?: { filters? }): Promise<string[]>`（挨着 `:539-545`）
- `file.readAttachment(path, opts: { maxBytes: number }): Promise<AttachmentReadResult>`（挨着 `:355`）

`ElectronAPI` 由 `typeof electronAPI` 推导（`src/preload/types.ts:1`），renderer 端类型自动到位，无 d.ts 要改。

#### 4) renderer（0.75d）

**a. hook：`useComposerAttachments.ts`**
把 `ingestFiles(files: File[])`（`:83-184`）的入参从 `File[]` 放宽为结构类型（`File` 天然满足，粘贴路径零改动）：
```ts
interface AttachmentSource { name: string; type: string; size: number;
                             arrayBuffer(): Promise<ArrayBuffer> }
ingestFiles(sources: AttachmentSource[], preSkipped?: string[])
```
新增导出 `ingestPickedPaths(paths: string[])`：
1. `setReading(+paths.length)`（Send 门禁 `ChatComposer.tsx:708/2082` 自动覆盖 IPC 读盘期）；
2. 逐路径 `detectAttachmentKind(basename, undefined)` 定 kind → `maxBytes = kind==='image' ? 5MB : 512KB` → `file.readAttachment`；
3. `ok:false` 直接生成 skip 文案，`too-large` **复用 `admitAttachment` 的原句**（同一 `formatAttachmentSize` + 同一措辞）；
4. `ok:true` 包成 `{name, type: detected.mediaType, size, arrayBuffer: async()=>bytes.buffer}` 交给同一条 `ingestFiles` —— 计数/图片头/复检/base64/`formatSkipNotice` 全部原样复用，**不复制任何限额逻辑**。

**b. 菜单 UI：新 `src/renderer/components/chat/ComposerAttachMenu.tsx`**
照 `ComposerModelTrigger.tsx:163-192` 的形（`Menu` + `MenuPrimitive.Trigger render={<button/>}` + `MenuPopup align="start" side={composerPopupSide(mode)}`），单条目 `Attach files`（Lucide `Paperclip`），`onClick` → `dialog.openFiles()` → `ingestPickedPaths`。
- **不要**用 `components/ui/menu.tsx:69` 的共享 `MenuItem`：它带 `text-base sm:text-sm`，会破 D25 分域字号。把 `ComposerModelTrigger.tsx:61-65` 的 `MENU_ITEM_CLASS`/`MENU_GROUP_LABEL_CLASS` 上提为 `middleColumnLayout.ts` 的 `composerMenuItemClass()` 供两处共用。
- `composerAttachButtonClass()`（`middleColumnLayout.ts:234-243`）补 `data-[popup-open]:bg-selection`，与 model trigger 打开态一致；其余不动（`size-6` 必须留在 24 档，F-A4 会查）。
- a11y：`aria-label="Attach files"`、`title="Attach files"`。**旧文案 `Add file context (@)` 全删**——它当初就是为「这不是上传」而写的诚实声明，现在能真上传了。
- 门禁沿用 `disabled || !activeSessionId`（不含 busy/sending，T-19 运行中可攒附件）。
- 菜单形态可扩展：未来加 `Link GitHub Issue/PR` 只是多一个 `MenuItem`。

**c. 移除 @ 注入**
删 `ChatComposer.tsx:639-661` `handleAddFileContext` 与 `:49` 的 `insertMentionTrigger` import。`fileMention.ts:105` 的 `insertMentionTrigger` 随之**无调用点**。两个处理方式二选一，建议 ②：
1. 连函数带 F-A12 测试一起删；
2. **保留函数**，菜单里加第二条 `Add file context (@)` 复用它（+0.05d，F-A12 原样保留，且 Cursor 参考图里也只有 3 条，我们 2 条不违和）。用户本轮只拍了「先一条」，故默认按 ① 落地、把 ② 记 ideas。
> 用户手打 `@` 的通路（`handleContentChange` `:604-622` → `extractMentionQuery`）完全不受影响。

#### 5) 多选与限额（(e) 的答复）
支持多选。**逐文件**过 `admitAttachment`，不做预截断：选 8 个 → 前 5 个入列，后 3 个各得一条 `Up to 5 attachments per message — "x" skipped.`，由 `formatSkipNotice`（`attachments.ts:376-383`）折叠成一条 `3 attachments skipped: …`。零新文案、零限额分叉。

---

### RISKS
1. **IPC 结构化克隆 5MB×5**：单次选择最坏 ~25MB 跨进程拷贝 + renderer base64（×1.34）。`reading>0` 已封住 Send，但 UI 会有可感卡顿。缓解：串行读（上面就是串行）+ 大文件先被主进程 `stat` 挡掉，绝不进内存。
2. **新读字节通道 = 新攻击面**：不加白名单就等于给 renderer 一个任意文件读原语（比现有 `file:read` 的纯文本更值钱）。→ 采纳 §2 的一次性路径白名单。
3. **`data:` 缩略图 OOM**：`shouldRenderThumbnail`（`attachments.ts:357-365`）以 512KB 为界，选文件比粘贴更容易命中 5MB 大图 → 走图标降级，符合既有设计，无需改。
4. **F-A4/F-A15 类断言**：类只做加法（`data-[popup-open]:`），`middleColumnLayout.test.ts:775-793` 的 `matchAll` 正则已能吃带前缀的 step，不会误伤；但 `size-` 档位必须仍是 6。
5. **诚实性红线（A06）**：菜单条目点了必须真出系统选择器；取消对话框必须**不**产生 notice、不动任何状态（`openFiles` 返回 `[]` 即早退）。
6. **文件所有权**：`src/renderer/components/chat/**` 名义 👥 主导（执行计划 `:156`），本批仍由主线改 → 落库时台账记一行并通知团队轨。

---

### TEST SURFACE
vitest 是 **node 环境、只收 `src/**/__tests__/**/*.test.ts`**（`vitest.config.ts:11-14`）—— 菜单交互无法单测，判据必须压进纯函数层 + GUI 点验单。

**新增纯模块（可测）**
- `src/renderer/components/chat/pickedAttachments.ts`：`plannedReadLimit(name) → {kind, maxBytes}`、`pickedSkipMessage(reason, name, byteLength) → string`（与 `admitAttachment` 同文案的锁定断言）。
- `src/main/ipc/attachmentReadGuard.ts`：`checkAttachmentRead({isFile, size}, maxBytes) → AttachmentReadResult['reason'] | null`，测试落 `src/main/ipc/__tests__/`（该目录已存在）。

**改**
- `attachmentLimits.test.ts`：加 mirror 锁 `MAX_ATTACHMENT_READ_BYTES === DEFAULT_ATTACHMENT_LIMITS.maxImageBytes`。
- `middleColumnLayout.test.ts:695-793`：新增 F-A20「⊕ 与 model trigger 共享 ghost/popup-open 三态」；F-A4/F-A15 保持绿。
- `fileMention.test.ts:183-229`（F-A12）：按 §4c 选项 ① 整块退役，并在 `docs/plans/2026-07-31-t30b2-composer-form-design.md:392-400`（F-A12 行）与 `:428`、`:470`、`:639`、`docs/design/a07-cursor-composer-alignment.html:3227`（「本仓无 renderer 侧读文件 IPC」的四处旧论断）同步改写——**这几处是本改动的文档红线**，不改就是留一份自相矛盾的设计档。

**GUI 点验单（凭证走共享测试网关，执行计划 §测试凭证统一约定）**
① 单图 → chip + 缩略图 + 发送 → 模型能描述；② 一次选 8 个 → 5 入列 + 折叠 notice；③ 600KB `.md` → 512KB 拒绝文案；④ 8MB PNG → 秒拒不卡（主进程 stat 拦截，未读盘）；⑤ 取消对话框 → 无 notice、无状态变化；⑥ 手打 `@` popup 照常；⑦ 键盘：Tab 到 ⊕ / Enter 开菜单 / Esc 关且焦点回落；⑧ 运行中（busy）仍可开菜单加附件，随下一条消息发出。

---

### ESTIMATE（0.25d 单位）

| 面 | 单位 | 内容 |
|---|---|---|
| 协议/shared | 1 (0.25d) | 2 个 channel 常量 + `attachmentIo.ts`（含硬顶与结果型） |
| main | 2 (0.5d) | `dialog:openFiles` 多选 + `file:readAttachment`（stat 上限/isFile/普通 readFile）+ 一次性路径白名单 + i18n `'Select files'` |
| preload | 1 (0.25d) | `dialog.openFiles` / `file.readAttachment` |
| renderer | 3 (0.75d) | hook 入参放宽 + `ingestPickedPaths` + `ComposerAttachMenu.tsx` + `composerMenuItemClass` 上提 + 删 `handleAddFileContext`/文案 |
| 测试 | 2 (0.5d) | 2 个新纯模块及其用例 + mirror 锁 + F-A20 + F-A12 退役 |
| **小计** | **9 (2.25d)** | |
| 落库/文档 | 1 (0.25d) | 设计文档 4 处旧论断改写 + 台账一行 + plantree |
| **合计** | **10 (2.5d)** | |

**红线/跨主体文件清单**：`src/shared/types/ipc.ts`（通道注册表，**非**三大协议文件 → 无需 CP/无需 bump）、`src/preload/index.ts`（dialog/file 段，🤖 自持）、`src/main/ipc/dialog.ts`、`src/main/ipc/files.ts`（🤖 自持）、`src/renderer/components/chat/**`（👥 名义主导 → 落库通知）、`docs/plans/2026-07-31-t30b2-composer-form-design.md` + `docs/design/a07-cursor-composer-alignment.html`（旧「无读文件 IPC」论断，必须同批改写）。**不触碰** `runtimeEvents.ts` / `agentHost.ts` / `sessionHistory.ts`。

---

## 编排者裁定（修复批依据）

1. **D1**：采诊断案——LeftNav 本地 focusedProjectId（文件夹头点击 + 会话选中双路同步），解析序 focusedFolder → activeSession → 首个可用；不复活全局 selectedWorkspaceId（守 T-26 决定）；不新增文件夹选中视觉，改为 New 按钮 title 显示目标（"New session in {folder}"）保持可发现性；canCreateSessionOnWorkspace 门禁随新解析序重估。
2. **D2**：采轻量索引 IPC 案——新增 chat.registerSession（仅 recordCreated，不拉起 Host），createChatSessionOnWorkspace 创建时 fire-and-forget 调用；archive 对未索引会话：先补 recordCreated 再重试一次，仍败则纯 renderer 移除（live-only 无服务端真相可保）；close 语义定为「detach + 本次运行从列表移除」（持久化会话重启后重现属设计，永久移除走归档）——语义写进代码注释与台账；TOCTOU 用 hostBoundSessionIds 串行判据防护。
3. **D3**：采 items-start 案；连带 sessionStatusLineWrapperClass 加 h-6 定高盒（否则 13px 状态行 top-flush 产生新错位）；字符串断言更新 + 实布局验证留 GUI 点验。
4. **D4**：按工单全量施行；⊕ 菜单暂只 Attach files（方案①：删 handleAddFileContext 与 insertMentionTrigger + F-A12 退役；「菜单加第二条 Add file context (@)」记 ideas）；一次性路径白名单**采纳**（+0.1d 安全钉）；文档四处旧论断（「本仓无读文件字节 IPC」）同批改写为红线。
