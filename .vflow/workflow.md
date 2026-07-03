# vflow3 Workflow Definition

Pipeline: understand → decide → build → check → done (free backward jump to any node already in history)

## Tier Guide

- **T0**: Pure Q&A — no proposal created
- **T1**: Clear, local, low-risk change — 3-line inline plan, zero artifacts beyond a minimal proposal.json (no state.json/ledger.md, no gates)
- **T2**: Standard feature/fix — full pointer graph (state.json + ledger.md), 2 hard gates apply
- **T3**: Architecture/core/high-risk — T2 + mandatory design reconfirmation (Hard Gate 1a) before entering build

## Skip Detection

If the user's request is clearly T0 (question, explanation, no code change), do NOT create a proposal. Answer directly.

## 常驻规则 (always-on, every node)

- **Uncertainty → ask, don't guess.** If a decision is genuinely the user's to make (spec definitions, system boundaries, tech-stack choices, acceptance criteria), present your analysis and trade-offs and wait for user direction rather than inferring.
- **Stagnation warning.** `inject.js` tracks how many prompts the pointer has sat still. If you see a stagnation warning, either make real progress (a `move`, an `item` transition, a `checkpoint`) or surface the blocker to the user — don't let the warning repeat silently.
- **PR granularity.** Each execution item must produce a diff the user can fully read and understand in one sitting. If an item would touch too many files or lines, split it into smaller items before starting.
- **Rubber duck.** When completing each item, explain in plain terms what the code does, what problem it solves, and any trade-off made — aim for the level of a Slack message to a teammate.
- **Ledger discipline.** Every `move` requires the AI to hand-write the matching transition entry into `ledger.md` (`## [ts] from -> to` + a `- Satisfied:` line) before the *next* move is allowed. The CLI never writes this text — only you do, via Write/Edit.

---

[workflow-state:no_proposal]

No active proposal. Evaluate the user's request:

1. If T0 (pure question/explanation): answer directly, no proposal needed.
2. If T1+ (code change required): create a proposal.

Command: `node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type <bug|feature|refactor|reference_build> --tier <T1|T2|T3>`

[workflow-state:understand]

Proposal created. Build a shared understanding of the problem before deciding anything.

**Actions:**
1. Restate the user's request in your own words; surface hidden assumptions.
2. Investigate the relevant code/config so the problem is grounded in what actually exists, not guesswork.
3. When you can state the problem and its scope in one paragraph, move forward.

Command: `node .vflow/scripts/dist/proposal.js move --to decide`

[workflow-state:decide]

Understanding is settled. Make the key design decisions.

**Actions:**
1. Identify the decision points, alternatives considered, and why you picked what you picked.
2. **Decision ownership:** decisions involving spec definitions, system boundaries, or tech-stack choices are user-owned — present trade-offs and wait for user direction. AI-inferred decisions are only fine for implementation details within an already-approved design.
3. Hand-write the decision into `ledger.md` under a `## [ts] understand -> decide` (first entry) or later `## [ts] decide -> decide` heading, with a `- Satisfied:` line summarizing the decision.

**T3 only — Hard Gate 1a:** before you're allowed to `move --to build`, the *last* decide-related ledger entry must be a self-loop `## [ts] decide -> decide` whose Satisfied line contains the literal marker `confirmed_by_user:true`. Get the user's explicit approval in conversation first, then write that entry yourself — there is no CLI command for it, it's a plain ledger.md edit.

**Before moving to build — Hard Gate 1 (all tiers):** declare your spec citations now:
`node .vflow/scripts/dist/proposal.js spec-ref add --file <path> --reason "..."` (repeatable), or `spec-ref none --reason "..."` if nothing applies.

Command: `node .vflow/scripts/dist/proposal.js move --to build --scope "<one-line problem/scope statement>"`

[workflow-state:build]

Design settled, gates cleared. Implement.

**Loop:**
1. Add items as you identify them: `node .vflow/scripts/dist/proposal.js item add --title "..."`
2. Work one at a time (serial): `item start --item E-NNN`
3. Implement the item's slice of work.
4. `item complete --item E-NNN --note "..."` (or `item block`/`item cancel` if it can't proceed)
5. Repeat until the work is done.

**Guardrails:**
- If goal/scope/approach changes significantly → stop, confirm with the user before continuing.
- If a major new problem is discovered → `move --to decide` to rework the design (any node in `history_stack` is reachable backward).
- Long build sessions: periodically `checkpoint` to leave a recovery trail in ledger.md (已完成/未完成/关键文件/坑/下一步).
- PR granularity and rubber duck rules apply to every item (see 常驻规则 above).

Command: `node .vflow/scripts/dist/proposal.js move --to check`

[workflow-state:check]

Implementation complete. Self-check before asking for acceptance — there is no machine-run verify command in v3; this is an AI judgment checklist.

**Self-check (no fixed schema — use judgment):**
1. **Completeness** — is everything promised in `decide` actually done?
2. **Correctness** — does it meet the understood problem/scope; are edge cases handled?
3. **Consistency** — does it violate any cited spec_ref? Cite file:line for anything questionable.
4. If gaps are found → `move --to build` to reopen items, or `move --to decide` if the design itself needs rework.

**Hard Gate 2 — explicit user acceptance:** once you're confident, PAUSE and hand off to the user — do not proceed silently.

**Actions:**
1. Report to the user: goal / current state / diff-from-goal / self-check results / known risks.
2. Explicitly ask whether the result meets their requirements.
3. ONLY after the user approves in this conversation, relay the acceptance:
   `node .vflow/scripts/dist/proposal.js accept --user-approved`
   (logged with `from=ai_relay` — auditable). The user may also accept themselves in a terminal: `accept` (interactive yes/no).

**Guardrail:** Never run `accept --user-approved` without first reporting AND getting the user's explicit in-conversation approval.

[workflow-state:done]

User accepted. Ready for archival.

**Actions:**
1. Extract knowledge candidates before archiving. Run `knowledge suggest` — it prints the classification guide (Convention / Pattern / Forbidden / Gotcha) for you to apply by hand while reading back through `ledger.md`. Target file: `common/` (language-agnostic) · `lang/<language>.md` · `modules/` (qt/embedded/...) · `domain/<topic>.md`. Persist each with `knowledge save --content "..." --reason "..."`, or `knowledge skip` if nothing is worth keeping.
2. Archive: `node .vflow/scripts/dist/proposal.js archive` (moves the proposal directory into `archive/<yyyy-mm>/`; requires `lifecycle_status=done`, pointer=done, and knowledge processed).
3. **Optional — commit** (only if the user asks): the working tree now holds the full change set — code, version bump, docs, AND the proposal's own `ledger.md`/`state.json` under `.vflow/proposals/`. Commit it as ONE unit. `.vflow/proposals/` and `.vflow/knowledge/` are tracked on purpose (the ledger is the decision record); `.vflow/runtime/` is not. Stage an explicit file list — never `git add -A`. Version bumps and CHANGELOG belong in the SAME proposal's `build`, not a follow-up proposal.

Command: `node .vflow/scripts/dist/proposal.js knowledge suggest` then `archive`

[workflow-state:overview]

vflow3 drives every non-trivial code change through a 5-node proposal lifecycle. Read this map BEFORE acting — do not reverse-engineer the process mid-task.

Pipeline: understand → decide → build → check → done. Backward jump to any node already in `history_stack` is always allowed via `move --to <node>`; forward movement must be to the strict next node.

Tier: T0 = pure Q&A, NO proposal (answer directly). T1 = 3-line inline plan only, no state.json/ledger.md, no gates. T2 = full pointer graph. T3 = T2 + mandatory design reconfirmation (Hard Gate 1a) before build.

BEFORE touching code: if the request is T1+, create the proposal FIRST, then understand.
  `node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type <bug|feature|refactor|reference_build> --tier <T1|T2|T3>`

Two files only (T2/T3): `state.json` is machine-authoritative (pointer/history_stack/scope/items/spec_refs — CLI is the sole writer). `ledger.md` is the human-readable append-only record — the AI hand-writes every transition/checkpoint entry via Write/Edit; the CLI only writes the initial header.

Exactly 2 hard gates: entering `build` requires scope + spec_refs (+ T3 design reconfirmation); entering `done` requires explicit user acceptance via `accept`. Everything else is an AI self-check, not a machine schema.

Acceptance (`check` node): the AI PAUSES and reports goal / current state / diff-from-goal / self-check results / risks, then asks the user. After the user approves in-conversation, the AI runs `accept --user-approved` (logged as ai_relay). The user may also accept themselves in a terminal.

Full step-by-step guide: the `/vflow-proposal` skill.
