import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { type InstructionSource, MAX_INSTRUCTION_BYTES } from './projectInstructions.ts';

const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);

/**
 * What goes in the prompt when a file exists, is contained, and still cannot be
 * turned into text. Silence would be worse: the user sees their CLAUDE.md
 * ignored with no way to tell whether it was found (context-prompt-15).
 */
function undecodableNotice(path: string): string {
  return `[not loaded: ${path} is not UTF-8 or UTF-16 text]`;
}

/**
 * Decode an instruction file, recognising the encoding rather than assuming it.
 *
 * Three cases, in the order they actually occur:
 *
 * 1. A UTF-16 byte-order mark. Notepad writes UTF-16LE, and read byte-for-byte
 *    as UTF-8 that file becomes kilobytes of U+FFFD interleaved with NULs —
 *    which a non-fatal decoder reports as complete success, so the mojibake
 *    goes into the system prompt and stays there for the whole session.
 * 2. Valid UTF-8, the normal case. Decoded with `fatal`, and in streaming mode
 *    when the read was cut at a byte budget so an incomplete trailing
 *    character is dropped rather than replaced.
 * 3. Neither (GBK, Latin-1, a binary file named CLAUDE.md). Reported, not
 *    guessed at: a wrong single-byte guess is indistinguishable from case 1.
 *
 * Deliberately a local copy of the idea in `plugins/tools/read-lines.ts` rather
 * than an import: that decoder belongs to the read tool's error contract
 * (`io_not_utf8` reaches the model), while an instruction file is optional and
 * must never end a run.
 */
function decodeInstructionText(bytes: Uint8Array, truncated: boolean, path: string): string {
  const utf16 =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : undefined;
  try {
    // `ignoreBOM` stays at its default: the mark is metadata, not content.
    return new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return undecodableNotice(path);
  }
}

// Adapt PI-Desktop's optional-file reads to D11's bounded, TSD-aware IO.
// Host/transport failures must propagate: ciphertext is never an instruction.
export function instructionSource(
  io: RuntimeHostIoService,
  maxBytes = MAX_INSTRUCTION_BYTES
): InstructionSource {
  return {
    async readText(path) {
      try {
        // context-prompt-06: HostIo rejects a non-regular file with its own
        // `invalid_host_request`, which is not an errno and so was not in the
        // optional set — a DIRECTORY named `AGENTS.md`, or a FIFO, failed every
        // single run in that workspace with an error naming neither. Asking
        // first is better than widening the set, because `invalid_host_request`
        // also covers caller mistakes (a relative path, a bad read window) that
        // must still be loud.
        const info = await io.stat(path);
        if (info.kind !== 'file') return undefined;
        const result = await io.readFile(path, {
          maxBytes: Math.max(1, maxBytes),
          overflow: 'truncate',
        });
        return decodeInstructionText(result.bytes, result.truncated, path);
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
    async realpath(path) {
      try {
        return await io.realpath(path);
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
  };
}
