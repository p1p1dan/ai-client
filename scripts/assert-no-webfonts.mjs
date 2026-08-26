#!/usr/bin/env node
/**
 * [FB9-5]: no webfont may reach the renderer bundle.
 *
 * `globals.css` states the rule ("this repo has no @font-face and no font
 * assets; naming a non-system family here is a blank cheque"), and until FB9 it
 * held by accident — nothing on the path had a font to bring. KaTeX does: its
 * HTML renderer ships 20 woff2 + 20 woff + 20 ttf, and importing
 * `katex/dist/katex.min.css` inlines all of them. Measured: the produced CSS
 * goes from 24.7KB to 1.46MB.
 *
 * A source scan (`[FB9-7]`) already forbids that import, but a source scan can
 * only forbid the ONE route it knows about. This checks the artifact, which is
 * the thing the rule is actually about — and it runs where builds happen
 * (`dist:prereq`) rather than as a unit test that would have to skip itself
 * whenever `out/` is absent, which is a test that passes by not looking.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'out', 'renderer');
const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf', '.eot'];

if (!existsSync(TARGET)) {
  console.error(`[assert-no-webfonts] ${TARGET} does not exist — run the renderer build first.`);
  process.exit(1);
}

/** @type {string[]} */
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(TARGET);

const fontFiles = files.filter((file) => FONT_EXTENSIONS.some((ext) => file.endsWith(ext)));
// An inlined face never lands as a file — it rides inside the CSS as a data URI.
const inliningFiles = files
  .filter((file) => file.endsWith('.css') || file.endsWith('.js'))
  .filter((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes('@font-face') || /data:(?:font|application\/font)/.test(text);
  });

if (fontFiles.length > 0 || inliningFiles.length > 0) {
  console.error('[assert-no-webfonts] the no-bundled-webfont red line is broken:');
  for (const file of fontFiles) console.error(`  font asset: ${file.slice(ROOT.length)}`);
  for (const file of inliningFiles) console.error(`  inlined face: ${file.slice(ROOT.length)}`);
  console.error(
    '\nThe usual cause is an `import "katex/dist/katex.min.css"` — KaTeX only needs\n' +
      'those faces for its HTML renderer, and `rehype-katex` is configured with\n' +
      "`output: 'mathml'` precisely so it does not."
  );
  process.exit(1);
}

console.log(`[assert-no-webfonts] OK — ${files.length} files in out/renderer, no webfonts.`);
