/**
 * dsh-rebase P1-7e (problems 20 and 21, decision 140): the head of a command's
 * output when its beginning was cut away, and the one sentence DSH puts where
 * a stopped command's output would be.
 *
 * A command's output reaches a row three ways, and every one of them can have
 * lost its start at an arbitrary byte, in the middle of a line:
 *
 *  - the live tail (`tool.output`) and the jobs window read the newest bytes
 *    of the job's ring;
 *  - DSH's own record of a long foreground command keeps the tail of stdout
 *    (`dsh-subprocess-local`: "the spill file covers the head") and marks it
 *    with `[output truncated; full output: <path>]` right after that text.
 *
 * Shown as it came, the body opened on half a line (「ll-line 612 d2」) with
 * nothing saying anything was left out. So the partial first line goes, and
 * the row says what was left out — in bytes when they are known (the ring
 * reports them), in words when they are not (DSH's record does not say how
 * much it dropped).
 */

/** What DSH's `bash` / `pwsh` append to a stream they kept only the tail of (`streamText`). */
export const DSH_OUTPUT_TRUNCATED_MARKER = '\n[output truncated; full output: ';

/** Where DSH's rendering of a command starts the stderr section (`renderResult`). */
const STDERR_HEADING = '[stderr]\n';

/**
 * The whole text of a foreground call Stop cut short, as `dsh-tools` records
 * it (`TOOL_ABORTED`). It is an account of the stop, which the row already
 * says (「已停止」), not output the command printed.
 */
export const DSH_TOOL_ABORTED_TEXT = 'Error: tool call aborted';

export function isDshAbortedText(output: string | undefined): boolean {
  return output?.trim() === DSH_TOOL_ABORTED_TEXT;
}

/** The size in the 「已省略前 x KB」 note, rounded as the jobs window rounds it. */
export function kilobytesLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * A tail read from a byte offset (`omittedBytes > 0`) starts at the next line
 * break: the partial line before it joins the omitted bytes. A tail that is
 * one unbroken line is kept whole — dropping it would show nothing at all.
 */
export function startAtLine(
  text: string,
  omittedBytes: number
): { text: string; omittedBytes: number } {
  if (!(omittedBytes > 0)) return { text, omittedBytes };
  const lineEnd = text.indexOf('\n');
  if (lineEnd < 0 || lineEnd === text.length - 1) return { text, omittedBytes };
  const cut = text.slice(0, lineEnd + 1);
  return { text: text.slice(lineEnd + 1), omittedBytes: omittedBytes + utf8Bytes(cut) };
}

/**
 * DSH's record of a shell command whose stdout it kept only the tail of: the
 * text from the first whole line on, and `headCut` so the row can say the
 * start is missing. Only stdout is read this way — it is where the body
 * starts; a stderr section keeps its text as it came. Anything without the
 * marker on stdout is returned unchanged.
 */
export function dshShellOutputHead(output: string): { text: string; headCut: boolean } {
  const marker = output.indexOf(DSH_OUTPUT_TRUNCATED_MARKER);
  if (marker < 0) return { text: output, headCut: false };
  // No stdout at all: the body opens on the stderr heading.
  if (output.startsWith(STDERR_HEADING)) return { text: output, headCut: false };
  const stderr = output.indexOf(`\n${STDERR_HEADING}`);
  // The marker belongs to stderr: stdout came through whole.
  if (stderr >= 0 && stderr < marker) return { text: output, headCut: false };
  const lineEnd = output.indexOf('\n');
  // The kept stdout is one partial line: keep it rather than show nothing.
  if (lineEnd >= marker) return { text: output, headCut: true };
  return { text: output.slice(lineEnd + 1), headCut: true };
}
