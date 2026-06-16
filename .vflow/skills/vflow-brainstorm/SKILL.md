---
name: vflow-brainstorm
description: "Requirements discovery with auto-context, question gating, and diverge→converge. Called from vflow-task step 2 or standalone when requirements are unclear."
---

# vflow Brainstorm — Requirements Discovery

Systematic requirements discovery before design. Reduces low-value questions, surfaces hidden scope, and converges to a complete requirement.md.

## Input Contract

- User's task description (classified as T2)
- Project codebase and `.vflow/config.json`
- Empty or partial `requirement.md` in the task directory

## Steps

### 1. Auto-Context [required·once]

Before asking the user anything, gather context yourself:

- Inspect code, configs, and docs related to the task topic
- Locate existing patterns, similar features, conventions
- Note constraints (dependencies, build tooling, API contracts)
- Check `.vflow/spec/` for relevant domain knowledge

Write findings into the conversation as a brief summary: "Here's what I already know from the codebase: ..."

### 2. Gated Questions [required·repeatable]

For each potential question, run the gate before asking:

| Gate | Check | If yes |
| :--- | :--- | :--- |
| A: Derivable? | Can I answer this from code, config, docs, or quick inspection? | Don't ask — derive it, state your finding |
| B: Meta? | Is this "should I search?" / "can you paste the code?" | Don't ask — take action directly |
| C: Type? | Is this Blocking (cannot proceed) or Preference (multiple valid choices)? | Ask only Blocking or Preference questions |

Rules:
- **One question per message** — never stack multiple questions
- **Prefer AskUserQuestion** with concrete options over open-ended text questions
- **For preference questions**: present 2-3 specific approaches with trade-offs, not "what do you want?"
- After each answer: immediately update requirement.md with the conclusion

### 3. Diverge Sweep [required·once]

After core requirements are understood, proactively expand thinking before converging. Present one message with 1-2 bullets per category:

1. **Future evolution** — What might this feature become in 1-3 months? What extension points are worth preserving now?
2. **Related scenarios** — What adjacent features should remain consistent? Parity expectations?
3. **Failure & edge cases** — Conflicts, data loss risks, idempotency, input validation, rollback

**5W1H blind-spot scan** — After the 3 categories above, run a quick 6-dimension check to catch gaps the categories missed:

| Dimension | Check Question |
| :--- | :--- |
| **What** | Is the deliverable clearly defined? Any ambiguity in what "done" means? |
| **Why** | Is the motivation documented? Would a different person reach the same conclusion about why this is needed? |
| **When** | Are there timing constraints, dependencies, or ordering requirements not yet captured? |
| **Where** | Which modules/layers/systems are affected? Any cross-boundary impacts missed? |
| **Who** | Who are the consumers of this change? Any stakeholders or downstream users not considered? |
| **How** | Is the implementation approach clear? Any unresolved technical choices? |

If any dimension reveals a gap, add it to the diverge list. If all 6 are covered, state "5W1H: no additional gaps found."

Ask the user (via AskUserQuestion): "Which of these should be in MVP scope?"

Update requirement.md:
- Selected items → requirements / acceptance criteria
- Excluded items → out of scope (explicit)

Skip this step if the task is genuinely simple (single-file change with clear scope) — state "Diverge sweep skipped: scope is narrow and unambiguous."

### 4. Converge [required·once]

Write the final requirement.md with all sections filled:
- Original requirement
- Q&A log (question + answer table)
- Requirement conclusions: goal, in-scope, out-of-scope, acceptance criteria

Confirm with the user: "Requirements are captured. Proceeding to design phase."

## Output Template

After step 1:
"🔍 Auto-context complete: found {N} relevant files/patterns. {key finding}."

After step 3:
"🔀 Diverge sweep: {N} items across 3 categories. Which belong in MVP?"

After step 4:
"✅ Phase complete: Requirement. Next: Design."

## Guardrails

- Never ask a question that fails all three gates — derive the answer yourself
- Never present more than one question per message
- AskUserQuestion is the preferred mechanism for all "user must decide" moments
- Do not skip the diverge sweep for T2 tasks unless scope is genuinely narrow (state the reason)
- Do not copy auto-context raw output into requirement.md — synthesize conclusions only
