import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { ChevronDown, FolderOpen, FolderPlus, GitBranch, Server } from 'lucide-react';
import { Menu, MenuPopup } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { composerMenuItemClass } from './middleColumnLayout';

/**
 * T12-e — the surface shown above the composer when no working directory has
 * been picked yet.
 *
 * It replaces a red-bordered, red-tinted monospace box reading
 * `No repository registered — launch with --open-path=<repo> (or add a
 * repository) first.`, which was permanently lit on a fresh install. The user
 * report was that it looks like the app is broken; it also told the user to
 * pass a CLI flag, which is not a thing a desktop user does.
 *
 * Shape follows pi-app's `ProjectHomeView`: a centred folder button with a
 * menu and a one-line explanation. T12-e′ records the 2026-08-30 field-test
 * reversal that gave this card the whole empty-repository surface, with no
 * composer mounted below it.
 *
 * U05-b partly undid that last part: the card is still the guided way to pick
 * a folder, but it no longer REPLACES the composer. A chat with no folder is a
 * supported way to work now (it runs in an isolated temporary directory), so
 * the card sits above a live composer and its copy offers the folder rather
 * than demanding it.
 *
 * The menu offers the same three entries as the folder dropdown's footer
 * (`TargetFolderSelect`) and delegates to the same `onAddRepository` callback.
 * Two different ways to add a repository that took different code paths would
 * be two things to keep in sync; this is one path with two entrances.
 */
interface ChatWelcomeCardProps {
  /** Opens the shared AddRepositoryDialog, owned by App. */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
}

export function ChatWelcomeCard({ onAddRepository }: ChatWelcomeCardProps) {
  const { t } = useI18n();

  return (
    <div className="mb-4 flex flex-col items-center gap-2 text-center">
      {onAddRepository ? (
        <Menu>
          <MenuPrimitive.Trigger
            className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-card/50 px-4 py-2 font-medium text-foreground text-markdown transition-colors hover:border-primary/40 hover:bg-accent"
            render={<button type="button" />}
          >
            <FolderOpen className="size-4 shrink-0" />
            {t('Choose a working directory')}
            <ChevronDown className="size-4 shrink-0" />
          </MenuPrimitive.Trigger>
          <MenuPopup
            align="center"
            className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
            side="bottom"
          >
            <MenuPrimitive.Item
              className={composerMenuItemClass()}
              onClick={() => onAddRepository('local')}
            >
              <FolderPlus className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('Use Existing…')}</span>
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={composerMenuItemClass()}
              onClick={() => onAddRepository('remote')}
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('Clone…')}</span>
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={composerMenuItemClass()}
              onClick={() => onAddRepository('ssh')}
            >
              <Server className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('Add Remote…')}</span>
            </MenuPrimitive.Item>
          </MenuPopup>
        </Menu>
      ) : (
        // No handler wired (the dialog lives in App and is threaded down). A
        // dead button would be worse than a plain sentence: it would promise
        // an action that cannot happen.
        <p className="font-medium text-foreground text-markdown">{t('No working directory yet')}</p>
      )}
      {/* `text-meta` (13px) rather than a raw size: D25 §6.3 bans raw size
          utilities in chat/, and this is a secondary explanation — the same
          tier as the status line it sits near. */}
      <p className="max-w-sm text-meta text-muted-foreground">
        {t(
          'Pick a folder to work on a project — the agent works inside it. Without one, this chat runs in a private temporary folder.'
        )}
      </p>
    </div>
  );
}
