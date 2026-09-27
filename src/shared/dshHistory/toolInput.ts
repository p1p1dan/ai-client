// New in dsh-rebase P1-4a

/**
 * DSH keeps a tool call's arguments as the raw JSON string the model wrote;
 * rows and cards need the object. Unparsable text is kept, under `raw`.
 */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * DSH names the file argument `file_path`; our timeline rows read `path`. The
 * alias is added and nothing is removed, so the call stays intact. Shared by
 * the bridge's live `tool.*` events and the history projection, so a replayed
 * row reads exactly like the live one.
 */
export function toolRowInput(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  return typeof record.file_path === 'string' && record.path === undefined
    ? { ...record, path: record.file_path }
    : record;
}
