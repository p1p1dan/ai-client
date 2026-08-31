import { Info, MonitorUp, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Ident } from '@/components/ui/ident';
import { addToast } from '@/components/ui/toast';
import { useWindowFocus } from '@/hooks/useWindowFocus';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiDisplayStore } from '@/stores/extensionUiDisplay';
import {
  type ExtensionUiWidgetPlacement,
  extensionUiNotificationDelivery,
} from './extensionUiDisplayModel';
import { ReadingColumn } from './ReadingColumn';

export function ExtensionUiStatusChips({ sessionId }: { sessionId: string | null }) {
  const statuses = useExtensionUiDisplayStore((state) => state.statuses);
  const entries = useMemo(
    () =>
      Object.values(statuses)
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => left.updatedAt - right.updatedAt),
    [sessionId, statuses]
  );
  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 px-6 pb-2">
      <ReadingColumn className="flex flex-wrap gap-1">
        {entries.map((entry) => (
          <Badge
            key={`${entry.runtimeId}:${entry.key}`}
            variant="outline"
            size="sm"
            className="min-w-0 max-w-full gap-1"
            title={`${entry.key}: ${entry.text}`}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-status-running" />
            <span className="truncate">{entry.text}</span>
          </Badge>
        ))}
      </ReadingColumn>
    </div>
  );
}

export function ExtensionUiWidgets({
  sessionId,
  placement,
}: {
  sessionId: string | null;
  placement: ExtensionUiWidgetPlacement;
}) {
  const widgets = useExtensionUiDisplayStore((state) => state.widgets);
  const entries = useMemo(
    () =>
      Object.values(widgets)
        .filter((entry) => entry.sessionId === sessionId && entry.placement === placement)
        .sort((left, right) => left.updatedAt - right.updatedAt),
    [placement, sessionId, widgets]
  );
  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 px-6 pb-2">
      <ReadingColumn className="grid gap-1">
        {entries.map((entry) => (
          <section
            key={`${entry.runtimeId}:${entry.key}`}
            aria-label={entry.key}
            className="rounded-md border border-border bg-muted/50 px-3 py-2"
          >
            <Ident className="block max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
              {entry.lines.join('\n')}
            </Ident>
          </section>
        ))}
      </ReadingColumn>
    </div>
  );
}

/** Deliver notify() exactly once and route OS notification clicks to live chats. */
export function ExtensionUiNotificationEffects() {
  const { t } = useI18n();
  const { isWindowFocused } = useWindowFocus();
  const notifications = useExtensionUiDisplayStore((state) => state.notifications);

  useEffect(() => {
    for (const snapshot of notifications) {
      const delivery = extensionUiNotificationDelivery(snapshot.kind, isWindowFocused);
      if (delivery === 'wait') continue;

      // Claim before the side effect. StrictMode may replay this effect, but a
      // replay cannot deliver an item already atomically removed from the store.
      const store = useExtensionUiDisplayStore.getState();
      const current = store.notifications.find((entry) => entry.id === snapshot.id);
      if (!current) continue;
      store.removeNotification(current.id);

      if (delivery === 'toast') {
        addToast({
          title: t('Extension notification'),
          description: current.message,
          type: current.kind,
        });
      } else {
        window.electronAPI.notification.show({
          title: current.kind === 'error' ? t('Extension error') : t('Extension warning'),
          body: current.message,
          sessionId: current.sessionId,
        });
      }
    }
  }, [isWindowFocused, notifications, t]);

  useEffect(
    () =>
      window.electronAPI.notification.onClick((sessionId) => {
        if (!sessionId) return;
        const state = useChatSessionsStore.getState();
        if (state.sessions.some((session) => session.id === sessionId)) {
          state.selectSession(sessionId);
        }
      }),
    []
  );

  return null;
}

export function ExtensionUiUnsupportedNotice({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const unsupported = useExtensionUiDisplayStore((state) => state.unsupported);
  const entries = useMemo(
    () =>
      Object.values(unsupported)
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => left.firstSeenAt - right.firstSeenAt),
    [sessionId, unsupported]
  );
  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 px-6 pb-2">
      <ReadingColumn>
        <div className="flex items-start gap-2 rounded-md border border-info/32 bg-info/4 px-3 py-2">
          <MonitorUp className="mt-0.5 size-4 shrink-0 text-info" />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-semibold text-foreground">
              {t('This extension needs the Pi TUI')}
            </p>
            <p className="text-meta text-muted-foreground">
              {t('The GUI does not support: {{methods}}. You can use these features in the TUI.', {
                methods: entries.map((entry) => entry.method).join(', '),
              })}
            </p>
          </div>
          {entries.some((entry) => entry.count > 1) ? (
            <Badge variant="info" size="sm" className="tabular-nums">
              <Info className="size-3" />
              {entries.reduce((total, entry) => total + entry.count, 0)}
            </Badge>
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-info" />
          )}
        </div>
      </ReadingColumn>
    </div>
  );
}
