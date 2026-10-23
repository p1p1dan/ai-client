/**
 * Decision 192: the review model's judgement of one call the auto gear would
 * ask about, as Claude Code's auto mode makes it — a fast first answer that
 * leans to blocking, and a reasoned second one only when the first blocks.
 *
 * Tool-free one-shot requests through the host's LLM service (the same
 * adapter, routes and per-request keys as a chat turn; nothing written to a
 * session), to the plan's `reviewModel`. Each request's usage goes to
 * `onUsage` (decision 193 §10: the session total counts it).
 */

import {
  buildReviewSystemPrompt,
  buildReviewTranscript,
  REVIEW_STAGE1_INSTRUCTION,
  REVIEW_STAGE1_MAX_TOKENS,
  REVIEW_STAGE1_THINKING_EXTRA_TOKENS,
  REVIEW_STAGE2_INSTRUCTION,
  REVIEW_STAGE2_MAX_TOKENS,
  type ReviewAction,
  type ReviewTranscriptEntry,
} from '../../shared/permissions/autoReview/prompt.ts';
import type { AutoModeRules } from '../../shared/permissions/autoReview/rules.ts';
import {
  type AutoReviewFailure,
  type AutoReviewVerdict,
  isReviewRefusal,
} from '../../shared/permissions/autoReview/types.ts';
import {
  estimateTokens,
  parseReviewAnswer,
  reviewTimeoutMs,
} from '../../shared/permissions/autoReview/verdict.ts';
import type { PermissionAskContext, ToolPermissionRequest } from '../../shared/permissions/gate.ts';
import type { CompletionChunk } from './completions.ts';
import type { DshRoutedModel } from './modelRoute.ts';

/** The slice of DSH's `ctx.llm` a review uses. */
export interface ReviewLlm {
  stream(options: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    system: string;
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>;
    maxTokens?: number;
    signal: AbortSignal;
  }): AsyncIterable<CompletionChunk>;
}

export interface AutoReviewerOptions {
  llm(): ReviewLlm | undefined;
  /** The review model as a completion; throws when the plan cannot serve it. */
  route(): DshRoutedModel;
  /** The review model's context window, when the plan states one. */
  contextWindow(): number | undefined;
  rules(): Promise<AutoModeRules | undefined>;
  /** The session's conversation as the reviewer reads it. */
  transcript(): ReviewTranscriptEntry[];
  cwd: string;
  /**
   * The review model thinks (a reasoning model: an effort level, or adaptive
   * thinking it cannot turn off). Stage 1 then gets
   * `REVIEW_STAGE1_THINKING_EXTRA_TOKENS` more, so the thought does not use up
   * the room the verdict needs.
   */
  thinks?: boolean;
  log?: (...args: unknown[]) => void;
  /**
   * Decision 193 §10: the provider-reported usage of one review request (the
   * stream's last `usage` chunk, a `TokenUsage`), once the request settles,
   * failed or not; never called for a request that reported none.
   */
  onUsage?: (usage: unknown) => void;
}

const TIMEOUT = 'auto_review_timed_out';

type Answer = { kind: 'text'; text: string } | Extract<AutoReviewVerdict, { kind: 'failed' }>;

function failed(
  failure: AutoReviewFailure,
  detail?: string
): Extract<AutoReviewVerdict, { kind: 'failed' }> {
  return { kind: 'failed', failure, ...(detail ? { detail } : {}) };
}

export function reviewActionOf(
  request: ToolPermissionRequest,
  context: PermissionAskContext,
  cwd: string
): ReviewAction {
  const hostAsk = request.hostAsk !== undefined;
  return {
    tool: request.tool,
    cwd,
    ...(request.command ? { command: request.command } : {}),
    ...(!hostAsk && request.path ? { path: request.path } : {}),
    ...(request.paths?.length ? { paths: request.paths } : {}),
    ...(!hostAsk && request.preview ? { preview: request.preview } : {}),
    ...(hostAsk && request.preview ? { hostAskReason: request.preview.text } : {}),
    ...(context.askReason ? { askReason: context.askReason } : {}),
    ...(request.delegation ? { delegation: { agentName: request.delegation.agentName } } : {}),
  };
}

export class AutoReviewer {
  private readonly options: AutoReviewerOptions;

  constructor(options: AutoReviewerOptions) {
    this.options = options;
  }

  async review(
    request: ToolPermissionRequest,
    context: PermissionAskContext,
    signal: AbortSignal
  ): Promise<AutoReviewVerdict> {
    const rules = await this.options.rules();
    if (!rules) return failed('unavailable', 'no auto-mode rules');
    const llm = this.options.llm();
    if (!llm) return failed('unavailable', 'this host has no LLM service');
    let routed: DshRoutedModel;
    try {
      routed = this.options.route();
    } catch (error) {
      return failed('unavailable', error instanceof Error ? error.message : String(error));
    }
    const system = buildReviewSystemPrompt(rules);
    const transcript = buildReviewTranscript(
      this.options.transcript(),
      reviewActionOf(request, context, this.options.cwd)
    );
    const tokens = estimateTokens(system) + estimateTokens(transcript);
    const window = this.options.contextWindow();
    if (window !== undefined && tokens + REVIEW_STAGE2_MAX_TOKENS > window) {
      return failed('too_long', `${tokens} prompt tokens for a ${window}-token window`);
    }
    const timeoutMs = reviewTimeoutMs(tokens);

    const first = await this.ask(
      llm,
      routed,
      system,
      `${transcript}\n\n${REVIEW_STAGE1_INSTRUCTION}`,
      {
        // No stop sequence: DSH's pi-ai adapter refuses `stop`; the cap keeps it fast.
        maxTokens:
          REVIEW_STAGE1_MAX_TOKENS +
          (this.options.thinks ? REVIEW_STAGE1_THINKING_EXTRA_TOKENS : 0),
        timeoutMs,
        signal,
      }
    );
    if (first.kind === 'failed') return first;
    if (parseReviewAnswer(first.text)?.block === false) return { kind: 'allow' };

    const second = await this.ask(
      llm,
      routed,
      system,
      `${transcript}\n\n${REVIEW_STAGE2_INSTRUCTION}`,
      {
        maxTokens: REVIEW_STAGE2_MAX_TOKENS,
        timeoutMs,
        signal,
      }
    );
    if (second.kind === 'failed') return second;
    const answer = parseReviewAnswer(second.text);
    if (!answer) return failed('unparseable', second.text.slice(0, 200));
    return answer.block ? { kind: 'block', reason: answer.reason ?? '' } : { kind: 'allow' };
  }

  private async ask(
    llm: ReviewLlm,
    routed: DshRoutedModel,
    system: string,
    prompt: string,
    limits: { maxTokens: number; timeoutMs: number; signal: AbortSignal }
  ): Promise<Answer> {
    if (limits.signal.aborted) return failed('error', 'aborted');
    const controller = new AbortController();
    const onAbort = () => controller.abort(limits.signal.reason);
    limits.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(TIMEOUT), limits.timeoutMs);
    timer.unref?.();
    const timedOut = () => controller.signal.reason === TIMEOUT;
    let usage: unknown;
    try {
      let text = '';
      const stream = llm.stream({
        provider: routed.selection.provider,
        model: routed.selection.model,
        ...(routed.selection.reasoningEffort
          ? { reasoningEffort: routed.selection.reasoningEffort }
          : {}),
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: limits.maxTokens,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          continue;
        }
        if (chunk.type === 'usage') {
          usage = chunk.usage ?? usage;
          continue;
        }
        if (chunk.type !== 'finish') continue;
        const kind = chunk.reason?.kind;
        if (kind === 'aborted') return timedOut() ? failed('timeout') : failed('error', 'aborted');
        if (kind === 'error') {
          const message = chunk.reason?.failure?.message;
          if (typeof message !== 'string') return failed('error', 'the model call failed');
          return failed(isReviewRefusal(message) ? 'refused' : 'error', message);
        }
        return { kind: 'text', text };
      }
      return timedOut() ? failed('timeout') : { kind: 'text', text };
    } catch (error) {
      if (timedOut()) return failed('timeout');
      return failed('error', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      limits.signal.removeEventListener('abort', onAbort);
      if (usage !== undefined) this.reportUsage(usage);
    }
  }

  /** `onUsage`, which may not cost the review its verdict. */
  private reportUsage(usage: unknown): void {
    try {
      this.options.onUsage?.(usage);
    } catch {
      // Bookkeeping only.
    }
  }
}
