# Onboarding Config Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 onboarding 注册状态丢失，并让 Claude/Codex 配置按当前运维要求落盘、备份与校验。

**Architecture:** 保持方案 A，不拆分 onboarding 文件。通过主进程统一 settings 合并写入修复缓存覆盖问题；在 onboarding 服务内新增本地配置写入与校验助手，分别处理 Claude 与 Codex 的备份、规范化写入和验证。

**Tech Stack:** Electron main process, TypeScript, Vitest, Node fs/path/os utilities

---

### Task 1: Add failing tests for onboarding persistence and config writers

**Files:**
- Create: `src/main/services/onboarding/__tests__/OnboardingService.test.ts`
- Modify: `src/main/services/onboarding/OnboardingService.ts`
- Modify: `src/main/services/claude/ClaudeProviderManager.ts`

- [ ] **Step 1: Write the failing tests**

Cover these behaviors:
- onboarding state merge keeps existing `enso-settings` and persists `onboarding`
- Claude config write creates a backup and writes `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io`
- Claude config write preserves unrelated settings fields
- Codex config write creates backups and writes `config.toml` plus `auth.json`
- register returns failure when post-write validation fails

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/services/onboarding/__tests__/OnboardingService.test.ts`
Expected: FAIL because current implementation still writes onboarding directly, writes Codex to `env.json`, and does not back up or validate config files.

### Task 2: Fix onboarding state persistence and config writing

**Files:**
- Modify: `src/main/ipc/settings.ts`
- Modify: `src/main/services/onboarding/OnboardingService.ts`
- Modify: `src/main/services/claude/ClaudeProviderManager.ts`

- [ ] **Step 1: Add a settings merge/update helper in main process**

Implement a helper that reads the current root settings, merges a patch, updates the shared cache, and writes once through the shared persistence path.

- [ ] **Step 2: Update onboarding state save path**

Make `OnboardingService` save onboarding through the shared settings merge helper instead of direct file overwrite.

- [ ] **Step 3: Implement Claude config backup and normalized write**

Back up existing `~/.claude/settings.json` before mutation, preserve unrelated fields, and write:
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

- [ ] **Step 4: Implement Codex config backup and required file format**

Stop writing `env.json` in onboarding. Write:
- `~/.codex/config.toml`
- `~/.codex/auth.json`

Use the required provider/model template and keep backups of existing files before overwrite.

- [ ] **Step 5: Add post-write validation**

After successful server registration, verify onboarding state, Claude settings, and Codex files. Return an error if validation fails.

- [ ] **Step 6: Run the targeted tests**

Run: `npm test -- src/main/services/onboarding/__tests__/OnboardingService.test.ts`
Expected: PASS

### Task 3: Verify integration safety

**Files:**
- Modify: `src/shared/types/onboarding.ts`
- Modify: `src/renderer/components/onboarding/OnboardingDialog.tsx` only if API result handling needs text adjustment

- [ ] **Step 1: Keep response typing aligned with new validation errors**

Only update shared types or renderer text if the main-process error surface changes.

- [ ] **Step 2: Run project verification**

Run:
- `npm test -- src/main/services/onboarding/__tests__/OnboardingService.test.ts`
- `npm test -- src/main/services/git/__tests__/gitLogFormat.test.ts`
- `npm run typecheck`

Expected:
- targeted onboarding tests pass
- existing sample main-process test still passes
- typecheck exits 0

- [ ] **Step 3: Review git diff**

Run: `git diff -- src/main/ipc/settings.ts src/main/services/onboarding/OnboardingService.ts src/main/services/claude/ClaudeProviderManager.ts src/main/services/onboarding/__tests__/OnboardingService.test.ts src/shared/types/onboarding.ts src/renderer/components/onboarding/OnboardingDialog.tsx`

Expected: only the planned files changed for this fix.
