/**
 * Question bridge — park AskUserQuestion canUseTool calls until the user
 * answers via the question.respond command. Mirrors PermissionBridge:
 * one questionId settles exactly once; session stop/close rejects pending.
 *
 * CLI contract (C-03 spike): answers ride back on allow.updatedInput.answers
 * (question text -> answer string, multiSelect comma-joined). A bare allow
 * without answers is silently discarded and re-asked by cli.js — respond()
 * therefore refuses inputs that carry neither answers, response nor cancel.
 * Cancel maps to allow + empty answers (no denial record in the transcript).
 */

import type { EmitFn, LogFn } from './eventNormalizer.ts';
import type { PermissionResult } from './permissionBridge.ts';

interface QuestionOptionPayload {
  label: string;
  description?: string;
  preview?: string;
}

interface QuestionItemPayload {
  question: string;
  header?: string;
  options: QuestionOptionPayload[];
  multiSelect?: boolean;
}

export interface QuestionRespondInput {
  sessionId: string;
  questionId: string;
  answers?: Record<string, string>;
  response?: string;
  cancel?: boolean;
}

interface PendingQuestion {
  sessionId: string;
  questionId: string;
  input: Record<string, unknown>;
  settle: (result: PermissionResult, resolved?: ResolvedPayload) => void;
  abortHandler: () => void;
  signal: AbortSignal;
}

interface ResolvedPayload {
  outcome: 'answered' | 'cancelled' | 'rejected';
  answers?: Record<string, string>;
  response?: string;
}

let questionSeq = 0;

function nextQuestionId(toolUseId?: string): string {
  if (toolUseId && toolUseId.length > 0) return toolUseId;
  questionSeq += 1;
  return `question-${Date.now()}-${questionSeq}`;
}

/** Tolerant extraction of the questions[] payload from raw tool input. */
function toQuestionItems(input: Record<string, unknown>): QuestionItemPayload[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const items: QuestionItemPayload[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== 'string' || q.question.length === 0) continue;
    const options: QuestionOptionPayload[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!opt || typeof opt !== 'object') continue;
        const o = opt as Record<string, unknown>;
        if (typeof o.label !== 'string' || o.label.length === 0) continue;
        options.push({
          label: o.label,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
          ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
        });
      }
    }
    items.push({
      question: q.question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return items;
}

export class QuestionBridge {
  private pending = new Map<string, PendingQuestion>();
  private readonly emit: EmitFn;
  private readonly log: LogFn;

  constructor(emit: EmitFn, log: LogFn = () => undefined) {
    this.emit = emit;
    this.log = log;
  }

  /**
   * Park an AskUserQuestion canUseTool call — emits question.requested and
   * waits for question.respond (or abort).
   */
  request(input: {
    sessionId: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
    toolUseId?: string;
  }): Promise<PermissionResult> {
    const questionId = nextQuestionId(input.toolUseId);

    if (input.signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Session aborted before question prompt',
        interrupt: true,
        toolUseID: questionId,
      });
    }

    if (this.pending.has(questionId)) {
      this.log('duplicate questionId, denying:', questionId);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Duplicate question request',
        toolUseID: questionId,
      });
    }

    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (result: PermissionResult, resolved?: ResolvedPayload) => {
        if (settled) return;
        settled = true;
        const entry = this.pending.get(questionId);
        if (entry) {
          entry.signal.removeEventListener('abort', entry.abortHandler);
          this.pending.delete(questionId);
        }
        this.emit({
          type: 'question.resolved',
          sessionId: input.sessionId,
          payload: {
            questionId,
            outcome: resolved?.outcome ?? 'rejected',
            ...(resolved?.answers ? { answers: resolved.answers } : {}),
            ...(resolved?.response ? { response: resolved.response } : {}),
          },
        });
        // Resume running unless abort already took over.
        if (!input.signal.aborted) {
          this.emit({
            type: 'session.status',
            sessionId: input.sessionId,
            payload: { status: 'running' },
          });
        }
        resolve(result);
      };

      const abortHandler = () => {
        settle({
          behavior: 'deny',
          message: 'Session stopped while waiting for an answer',
          interrupt: true,
          toolUseID: questionId,
        });
      };

      this.pending.set(questionId, {
        sessionId: input.sessionId,
        questionId,
        input: input.input,
        settle,
        abortHandler,
        signal: input.signal,
      });
      input.signal.addEventListener('abort', abortHandler, { once: true });

      this.emit({
        type: 'question.requested',
        sessionId: input.sessionId,
        payload: {
          questionId,
          questions: toQuestionItems(input.input),
        },
      });
      this.emit({
        type: 'session.status',
        sessionId: input.sessionId,
        payload: { status: 'waiting_question' },
      });
    });
  }

  /**
   * Apply the user's answer. Returns false if unknown / already settled /
   * session mismatch / no usable payload (bare allow would be re-asked).
   */
  respond(input: QuestionRespondInput): boolean {
    const entry = this.pending.get(input.questionId);
    if (!entry) {
      this.log('question.respond: no pending', input.questionId);
      return false;
    }
    if (entry.sessionId !== input.sessionId) {
      this.log('question.respond: session mismatch', input);
      return false;
    }

    if (input.cancel) {
      // Dismiss without a denial record: allow with explicitly empty answers.
      entry.settle(
        {
          behavior: 'allow',
          updatedInput: { ...entry.input, answers: {} },
          toolUseID: input.questionId,
        },
        { outcome: 'cancelled' }
      );
      return true;
    }

    const answers =
      input.answers && Object.keys(input.answers).length > 0 ? input.answers : undefined;
    const response =
      typeof input.response === 'string' && input.response.length > 0 ? input.response : undefined;
    if (!answers && !response) {
      // Bare allow footgun: cli.js silently re-asks when no answers arrive.
      this.log('question.respond: empty payload refused', input.questionId);
      return false;
    }

    entry.settle(
      {
        behavior: 'allow',
        updatedInput: {
          ...entry.input,
          ...(answers ? { answers } : {}),
          ...(response ? { response } : {}),
        },
        toolUseID: input.questionId,
      },
      { outcome: 'answered', answers, response }
    );
    return true;
  }

  /** Reject all pending questions for a session (stop / close). */
  rejectSession(sessionId: string, message = 'Session closed'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId !== sessionId) continue;
      entry.settle({
        behavior: 'deny',
        message,
        interrupt: true,
        toolUseID: entry.questionId,
      });
    }
  }

  /** Reject everything (Host shutdown). */
  rejectAll(message = 'Host shutting down'): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle({
        behavior: 'deny',
        message,
        interrupt: true,
        toolUseID: entry.questionId,
      });
    }
  }

  hasPending(sessionId?: string): boolean {
    if (!sessionId) return this.pending.size > 0;
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }
}
