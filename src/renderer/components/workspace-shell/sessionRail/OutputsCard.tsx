import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import {
  Copy,
  FileText,
  FolderOpen,
  Globe,
  ImageIcon,
  type LucideIcon,
  Presentation,
  Sheet,
} from 'lucide-react';
import { MenuItem, MenuPopup } from '@/components/ui/menu';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { resolveIntentPath } from '../surfaces/resolveIntentPath';
import type { OutputKind, OutputRow } from './outputsModel';
import { RailCard } from './RailCard';

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KIND_ICON: Readonly<Record<OutputKind, LucideIcon>> = {
  document: FileText,
  web: Globe,
  image: ImageIcon,
  sheet: Sheet,
  slides: Presentation,
};

function toastMissing(row: OutputRow, t: Translate): void {
  toastManager.add({
    type: 'warning',
    title: t('The file is no longer there'),
    description: row.name,
  });
}

/**
 * Decision 209 §2: a web page opens in the app's preview window, anything
 * else in the editor pane (the request a tool row's path makes). A file that
 * is gone says so instead of opening an empty tab.
 */
export async function openOutput(
  row: OutputRow,
  workspacePath: string | null,
  t: Translate
): Promise<void> {
  const api = window.electronAPI;
  const path = resolveIntentPath(row.path, workspacePath);
  const exists = path ? await api?.file.exists(path).catch(() => false) : false;
  if (!path || !exists) {
    toastMissing(row, t);
    return;
  }
  if (row.kind === 'web') {
    const result = await api?.preview.openHtml(path).catch(() => null);
    if (result?.ok) return;
    if (result?.reason === 'missing') {
      toastMissing(row, t);
      return;
    }
    toastManager.add({ type: 'error', title: t('Could not open "{{path}}".', { path: row.name }) });
    return;
  }
  useFileOpenIntentStore.getState().requestFileOpen({ path, source: 'outputs' });
}

/**
 * Decision 209 §2: the session rail's Outputs card — the documents, pages,
 * images, sheets and slides this conversation created, newest first. A row
 * opens its file; right-click copies its path or shows it in the file
 * manager. Not drawn while there is none.
 */
export function OutputsCard({
  rows,
  workspacePath,
}: {
  rows: readonly OutputRow[];
  /** The conversation's folder, for paths a tool recorded relative to it. */
  workspacePath: string | null;
}) {
  const { t } = useI18n();
  return (
    <RailCard id="outputs" title={t('Outputs')} summary={<span>{rows.length}</span>}>
      <ul className="flex flex-col" data-rail-outputs="">
        {rows.map((row) => {
          const Icon = KIND_ICON[row.kind];
          const fullPath = resolveIntentPath(row.path, workspacePath) ?? row.path;
          return (
            <li key={row.key} className="-mx-1 min-w-0">
              <ContextMenuPrimitive.Root>
                <ContextMenuPrimitive.Trigger
                  render={
                    <button
                      type="button"
                      onClick={() => void openOutput(row, workspacePath, t)}
                      title={fullPath}
                      className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left transition-colors hover:bg-fill-ghost-hover"
                      data-output-kind={row.kind}
                    />
                  }
                >
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                </ContextMenuPrimitive.Trigger>
                <MenuPopup align="start" side="bottom" className="min-w-40">
                  <MenuItem
                    onClick={() => {
                      void navigator.clipboard.writeText(fullPath).then(
                        () =>
                          toastManager.add({
                            title: t('Copied'),
                            description: t('Path copied to clipboard'),
                            type: 'success',
                            timeout: 2000,
                          }),
                        () => undefined
                      );
                    }}
                  >
                    <Copy />
                    {t('Copy Path')}
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      void window.electronAPI?.file.revealInFileManager(fullPath).catch(() => {})
                    }
                  >
                    <FolderOpen />
                    {t('Reveal in Explorer')}
                  </MenuItem>
                </MenuPopup>
              </ContextMenuPrimitive.Root>
            </li>
          );
        })}
      </ul>
    </RailCard>
  );
}
