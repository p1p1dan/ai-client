/**
 * Claude Code's `--output-format stream-json` transcript, folded into the
 * normalized trace. One API message can arrive as several `assistant` lines
 * (one per content block) under the same message id; their usage is the
 * message_start snapshot, so totals come from the `result` line's
 * `modelUsage` (every model the run used) and only fall back to a per-message
 * sum when the run was cut before `result`.
 */

import { clipInput, isShellTool, toolCategory } from './toolMetrics.ts';
import type { LlmEvent, TokenUsage, ToolEvent, TraceEvent } from './types.ts';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (isRecord(block) ? String(block.text ?? '') : '')).join('\n');
  }
  return '';
}

export interface ClaudeStream {
  init?: Json;
  result?: Json;
  events: TraceEvent[];
  offeredTools: string[];
  answer: string;
  tokens: TokenUsage;
  tokensSource: 'modelUsage' | 'result.usage' | 'messages';
  /** Lines that were not JSON (should be none). */
  badLines: number;
}

export function parseClaudeStream(text: string, startedAt?: number): ClaudeStream {
  let init: Json | undefined;
  let result: Json | undefined;
  let badLines = 0;
  const llmById = new Map<string, LlmEvent>();
  const usageById = new Map<string, TokenUsage>();
  const tools = new Map<string, ToolEvent>();
  const events: TraceEvent[] = [];
  let mainSteps = 0;
  let subSteps = 0;
  const at = (line: Json) => {
    if (startedAt === undefined || typeof line.timestamp !== 'string') return undefined;
    const ms = Date.parse(line.timestamp);
    return Number.isFinite(ms) ? Math.max(0, ms - startedAt) : undefined;
  };
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: Json;
    try {
      line = JSON.parse(raw) as Json;
    } catch {
      badLines += 1;
      continue;
    }
    if (line.type === 'system' && line.subtype === 'init') {
      init = line;
      continue;
    }
    if (line.type === 'result') {
      result = line;
      continue;
    }
    const message = isRecord(line.message) ? line.message : undefined;
    const subagent = typeof line.parent_tool_use_id === 'string';
    if (line.type === 'assistant' && message) {
      const id = String(message.id ?? `anon-${events.length}`);
      let llm = llmById.get(id);
      if (!llm) {
        llm = {
          kind: 'llm',
          t: at(line),
          step: subagent ? ++subSteps : ++mainSteps,
          subagent,
          text: '',
          toolCalls: [],
        };
        llmById.set(id, llm);
        events.push(llm);
      }
      const usage = isRecord(message.usage) ? message.usage : undefined;
      if (usage) {
        const seen = usageById.get(id);
        usageById.set(id, {
          input: Math.max(seen?.input ?? 0, num(usage.input_tokens)),
          cacheRead: Math.max(seen?.cacheRead ?? 0, num(usage.cache_read_input_tokens)),
          cacheWrite: Math.max(seen?.cacheWrite ?? 0, num(usage.cache_creation_input_tokens)),
          output: Math.max(seen?.output ?? 0, num(usage.output_tokens)),
        });
        llm.usage = usageById.get(id);
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block)) continue;
        if (block.type === 'text') llm.text += String(block.text ?? '');
        if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          llm.toolCalls.push(name);
          const event: ToolEvent = {
            kind: 'tool',
            t: at(line),
            step: llm.step,
            subagent,
            id: String(block.id ?? `tool-${tools.size}`),
            name,
            category: toolCategory(name),
            input: clipInput(block.input),
            pending: true,
            error: false,
            unknown: false,
            exitCode: null,
            output: '',
          };
          tools.set(event.id, event);
          events.push(event);
        }
      }
      continue;
    }
    if (line.type === 'user' && message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        const event = tools.get(String(block.tool_use_id));
        if (!event) continue;
        const output = resultText(block.content);
        event.pending = false;
        event.output = output.slice(0, 2000);
        event.error = block.is_error === true;
        if (/No such tool available/i.test(output)) event.unknown = true;
        if (isShellTool(event.name)) {
          // Claude Code reports a non-zero exit as an error whose text starts
          // "Exit code N"; a command that ran is not a tool error.
          const exit = event.error ? /^Exit code (\d+)/.exec(output) : null;
          if (exit) {
            event.exitCode = Number(exit[1]);
            event.error = false;
          } else if (!event.error) {
            event.exitCode = 0;
          }
        }
      }
    }
  }
  const offeredTools = Array.isArray(init?.tools) ? (init.tools as unknown[]).map(String) : [];
  for (const event of tools.values()) {
    if (offeredTools.length > 0 && !offeredTools.includes(event.name)) event.unknown = true;
    if (event.unknown) event.error = true;
  }
  const lastMain = [...llmById.values()].filter((llm) => !llm.subagent && llm.text).at(-1);
  const answer =
    typeof result?.result === 'string' && result.result !== ''
      ? result.result
      : (lastMain?.text ?? '');
  return { init, result, events, offeredTools, answer, ...tokensOf(result, usageById), badLines };
}

function tokensOf(
  result: Json | undefined,
  usageById: Map<string, TokenUsage>
): { tokens: TokenUsage; tokensSource: ClaudeStream['tokensSource'] } {
  const modelUsage = isRecord(result?.modelUsage) ? result.modelUsage : undefined;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const usage of Object.values(modelUsage)) {
      if (!isRecord(usage)) continue;
      tokens.input += num(usage.inputTokens);
      tokens.cacheRead += num(usage.cacheReadInputTokens);
      tokens.cacheWrite += num(usage.cacheCreationInputTokens);
      tokens.output += num(usage.outputTokens);
    }
    return { tokens, tokensSource: 'modelUsage' };
  }
  const usage = isRecord(result?.usage) ? result.usage : undefined;
  if (usage) {
    return {
      tokens: {
        input: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens),
      },
      tokensSource: 'result.usage',
    };
  }
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const usage of usageById.values()) {
    tokens.input += usage.input;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    tokens.output += usage.output;
  }
  return { tokens, tokensSource: 'messages' };
}
