// Moved from src/runtime/plugins/mcp/index.ts (dsh-rebase P1-16 prep): folding a server's tools/call result into tool-result content.

import type { McpToolResult } from './client.ts';

/** Tool output is folded into the conversation, so it shares the tool budget. */
export const MCP_OUTPUT_BYTES = 50 * 1024;
/** Images bypass the text budget entirely, so their count is what is capped. */
export const MCP_MAX_IMAGES = 8;
/**
 * T024 — byte ceilings for the images one call may forward.
 *
 * A count alone does not bound anything: the base64 payload of every forwarded
 * image is written into the session file verbatim, and the only other limit on
 * it is the 8 MiB transport frame, so eight images could add most of that to a
 * single JSONL line. Unlike a tool's text output — which the model produced and
 * is therefore bounded by its own output budget — this size is chosen entirely
 * by a third-party server, which makes it the one session-file source a user
 * cannot influence. Per-image and per-call are both needed: one ceiling alone
 * is escapable by splitting one big image into eight merely large ones.
 *
 * The numbers: 1 MiB of base64 is roughly 768 KiB of PNG, generous for a
 * screenshot, and 2 MiB per call keeps the worst call at 1/16 of the session
 * budget instead of 1/4.
 */
export const MCP_IMAGE_BYTES = 1024 * 1024;
export const MCP_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;

/** A text block of a tool result; structurally pi-ai's `TextContent`. */
export interface McpTextBlock {
  type: 'text';
  text: string;
}

/** An image block of a tool result; structurally pi-ai's `ImageContent`. */
export interface McpImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

export type McpResultBlock = McpTextBlock | McpImageBlock;

/**
 * A server's `tools/call` result, as content the model can actually receive.
 *
 * An image comes back as `{type:'image', data, mimeType}`, which is exactly the
 * shape a tool result may carry, so it is forwarded rather than flattened: a
 * screenshot server is one of the most common MCP servers there is, and the
 * literal text `[image]` is indistinguishable to the model from a tool that
 * returned nothing.
 */
export function mcpResultContent(result: McpToolResult): {
  content: McpResultBlock[];
  images: number;
} {
  const texts: string[] = [];
  const images: McpImageBlock[] = [];
  let dropped = 0;
  let oversized = 0;
  let imageBytes = 0;
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text) texts.push(part.text);
      continue;
    }
    if (part.type === 'image' && typeof part.data === 'string' && part.data) {
      if (images.length >= MCP_MAX_IMAGES) {
        dropped += 1;
        continue;
      }
      // T024 — measured before the payload is kept, not after: an image that
      // does not fit must never reach the session file at all.
      const bytes = Buffer.byteLength(part.data);
      if (bytes > MCP_IMAGE_BYTES || imageBytes + bytes > MCP_IMAGE_TOTAL_BYTES) {
        oversized += 1;
        continue;
      }
      imageBytes += bytes;
      images.push({
        type: 'image',
        data: part.data,
        mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
      });
      continue;
    }
    // Resource links, audio, and whatever a future revision adds: named, so the
    // model can tell "I got something I cannot read" from "I got nothing".
    texts.push(`[${part.type}]`);
  }
  if (dropped > 0) texts.push(`[${dropped} more image(s) not forwarded]`);
  // Said separately from the count overflow: "too many" is answered by asking
  // for fewer, "too large" is not, and a model told the wrong one retries the
  // call forever.
  if (oversized > 0) texts.push(`[${oversized} image(s) dropped: over the size budget]`);
  const joined = texts.join('\n');
  // T024 — cut on bytes, which is what the budget is named in and what the
  // session file is measured in. `String.length` counts UTF-16 units, so the
  // same "50 KiB" admitted up to three times that in CJK or emoji text.
  const encoded = Buffer.from(joined);
  const text =
    encoded.byteLength > MCP_OUTPUT_BYTES
      ? `${truncateUtf8(encoded, MCP_OUTPUT_BYTES)}\n[output truncated]`
      : joined;
  return {
    content: [{ type: 'text', text: text || summarize(images.length) }, ...images],
    images: images.length,
  };
}

/**
 * The whole tool result: {@link mcpResultContent}, with a server-reported
 * failure labelled in the text.
 *
 * MCP's `isError` is the SERVER reporting a tool-level failure — a missing
 * file, a rejected query — which the model is meant to read and react to.
 * Throwing would end the tool call as a runtime fault and hide the server's
 * own explanation, so it is labelled in the text instead. A transport fault is
 * a different thing and does throw (from the client, before this runs).
 */
export function foldMcpToolResult(result: McpToolResult): {
  content: McpResultBlock[];
  images: number;
  isError: boolean;
} {
  const { content, images } = mcpResultContent(result);
  const [first, ...rest] = content;
  return {
    content: [
      result.isError && first?.type === 'text'
        ? ({ type: 'text', text: `[tool reported an error]\n${first.text}` } as const)
        : first,
      ...rest,
    ].filter((part): part is McpResultBlock => part !== undefined),
    images,
    isError: result.isError === true,
  };
}

/**
 * Cut UTF-8 bytes without producing a replacement character.
 *
 * `stream: true` makes the decoder hold back an incomplete trailing sequence
 * rather than emit U+FFFD for it, so the cut lands on a character boundary and
 * the dropped bytes are at most three.
 */
function truncateUtf8(bytes: Buffer, limit: number): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, limit), {
    stream: true,
  });
}

/** The text block is never empty: a transcript renders it, and JSON of a base64 image is not a transcript line. */
function summarize(images: number): string {
  if (images === 0) return '(no output)';
  return images === 1 ? '(1 image)' : `(${images} images)`;
}
