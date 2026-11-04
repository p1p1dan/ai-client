import { describe, expect, it } from 'vitest';
import { deriveSessionOutputs, outputKindOf, outputName } from '../sessionRail/outputsModel';
import type { SessionReviewEntry } from '../sessionReview';

/** Decision 209 §2: what the session rail's Outputs card lists. */
function entry(
  path: string,
  status: SessionReviewEntry['status'] = 'added',
  id = path
): SessionReviewEntry {
  return { id, path, status, added: 1, removed: 0 };
}

describe('outputKindOf — document-like kinds only', () => {
  it('documents, web pages, images, sheets and slides, by extension in any case', () => {
    expect(outputKindOf('/r/docs/208-chat-transcript-styles.md')).toBe('document');
    expect(outputKindOf('notes.MARKDOWN')).toBe('document');
    for (const ext of ['txt', 'pdf', 'doc', 'docx', 'rtf']) {
      expect(outputKindOf(`a.${ext}`)).toBe('document');
    }
    expect(outputKindOf('/r/transcript-density-options.html')).toBe('web');
    expect(outputKindOf('C:\\r\\page.HTM')).toBe('web');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']) {
      expect(outputKindOf(`a.${ext}`)).toBe('image');
    }
    for (const ext of ['csv', 'tsv', 'xls', 'xlsx']) expect(outputKindOf(`a.${ext}`)).toBe('sheet');
    for (const ext of ['ppt', 'pptx']) expect(outputKindOf(`a.${ext}`)).toBe('slides');
  });

  it('code, configuration and the rest are not outputs', () => {
    for (const path of [
      'src/a.ts',
      'src/a.tsx',
      'b.py',
      'package.json',
      'c.yaml',
      'd.toml',
      'e.css',
      'Makefile',
      '.md',
      'archive.md.',
    ]) {
      expect(outputKindOf(path), path).toBeNull();
    }
  });

  it('the name is the last segment, either separator', () => {
    expect(outputName('/r/docs/a.md')).toBe('a.md');
    expect(outputName('C:\\r\\b.html')).toBe('b.html');
    expect(outputName('c.png')).toBe('c.png');
  });
});

describe('deriveSessionOutputs', () => {
  it('lists created documents only, newest first', () => {
    const rows = deriveSessionOutputs([
      entry('/r/docs/208-chat-transcript-styles.md'),
      entry('/r/src/model.ts'),
      entry('/r/README.md', 'modified'),
      entry('/r/notes.txt', 'unknown'),
      entry('/r/transcript-density-options.html'),
    ]);
    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ['transcript-density-options.html', 'web'],
      ['208-chat-transcript-styles.md', 'document'],
    ]);
  });

  it('a path created twice is listed once, at its last creation', () => {
    const rows = deriveSessionOutputs([
      entry('/r/a.md', 'added', 'm1:t1'),
      entry('/r/b.md', 'added', 'm2:t1'),
      entry('/r/a.md', 'added', 'm3:t1'),
    ]);
    expect(rows.map((row) => row.name)).toEqual(['a.md', 'b.md']);
  });

  it('a later edit does not take a created file off the list', () => {
    const rows = deriveSessionOutputs([entry('/r/a.md'), entry('/r/a.md', 'modified', 'm2:t1')]);
    expect(rows.map((row) => row.path)).toEqual(['/r/a.md']);
  });

  it('nothing created: no rows (the card is not drawn)', () => {
    expect(deriveSessionOutputs([])).toEqual([]);
    expect(deriveSessionOutputs([entry('/r/a.ts')])).toEqual([]);
  });
});
