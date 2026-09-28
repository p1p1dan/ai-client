/**
 * Narrow structural views of the DSH shapes the `aiclient-loop-guard` row
 * reads (DSH 0.1.7-rc.2: dsh-llm, dsh-agent, dsh-session, dsh-tools).
 *
 * Declared here instead of imported so the row's unit tests build them by
 * hand and the row's bundle takes in no DSH types.
 */

/** dsh-llm `LlmFailure`. */
export interface DshLlmFailure {
  readonly message: string;
  readonly code: string;
}

/** dsh-llm `FinishReason`, as far as this row reads or writes it. */
export type DshFinishReason =
  | { readonly kind: 'error' | 'aborted'; readonly failure: DshLlmFailure }
  | { readonly kind: string; readonly failure?: DshLlmFailure };

/** dsh-llm `ToolCallBlock`: `arguments` is the model's raw JSON string. */
export interface DshToolCallBlock {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** dsh-llm `StreamChunk`, as far as this row reads or writes it. */
export type DshStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | {
      readonly type: 'block-end';
      readonly index: number;
      readonly block: { readonly type: string } | DshToolCallBlock;
    }
  | { readonly type: 'finish'; readonly reason: DshFinishReason }
  | { readonly type: string; readonly [key: string]: unknown };

/** dsh-llm `MessageSource`: merge-extensible, keyed by `kind`. */
export interface DshMessageSource {
  readonly kind: string;
  readonly [key: string]: unknown;
}

/** dsh-llm `UserMessage`. */
export interface DshUserMessage {
  readonly id: string;
  readonly role?: 'user';
  readonly content: readonly unknown[];
  readonly source: DshMessageSource;
}

/** dsh-session `AgentCancelCause` (the `hook` branch this row sends). */
export interface DshCancelCause {
  readonly kind: 'hook';
  readonly reason: string;
}

/** dsh-agent `Agent`, as far as this row reads or drives it. */
export interface DshAgentView {
  readonly id: string;
  readonly session?: { readonly id: string };
  cancel(cause: DshCancelCause, options?: { keepInbox?: boolean }): void;
}

/** dsh-agent `PreStepDecision`. */
export type DshPreStepDecision =
  | { readonly kind: 'reject' }
  | {
      readonly kind: 'enter';
      readonly messages: readonly DshUserMessage[];
      readonly startsRequestSeries?: boolean;
    };

/** `agent/pre-step`'s payload. */
export interface DshPreStepPayload {
  readonly agent: DshAgentView;
  /** The messages the loop claimed from the inbox for this step. */
  readonly messages: readonly DshUserMessage[];
  readonly turn: number;
  /** 1-based within the turn. */
  readonly step: number;
}

/** `agent/request-error`'s payload. */
export interface DshRequestErrorPayload {
  readonly agent?: DshAgentView;
  readonly turn: number;
  readonly step: number;
  readonly failure: DshLlmFailure;
}

/** dsh-agent `RequestErrorAction`; `undefined` leaves the failure terminal. */
export type DshRequestErrorAction = { readonly kind: 'retry' } | undefined;

/** One durable `session/event`. */
export interface DshSessionEvent {
  readonly type: string;
  readonly seq?: number;
  readonly data?: { readonly turn?: unknown; readonly step?: unknown };
}

/** `tools/pre-execute`'s `exec`, as far as this row reads it. */
export interface DshToolCall {
  readonly callId: string;
  readonly name: string;
  readonly agent?: { readonly id: string; readonly session?: { readonly id: string } };
}

/** dsh-tools `PreToolDecision`, the two branches this row returns. */
export type DshPreToolDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny';
      readonly reason: string;
      readonly info?: { readonly name: string; readonly code: string };
    }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask'; readonly reason?: string };
