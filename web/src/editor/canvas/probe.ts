// A hidden, laid-out canvas for measuring HTML with a brew's theme and CSS (plan §7): the
// importer mounts upstream-shaped pages in it and asks computed styles which elements are page
// objects, markers, and so on.
//
//   const probe = await mountProbe('5ePHB', brewCss);
//   probe.root.innerHTML = pagesHtml;          // div.page › div.columnWrapper …
//   await Promise.all([probe.fontsReady(), probe.imagesReady?.()]);
//   … probe.window.getComputedStyle(el) …
//   probe.dispose();
//
// The probe is a same-origin, sandboxed (no scripts) iframe placed off screen: its theme links,
// user CSS and fonts can't touch the editor's document (theme sheets apply to every .hb-canvas
// of a document), and the editor's canvas.css can't touch the probe. Its DOM is
//   html › body › div.hb-canvas[lang] › div.pages (= root)
// with the upstream base styles (reset + core + Open Sans, upstreamBase.ts), the theme chain (themeLoader:
// the API bundle, or the static catalog) and the user CSS scoped to .hb-canvas (cssScope.ts).
// Leading @import rules of the user CSS are kept as real @imports inside the probe (fonts load).
import { OPEN_SANS_CSS, PROBE_LAYOUT_CSS, UPSTREAM_BASE_CSS } from '../import/upstreamBase';
import { extractCssImports, scopeCssText } from './cssScope';
import { applyThemeStyles, loadThemeChain, waitForFonts, type LoadThemeChainOptions, type ThemeChain } from './themeLoader';

export interface Probe {
  /** div.pages inside the probe: put the div.page elements here. */
  root: HTMLElement;
  /** div.hb-canvas, root's parent. */
  canvas: HTMLElement;
  document: Document;
  /** The probe document's window (use its getComputedStyle). */
  window: Window;
  /** The theme chain that was applied, or null (theme not found / not loaded). */
  chain: ThemeChain | null;
  /** Stylesheets that failed to load. */
  failedStyles: string[];
  /** Resolves once web fonts used by root have loaded (false on timeout). */
  fontsReady(timeoutMs?: number): Promise<boolean>;
  /**
   * Resolves once every image under root has loaded or failed (false on timeout), so layout and
   * natural sizes are final. Lazy images are not waited for. Optional: a probe without it is
   * treated as ready.
   */
  imagesReady?(timeoutMs?: number): Promise<boolean>;
  /** Class names that appear in the probe's stylesheets (theme chain + user CSS). */
  stylesheetClasses(): Set<string>;
  dispose(): void;
}

export interface MountProbeOptions {
  /** The document the iframe is added to (default: document). */
  document?: Document;
  /** A chain already loaded (skips loadThemeChain). */
  chain?: ThemeChain | null;
  /** Options for loadThemeChain (fetch, signal, source). */
  themeOptions?: LoadThemeChainOptions;
  /** lang of the canvas (hyphenation), default 'en'. */
  lang?: string;
  /** Probe viewport width in CSS px (default 1100: a page plus room for overflow). */
  width?: number;
}

const CLASS_IN_SELECTOR = /\.(-?[_a-zA-Z\u00A0-\uFFFF][-_a-zA-Z0-9\u00A0-\uFFFF]*)/g;

function collectClasses(rules: CSSRuleList | undefined, out: Set<string>, depth = 0): void {
  if (!rules || depth > 8) return;
  for (const rule of Array.from(rules)) {
    const r = rule as CSSRule & { selectorText?: string; cssRules?: CSSRuleList; styleSheet?: CSSStyleSheet | null };
    if (typeof r.selectorText === 'string') {
      for (const m of r.selectorText.matchAll(CLASS_IN_SELECTOR)) out.add(m[1]!);
    }
    try {
      if (r.styleSheet) collectClasses(r.styleSheet.cssRules, out, depth + 1); // @import
    } catch {
      // cross-origin import: not readable
    }
    if (r.cssRules) collectClasses(r.cssRules, out, depth + 1); // @media, @supports, nesting, …
  }
}

/**
 * Resolves true once every image under `root` has loaded or failed, false after `timeoutMs`.
 * Images with loading=lazy are left out: off screen, they never load.
 */
export function waitForImages(root: ParentNode, timeoutMs = 10_000): Promise<boolean> {
  const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete && img.loading !== 'lazy');
  if (pending.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = pending.length;
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      for (const img of pending) {
        img.removeEventListener('load', one);
        img.removeEventListener('error', one);
      }
      resolve(settled);
    };
    const one = () => {
      if (--left === 0) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    for (const img of pending) {
      img.addEventListener('load', one, { once: true });
      img.addEventListener('error', one, { once: true });
    }
  });
}

/** Scoped user CSS as text for a <style> element, keeping its leading @imports. */
export function probeUserCss(css: string, baseURL: string): string {
  if (!css.trim()) return '';
  const imports = extractCssImports(css).map((i) => i.statement);
  let scoped: string;
  try {
    scoped = scopeCssText(css, baseURL);
  } catch {
    scoped = ''; // CSS the CSSOM can't parse at all
  }
  return `${imports.join('\n')}\n${scoped}`;
}

/**
 * Mounts a probe canvas for `themeKey` with `userCss` (the brew's CSS; scoped to the canvas).
 * The theme is loaded with loadThemeChain; a theme that can't be loaded leaves `chain` null and
 * the probe unstyled apart from the base styles.
 */
export async function mountProbe(themeKey: string, userCss = '', options: MountProbeOptions = {}): Promise<Probe> {
  const parent = options.document ?? document;
  const iframe = parent.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.title = 'Import layout probe';
  const width = options.width ?? 1100;
  iframe.style.cssText = `position:fixed;left:-${width + 20000}px;top:0;width:${width}px;height:1200px;border:0;visibility:hidden;pointer-events:none;`;
  parent.body.appendChild(iframe);

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) {
    iframe.remove();
    throw new Error('mountProbe: the probe iframe has no document.');
  }
  doc.open();
  doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
  doc.close();

  const base = doc.createElement('style');
  base.setAttribute('data-hb-probe', 'base');
  base.textContent = [OPEN_SANS_CSS, UPSTREAM_BASE_CSS, PROBE_LAYOUT_CSS].join('\n');
  doc.head.appendChild(base);

  let chain: ThemeChain | null = options.chain ?? null;
  const failedStyles: string[] = [];
  if (chain === null && options.chain === undefined) {
    try {
      chain = await loadThemeChain(themeKey, options.themeOptions);
    } catch (error) {
      failedStyles.push(`theme ${themeKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (chain) {
    // URL styles as <link>s (themeLoader puts them in front of the base <style>); CSS-text
    // styles (user themes) as scoped <style>s, since constructed sheets can't cross documents.
    const applied = await applyThemeStyles(
      { styles: chain.styles.filter((s) => s.kind === 'url') },
      null,
      { document: doc, slot: 'probe' },
    );
    failedStyles.push(...applied.failed);
    for (const style of chain.styles) {
      if (style.kind !== 'css') continue;
      const el = doc.createElement('style');
      el.setAttribute('data-hb-probe', 'user-theme');
      el.textContent = probeUserCss(style.css, style.baseUrl ?? parent.baseURI);
      doc.head.appendChild(el);
    }
  }
  // The theme links go first (as in the editor), the base reset stays at zero specificity.
  const user = doc.createElement('style');
  user.setAttribute('data-hb-probe', 'user');
  user.textContent = probeUserCss(userCss, parent.baseURI);
  doc.head.appendChild(user);

  const canvas = doc.createElement('div');
  canvas.className = 'hb-canvas';
  canvas.lang = options.lang ?? 'en';
  const root = doc.createElement('div');
  root.className = 'pages';
  canvas.appendChild(root);
  doc.body.appendChild(canvas);

  return {
    root,
    canvas,
    document: doc,
    window: win,
    chain,
    failedStyles,
    fontsReady: (timeoutMs = 10_000) => waitForFonts({ document: doc, root, timeoutMs }),
    imagesReady: (timeoutMs = 10_000) => waitForImages(root, timeoutMs),
    stylesheetClasses: () => {
      const out = new Set<string>();
      for (const sheet of Array.from(doc.styleSheets)) {
        try {
          collectClasses(sheet.cssRules, out);
        } catch {
          // cross-origin sheet
        }
      }
      return out;
    },
    dispose: () => iframe.remove(),
  };
}

/**
 * A probe without layout for environments that can't lay out (jsdom unit tests): a detached
 * .hb-canvas in the given document, no theme. Computed styles then only see inline styles.
 */
export function mountInlineProbe(options: { document?: Document; lang?: string } = {}): Probe {
  const doc = options.document ?? document;
  const win = doc.defaultView ?? window;
  const canvas = doc.createElement('div');
  canvas.className = 'hb-canvas';
  canvas.lang = options.lang ?? 'en';
  const root = doc.createElement('div');
  root.className = 'pages';
  canvas.appendChild(root);
  doc.body.appendChild(canvas);
  return {
    root,
    canvas,
    document: doc,
    window: win,
    chain: null,
    failedStyles: [],
    fontsReady: () => Promise.resolve(true),
    imagesReady: () => Promise.resolve(true), // jsdom never loads images
    stylesheetClasses: () => new Set<string>(),
    dispose: () => canvas.remove(),
  };
}
