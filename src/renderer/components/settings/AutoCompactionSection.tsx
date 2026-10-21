/**
 * dsh-rebase decision 177 — 「设置 · 模型」's automatic compaction list: for
 * every model the menu offers, whether the engine compacts its conversations
 * by itself and from about where, or why it does not.
 *
 * Read from the same menu the chat's model picker gets (`listPiModels`): Main
 * builds it with the model plan the host is configured with, and puts each
 * model's policy on it from the shared rules the host configures
 * `compaction-basic` with. `reloadKey` changes when the services or the
 * managed catalog changed, so the list follows an edit.
 */

import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { autoCompactionNote } from './autoCompactionText';
import { SETTINGS_CARD_FRAME_CLASS, SettingsSectionBlock } from './SettingsPrimitives';

export function AutoCompactionSection({ reloadKey }: { reloadKey?: string | number }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);

  useEffect(() => {
    // `reloadKey` is the trigger, not an input of the read.
    void reloadKey;
    const listPiModels = window.electronAPI?.chat?.listPiModels;
    if (!listPiModels) return;
    let live = true;
    listPiModels()
      .then((result) => {
        if (live && result && Array.isArray(result.models)) setCatalog(result);
      })
      // A failed read leaves the list as it was; the model picker reports the catalog.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const models = (catalog?.models ?? []).flatMap((model) =>
    model.autoCompaction ? [{ ...model, autoCompaction: model.autoCompaction }] : []
  );
  if (models.length === 0) return null;

  return (
    <SettingsSectionBlock
      bare
      title={t('Automatic compaction')}
      description={t(
        'When a conversation nears the context window, the engine summarizes its earlier part by itself. Where that starts, model by model:'
      )}
    >
      <ul aria-label={t('Automatic compaction')} className={SETTINGS_CARD_FRAME_CLASS}>
        {models.map((model) => {
          const policy = model.autoCompaction;
          const note = autoCompactionNote(policy, policy.contextWindowDefaulted, t);
          return (
            <li
              key={model.id}
              data-model={model.id}
              data-auto={policy.auto ? 'on' : 'off'}
              className="min-w-0 space-y-0.5 px-3 py-2"
            >
              <p className="truncate text-ui" title={model.id}>
                {model.label}
              </p>
              <p
                className={cn(
                  'text-small',
                  note.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'
                )}
              >
                {note.text}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-small text-muted-foreground">
        {t(
          'For an AI service you added yourself, edit it under AI services above and change the context window and output limit in Model settings; for a model your administrator provides, ask them.'
        )}
      </p>
    </SettingsSectionBlock>
  );
}
