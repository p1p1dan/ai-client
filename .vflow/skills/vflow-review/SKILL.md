---
name: vflow-review
description: "Three-dimensional, three-level code review against vflow spec library (completeness / correctness / consistency × CRITICAL / WARNING / SUGGESTION). Auto-used during standard task quality check phase; user can also invoke independently with 'check against spec'."
---

# vflow Spec Review

Compare current changes against .vflow/spec/ conventions line by line, producing an actionable graded issue list.

## Input Contract

- Review scope: files changed in the current task (git diff or files listed in worklog.md); when invoked independently, scope is user-specified
- `.vflow/spec/index.md` + spec content filtered by config.json features
- Task archive (if available): requirement.md / plan.md for completeness checking

## Steps

### 1. Determine Scope [required·once]
List all files changed in this task (prefer `git diff --name-only`, fall back to worklog.md).

### 2. Load Specs [required·once]
Prefer the spec manifest in the task's plan.md (关联规范 — files + reasons declared at design time); supplement or fall back to spec/index.md topic selection. Exclude disabled modules (e.g. qt:false → skip Qt entries).

### 3. Three-Dimensional Check [required·once]

**Completeness**: Are all plan.md change items and checklist items done (all checkboxes ticked)? Are all test cases promised in the test plan written?

**Correctness**: Does the implementation meet requirement.md acceptance criteria? Are edge cases handled?

**Consistency**: Check against spec entries line by line:
- Violates [RULE] level → CRITICAL (core safety / resource) or WARNING (style / structure)
- Violates [SUGGEST] level → SUGGESTION

### 3.5 Design Logic Audit (Critical Thinking) [required·conditional]

**Trigger**: T2 tasks that contain design decisions (ADR entries in design.md). Skip for T1 tasks and pure bugfixes with no design choices.

Apply the 4-point critical thinking examination to each design decision / ADR:

| # | Examination | What to check |
| :--- | :--- | :--- |
| 1 | **Premise reliable?** | Are the stated constraints and assumptions still true? Were any invalidated during implementation? |
| 2 | **Evidence sufficient?** | Is the decision backed by concrete data (benchmarks, test results, prior experience) or just intuition? |
| 3 | **Logic coherent?** | Does the conclusion follow from the premises? Any logical jumps or unstated dependencies? |
| 4 | **Better alternative?** | Given what we now know post-implementation, is there a simpler or more robust approach we missed? |

**Output**: For each ADR examined, append one line to the review report:
- `✅ ADR-N: all 4 checks passed`
- `⚠ ADR-N: [exam #] failed — {finding}` → escalate to WARNING level

### 4. Confidence Filter [required·once]
Only report high-confidence findings (definite violation, specific spec entry cited). When uncertain, downgrade (WARNING → SUGGESTION) or omit.

### 5. Output Report [required·once]
(See template below.) In task workflow, also write results to the review section of verify.md.

### 6. Independent Review Mode [on demand]
(Mandatory for high-risk tasks; user can also request "independent review" at any time)
- Do NOT self-review in the main conversation. Instead, dispatch a fresh-context sub-agent via the Agent tool to perform the review — avoids "reviewing your own code" confirmation bias.
- Dispatch prompt must be self-contained: file list + requirement.md/plan.md paths + spec file paths to read + the 3D/3-level criteria and output template from this skill + "output report only, do not modify any files"
- After sub-agent reports back, write the report verbatim into verify.md marked as "Independent Review". The main conversation must not delete or alter sub-agent findings; it may add a remediation plan.

## Output Template

```
## Spec Review Report

Scope: N files | Specs loaded: common + <language> [+ qt/embedded]

| Dimension | Result |
| Completeness | ✅/⚠ {details} |
| Correctness | ✅/⚠ {details} |
| Consistency | {X CRITICAL / Y WARNING / Z SUGGESTION} |

### CRITICAL (must fix)
- file.cpp:42 {issue} → {fix suggestion} (violates cpp.md#57 base class virtual destructor)

### WARNING (should fix)
...
### SUGGESTION (advisory)
...
```

## Guardrails

- Every finding must include file:line and the specific spec entry violated — no vague "suggest reviewing overall" outputs
- Do not review pre-existing code outside the change scope (unless user explicitly requests) — follow "strict on new code, lenient on legacy"
- When CRITICAL findings exist, explicitly state "archival not recommended until fixed"
- Finding issues in your own code is not a failure — missing them is
