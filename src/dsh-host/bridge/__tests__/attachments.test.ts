import { describe, expect, it, vi } from 'vitest';
import type { SessionAttachment } from '../../../shared/types/agentHost.ts';
import { WORKER_ATTACHMENT_REJECTED } from '../../../shared/types/workerRpc.ts';
import {
  admitUserContent,
  type DshAdmissionPart,
  type DshAttachmentStore,
  type DshUserContent,
} from '../attachments.ts';

/**
 * dsh-rebase P1-4c2 (decisions 096 and 097): the one admission a send and an
 * interjection share, against a fake `ctx.attachments`. What the real store
 * does with the bytes is measured by tools/attachment-experiments.ts and the
 * `image` / `file-attach` recordings.
 */

function attachmentError(code: string, message = `${code} refused`): Error {
  return Object.assign(new Error(message), { name: 'AttachmentError', code });
}

function store(overrides: Partial<DshAttachmentStore> = {}): DshAttachmentStore {
  return {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    admitPromptContent: vi.fn(async (parts: readonly DshAdmissionPart[]) =>
      parts.map(
        (part): DshUserContent =>
          part.type === 'image'
            ? {
                type: 'image' as const,
                attachment: {
                  attachmentId: `sha256:${part.name}`,
                  mediaType: part.mediaType,
                  bytes: 1,
                  width: 1,
                  height: 1,
                },
              }
            : part
      )
    ),
    saveFile: vi.fn(async (input) => ({
      attachmentId: 'sha256:f',
      name: input.name ?? 'file',
      bytes: input.data.byteLength,
    })),
    validateImage: vi.fn(async () => undefined),
    isAttachmentError: (error) => (error as { name?: unknown })?.name === 'AttachmentError',
    ...overrides,
  };
}

const png = (name?: string, data = 'AAAA'): SessionAttachment => ({
  kind: 'image',
  mediaType: 'image/png',
  data,
  ...(name ? { name } : {}),
});

async function rejected(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a rejection');
}

describe('admitUserContent', () => {
  it('without attachments is the text alone, and the store is never asked', async () => {
    const attachments = store();
    await expect(admitUserContent(attachments, 'hi', undefined)).resolves.toEqual([
      { type: 'text', text: 'hi' },
    ]);
    await expect(admitUserContent(attachments, 'hi', [])).resolves.toEqual([
      { type: 'text', text: 'hi' },
    ]);
    expect(attachments.admitPromptContent).not.toHaveBeenCalled();
    expect(attachments.saveFile).not.toHaveBeenCalled();
  });

  it('stores a text attachment as its UTF-8 bytes, under its own name', async () => {
    const attachments = store();
    const content = await admitUserContent(attachments, 'read it', [
      { kind: 'text', mediaType: 'text/markdown', data: '# 标题\n', name: 'notes.md' },
    ]);
    const saved = vi.mocked(attachments.saveFile).mock.calls[0]?.[0];
    expect(Buffer.from(saved?.data ?? []).toString('utf8')).toBe('# 标题\n');
    expect(saved?.name).toBe('notes.md');
    expect(content).toEqual([
      { type: 'text', text: 'read it' },
      { type: 'file', attachment: { attachmentId: 'sha256:f', name: 'notes.md', bytes: 9 } },
    ]);
  });

  it('names the only image of a refused batch', async () => {
    const attachments = store({
      admitPromptContent: vi.fn(async () => {
        throw attachmentError('IMAGE_TOO_LARGE', 'Image exceeds the limit.');
      }),
    });
    const error = await rejected(admitUserContent(attachments, '', [png('big.png')]));
    expect(error).toMatchObject({
      code: WORKER_ATTACHMENT_REJECTED,
      message: 'IMAGE_TOO_LARGE "big.png": Image exceeds the limit.',
    });
    // Only on the refusal path, and not needed here.
    expect(attachments.validateImage).not.toHaveBeenCalled();
  });

  it('finds the image a batch is refused for by validating each alone', async () => {
    const attachments = store({
      admitPromptContent: vi.fn(async () => {
        throw attachmentError('IMAGE_DIMENSION_TOO_LARGE');
      }),
      validateImage: vi.fn(async (input) => {
        if (input.data.byteLength > 3) throw attachmentError('IMAGE_DIMENSION_TOO_LARGE');
      }),
    });
    const error = await rejected(
      admitUserContent(attachments, 'x', [png('ok.png', 'AAA='), png('wide.png', 'AAAAAAAA')])
    );
    expect(error.message).toMatch(/^IMAGE_DIMENSION_TOO_LARGE "wide\.png": /);
  });

  it('reads the image off the batch for a type DSH does not take, or a bad encoding', async () => {
    const refusing = (code: string) =>
      store({
        admitPromptContent: vi.fn(async () => {
          throw attachmentError(code);
        }),
      });
    const bmp: SessionAttachment = {
      kind: 'image',
      mediaType: 'image/bmp',
      data: 'AAAA',
      name: 'x.bmp',
    };
    expect(
      (
        await rejected(
          admitUserContent(refusing('UNSUPPORTED_IMAGE_TYPE'), '', [png('a.png'), bmp])
        )
      ).message
    ).toMatch(/^UNSUPPORTED_IMAGE_TYPE "x\.bmp": /);
    expect(
      (
        await rejected(
          admitUserContent(refusing('INVALID_IMAGE_BASE64'), '', [
            png('a.png'),
            png('b.png', 'AAAA\n'),
          ])
        )
      ).message
    ).toMatch(/^INVALID_IMAGE_BASE64 "b\.png": /);
  });

  it('blames no one file when the images are refused as a whole', async () => {
    const attachments = store({
      admitPromptContent: vi.fn(async () => {
        throw attachmentError('TOO_MANY_IMAGES', 'Image batch exceeds the configured limit.');
      }),
    });
    const error = await rejected(admitUserContent(attachments, '', [png('a.png'), png('b.png')]));
    expect(error.message).toBe('TOO_MANY_IMAGES: Image batch exceeds the configured limit.');
  });

  it('names a text file the store could not write, and an image with no name as "image"', async () => {
    const failing = store({
      saveFile: vi.fn(async () => {
        throw attachmentError('ATTACHMENT_WRITE_FAILED', 'Unable to write.');
      }),
    });
    expect(
      (
        await rejected(
          admitUserContent(failing, '', [
            png('a.png'),
            { kind: 'text', mediaType: 'text/plain', data: 'x', name: 'n.txt' },
          ])
        )
      ).message
    ).toBe('ATTACHMENT_WRITE_FAILED "n.txt": Unable to write.');
    const unnamed = store({
      admitPromptContent: vi.fn(async () => {
        throw attachmentError('INVALID_IMAGE', 'Not an image.');
      }),
    });
    expect((await rejected(admitUserContent(unnamed, '', [png()]))).message).toBe(
      'INVALID_IMAGE "image": Not an image.'
    );
  });

  it('lets any other failure of the store through unrenamed', async () => {
    const broken = new Error('the store is gone');
    const attachments = store({
      admitPromptContent: vi.fn(async () => {
        throw broken;
      }),
    });
    await expect(admitUserContent(attachments, '', [png('a.png')])).rejects.toBe(broken);
  });
});
