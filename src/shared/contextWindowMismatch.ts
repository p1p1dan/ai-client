/**
 * User 2026-10-18: a model whose real context window is smaller than the one
 * it is set to. The engines compact by the window they were given, so such a
 * model runs into the service's own limit: the service refuses the request
 * ("prompt is too long"), the engine compacts and retries, and nothing tells
 * anybody that the setting is wrong. Both engines read the service's limit out
 * of that refusal here and, when it is below the setting, put one notice in
 * the timeline asking for the window to be corrected.
 *
 * Pure and import-free: the DSH host, the Agent SDK host and the renderer all
 * load it.
 */

/** `custom.message` notice kind of the timeline line (`dsh:context-window`). */
export const CONTEXT_WINDOW_NOTICE_KIND = 'context-window';

/** The line's dictionary key; `text` is its English rendering. */
export const CONTEXT_WINDOW_NOTICE_KEY =
  'The service accepts at most {{limit}} tokens for {{model}}, less than the {{configured}} it is set to. Ask your administrator to correct this model’s context window, or fix it in the service settings if you added the service yourself.';

export interface ServiceContextLimit {
  /** The most the service takes, as its refusal says. */
  limit: number;
  /** What the refused request came to, when the refusal says. */
  requested?: number;
}

/** A refusal's wording, with the limit's capture group and, optionally, the request's. */
interface LimitPattern {
  pattern: RegExp;
  limit: number;
  requested?: number;
}

const NUMBER = '([\\d,]+)';

/**
 * Wordings with the limit in them (pi-ai's `utils/overflow.ts` lists the
 * services; the Agent SDK CLI words Anthropic's its own way). A refusal
 * without a number ("Your input exceeds the context window of this model")
 * has nothing to read.
 */
const LIMIT_PATTERNS: readonly LimitPattern[] = [
  // Anthropic: "prompt is too long: 213462 tokens > 200000 maximum".
  {
    pattern: new RegExp(
      `prompt is too long:\\s*${NUMBER}\\s*tokens?\\s*>\\s*${NUMBER}\\s*maximum`,
      'i'
    ),
    requested: 1,
    limit: 2,
  },
  // The Agent SDK CLI: "the request is ~250000 tokens (limit 200000)".
  {
    pattern: new RegExp(`request is ~?${NUMBER}\\s*tokens?\\s*\\(limit\\s*${NUMBER}\\)`, 'i'),
    requested: 1,
    limit: 2,
  },
  // Anthropic, input plus max_tokens: "exceed context limit: 180000 + 64000 > 200000".
  {
    pattern: new RegExp(
      `exceed context limit:\\s*${NUMBER}\\s*\\+\\s*${NUMBER}\\s*>\\s*${NUMBER}`,
      'i'
    ),
    limit: 3,
  },
  // OpenAI, OpenRouter: "maximum context length is 272000 tokens. However, your messages resulted in 300000 tokens".
  {
    pattern: new RegExp(
      `maximum context length is ${NUMBER} tokens?[^\\d]{0,80}?(?:resulted in|requested about) ${NUMBER}`,
      'i'
    ),
    limit: 1,
    requested: 2,
  },
  { pattern: new RegExp(`maximum context length is ${NUMBER} tokens?`, 'i'), limit: 1 },
  // OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)".
  {
    pattern: new RegExp(
      `input length \\(${NUMBER}\\) exceeds (?:the )?model'?s maximum context length \\(${NUMBER}\\)`,
      'i'
    ),
    requested: 1,
    limit: 2,
  },
  // LiteLLM: "exceeds the model's maximum context length of 131072 tokens".
  {
    pattern: new RegExp(`maximum context length(?: of\\s*|\\s*\\()${NUMBER}`, 'i'),
    limit: 1,
  },
  // Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)".
  {
    pattern: new RegExp(
      `input token count \\(${NUMBER}\\) exceeds the maximum number of tokens allowed \\(${NUMBER}\\)`,
      'i'
    ),
    requested: 1,
    limit: 2,
  },
  // xAI: "maximum prompt length is 131072 but the request contains 537812 tokens".
  {
    pattern: new RegExp(
      `maximum prompt length is ${NUMBER}(?: but the request contains ${NUMBER})?`,
      'i'
    ),
    limit: 1,
    requested: 2,
  },
  // OpenRouter/Poolside: "exceeds the maximum allowed input length of 131072 tokens".
  { pattern: new RegExp(`maximum allowed input length of ${NUMBER} tokens?`, 'i'), limit: 1 },
  // Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)".
  {
    pattern: new RegExp(
      `input \\(${NUMBER} tokens?\\) is longer than the model'?s context length \\(${NUMBER} tokens?\\)`,
      'i'
    ),
    requested: 1,
    limit: 2,
  },
  // GitHub Copilot: "prompt token count of X exceeds the limit of Y".
  {
    pattern: new RegExp(`prompt token count of ${NUMBER} exceeds the limit of ${NUMBER}`, 'i'),
    requested: 1,
    limit: 2,
  },
  // Mistral: "too large for model with 131072 maximum context length".
  {
    pattern: new RegExp(`too large for model with ${NUMBER} maximum context length`, 'i'),
    limit: 1,
  },
  // DS4: "Prompt has X tokens, but the configured context size is Y tokens".
  {
    pattern: new RegExp(
      `prompt has ${NUMBER} tokens?, but the configured context size is ${NUMBER}`,
      'i'
    ),
    requested: 1,
    limit: 2,
  },
  // Kimi: "Your request exceeded model token limit: X (requested: Y)".
  {
    pattern: new RegExp(
      `exceeded model token limit:\\s*${NUMBER}(?:\\s*\\(requested:\\s*${NUMBER}\\))?`,
      'i'
    ),
    limit: 1,
    requested: 2,
  },
  // DashScope / Qwen: "Range of input length should be [1, 129024]".
  { pattern: new RegExp(`range of input length should be \\[1,\\s*${NUMBER}\\]`, 'i'), limit: 1 },
];

/** Below this a "limit" is not a context window (a byte count, an id). */
const MIN_LIMIT = 1_000;

function tokenCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The service's limit a context-overflow refusal names, or undefined when it names none. */
export function serviceContextLimit(text: string): ServiceContextLimit | undefined {
  if (!text) return undefined;
  for (const { pattern, limit, requested } of LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = tokenCount(match[limit]);
    if (value === undefined || value < MIN_LIMIT) continue;
    const asked = requested !== undefined ? tokenCount(match[requested]) : undefined;
    return { limit: value, ...(asked !== undefined ? { requested: asked } : {}) };
  }
  return undefined;
}

export interface ContextWindowNotice {
  key: string;
  params: { model: string; limit: string; configured: string };
  /** The English rendering, for every surface that does not translate. */
  text: string;
  limit: number;
  configured: number;
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The notice a refusal earns: when it names the service's limit and that is
 * below the window the model is set to. A model set to what the service takes
 * earns none, even when one request was too big for it.
 */
export function contextWindowNotice(input: {
  errorText: string;
  /** The window the engine runs the model at (the catalog's, or the engine's own). */
  configured: number | undefined;
  /** The model as the user knows it: `provider/model` or the bare id; shown bare. */
  model: string;
}): ContextWindowNotice | undefined {
  const found = serviceContextLimit(input.errorText);
  const configured = input.configured;
  if (!found || configured === undefined || !(configured > found.limit)) return undefined;
  const slash = input.model.indexOf('/');
  const model = slash >= 0 ? input.model.slice(slash + 1) : input.model;
  const params = { model, limit: grouped(found.limit), configured: grouped(configured) };
  const text = CONTEXT_WINDOW_NOTICE_KEY.replace(
    /\{\{(model|limit|configured)\}\}/g,
    (_, name: keyof typeof params) => params[name]
  );
  return { key: CONTEXT_WINDOW_NOTICE_KEY, params, text, limit: found.limit, configured };
}
