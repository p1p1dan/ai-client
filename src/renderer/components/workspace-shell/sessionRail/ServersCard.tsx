import { Globe } from 'lucide-react';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { RailCard } from './RailCard';
import type { ServerRow } from './serversModel';

/**
 * The session rail's Servers card (user, 2026-10-22): the local addresses the
 * conversation's running background commands announced. A row opens its
 * address in the browser. Not drawn while there is none.
 */
export function ServersCard({ rows }: { rows: readonly ServerRow[] }) {
  const { t } = useI18n();
  return (
    <RailCard id="servers" title={t('Servers')} summary={<span>{rows.length}</span>}>
      <ul className="flex flex-col" data-rail-servers="">
        {rows.map((row) => (
          <li key={row.key} className="-mx-1 min-w-0">
            <button
              type="button"
              onClick={() => void window.electronAPI?.shell?.openExternal(row.url)}
              title={`${t('Open in browser')} · ${row.url}`}
              className="flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-fill-ghost-hover"
              data-server-url={row.url}
            >
              <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <Ident className="truncate text-foreground">
                  {row.url.replace(/^https?:\/\//, '')}
                </Ident>
                {row.label && <Ident className="truncate text-foreground-faint">{row.label}</Ident>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </RailCard>
  );
}
