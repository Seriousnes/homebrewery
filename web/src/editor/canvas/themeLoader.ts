// Theme loading for the editing canvas (plan §5, §8.7).
//
//   const chain = await loadThemeChain('5ePHB');           // root first: Blank, 5ePHB
//   const applied = await applyThemeStyles(chain, userCss, { scopeCss });
//   await waitForFonts({ root: canvasElement });
//
// loadThemeChain asks the API for the theme bundle (GET /api/themes/{theme}/bundle, which also
// resolves user themes) and falls back to the static catalog /themes/themes.json (walking
// baseTheme) when the API is unavailable. Static theme stylesheets are the build-time scoped
// files (style.scoped.css, every selector under .hb-canvas); they are attached as <link>s at the
// start of <head>, so the editor's own CSS (canvas.css, loaded later) wins specificity ties.
//
// CSS text (user-theme CSS, the brew's own CSS) must be scoped at runtime. That is the canvas
// lane's cssScope.ts; pass it as `scopeCss`. Without it such CSS is not applied.

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** One stylesheet of a theme chain, in cascade order. */
export type ThemeStyle =
  | { kind: 'url'; href: string }
  /** CSS text (user themes). `baseUrl` resolves its relative url()s. */
  | { kind: 'css'; css: string; baseUrl?: string };

/** A snippet source: a static theme's snippet group id ("V3_5ePHB") or a user theme's snippets. */
export type ThemeSnippetRef = string | { name: string; snippets: unknown };

/** Response of GET /api/themes/{theme}/bundle (plan §8.7): the chain, root first. */
export interface ThemeBundle {
  name: string;
  author: string | null;
  styles: ThemeStyle[];
  snippets: ThemeSnippetRef[];
}

export interface ThemeChain extends ThemeBundle {
  /** The theme that was asked for. */
  theme: string;
  /** Where the chain came from. */
  source: 'api' | 'static';
}

/** One entry of /themes/themes.json (web/vite/generateAssetsPlugin.ts writes it). */
export interface ThemeCatalogEntry {
  key: string;
  name: string;
  renderer: 'V3';
  baseTheme: string | null;
  baseSnippets: string | null;
  path: string;
  style: string;
  scopedStyle: string;
  preview: string | null;
  texture: string | null;
  hasSnippets: boolean;
}

export interface ThemeCatalog {
  themes: ThemeCatalogEntry[];
}

export class ThemeLoadError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ThemeLoadError';
    this.status = status;
  }
}

/** Longest base-theme chain accepted (the server enforces the same limit). */
export const MAX_THEME_CHAIN = 8;
export const THEME_CATALOG_URL = '/themes/themes.json';
export const themeBundleUrl = (theme: string): string => `/api/themes/${encodeURIComponent(theme)}/bundle`;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LoadThemeChainOptions {
  /** 'auto' (default): API, then the static catalog. 'api' / 'static': only that source. */
  source?: 'auto' | 'api' | 'static';
  fetch?: FetchLike;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** GET /themes/themes.json. */
export async function loadThemeCatalog(options: Pick<LoadThemeChainOptions, 'fetch' | 'signal'> = {}): Promise<ThemeCatalog> {
  const fetchFn = options.fetch ?? defaultFetch;
  const response = await fetchFn(THEME_CATALOG_URL, { signal: options.signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ThemeLoadError(`Theme catalog: HTTP ${response.status}`, response.status);
  const catalog = (await response.json()) as Partial<ThemeCatalog>;
  if (!Array.isArray(catalog.themes)) throw new ThemeLoadError('Theme catalog: no themes array');
  return catalog as ThemeCatalog;
}

/** The chain for a static theme, root first (Blank, 5ePHB, 5eDMG). Pure. */
export function staticThemeChain(catalog: ThemeCatalog, theme: string): ThemeChain {
  const byKey = new Map(catalog.themes.map((t) => [t.key, t]));
  const entries: ThemeCatalogEntry[] = [];
  const visited = new Set<string>();
  for (let key: string | null = theme; key !== null; ) {
    const entry = byKey.get(key);
    if (!entry) throw new ThemeLoadError(`Unknown theme "${key}"`, 404);
    if (visited.has(key)) throw new ThemeLoadError(`Theme cycle at "${key}"`, 422);
    if (entries.length >= MAX_THEME_CHAIN) throw new ThemeLoadError(`Theme chain longer than ${MAX_THEME_CHAIN}`, 422);
    visited.add(key);
    entries.push(entry);
    key = entry.baseTheme;
  }
  entries.reverse();
  return {
    theme,
    source: 'static',
    name: byKey.get(theme)?.name ?? theme,
    author: null,
    styles: entries.map((e) => ({ kind: 'url', href: e.scopedStyle })),
    snippets: entries.map((e) => `${e.renderer}_${e.key}`),
  };
}

function parseBundle(theme: string, value: unknown): ThemeChain | null {
  if (value === null || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (!Array.isArray(b.styles)) return null;
  const styles: ThemeStyle[] = [];
  for (const s of b.styles as unknown[]) {
    if (s === null || typeof s !== 'object') return null;
    const style = s as Record<string, unknown>;
    if (style.kind === 'url' && typeof style.href === 'string') styles.push({ kind: 'url', href: style.href });
    else if (style.kind === 'css' && typeof style.css === 'string') {
      styles.push(typeof style.baseUrl === 'string' ? { kind: 'css', css: style.css, baseUrl: style.baseUrl } : { kind: 'css', css: style.css });
    } else return null;
  }
  const snippets = Array.isArray(b.snippets) ? (b.snippets as ThemeSnippetRef[]) : [];
  return {
    theme,
    source: 'api',
    name: typeof b.name === 'string' ? b.name : theme,
    author: typeof b.author === 'string' ? b.author : null,
    styles,
    snippets,
  };
}

/**
 * The theme chain for `theme` (a static theme key or a user theme's share id), root first.
 * Throws ThemeLoadError when neither source has it (status 404) or the chain is invalid (422).
 */
export async function loadThemeChain(theme: string, options: LoadThemeChainOptions = {}): Promise<ThemeChain> {
  const source = options.source ?? 'auto';
  const fetchFn = options.fetch ?? defaultFetch;

  if (source !== 'static') {
    let apiError: ThemeLoadError;
    try {
      const response = await fetchFn(themeBundleUrl(theme), {
        signal: options.signal,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (response.ok) {
        const chain = parseBundle(theme, await response.json().catch(() => null));
        if (chain) return chain;
        apiError = new ThemeLoadError(`Theme bundle for "${theme}": unexpected response`, response.status);
      } else {
        // A cycle or an over-long chain is a real answer about this theme: don't mask it.
        if (response.status === 422) throw new ThemeLoadError(`Theme "${theme}" has an invalid chain`, 422);
        apiError = new ThemeLoadError(`Theme bundle for "${theme}": HTTP ${response.status}`, response.status);
      }
    } catch (error) {
      if (error instanceof ThemeLoadError && error.status === 422) throw error;
      if (options.signal?.aborted) throw error;
      apiError = error instanceof ThemeLoadError ? error : new ThemeLoadError(`Theme bundle for "${theme}": ${String(error)}`);
    }
    if (source === 'api') throw apiError;
  }

  return staticThemeChain(await loadThemeCatalog(options), theme);
}

// ---------------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------------

/** Scopes CSS text to the canvas (cssScope.ts from the canvas lane). */
export type ScopeCss = (css: string, baseURL: string) => CSSStyleSheet;

export interface ApplyThemeStylesOptions {
  /**
   * Independent set of theme styles (default 'canvas'). Applying again to the same slot replaces
   * its styles; other slots are untouched. Note that every slot's sheets apply to every
   * .hb-canvas in the document.
   */
  slot?: string;
  /** Required to apply CSS text (user themes, user CSS); see the file header. */
  scopeCss?: ScopeCss;
  document?: Document;
  /** Give up waiting for a stylesheet after this long (default 15 s). */
  timeoutMs?: number;
}

export interface AppliedThemeStyles {
  slot: string;
  links: HTMLLinkElement[];
  /** Constructed (scoped) sheets in document.adoptedStyleSheets. */
  sheets: CSSStyleSheet[];
  /** hrefs that failed to load or timed out. */
  failed: string[];
  /** CSS texts not applied because no scopeCss was given. */
  skippedCss: number;
  /** Removes this slot's links and sheets. */
  dispose: () => void;
}

const SLOT_ATTR = 'data-hb-theme-slot';
const HREF_ATTR = 'data-hb-theme-href';
const adoptedBySlot = new WeakMap<Document, Map<string, CSSStyleSheet[]>>();

function slotSheets(doc: Document): Map<string, CSSStyleSheet[]> {
  let map = adoptedBySlot.get(doc);
  if (!map) {
    map = new Map();
    adoptedBySlot.set(doc, map);
  }
  return map;
}

/** First stylesheet in <head> that isn't a theme link: theme links go in front of it. */
function styleAnchor(head: HTMLHeadElement): ChildNode | null {
  for (const node of Array.from(head.childNodes)) {
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (child.hasAttribute(SLOT_ATTR)) continue;
    if (child.localName === 'style' || (child.localName === 'link' && /\bstylesheet\b/i.test(child.getAttribute('rel') ?? ''))) {
      return child;
    }
  }
  return null;
}

/** Links that have fired `load` (a reused link doesn't fire it again). */
const loadedLinks = new WeakSet<HTMLLinkElement>();

function waitForLink(link: HTMLLinkElement, timeoutMs: number): Promise<boolean> {
  if (loadedLinks.has(link) || link.sheet) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      link.removeEventListener('load', onLoad);
      link.removeEventListener('error', onError);
      if (ok) loadedLinks.add(link);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    link.addEventListener('load', onLoad);
    link.addEventListener('error', onError);
  });
}

function setAdoptedSheets(doc: Document, slot: string, sheets: CSSStyleSheet[]): void {
  const bySlot = slotSheets(doc);
  const previous = new Set(bySlot.get(slot) ?? []);
  if (previous.size === 0 && sheets.length === 0) return;
  const others = doc.adoptedStyleSheets.filter((s) => !previous.has(s));
  doc.adoptedStyleSheets = [...others, ...sheets];
  if (sheets.length) bySlot.set(slot, sheets);
  else bySlot.delete(slot);
}

/**
 * Removes every link and adopted sheet of `slot`, whichever applyThemeStyles call added them.
 * Use it when the slot's owner goes away: an AppliedThemeStyles result only knows its own links,
 * and a later apply to the same slot may have added others.
 */
export function disposeThemeSlot(slot: string, doc: Document = document): void {
  for (const link of Array.from(doc.head.querySelectorAll<HTMLLinkElement>(`link[${SLOT_ATTR}]`))) {
    if (link.getAttribute(SLOT_ATTR) === slot) link.remove();
  }
  if ('adoptedStyleSheets' in doc) setAdoptedSheets(doc, slot, []);
}

/**
 * Attaches a theme chain (and optional user CSS) to the document, replacing what the same slot
 * had before. Links that are already in place are reused (no reload). Resolves once every
 * stylesheet has loaded, failed or timed out; check `failed`.
 */
export async function applyThemeStyles(
  chain: Pick<ThemeChain, 'styles'>,
  userCss?: string | null,
  options: ApplyThemeStylesOptions = {},
): Promise<AppliedThemeStyles> {
  const doc = options.document ?? document;
  const slot = options.slot ?? 'canvas';
  const head = doc.head;

  // <link>s for URL styles, in chain order, in front of the app's own stylesheets.
  const existing = new Map<string, HTMLLinkElement>();
  for (const link of Array.from(head.querySelectorAll<HTMLLinkElement>(`link[${SLOT_ATTR}]`))) {
    if (link.getAttribute(SLOT_ATTR) === slot) existing.set(link.getAttribute(HREF_ATTR) ?? '', link);
  }
  const links: HTMLLinkElement[] = [];
  for (const style of chain.styles) {
    if (style.kind !== 'url') continue;
    let link = existing.get(style.href);
    if (link) existing.delete(style.href);
    else {
      link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = style.href;
      link.setAttribute(SLOT_ATTR, slot);
      link.setAttribute(HREF_ATTR, style.href);
    }
    links.push(link);
  }
  for (const stale of existing.values()) stale.remove();

  // Keep the slot's links contiguous and ordered, moving only those out of place.
  let cursor: ChildNode | null = links.length ? styleAnchor(head) : null;
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i]!;
    if (link.parentNode !== head || link.nextSibling !== cursor) head.insertBefore(link, cursor);
    cursor = link;
  }

  // CSS text (user themes, then the brew's own CSS), scoped at runtime.
  const texts = chain.styles.flatMap((s) => (s.kind === 'css' ? [{ css: s.css, baseUrl: s.baseUrl ?? doc.baseURI }] : []));
  if (userCss) texts.push({ css: userCss, baseUrl: doc.baseURI });
  let skippedCss = 0;
  const sheets: CSSStyleSheet[] = [];
  if (options.scopeCss) {
    for (const t of texts) sheets.push(options.scopeCss(t.css, t.baseUrl));
  } else if (texts.length) {
    skippedCss = texts.length;
    console.warn(`[themeLoader] ${skippedCss} CSS text(s) not applied: pass scopeCss (cssScope.ts) to applyThemeStyles.`);
  }
  if ('adoptedStyleSheets' in doc) setAdoptedSheets(doc, slot, sheets);

  const timeoutMs = options.timeoutMs ?? 15_000;
  const results = await Promise.all(links.map((link) => waitForLink(link, timeoutMs)));
  const failed = links.filter((_, i) => !results[i]).map((link) => link.getAttribute(HREF_ATTR) ?? link.href);

  return {
    slot,
    links,
    sheets,
    failed,
    skippedCss,
    dispose: () => {
      for (const link of links) link.remove();
      if ('adoptedStyleSheets' in doc) setAdoptedSheets(doc, slot, []);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

export interface WaitForFontsOptions {
  document?: Document;
  /** Element whose layout is flushed first, so the fonts it uses start loading. */
  root?: Element | null;
  /** Load every @font-face of the loaded sheets, not only the ones in use (slower, deterministic). */
  loadAll?: boolean;
  /** Give up after this long (default 10 s). */
  timeoutMs?: number;
}

/**
 * Resolves true once no font is loading (document.fonts.ready, re-checked in case layout started
 * new loads), or false on timeout. Without the FontFaceSet API (jsdom) it resolves true at once.
 * Pagination must also listen for later `loadingdone` events (plan §4.7); this is the gate for
 * the first layout.
 */
export async function waitForFonts(options: WaitForFontsOptions = {}): Promise<boolean> {
  const doc = options.document ?? document;
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return true;
  options.root?.getBoundingClientRect();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), options.timeoutMs ?? 10_000);
  });
  const settle = async (): Promise<true> => {
    if (options.loadAll) {
      await Promise.allSettled(
        Array.from(fonts as unknown as Iterable<FontFace>)
          .filter((face) => face.status === 'unloaded')
          .map((face) => face.load()),
      );
    }
    for (let round = 0; round < 5; round++) {
      await fonts.ready;
      options.root?.getBoundingClientRect();
      if (fonts.status !== 'loading') break;
    }
    return true;
  };
  try {
    return await Promise.race([settle(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
