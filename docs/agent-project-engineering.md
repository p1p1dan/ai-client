# Agent Project Engineering Standard — Verifiable · Regressable · Comparable · Handoff-ready

> Scope: all future Agent / AI application projects, whether newly built or refactored.
> One-line goal: make the project a system that is **verifiable, regressable, comparable, and can be handed off to another agent for development and testing.**

## 0. Core principles

- Four goals: **Verifiable** (correctness can be judged automatically), **Regressable** (changes never fear old cases), **Comparable** (old vs. new versions can be compared quantitatively), **Handoff-ready** (another agent can read the artifacts and take over).
- Golden order (see §12): **define the verification first, change the code second.** No blind edits judged by human recall.
- Manual testing is for *discovering* new problems; automated regression is for *preventing* their recurrence (see §16).

---

## Group A — Runnability & Observability

### 1. Decouple the run entry point from the UI
- **Rule:** the agent must have an execution entry point that runs without the front end. "Clicking a web button" must not be the only way to invoke it.
- **Provide at least one of:**
  - CLI: `agent_runner --input cases/case_001.json --output runs/run_001.json`
  - HTTP: `POST /agent/run { "input": ..., "context": {...}, "config": {...} }`
  - Library function: `run_agent(input, context, config) -> RunResult`
  - Queue / task entry
- **Acceptance:** one full run without a browser; the same input can be re-run; scriptable in batch; directly callable by another agent.

### 2. Emit a structured trace for every run (not just natural-language output)
- **Rule:** every run must persist a structured trace (JSON / JSONL), not only the final answer or free-text logs.
- **Record at least:** `run_id`, timestamp, input, system prompt / config version, model name, tool-call sequence (input/output per step), intermediate state snapshots, final result, errors, total `latency_ms`, tokens / cost (if obtainable).
- **Example:**
```json
{
  "run_id": "run_20260629_001",
  "timestamp": "2026-06-29T10:00:00Z",
  "input": "Summarize this article for me",
  "model": "claude-opus-4-8",
  "config_version": "prompt_v12",
  "steps": [
    { "step": 1, "type": "llm", "thought_summary": "Decide to extract the topic first", "output": "..." },
    { "step": 2, "type": "tool", "tool_name": "web_fetch", "tool_input": { "url": "..." }, "tool_output": { "title": "..." } }
  ],
  "final_output": "...",
  "latency_ms": 8321,
  "success": true
}
```
- **Acceptance:** on a bug you can reconstruct "where it went wrong"; another agent can read the trace and analyze it; regression does not depend on screenshots or human memory.

---

## Group B — Defining correctness & assertions

### 3. Define a Happy Path for every core capability first
- **Rule:** don't start with a pile of fuzz cases; write the correct path first.
- **For each capability specify:** input conditions; which tools should fire; call order; which intermediate states should appear; the minimum the final output must satisfy.
- **Example (weather):** input "what's Shanghai's weather tomorrow" → should trigger the weather tool, must not trigger search; output must contain city / date / description / temperature; must not fabricate a data source.
- **Acceptance:** every core function can answer, in one sentence, "if it works correctly, how should it flow?" If you can't, the regression won't be stable.

### 4. Test process assertions (deterministic) first — not just the final answer
- **Rule:** split verification into two layers; the first is deterministic, objectively-checkable assertions. Automate those first; don't make an LLM the sole judge from the start.
- **Directly assertable:** whether a tool was called, how many times, in what order; whether a route was hit; whether key context was read; whether structured fields were produced; whether it finished within a time budget; whether a forbidden pattern appeared (hallucinated field / empty result / call loop).
- **Example:**
```python
assert run.success is True
assert "weather_api" in run.called_tools
assert run.called_tools.count("weather_api") == 1
assert "search_web" not in run.called_tools
assert run.final_output["city"] == "Shanghai"
assert run.latency_ms < 15000
```

### 5. For what can't be hard-asserted, use LLM-as-judge — but only for fuzzy scoring
- **Rule:** for quality / completeness / reasonableness that can't be hard-coded, add a second-layer LLM scorer; let it score / compare / classify / explain deductions. Do **not** let it deliver a one-word pass/fail verdict.
- **Dimensions:** task completeness, factual consistency, missing key points, needless verbosity, structural clarity, intent match.
- **Example output:**
```json
{
  "score": 7.8,
  "dimensions": { "completeness": 8, "factuality": 7, "clarity": 9, "instruction_following": 7 },
  "issues": ["Missed the date confirmation", "Answer slightly verbose"]
}
```
- **Keep the judge clean:** it does not participate in development, does not see how the code changed, sees only input / expectation / trace / output, with a fixed prompt and rubric.
- **Acceptance:** scoring is relatively stable for similar outputs; supports before/after version comparison; helps tell "better or worse."

---

## Group C — Versioning & flags

### 6. Every new capability ships behind a feature flag
- **Rule:** new tool / new prompt path / new planner / new memory behavior all get a switch (e.g. `ENABLE_NEW_PLANNER`, `ENABLE_MEMORY_RERANKER`, `ENABLE_TOOL_X_V2`).
- **Why:** without a switch you can't do A/B, rollback, pinpoint who introduced a regression, or diff old vs. new behavior on the same case.
- **Acceptance:** run at least two groups (on / off); you can answer "what did it improve, and what did it quietly break?"

### 15. Keep an accountable version stamp for every change
- **Rule:** bind version info to every evaluation: git commit, prompt version, tool version, config hash, feature flags, eval-suite version.
- **Acceptance:** any report can be traced back to "which version was actually running," ending "it worked yesterday, why not today?"

---

## Group D — Regression assets

### 7. Build a layered regression set
- **Rule:** split cases into three tiers —
  - **Smoke:** 10–20 most-core cases, runs in minutes, after every commit.
  - **Main regression:** covers main functional paths, daily / before every merge.
  - **Incident regression:** production failures, real weird inputs, historical bug cases — the most valuable asset.
- **Case shape:**
```json
{
  "case_id": "search_013",
  "input": "...",
  "context": {},
  "expected_assertions": {
    "must_call_tools": ["search_web"],
    "must_not_call_tools": ["send_email"]
  },
  "judge_rubric": "..."
}
```
- **Acceptance:** any fixed bug becomes a permanent regression case; changes are checked by "run the suite," not "poke at it once."

### 8. Treat real user-failure samples as the most important data source
- **Rule:** don't rely only on ideal inputs you imagined; systematically collect real bad cases: ambiguous phrasing, over-long input, mixed intents, context conflicts, tool-boundary cases, prompt injection, ultra-short input, typos / colloquial / elliptical phrasing.
- **Action:** on every production failure — (1) record the raw input, (2) record the failing trace, (3) add it to the incident regression set.
- **Acceptance:** the regression set grows to resemble the real world, not lab toy data.

### 14. Establish a failure-classification taxonomy
- **Rule:** tag failing cases instead of calling everything "a bad case."
- **Common tags:** `route_error` (wrong routing), `tool_misfire` (tool didn't fire / fired wrongly), `hallucination`, `memory_error` (wrong context fetched), `format_error` (invalid structure), `timeout`, `loop_error` (call loop), `judge_score_drop`, `regression` (historical capability lost).
- **Value:** you can see where regressions concentrate — prompt vs. tool vs. planner vs. memory.

---

## Group E — Evaluation as engineering

### 9. Make evaluation an independent module
- **Rule:** keep evaluation code separate from business logic. Suggested layout:
```
agent/     run logic
cases/     test inputs
eval/      assertions + LLM judge
reports/   result output
traces/    run traces
```
- `eval/` contains at least: case loader, runner, assertion engine, LLM judge, diff reporter, summary report.
- **Acceptance:** one command runs the whole suite, e.g. `python eval/run_eval.py --suite smoke --config prompt_v12`.

### 10. Produce a comparison report — not just pass/fail
- **Rule:** each eval round auto-generates a comparison report with at least: overall pass rate, per-dimension pass rate, average-score change, latency change, tool-call change, newly failing cases, newly fixed cases, top regressions.
- **Focus:** not "all green," but which cases regressed, why, whether it's a capability regression or a cost increase, a result regression or a path regression.
- **Acceptance:** you can tell within 3 minutes whether the change is worth keeping.

### 13. Also evaluate "system cost" (non-functional metrics)
- **Rule:** judge not only correctness but cost and stability: average latency, token consumption, failure rate, retry rate, tool-call count, long-chain ratio, timeout ratio, empty-output ratio.
- **Why:** "slightly better answer at 3× the cost" is often a net negative.
- **Acceptance:** every version comparison shows quality change / cost change / stability change together.

---

## Group F — Agent-facing interface

### 11. Design an interface another agent can consume (the most overlooked point)
- **Rule:** the agent should serve not only users but another agent. Let a coding / debug agent easily obtain: a run's input, config version, trace, assertion results, score report, historical comparisons.
- **Purpose:** another agent can autonomously reproduce a bug, analyze the failure, edit code/prompt, re-run regression, and diff before/after.
- **Acceptance:** you can make this real — "before fixing this, read the failing case + trace + last report, then submit a fix and re-run regression."

---

## Group G — Development flow

### 12. Shift from "change then test" to "define verification then change"
- **Rule:** order for adding a feature — (1) define the Happy Path, (2) write assertions, (3) add eval cases, (4) add a feature flag, (5) only then change agent logic.
- **Acceptance:** every feature PR carries at least: added/changed cases, matching assertions, eval results, flag notes.

### 16. Demote manual exploratory testing to a supplement
- **Rule:** keep manual play/observation, but only to discover new problems, spark ideas, and add edge cases — not as the primary regression method or the sole correctness judge.

---

## Minimum landing checklist (new project / refactor start)

- [ ] A non-UI run entry point (§1)
- [ ] Structured trace per run (§2)
- [ ] Happy Path written for core capabilities (§3)
- [ ] A deterministic process-assertion layer (§4)
- [ ] A clean LLM judge where needed (§5)
- [ ] Feature flags on new capabilities (§6)
- [ ] Smoke / main / incident regression tiers (§7, §8)
- [ ] Evaluation as a module, runnable in one command (§9)
- [ ] Comparison report each round, incl. cost metrics (§10, §13)
- [ ] Reports stamped with version info (§15)
- [ ] Failing cases tagged (§14)
- [ ] Agent-facing interface exposed (§11)
- [ ] "Verify first, change second" order (§12); manual testing as supplement only (§16)

---

## Appendix A — Borrowed disciplines (added 2026-08-18)

Three rules adopted from the DeepSeek Harness study ([`plans/2026-08-18-deepseek-harness-study.md`](plans/2026-08-18-deepseek-harness-study.md) §4). They refine §2 (structured trace) and §4 (process assertions) rather than extending the fixed 1–16 index.

### A1. `model-visible ⟺ logged`
- **Rule:** everything that reaches a model request MUST be reconstructable from the session log, and a runtime invariant MUST assert it. Adding a model-visible input therefore means adding a log event — never a side channel read at request time.
- **Why here:** our slice-5 defect class (re-projection dropping `reasoning` / `exec`) is exactly this rule not holding.
- **Acceptance:** for each new model-visible input, one log event + one replay test proving the request is byte-reproducible from the log alone.

### A2. Projection units are pure, versioned folds
- **Rule:** a projection unit is `init()` / `apply(state, event)` / `view(state)` — three pure **synchronous** functions — plus an integer `stateVersion`. `apply` MUST return the **same reference** for events it does not care about (`Object.is` ⇒ zero downstream work). Bump `stateVersion` whenever serialized fields or fold semantics change, so persisted cache rows from an older unit are **discarded**, not forward-applied into garbage.
- **Acceptance:** every projection has a version field and a test arm proving a stale-version cache row is dropped rather than folded forward.

### A3. Empty shells must state their reason, and a gate must enforce it
- **Rule:** when a module has no invariant / no check / no implementation to contribute, it MUST still declare that explicitly, starting with `No runtime invariant:` (or the equivalent marker) and explaining **why this specific module has none**. A mechanical gate MUST reject unexplained empty shells, missing registrations, and non-empty checks that ignore their reporter.
- **Why here:** this is the machine-enforced form of our "same-name empty shell / absent producer / hardcoded belief" spec-review lens, which is currently manual and therefore skippable.
- **Acceptance:** a `verify-*` script in the gate chain that fails on an unexplained empty shell.
