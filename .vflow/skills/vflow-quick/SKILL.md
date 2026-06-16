---
name: vflow-quick
description: "vflow quick task (T1) flow: single-file small changes, low-risk tasks executed through the same 6-state pipeline with thin artifacts. Use when task is classified as T1 or user invokes /vflow:quick."
---

# vflow Quick Task Flow (Thin-Archive Mode)

T1 tasks run the SAME 6-state pipeline as T2 — only the artifacts are thin
(one or two lines per section) and there are NO human gates. The AI advances
autonomously and reports once at the end. Uniform archive format is the point:
any audited task looks structurally identical.

## Input Contract

- User's task description (classified as T1: single file, low risk, clear intent)
- `.vflow/config.json` (test_command, test_required)

## Steps

### 1. Create [required·once]
`python .vflow/scripts/task.py create <slug> --title "<title>" --tier T1`

### 2. Requirement (created → analyzed) [required·once]
Fill requirement.md thin: original request one line, skip clarification table if intent is clear, **1-2 R-IDs** (`- R1: ...`). Then `task.py advance`.

### 3. Design (analyzed → designed) [required·once]
Fill design.md thin: "无架构影响" if so, change list 1-2 rows, checklist 1-3 items **each tagged (R<n>)**, test plan one row. Optionally `task.py set test_scope "<narrow command>"` if full suite is too heavy (declare in test plan). Then `task.py set risk low` and `task.py advance`.

### 4. Implement (designed → implementing → verified) [required·once]
`task.py advance` to enter implementing. Code the change. Log every changed file in worklog.md.
Test hard rule (exempt when config.test_required=false): logic change → update/add test case; pure comment/doc change → note exemption in worklog.
Fill verify.md §1 (one `- R<n>: ...` line per R-ID), §2 "不适用" + reason if applicable. Then `task.py advance` — task.py executes the test command itself and appends the machine record. If it fails, fix and advance again.

### 5. Archive (verified → archived) [required·once]
`python .vflow/scripts/task.py done --summary "<one-liner>"`
Optionally add one index line to `.vflow/tasks/quick-log.md` pointing to the archived directory.

## Output Template

After completion (single report, no mid-flow interruptions):
"⚡ Quick task done: {change summary}. Archived: tasks/archive/YYYY-MM/{id}/. Machine verification: {exit 0, N tests passed}"

## Guardrails

- If during implementation the change exceeds T1 scope (>3 files or touches core_paths) → stop and state "Task exceeds T1 scope, recommend upgrading to standard task", ask the user
- Machine verification must not be skipped even for quick tasks (test_required=false is the only exemption)
- Do not ask the user gate questions for T1 — autonomy is the contract; escalate only on scope breach or genuine ambiguity
