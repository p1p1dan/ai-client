import ts from 'typescript';

/**
 * Blank every comment in a TS/TSX source, leaving the code — string literals,
 * template literals and regex literals included — character for character.
 *
 * Shared by the static-scan suites in this directory and in
 * `workspace-shell/__tests__` (`chatMarkdownPolicy`, `fontDomainScan`,
 * `composerFormStatic`, `composerTargetGuards`, `contextPanelMountStatic`,
 * `terminalSurfaceStatic`, `deadControlsStatic`), each of which scans source for a name its own doc
 * comments have to spell in order to explain the ban: `rehype-raw`,
 * `dangerouslySetInnerHTML`, `SelectTrigger`, `font-mono`. Without a strip, the
 * scans would fail on the explanation; with the wrong strip, they pass on
 * nothing at all.
 *
 * ## Why the TypeScript parser, and not a pair of regexes
 *
 * All four suites used to carry a private copy of
 *
 * ```
 * source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
 * ```
 *
 * which has no idea what a string is. It therefore deleted CODE — silently, and
 * in the one direction that makes a negative assertion pass. Five shapes were
 * reproduced against this repo's own tree, and all five are regression cases in
 * `chatMarkdownPolicy.test.ts`:
 *
 *  1. a string literal containing `//` (`{ u: 'a//b' }`) eats the rest of its
 *     line, and with it any banned token that follows;
 *  2. a template literal containing `` `//` `` does the same;
 *  3. `'data:text/plain,//example'` does the same — the `[^:]` guard only ever
 *     protected the shape where the colon is IMMEDIATELY in front (`https://`),
 *     which is not the shape a `data:` url has;
 *  4. a regex literal that ends in an escaped slash (`/^\/\//`) ends in the
 *     characters `\`, `/`, `/`, so the line-comment rule fires on the literal
 *     itself and eats the rest of the line;
 *  5. a `'/*'` inside a string pairs with the next REAL block-comment
 *     terminator and deletes every line between the two.
 *
 * A hand-written lexer closes all five, but only by re-solving JavaScript's
 * regex-versus-division ambiguity — which is the very bug class above, and in a
 * `.tsx` file it also has to know that `</div>` is not the start of a regex.
 * `typescript` is already a devDependency and its parser answers exactly that
 * question, so the scans borrow the answer instead of re-deriving it.
 *
 * ## Why blanking rather than deleting
 *
 * Every comment character becomes a space and every newline inside a comment is
 * kept, so offsets, line numbers and line counts survive the strip: `^…$`
 * line-anchored patterns, "look at a window of N lines around the match" scans
 * and reported positions all still line up with the file on disk. Deleting a
 * block comment instead JOINS the code on either side of it, which is a second
 * way to manufacture a match that is not in the source.
 *
 * The consequence for callers: the stripped text is always the same LENGTH as
 * the input, so "did the strip do anything" has to be asked of the non-blank
 * content, never of `.length`.
 */
export function stripComments(source: string, fileName: string): string {
  const key = `${fileName.length}:${fileName}${source}`;
  const cached = strippedCache.get(key);
  if (cached !== undefined) return cached;
  const stripped = blankCommentRanges(source, fileName);
  strippedCache.set(key, stripped);
  return stripped;
}

/**
 * Keyed by name + exact content, so it is a memo rather than state: the
 * tree-wide scans strip the same 400-odd files two or three times per run, and
 * a parse is ~2ms where the regex it replaces was ~0.005ms.
 */
const strippedCache = new Map<string, string>();

function blankCommentRanges(source: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    // `.ts` and `.tsx` are different grammars — `<Foo>bar` is a type assertion
    // in one and an unclosed JSX element in the other — so the kind is taken
    // from the caller's real filename rather than guessed.
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out = source.split('');
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    // Leaves only: every comment in a file sits in the trivia of exactly one
    // token — the ones at the very end belong to `EndOfFileToken` — so visiting
    // each leaf once visits each comment once.
    //
    // BOTH queries, at the same position, because they split the trivia between
    // them rather than overlapping: `getLeadingCommentRanges` starts collecting
    // only after the first line break (unless the position is 0), so on its own
    // it silently keeps every same-line `code; // note` comment in the output —
    // measured on this tree at 278 of 2397 files. `getTrailingCommentRanges`
    // collects from the position up to that same first line break and stops.
    // Neither is complete; the union is.
    const start = node.getFullStart();
    const ranges = [
      ...(ts.getTrailingCommentRanges(source, start) ?? []),
      ...(ts.getLeadingCommentRanges(source, start) ?? []),
    ];
    for (const range of ranges) {
      for (let i = range.pos; i < range.end; i += 1) {
        if (out[i] !== '\n') out[i] = ' ';
      }
    }
  };
  visit(sourceFile);
  return out.join('');
}
