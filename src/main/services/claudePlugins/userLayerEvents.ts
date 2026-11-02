/**
 * docs/plantree/plans/claude-plugins §4.3: the Claude user layer changed (a
 * plugin or MCP server added, switched or removed), so lists kept per folder
 * — the slash menu's (decision 194) — are out of date.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onClaudeUserLayerChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyClaudeUserLayerChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[claude-plugins] a user-layer listener failed', error);
    }
  }
}
