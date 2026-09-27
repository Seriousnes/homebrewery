// HTML export (P6.4, plan §5, §11): the brew as one self-contained .html file that opens offline.
//
//   1. the document (the editor's, settled first, or ProseMirror JSON) → serializeBrew: the DOM of
//      a read-only editor (div.pages › div.page#p{n} with its chrome, header rows in <thead>)
//   2. collectExportCss: the theme chain's scoped stylesheets, the app's canvas CSS, user-theme and
//      brew CSS scoped as the editor scopes them, every url() absolute
//   3. the layout probe (probe.ts): the file laid out in a hidden iframe tells which headings the
//      theme keeps out of tables of contents, which url()s the page really uses, and the page size
//   4. TOCs filled; same-origin files the page uses (theme fonts and images, /assets images in the
//      brew) fetched and written in as data: URIs; other sites' images and fonts stay links and are
//      listed in the report; scripts, event handlers and script URLs removed; a CSP forbids scripts
//   5. exportDocumentHtml: body.hb-canvas › div.pages, plus print rules: one brew page per sheet,
//      the page size as the default @page size (theme and brew @page rules still win)
import { type Editor, getSchema, type JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import type { ThemeChain } from '../canvas/themeLoader';
import { settleNow } from '../pagination';
import { schemaExtensions } from '../schema';
import { collectHeadings, type TocHeading } from '../toc';
import { cssUrls, dedupeFontFaces, replaceCssUrls } from './cssText';
import { collectExportCss, exportStylesheets } from './exportCss';
import { exportDocumentHtml, serializeHtml } from './html';
import { createIframeProbe, type ExportProbe, type ExportProbeResult, HEADING_INDEX_ATTR } from './probe';
import { absoluteUrl, classifyUrl, fetchDataUris, type FetchLike, type InlinedFile } from './resources';
import { fillTocs, type SerializedBrew, serializeBrew, stripActiveContent } from './serialize';

/** The brew to export: an editor (its current document, pagination finished first) or a document. */
export type ExportSource = Editor | PMNode | JSONContent;

export interface ExportBrewOptions {
  /** The theme chain (EditorCanvas's status.chain, or loadThemeChain). */
  chain: Pick<ThemeChain, 'styles'>;
  /** The brew's own CSS (its style). */
  userCss?: string;
  /** The brew's language (<html lang>). Default 'en'. */
  lang?: string;
  /** The brew's title (<title> and the file name). */
  title?: string;
  /** The URL relative URLs resolve against, and whose origin counts as "this site". Default: the page's. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** The layout probe (default: a hidden iframe). null: no probe (every url() inlined, no TOC exclusions, no page size). */
  probe?: ExportProbe | null;
  /** Add ProseMirror's separator images, as Chromium shows them (default true). */
  separators?: boolean;
  signal?: AbortSignal;
}

export interface ExportReport {
  pages: number;
  /** Size of the file in bytes (UTF-8). */
  bytes: number;
  /** Files written in as data: URIs. */
  inlined: number;
  /** Their size in bytes (before base64). */
  inlinedBytes: number;
  /** Files of other sites (images, fonts) the page uses: left as links, shown only online. */
  external: string[];
  /** Files of this site that could not be fetched (left as links), and stylesheets that failed. */
  failed: string[];
  /** Scripts, event handlers and script URLs removed from the brew's HTML. */
  removed: number;
  /** The default @page size written ("8.5in 11in"), or null when pages differ in size or weren't measured. */
  pageSize: string | null;
  /** false when fonts were still loading when the probe gave up waiting. */
  fontsSettled: boolean;
}

export interface ExportResult {
  html: string;
  /** A file name for the download ("<title>.html"). */
  filename: string;
  report: ExportReport;
}

const isEditor = (source: ExportSource): source is Editor =>
  typeof (source as Editor).view === 'object' && typeof (source as Editor).state === 'object' && (source as Editor).state !== null;

const isNode = (source: ExportSource): source is PMNode =>
  typeof (source as PMNode).nodeSize === 'number' && typeof (source as PMNode).type?.schema === 'object';

let jsonSchema: ReturnType<typeof getSchema> | null = null;

/** The ProseMirror document of `source`. An editor finishes pagination first (as printing does). */
export function exportDocument(source: ExportSource): PMNode {
  if (isEditor(source)) {
    try {
      if (!source.isDestroyed) settleNow(source.view);
    } catch {
      // A detached view: export what is there.
    }
    return source.state.doc;
  }
  if (isNode(source)) return source;
  jsonSchema ??= getSchema(schemaExtensions);
  return PMNode.fromJSON(jsonSchema, source);
}

/** A file name for `title`: characters that file systems reject replaced, at most 100 characters. */
export function exportFileName(title: string | undefined, extension: 'html' | 'pdf' = 'html'): string {
  const base = (title ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[\s.]+$/, '')
    .replace(/^[\s.]+/, '');
  return `${base || 'brew'}.${extension}`;
}

/**
 * The default @page rule: no margins (a brew page fills its sheet) and, when every page has the
 * same size, that size, so the file prints one brew page per sheet whatever paper the printer
 * dialog starts with. It comes first: theme and brew @page rules override it.
 *
 * The size is the measured one in px, unrounded: layout sizes are exact binary fractions of a
 * px (Chromium 1/64, Firefox 1/60), so the sheet is exactly as tall as the page. A sheet rounded
 * a hair shorter would push a sliver of every page onto the next sheet.
 */
export function pageRule(sizes: readonly { width: number; height: number }[]): { css: string; size: string | null } {
  const first = sizes[0];
  const uniform = first !== undefined && first.width > 0 && first.height > 0 && sizes.every((s) => Math.abs(s.width - first.width) < 0.01 && Math.abs(s.height - first.height) < 0.01);
  const px = (value: number) => `${+value.toFixed(6)}px`;
  const size = uniform ? `${px(first.width)} ${px(first.height)}` : null;
  return { css: size ? `@page {\n  size: ${size};\n  margin: 0;\n}` : '@page {\n  margin: 0;\n}', size };
}

type UrlUse = 'inline' | 'link';

/** How an element's URL attribute is treated: fetched and written in, made absolute, or left alone. */
function urlAttributeUse(el: Element, name: string): UrlUse | null {
  const tag = el.localName;
  if (name === 'src') return tag === 'img' ? 'inline' : ['video', 'audio', 'source', 'track', 'embed', 'iframe'].includes(tag) ? 'link' : null;
  if (name === 'poster') return tag === 'video' ? 'inline' : null;
  if (name === 'href' || name === 'xlink:href') return tag === 'image' || tag === 'feImage' ? 'inline' : tag === 'a' || tag === 'area' ? 'link' : null;
  return null;
}

/** Relative URLs in the pages made absolute (the file lives elsewhere); fragments left alone. */
function absolutizePageUrls(root: Element, baseUrl: string): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'style') {
        const next = replaceCssUrls(attr.value, (url) => (/^(?:data:|#)/i.test(url.trim()) ? null : absoluteUrl(url, baseUrl)));
        if (next !== attr.value) el.setAttribute('style', next);
        continue;
      }
      if (!urlAttributeUse(el, attr.name)) continue;
      const value = attr.value.trim();
      if (value === '' || value.startsWith('#') || /^data:/i.test(value)) continue;
      const href = absoluteUrl(value, baseUrl);
      if (href && href !== attr.value) el.setAttribute(attr.name, href);
    }
    // The file is offline: an image's srcset would only point back at the site.
    if (el.localName === 'img' && el.hasAttribute('src') && el.hasAttribute('srcset')) {
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
    }
  }
}

/** The URLs the pages' own HTML wants written in: images and inline-style url()s. */
function pageInlineUrls(root: Element, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'style') {
        for (const url of cssUrls(attr.value)) {
          if (/^#/.test(url.trim())) continue;
          const href = absoluteUrl(url, baseUrl);
          if (href) urls.push(href);
        }
      } else if (urlAttributeUse(el, attr.name) === 'inline') {
        const href = absoluteUrl(attr.value, baseUrl);
        if (href) urls.push(href);
      }
    }
  }
  return urls;
}

/** Writes the fetched files into the pages (attributes and inline styles). */
function inlinePageUrls(root: Element, baseUrl: string, files: ReadonlyMap<string, InlinedFile | null>): void {
  const dataUri = (url: string) => {
    const href = absoluteUrl(url, baseUrl);
    return (href && files.get(href)?.dataUri) ?? null;
  };
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'style') {
        const next = replaceCssUrls(attr.value, dataUri);
        if (next !== attr.value) el.setAttribute('style', next);
      } else if (urlAttributeUse(el, attr.name) === 'inline') {
        const uri = dataUri(attr.value);
        if (uri) el.setAttribute(attr.name, uri);
      }
    }
  }
}

function markHeadings(serialized: SerializedBrew): void {
  serialized.headings.forEach((el, i) => el.setAttribute(HEADING_INDEX_ATTR, String(i)));
}

function unmarkHeadings(serialized: SerializedBrew): void {
  for (const el of serialized.headings) el.removeAttribute(HEADING_INDEX_ATTR);
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * Exports the brew as one self-contained HTML document (see the file header). The fetches and the
 * probe need a browser; `probe: null` and a `fetch` make it run anywhere with a DOM.
 */
export async function exportBrewHtml(source: ExportSource, options: ExportBrewOptions): Promise<ExportResult> {
  const doc = exportDocument(source);
  const baseUrl = options.baseUrl ?? document.baseURI;
  const origin = new URL(baseUrl).origin;
  const lang = options.lang?.trim() || 'en';
  const title = options.title?.trim() || 'Brew';
  const signal = options.signal;

  // Stylesheets (fetched, scoped, url()s absolute); a font file repeated by several themes of
  // the chain is defined once.
  const css = await collectExportCss(options.chain, options.userCss ?? '', { baseUrl, fetch: options.fetch, signal });
  const seenFaces = new Set<string>();
  const stylesheets = exportStylesheets(css).map((s) => ({ name: s.group, css: dedupeFontFaces(s.css, seenFaces).css }));

  // The pages, with absolute URLs and without active content.
  const serialized = serializeBrew(doc, { separators: options.separators });
  const removed = stripActiveContent(serialized.pages);
  absolutizePageUrls(serialized.pages, baseUrl);
  fillTocs(serialized, doc);

  const documentHtml = (styles: { name: string; css: string }[]) =>
    exportDocumentHtml({ lang, title, styles, pages: serializeHtml(serialized.pages) });

  // Lay the file out once: TOC exclusions, the url()s it uses, the page size.
  let probed: ExportProbeResult | null = null;
  const probe = options.probe === undefined ? createIframeProbe() : options.probe;
  if (probe) {
    markHeadings(serialized);
    try {
      probed = await probe(documentHtml([{ name: 'page', css: pageRule([]).css }, ...stylesheets]));
    } finally {
      unmarkHeadings(serialized);
    }
    signal?.throwIfAborted();
  }
  if (probed) {
    const headings = collectHeadings(doc);
    const excluded = new Set<number>();
    for (const index of probed.excludedHeadings) {
      const heading = headings[index];
      if (heading) excluded.add(heading.pos);
    }
    fillTocs(serialized, doc, (heading: TocHeading) => excluded.has(heading.pos));
  }

  // Which files to write in: the stylesheets' url()s the page uses (all of them without a
  // probe), and the pages' images. Other sites' files are only listed.
  const wanted = new Set<string>();
  for (const sheet of stylesheets) {
    for (const url of cssUrls(sheet.css)) {
      if (/^(?:data:|#)/i.test(url.trim())) continue;
      const href = absoluteUrl(url, baseUrl);
      if (href && (!probed || probed.cssUrls.has(href))) wanted.add(href);
    }
  }
  for (const href of pageInlineUrls(serialized.pages, baseUrl)) wanted.add(href);
  const sameOrigin: string[] = [];
  const external: string[] = [];
  for (const href of wanted) {
    const kind = classifyUrl(href, baseUrl, origin);
    if (kind === 'same-origin') sameOrigin.push(href);
    else if (kind === 'external') external.push(href);
  }
  const files = await fetchDataUris(sameOrigin, { fetch: options.fetch, signal });

  // Write them in.
  const dataUri = (url: string) => {
    const href = absoluteUrl(url, baseUrl);
    return (href && files.get(href)?.dataUri) ?? null;
  };
  const page = pageRule(probed?.pageSizes ?? []);
  const styles = [{ name: 'page', css: page.css }, ...stylesheets.map((s) => ({ name: s.name, css: replaceCssUrls(s.css, dataUri) }))];
  inlinePageUrls(serialized.pages, baseUrl, files);
  const html = documentHtml(styles);

  let inlined = 0;
  let inlinedBytes = 0;
  const failed = [...css.failed];
  for (const [url, file] of files) {
    if (file) {
      inlined++;
      inlinedBytes += file.bytes;
    } else failed.push(url);
  }
  return {
    html,
    filename: exportFileName(options.title),
    report: {
      pages: doc.childCount,
      bytes: utf8Length(html),
      inlined,
      inlinedBytes,
      external: external.sort(),
      failed,
      removed,
      pageSize: page.size,
      fontsSettled: probed?.fontsSettled ?? true,
    },
  };
}
