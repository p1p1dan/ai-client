import type { HighlighterCore } from 'shiki/core';
import { type ChatCodeLanguage, type ChatCodeToken, normalizeCodeLanguage } from './chatMarkdown';

/**
 * T-29: the chat timeline's syntax highlighter — a lazily loaded, process-wide
 * singleton that hands back shiki's TOKEN model, never an HTML string.
 *
 * ## Why tokens instead of `codeToHtml` (the repo's existing route)
 *
 * `ui/code-block.tsx` calls `codeToHtml` and injects the result through
 * `dangerouslySetInnerHTML`. That is defensible for a file the user opened; it
 * is the wrong shape for assistant output, where the code fence's contents are
 * attacker-influenceable and the audit question "can this string become markup?"
 * should have a structural answer rather than a review-time one.
 *
 * `codeToTokens` gives that structurally. The renderer (`ChatCodeBlock.tsx`)
 * turns each token into `<span style={…}>{token.content}</span>`, so the code
 * text crosses into the DOM as a React TEXT CHILD — escaped by React, with no
 * parser in the path. `codeToHast` + `hast-util-to-jsx-runtime` would reach the
 * same place, but only by depending on a package that is currently a TRANSITIVE
 * dependency of `react-markdown` (present today because `.npmrc` sets
 * `node-linker=hoisted`, which is not a contract), and by re-introducing a
 * property/attribute mapping layer this component has no use for. The token
 * model needs neither.
 *
 * ## Why every shiki import here is dynamic
 *
 * `shiki/core`, its regex engine and each theme are several hundred KB of
 * JavaScript, and a session with no code fence in it must not pay for them.
 * Everything below is `await import(...)` inside a function body, so Rollup
 * emits them as async chunks and the first fenced block in a session is what
 * fetches them. The only static import in this file is `import type`, which is
 * erased at build time.
 *
 * ## Theme
 *
 * `vitesse-light` / `vitesse-dark`, the pair `ui/code-block.tsx` already uses,
 * so a fenced block in chat and the same block in the file preview are coloured
 * identically. shiki ships no Flexoki theme, and authoring one would mean a full
 * TextMate scope mapping maintained by hand against a palette that already has
 * a documented source of truth — a large surface for a difference nobody asked
 * for. What IS taken from Flexoki is the box: `ChatCodeBlock` paints the
 * background and border from our own tokens and leaves shiki's `bg` unused, so
 * the block sits on a Flexoki surface with vitesse token colours on top.
 */

/** Shiki theme ids, paired to the app's resolved light/dark state. */
export const CHAT_SHIKI_THEMES = {
  light: 'vitesse-light',
  dark: 'vitesse-dark',
} as const;

/**
 * One promise for the whole renderer process. Deliberately module-level rather
 * than React state: a highlighter held in state would re-create per component
 * tree, and — more importantly — a `useState` holding it would make every code
 * block that finishes loading re-render its ancestors. Nothing here is
 * reactive; `ChatCodeBlock` keeps only its own token array in state.
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;

/** Grammars already registered on the singleton, so a repeated fence costs nothing. */
const loadedLanguages = new Set<ChatCodeLanguage>();

/** Grammars whose dynamic import failed — never retried, so a broken chunk cannot loop. */
const failedLanguages = new Set<ChatCodeLanguage>();

/**
 * Lazily import each supported grammar.
 *
 * Written out as a literal map rather than a computed `import(\`shiki/langs/${id}.mjs\`)`
 * on purpose: a template-literal import makes the bundler emit a chunk for
 * EVERY file matching the pattern (shiki ships ~200 grammars), which would put
 * the whole language set into the build output whether or not it is reachable.
 * A literal map is statically analysable, so only these entries are emitted.
 */
const LANGUAGE_LOADERS: Record<ChatCodeLanguage, () => Promise<unknown>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  // `shell` / `bash` are both alias modules re-exporting ONE `shellscript`
  // grammar, and that grammar carries its own `aliases: ['bash','sh','shell',
  // 'zsh']`, so either specifier registers all four ids. `shell.mjs` is chosen
  // to match `ui/code-block.tsx` byte for byte, which lets the bundler share the
  // chunk instead of emitting a second re-export stub.
  shell: () => import('shiki/langs/shell.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [core, engine, dark, light] = await Promise.all([
        import('shiki/core'),
        // The JS regex engine, not oniguruma: the WASM build would add a binary
        // asset to the renderer bundle and an instantiation step, and the JS
        // engine is what `ui/code-block.tsx` already runs on.
        import('shiki/engine/javascript'),
        import('shiki/themes/vitesse-dark.mjs'),
        import('shiki/themes/vitesse-light.mjs'),
      ]);
      return core.createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [],
        engine: engine.createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

async function ensureLanguage(
  highlighter: HighlighterCore,
  language: ChatCodeLanguage
): Promise<boolean> {
  if (loadedLanguages.has(language)) return true;
  if (failedLanguages.has(language)) return false;
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return false;
  try {
    const grammar = await loader();
    await highlighter.loadLanguage(grammar as Parameters<typeof highlighter.loadLanguage>[0]);
    loadedLanguages.add(language);
    return true;
  } catch {
    failedLanguages.add(language);
    return false;
  }
}

/**
 * Highlight one fenced block, or return `null` for "render it plain".
 *
 * `null` is a normal outcome, not an error: an unknown language, a grammar
 * whose chunk failed to load, and a highlighter that could not be constructed
 * all land here, and the caller's un-highlighted `<pre>` is a correct rendering
 * of the same text in the same box.
 */
export async function highlightChatCode(input: {
  code: string;
  language: string | null;
  isDark: boolean;
}): Promise<ChatCodeToken[][] | null> {
  const language = normalizeCodeLanguage(input.language);
  if (!language) return null;
  try {
    const highlighter = await getHighlighter();
    if (!(await ensureLanguage(highlighter, language))) return null;
    const theme = input.isDark ? CHAT_SHIKI_THEMES.dark : CHAT_SHIKI_THEMES.light;
    const { tokens } = highlighter.codeToTokens(input.code, { lang: language, theme });
    return tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color,
        fontStyle: token.fontStyle,
      }))
    );
  } catch {
    return null;
  }
}
