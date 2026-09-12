/**
 * H/21 P0 — "this session's model is not in this app's model directory".
 *
 * H/19 U1 moved this app onto its own agent directory. A user who had been
 * running `pi` themselves keeps their AI services in their own Pi directory,
 * and nothing is copied over until the migration in Settings -> Pi runs. Until
 * it does, every session that recorded one of those models fails to start and
 * the only thing on screen is the worker's raw diagnostic: it names the model
 * but never says a migration exists. The H/19 point-check found users have no
 * way to get from that failure to the fix, which is what this module supplies.
 *
 * Shaped after `authRequiredError`, and matched on two signals for the same
 * reason: only one of the two throw sites carries a code that survives the trip
 * to the renderer.
 *  - `piWorkerSession` throws `PiWorkerSessionError('WORKER_MODEL_NOT_FOUND')`,
 *    and `WorkerSlot` formats remote failures as `` `${code}: ${message}` `` —
 *    so the code is in the text.
 *  - `piAgentSessionBootstrap` throws a plain `Error`, which the worker's
 *    `errorPayload` flattens to `WORKER_REQUEST_FAILED`. There the code is
 *    gone and only the fixed message text identifies the failure.
 */

/** The code carried by the throw site that has one (`piWorkerSession`). */
export const MODEL_MISSING_CODE_TOKEN = 'WORKER_MODEL_NOT_FOUND';

/**
 * The message text both throw sites produce (`Pi model not found: <ref>`).
 * Matched as a substring: the text is wrapped by the worker RPC and again by
 * Electron's IPC, both of which prefix rather than rewrite.
 */
const MODEL_MISSING_MESSAGE_NEEDLE = 'Pi model not found';

/** True when `text` looks like a session whose recorded model is unknown here. */
export function isModelMissingError(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes(MODEL_MISSING_CODE_TOKEN) || text.includes(MODEL_MISSING_MESSAGE_NEEDLE);
}

export interface ModelMissingErrorView {
  title: string;
  message: string;
  /** The second way out, for users who do not want to migrate anything. */
  hint: string;
  actionLabel: string;
  /** Pane the action opens; `pi` is where H/19 U2 put the migration section. */
  settingsCategory: 'pi';
}

/**
 * Copy + "go migrate" action, shared by the two surfaces this failure
 * reaches: the timeline's history notice (resume failed) and the session-failed
 * card (a send failed). One view so the two cannot drift apart.
 *
 * Retry is deliberately not offered anywhere for this code — the model will
 * still be missing on the next attempt, and a button that cannot work is worse
 * than no button.
 */
export const MODEL_MISSING_ERROR_VIEW: ModelMissingErrorView = {
  title: 'Model is not available here',
  // Every string here is a DICTIONARY KEY, not display text: this module is a
  // plain `.ts` with no translator in scope, so the two surfaces that render
  // this view call `t()` on each field. Same split as the tool verbs (batch 4).
  message:
    'This chat is pinned to a model this app does not have, so it could not be started. This app uses its own agent directory, and AI services you set up in your own Pi directory do not come across on their own.',
  // Names both ways out on purpose. The migration section hides itself when
  // there is no `~/.pi/agent` to copy from, so copy that promised only a
  // migration would send some users to a pane with no such control. The same
  // pane always carries the AI services editor, which is the other way in.
  hint: 'Migrate or add the AI service under Settings · Pi and this chat can continue; you can also switch to a model this app already has, from above the composer.',
  actionLabel: 'Add the model in Pi settings',
  settingsCategory: 'pi',
};
