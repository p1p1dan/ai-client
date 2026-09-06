/**
 * D12 (U24) decision three: say it once when the pool reclaims a conversation.
 *
 * Reclamation itself is old behaviour and stays exactly as it was — the oldest
 * IDLE session loses its worker so a new one can start. What changed is that it
 * used to be silent, which left the user with a conversation that had quietly
 * stopped being started and nothing to attribute it to.
 *
 * The user chose "reclaim and say so" over "ask which one to give up": the real
 * cost of reclamation is one resume on the next open (a pi session lives in a
 * file, so nothing is lost but the load time), and turning that into a required
 * decision would interrupt every new chat once the pool is full.
 *
 * A hook rather than a reducer branch: `addToast` is a side effect, and the
 * store's event reducer is pure. The reducer's half of this (dropping the host
 * binding) lives there; the sentence lives here.
 */
import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';

export function useCapacityReclaimNotice(): void {
  const { t } = useI18n();

  useEffect(() => {
    return subscribeRuntimeEvent((event) => {
      if (event.type !== 'session.status') return;
      if (event.payload.disconnectReason !== 'capacity_reclaimed') return;
      // Read the title fresh at event time rather than subscribing to the
      // session list: this effect must not re-subscribe on every store change,
      // and the title it wants is whatever the row says right now.
      const session = useChatSessionsStore
        .getState()
        .sessions.find((item) => item.id === event.sessionId);
      addToast({
        type: 'info',
        title: t('A conversation moved to the background'),
        description: session
          ? t('“{{name}}” was stopped to make room for a new one. Open it to continue.', {
              name: session.title,
            })
          : t('An older conversation was stopped to make room for a new one.'),
      });
    });
  }, [t]);
}
