# Ledger: 对话输入框 IME 中英切换（Shift）时组合文本丢失 (P-20260703-004)

## [2026-07-03T17:37] understand（根因分析）
- 现象: 增强对话输入框（EnhancedInput）在中文输入法组合态下按 Shift 切换中英时，已输入的组合文本丢失。
- 代码定位:
  - `src/renderer/components/chat/EnhancedInput.tsx:811-828` 受控 `<textarea value={content}>`。
  - `onCompositionEnd`（820-822）仅置 `composingRef.current=false`，**未从 DOM 回同步最终值**。
  - 内容链路: `onChange→handleContentChange→onContentChange→setEnhancedInputContent`（`EnhancedInputContainer.tsx:64` / `agentSessions.ts:542`）→ 重渲染 `value=content`。整条链路每次 input（含组合期）都经 Zustand store 异步回写。
- 根因假设（可证伪）: 正常中文输入由 React 在 compositionend 后补发的 onChange 落库，故正常可用；但 **Shift 切中英触发的 compositionend** 场景下，Chromium 未补发携带已提交文本的 input/onChange（或携过期值），而 `onCompositionEnd` 无兜底回写 → 已提交组合文本未进 store → 丢字。"正常中文可用、仅 Shift 丢字"佐证问题局限在**提交路径兜底**，而非组合期受控回写本身。
- 约束: 测试基建为 vitest `environment:'node'`，仅收录 `__tests__/**/*.test.ts`，无 jsdom / @testing-library/react，无 React 组件级测试栈。
- 待决: 修复落点（compositionEnd 兜底回写）与验证方式（手动复现 vs 引入 DOM 测试栈）留待 decide/check。

## [2026-07-03T17:38] understand -> decide
- 修复方案（外科式，单点）: `onCompositionEnd` 在置 `composingRef=false` 后，追加 `handleContentChange(e.currentTarget.value)`，从 DOM 强制回写已提交文本并补跑 mention/slash 检测。
  - 正确性依据: Chromium 事件序为 `compositionend`→`input`，compositionend 触发时 `target.value` 已含提交文本；React 17+ 无事件池，同步读 `currentTarget.value` 安全。
  - 幂等性: 正常路径下 React 仍会补发 onChange，重复调用 `handleContentChange` 仅重设相同值 + 重跑检测，无副作用（never break userspace）。
  - 拒绝的替代方案: 组合期改用非受控 textarea（ref 驱动）——改动面大、正常中文输入已可用，违反"不重构未损坏模块"。
- 验证方式裁决: 依优先级栈 rule1（KISS/YAGNI）高于 rule4（testing），拒绝为 2 行 handler 引入 jsdom/@testing-library/react 组件测试栈。验证 = `typecheck` + `lint` + 文档化手动复现步骤。是否加自动化 DOM 测试作为可选项在 check 交用户裁定（我无法在本环境驱动 IME）。
- spec_refs: common/debugging.md（根因/可证伪）、common/basic.md（外科式+简洁优先）。

## [2026-07-03T17:39] decide -> build
- Satisfied: scope 已定（EnhancedInput.tsx onCompositionEnd 单点兜底回写）；spec_refs 已声明（debugging.md / basic.md）；执行项 E-001 已拆分。硬门槛（scope + spec_refs）满足。

## [2026-07-03T17:43] build -> check
- E-001 完成: `EnhancedInput.tsx:820-826` `onCompositionEnd` 改为接收事件参数，置 `composingRef=false` 后追加 `handleContentChange(e.currentTarget.value)`，从 DOM 强制回写 IME 提交文本并补跑 mention/slash 检测。git diff +5/-1（1 文件）。
- 验证:
  - typecheck: `tsc --noEmit` 对 EnhancedInput.tsx 零类型错误。
  - lint: biome 仅剩全仓库既存 CRLF format 债务（基线，P-001 已记录），无 lint/correctness 规则违反。
  - test: `vitest run` 117 passed；3 个失败文件（settings/defaults.test.ts + 2 个 vflow 资源脚本套件）经 stash 本改动后重跑复现完全一致 → 确认为既存基线（defaults 源自 P-011 设置默认变更未同步测试；vflow 套件需 `pnpm prepare:vflow`），与本 IME 修复零依赖、非本次引入。
- 自检（rubric）: 可维护性✓（2 行 + 英文注释说明 why）；正确性✓（compositionend→input 序列，同步读 currentTarget.value 安全，React17+ 无事件池）；向后兼容✓（正常中文路径 React 仍补发 onChange，重复 handleContentChange 幂等，never break userspace）；简洁✓（外科式单点，拒绝引入 DOM 测试栈）。
- 局限（须向用户披露）: 我无法在本无头环境驱动真实 IME/Shift 切换复现，修复正确性依赖事件模型推理 + 需用户在真实中文输入法下手动验收；未加自动化 DOM 组件测试（依 KISS 裁决，见 decide）。
