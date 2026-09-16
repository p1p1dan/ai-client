import { execSync } from 'node:child_process';

/**
 * Decode console output the way the console wrote it (windows-07, windows-09).
 *
 * Console programs on Windows write pipes in the console code page, not UTF-8:
 * on a Chinese install that is 936 (GBK). Decoding those bytes as UTF-8 does
 * not fail — `Buffer.toString('utf8')` silently turns every non-ASCII byte into
 * U+FFFD — so a PATH entry under a Chinese user directory came back as
 * replacement characters and the tool it pointed at simply stopped existing,
 * and a native command's Chinese output reached the model as mojibake it then
 * reasoned about.
 *
 * Pure ASCII is valid UTF-8, so nothing here changes on an ASCII machine, and
 * MSYS tools (which do write UTF-8) keep decoding as UTF-8 even when the
 * console code page says otherwise — the bytes decide, not the setting.
 */

/**
 * The Windows code pages `TextDecoder` can actually decode.
 *
 * Node ships full ICU, but `TextDecoder` only accepts WHATWG encoding labels —
 * `cp936` is not one of them, `gbk` is, and the DOS pages (437, 850) have no
 * label at all. A page missing from this table falls back to UTF-8, which is
 * the behaviour that existed before this table did.
 */
const CODE_PAGE_LABELS: Record<number, string> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28591: 'iso-8859-1',
  54936: 'gb18030',
  65001: 'utf-8',
};

/** The WHATWG label for a Windows code page, or nothing if it has none. */
export function codePageLabel(codePage: number | undefined): string | undefined {
  return codePage === undefined ? undefined : CODE_PAGE_LABELS[codePage];
}

/** Probed once per process: the answer cannot change under a running console. */
let probed: { value: number | undefined } | undefined;

export interface ConsoleCodePageOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; production shells out to `chcp.com` exactly once. */
  run?: () => string;
}

/**
 * The console output code page, or `undefined` when there is nothing to ask.
 *
 * `AICLIENT_CONSOLE_CODEPAGE` overrides the probe on every platform: it is the
 * escape hatch for a field machine whose console reports one page and whose
 * tools write another, and it is how this path is exercised off Windows.
 */
export function consoleCodePage(options: ConsoleCodePageOptions = {}): number | undefined {
  const env = options.env ?? process.env;
  const override = Number(env.AICLIENT_CONSOLE_CODEPAGE);
  if (Number.isInteger(override) && override > 0) return override;
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  if (probed) return probed.value;
  let value: number | undefined;
  try {
    const output = (
      options.run ??
      (() =>
        execSync('chcp.com', {
          encoding: 'ascii',
          timeout: 2000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }))
    )();
    // "Active code page: 936" — the label is localized, the number is not, and
    // a localized label decoded as ASCII still leaves the digits intact.
    const match = /(\d{3,5})\D*$/.exec(output.trim());
    value = match ? Number(match[1]) : undefined;
  } catch {
    // No console (a packaged GUI process), no chcp, or it timed out: fall back
    // to UTF-8 rather than guessing a page.
    value = undefined;
  }
  probed = { value };
  return value;
}

/** Forget the probed code page. Tests only. */
export function resetConsoleCodePageCache(): void {
  probed = undefined;
}

/**
 * Drop a multi-byte character cut in half by an output budget.
 *
 * Output that was truncated at a byte count can end mid-sequence, and that
 * single incomplete tail would otherwise make a perfectly good UTF-8 stream
 * look like it was written in some other encoding.
 */
function dropIncompleteUtf8Tail(bytes: Uint8Array): Uint8Array {
  for (let index = bytes.length - 1, back = 0; index >= 0 && back < 4; index--, back++) {
    const byte = bytes[index];
    if (byte < 0x80) return bytes;
    if (byte < 0xc0) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return bytes.length - index >= needed ? bytes : bytes.subarray(0, index);
  }
  return bytes;
}

export interface DecodeConsoleOptions {
  /** Defaults to the probed console code page. */
  codePage?: number;
  /** Set when an output budget cut the bytes short. */
  truncated?: boolean;
}

/**
 * Decode bytes a console program wrote.
 *
 * Order matters: valid UTF-8 wins, because Git Bash and every MSYS tool write
 * it regardless of the console page, and only bytes that cannot be UTF-8 are
 * handed to the code page. A string argument is returned untouched, so a caller
 * that still decodes at the `execSync` boundary keeps its own (lossy) result.
 */
export function decodeConsoleOutput(
  value: string | Uint8Array,
  options: DecodeConsoleOptions = {}
): string {
  if (typeof value === 'string') return value;
  const bytes = options.truncated ? dropIncompleteUtf8Tail(value) : value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8; fall through to the code page.
  }
  const label = codePageLabel(options.codePage ?? consoleCodePage());
  if (label !== undefined && label !== 'utf-8') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // A label this build cannot honour: fall back to the lossy UTF-8 read.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
