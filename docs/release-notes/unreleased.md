# AiClient 0.4 — Pi-only release candidate

> This curated file is the user-facing body of the next release notes. The tag
> workflow appends verified download links and the full changelog URL.

## Highlights

- **Pi is now the only conversation runtime.** New conversations, resume,
  history, tree/rewind/fork, permission UI, model switching, and the embedded
  terminal all use the bundled Pi SDK.
- **Bounded multi-session workers.** Electron Main owns a resource-bounded pool
  with protected eviction, idle reclamation, crash recovery, and clean process
  shutdown.
- **One conversation across GUI and Pi TUI.** Switching presentation modes
  transfers exclusive ownership of the same Pi session instead of creating a
  second conversation.
- **Claude history import.** Selected local Claude conversations are copied into
  new Pi sessions by a read-only, atomic, deduplicated importer. Source
  transcripts are never changed. Codex history import is not enabled yet.

## Reliability and safety

- Fixed sessions becoming permanently unusable when the first assistant message
  had not yet created the Pi JSONL file. Durable identities are now published
  only after the file exists, historical dangling index rows are repaired, and
  unwritten sessions can recover after a worker crash.
- Fixed worker restart, queue settlement, logout cleanup, terminal replay, dev
  worker startup, and packaged runtime diagnostics found during release gates.
- Packaged applications verify the Pi worker, bundled Node runtime, permission
  extension, third-party notices, and clean worker bootstrap/dispose behavior.

## Migration: `~/.aiclient` → `~/.pilab`

Local state and credentials are copied automatically on first launch. Existing
files are not overwritten and the old `~/.aiclient` directory is deliberately
kept, so rolling back to an older version remains possible.

Remote-machine state is not migrated. The first remote connection after upgrade
may restore defaults and download the remote runtime again; local data is not
affected.

Read the full [Pi-only migration guide](../pi-only-migration.md) before rollout.

## Breaking changes and known limits

- Claude, Codex, Gemini, Cursor, Droid, Auggie, and custom CLI execution paths
  are no longer selectable runtimes. Configure providers and models through Pi.
- Imported Claude sessions continue as independent Pi sessions; they do not
  reactivate the Claude runtime.
- Codex history import awaits validated real-world source-format evidence.
- A fully signed and notarized macOS release still requires Apple credentials
  and real-Mac Gatekeeper verification. Unsigned CI output is not a general
  release artifact.

## Rollback

Exit AiClient and any Pi TUI, back up `~/.pilab/<profile>`, and reinstall the
previous build. Keep both `~/.pilab` and `~/.aiclient`, plus all legacy source
transcripts. Older builds may not display new Pi sessions, but rollback must not
delete them. See the [rollout and rollback runbook](../pi-only-rollout-rollback.md).
