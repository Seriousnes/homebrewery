// Markdown brew → document (plan §7, P6.2).
//
//   const { doc, style, meta, report } = await hbfmToDoc(brewText);
//
// 1. Split metadata, CSS and markdown (brewText.ts); reject renderer: legacy.
// 2. Split pages with the V3 regex; read `\page {…}` tags with the HBFM lexer.
// 3. Render every page twice with the HBFM renderer (hbfm/renderer.ts, no marked-variables and
//    no expr-eval: brew text is untrusted): variables defined on later pages resolve on the
//    second pass, as upstream's forced re-render did. `variables: 'keep'` leaves variable
//    syntax as written instead. No trailing `\column` hack (plan §4.2).
// 4. Convert legacy-renderer stat blocks (legacyStatBlocks.ts). Lift <style> tags into the brew CSS, drop comments, sanitize (sanitize.ts), wrap each page
//    in div.page[data-kind=manual] › div.columnWrapper with the \page line's classes and styles.
// 5. Mount the pages in the probe (canvas/probe.ts: the brew's theme and CSS), wait for fonts
//    and images; read the images' natural sizes (imageSizes.ts).
// 6. Lift page-level pieces (lift.ts): markers, footer, page number, positioned objects.
// 7. generateJSON with the schema's parse rules; image nodes get their natural size (plan §6.6).
// The report (importReport.ts) lists what was changed or lost.
import { generateJSON, type JSONContent } from '@tiptap/core';
import { mountProbe, type Probe } from '../canvas/probe';
import type { LoadThemeChainOptions } from '../canvas/themeLoader';
import { markMultilineDefinitionLists, schemaExtensions } from '../schema';
import { splitTextStyleAndMetadata, type BrewMetadata } from './brewText';
import { createHbfmRenderer, type VariablesMode } from './hbfm/renderer';
import { applyNaturalSizes, naturalImageSizes } from './imageSizes';
import { ImportReport, type ImportReportData } from './importReport';
import { convertLegacyStatBlocks } from './legacyStatBlocks';
import { analyzePage, applyLift } from './lift';
import { buildPageElement, pageLine, pageShellFromTags, splitPages, stripPageLine } from './pages';
import { sanitizeImportHtmlDetailed } from './sanitize';

export const DEFAULT_IMPORT_THEME = '5ePHB';

export type ImportErrorCode = 'legacy-renderer';

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export interface HbfmToDocOptions {
  /** Theme to lay the pages out with (default: the brew's metadata theme, then 5ePHB). */
  theme?: string;
  /** Probe factory (tests pass mountInlineProbe); default mountProbe. */
  probe?: (theme: string, css: string, lang: string) => Promise<Probe>;
  /** Passed to loadThemeChain by the default probe. */
  themeOptions?: LoadThemeChainOptions;
  /** How long to wait for web fonts before lifting (default 10 s). */
  fontsTimeoutMs?: number;
  /** How long to wait for the images to load or fail, at the same time as the fonts (default 10 s). */
  imagesTimeoutMs?: number;
  /**
   * Brew variables: 'expand' (default; plan §1 "imports keep the expanded text") substitutes
   * them with the importer's own safe port; 'keep' leaves `[name]: value` and `$[name]` as
   * written. Both list the definitions in the report.
   */
  variables?: VariablesMode;
}

export interface HbfmImportResult {
  doc: JSONContent;
  /** The brew CSS: the ```css block plus any <style> tags found in the text. */
  style: string;
  /** Metadata from the ```metadata block. */
  meta: BrewMetadata;
  report: ImportReportData;
  /** The page HTML handed to generateJSON (after lifting), for debugging and tests. */
  html: string;
}

/** Elements with no schema rule: their text survives, their tag and attributes don't. */
const TRANSPARENT_TAGS = new Set([
  'font', 'small', 'big', 'mark', 'ins', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time', 'dfn',
  'tt', 'bdi', 'bdo', 'ruby', 'label', 'nobr', 'caption',
]);
/** Mark tags whose attributes the marks don't keep. */
const MARK_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'sub', 'sup', 'code']);

interface RenderedPage {
  html: string;
  classes: string[];
  styles: Record<string, string>;
  attributes: Record<string, string>;
}

/**
 * Comments out, <style> contents collected, legacy stat blocks converted (legacyStatBlocks.ts);
 * the rest re-serialized (inert template parse).
 */
function extractStylesAndComments(html: string, doc: Document): { html: string; styles: string[]; comments: number; statBlocks: number } {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const walker = doc.createTreeWalker(template.content, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
  const styles: string[] = [];
  for (const style of Array.from(template.content.querySelectorAll('style'))) {
    if ((style.textContent ?? '').trim()) styles.push(style.textContent ?? '');
    style.remove();
  }
  const statBlocks = convertLegacyStatBlocks(template.content, doc);
  return { html: template.innerHTML, styles, comments: comments.length, statBlocks };
}

function countTransparent(root: Element, report: ImportReport): void {
  for (const el of Array.from(root.querySelectorAll('.columnWrapper *'))) {
    const tag = el.tagName.toLowerCase();
    if (el.closest('svg')) continue;
    if (TRANSPARENT_TAGS.has(tag)) report.addTransparent(tag);
    else if (tag === 'span' && !el.classList.contains('inline-block') && el.attributes.length > 0) report.addTransparent('span (without inline-block)');
    else if (MARK_TAGS.has(tag) && !(tag === 'i' && el.classList.length) && (el.hasAttribute('style') || el.hasAttribute('class') || el.hasAttribute('id')))
      report.addTransparent(`${tag}[class|style|id]`);
    else if (tag === 'a' && (el.hasAttribute('style') || el.hasAttribute('class') || el.hasAttribute('id'))) report.addTransparent('a[class|style|id]');
  }
}

/**
 * Converts a brew text (optionally with ```metadata and ```css blocks) into a document.
 * Needs a browser: the probe lays the pages out with the brew's theme.
 */
export async function hbfmToDoc(raw: string, options: HbfmToDocOptions = {}): Promise<HbfmImportResult> {
  const brew = splitTextStyleAndMetadata({ text: raw });
  if (brew.renderer === 'legacy') {
    throw new ImportError('legacy-renderer', 'This brew uses the legacy renderer, which cannot be imported. Switch it to V3 upstream first.');
  }
  const { text, style: brewStyle, metadataError, ...meta } = brew;
  const theme = options.theme ?? brew.theme ?? DEFAULT_IMPORT_THEME;
  const pages = splitPages(text);
  const variables = options.variables ?? 'expand';
  const report = new ImportReport(pages.length, theme, variables);
  if (metadataError) report.warn(`Metadata block ignored: ${metadataError}`);

  // Render twice: cross-page variables resolve on the second pass.
  const renderer = createHbfmRenderer({ variables });
  const bodies = pages.map(stripPageLine);
  bodies.forEach((body, i) => renderer.render(body, i));
  const inert = document.implementation.createHTMLDocument('');
  const styleTags: string[] = [];
  let legacyStatBlocks = 0;
  const rendered: RenderedPage[] = bodies.map((body, i) => {
    const line = pageLine(pages[i] ?? '');
    const shell = pageShellFromTags(line ? renderer.pageLineTags(line) : null);
    const extracted = extractStylesAndComments(renderer.render(body, i), inert);
    legacyStatBlocks += extracted.statBlocks;
    styleTags.push(...extracted.styles);
    report.data.commentsDropped += extracted.comments;
    const clean = sanitizeImportHtmlDetailed(extracted.html);
    // Comments the template parse turned up late (e.g. inside raw SVG) count as comments.
    const { '#comment': lateComments = 0, ...elements } = clean.removed.elements;
    report.data.commentsDropped += lateComments;
    report.addSanitizerRemovals({ elements, attributes: clean.removed.attributes });
    return { html: clean.html, ...shell };
  });
  report.data.styleTagsLifted = styleTags.length;
  if (legacyStatBlocks > 0) {
    const what = legacyStatBlocks === 1 ? 'A stat block' : `${legacyStatBlocks} stat blocks`;
    report.warn(`${what} in the legacy renderer’s style (a rule before a quote) became ${legacyStatBlocks === 1 ? 'a monster frame' : 'monster frames'}.`);
  }
  report.data.variables.definitions = renderer.variables.definitions.map((d) => ({ ...d, page: d.page + 1 }));
  for (const [page, calls] of renderer.variables.unresolved) for (const call of calls) report.data.variables.unresolved.push({ page: page + 1, call });

  const style = [brewStyle ?? '', ...styleTags].filter((s) => s.trim() !== '').join('\n\n');
  const html = rendered
    .map((p) => buildPageElement(inert, p, p.html, { 'data-kind': 'manual' }).outerHTML)
    .join('');

  const lang = brew.lang || 'en';
  const probe = await (options.probe ?? ((t: string, css: string, l: string) => mountProbe(t, css, { lang: l, themeOptions: options.themeOptions })))(theme, style, lang);
  try {
    if (!probe.chain && !options.probe) report.warn(`Theme "${theme}" could not be loaded; objects were detected without it.`);
    for (const failed of probe.failedStyles) report.warn(`Stylesheet not loaded: ${failed}`);
    probe.root.innerHTML = html;
    const [fontsLoaded, imagesLoaded] = await Promise.all([
      probe.fontsReady(options.fontsTimeoutMs),
      probe.imagesReady?.(options.imagesTimeoutMs) ?? true,
    ]);
    if (!fontsLoaded) report.warn('Web fonts did not finish loading; layout checks may be off.');
    if (!imagesLoaded) report.warn('Some images did not finish loading; layout checks may be off, and their sizes are recorded once they load in the editor.');
    // Read before lifting: image objects leave the flow, but share a file with inline images.
    const imageSizes = naturalImageSizes(probe.root);

    countTransparent(probe.root, report);
    const pageEls = Array.from(probe.root.querySelectorAll<HTMLElement>(':scope > .page'));
    // Read everything first: lifting changes computed styles (:has(.frontCover) …).
    const analyses = pageEls.map((el, i) => analyzePage(el, probe.window, i));
    analyses.forEach((analysis, i) => {
      if (analysis.clipped) report.data.clippedPages.push({ page: i + 1, estimatedPages: analysis.clipped.estimatedPages });
      for (const p of analysis.positionedInFlow) report.data.positionedInFlow.push({ ...p, page: i + 1 });
      const counts = applyLift(pageEls[i]!, analysis);
      report.data.lifted.markers += counts.markers;
      report.data.lifted.footers += counts.footers;
      report.data.lifted.pageNumbers += counts.pageNumbers;
      report.data.lifted.objects += counts.objects;
      report.data.lost.push(...counts.lost.map((l) => `page ${i + 1}: ${l}`));
    });

    markMultilineDefinitionLists(probe.root);
    const liftedHtml = probe.root.innerHTML;
    const doc = generateJSON(liftedHtml, schemaExtensions);
    applyNaturalSizes(doc, imageSizes);
    const known = probe.chain ? probe.stylesheetClasses() : null;
    report.inspect(doc, known);
    return { doc, style, meta, report: report.toJSON(), html: liftedHtml };
  } finally {
    probe.dispose();
  }
}
