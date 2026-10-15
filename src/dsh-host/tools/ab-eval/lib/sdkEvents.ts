/**
 * The PiLab+SDK arm's trace. The main agent comes from the runtime events
 * the Claude SDK host sent over IPC (what PiLab's window would show): one
 * assistant `message.started` per model call, `tool.started` / `tool.updated`
 * / `tool.completed` per tool call. The host leaves subagents out of its
 * events, so their calls come from the SDK message log, which is the
 * `stream-json` shape (`parseClaudeStream`); so do the token totals (the
 * SDK's `result.modelUsage`, every model the CLI used, as for Claude Code),
 * the offered tools and the session facts of the `init` message.
 */

import { type ClaudeStream, parseClaudeStream } from './claudeStream.ts';
import { clipInput, isShellTool, toolCategory } from './toolMetrics.ts';
import type { LlmEvent, TokenUsage, ToolEvent, TraceEvent } from './types.ts';

type Json = Record<string, unknown>;

/** One runtime event as it arrived, with its arrival time (ms since the send). */
export interface HostEvent {
  type: string;
  requestId?: string;
  payload?: Json;
  t?: number;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool result's text: a string, or `{content: [{text}]}`. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const content = isRecord(output) ? output.content : undefined;
  if (Array.isArray(content)) {
    return content.map((block) => (isRecord(block) ? String(block.text ?? '') : '')).join('\n');
  }
  return output === undefined ? '' : JSON.stringify(output);
}

export interface SdkHostTrace {
  events: TraceEvent[];
  answer: string;
  offeredTools: string[];
  tokens: TokenUsage;
  tokensSource: string;
  stream: ClaudeStream;
  /** Main-agent counts as the host's events and as the SDK messages give them (should agree). */
  crossCheck: { hostSteps: number; sdkSteps: number; hostTools: number; sdkTools: number };
}

/** Folds the host's events (from `from` on) and the SDK message log into the trace. */
export function summarizeSdkHost(
  hostEvents: readonly HostEvent[],
  messageLog: string,
  startedAt?: number
): SdkHostTrace {
  const stream = parseClaudeStream(messageLog, startedAt);
  const offeredTools = stream.offeredTools;
  const events: TraceEvent[] = [];
  const steps = new Map<string, LlmEvent>();
  const tools = new Map<string, ToolEvent>();
  let step = 0;
  for (const event of hostEvents) {
    const p = event.payload ?? {};
    const messageId = String(p.messageId ?? '');
    switch (event.type) {
      case 'message.started': {
        if (p.role !== 'assistant') break;
        const llm: LlmEvent = {
          kind: 'llm',
          t: event.t,
          step: ++step,
          subagent: false,
          text: '',
          toolCalls: [],
        };
        steps.set(messageId, llm);
        events.push(llm);
        break;
      }
      case 'message.delta': {
        const llm = steps.get(messageId);
        if (llm && typeof p.text === 'string') llm.text += p.text;
        break;
      }
      case 'tool.started': {
        const id = String(p.toolCallId ?? `tool-${tools.size}`);
        if (tools.has(id)) break;
        const name = String(p.name ?? '');
        const llm = steps.get(messageId);
        llm?.toolCalls.push(name);
        const streaming = isRecord(p.input) && '__streaming' in p.input;
        const tool: ToolEvent = {
          kind: 'tool',
          t: event.t,
          step: llm?.step ?? step,
          subagent: false,
          id,
          name,
          category: toolCategory(name),
          input: streaming ? {} : clipInput(p.input ?? {}),
          pending: true,
          error: false,
          unknown: false,
          exitCode: null,
          output: '',
        };
        tools.set(id, tool);
        events.push(tool);
        break;
      }
      case 'tool.updated': {
        const tool = tools.get(String(p.toolCallId));
        if (tool && p.input !== undefined) tool.input = clipInput(p.input);
        break;
      }
      case 'tool.completed': {
        const tool = tools.get(String(p.toolCallId));
        if (!tool) break;
        const details = isRecord(p.output) && isRecord(p.output.details) ? p.output.details : {};
        const text = outputText(p.output) || String(p.error ?? '');
        tool.output = text.slice(0, 2000);
        // Stopped or never started: cut off before a result, as Claude Code's are when killed.
        if (details.stopped === true || details.notStarted === true) break;
        tool.pending = false;
        tool.error = p.ok !== true;
        if (/No such tool available/i.test(text)) tool.unknown = true;
        if (isShellTool(tool.name)) {
          // As in claudeStream: a command that ran and exited non-zero is not a tool error.
          const exit = tool.error ? /^Exit code (\d+)/.exec(text) : null;
          if (exit) {
            tool.exitCode = Number(exit[1]);
            tool.error = false;
          } else if (!tool.error) {
            tool.exitCode = 0;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  for (const tool of tools.values()) {
    if (offeredTools.length > 0 && !offeredTools.includes(tool.name)) tool.unknown = true;
    if (tool.unknown) tool.error = true;
  }
  events.push(...stream.events.filter((event) => event.subagent));
  const lastText = [...steps.values()].filter((llm) => llm.text.trim() !== '').at(-1)?.text;
  const answer = lastText ?? stream.answer;
  const sdkMain = stream.events.filter((event) => !event.subagent);
  return {
    events,
    answer,
    offeredTools,
    tokens: stream.tokens,
    tokensSource: `sdk-${stream.tokensSource}`,
    stream,
    crossCheck: {
      hostSteps: steps.size,
      sdkSteps: sdkMain.filter((event) => event.kind === 'llm').length,
      hostTools: tools.size,
      sdkTools: sdkMain.filter((event) => event.kind === 'tool').length,
    },
  };
}
