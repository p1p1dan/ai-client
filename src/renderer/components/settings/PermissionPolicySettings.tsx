import type {
  EffectiveRule,
  PermissionAction,
  PermissionPolicySnapshot,
  PolicyPatch,
  PolicyScopeId,
} from '@shared/piPermissionPolicy';
import { AlertTriangle, FolderOpen, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  deriveRuleTables,
  deriveScopeRows,
  deriveSurfaceControls,
  INHERIT_OPTION,
  isDangerousChoice,
  type RuleTableView,
  readActionChoice,
  rulePatch,
  type ScopeRow,
  type SurfaceControl,
  surfacePatch,
  validateNewRule,
} from './permissionPolicyView';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * T08-c slice 2 — Settings → 权限策略.
 *
 * What the panel is for: the permission gate is the one part of this app whose
 * behaviour is otherwise invisible until it either interrupts you or fails to.
 * "Why did it ask about that" and "why did it NOT ask about that" both have the
 * same answer — a rule in one of three files — and until now there was nowhere
 * to read it.
 *
 * Two structural rules, both easy to "fix" back into bugs:
 *
 *  1. **Every control's value comes from the snapshot, never from local state.**
 *     That is what makes cancelling the dangerous-choice confirmation free: no
 *     local copy is left sitting on the value that was not stored, so the Select
 *     snaps back on its own.
 *  2. **A failed save keeps the old snapshot and shows the error.** The write
 *     rejects on the local route by design; swallowing that would leave a panel
 *     that reports a policy the user does not have.
 */
export function PermissionPolicySettings({ repoPath }: { repoPath?: string }) {
  const { t, locale } = useI18n();

  const [snapshot, setSnapshot] = useState<PermissionPolicySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The dangerous choice waiting for its second confirmation. Held here and
  // nowhere else — in particular not in the Select.
  const [pending, setPending] = useState<{
    control: SurfaceControl;
    next: PermissionAction;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await window.electronAPI.piPermissions.get({ repoPath }));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (patch: PolicyPatch) => {
      setBusy(true);
      setError(null);
      try {
        setSnapshot(await window.electronAPI.piPermissions.update({ patch, repoPath }));
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [repoPath]
  );

  const reset = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.electronAPI.piPermissions.reset({ repoPath }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, [repoPath]);

  const chooseSurface = (control: SurfaceControl, next: PermissionAction | null) => {
    if (isDangerousChoice(control, next)) {
      setPending({ control, next: 'allow' });
      return;
    }
    void apply(surfacePatch(control, next));
  };

  if (!snapshot) {
    return (
      <div className="space-y-6">
        <PanelHeading />
        <p className="text-ui text-muted-foreground">{error ?? t('Loading...')}</p>
      </div>
    );
  }

  const controls = deriveSurfaceControls(snapshot);
  const tables = deriveRuleTables(snapshot);
  const scopes = deriveScopeRows(snapshot.scopes, locale);
  const editable = snapshot.editable && !busy;

  return (
    <div className="space-y-6">
      <PanelHeading />

      {!snapshot.editable && (
        <div className="flex gap-3 rounded-md border border-info/30 bg-info/10 p-3 text-ui text-info">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{snapshot.readOnlyReason}</span>
        </div>
      )}

      {snapshot.effective.yoloMode.value && (
        <div className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {t(
              'Yolo mode disables all permission checks, including command restrictions. Disable it in the {{source}} configuration file.',
              { source: t(originLabel(snapshot.effective.yoloMode.origin)) }
            )}
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      <section className="space-y-3">
        <SettingsSectionBlock
          title={t('Default actions')}
          description={t(
            'Choose whether each tool call is allowed, requires approval, or is denied.'
          )}
        />
        <div className="border-t divide-y">
          {controls.map((control) => (
            <SurfaceRow
              key={`${control.surface}:${control.pattern ?? ''}`}
              control={control}
              editable={editable}
              onChoose={(next) => chooseSurface(control, next)}
            />
          ))}
        </div>
      </section>

      {tables.map((table) => (
        <RuleTableSection
          key={table.surface}
          table={table}
          editable={editable}
          onApply={(patch) => void apply(patch)}
        />
      ))}

      <section className="space-y-3">
        <SettingsSectionBlock
          title={t('Approval log')}
          description={t('Record allowed and denied actions for review.')}
        />
        <div className="flex items-center justify-between gap-4 border-t p-4">
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium">{t('Record approval results')}</p>
            <p className="text-meta text-muted-foreground">
              {t('Write to')}
              <Ident>{'<agentDir>/extensions/pi-permission-system/logs'}</Ident>。
              {snapshot.effective.permissionReviewLog.origin
                ? t('Currently set by {{source}}.', {
                    source: t(originLabel(snapshot.effective.permissionReviewLog.origin)),
                  })
                : t('Using the plugin default.')}
            </p>
          </div>
          <Switch
            checked={snapshot.effective.permissionReviewLog.value}
            disabled={!editable}
            onCheckedChange={(checked) => void apply({ permissionReviewLog: checked })}
            aria-label={t('Record approval results')}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SettingsSectionBlock
          title={t('Configuration sources')}
          description={t(
            'Lower entries take precedence. The last layer defining a setting determines its value.'
          )}
        />
        <div className="border-t divide-y">
          {scopes.map((scope) => (
            <ScopeRowView key={scope.id} scope={scope} />
          ))}
        </div>
        {snapshot.editable && (
          <Button variant="outline" disabled={busy} onClick={() => void reset()}>
            <RotateCcw className="h-4 w-4" />
            {t('Reset my permission overrides')}
          </Button>
        )}
      </section>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(nextOpen) => {
          // Escape, backdrop and Cancel are all the same answer, and it writes
          // nothing: the Select re-reads the snapshot and snaps back by itself.
          if (!nextOpen) setPending(null);
        }}
      >
        <AlertDialogPopup className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span className="min-w-0 flex-1">{t('Remove this protection?')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? t('{{action}} will run without approval. {{description}}', {
                    action: t(pending.control.label),
                    description: t(pending.control.description),
                  })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                if (pending) void apply(surfacePatch(pending.control, pending.next));
                setPending(null);
              }}
            >
              {t('Allow anyway')}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('Cancel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function PanelHeading() {
  const { t } = useI18n();

  return (
    <SettingsSectionBlock
      title={t('Permission policy')}
      description={t('Review the policy applied before Pi tool calls and edit your own overrides.')}
    />
  );
}

const ACTION_LABELS: Record<PermissionAction, string> = {
  allow: 'Allow',
  ask: 'Ask every time',
  deny: 'Deny',
};

function SurfaceRow({
  control,
  editable,
  onChoose,
}: {
  control: SurfaceControl;
  editable: boolean;
  onChoose: (next: PermissionAction | null) => void;
}) {
  const { t } = useI18n();

  return (
    <SettingsRow className="sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-ui font-medium">{t(control.label)}</span>
          <OriginBadge origin={control.origin} overridden={control.overridden} />
        </div>
        <p className="text-meta text-muted-foreground">{t(control.description)}</p>
      </div>
      <Select
        value={control.overridden ? control.value : INHERIT_OPTION}
        disabled={!editable}
        onValueChange={(next) => {
          // Strict: an unrecognized value does nothing. See `readActionChoice`.
          const choice = readActionChoice(next);
          if (choice !== undefined) onChoose(choice);
        }}
      >
        <SelectTrigger className="w-40 shrink-0" aria-label={t(control.label)}>
          <SelectValue>
            <span
              className={
                control.value === 'allow' && control.dangerous ? 'text-destructive' : undefined
              }
            >
              {control.overridden
                ? t(ACTION_LABELS[control.value])
                : t('Inherit default ({{action}})', { action: t(ACTION_LABELS[control.value]) })}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={INHERIT_OPTION}>{t('Inherit default')}</SelectItem>
          <SelectItem value="allow">
            <span className={control.dangerous ? 'text-destructive' : undefined}>
              {t(ACTION_LABELS.allow)}
            </span>
          </SelectItem>
          <SelectItem value="ask">{t(ACTION_LABELS.ask)}</SelectItem>
          <SelectItem value="deny">{t(ACTION_LABELS.deny)}</SelectItem>
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
}

function RuleTableSection({
  table,
  editable,
  onApply,
}: {
  table: RuleTableView;
  editable: boolean;
  onApply: (patch: PolicyPatch) => void;
}) {
  const { t, locale } = useI18n();

  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<PermissionAction>('deny');
  const validation = pattern ? validateNewRule(table.rules, pattern, locale) : { ok: false };

  const add = () => {
    if (!validation.ok) return;
    onApply(rulePatch(table.surface, pattern, action));
    setPattern('');
  };

  return (
    <section className="space-y-3">
      <SettingsSectionBlock title={t(table.label)} description={t(table.description)} />
      <div className="border-t">
        {table.rules.length === 0 ? (
          <p className="p-4 text-meta text-muted-foreground">{t('No rules in this category.')}</p>
        ) : (
          <ol className="divide-y">
            {table.rules.map((rule, index) => (
              <RuleRow
                key={rule.pattern}
                rule={rule}
                index={index}
                deletable={editable && table.editablePatterns.includes(rule.pattern)}
                onDelete={() => onApply(rulePatch(table.surface, rule.pattern, null))}
              />
            ))}
          </ol>
        )}
      </div>

      {editable && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
              placeholder={table.surface === 'bash' ? t('e.g. npm test *') : t('e.g. ~/secrets/*')}
              aria-label={t('Add a {{category}} rule', { category: t(table.label) })}
            />
            <Select
              value={action}
              onValueChange={(next) => {
                const choice = readActionChoice(next);
                if (choice) setAction(choice);
              }}
            >
              <SelectTrigger className="w-32 shrink-0" aria-label={t('Action for the new rule')}>
                <SelectValue>{t(ACTION_LABELS[action])}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="allow">{t(ACTION_LABELS.allow)}</SelectItem>
                <SelectItem value="ask">{t(ACTION_LABELS.ask)}</SelectItem>
                <SelectItem value="deny">{t(ACTION_LABELS.deny)}</SelectItem>
              </SelectPopup>
            </Select>
            <Button variant="outline" disabled={!validation.ok} onClick={add}>
              <Plus className="h-4 w-4" />
              {t('Add')}
            </Button>
          </div>
          {validation.error && (
            <p role="alert" className="text-meta text-destructive">
              {validation.error}
            </p>
          )}
          {validation.warning && <p className="text-meta text-warning">{validation.warning}</p>}
        </div>
      )}
    </section>
  );
}

function RuleRow({
  rule,
  index,
  deletable,
  onDelete,
}: {
  rule: EffectiveRule;
  index: number;
  deletable: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();

  return (
    <li className="flex items-center gap-3 p-3">
      <span className="w-6 shrink-0 text-meta tabular-nums text-muted-foreground">{index + 1}</span>
      <Ident className="min-w-0 flex-1 truncate">{rule.pattern}</Ident>
      {rule.repositioned && (
        <Badge
          variant="warning"
          size="sm"
          title={t('This rule was changed but retains its original position')}
        >
          {t('Position unchanged')}
        </Badge>
      )}
      <Badge
        variant={rule.action === 'deny' ? 'error' : rule.action === 'allow' ? 'success' : 'outline'}
      >
        {t(ACTION_LABELS[rule.action])}
      </Badge>
      <OriginBadge origin={rule.origin} overridden={false} />
      {deletable ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={t('Delete rule {{pattern}}', { pattern: rule.pattern })}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : (
        <span className="w-8 shrink-0" />
      )}
    </li>
  );
}

const ORIGIN_LABELS: Record<PolicyScopeId, string> = {
  bundled: 'Bundled defaults',
  global: 'My settings',
  project: 'Project configuration',
};

function originLabel(origin: PolicyScopeId | undefined): string {
  return origin ? ORIGIN_LABELS[origin] : 'Plugin defaults';
}

function OriginBadge({
  origin,
  overridden,
}: {
  origin: PolicyScopeId | undefined;
  overridden: boolean;
}) {
  const { t } = useI18n();

  return (
    <Badge variant={overridden ? 'info' : 'outline'} size="sm">
      {t(originLabel(origin))}
    </Badge>
  );
}

const SCOPE_STATUS: Record<
  ScopeRow['status'],
  { label: string; variant: 'success' | 'outline' | 'warning' | 'error' }
> = {
  active: { label: 'Active', variant: 'success' },
  missing: { label: 'Not created', variant: 'outline' },
  ignored: { label: 'Ignored', variant: 'warning' },
  invalid: { label: 'Invalid', variant: 'error' },
};

function ScopeRowView({ scope }: { scope: ScopeRow }) {
  const { t } = useI18n();

  const status = SCOPE_STATUS[scope.status];
  return (
    <div className="flex items-start gap-3 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-ui font-medium">{t(scope.label)}</span>
          <Badge variant={status.variant} size="sm">
            {t(status.label)}
          </Badge>
          {scope.writable && (
            <Badge variant="info" size="sm">
              {t('Changes are saved here')}
            </Badge>
          )}
        </div>
        <p className="text-meta text-muted-foreground">{t(scope.summary)}</p>
        <p className="break-all text-meta text-muted-foreground">
          <Ident>{scope.path}</Ident>
        </p>
        {scope.detail && <p className="text-meta text-warning">{scope.detail}</p>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void window.electronAPI.piPermissions.reveal(scope.path)}
        aria-label={t('Reveal {{scope}} in file manager', { scope: t(scope.label) })}
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
    </div>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
