// The import report (plan §7 "Import report", P6.3): what the conversion changed or couldn't
// keep, shown before the brew is saved.
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { VariablesMode } from './hbfm/renderer';
import type { VariableDefinition } from './hbfm/variables';
import type { PositionedInFlow } from './lift';
import type { SanitizeRemovals } from './sanitize';

export interface ClippedPage {
  /** 1-based page number in the imported brew. */
  page: number;
  /** Pages the content needs, estimated from the probe's overflow columns. */
  estimatedPages: number;
  /** Pages it actually grew into after pagination (set by recordPaginatedPages / setPaginatedPages). */
  paginatedPages?: number;
}

/** A source page that pagination turned into more than one page. */
export interface GrownPage {
  /** 1-based page number in the imported brew (= its manual page). */
  page: number;
  /** The manual page plus the auto pages that follow it. */
  pages: number;
}

export interface ImportReportData {
  /** Pages in the source (\page splits). */
  pages: number;
  theme: string;
  /** Pages that clipped content upstream (content that didn't fit was cut off). */
  clippedPages: ClippedPage[];
  variables: {
    /** 'expand': values were inlined as text; 'keep': variable syntax was left as written. */
    mode: VariablesMode;
    /** Definitions found (`[name]: value`, `$[name](value)`; page is 1-based). */
    definitions: VariableDefinition[];
    /**
     * `$[…]` calls left as text, per 1-based page: the unresolved ones ('expand'), or every
     * call ('keep').
     */
    unresolved: Array<{ page: number; call: string }>;
  };
  /**
   * After the imported document was paginated (recordPaginatedPages): its page count and the
   * source pages that grew into several pages. null until then.
   */
  paginated: { pages: number; grown: GrownPage[] } | null;
  /** rawHtml nodes kept (HTML the schema has no node for), with a short sample of each. */
  rawHtml: { count: number; samples: string[] };
  /** HTML comments dropped. */
  commentsDropped: number;
  /** <style> tags in the text, moved into the brew's CSS. */
  styleTagsLifted: number;
  /** Classes used in the document that no loaded stylesheet mentions; null if not checked. */
  unknownClasses: Array<{ name: string; count: number }> | null;
  /** What the sanitizer removed (by tag / attribute name). */
  sanitizer: SanitizeRemovals;
  /** Elements the schema has no rule for: their text is kept, their tag and attributes dropped. */
  transparentElements: Record<string, number>;
  /** Page chrome moved into page attributes. */
  lifted: { markers: number; footers: number; pageNumbers: number; objects: number };
  /** Absolutely positioned elements that stayed in the flow (not representable as objects). */
  positionedInFlow: Array<PositionedInFlow & { page: number }>;
  /** Details the page model can't keep (marker classes, footer formatting, …). */
  lost: string[];
  /** Other problems (theme not found, stylesheet failures, metadata errors). */
  warnings: string[];
}

const RAW_SAMPLE = 80;

/** Collects the report while hbfmToDoc runs; `toJSON()` gives the data. */
export class ImportReport {
  readonly data: ImportReportData;

  constructor(pages: number, theme: string, variables: VariablesMode = 'expand') {
    this.data = {
      pages,
      theme,
      clippedPages: [],
      variables: { mode: variables, definitions: [], unresolved: [] },
      paginated: null,
      rawHtml: { count: 0, samples: [] },
      commentsDropped: 0,
      styleTagsLifted: 0,
      unknownClasses: null,
      sanitizer: { elements: {}, attributes: {} },
      transparentElements: {},
      lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
      positionedInFlow: [],
      lost: [],
      warnings: [],
    };
  }

  warn(message: string): void {
    this.data.warnings.push(message);
  }

  addSanitizerRemovals(removed: SanitizeRemovals): void {
    for (const [k, v] of Object.entries(removed.elements)) this.data.sanitizer.elements[k] = (this.data.sanitizer.elements[k] ?? 0) + v;
    for (const [k, v] of Object.entries(removed.attributes)) this.data.sanitizer.attributes[k] = (this.data.sanitizer.attributes[k] ?? 0) + v;
  }

  addTransparent(tag: string): void {
    this.data.transparentElements[tag] = (this.data.transparentElements[tag] ?? 0) + 1;
  }

  /**
   * Hook for pagination (P4): after the imported document settles, record how many pages a
   * page that clipped upstream grew into. `page` is 1-based, as in clippedPages.
   */
  setPaginatedPages(page: number, pages: number): void {
    const entry = this.data.clippedPages.find((c) => c.page === page);
    if (entry) entry.paginatedPages = pages;
  }

  /** Counts from the finished document: rawHtml nodes; unknown classes against `known`. */
  inspect(doc: JSONContent, known: Set<string> | null): void {
    const used = new Map<string, number>();
    const count = (name: unknown) => {
      if (typeof name === 'string' && name) used.set(name, (used.get(name) ?? 0) + 1);
    };
    const visit = (node: JSONContent) => {
      if (node.type === 'rawHtml') {
        this.data.rawHtml.count++;
        const html = String(node.attrs?.html ?? '').replace(/\s+/g, ' ');
        if (this.data.rawHtml.samples.length < 20) this.data.rawHtml.samples.push(html.length > RAW_SAMPLE ? `${html.slice(0, RAW_SAMPLE)}…` : html);
      }
      const attrs = node.attrs ?? {};
      if (Array.isArray(attrs.classes)) attrs.classes.forEach(count);
      if (Array.isArray(attrs.markers)) attrs.markers.forEach(count);
      if (Array.isArray(attrs.objects)) for (const o of attrs.objects as Array<{ classes?: unknown }>) if (Array.isArray(o.classes)) o.classes.forEach(count);
      if (node.type === 'icon') {
        count(attrs.font);
        String(attrs.glyph ?? '').split(/\s+/).forEach(count);
      }
      for (const mark of node.marks ?? []) if (Array.isArray(mark.attrs?.classes)) (mark.attrs.classes as unknown[]).forEach(count);
      node.content?.forEach(visit);
    };
    visit(doc);
    if (known) {
      this.data.unknownClasses = [...used]
        .filter(([name]) => !known.has(name))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count }));
    }
  }

  toJSON(): ImportReportData {
    return this.data;
  }
}

type PageKindSource = JSONContent | PMNode;

/** The `kind` attribute of every page of a document (JSON or ProseMirror node). */
function pageKinds(doc: PageKindSource): unknown[] {
  if ('forEach' in doc && typeof doc.forEach === 'function' && 'childCount' in doc) {
    const kinds: unknown[] = [];
    (doc as PMNode).forEach((page) => kinds.push(page.attrs.kind));
    return kinds;
  }
  return ((doc as JSONContent).content ?? []).map((page): unknown => page.attrs?.kind);
}

/**
 * Pages per section: every manual page (one per source page after an import) plus the auto
 * pages pagination added after it. `[1, 3, 1]` = source page 2 now spans three pages.
 */
export function sectionPageCounts(doc: PageKindSource): number[] {
  const counts: number[] = [];
  for (const kind of pageKinds(doc)) {
    if (kind === 'auto' && counts.length) counts[counts.length - 1]! += 1;
    else counts.push(1);
  }
  return counts;
}

/**
 * The report hook for pagination (plan §7 "pages that previously clipped content, and how many
 * pages they grew into"): call it with the imported document once pagination has settled
 * (isSettled). Returns a new report: `paginated` filled in, and `paginatedPages` set on every
 * clipped page. The document must not have been edited since the import (page i+1 of the
 * source is the i-th manual page).
 */
export function recordPaginatedPages(report: ImportReportData, doc: PageKindSource): ImportReportData {
  const counts = sectionPageCounts(doc);
  const grown: GrownPage[] = counts.flatMap((pages, i) => (pages > 1 ? [{ page: i + 1, pages }] : []));
  return {
    ...report,
    clippedPages: report.clippedPages.map((c) => ({ ...c, paginatedPages: counts[c.page - 1] ?? c.paginatedPages })),
    paginated: { pages: counts.reduce((a, b) => a + b, 0), grown },
  };
}
