/**
 * Decision 182 (DA-3): every user message of an anthropic-messages request in
 * one content form, the text-block array, on every request.
 *
 * pi-ai's Anthropic serializer sends the last user message as a text block
 * carrying the cache mark and every earlier one as a plain string, so a
 * turn's user input goes out as a block on its first step and as a string
 * from its second step on. On some upstreams behind the company gateway the
 * cache written on that block is never read again: each turn's second step
 * rewrote what its first step had cached (evidence
 * cache-compare-real-gateway-2026-10-11). Claude Code keeps every message a
 * block array and only moves the mark; this does the same for us.
 *
 * Only a `role: "user"` message whose `content` is a string with non-space
 * text changes: its content becomes `[{type: "text", text}]` with the very
 * same text. The message's other keys, their order, every other message,
 * every mark and every other field stay as they are. An empty or blank string
 * is left alone: the API refuses a text block without text, and pi-ai never
 * sends one.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `message` is a user message whose content this file turns into a block. */
function hasStringUserContent(message: unknown): message is Record<string, unknown> & {
  content: string;
} {
  return (
    isPlainObject(message) &&
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.trim() !== ''
  );
}

/**
 * `body` (a parsed Messages request) with each user message's string content
 * as the one text block it stands for; undefined when no message has one, so
 * the caller sends the body as it is. `body` is never changed: the result
 * shares everything but the messages array and the messages it rewrites.
 * Applying it to its own result gives undefined.
 */
export function withUserContentBlocks(body: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return undefined;
  const source: readonly unknown[] = body.messages;
  let messages: unknown[] | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (!hasStringUserContent(message)) continue;
    messages ??= [...source];
    // Spread keeps `content` where it was: the key order goes out as it came.
    messages[index] = { ...message, content: [{ type: 'text', text: message.content }] };
  }
  return messages === undefined ? undefined : { ...body, messages };
}
