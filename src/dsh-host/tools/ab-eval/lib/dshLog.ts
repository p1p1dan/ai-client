/**
 * DSH session logs (`$DSH_HOME/sessions/<cwd>/<session>/session.v4.jsonl.zstd`),
 * decoded and folded into the normalized trace. The log is DSH's source of
 * truth (model-visible ⟺ logged): calls, results, usage per step and the
 * exact system prompt and tool list each request carried.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { clipInput, isShellTool, toolCategory } from './toolMetrics.ts';
import type { LlmEvent, TokenUsage, ToolEvent, TraceEvent } from './types.ts';

type Json = Record<string, any>;

export interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Json;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * One zstd frame per append and the one-shot decoder stops after the first,
 * so split on the frame magic and widen a slice whenever a split was spurious
 * (the magic bytes inside compressed data).
 */
export function decodeZstdFrames(raw: Buffer): string {
  const starts: number[] = [];
  for (let at = raw.indexOf(ZSTD_MAGIC); at >= 0; at = raw.indexOf(ZSTD_MAGIC, at + 1)) {
    starts.push(at);
  }
  if (starts.length === 0) return raw.toString('utf8');
  let text = '';
  let from = 0;
  for (let next = 1; next <= starts.length; next += 1) {
    const end = next < starts.length ? starts[next] : raw.length;
    try {
      text += zstdDecompressSync(raw.subarray(starts[from], end)).toString('utf8');
      from = next;
    } catch {
      // A spurious split: keep widening.
    }
  }
  return text;
}

export function decodeSessionLog(file: string): DshEvent[] {
  const raw = readFileSync(file);
  const text = file.endsWith('.zstd') ? decodeZstdFrames(raw) : raw.toString('utf8');
  const events: DshEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DshEvent);
    } catch {
      // A torn last line from a crash; the rest stands.
    }
  }
  return events;
}

/** Every session log under `$DSH_HOME/sessions`. */
export function findSessionLogs(dshHome: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name)) out.push(path);
    }
  };
  walk(join(dshHome, 'sessions'));
  return out.sort();
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: Json) => block?.type === 'text')
    .map((block: Json) => String(block.text ?? ''))
    .join('');
}

export interface DshSessionSummary {
  events: TraceEvent[];
  offeredTools: string[];
  systemPrompt: string;
  answer: string;
  /** The last request's call configuration (provider, model, effort, max tokens). */
  config?: Json;
  turnEnd?: Json;
  retries: number;
  failedAttempts: number;
  tokens: TokenUsage;
}

export function summarizeDshSession(
  log: readonly DshEvent[],
  options: { subagent: boolean; startedAt?: number }
): DshSessionSummary {
  const events: TraceEvent[] = [];
  const tools = new Map<string, ToolEvent>();
  const tokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let offered: string[] = [];
  let systemPrompt = '';
  let answer = '';
  let config: Json | undefined;
  let turnEnd: Json | undefined;
  let retries = 0;
  let failedAttempts = 0;
  let step = 0;
  const at = (event: DshEvent) =>
    options.startedAt !== undefined && typeof event.time === 'number'
      ? Math.max(0, event.time - options.startedAt)
      : undefined;
  for (const event of log) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'request/header': {
        const header = data.header ?? {};
        if (Array.isArray(header.tools))
          offered = header.tools.map((tool: Json) => String(tool?.name));
        if (header.config) config = header.config;
        break;
      }
      case 'system/message': {
        const text = textOf(data.message?.content);
        if (text) systemPrompt = text;
        break;
      }
      case 'assistant/message': {
        step += 1;
        const usage = data.usage;
        const llm: LlmEvent = {
          kind: 'llm',
          t: at(event),
          step,
          subagent: options.subagent,
          text: textOf(data.message?.content),
          toolCalls: (Array.isArray(data.message?.content) ? data.message.content : [])
            .filter((block: Json) => block?.type === 'tool-call')
            .map((block: Json) => String(block.name ?? block.toolName ?? '')),
        };
        if (usage) {
          llm.usage = {
            input: usage.inputTokens ?? 0,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
            output: usage.outputTokens ?? 0,
          };
          tokens.input += llm.usage.input;
          tokens.cacheRead += llm.usage.cacheRead;
          tokens.cacheWrite += llm.usage.cacheWrite;
          tokens.output += llm.usage.output;
        }
        if (llm.text) answer = llm.text;
        events.push(llm);
        break;
      }
      case 'tool/call': {
        const name = String(data.name ?? '');
        let input: unknown = data.arguments;
        try {
          input = JSON.parse(String(data.arguments));
        } catch {
          // Unparseable arguments stay a string, as the model wrote them.
        }
        const tool: ToolEvent = {
          kind: 'tool',
          t: at(event),
          step,
          subagent: options.subagent,
          id: String(data.callId ?? `call-${tools.size}`),
          name,
          category: toolCategory(name),
          input: clipInput(input),
          pending: true,
          error: false,
          unknown: offered.length > 0 && !offered.includes(name),
          exitCode: null,
          output: '',
        };
        tools.set(tool.id, tool);
        events.push(tool);
        break;
      }
      case 'tool/result': {
        const tool = tools.get(String(data.message?.toolCallId));
        if (!tool) break;
        const output = textOf(data.message?.content);
        tool.pending = false;
        tool.output = output.slice(0, 2000);
        tool.error = data.message?.isError === true;
        if (data.error?.code === 'UNKNOWN_TOOL') tool.unknown = true;
        if (isShellTool(tool.name)) {
          const exits = [...output.matchAll(/\[exit code: (-?\d+)\]/g)];
          tool.exitCode = exits.length > 0 ? Number(exits.at(-1)?.[1]) : tool.error ? null : 0;
        }
        if (tool.unknown) tool.error = true;
        break;
      }
      case 'llm/retry':
        retries += 1;
        break;
      case 'assistant/attempt':
        failedAttempts += 1;
        break;
      case 'turn/end':
        turnEnd = data.reason;
        break;
    }
  }
  return {
    events,
    offeredTools: offered,
    systemPrompt,
    answer,
    ...(config ? { config } : {}),
    ...(turnEnd ? { turnEnd } : {}),
    retries,
    failedAttempts,
    tokens,
  };
}
