/**
 * H/19 U2 — the "bring your own Pi setup over" section.
 *
 * Deliberately explicit rather than automatic. Every item is named, every
 * collision is named, and the default answer to a collision is to keep what is
 * already here. The reason is that the destination can hold files this app
 * wrote or the user edited after an earlier run: a silent copy would be a
 * silent overwrite.
 *
 * The whole section disappears for a user with no `~/.pi/agent`, which is most
 * new users — there is nothing to say to them.
 */

import type {
  MigrationItem,
  MigrationItemKind,
  MigrationOutcome,
  MigrationPlan,
} from '@shared/agentMigration';
import { AlertTriangle, ArrowRightLeft, Check, FolderInput } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Ident } from '@/components/ui/ident';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
// H/21 P1: label and "would this copy anything" now live with the first-launch
// prompt's rules, so the dialog and this pane cannot drift apart on either.
import { defaultMigrationSelection, migrationKindLabel } from './agentMigrationPrompt';
import { SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AgentMigrationSettings() {
  const { t } = useI18n();
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [selected, setSelected] = useState<Set<MigrationItemKind>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<MigrationOutcome[] | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.agentMigration.inspect();
      setPlan(next);
      // Pre-select everything that would actually copy something. A user who
      // opens this page and presses the button gets the obvious outcome; the
      // checkboxes are there to take things OUT.
      setSelected(new Set(defaultMigrationSelection(next)));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
        onConflict: overwrite ? 'overwrite' : 'skip',
      });
      setOutcomes(result.outcomes);
      setPlan(result.plan);
      setSelected(new Set());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  // Nothing there to bring over: say nothing at all.
  if (!plan || !plan.sourceExists || plan.items.length === 0) return null;

  return (
    <div className="space-y-4">
      <SettingsSectionBlock
        title={t('Bring over your personal Pi setup')}
        description={t(
          'Copies from your own Pi directory into this app. Your files stay where they are — nothing is moved or changed there.'
        )}
      />

      <div className="grid gap-1 text-meta text-muted-foreground sm:grid-cols-[80px_1fr] sm:gap-3">
        {/* Not the bare 'From'/'To' keys — those already exist for the file
            move dialog, where they translate as 从/到. Reusing them would have
            silently overwritten that pair. */}
        <span>{t('Copy from')}</span>
        <Ident className="min-w-0 break-all">{plan.sourceDir}</Ident>
        <span>{t('Copy to')}</span>
        <Ident className="min-w-0 break-all">{plan.targetDir}</Ident>
      </div>

      <ul className="divide-y rounded-md border">
        {plan.items.map((item) => (
          <MigrationRow
            key={item.kind}
            item={item}
            checked={selected.has(item.kind)}
            disabled={busy}
            onCheckedChange={(checked) => toggle(item.kind, checked)}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-w-0 items-center gap-2 text-ui">
          <Switch checked={overwrite} onCheckedChange={setOverwrite} disabled={busy} />
          <span className="min-w-0">
            {t('Replace items this app already has')}
            <span className="ml-2 text-meta text-muted-foreground">
              {t('Off: anything already here is left alone.')}
            </span>
          </span>
        </label>
        <Button onClick={() => void run()} disabled={busy || selected.size === 0}>
          <ArrowRightLeft className="h-4 w-4" />
          {busy ? t('Copying...') : t('Copy selected')}
        </Button>
      </div>

      {outcomes && <MigrationReport outcomes={outcomes} />}

      {error && (
        <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

function MigrationRow({
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
  const pending = item.total - item.conflicts - item.blocked;
  return (
    <li className="flex items-start gap-3 p-3">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={t(migrationKindLabel(item.kind))}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-ui font-medium">{t(migrationKindLabel(item.kind))}</span>
          <Badge variant="secondary">{`${item.total}`}</Badge>
          {pending === 0 && <Badge variant="success">{t('Already here')}</Badge>}
        </div>
        <p className="truncate text-meta text-muted-foreground">{item.sourcePath}</p>
        {/* Names, not just counts: "3 conflicts" is not something a user can
            decide about, and the decision is the point of this control. */}
        <p className="text-meta text-muted-foreground">
          {item.entries.map((entry) => entry.name).join(', ')}
          {item.total > item.entries.length && ' …'}
        </p>
        {item.conflicts > 0 && (
          <p className="text-meta text-warning">
            {t('{{count}} already exist here and will be kept unless you allow replacing.', {
              count: item.conflicts,
            })}
          </p>
        )}
        {item.entries
          .filter((entry) => entry.blocked)
          .map((entry) => (
            <p key={entry.name} className="text-meta text-destructive">
              {`${entry.name}: ${entry.blocked}`}
            </p>
          ))}
      </div>
    </li>
  );
}

function MigrationReport({ outcomes }: { outcomes: MigrationOutcome[] }) {
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
            <FolderInput className="mr-1 inline h-3 w-3" />
            {`${t(migrationKindLabel(outcome.kind))}: `}
            {t('{{copied}} copied, {{replaced}} replaced, {{skipped}} left alone', {
              copied: outcome.copied,
              replaced: outcome.overwritten,
              skipped: outcome.skipped,
            })}
          </p>
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
