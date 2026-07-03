// derive.ts — Archive move + (weakened) knowledge guidance.
//
// v3 has no structured decisions[]/findings[]/review.md to derive — ledger.md is
// already the human-readable record, so archive only moves the directory and
// updates the repo index; knowledge suggestion becomes a static classification
// guide the AI applies by hand after reading ledger.md.

import { mkdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ARCHIVE_DIR, isoNow, yearMonth } from './config.js';
import type { Proposal } from './schema.js';
import { writeProposal, upsertRepoIndex } from './store.js';
import { clearProposalFromSessions } from './session-runtime.js';

export function archiveProposal(dir: string, proposal: Proposal): void {
  const monthDir = join(ARCHIVE_DIR, yearMonth());
  mkdirSync(monthDir, { recursive: true });
  const dest = join(monthDir, basename(dir));
  renameSync(dir, dest);

  proposal.lifecycle_status = 'archived';
  writeProposal(dest, proposal);

  upsertRepoIndex({
    id: proposal.id, slug: proposal.slug, dir: `archive/${yearMonth()}/${basename(dir)}`,
    title: proposal.title, lifecycle_status: 'archived', type: proposal.type, updated_at: isoNow(),
  });

  clearProposalFromSessions(proposal.id);

  console.log(`Archived ${proposal.id} to ${dest}`);
}

export function knowledgeSuggestGuidance(): string[] {
  return [
    'v3 stores decisions/findings as free text in ledger.md, not structured JSON —',
    'read through ledger.md yourself and classify anything worth keeping into one of:',
    '  - Convention (naming/format/structure agreement)',
    '  - Pattern (verified approach)',
    '  - Forbidden (banned practice)',
    '  - Gotcha (counter-intuitive trap)',
    'Target file: common/ (principle) | lang/<language>.md | modules/ (qt/embedded) | domain/<topic>.md',
    '',
    'Then run `knowledge save --content "..." --reason "..."` for each entry worth keeping,',
    'or `knowledge skip` if nothing is worth capturing.',
  ];
}
