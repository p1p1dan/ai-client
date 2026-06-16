# vflow Workflow Definition

> This file is the single semantic center of vflow: task classification rules,
> per-state behavioral constraints, and approval gate rules are all defined here.
> inject.py extracts the matching [workflow-state:*] block based on current task
> state and injects it into each conversation turn.
> To change workflow behavior, edit this file — no code changes needed.

## Pipeline (v2)

All tasks (T1 and T2) run the same 6-state pipeline. Tier only controls the
*thickness* of each station's artifact and how often the human is consulted —
never which stations are skipped.

```
created -> analyzed -> designed -> implementing -> verified -> archived
             |            |             |              |           |
       requirement.md  design.md    worklog.md     verify.md   journal
       (SWE.1, R-IDs)  (SWE.2/3)   (SWE.4 log)    (SWE.4/5/6) (+spec writeback)
```

State moves ONLY via `python .vflow/scripts/task.py advance` (checks exit
conditions mechanically) and `task.py done --summary "..."` (verified ->
archived). `task.py back` returns verified -> implementing when code must
change after verification. Bypasses (`advance --skip-check`, `done --force`)
are recorded in task.json and visible in monthly audits.

## Task Classification

| Tier | Criteria | Artifact thickness | Human gates |
| :--- | :--- | :--- | :--- |
| T0 Q&A | Explanation / comparison / query, no code changes | None (no task) | — |
| T1 Quick | Single-file small change, low risk, clear intent | Thin: 1-2 R-IDs, one-line sections | None (AI advances autonomously, report at end) |
| T2 Standard | New feature / algorithm, cross-file, touches core modules | Full: 3-8 R-IDs, complete sections | Gate 1 (requirement) + Gate 3 (acceptance); high risk adds Gate 2 (design) |

## Risk Determination (controls number of approval gates)

High risk (any one): change touches config.json core_paths | expected changes >3 files | irreversible operation (delete file / change interface signature / change data format)
Low risk: everything else

## Human Gates

| Risk | Gate 1 (after requirement) | Gate 2 (after design) | Gate 3 (before archive) |
| :--- | :--- | :--- | :--- |
| T1 | — | — | — (one-line report after archive) |
| T2 low | ✅ confirm R-IDs | — | ✅ confirm verify report |
| T2 high | ✅ | ✅ confirm design | ✅ |

Use AskUserQuestion for gate confirmations whenever possible.

## Skip Detection Rule

ONLY these exact user phrases constitute a skip signal:
  "skip" | "直接做" | "跳过" | "不用规划" | "不走流程"

### Anti-patterns (these are NOT skip signals)

- Implementation strategy: "use goal mode", "fix file by file", "start from XX"
- Urgency: "hurry", "快点", "赶紧做"
- Confirmation: "go ahead", "就这样做", "可以开始了"
- Scope refinement: "focus on XX first", "先做XX部分"

When uncertain whether the user means to skip: ASK
"Do you want to skip the planning phase and implement directly, or use this as an implementation strategy within the plan?"

Even when skipping ceremony (`advance --skip-check`), spec/ conventions and
the test hard rule still apply.

---

[workflow-state:no_task]
No active task. After receiving a user message, classify first, then act.

### Classification [required·once]
1. Classify and state explicitly using this fixed phrase:
   "📋 Tier: T{0|1|2} {Q&A|Quick|Standard} (reason: ...). {next action}"
2. T0 Q&A → answer directly, no archive, no tier output (pure Q&A, don't interrupt)
3. T1 Quick → output tier statement → run `python .vflow/scripts/task.py create <slug> --title "<title>" --tier T1` → execute per .vflow/skills/vflow-quick/SKILL.md (thin-archive mode, advance autonomously)
4. T2 Standard → output tier statement → run `python .vflow/scripts/task.py create <slug> --title "<title>"` → execute per .vflow/skills/vflow-task/SKILL.md

### Override and Correction
- When the user specifies a tier via /vflow:task or /vflow:quick, obey — do not re-classify
- When the user uses a skip phrase (see Skip Detection Rule above) → bypass workflow ceremony, but still follow spec/ conventions and test hard rules
- The user can change tier with a single phrase (e.g. "handle this as quick"), switch immediately without argument

### Prohibited
- Starting code changes before classification (T0 exempt)
- Treating "here's a proposed plan" as task completion
[/workflow-state:no_task]

[workflow-state:created]
Task created. Current station: requirement analysis (SWE.1).

### Requirement Analysis [required·once]
1. T2: execute vflow-brainstorm flow (auto-context → gated questions, one at a time, AskUserQuestion preferred → converge). T1: skip questioning if intent is clear.
2. Fill requirement.md: original request, clarifications, and **R-ID acceptance entries** (lines `- R<n>: ...`). T1: 1-2 R-IDs. T2: 3-8 R-IDs covering edge conditions.
3. Gate 1 (T2 only): show R-IDs, ask user to confirm requirement understanding (AskUserQuestion).
4. Run `python .vflow/scripts/task.py advance` (validates requirement.md is filled and defines at least one R-ID).

### Prohibited
- Advancing with placeholder R-IDs (e.g. "- R1: make it work")
- Writing any design or implementation before R-IDs are stated
[/workflow-state:created]

[workflow-state:analyzed]
Requirement confirmed. Current station: design (SWE.2 architecture + SWE.3 detailed design).

### Design [required·once]
1. Draft the design in conversation first: architecture impact (one line if none), change list, ADR-lite decisions (T1 may omit), **test plan**, spec manifest (which spec/ files to read, with reasons).
2. Fill design.md. The task checklist items MUST carry trailing R-ID tags: `- [ ] 1.1 ... (R1)` or `(R1,R3)`. Every R-ID from requirement.md must be covered — advance is mechanically rejected otherwise.
3. If narrowing machine verification scope, declare it in the test plan and run `task.py set test_scope "<command>"`.
4. Set risk: `python .vflow/scripts/task.py set risk {low|high}`
5. Gate 2 (high risk only): 🛑 STOP. Show the design, wait for user confirmation (reply ok/confirm/可以/行) before advancing.
6. Run `python .vflow/scripts/task.py advance` (validates design.md filled + R-ID coverage).

### Prohibited
- Writing implementation code in this state (high risk: not before user confirmation)
- Checklist items without R-ID tags
- Copying injected <vflow-state>/<vflow-context> content into deliverable files
[/workflow-state:analyzed]

[workflow-state:designed]
Design confirmed. Run `python .vflow/scripts/task.py advance` to enter implementation (creates worklog.md), then implement.
[/workflow-state:designed]

[workflow-state:implementing]
Current station: implementation (SWE.4). Implement checklist items one by one.

### Implementation [required·repeatable]
1. Before coding, read the spec files listed in design.md's spec manifest (关联规范); if missing, select .vflow/spec/ files by topic (filter modules by config.json features)
2. Implement items from design.md checklist one by one: check `[x]` after each, append a row to worklog.md (`| time | file | change |` — **every changed file must be logged; the mtime cross-check at archive depends on it**)
3. Mirror the checklist into Claude's task list (TaskCreate) right after entering this state; mark tasks completed (TaskUpdate) as you check items. design.md is the source of truth. On cross-session resume, continue from the first unchecked item.

### Scope Change Handling [required·continuous]
If the user changes scope during implementation:
- Update requirement.md R-IDs and design.md checklist BEFORE implementing the change (sync Claude task list)
- Note the scope change in worklog.md

### Test Hard Rule [required·continuous]
(Default: enabled. Exempt when config.json test_required=false)
4. No test directory → create scaffold first per .vflow/skills/vflow-test/SKILL.md (this is REQUIRED: machine verification needs a runnable test_command)
5. New class / public interface → write test cases (happy path + edge cases)

### Verification [required·once]
6. When all checklist items are checked, fill verify.md §1 (one `- R<n>: ...` result line per R-ID), §2 integration (or "不适用" + reason), then run `python .vflow/scripts/task.py advance`
   - task.py will EXECUTE config.build.test_command itself (or task.json test_scope): exit≠0 → transition rejected with failure output; exit 0 → machine record appended to verify.md by the script
   - Do NOT paste test output yourself — the machine record is authoritative
7. If tests fail: fix code, log files in worklog.md, advance again

### Prohibited
- Skipping test hard rule (exempt only: pure comment/doc changes, or config.test_required=false)
- Editing the machine execution record in verify.md
- Deviating from the confirmed design without informing the user
[/workflow-state:implementing]

[workflow-state:verified]
Machine verification passed. Current station: review and archive.

### Quality Review [required·once]
1. Run quality check per .vflow/skills/vflow-review/SKILL.md (**high-risk tasks must use independent review mode**: fresh-context sub-agent), fill the review section of verify.md
2. Spec accumulation: review worklog.md for new conventions/patterns/gotchas → if found, trigger vflow-spec flow (draft → user confirmation → write to spec/)

### Gate 3 [required·once]
3. T2: 🛑 show the verify report (R-ID closure + machine record summary), wait for user confirmation. T1: skip, report one line after archive.

### Archive [required·once]
4. Run `python .vflow/scripts/task.py done --summary "<one-line outcome including new test count>"`
   - Validates: every R-ID has a result entry in verify.md §1; source files unchanged since machine verification (mtime cross-check)
   - If code changed after verification: `task.py back` → re-advance (re-runs tests)

### Prohibited
- Archiving without showing the verify report (T2)
- Using `done --force` without explicit user confirmation
[/workflow-state:verified]
