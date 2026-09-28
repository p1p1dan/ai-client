// Moved from src/runtime/plugins/mcp/index.ts (dsh-rebase P1-16 prep): how an MCP tool is named to the model and to the permission gate.

/**
 * ## Naming
 *
 * `mcp__<server>__<tool>`, the convention the ecosystem already uses. The
 * prefix is not decoration: it is what tells a permission rule, an approval
 * card and a transcript row that this call leaves the machine's own tool set,
 * and what keeps two servers that both publish `search` apart.
 *
 * ## Permission
 *
 * Every call is put to the permission gate before it reaches the server. An
 * MCP tool can do anything its server can do, and unlike `read` or `bash`
 * there is nothing local to inspect — no path to check, no command to parse.
 * So the gate is asked with the workspace as the subject and the arguments as
 * the preview, on the `mcp` policy surface with a `server:tool` value.
 */

/**
 * `mcp__<server>__<tool>`, clamped to what a provider accepts as a tool name.
 *
 * The alphabet is `[A-Za-z0-9_-]` because that is OpenAI's and Anthropic's rule
 * for a function name, not a local preference — and a tool definition rides
 * along with EVERY request, so one unacceptable character does not break one
 * call, it breaks every turn of the session with a 400 that names no tool.
 * A dot is the common case (`slack.postMessage`), so it is replaced rather than
 * rejected; two names that collide once replaced are caught at registration.
 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}

/**
 * T002 — the policy surface an MCP call is judged on. The tool name above is
 * sanitized and clamped for the model's alphabet; it is not the ecosystem's
 * `mcp` surface, so a rule like `"mcp": "deny"` is only consulted when the
 * surface is passed explicitly.
 */
export const MCP_POLICY_SURFACE = 'mcp';

/**
 * T002 — the value a policy rule or a remembered grant matches: `server:tool`,
 * the shape a policy author writes (`"mcp": {"echo:*": "deny"}`), built from
 * the server's and the tool's OWN names — never recovered from the clamped
 * tool name, which may have lost characters.
 */
export function mcpPolicyValue(server: string, tool: string): string {
  return `${server}:${tool}`;
}

/** The approval card's preview of a call's arguments. */
export function mcpArgumentsPreview(args: Record<string, unknown>): {
  label: string;
  text: string;
} {
  return { label: 'Arguments', text: JSON.stringify(args, null, 2).slice(0, 4000) };
}
