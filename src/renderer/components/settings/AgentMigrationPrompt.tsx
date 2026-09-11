/**
 * H/21 P1 — the one-time "bring your Pi setup over" dialog.
 *
 * Shown at most once per install, to the only people it has anything to say to:
 * users with a real `~/.pi/agent` and something in it this app does not have.
 * Everyone else never sees it, and never learns it exists.
 *
 * ## Why a dialog and not a silent copy
 *
 * The silent option was considered and rejected (decision one, option A): one
 * of the five items is the user's API keys, and copying those into this app's
 * vault is a consent question rather than a technical one. Option C — leave it
 * in settings and wait — is what H/19 shipped, and the point-check proved
 * nobody walks there. So: ask once, default everything on, one button.
 *
 * ## Why it can be dismissed forever
 *
 * Dismissing sets the same flag as running it. A dialog that comes back every
 * launch is a dialog people learn to click through without reading, which
 * would defeat the consent argument that put it here in the first place. The
 * settings pane keeps the door open for anyone who changes their mind, and P0's
 * error copy points at that pane when a stale session actually fails.
 */

import type {
  MigrationItem,
  MigrationItemKind,
  MigrationOutcome,
  MigrationPlan,
} from '@shared/agentMigration';
import { ArrowRightLeft, Check, KeyRound, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { STORAGE_KEYS } from '../../App/storage';
import {
  defaultMigrationSelection,
  itemWouldCopy,
  migrationKindLabel,
  selectionCarriesSecrets,
  shouldPromptMigration,
} from './agentMigrationPrompt';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function markAsked(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.AGENT_MIGRATION_PROMPTED, 'true');
  } catch {
    // A storage failure must not take the dialog down with it. Worst case the
    // offer is made again next launch, which is annoying, not harmful.
  }
}

function alreadyAsked(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.AGENT_MIGRATION_PROMPTED) !== null;
  } catch {
    // Unreadable storage reads as "asked": showing the dialog to someone who
    // already answered is the worse of the two failures.
    return true;
  }
}

export function AgentMigrationPrompt() {
  const { t } = useI18n();
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<MigrationItemKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<MigrationOutcome[] | null>(null);

  useEffect(() => {
    // The inspection walks directories, so it is skipped entirely once the
    // question has been answered — which is every launch after the first for
    // everyone, and every launch for a user who never had `pi`.
    if (alreadyAsked()) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await window.electronAPI.agentMigration.inspect();
        if (cancelled) return;
        if (!shouldPromptMigration({ plan: next, asked: false })) return;
        setPlan(next);
        setSelected(new Set(defaultMigrationSelection(next)));
        setOpen(true);
      } catch {
        // An inspection that failed is not an offer. Stay silent and leave the
        // flag unset, so a transient failure does not cost the user the one
        // time we get to ask.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    markAsked();
    setOpen(false);
  }, []);

  const toggle = (kind: MigrationItemKind, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const run = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.agentMigration.apply({
        kinds: [...selected],
        // Never overwrite from this dialog. The user has not seen a single file
        // name yet — they opened the app, not the settings pane — so there is
        // no informed answer to a collision here. The pane, which does show the
        // names, is where `overwrite` belongs.
        onConflict: 'skip',
      });
      // Written only on success: a failed apply leaves the offer standing.
      markAsked();
      setOutcomes(result.outcomes);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return null;

  const secrets = selectionCarriesSecrets([...selected]);
  const done = outcomes !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing by backdrop or Escape is an answer too — the same one the
        // "Not now" button gives. Treating it as "ask me again" would bring the
        // dialog back on the next launch for a user who just said no.
        if (!next) dismiss();
        else setOpen(true);
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('Bring over your personal Pi setup')}</DialogTitle>
          <DialogDescription>
            {done
              ? t('Copy finished')
              : t(
                  'Found an existing Pi setup on this machine. Copying it over takes a moment and changes nothing in your own directory.'
                )}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <PromptReport outcomes={outcomes} />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-1 text-meta text-muted-foreground sm:grid-cols-[80px_1fr] sm:gap-3">
              <span>{t('Copy from')}</span>
              <Ident className="min-w-0 break-all">{plan.sourceDir}</Ident>
              <span>{t('Copy to')}</span>
              <Ident className="min-w-0 break-all">{plan.targetDir}</Ident>
            </div>

            <ul className="divide-y rounded-md border">
              {plan.items.map((item) => (
                <PromptRow
                  key={item.kind}
                  item={item}
                  checked={selected.has(item.kind)}
                  disabled={busy}
                  onCheckedChange={(checked) => toggle(item.kind, checked)}
                />
              ))}
            </ul>

            {/* The consent sentence. Shown only while the item carrying secrets
                is actually ticked, so unticking it visibly removes the warning
                as well as the copy. */}
            {secrets && (
              <p className="flex gap-2 rounded-sm border border-warning/30 bg-warning/8 p-3 text-meta text-muted-foreground">
                <KeyRound className="h-4 w-4 shrink-0 text-warning" />
                <span>
                  {t(
                    'Your AI services include API keys. Copying them stores a copy in this app’s own credential vault. Uncheck that row to leave them out.'
                  )}
                </span>
              </p>
            )}

            <p className="text-meta text-muted-foreground">
              {t('Anything this app already has is left alone. You can do this later in Settings.')}
            </p>
          </div>
        )}

        {error && (
          <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            {error}
          </p>
        )}

        <DialogFooter variant="bare">
          {done ? (
            <Button onClick={() => setOpen(false)}>{t('Done')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={dismiss} disabled={busy}>
                {t('Not now')}
              </Button>
              <Button onClick={() => void run()} disabled={busy || selected.size === 0}>
                <ArrowRightLeft className="h-4 w-4" />
                {busy ? t('Copying...') : t('Copy selected')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PromptRow({
  item,
  checked,
  disabled,
  onCheckedChange,
}: {
  item: MigrationItem;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  const label = t(migrationKindLabel(item.kind));
  return (
    <li className="flex items-center gap-3 p-2.5">
      <Checkbox
        checked={checked}
        disabled={disabled || !itemWouldCopy(item)}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={label}
      />
      <span className="min-w-0 flex-1 truncate text-ui font-medium">{label}</span>
      {/* The count is what lets someone decide about a huge history directory
          without opening it — the one thing option B was chosen to preserve. */}
      <Badge variant="secondary" className="shrink-0">{`${item.total}`}</Badge>
      {!itemWouldCopy(item) && (
        <Badge variant="success" className="shrink-0">
          {t('Already here')}
        </Badge>
      )}
    </li>
  );
}

function PromptReport({ outcomes }: { outcomes: MigrationOutcome[] }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-ui font-medium">
        <Check className="h-4 w-4 text-success" />
        {t('Copy finished')}
      </div>
      {outcomes.map((outcome) => (
        <div key={outcome.kind} className="space-y-1">
          <p className="text-meta text-muted-foreground">
            {`${t(migrationKindLabel(outcome.kind))}: `}
            {t('{{copied}} copied, {{replaced}} replaced, {{skipped}} left alone', {
              copied: outcome.copied,
              replaced: outcome.overwritten,
              skipped: outcome.skipped,
            })}
          </p>
          {/* A shorter list than promised has to say why — a keyring that would
              not unlock reports here, not in a log nobody reads. */}
          {outcome.failed.map((failure) => (
            <p key={failure.name} className="text-meta text-destructive">
              {`${failure.name}: ${failure.error}`}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
