/**
 * The deterministic assertion layer - `docs/agent-project-engineering.md` §4.
 *
 * §4's rule is that the FIRST layer of verification must be objectively
 * checkable, and that an LLM judge (§5) is only added on top for the fuzzy part.
 * Everything asserted here is a fact about the run, not about the answer's
 * quality: did it succeed, how many turns did it take, was any tool called, was
 * it inside its time budget.
 *
 * Kept separate from the runner so P1..P3 can reuse it: a case file's
 * `expected_assertions` block is the same shape whatever phase produced the run.
 */

import type { RuntimeRunResult } from '../contracts.ts';

export interface ExpectedAssertions {
  must_succeed?: boolean;
  must_call_tools?: string[];
  /** `["*"]` means "no tool at all", which is P0's whole contract. */
  must_not_call_tools?: string[];
  turns?: number;
  min_output_chars?: number;
  exact_output?: string;
  max_latency_ms?: number;
}

export interface SmokeCase {
  case_id: string;
  lane: 'live' | 'offline';
  input: string;
  system_prompt: string;
  /** Offline lane only: what the faux provider is scripted to answer. */
  scripted_output?: string;
  expected_assertions: ExpectedAssertions;
  notes?: string;
}

export interface AssertionOutcome {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  /**
   * Failure tag from §14's taxonomy, so failures can be counted by kind rather
   * than all landing in one "bad case" bucket.
   */
  tag?: 'regression' | 'tool_misfire' | 'timeout' | 'format_error' | 'loop_error';
}

export interface AssertionReport {
  case_id: string;
  passed: boolean;
  outcomes: AssertionOutcome[];
}

export function evaluateCase(
  smokeCase: SmokeCase,
  result: RuntimeRunResult,
  toolsCalled: readonly string[]
): AssertionReport {
  const expected = smokeCase.expected_assertions;
  const outcomes: AssertionOutcome[] = [];

  if (expected.must_succeed !== undefined) {
    outcomes.push({
      name: 'must_succeed',
      passed: result.success === expected.must_succeed,
      expected: expected.must_succeed,
      // The error is carried into `actual` because a bare `false` tells whoever
      // reads the report nothing about why the run failed.
      actual: { success: result.success, error: result.error ?? null },
      tag: 'regression',
    });
  }

  for (const tool of expected.must_call_tools ?? []) {
    outcomes.push({
      name: `must_call_tools:${tool}`,
      passed: toolsCalled.includes(tool),
      expected: tool,
      actual: toolsCalled,
      tag: 'tool_misfire',
    });
  }

  for (const tool of expected.must_not_call_tools ?? []) {
    const called = tool === '*' ? toolsCalled.length > 0 : toolsCalled.includes(tool);
    outcomes.push({
      name: `must_not_call_tools:${tool}`,
      passed: !called,
      expected: tool === '*' ? 'no tool calls' : `no call to ${tool}`,
      actual: toolsCalled,
      tag: 'tool_misfire',
    });
  }

  if (expected.turns !== undefined) {
    outcomes.push({
      name: 'turns',
      passed: result.turns === expected.turns,
      expected: expected.turns,
      actual: result.turns,
      tag: 'loop_error',
    });
  }

  if (expected.min_output_chars !== undefined) {
    outcomes.push({
      name: 'min_output_chars',
      passed: result.text.trim().length >= expected.min_output_chars,
      expected: `>= ${expected.min_output_chars}`,
      actual: result.text.trim().length,
      tag: 'format_error',
    });
  }

  if (expected.exact_output !== undefined) {
    outcomes.push({
      name: 'exact_output',
      passed: result.text.trim() === expected.exact_output,
      expected: expected.exact_output,
      actual: result.text.trim(),
      tag: 'format_error',
    });
  }

  if (expected.max_latency_ms !== undefined) {
    outcomes.push({
      name: 'max_latency_ms',
      passed: result.latencyMs <= expected.max_latency_ms,
      expected: `<= ${expected.max_latency_ms}`,
      actual: result.latencyMs,
      tag: 'timeout',
    });
  }

  return {
    case_id: smokeCase.case_id,
    passed: outcomes.every((outcome) => outcome.passed),
    outcomes,
  };
}
