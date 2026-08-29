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
        <p className="text-ui text-muted-foreground">{error ?? '读取中…'}</p>
      </div>
    );
  }

  const controls = deriveSurfaceControls(snapshot);
  const tables = deriveRuleTables(snapshot);
  const scopes = deriveScopeRows(snapshot.scopes);
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
            Yolo 模式已开启，权限闸整体失效——包括对 <Ident>sudo</Ident>、<Ident>bash -c</Ident>{' '}
            这类命令的兜底限制。本面板不提供开关；请到
            {originLabel(snapshot.effective.yoloMode.origin)}对应的配置文件里关掉它。
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
        <SectionTitle
          title="各类操作的默认处理"
          hint="agent 每次调用工具时，闸门按这里的设置决定是直接放行、弹窗询问，还是直接拒绝。"
        />
        <div className="rounded-md border bg-card divide-y">
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
        <SectionTitle title="审批日志" hint="记录每一次放行与拒绝，供事后追查。" />
        <div className="flex items-center justify-between gap-4 rounded-md border bg-card p-4">
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium">记录审批结果</p>
            <p className="text-meta text-muted-foreground">
              写入 <Ident>{'<agentDir>/extensions/pi-permission-system/logs'}</Ident>。
              {snapshot.effective.permissionReviewLog.origin
                ? `当前由「${originLabel(snapshot.effective.permissionReviewLog.origin)}」设定。`
                : '当前是插件自带的默认值。'}
            </p>
          </div>
          <Switch
            checked={snapshot.effective.permissionReviewLog.value}
            disabled={!editable}
            onCheckedChange={(checked) => void apply({ permissionReviewLog: checked })}
            aria-label="记录审批结果"
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle
          title="配置来源"
          hint="越靠下的层级优先级越高。同一条设置由最后一个写它的层决定。"
        />
        <div className="rounded-md border bg-card divide-y">
          {scopes.map((scope) => (
            <ScopeRowView key={scope.id} scope={scope} />
          ))}
        </div>
        {snapshot.editable && (
          <Button variant="outline" disabled={busy} onClick={() => void reset()}>
            <RotateCcw className="h-4 w-4" />
            清空我的设置，恢复出厂策略
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
              <span className="min-w-0 flex-1">确认取消这一层保护？</span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? `“${pending.control.label}”将不再询问，agent 可以直接执行。${pending.control.description}`
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
              仍然直接允许
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function PanelHeading() {
  return (
    <div>
      <h3 className="text-title font-semibold tracking-[-0.01em]">权限策略</h3>
      <p className="text-ui text-muted-foreground">
        Pi 后端每次调用工具前都会先过这道闸。这里能看到它当前的判断依据，并修改属于你的那一层。
      </p>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h4 className="text-ui font-semibold">{title}</h4>
      <p className="text-meta text-muted-foreground">{hint}</p>
    </div>
  );
}

const ACTION_LABELS: Record<PermissionAction, string> = {
  allow: '直接允许',
  ask: '每次询问',
  deny: '直接拒绝',
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
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-ui font-medium">{control.label}</span>
          <OriginBadge origin={control.origin} overridden={control.overridden} />
        </div>
        <p className="text-meta text-muted-foreground">{control.description}</p>
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
        <SelectTrigger className="w-40 shrink-0" aria-label={control.label}>
          <SelectValue>
            <span
              className={
                control.value === 'allow' && control.dangerous ? 'text-destructive' : undefined
              }
            >
              {control.overridden
                ? ACTION_LABELS[control.value]
                : `跟随默认（${ACTION_LABELS[control.value]}）`}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={INHERIT_OPTION}>跟随默认</SelectItem>
          <SelectItem value="allow">
            <span className={control.dangerous ? 'text-destructive' : undefined}>
              {ACTION_LABELS.allow}
            </span>
          </SelectItem>
          <SelectItem value="ask">{ACTION_LABELS.ask}</SelectItem>
          <SelectItem value="deny">{ACTION_LABELS.deny}</SelectItem>
        </SelectPopup>
      </Select>
    </div>
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
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<PermissionAction>('deny');
  const validation = pattern ? validateNewRule(table.rules, pattern) : { ok: false };

  const add = () => {
    if (!validation.ok) return;
    onApply(rulePatch(table.surface, pattern, action));
    setPattern('');
  };

  return (
    <section className="space-y-3">
      <SectionTitle title={table.label} hint={table.description} />
      <div className="rounded-md border bg-card">
        {table.rules.length === 0 ? (
          <p className="p-4 text-meta text-muted-foreground">这一类还没有任何规则。</p>
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
          <div className="flex gap-2">
            <Input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
              placeholder={table.surface === 'bash' ? '例如 npm test *' : '例如 ~/secrets/*'}
              aria-label={`新增${table.label}规则`}
            />
            <Select
              value={action}
              onValueChange={(next) => {
                const choice = readActionChoice(next);
                if (choice) setAction(choice);
              }}
            >
              <SelectTrigger className="w-32 shrink-0" aria-label="新规则的处理方式">
                <SelectValue>{ACTION_LABELS[action]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="allow">{ACTION_LABELS.allow}</SelectItem>
                <SelectItem value="ask">{ACTION_LABELS.ask}</SelectItem>
                <SelectItem value="deny">{ACTION_LABELS.deny}</SelectItem>
              </SelectPopup>
            </Select>
            <Button variant="outline" disabled={!validation.ok} onClick={add}>
              <Plus className="h-4 w-4" />
              添加
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
  return (
    <li className="flex items-center gap-3 p-3">
      <span className="w-6 shrink-0 text-meta tabular-nums text-muted-foreground">{index + 1}</span>
      <Ident className="min-w-0 flex-1 truncate">{rule.pattern}</Ident>
      {rule.repositioned && (
        <Badge variant="warning" size="sm" title="这条规则被你改过，但仍留在原来的位置上">
          位置未变
        </Badge>
      )}
      <Badge
        variant={rule.action === 'deny' ? 'error' : rule.action === 'allow' ? 'success' : 'outline'}
      >
        {ACTION_LABELS[rule.action]}
      </Badge>
      <OriginBadge origin={rule.origin} overridden={false} />
      {deletable ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={`删除规则 ${rule.pattern}`}
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
  bundled: '随包默认',
  global: '我的设置',
  project: '项目配置',
};

function originLabel(origin: PolicyScopeId | undefined): string {
  return origin ? ORIGIN_LABELS[origin] : '插件自带默认';
}

function OriginBadge({
  origin,
  overridden,
}: {
  origin: PolicyScopeId | undefined;
  overridden: boolean;
}) {
  return (
    <Badge variant={overridden ? 'info' : 'outline'} size="sm">
      {originLabel(origin)}
    </Badge>
  );
}

const SCOPE_STATUS: Record<
  ScopeRow['status'],
  { label: string; variant: 'success' | 'outline' | 'warning' | 'error' }
> = {
  active: { label: '生效中', variant: 'success' },
  missing: { label: '未创建', variant: 'outline' },
  ignored: { label: '被忽略', variant: 'warning' },
  invalid: { label: '无法解析', variant: 'error' },
};

function ScopeRowView({ scope }: { scope: ScopeRow }) {
  const status = SCOPE_STATUS[scope.status];
  return (
    <div className="flex items-start gap-3 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-ui font-medium">{scope.label}</span>
          <Badge variant={status.variant} size="sm">
            {status.label}
          </Badge>
          {scope.writable && (
            <Badge variant="info" size="sm">
              本面板写这里
            </Badge>
          )}
        </div>
        <p className="text-meta text-muted-foreground">{scope.summary}</p>
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
        aria-label={`在文件管理器中显示 ${scope.label}`}
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
    </div>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
