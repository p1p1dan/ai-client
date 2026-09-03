# Pi-only release rollout and rollback

This runbook governs the AiClient 0.4 Pi-only release candidate. Writing the
runbook is not evidence that an observation window or target-platform test has
passed; results must be recorded in the T37 release evidence with run URLs,
artifact hashes, dates, and operators.

## Candidate inputs

Before rollout, record:

- Git commit and candidate tag;
- GitHub Actions Build run URL and run ID;
- artifact name, byte size, and SHA-256 for each platform;
- packaged verifier result for each artifact;
- target-platform install, launch, conversation, Pi TUI, and clean-exit result;
- migration guide and release-notes revision used by the candidate.

## Rollout stages

1. **CI candidate** — all automated gates and packaged verifiers pass. A manual
   `workflow_dispatch` run may produce artifacts without publishing a release.
2. **Internal use** — use the candidate with real providers for 1–2 days. Do not
   widen distribution merely because CI is green.
3. **Limited rollout** — widen only after the internal observation exit criteria
   pass and a rollback rehearsal has been recorded.
4. **General release** — publish the signed/approved platform artifacts and the
   curated release notes.

## Observation checklist

Record at least once per observation day:

- application launch and model discovery;
- create, stop, resume, history, rewind, and fork behavior;
- Claude import result and confirmation that the source is unchanged;
- permission approval and denial behavior;
- GUI ↔ Pi TUI ownership transfer;
- worker crash and application restart recovery;
- no dangling runtime identity in the session index;
- no worker or Pi TUI process after application exit;
- RAM, swap, and disk trend during repeated session churn.

## Release blockers

Any of the following stops rollout:

- session or transcript data corruption;
- permission execution without the required approval;
- output or state crossing logical sessions;
- GUI and Pi TUI writing the same session concurrently;
- repeatable startup failure or inability to discover configured models;
- a session becoming permanently unusable after stop, crash, or restart;
- orphan worker or Pi TUI processes after the application exits;
- packaged application missing `resources/licenses/LICENSE` or
  `resources/licenses/THIRD_PARTY_NOTICES.md`.

## Rollback procedure

1. Stop distribution and remove the candidate from the latest-release channel.
2. Ask users to exit AiClient completely before installing the previous build.
3. Preserve `~/.pilab`, `~/.aiclient`, Pi session JSONL files, and original
   Claude/Codex transcripts. Do not run a cleanup or reverse migration.
4. Restore the previous application version. It continues to read the unchanged
   legacy state retained under `~/.aiclient`.
5. Keep new Pi sessions for a later fixed build; older versions may not display
   them, but rollback must not delete them.
6. Record the failing version, commit, platform, artifact hash, trigger,
   affected session identity, logs, and the owner who approved the rollback.
7. Re-open rollout only after a new candidate passes the original failing gate
   and the full T37 blocker matrix.

## External release conditions

- Windows and Linux artifacts require their native CI jobs and target-platform
  install/start/TUI/exit evidence.
- macOS general release requires a macOS runner, Developer ID signing and
  notarization credentials, and Gatekeeper validation on a real Mac. An
  unsigned CI artifact is useful structural evidence but is not a distributable
  macOS release.
- The 1–2 day internal observation window cannot be marked complete in advance.
