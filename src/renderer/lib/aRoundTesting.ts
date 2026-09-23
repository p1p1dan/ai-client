/**
 * A-round testing: every surface that would pull a user's OWN existing Pi
 * setup — potentially including their API keys — into this app is closed for
 * the duration. One switch, three call sites, so the round cannot be half
 * re-opened by editing the wrong one of them.
 *
 * TO RE-OPEN, FLIP THIS ONE LINE TO `false`. Nothing else needs changing:
 * every button, dialog, handler and IPC call downstream is still fully
 * wired — this only stops each surface from being reached.
 *
 * ## The three surfaces, and why they are one switch
 *
 * 1. `WelcomeView`'s "Use my own setup" button — chooses `credentialMode:
 *    'local'` via `auth.enterApp('local')`. Kept on screen, disabled (see
 *    `WelcomeView.tsx` for the button-specific reasoning).
 * 2. `AgentMigrationPrompt` — the dialog that offers to COPY an existing
 *    `~/.pi(lab)/.../agent` directory (skills, AI services — with their API
 *    keys, conversation history) into this app's own directory. Suppressed
 *    outright rather than greyed out (see that file for why).
 * 3. `AgentMigrationSettings` — the same offer, parked in Settings for anyone
 *    who did not act on (2) on an earlier launch. Greyed out like (1).
 *
 * (2) and (3) sit on a different axis from (1) — they copy files, they do not
 * choose a credential source, and neither checks `credentialMode` at all: the
 * migration IPC (`main/ipc/agentMigration.ts`,
 * `main/services/agentMigration/`) fires for a signed-in (`managed`) user
 * exactly as readily as a local one, the moment it finds something to copy.
 * But the A-round risk is the same one either way: a tester ends up with a
 * second, real credential — their own API key — inside the build being
 * tested. Hence one constant for "closed for the round", not three.
 *
 * ## Why (2) is suppressed and (1)/(3) are only greyed out
 *
 * A disabled button that stays on screen is an honest "not now" — the tester
 * can see the route exists and that it is coming back. A dialog that pops up
 * unasked and offers only "ask me later" is not the same kind of disabled:
 * greying out its buttons would still leave a modal in the tester's way for a
 * route A-round does not want exercised at all. So while this is `true`,
 * `AgentMigrationPrompt` never even inspects the filesystem for something to
 * offer; (1) and (3) stay visible and inert, exactly like the original
 * `WelcomeView` treatment this switch started as (see git history:
 * `99ab7d57`).
 */
export const LOCAL_SETUP_ENTRY_DISABLED = false;

/**
 * The Pi-directory migration rows (skills, prompt templates, AGENTS.md, AI
 * services, Pi conversation history) inside `AgentMigrationPrompt` and
 * `AgentMigrationSettings`.
 *
 * `LOCAL_SETUP_ENTRY_DISABLED` was flipped to `false` so the startup dialog
 * can open again — but only to carry the Claude Code / Codex history guide.
 * The Pi copy itself is not ready to ship yet, so its rows stay suppressed:
 * the dialog never inspects `~/.pi/agent`, never offers the Pi copy, and the
 * settings pane greys those rows out. Flip this to `false` to bring the Pi
 * migration back.
 */
export const PI_MIGRATION_DISABLED = true;
