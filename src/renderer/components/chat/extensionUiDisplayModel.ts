import type { RuntimeEvent } from '@shared/types/runtimeEvents';

export type ExtensionUiWidgetPlacement = 'aboveEditor' | 'belowEditor';
export type ExtensionUiNotificationKind = 'info' | 'warning' | 'error';
export type ExtensionUiNotificationDelivery = 'toast' | 'os' | 'wait';

export function extensionUiNotificationDelivery(
  kind: ExtensionUiNotificationKind,
  windowFocused: boolean
): ExtensionUiNotificationDelivery {
  if (windowFocused) return 'toast';
  return kind === 'warning' || kind === 'error' ? 'os' : 'wait';
}

export interface ExtensionUiStatusEntry {
  sessionId: string;
  runtimeId: string;
  key: string;
  text: string;
  updatedAt: number;
}

export interface ExtensionUiWidgetEntry {
  sessionId: string;
  runtimeId: string;
  key: string;
  lines: string[];
  placement: ExtensionUiWidgetPlacement;
  updatedAt: number;
}

export interface ExtensionUiUnsupportedEntry {
  sessionId: string;
  runtimeId: string;
  method: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface ExtensionUiNotificationEntry {
  id: string;
  sessionId: string;
  runtimeId: string;
  message: string;
  kind: ExtensionUiNotificationKind;
  receivedAt: number;
}

export interface ExtensionUiDisplayState {
  statuses: Record<string, ExtensionUiStatusEntry>;
  widgets: Record<string, ExtensionUiWidgetEntry>;
  unsupported: Record<string, ExtensionUiUnsupportedEntry>;
  notifications: ExtensionUiNotificationEntry[];
}

export const initialExtensionUiDisplay: ExtensionUiDisplayState = {
  statuses: {},
  widgets: {},
  unsupported: {},
  notifications: [],
};

const STATUS_TEXT_BYTES = 256;
const STATUS_MAX_PER_RUNTIME = 8;
const WIDGET_MAX_PER_RUNTIME = 6;
const UNSUPPORTED_MAX_PER_RUNTIME = 12;
const WIDGET_LINE_BYTES = 512;
const WIDGET_TOTAL_BYTES = 4096;
const WIDGET_MAX_LINES = 12;
const NOTIFICATION_BYTES = 1024;
const MAX_NOTIFICATIONS = 32;

const entryKey = (sessionId: string, runtimeId: string, key: string) =>
  `${sessionId}\u0000${runtimeId}\u0000${key}`;

export function reduceExtensionUiDisplay(
  state: ExtensionUiDisplayState,
  event: RuntimeEvent
): ExtensionUiDisplayState {
  if (event.type === 'extensionUi.reset') {
    return clearExtensionUiRuntime(state, event.sessionId, event.payload.runtimeId);
  }
  if (event.type !== 'extensionUi.request' || !event.sessionId) return state;

  const { method, args, runtimeId, uiRequestId } = event.payload;
  switch (method) {
    case 'setStatus': {
      const parsed = readStatusArgs(args);
      if (!parsed) return state;
      const key = entryKey(event.sessionId, runtimeId, parsed.key);
      if (parsed.text === undefined) {
        if (!(key in state.statuses)) return state;
        return { ...state, statuses: withoutKey(state.statuses, key) };
      }
      const next: ExtensionUiStatusEntry = {
        sessionId: event.sessionId,
        runtimeId,
        key: parsed.key,
        text: truncateUtf8(parsed.text, STATUS_TEXT_BYTES),
        updatedAt: event.timestamp,
      };
      const current = state.statuses[key];
      if (current?.text === next.text) return state;
      return {
        ...state,
        statuses: limitRuntimeEntries(
          { ...state.statuses, [key]: next },
          event.sessionId,
          runtimeId,
          STATUS_MAX_PER_RUNTIME
        ),
      };
    }

    case 'setWidget': {
      const parsed = readWidgetArgs(args);
      if (!parsed) return state;
      const key = entryKey(event.sessionId, runtimeId, parsed.key);
      if (parsed.lines === undefined) {
        if (!(key in state.widgets)) return state;
        return { ...state, widgets: withoutKey(state.widgets, key) };
      }
      const next: ExtensionUiWidgetEntry = {
        sessionId: event.sessionId,
        runtimeId,
        key: parsed.key,
        lines: boundWidgetLines(parsed.lines),
        placement: parsed.placement,
        updatedAt: event.timestamp,
      };
      const current = state.widgets[key];
      if (
        current?.placement === next.placement &&
        current.lines.length === next.lines.length &&
        current.lines.every((line, index) => line === next.lines[index])
      ) {
        return state;
      }
      return {
        ...state,
        widgets: limitRuntimeEntries(
          { ...state.widgets, [key]: next },
          event.sessionId,
          runtimeId,
          WIDGET_MAX_PER_RUNTIME
        ),
      };
    }

    case 'unsupported': {
      const unsupportedMethod = readNonEmptyString(args, 'method');
      if (!unsupportedMethod) return state;
      const key = entryKey(event.sessionId, runtimeId, unsupportedMethod);
      const current = state.unsupported[key];
      const next: ExtensionUiUnsupportedEntry = current
        ? { ...current, count: current.count + 1, lastSeenAt: event.timestamp }
        : {
            sessionId: event.sessionId,
            runtimeId,
            method: unsupportedMethod,
            firstSeenAt: event.timestamp,
            lastSeenAt: event.timestamp,
            count: 1,
          };
      return {
        ...state,
        unsupported: limitRuntimeEntries(
          { ...state.unsupported, [key]: next },
          event.sessionId,
          runtimeId,
          UNSUPPORTED_MAX_PER_RUNTIME
        ),
      };
    }

    case 'notify': {
      const notification = readNotification(args, {
        id: `${runtimeId}:${uiRequestId}`,
        sessionId: event.sessionId,
        runtimeId,
        receivedAt: event.timestamp,
      });
      if (!notification || state.notifications.some((item) => item.id === notification.id)) {
        return state;
      }
      return {
        ...state,
        notifications: [...state.notifications, notification].slice(-MAX_NOTIFICATIONS),
      };
    }

    default:
      // Blocking dialogs live in extensionUiModel; semantic no-ops and other
      // portable-local methods intentionally create no renderer display state.
      return state;
  }
}

export function removeExtensionUiNotification(
  state: ExtensionUiDisplayState,
  id: string
): ExtensionUiDisplayState {
  const notifications = state.notifications.filter((item) => item.id !== id);
  return notifications.length === state.notifications.length ? state : { ...state, notifications };
}

export function clearExtensionUiRuntime(
  state: ExtensionUiDisplayState,
  sessionId: string,
  runtimeId: string
): ExtensionUiDisplayState {
  const keep = <T extends { sessionId: string; runtimeId: string }>(entry: T) =>
    entry.sessionId !== sessionId || entry.runtimeId !== runtimeId;
  const statuses = filterRecord(state.statuses, keep);
  const widgets = filterRecord(state.widgets, keep);
  const unsupported = filterRecord(state.unsupported, keep);
  const notifications = state.notifications.filter(keep);
  if (
    statuses === state.statuses &&
    widgets === state.widgets &&
    unsupported === state.unsupported &&
    notifications.length === state.notifications.length
  ) {
    return state;
  }
  return { statuses, widgets, unsupported, notifications };
}

export function pruneExtensionUiDisplayState(
  state: ExtensionUiDisplayState,
  sessionIds: readonly string[]
): ExtensionUiDisplayState {
  const live = new Set(sessionIds);
  const keep = <T extends { sessionId: string }>(entry: T) => live.has(entry.sessionId);
  return {
    statuses: filterRecord(state.statuses, keep),
    widgets: filterRecord(state.widgets, keep),
    unsupported: filterRecord(state.unsupported, keep),
    notifications: state.notifications.filter(keep),
  };
}

function readStatusArgs(args: unknown): { key: string; text?: string } | undefined {
  const key = readNonEmptyString(args, 'key');
  if (!key || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const text = (args as Record<string, unknown>).text;
  return text === undefined || typeof text === 'string'
    ? { key, ...(text !== undefined ? { text } : {}) }
    : undefined;
}

function readWidgetArgs(
  args: unknown
): { key: string; lines?: string[]; placement: ExtensionUiWidgetPlacement } | undefined {
  const key = readNonEmptyString(args, 'key');
  if (!key || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const raw = args as Record<string, unknown>;
  if (raw.content === undefined) return { key, placement: 'aboveEditor' };
  if (!Array.isArray(raw.content) || !raw.content.every((line) => typeof line === 'string')) {
    return undefined;
  }
  const options =
    raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)
      ? (raw.options as Record<string, unknown>)
      : undefined;
  return {
    key,
    lines: raw.content,
    placement: options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
  };
}

function readNotification(
  args: unknown,
  identity: Pick<ExtensionUiNotificationEntry, 'id' | 'sessionId' | 'runtimeId' | 'receivedAt'>
): ExtensionUiNotificationEntry | undefined {
  const message = readNonEmptyString(args, 'message');
  if (!message || isMisleadingPermissionLegacyNotification(message)) return undefined;
  const rawKind = readNonEmptyString(args, 'type');
  const kind: ExtensionUiNotificationKind =
    rawKind === 'warning' || rawKind === 'error' ? rawKind : 'info';
  return { ...identity, message: truncateUtf8(message, NOTIFICATION_BYTES), kind };
}

function readNonEmptyString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' && item.trim() ? item : undefined;
}

function boundWidgetLines(lines: readonly string[]): string[] {
  const result: string[] = [];
  let used = 0;
  for (const line of lines.slice(0, WIDGET_MAX_LINES)) {
    const bounded = truncateUtf8(line, Math.min(WIDGET_LINE_BYTES, WIDGET_TOTAL_BYTES - used));
    const bytes = utf8Length(bounded);
    if (bytes === 0 && used >= WIDGET_TOTAL_BYTES) break;
    result.push(bounded);
    used += bytes;
    if (used >= WIDGET_TOTAL_BYTES) break;
  }
  return result;
}

function truncateUtf8(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (utf8Length(value) <= limit) return value;
  let result = '';
  let used = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (used + size > limit) break;
    result += char;
    used += size;
  }
  return result;
}

const encoder = new TextEncoder();
const utf8Length = (value: string) => encoder.encode(value).byteLength;

export function isMisleadingPermissionLegacyNotification(message: string): boolean {
  return message.trimStart().startsWith('Legacy extension config found at');
}

function limitRuntimeEntries<
  T extends { sessionId: string; runtimeId: string; updatedAt?: number; lastSeenAt?: number },
>(
  record: Record<string, T>,
  sessionId: string,
  runtimeId: string,
  limit: number
): Record<string, T> {
  const matching = Object.entries(record)
    .filter(([, entry]) => entry.sessionId === sessionId && entry.runtimeId === runtimeId)
    .sort(
      ([, left], [, right]) =>
        (left.updatedAt ?? left.lastSeenAt ?? 0) - (right.updatedAt ?? right.lastSeenAt ?? 0)
    );
  if (matching.length <= limit) return record;
  const drop = new Set(matching.slice(0, matching.length - limit).map(([key]) => key));
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)));
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function filterRecord<T>(
  record: Readonly<Record<string, T>>,
  predicate: (value: T) => boolean
): Record<string, T> {
  const entries = Object.entries(record).filter(([, value]) => predicate(value));
  return entries.length === Object.keys(record).length
    ? (record as Record<string, T>)
    : Object.fromEntries(entries);
}
