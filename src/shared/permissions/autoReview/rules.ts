/**
 * The rule set Claude Code's auto mode reviews against, as `claude auto-mode
 * defaults` prints it (decision 192 §3.2): read at run time from the bundled
 * CLI, never stored in this repository.
 */

export interface AutoModeRules {
  allow: string[];
  softDeny: string[];
  hardDeny: string[];
  environment: string[];
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  return items.length === value.length ? items : null;
}

/** The CLI's JSON, or null when it is not the four lists the reviewer needs. */
export function parseAutoModeRules(text: string): AutoModeRules | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allow = stringList(record.allow);
  const softDeny = stringList(record.soft_deny);
  const hardDeny = stringList(record.hard_deny);
  const environment = stringList(record.environment ?? []);
  if (!allow || !softDeny || !hardDeny || !environment) return null;
  if (softDeny.length === 0 && hardDeny.length === 0) return null;
  return { allow, softDeny, hardDeny, environment };
}
