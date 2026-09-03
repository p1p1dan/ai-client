<p align="center">
  <img src="docs/assets/logo.png" alt="AiClient Logo" width="120" />
</p>

<h1 align="center">AiClient</h1>

<p align="center">
  <strong>Pi-native AI coding across Git worktrees</strong>
</p>
<p align="center">
  Keep each branch, terminal, editor state, and Pi conversation isolated while
  moving between tasks without stashing or context switching.
</p>

<p align="center">
  <a href="README.zh.md">中文</a> | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/p1p1dan/ai-client/releases/latest"><img src="https://img.shields.io/github/v/release/p1p1dan/ai-client?style=flat&color=blue" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Electron-39+-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

---

## What AiClient is

AiClient is an Electron desktop application for **Git Worktree + Pi** workflows.
Every worktree can keep independent conversations, terminals, files, and Git
state while a bounded worker pool prevents inactive sessions from consuming
unbounded resources.

![AiClient Terminal](docs/assets/feature-terminal.png)

## Installation

Download a release artifact from
[GitHub Releases](https://github.com/p1p1dan/ai-client/releases/latest).

| Platform | Artifact |
|---|---|
| Windows x64 | installer or portable `.exe` |
| Linux x64 | `.AppImage` or `.deb` |

A signed and notarized macOS package is not part of the current release
candidate yet. See the [Pi-only migration guide](docs/pi-only-migration.md) for
upgrade and rollback details.

### Build from source

```bash
git clone https://github.com/p1p1dan/ai-client.git
cd ai-client

# Node.js 24 and pnpm 10 are required
pnpm install
pnpm dev
```

Packaging is host-platform only; native Windows, Linux, and macOS builds should
run on their matching OS or through the Build workflow.

## Features

### Pi-native conversations

- Bundled Pi SDK and CLI; no global Pi installation is required
- Provider and model selection through Pi configuration
- Streaming messages, tool/thinking timeline, queue and Stop
- Persistent history, branch tree, rewind, and fork
- Extension UI permission prompts rendered in the desktop GUI
- GUI ↔ Pi TUI handoff with a single-writer session guard
- Worker crash recovery, idle reclamation, and clean process shutdown

### Legacy conversation import

Local Claude history can be scanned read-only and imported into independent Pi
sessions. The importer is atomic and deduplicated, and it never modifies source
transcripts. Codex history import is not enabled until its real local format is
validated. See [Migrating to Pi-only AiClient](docs/pi-only-migration.md).

### Git worktree management

- Create and switch worktrees and branches
- Keep workspace state isolated by worktree
- Review changes, stage/unstage files, and browse commit history
- Open the current workspace in VS Code, Cursor, or another configured tool

### Editor and terminals

- Monaco-based multi-tab editor and file tree
- xterm.js terminals backed by node-pty
- Pi TUI embedded in the terminal surface
- Theme synchronization with bundled Ghostty themes

## Architecture

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

The Pi SDK stays outside Electron Main. Legacy Claude/Codex code is retained
only where required for read-only migration and provenance display.

## Upgrade and release documentation

- [Pi-only migration guide](docs/pi-only-migration.md)
- [Rollout and rollback runbook](docs/pi-only-rollout-rollback.md)
- [Unreleased notes](docs/release-notes/unreleased.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Tech stack

- Electron 39, React 19, TypeScript 5.9
- Tailwind CSS 4
- Monaco Editor, xterm.js, node-pty
- simple-git, sqlite3
- Pi coding agent SDK

## Development checks

Run heavy checks serially:

```bash
pnpm typecheck
pnpm typecheck:agent-host
pnpm lint
pnpm test
```

See `AGENTS.md` for repository conventions and resource-safe test guidance.

## License

AiClient is licensed under the [MIT License](LICENSE). Third-party source and
runtime notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
