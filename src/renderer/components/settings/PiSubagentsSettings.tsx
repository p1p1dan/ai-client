/**
 * P5-2-5 / SA17 — managing the subagents a session can delegate to.
 *
 * The list is the whole catalog the runtime would load: the user's own
 * definitions first, then the four we ship that nothing shadows. Editing a
 * builtin writes a user document of the same name rather than touching what we
 * ship, which is why a builtin row offers "Customise" instead of "Edit".
 *
 * Decisions this component makes, all of them from the contract:
 *
 * - **A switch is optimistic, and rolls back.** The row flips immediately and
 *   the whole view is restored if the write fails, so a failed switch never
 *   leaves a row showing a state it did not reach.
 * - **A refresh never blanks the list.** A failed read keeps what is on screen
 *   and shows the error next to it; only a successful read can report "empty".
 * - **A save sends the whole definition.** The form carries `permission` even
 *   though it has no control for it yet, because the alternative is an edit
 *   that silently widens a delegate's approval gear.
 * - **Busy is per row.** One row saving must not disable the others: the list
 *   is where a user looks to find the row they want, and a page that freezes
 *   whole is one they have to wait out.
 */

import {
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_THINKING_LEVELS,
} from '@shared/subagentDefinition';
import { isPromptCacheTtl, PROMPT_CACHE_TTLS } from '@shared/types/promptCacheTtl';
import type {
  SubagentCatalogView,
  SubagentImportPreview,
  SubagentRow,
} from '@shared/types/subagentManagement';
import {
  Download,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';
import {
  adoptCatalog,
  describeImportResult,
  draftFromBuiltin,
  draftFromRow,
  emptySubagentDraft,
  filterSubagentRows,
  importableNames,
  importRowNotes,
  type SubagentDraft,
  saveRequestFromDraft,
  sortSubagentRows,
  subagentRowSummary,
  toggleImportSelection,
  validateSubagentDraft,
  withOptimisticEnabled,
} from './subagentManagementModel';

const UNSET = '__unset__';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * How long a DELEGATE's prompt cache prefix lives, which is a different
 * question from the main conversation's (that one is on the model-management
 * page).
 *
 * Five minutes by default: a delegate builds a prefix, spends a few turns on it
 * and is gone, and nothing reads that prefix again — so an hour of retention is
 * a write premium with no read to earn it back, once per delegate on a fan-out.
 * Raising it only pays when the same delegate is re-run against an unchanged
 * prompt, repeatedly.
 */
function SubagentPromptCacheTtlRow() {
  const { t } = useI18n();
  const subagentPromptCacheTtl = useSettingsStore((state) => state.subagentPromptCacheTtl);
  const setSubagentPromptCacheTtl = useSettingsStore((state) => state.setSubagentPromptCacheTtl);

  return (
    <SettingsRow>
      <span className="text-ui">{t('Subagent prompt cache')}</span>
      <div className="min-w-0 space-y-2">
        <ToggleGroup
          value={[subagentPromptCacheTtl]}
          onValueChange={(value) => {
            const next = (value as string[])[0];
            if (isPromptCacheTtl(next)) setSubagentPromptCacheTtl(next);
          }}
        >
          {PROMPT_CACHE_TTLS.map((ttl) => (
            <ToggleGroupItem key={ttl} value={ttl}>
              {ttl === '1h' ? t('1 hour') : t('5 minutes')}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-meta text-muted-foreground">
          {t(
            'A delegate writes a prefix nothing reads again, so five minutes is usually the cheaper choice. Takes effect the next time a conversation starts its runtime.'
          )}
        </p>
      </div>
    </SettingsRow>
  );
}

export function PiSubagentsSettings() {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<SubagentCatalogView | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Which row is mid-write. Per row, so the rest of the list stays usable. */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [draft, setDraft] = useState<SubagentDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SubagentRow | null>(null);
  /** subagent-data-01: null until the user asks to look at the old directory. */
  const [importPreview, setImportPreview] = useState<SubagentImportPreview | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.piSubagents.list();
      // `adoptCatalog` is what keeps a loaded list on screen when a refresh
      // fails; here the read succeeded, so it simply takes the new one.
      setCatalog((previous) => adoptCatalog(previous, next));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => (catalog ? sortSubagentRows(filterSubagentRows(catalog.rows, query)) : []),
    [catalog, query]
  );
  const existingNames = useMemo(() => catalog?.rows.map((row) => row.name) ?? [], [catalog]);

  const toggleEnabled = async (row: SubagentRow, enabled: boolean) => {
    if (!catalog) return;
    const rollback = catalog;
    setCatalog(withOptimisticEnabled(catalog, row.name, enabled));
    setBusyRow(row.name);
    setError(null);
    try {
      setCatalog(await window.electronAPI.piSubagents.setEnabled(row.name, enabled));
    } catch (cause) {
      // Whole-view rollback: putting the previous view back cannot half-apply
      // the way patching one field could.
      setCatalog(rollback);
      setError(messageOf(cause));
    } finally {
      setBusyRow(null);
    }
  };

  const remove = async (row: SubagentRow) => {
    setBusyRow(row.name);
    setError(null);
    try {
      setCatalog(await window.electronAPI.piSubagents.remove(row.name));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyRow(null);
      setPendingDelete(null);
    }
  };

  const reveal = async (row?: SubagentRow) => {
    setError(null);
    try {
      await window.electronAPI.piSubagents.reveal(row?.name);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const problems = draft ? validateSubagentDraft(draft, existingNames) : [];

  const save = async () => {
    if (!draft || problems.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      setCatalog(await window.electronAPI.piSubagents.save(saveRequestFromDraft(draft)));
      setDraft(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  /**
   * subagent-data-01 — scan the legacy directory and show what would happen.
   *
   * Two steps on purpose, and the preview is the first one: migration is the
   * place where a delegate can arrive with a different tool set or a different
   * approval gear than the user set, and nothing complains afterwards because
   * it still works. The preview is where that is visible, and nothing is
   * written until the user ticks a row and presses the button.
   */
  const openImport = async () => {
    setError(null);
    setImportNote(null);
    setImportBusy(true);
    try {
      const preview = await window.electronAPI.piSubagents.importPreview();
      setImportPreview(preview);
      setImportSelected([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setImportBusy(false);
    }
  };

  const runImport = async () => {
    if (importSelected.length === 0) return;
    setImportBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.piSubagents.importApply(importSelected);
      setCatalog(result.catalog);
      setImportNote(describeImportResult(result));
      // Re-previewed rather than closed: what was imported now collides with
      // itself, and leaving the old list up would invite a second import of
      // the same document.
      setImportPreview(await window.electronAPI.piSubagents.importPreview());
      setImportSelected([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setImportBusy(false);
    }
  };

  const clearStale = async () => {
    setError(null);
    try {
      setCatalog(await window.electronAPI.piSubagents.clearStale());
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionBlock
        title={t('Subagents')}
        description={t(
          'Background delegates the model can start with Task. Each one runs on its own context and reports back when it finishes.'
        )}
      />

      <SubagentPromptCacheTtlRow />

      {error && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search by name, description or tool')}
            aria-label={t('Search subagents')}
          />
        </div>
        <Button variant="outline" onClick={() => void reveal()}>
          <FolderOpen className="h-4 w-4" />
          {t('Open subagents folder')}
        </Button>
        <Button variant="outline" disabled={importBusy} onClick={() => void openImport()}>
          <Download className="h-4 w-4" />
          {t('Import old definitions')}
        </Button>
        <Button onClick={() => setDraft(emptySubagentDraft())}>
          <Plus className="h-4 w-4" />
          {t('New subagent')}
        </Button>
      </div>

      {catalog === null ? (
        <p className="text-ui text-muted-foreground">{t('Loading subagents...')}</p>
      ) : (
        <>
          {catalog.staleDisabled.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3">
              <p className="min-w-0 text-meta text-muted-foreground">
                {t(
                  '{{count}} switched-off names no longer match any subagent — they were renamed or deleted.',
                  { count: catalog.staleDisabled.length }
                )}
              </p>
              <Button variant="outline" size="sm" onClick={() => void clearStale()}>
                <RotateCcw className="h-4 w-4" />
                {t('Clear them')}
              </Button>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="text-ui text-muted-foreground">
              {query ? t('No subagent matches that.') : t('No subagents yet.')}
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((row) => (
                <li key={row.name} className="flex items-start gap-3 p-3">
                  <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-ui font-medium">{row.name}</span>
                      {row.source === 'builtin' && (
                        <Badge variant="secondary">{t('Built in')}</Badge>
                      )}
                      {!row.enabled && <Badge variant="outline">{t('Switched off')}</Badge>}
                    </div>
                    <p className="text-meta text-muted-foreground">{row.description}</p>
                    <p className="text-meta text-muted-foreground">{subagentRowSummary(row)}</p>
                    {row.warnings?.map((warning) => (
                      <p key={warning} className="text-meta text-amber-600 dark:text-amber-500">
                        {warning}
                      </p>
                    ))}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={row.enabled}
                      disabled={busyRow === row.name}
                      onCheckedChange={(checked) => void toggleEnabled(row, checked)}
                      aria-label={t('Enable {{name}}', { name: row.name })}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyRow === row.name}
                      onClick={() =>
                        setDraft(
                          row.source === 'builtin' ? draftFromBuiltin(row) : draftFromRow(row)
                        )
                      }
                      aria-label={
                        row.source === 'builtin'
                          ? t('Customise {{name}}', { name: row.name })
                          : t('Edit {{name}}', { name: row.name })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {row.filePath && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void reveal(row)}
                        aria-label={t('Show {{name}} in folder', { name: row.name })}
                      >
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    )}
                    {row.source === 'user' && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busyRow === row.name}
                        onClick={() => setPendingDelete(row)}
                        aria-label={t('Delete {{name}}', { name: row.name })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {catalog.broken.length > 0 && (
            <section className="space-y-2 rounded-md border border-destructive/30 p-3">
              <h4 className="text-ui font-semibold text-destructive">
                {t('These documents do not load')}
              </h4>
              {catalog.broken.map((entry) => (
                <div key={entry.filePath} className="space-y-1">
                  <Ident className="min-w-0 break-all">{entry.filePath}</Ident>
                  <p className="text-meta text-destructive">{entry.errors.join('; ')}</p>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {importPreview && (
        <LegacyImportPanel
          preview={importPreview}
          selected={importSelected}
          busy={importBusy}
          note={importNote}
          onToggle={(name) =>
            setImportSelected(toggleImportSelection(importSelected, name, importPreview))
          }
          onClose={() => {
            setImportPreview(null);
            setImportNote(null);
          }}
          onImport={() => void runImport()}
        />
      )}

      {draft && (
        <SubagentEditor
          draft={draft}
          problems={problems}
          saving={saving}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void save()}
        />
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Delete {{name}}?', { name: pendingDelete?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This removes the definition file. Sessions already running keep the copy they started with.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button
              variant="destructive"
              disabled={busyRow !== null}
              onClick={() => pendingDelete && void remove(pendingDelete)}
            >
              {t('Delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * subagent-data-01 — the legacy directory, one row per document.
 *
 * A blocked row is shown and cannot be ticked: "why is my old fixer not here"
 * has to have an answer on screen, and the notes are that answer.
 */
function LegacyImportPanel({
  preview,
  selected,
  busy,
  note,
  onToggle,
  onClose,
  onImport,
}: {
  preview: SubagentImportPreview;
  selected: readonly string[];
  busy: boolean;
  note: string | null;
  onToggle: (name: string) => void;
  onClose: () => void;
  onImport: () => void;
}) {
  const { t } = useI18n();
  const importable = new Set(importableNames(preview));

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h4 className="text-ui font-semibold">{t('Import old definitions')}</h4>
          <p className="text-meta text-muted-foreground">
            {t(
              'These are the documents in your previous agents folder. Importing copies one into the subagents folder; the original file is left where it is.'
            )}
          </p>
          <Ident className="min-w-0 break-all">{preview.sourceDirectory}</Ident>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('Close')}
        </Button>
      </div>

      {note && <p className="text-meta text-muted-foreground">{note}</p>}

      {preview.rows.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          {t('Nothing to import — that folder has no definitions.')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {preview.rows.map((row) => (
            <li key={row.filePath} className="flex items-start gap-3 p-3">
              <Checkbox
                className="mt-0.5 shrink-0"
                checked={selected.includes(row.name)}
                disabled={busy || !importable.has(row.name)}
                onCheckedChange={() => onToggle(row.name)}
                aria-label={t('Import {{name}}', { name: row.name })}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ui font-medium">{row.name}</span>
                  {row.blocked && <Badge variant="outline">{t('Needs a decision')}</Badge>}
                  {row.collides && <Badge variant="secondary">{t('Name already used')}</Badge>}
                </div>
                <Ident className="min-w-0 break-all">{row.filePath}</Ident>
                {importRowNotes(row).map((line) => (
                  <p key={line} className="text-meta text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview.rows.length > 0 && (
        <div className="flex justify-end">
          <Button disabled={busy || selected.length === 0} onClick={onImport}>
            {busy ? t('Importing...') : t('Import {{count}} selected', { count: selected.length })}
          </Button>
        </div>
      )}
    </section>
  );
}

function SubagentEditor({
  draft,
  problems,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: SubagentDraft;
  problems: ReturnType<typeof validateSubagentDraft>;
  saving: boolean;
  onChange: (draft: SubagentDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const problemFor = (field: keyof SubagentDraft) =>
    problems.find((problem) => problem.field === field)?.message;

  return (
    <section className="space-y-4 rounded-md border p-4">
      <h4 className="text-ui font-semibold">
        {draft.previousName ? t('Edit {{name}}', { name: draft.previousName }) : t('New subagent')}
      </h4>

      <Field label={t('Name')} error={problemFor('name')}>
        <Input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="explorer"
        />
      </Field>

      <Field
        label={t('When to delegate here')}
        hint={t('The model reads this to choose. One line.')}
        error={problemFor('description')}
      >
        <Input
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </Field>

      <Field label={t('Tools')} error={problemFor('tools')}>
        <ToggleGroup
          multiple
          value={draft.tools}
          onValueChange={(value) => onChange({ ...draft, tools: value as string[] })}
          className="flex-wrap"
        >
          {SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => (
            <ToggleGroupItem key={tool} value={tool}>
              {tool}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      <Field
        label={t('Model')}
        hint={t('Leave empty to follow the session model. Written as provider/model.')}
        error={problemFor('modelPin')}
      >
        <div className="flex items-center gap-2">
          <Input
            value={draft.modelPin}
            onChange={(event) => onChange({ ...draft, modelPin: event.target.value })}
            placeholder="anthropic/claude-sonnet-5"
          />
          <Button
            variant="outline"
            disabled={!draft.modelPin}
            onClick={() => onChange({ ...draft, modelPin: '' })}
          >
            {t('Clear')}
          </Button>
        </div>
      </Field>

      <Field label={t('Thinking level')}>
        <Select
          value={draft.thinkingLevel || UNSET}
          onValueChange={(value) =>
            onChange({
              ...draft,
              thinkingLevel: value === UNSET ? '' : (value as SubagentDraft['thinkingLevel']),
            })
          }
        >
          <SelectTrigger className="w-64">
            <SelectValue>{draft.thinkingLevel || t('Follow the session')}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={UNSET}>{t('Follow the session')}</SelectItem>
            {SUBAGENT_THINKING_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      <Field
        label={t('Turn cap')}
        hint={t('Empty means unlimited. Up to {{max}}.', { max: MAX_SUBAGENT_MAX_TURNS })}
        error={problemFor('maxTurns')}
      >
        <div className="flex items-center gap-2">
          <Input
            className="w-32"
            value={draft.maxTurns}
            inputMode="numeric"
            onChange={(event) => onChange({ ...draft, maxTurns: event.target.value })}
            placeholder={t('unlimited')}
          />
          <Button
            variant="outline"
            disabled={!draft.maxTurns}
            onClick={() => onChange({ ...draft, maxTurns: '' })}
          >
            {t('Clear')}
          </Button>
        </div>
      </Field>

      <Field
        label={t('Instructions')}
        hint={t('The whole system prompt this subagent runs on.')}
        error={problemFor('prompt')}
      >
        <Textarea
          rows={10}
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
      </Field>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t('Cancel')}
        </Button>
        <Button onClick={onSave} disabled={saving || problems.length > 0}>
          {saving ? t('Saving...') : t('Save')}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-ui">{label}</Label>
      {children}
      {hint && !error && <p className="text-meta text-muted-foreground">{hint}</p>}
      {error && <p className="text-meta text-destructive">{error}</p>}
    </div>
  );
}
