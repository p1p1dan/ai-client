/**
 * Decision 209 §3: a window this page draws into — opened with
 * `window.open('about:blank', name)` (Main lets exactly one name through, as
 * a frameless window owned by the main window) and filled through a React
 * portal, so its state stays in this page and nothing is synced.
 *
 * An `about:blank` window has none of the app's styles, so they are mirrored:
 *  - a `<base>` first, so a stylesheet's relative URL (the packaged build's
 *    `./assets/…`) resolves against the app rather than `about:blank`;
 *  - every `<style>` and stylesheet `<link>` of the main document, kept in step
 *    as they change (Vite rewrites them in place during development);
 *  - the `<html>` and `<body>` attributes — the theme class, the font-size
 *    variables — so a theme switch reaches the window too.
 *
 * Closing the page (a reload, the main window going away) closes the window.
 */

export interface PopoutWindow {
  window: Window;
  /** Portal target, filling the window. */
  container: HTMLElement;
  /** Stop mirroring and close the window. */
  dispose: () => void;
}

const STYLE_SELECTOR = 'style, link[rel~="stylesheet"]';

function isStyleNode(node: Node): node is Element {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.matches(STYLE_SELECTOR);
}

function copyAttributes(from: Element, to: Element): void {
  for (const name of to.getAttributeNames()) {
    if (!from.hasAttribute(name)) to.removeAttribute(name);
  }
  for (const name of from.getAttributeNames()) {
    to.setAttribute(name, from.getAttribute(name) ?? '');
  }
}

/** Mirror `source`'s styles and root attributes into `target`; returns the stop. */
export function mirrorDocumentStyles(source: Document, target: Document): () => void {
  const base = target.createElement('base');
  base.href = source.baseURI;
  target.head.append(base);

  const clones = new Map<Element, Element>();
  const copy = (node: Element) => {
    const clone = target.importNode(node, true) as Element;
    const previous = clones.get(node);
    if (previous) previous.replaceWith(clone);
    else target.head.append(clone);
    clones.set(node, clone);
  };
  for (const node of source.head.querySelectorAll(STYLE_SELECTOR)) copy(node);

  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList' && record.target === source.head) {
        for (const node of record.addedNodes) if (isStyleNode(node)) copy(node);
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1) continue;
          clones.get(node as Element)?.remove();
          clones.delete(node as Element);
        }
        continue;
      }
      // A style's text or a link's href changed: copy that one again.
      let owner: Node | null = record.target;
      while (owner && !(owner.nodeType === 1 && isStyleNode(owner))) owner = owner.parentNode;
      if (owner && clones.has(owner as Element)) copy(owner as Element);
    }
  });
  headObserver.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  const syncRoots = () => {
    copyAttributes(source.documentElement, target.documentElement);
    if (source.body && target.body) copyAttributes(source.body, target.body);
  };
  syncRoots();
  const rootObserver = new MutationObserver(syncRoots);
  rootObserver.observe(source.documentElement, { attributes: true });
  if (source.body) rootObserver.observe(source.body, { attributes: true });

  return () => {
    headObserver.disconnect();
    rootObserver.disconnect();
  };
}

/**
 * Open (or take over) the window called `name`. Null when it cannot be opened
 * — Main refused it, or it is not same-origin — so the caller can fall back.
 */
export function openPopoutWindow(options: {
  name: string;
  title: string;
  width: number;
  height: number;
}): PopoutWindow | null {
  let popup: Window | null = null;
  try {
    popup = window.open(
      'about:blank',
      options.name,
      `popup,width=${options.width},height=${options.height}`
    );
  } catch {
    popup = null;
  }
  if (!popup) return null;
  let target: Document;
  try {
    target = popup.document;
    // A window left over from an earlier open keeps its old content.
    target.head.replaceChildren();
    target.body.replaceChildren();
  } catch {
    popup.close();
    return null;
  }
  target.title = options.title;
  const stopMirroring = mirrorDocumentStyles(document, target);

  const container = target.createElement('div');
  // The body's own attributes are the main page's (mirrored); the app's CSS
  // already zeroes its margin.
  container.style.height = '100vh';
  container.style.overflow = 'hidden';
  target.body.append(container);

  const closePopup = () => popup?.close();
  window.addEventListener('pagehide', closePopup);

  let disposed = false;
  return {
    window: popup,
    container,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopMirroring();
      window.removeEventListener('pagehide', closePopup);
      if (!popup?.closed) popup?.close();
    },
  };
}
