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
/**
 * Every theme link loads with this media: fetched and parsed, but not applied. The switch applies
 * its sheet through the CSSOM (sheet.media) and marks the link with APPLIED_ATTR; the attribute
 * stays. Changing a link's media attribute makes Firefox drop the sheet and load it again (the
 * canvas would show neither theme meanwhile), and moving a link re-creates its sheet from the
 * attribute, so a link that has loaded is never moved (it is replaced by a new one) and its media
 * attribute is never changed.
 */
const INERT_MEDIA = 'not all';
const APPLIED_ATTR = 'data-hb-theme-applied';
const isApplied = (link: HTMLLinkElement) => link.hasAttribute(APPLIED_ATTR);

/** Applies a loaded theme link's sheet, synchronously and without reloading it. */
function applyLink(link: HTMLLinkElement): void {
  if (link.sheet) link.sheet.media.mediaText = 'all';
  link.setAttribute(APPLIED_ATTR, '');
}

function createThemeLink(doc: Document, href: string, slot: string): HTMLLinkElement {
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('media', INERT_MEDIA);
  link.href = href;
  link.setAttribute(SLOT_ATTR, slot);
  link.setAttribute(HREF_ATTR, href);
  return link;
}
const adoptedBySlot = new WeakMap<Document, Map<string, CSSStyleSheet[]>>();
/** The latest applyThemeStyles call per slot: only it switches the slot's styles. */
const latestBySlot = new WeakMap<Document, Map<string, object>>();
/** A user theme's scoped sheet → its source (base URL and CSS), to reuse it while unchanged. */
const themeSheetKeys = new WeakMap<CSSStyleSheet, string>();

function slotMap<T>(maps: WeakMap<Document, Map<string, T>>, doc: Document): Map<string, T> {
  let map = maps.get(doc);
  if (!map) {
    map = new Map();
    maps.set(doc, map);
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

/** Longest wait for a new theme's fonts and images before a theme switch (the browser's font block period). */
const PRELOAD_TIMEOUT_MS = 3_000;

/** FontFace descriptors and the @font-face properties they come from. */
const FACE_DESCRIPTORS: [string, string][] = [
  ['style', 'font-style'],
  ['weight', 'font-weight'],
  ['stretch', 'font-stretch'],
  ['unicodeRange', 'unicode-range'],
  ['featureSettings', 'font-feature-settings'],
  ['display', 'font-display'],
  ['ascentOverride', 'ascent-override'],
  ['descentOverride', 'descent-override'],
  ['lineGapOverride', 'line-gap-override'],
];

/**
 * A stylesheet an applyThemeStyles call switches in: a theme link, or a user theme's scoped CSS
 * text. `owner` (the link, or the sheet itself) keys the fonts preloaded for it.
 */
interface IncomingSheet {
  owner: object;
  sheet: CSSStyleSheet;
  /** Resolves the sheet's relative url()s. */
  base: string;
}

/** Faces loaded ahead for a theme link or sheet (preloadFonts), in document.fonts while it applies. */
const preloadedFaces = new WeakMap<object, { faces: FontFace[]; settled: Promise<unknown> }>();

/** The rules of `sheet`, or none for a cross-origin sheet. */
function rulesOf(sheet: CSSStyleSheet): CSSRule[] {
  try {
    return Array.from(sheet.cssRules); // throws for a cross-origin sheet
  } catch {
    return [];
  }
}

const URL_TOKEN = /url\(\s*(["']?)(.*?)\1\s*\)/g;

/** A copy of an @font-face rule as a FontFace (src resolved against its sheet), or null. */
function faceOf(rule: CSSFontFaceRule, base: string, Face: typeof FontFace): FontFace | null {
  const family = rule.style.getPropertyValue('font-family').trim().replace(/^(["'])(.*)\1$/, '$2');
  // url()s as written are relative to the sheet.
  const src = rule.style
    .getPropertyValue('src')
    .replace(URL_TOKEN, (_, _q: string, url: string) => `url(${JSON.stringify(new URL(url, base).href)})`);
  if (!family || !src) return null;
  const descriptors: Record<string, string> = {};
  for (const [key, property] of FACE_DESCRIPTORS) {
    const value = rule.style.getPropertyValue(property).trim();
    if (value) descriptors[key] = value;
  }
  try {
    return new Face(family, src, descriptors);
  } catch {
    return null; // a rule the FontFace constructor rejects: its own face loads when used
  }
}

/**
 * Starts loading, as FontFace objects outside document.fonts, the @font-face rules of incoming
 * sheets (whose faces the document doesn't know yet), and resolves when all have settled.
 * addPreloadedFonts adds them to document.fonts when the sheets apply, so the new theme's text
 * shows at once instead of going invisible while its fonts load.
 */
async function preloadFonts(incoming: IncomingSheet[], doc: Document): Promise<void> {
  const win = doc.defaultView;
  if (!win?.FontFace || !win.CSSFontFaceRule || !doc.fonts) return;
  const pending: Promise<unknown>[] = [];
  for (const { owner, sheet, base } of incoming) {
    let entry = preloadedFaces.get(owner);
    if (!entry) {
      const faces = rulesOf(sheet)
        .flatMap((rule) => (rule instanceof win.CSSFontFaceRule ? [faceOf(rule, base, win.FontFace)] : []))
        .filter((f) => f !== null);
      entry = { faces, settled: Promise.allSettled(faces.map((face) => face.load())) };
      preloadedFaces.set(owner, entry);
    }
    pending.push(entry.settled);
  }
  await Promise.all(pending);
}

const PSEUDO_ELEMENT = /::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button)\b/g;

/**
 * The url()s of `sheet`'s style rules that match an element in `doc`, resolved. Every declaration
 * counts, custom properties and shorthands included (Blank's `--wc: url(…)`, used by a mask).
 */
function usedImageUrls({ sheet, base }: IncomingSheet, doc: Document): Set<string> {
  const urls = new Set<string>();
  const win = doc.defaultView;
  if (!win?.CSSStyleRule) return urls;
  const visit = (rules: CSSRule[]) => {
    for (const rule of rules) {
      if (rule instanceof win.CSSStyleRule) {
        const found = Array.from(rule.style.cssText.matchAll(URL_TOKEN)).flatMap(([, , url]) => (url ? [url] : []));
        let used = false;
        if (found.length) {
          try {
            used = doc.querySelector(rule.selectorText.replace(PSEUDO_ELEMENT, '')) !== null;
          } catch {
            // a selector querySelector can't take
          }
        }
        if (used) {
          for (const url of found) {
            try {
              urls.add(new URL(url, base).href);
            } catch {
              // not a URL
            }
          }
        }
      }
      if ('cssRules' in rule) visit(Array.from((rule as CSSGroupingRule).cssRules)); // @media, @layer, nesting
    }
  };
  visit(rulesOf(sheet));
  return urls;
}

/**
 * Loads (and decodes) the images the incoming sheets' rules put on elements already in the
 * document, so the new theme's page textures and borders paint from the cache at the switch.
 */
function preloadImages(incoming: IncomingSheet[], doc: Document): Promise<unknown> {
  const urls = new Set(incoming.flatMap((s) => [...usedImageUrls(s, doc)]));
  return Promise.allSettled(
    Array.from(urls, (url) => {
      const img = doc.createElement('img');
      img.src = url;
      return img.decode();
    }),
  );
}

/** Puts the preloaded faces of `owners` in document.fonts (a face added last wins over the sheet's own). */
function addPreloadedFonts(owners: object[], doc: Document): void {
  for (const owner of owners) for (const face of preloadedFaces.get(owner)?.faces ?? []) doc.fonts?.add(face);
}

/** Removes the faces preloaded for a link or sheet that no longer applies. */
function removePreloadedFonts(owner: object, doc: Document): void {
  for (const face of preloadedFaces.get(owner)?.faces ?? []) doc.fonts?.delete(face);
  preloadedFaces.delete(owner);
}

/** Removes a theme link and the faces preloaded for it. */
function removeLink(link: HTMLLinkElement): void {
  removePreloadedFonts(link, link.ownerDocument);
  link.remove();
}

function setAdoptedSheets(doc: Document, slot: string, sheets: CSSStyleSheet[]): void {
  const bySlot = slotMap(adoptedBySlot, doc);
  const previous = new Set(bySlot.get(slot) ?? []);
  if (previous.size === 0 && sheets.length === 0) return;
  const others = doc.adoptedStyleSheets.filter((s) => !previous.has(s));
  doc.adoptedStyleSheets = [...others, ...sheets];
  for (const sheet of previous) if (!sheets.includes(sheet)) removePreloadedFonts(sheet, doc);
  if (sheets.length) bySlot.set(slot, sheets);
  else bySlot.delete(slot);
}

/**
 * Removes every link and adopted sheet of `slot`, whichever applyThemeStyles call added them.
 * Use it when the slot's owner goes away: an AppliedThemeStyles result only knows its own links,
 * and a later apply to the same slot may have added others.
 */
export function disposeThemeSlot(slot: string, doc: Document = document): void {
  slotMap(latestBySlot, doc).delete(slot); // a pending apply must not switch styles back in
  for (const link of Array.from(doc.head.querySelectorAll<HTMLLinkElement>(`link[${SLOT_ATTR}]`))) {
    if (link.getAttribute(SLOT_ATTR) === slot) removeLink(link);
  }
  if ('adoptedStyleSheets' in doc) setAdoptedSheets(doc, slot, []);
}

/**
 * Attaches a theme chain (and optional user CSS) to the document, replacing what the same slot
 * had before. Links that are already in place are reused (no reload). Resolves once every
 * stylesheet has loaded, failed or timed out; check `failed`.
 *
 * The switch is atomic: new links load inert (media "not all") while the slot's previous styles
 * stay applied, then, once every link has settled, the new links (applied through the CSSOM, see
 * INERT_MEDIA), the CSS text and the removal of the previous links take effect together (one
 * task, no paint between), so the canvas never shows a half-applied theme. When a newer call for the same slot is made meanwhile, only that
 * one switches.
 */
export async function applyThemeStyles(
  chain: Pick<ThemeChain, 'styles'>,
  userCss?: string | null,
  options: ApplyThemeStylesOptions = {},
): Promise<AppliedThemeStyles> {
  const doc = options.document ?? document;
  const slot = options.slot ?? 'canvas';
  const head = doc.head;
  const token = {};
  slotMap(latestBySlot, doc).set(slot, token);

  // <link>s for URL styles, in chain order, in front of the app's own stylesheets.
  const existing = new Map<string, HTMLLinkElement>();
  for (const link of Array.from(head.querySelectorAll<HTMLLinkElement>(`link[${SLOT_ATTR}]`))) {
    if (link.getAttribute(SLOT_ATTR) === slot) existing.set(link.getAttribute(HREF_ATTR) ?? '', link);
  }
  const showing = Array.from(existing.values()).some(isApplied);
  const links: HTMLLinkElement[] = [];
  for (const style of chain.styles) {
    if (style.kind !== 'url') continue;
    let link = existing.get(style.href);
    if (link) existing.delete(style.href);
    else link = createThemeLink(doc, style.href, slot);
    links.push(link);
  }
  // Still applied until the switch below.
  const stale = new Set(existing.values());

  // Keep the slot's links contiguous and ordered. A link already in <head> that is out of place is
  // replaced by a new one (loading inert, from the cache) instead of moved: moving it would
  // re-create its sheet (see INERT_MEDIA). Stale links in between don't count: they go at the switch.
  const nextKept = (node: ChildNode): ChildNode | null => {
    let next = node.nextSibling;
    while (next && stale.has(next as HTMLLinkElement)) next = next.nextSibling;
    return next;
  };
  let cursor: ChildNode | null = links.length ? styleAnchor(head) : null;
  for (let i = links.length - 1; i >= 0; i--) {
    let link = links[i]!;
    if (link.parentNode === head && nextKept(link) !== cursor) {
      stale.add(link);
      link = links[i] = createThemeLink(doc, link.getAttribute(HREF_ATTR) ?? link.href, slot);
    }
    if (link.parentNode !== head) head.insertBefore(link, cursor);
    cursor = link;
  }

  // CSS text (user themes, then the brew's own CSS), scoped at runtime. A user theme's sheet that
  // the slot already shows is reused, so only a theme that changed preloads (not every CSS edit).
  const current = slotMap(adoptedBySlot, doc).get(slot) ?? [];
  const shownThemeSheets = new Map<string, CSSStyleSheet>();
  for (const sheet of current) {
    const key = themeSheetKeys.get(sheet);
    if (key !== undefined) shownThemeSheets.set(key, sheet);
  }
  const themeTexts = chain.styles.flatMap((s) => (s.kind === 'css' ? [{ css: s.css, baseUrl: s.baseUrl ?? doc.baseURI }] : []));
  let skippedCss = 0;
  const sheets: CSSStyleSheet[] = [];
  const incomingSheets: IncomingSheet[] = [];
  if (options.scopeCss) {
    for (const t of themeTexts) {
      const key = `${t.baseUrl}\n${t.css}`;
      let sheet = shownThemeSheets.get(key);
      if (!sheet) {
        sheet = options.scopeCss(t.css, t.baseUrl);
        themeSheetKeys.set(sheet, key);
        incomingSheets.push({ owner: sheet, sheet, base: t.baseUrl });
      }
      sheets.push(sheet);
    }
    if (userCss) sheets.push(options.scopeCss(userCss, doc.baseURI));
  } else {
    skippedCss = themeTexts.length + (userCss ? 1 : 0);
    if (skippedCss) console.warn(`[themeLoader] ${skippedCss} CSS text(s) not applied: pass scopeCss (cssScope.ts) to applyThemeStyles.`);
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const results = await Promise.all(links.map((link) => waitForLink(link, timeoutMs)));
  const failed = links.filter((_, i) => !results[i]).map((link) => link.getAttribute(HREF_ATTR) ?? link.href);

  // A switch from styles on screen: the incoming sheets' fonts and images first (theme links and
  // user themes' CSS), so the new theme's text doesn't go invisible and its textures don't paint
  // in late. (A first load has nothing on screen to keep.)
  const incoming: IncomingSheet[] = [...incomingSheets];
  for (const link of links) {
    if (!isApplied(link) && link.sheet) incoming.push({ owner: link, sheet: link.sheet, base: link.sheet.href ?? link.href });
  }
  const preloadMs = Math.min(timeoutMs, PRELOAD_TIMEOUT_MS);
  if ((showing || current.length > 0) && incoming.length && preloadMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([preloadFonts(incoming, doc), preloadImages(incoming, doc)]),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, preloadMs))),
    ]);
    clearTimeout(timer);
  }

  // The switch, unless a newer call (or disposeThemeSlot) owns the slot now.
  if (slotMap(latestBySlot, doc).get(slot) === token) {
    addPreloadedFonts(incoming.map((s) => s.owner), doc);
    for (const link of links) if (!isApplied(link)) applyLink(link);
    if ('adoptedStyleSheets' in doc) setAdoptedSheets(doc, slot, sheets);
    for (const link of stale) removeLink(link);
  }

  return {
    slot,
    links,
    sheets,
    failed,
    skippedCss,
    dispose: () => {
      for (const link of links) removeLink(link);
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
