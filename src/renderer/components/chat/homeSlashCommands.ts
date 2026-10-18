/**
 * dsh-rebase decision 175 (GitHub issue #6 follow-up): slash commands on the
 * home page, where no conversation is open.
 *
 * Some commands act on the conversation on screen. The home page has none,
 * and a typed one used to go out as the first message of a conversation made
 * on the draft target (decision 174 §2.8, risk 8): `/archive` reached the
 * model as text, `/compact` ran on an empty chat. Now the menu leaves them
 * out, and a typed one is answered on the spot with the text left in the box.
 *
 * Which ones (decision 175 §3):
 * - this window's `/archive` and `/compact` — unless a plugin or a skill took
 *   the name (`source` is not `builtin`), which then keeps it, as everywhere;
 * - DSH's `/goal` alone, or with `pause`, `resume`, `edit …` or `clear`: they
 *   act on a goal, and a goal lives in its conversation. `/goal <objective>`
 *   starts the new conversation with that goal, which is what typing it here
 *   means, so it goes out.
 *
 * `/new` and `/settings` work anywhere. A skill and every other `/name` go out
 * as the first message, where DSH runs them as it would in any conversation.
 */

import type { ChatEngine } from '@shared/claudeSdkEngine';
import type { Translate } from '@shared/i18n';
import { isGoalCreatingLine } from './goalStart';
import { resolveSlashAction, type SlashCatalogItem } from './slashCommands';

/** This window's commands that act on the conversation on screen. */
export const CONVERSATION_BUILTINS: ReadonlySet<string> = new Set(['archive', 'compact']);

/** The home page's menu: the catalog without this window's commands that need a conversation. */
export function homeSlashMenu(catalog: readonly SlashCatalogItem[]): SlashCatalogItem[] {
  return catalog.filter(
    (item) => !(item.source === 'builtin' && CONVERSATION_BUILTINS.has(item.name))
  );
}

/** Why a command cannot run from the home page: `goal` has its own hint. */
export type HomeSlashRefusal = 'conversation' | 'goal';

/**
 * Why `/name args` typed on the home page cannot run there, or null when it
 * can. `source` is the catalog's for the name (undefined: not in it).
 *
 * `/goal` is DSH's command whatever the catalog says: a `/name` at the start
 * of a line runs the command, never a skill of the same name, and DSH always
 * has `goal`. Decision 194: on the Claude Agent SDK engine `/goal` is the
 * CLI's own command, with its own usage; it goes out as typed.
 */
export function homeSlashRefusal(
  name: string,
  args: string,
  source: string | undefined,
  engine: ChatEngine = 'dsh'
): HomeSlashRefusal | null {
  const action = resolveSlashAction(name, args, source);
  if (action.type === 'archive' || action.type === 'compact') return 'conversation';
  if (
    engine === 'dsh' &&
    name === 'goal' &&
    !isGoalCreatingLine(args ? `/goal ${args}` : '/goal')
  ) {
    return 'goal';
  }
  return null;
}

/** The hint a refused command gets (an info toast, like `/compact`'s other refusals). */
export function homeSlashRefusalToast(
  refusal: HomeSlashRefusal,
  command: string,
  t: Translate
): { title: string; description: string } {
  return {
    title: t('This command needs an open conversation'),
    description:
      refusal === 'goal'
        ? t(
            'To start a goal from here, write it after /goal. Showing, pausing, resuming, editing or clearing a goal works in its conversation.'
          )
        : t(
            '/{{command}} works on an open conversation. Open one from the sidebar or the recent list, then run it there.',
            { command }
          ),
  };
}
