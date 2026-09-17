/**
 * The app's own keys on pi objects, and the rule that takes them off again.
 *
 * ## What rides where
 *
 * Two riders travel on objects pi owns and persists: the attachment file name
 * on an image content block (`attachmentRider.ts`) and the origin mark on a
 * message the runtime wrote for itself (`internalMessage.ts`). Both are
 * namespaced with the same prefix, so one rule finds both and any third one
 * added later.
 *
 * ## Why they have to come off
 *
 * The session file WANTS them — that is the whole point of a rider. A provider
 * must not see them. The original reasoning was that no provider ever could,
 * because every pi-ai adapter REBUILDS a block from the fields it knows
 * (`{ source: { media_type, data } }` for Anthropic, a `data:` URL for OpenAI,
 * `inlineData` for Google) and drops the rest.
 *
 * That is true of every adapter but one. `pi-messages` does not rebuild
 * anything: it sends `JSON.stringify({ model, context, options })` with the
 * context verbatim (`@earendil-works/pi-ai/dist/api/pi-messages.js`), and this
 * app lists that API as a user-selectable one (`shared/userProviders.ts`,
 * `model-adapter/catalog.ts`). So "the wire never sees it" was not a property
 * of the adapters at all. It is enforced on the way out instead, in one place
 * that every provider goes through (`plugins/model-adapter/index.ts`).
 */

/** The prefix every app-owned key on a pi object starts with. */
export const AICLIENT_KEY_PREFIX = 'aiclient';

/**
 * Prefix plus a capital, so the rule cannot swallow a provider field that
 * merely begins with the same letters. Both riders are named this way.
 */
const NAMESPACED_KEY = /^aiclient[A-Z]/;

/** True for a key this app put on an object pi owns. */
export function isAiclientKey(key: string): boolean {
  return NAMESPACED_KEY.test(key);
}

/**
 * A copy of `value` with every app-owned key removed, at any depth.
 *
 * Returns the SAME reference when there was nothing to strip, so a context
 * carrying no rider costs one walk and no allocation, and anything comparing
 * message identity across a request keeps seeing what it saw.
 *
 * Only plain objects and arrays are walked. A class instance, a Buffer or a
 * function is passed through untouched: those are pi's or a vendor SDK's, and
 * a rider is never put on one.
 */
export function stripAiclientKeys<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = strip(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isAiclientKey(key)) {
      changed = true;
      continue;
    }
    const stripped = strip(item);
    if (stripped !== item) changed = true;
    next[key] = stripped;
  }
  return changed ? next : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
