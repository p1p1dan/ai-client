---
name: vflow-spec
description: "Spec library knowledge writeback: capture conventions, patterns, and gotchas from implementation/debugging into .vflow/spec/ and update the index. Use when the user says 'record this in spec' / 'this should be a spec', or during task closeout when a valuable convention is discovered."
---

# vflow Spec Writeback

Make the spec library grow with practice — what one session learns, every future session inherits.

## Input Contract

- Content to capture (from conversation context: lessons learned, confirmed approaches, user-approved decisions)
- Current state of `.vflow/spec/index.md` and target spec file

## Classification

Every entry must be classified into one of these categories (Trellis-style):

| Category | Meaning | Example |
| :--- | :--- | :--- |
| **Convention** | Team agreement on naming, formatting, structure | "Prefix private members with m_" |
| **Pattern** | Verified implementation approach | "Use RAII for resource cleanup in device drivers" |
| **Forbidden** | Explicitly banned practice | "Never use raw new/delete in application code" |
| **Gotcha** | Counter-intuitive trap | "Qt signal/slot across threads requires QueuedConnection" |

## Steps

### 1. Determine Target File [required·once]
- Language-independent principle → `common/` corresponding file
- Language-specific (C++, Python, etc.) → `lang/<language>.md` under the relevant topic section
- Feature-specific (Qt / embedded / bindings) → `modules/` corresponding file
- Project domain knowledge (coordinate systems, data formats, algorithm conventions, physical constraints) → `domain/<topic>.md` — create a new topic file if needed and register it in index.md. This is the primary writeback destination in practice.

### 2. Deduplicate [required·once]
- Read the target file; confirm no duplicate or conflicting entries
- If conflict with existing entry → report to user and ask: revise existing entry OR discard new entry

### 3. Draft Entry [required·once]
Format consistent with existing library:
```
N. [RULE|SUGGEST] Description. (source: vflow YYYY-MM-DD, category: <Category>)
```

Exception: `domain/` files may be structured documents (definitions, diagrams, naming tables) instead of numbered entries when the knowledge is systemic — e.g. a full coordinate-system convention. Follow the existing structure of the target file.

Level determination:
- Violation causes bugs / security issues → `[RULE]`
- Style consistency / readability → `[SUGGEST]`

### 4. Present Draft for Confirmation [required·once]
Show to user and wait for explicit confirmation before writing:

"📘 Spec writeback draft (pending confirmation):
Target: {file}
Entry: [{RULE|SUGGEST}] {content} (source: vflow {date}, category: {category})
Reason: {why this is worth capturing}"

### 5. Write and Update Index [required·once]
- Append to target file (sequential numbering)
- If entry count changed significantly, update index.md item count

Confirmation output: "✅ Written to {file} as entry #{N}, index updated"

## Guardrails

- MUST have user confirmation before writing — specs are team assets, not AI-unilateral additions
- Capture knowledge reusable by future tasks. Project domain knowledge (coordinate systems, formats, algorithm conventions) DOES belong — in `domain/`. Only ephemeral single-task details do not (put those in the task's worklog instead)
- One entry at a time; multiple entries confirmed one by one
