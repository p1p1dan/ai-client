import type { Translate } from '@shared/i18n';
import { ShieldQuestion } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useState } from 'react';
import { useHomeTarget } from '@/components/chat/useHomeTarget';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  deriveHomeRecentRows,
  groupHomeRows,
  HOME_AREA_CLASS,
  HOME_AUX_ROW_CLASS,
  HOME_BODY_CLASS,
  HOME_BOTTOM_SPACER_CLASS,
  HOME_COLUMN_CLASS,
  HOME_GROUP_LABEL_CLASS,
  HOME_RECENT_HEADING_CLASS,
  HOME_RECENT_LIMIT,
  HOME_RECENT_SECTION_CLASS,
  HOME_ROW_CLASS,
  HOME_SUBLINE_CLASS,
  HOME_TITLE_CLASS,
  HOME_TITLE_EMPHASIS_CLASS,
  HOME_TOP_SPACER_CLASS,
  type HomeDayGroup,
  limitHomeRows,
  nextHomeRowsShown,
} from './homeViewModel';
import {
  formatRelativeAge,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  type SidebarSessionRow,
  sidebarFolderNameForDisplay,
  sidebarRowForDisplay,
  sidebarRowPlace,
  sidebarRowTooltip,
  sidebarRowWhere,
  splitBranchSuffix,
} from './sidebarTree';
import { useActivateSession } from './useActivateSession';

/** The product name the title is built around (`productName: PiLab Ai`). */
const HOME_BRAND = 'PiLab';

/** Splits a translated sentence around an interpolated part, to style it apart. */
const SPLIT_MARK = '\u0000';

/** 今天 / 昨天 / 更早 — literal keys, so the catalog scan sees them. */
function dayGroupLabel(group: HomeDayGroup, t: Translate): string {
  if (group === 'today') return t('Today');
  if (group === 'yesterday') return t('Yesterday');
  return t('Earlier');
}

/**
 * dsh-rebase decision 174 (GitHub issue #6, second wave; user rulings
 * 2026-10-10): the home page — the middle column while no conversation is
 * open. Three things only:
 *
 * - the title 「在 <工作区> 与 PiLab 一起进行创造吧」, naming the repository
 *   the composer's work bar has picked (it changes with the pick);
 * - 「最近对话」: every conversation, five rows and 「查看更多（N）」;
 * - the composer — which is NOT here: `ChatWorkspace` renders the one composer
 *   instance under this view, exactly where a conversation docks it, so the
 *   first send moves nothing.
 *
 * The title's centre sits at the golden section of the room above the
 * composer, in pure CSS (`homeViewModel.ts`'s layout classes). The prototype
 * is the acceptance bar: `docs/plantree/plans/dsh-rebase/evidence/
 * sidebar-regions-2026-10/prototype.html`, v4.
 */
export function HomeView() {
  const { t } = useI18n();
  const { target } = useHomeTarget();
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const rows = useMemo(
    () => deriveHomeRecentRows({ sessions, workspaces }),
    [sessions, workspaces]
  );

  return (
    <div className={HOME_AREA_CLASS} data-home-view="">
      <ScrollArea scrollFade="bottom">
        <div className={HOME_COLUMN_CLASS}>
          <div aria-hidden className={HOME_TOP_SPACER_CLASS} />
          <div className={HOME_BODY_CLASS}>
            <div className="text-center">
              <h1 className={HOME_TITLE_CLASS} data-home-title="">
                <HomeTitle repositoryName={target.repositoryName} />
              </h1>
              {target.workspace === null && (
                <p className={HOME_SUBLINE_CLASS} data-home-subline="">
                  {target.hasRepositories ? (
                    t(
                      'This chat is not bound to a repository; it runs in a private temporary folder.'
                    )
                  ) : (
                    // Two deliberate lines: CJK has no word boundaries, and a
                    // free wrap at `max-w-md` breaks mid-phrase (「在下 / 方工作栏」).
                    <>
                      {t('No repository added yet; this chat runs in a private temporary folder.')}
                      <br />
                      {t('You can add a repository from the bar below.')}
                    </>
                  )}
                </p>
              )}
            </div>
            {rows.length > 0 && <HomeRecentList rows={rows} />}
          </div>
          <div aria-hidden className={HOME_BOTTOM_SPACER_CLASS} />
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * 「在 <仓库> 与 PiLab 一起进行创造吧」 with the repository emphasised — or,
 * with no repository, 「与 PiLab 一起进行创造吧」 with PiLab emphasised. The
 * translated sentence is split around the emphasised part, so each language
 * keeps its own word order.
 */
function HomeTitle({ repositoryName }: { repositoryName: string | null }) {
  const { t } = useI18n();
  if (repositoryName !== null) {
    const [before, after] = t('Create with PiLab in {{workspace}}', {
      workspace: SPLIT_MARK,
    }).split(SPLIT_MARK);
    return (
      <>
        {before}
        <span className={HOME_TITLE_EMPHASIS_CLASS} title={repositoryName} data-home-workspace="">
          {repositoryName}
        </span>
        {after}
      </>
    );
  }
  const sentence = t('Create with PiLab');
  const at = sentence.indexOf(HOME_BRAND);
  if (at < 0) return <>{sentence}</>;
  return (
    <>
      {sentence.slice(0, at)}
      <span className={HOME_TITLE_EMPHASIS_CLASS}>{HOME_BRAND}</span>
      {sentence.slice(at + HOME_BRAND.length)}
    </>
  );
}

function HomeRecentList({ rows }: { rows: readonly SidebarSessionRow[] }) {
  const { t, locale } = useI18n();
  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const hostBoundSessionIds = useChatSessionsStore((state) => state.hostBoundSessionIds);
  const unreadSessionIds = useChatSessionsStore((state) => state.unreadSessionIds);
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  const activateSession = useActivateSession();
  // Five until 「查看更多」; memory only, like the sidebar's 「查看更多」.
  const [shown, setShown] = useState(HOME_RECENT_LIMIT);

  // Coarse minute tick, as in the sidebar: nothing else re-renders an idle
  // home page, so without it the age column freezes.
  const [, bumpClock] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(bumpClock, 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace] as const)),
    [workspaces]
  );
  const folderNameByProjectId = useMemo(
    () =>
      new Map(
        projects.map(
          (project) =>
            [project.id, sidebarFolderNameForDisplay(project.id, project.name, t)] as const
        )
      ),
    [projects, t]
  );
  const pendingApprovalCountBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const request of pendingPermissions) {
      if (!request.sessionId) continue;
      counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [pendingPermissions]);

  const limited = limitHomeRows(rows, shown);
  const groups = groupHomeRows(limited.rows, limited.collapsible, now);

  return (
    <section className={HOME_RECENT_SECTION_CLASS} aria-labelledby="home-recent-heading">
      <div className="flex h-7 items-center px-2">
        <h2 id="home-recent-heading" className={HOME_RECENT_HEADING_CLASS}>
          {t('Recent conversations')}
        </h2>
      </div>
      <div className="mt-0.5 space-y-0.5">
        {groups.map((group, index) => (
          <div key={group.group ?? 'all'} className="space-y-0.5">
            {group.group !== null && (
              <div
                className={cn(HOME_GROUP_LABEL_CLASS, index > 0 && 'mt-3')}
                data-home-group={group.group}
              >
                {dayGroupLabel(group.group, t)}
              </div>
            )}
            {group.rows.map((row) => {
              const place = sidebarRowPlace(row, workspaceById, folderNameByProjectId);
              return (
                <HomeRow
                  key={row.sessionId}
                  row={row}
                  where={sidebarRowWhere(place, t)}
                  tooltip={sidebarRowTooltip({
                    title: sidebarRowForDisplay(row, t).title,
                    place,
                    updatedAt: row.updatedAt,
                    locale,
                    t,
                  })}
                  now={now}
                  started={hostBoundSessionIds.includes(row.sessionId)}
                  unread={unreadSessionIds.includes(row.sessionId)}
                  pendingApprovalCount={pendingApprovalCountBySession.get(row.sessionId) ?? 0}
                  onOpen={() => activateSession(row.sessionId)}
                />
              );
            })}
          </div>
        ))}
        {limited.hiddenCount > 0 && (
          <HomeAuxRow onClick={() => setShown((current) => nextHomeRowsShown(current))}>
            {t('View more ({{count}})', { count: limited.hiddenCount })}
          </HomeAuxRow>
        )}
        {limited.collapsible && (
          <HomeAuxRow onClick={() => setShown(HOME_RECENT_LIMIT)}>{t('Show less')}</HomeAuxRow>
        )}
      </div>
    </section>
  );
}

/**
 * One conversation: the status slot, the title, the alert badges, 「文件夹 ·
 * 分支」 and the age — the sidebar row's parts (`LeftNav`'s `SessionRow`) at
 * the home page's size: 36px, title 15px in the body ink. Clicking opens it the
 * way the sidebar does (`useActivateSession`). The three-line tooltip is the
 * sidebar's.
 */
function HomeRow({
  row: sourceRow,
  where,
  tooltip,
  now,
  started,
  unread,
  pendingApprovalCount,
  onOpen,
}: {
  row: SidebarSessionRow;
  where: string;
  tooltip: string;
  now: number;
  started: boolean;
  unread: boolean;
  pendingApprovalCount: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const row = sidebarRowForDisplay(sourceRow, t);
  const titleParts = splitBranchSuffix(row.title);
  return (
    <button
      type="button"
      className={HOME_ROW_CLASS}
      title={tooltip}
      onClick={onOpen}
      data-home-row={row.sessionId}
    >
      {/* The sidebar's one `w-4` status slot, in the same urgency order. */}
      <span className="flex w-4 shrink-0 items-center justify-center">
        <HomeRowMarker row={row} started={started} unread={unread} />
      </span>
      {titleParts.suffix === null ? (
        <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
      ) : (
        <span
          className={cn(
            'flex min-w-0 flex-1 items-baseline overflow-hidden text-foreground',
            titleParts.spaced && 'gap-1'
          )}
        >
          <span className="min-w-0 truncate">{titleParts.base}</span>
          <span className="shrink-0 text-muted-foreground">{titleParts.suffix}</span>
        </span>
      )}
      {row.legacyDiverged && (
        <Badge
          variant="warning"
          size="lg"
          className="shrink-0"
          title={t(LEGACY_DIVERGED_HINT)}
          aria-label={t(LEGACY_DIVERGED_HINT)}
        >
          1.0.x
        </Badge>
      )}
      {pendingApprovalCount > 0 && (
        <Badge
          variant="warning"
          size="lg"
          className="shrink-0 gap-0.5 tabular-nums"
          aria-label={t('{{count}} pending approval requests', { count: pendingApprovalCount })}
          title={t('{{count}} pending approval requests', { count: pendingApprovalCount })}
        >
          <ShieldQuestion className="size-3.5" />
          {pendingApprovalCount}
        </Badge>
      )}
      {row.failed && (
        <Badge variant="destructive" size="lg" className="shrink-0">
          {t('Failed')}
        </Badge>
      )}
      {/* Gives way first: the title is the row's identity. */}
      <span className="min-w-0 max-w-[45%] shrink truncate text-meta text-muted-foreground">
        {where}
      </span>
      <span className="w-12 shrink-0 text-right text-meta text-muted-foreground tabular-nums">
        {formatRelativeAge(row.updatedAt, now)}
      </span>
    </button>
  );
}

/** Running (spinner), waiting on the user, an unseen result, or started in the background. */
function HomeRowMarker({
  row,
  started,
  unread,
}: {
  row: SidebarSessionRow;
  started: boolean;
  unread: boolean;
}): ReactNode {
  const { t } = useI18n();
  if (row.busy) {
    if (isWaitingSessionStatus(row.status)) {
      const label =
        row.status === 'waiting_question' ? t('Waiting for an answer') : t('Waiting for approval');
      return (
        <span
          role="img"
          aria-label={label}
          title={label}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
        />
      );
    }
    return <Spinner aria-label={t('Running')} className="size-3 shrink-0 text-status-running" />;
  }
  if (unread) {
    const label = row.failed ? t('Failed while you were away') : t('Finished while you were away');
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          row.failed ? 'bg-destructive' : 'bg-success'
        )}
      />
    );
  }
  if (started) {
    return (
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground"
        title={t('Running in the background')}
      />
    );
  }
  return null;
}

function HomeAuxRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={HOME_AUX_ROW_CLASS} onClick={onClick}>
      <span aria-hidden className="w-4 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
