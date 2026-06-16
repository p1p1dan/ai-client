---
name: vflow-task
description: "vflow standard task (T2) 6-state pipeline: requirement analysis → design → implementation → machine verification → review → archive. Use when task is classified as T2, user invokes /vflow:task, or vflow-state directs standard task flow."
---

# vflow Standard Task Workflow (v2 Pipeline)

Execute a standard task through the 6-state pipeline, producing a complete
task archive with an R-ID trace chain closed end-to-end.
All decisions are recorded. All completions are machine-verified.

```
created -> analyzed -> designed -> implementing -> verified -> archived
```

State moves ONLY via `task.py advance` (mechanical checks) and `task.py done`.

## Task Directory Path

**IMPORTANT**: Task files are stored at `.vflow/tasks/<slug>/` (e.g. `.vflow/tasks/06-15-my-task/`).
There is NO `active/` subdirectory. Never use `.vflow/tasks/active/`. The correct path is always:

```
.vflow/tasks/<slug>/requirement.md
.vflow/tasks/<slug>/design.md
.vflow/tasks/<slug>/worklog.md
.vflow/tasks/<slug>/verify.md
.vflow/tasks/<slug>/task.json
```

The current task name is stored in `.vflow/.runtime/current-task`.

## Input Contract

- User's task description (classified as T2)
- Current <vflow-state> injection with state and task info
- `.vflow/config.json` (features filter specs, core_paths determine risk, test_command)

## Steps

### 1. Create Task [required·once]
`python .vflow/scripts/task.py create <slug> --title "<title>"`
(slug: lowercase English with dashes, e.g. roundness-algo)

### 2. Requirement Analysis (created → analyzed) [required·once]
- Execute vflow-brainstorm flow to discover requirements (auto-context → question gating → diverge/converge)
- Fill requirement.md including **R-ID acceptance entries** (lines `- R<n>: ...`, typically 3-8, covering edge conditions). These are the mechanical anchors for the whole trace chain — make each one independently verifiable.
- **Gate 1**: show the R-IDs, confirm requirement understanding with the user (AskUserQuestion preferred)
- Run `python .vflow/scripts/task.py advance` (rejects if no R-ID is defined)

### 3. Design (analyzed → designed) [required·once]
- Show the full draft in conversation (architecture impact, change list, ADR-lite decisions, **test plan**, spec manifest with reasons)
- Fill design.md. Checklist items MUST carry trailing R-ID tags `(R1)` / `(R1,R3)`; every requirement R-ID must be covered or advance is rejected
- If narrowing machine verification: declare in test plan + `task.py set test_scope "<command>"`
- Risk: `python .vflow/scripts/task.py set risk {low|high}` (high = core_paths / >3 files / irreversible)
- **Gate 2 (high risk only)**: 🛑 STOP. Wait for user confirmation (ok/confirm/可以/行) before advancing
- Run `python .vflow/scripts/task.py advance`

### 4. Implementation (designed → implementing) [required·repeatable]
Run `python .vflow/scripts/task.py advance` (creates worklog.md), then:
- Mirror the design.md checklist into Claude's task list (TaskCreate, one task per item); design.md is the source of truth
- Before coding, read the spec files listed in design.md's spec manifest (关联规范)
- Implement items one by one: check `[x]`, append a worklog.md row (`| time | file | change |`) — **log every changed file; the archive-time mtime cross-check depends on it**, mark the Claude task completed
- Scope change → update requirement.md R-IDs and design.md checklist BEFORE implementing
- Code spec rule: new module/class/public interface → write function-level spec BEFORE implementation per vflow-code (grade → spec → review → implement); modifying existing public interface → update spec BEFORE changing code
- Test hard rule (exempt if config.test_required=false): no test dir → create scaffold per vflow-test (REQUIRED — machine verification needs a runnable test_command); new class/public interface → test cases (happy path + edge)

### 5. Machine Verification (implementing → verified) [required·once]
- Fill verify.md §1: one result line per R-ID (`- R<n>: <interpretation>`), §2 integration (or 不适用 + reason)
- Run `python .vflow/scripts/task.py advance`
  - task.py EXECUTES the test command itself: exit≠0 → rejected with failure output; exit 0 → machine record appended to verify.md by the script
  - Do NOT paste raw test output yourself; never edit the machine record
- On failure: fix code, log files in worklog.md, advance again

### 6. Review & Archive (verified → archived) [required·once]
- Quality check per vflow-review (**high-risk tasks must use independent review mode**: fresh-context sub-agent), fill review section of verify.md
- Spec accumulation: new conventions/patterns/gotchas in worklog.md → vflow-spec flow (draft → user confirmation → write to spec/); nothing new → skip silently
- **Gate 3**: 🛑 show the verify report (R-ID closure + machine record), wait for user confirmation
- Run `python .vflow/scripts/task.py done --summary "<one-line outcome including new test count>"`
  - Validates R-ID closure in verify.md §1 and that no source file changed after machine verification (mtime cross-check)
  - If code changed after verification: `task.py back` → re-advance

## Output Templates

State transitions — one line:
"✅ Station complete: {requirement|design|implementation|verification|review}. Next: {…}"

After archival:
"📦 Task archived: tasks/archive/YYYY-MM/<id>/. Output: {summary}"

## Guardrails

- High-risk tasks: no implementation code before Gate 2 confirmation
- Never bypass advance checks with --skip-check unless the user explicitly asks (recorded in task.json)
- Never use done --force without explicit user confirmation
- Skip Detection Rule (workflow.md): only explicit skip phrases bypass ceremony; spec/ conventions and test hard rule still apply
- Do not copy injected <vflow-state>/<vflow-context> content into deliverable files
