import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { type InstructionSource, MAX_INSTRUCTION_BYTES } from './projectInstructions.ts';

const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);

// Adapt PI-Desktop's optional-file reads to D11's bounded, TSD-aware IO.
// Host/transport failures must propagate: ciphertext is never an instruction.
export function instructionSource(
  io: RuntimeHostIoService,
  maxBytes = MAX_INSTRUCTION_BYTES
): InstructionSource {
  return {
    async readText(path) {
      try {
        const result = await io.readFile(path, {
          maxBytes: Math.max(1, maxBytes),
          overflow: 'truncate',
        });
        // A bounded read may end inside a UTF-8 character. Streaming decode
        // leaves that incomplete suffix out instead of injecting U+FFFD.
        return new TextDecoder().decode(result.bytes, { stream: result.truncated });
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
