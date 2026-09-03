# Migrating to the Pi-only AiClient

AiClient 0.4 changes the conversation runtime to Pi. Git worktrees, the editor,
Git tools, terminals, and existing workspace state remain part of AiClient; the
runtime that executes AI conversations is now Pi only.

## What Pi-only means

- New and resumed conversations run through the bundled Pi SDK.
- Providers and models are configured through Pi rather than by choosing a
  Claude, Codex, Gemini, or custom CLI runtime in AiClient.
- Claude and Codex execution runtimes, installers, and remote plugins are no
  longer included.
- The GUI and the embedded Pi TUI operate on the same Pi session file. AiClient
  transfers ownership when switching modes so they never write simultaneously.

## Existing conversations

### Claude history

AiClient can scan local Claude project history and import selected conversations.
Import is deliberately one-way and non-destructive:

- source transcripts are opened read-only and are never modified;
- each imported conversation becomes a new, independent Pi session;
- repeated imports are deduplicated from source identity and content metadata;
- unsupported tool payloads are retained for display but are not executed or
  injected into the model context.

Importing does not restore the old Claude runtime. Continue the conversation in
the newly created Pi session.

### Codex history

Codex history import is not enabled in this release because the supported local
source format has not yet been validated with real rollout data. Existing Codex
files are not deleted or modified.

## Application data migration

On first launch, local application state is copied from `~/.aiclient` to the
active profile under `~/.pilab`.

- Settings, local session state, remote-connection work files, and credentials
  are copied automatically.
- Existing destination files are not overwritten.
- The migration marker is written only after the credential and state copies
  succeed, so an interrupted migration is retried.
- `~/.aiclient` is kept unchanged for rollback. Delete it only after you are
  satisfied that the new version works for you.

Remote machines are not migrated. The first connection after upgrade may reset
remote-side settings and download the remote runtime again; local data is not
affected.

## Provider and model setup

AiClient reads Pi configuration from the active Pi profile. If no models appear,
check that the configured Pi agent directory exists and contains valid provider
and model configuration. The application does not fall back to the removed
legacy CLI runtimes.

## Rollback

1. Exit AiClient completely, including any Pi TUI terminal.
2. Back up the active `~/.pilab/<profile>` directory before changing versions.
3. Install the previous AiClient version.
4. Keep both `~/.pilab` and `~/.aiclient`; do not delete legacy transcripts.

The previous version can continue reading its unchanged `~/.aiclient` state.
Pi sessions created by 0.4 are preserved on disk but are not guaranteed to be
understood by older AiClient releases. Reinstalling a Pi-only build restores
access to those sessions.

## Release blockers and support data

Stop rollout and report the candidate build if you observe data corruption,
permission approval being bypassed, messages crossing sessions, GUI/TUI double
writing, repeatable startup failure, or orphan worker/TUI processes after exit.
Preserve the affected Pi session JSONL and application logs when reporting a
problem; do not edit the original legacy transcript used for an import.
