// Inline the Lucide icons used by prototype.html as an SVG sprite, so the page
// stays a single file with no external dependency. Same approach as
// ../sidebar-hierarchy-2026-10/gen-icons.mjs (issue #3), plus the icons issue #6
// adds: `chevrons-down-up` (the Repositories title's "collapse all" button),
// `trash-2` (the third hover action on a temporary-workspace row), for v2 the
// home entry, the SessionBar toggles and the center column stand-ins, and for v3
// the real composer's icons and LeftNav's no-repository card.
//
// Usage: node gen-icons.mjs [prototype.html]
// Rewrites the block between <!--ICONS:BEGIN--> and <!--ICONS:END--> in place.
// Icon shapes are read from the repo's own lucide-react (same version the app ships).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, process.argv[2] ?? 'prototype.html');
const iconDir = resolve(here, '../../../../../../node_modules/lucide-react/dist/esm/icons');

const NAMES = [
  // LeftNav
  'search',
  'plus',
  'folder-plus',
  'list-checks',
  'list-filter',
  'chevrons-down-up', // issue #6: collapse every repository folder
  'folder',
  'folder-open',
  'chevron-down',
  'chevron-right',
  'ellipsis', // MoreHorizontal
  'archive',
  'x',
  'trash-2', // DeleteTempButton
  'shield-question',
  'loader-circle', // Spinner (Loader2)
  'check',
  // issue #6 v2: home entry, SessionBar, start screen, composer stand-in
  'house',
  'arrow-left-right',
  'layers',
  'users',
  'messages-square',
  'arrow-up',
  // issue #6 v3: the real composer on the home page (ChatComposer, ComposerTargetBar,
  // LockedRepoLabel, RunLocationIndicator, BranchSwitcher, ComposerRoundButton,
  // ComposerPermissionTrigger) and LeftNav's no-repository card
  'lock',
  'monitor',
  'server',
  'send-horizontal', // SendHorizonal
  'square',
  'list-plus',
  'shield',
  'chevrons-up-down',
  'folder-git-2',
  // LeftDock rail
  'message-square',
  'git-branch',
  'file-code',
  'square-terminal',
  'activity',
  'panel-left-close',
  'blocks',
  'settings',
];

function iconNode(name) {
  let src = readFileSync(resolve(iconDir, `${name}.js`), 'utf8');
  // Renamed icons are re-export stubs (shield-question -> shield-question-mark).
  const alias = src.match(/export \{ default \} from '\.\/([\w-]+)\.js'/);
  if (alias) src = readFileSync(resolve(iconDir, `${alias[1]}.js`), 'utf8');
  const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\n/);
  if (!m) throw new Error(`cannot parse icon ${name}`);
  // The node is a plain JS array literal (unquoted keys), not JSON.
  return new Function(`return ${m[1]}`)();
}

function toSymbol(name) {
  const children = iconNode(name)
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${children}</symbol>`;
}

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${NAMES.map(toSymbol).join('\n')}\n</svg>`;
const html = readFileSync(target, 'utf8');
const begin = '<!--ICONS:BEGIN-->';
const end = '<!--ICONS:END-->';
const i = html.indexOf(begin);
const j = html.indexOf(end);
if (i < 0 || j < i) throw new Error('icon markers not found');
writeFileSync(target, `${html.slice(0, i + begin.length)}\n${sprite}\n${html.slice(j)}`);
console.log(`inlined ${NAMES.length} icons into ${target}`);
