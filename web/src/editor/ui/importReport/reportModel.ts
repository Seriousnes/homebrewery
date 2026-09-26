// The import report in words (plan §7 "Import report", P6.3): one item per thing the import
// changed or couldn't keep, from ImportReportData (web/src/editor/import/importReport.ts). Pure, so
// the wording is unit-tested and the view only lays it out.
//
// The plan's items are always listed, with 0 when nothing happened: pages that clipped upstream
// (and how many pages they grew into once paginated), variable definitions, raw HTML kept,
// comments dropped, unknown classes, tags that lost their attributes. The others appear only when
// they have something to say.
import type { ImportReportData } from '@/editor/import/importReport';

export type ReportTone = 'neutral' | 'info' | 'warning';

/** The layout pass of the preview: not started or running, settled, or impossible (no preview). */
export type LayoutState = 'pending' | 'done' | 'unavailable';

export interface ReportDetails {
  /** The list's accessible name. */
  label: string;
  items: string[];
  /** Show the items as code (HTML samples, tag and class names). */
  code?: boolean;
}

export interface ReportItem {
  /** Stable id (test ids: import-report-<id>). */
  id: string;
  label: string;
  /** What is counted; null when it wasn't checked. */
  count: number | null;
  summary: string;
  tone: ReportTone;
  details?: ReportDetails;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sum = (record: Record<string, number>): number => Object.values(record).reduce((a, b) => a + b, 0);
/** "name ×3", biggest first. */
const counted = (record: Record<string, number>, show: (name: string) => string = (n) => n): string[] =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${show(name)} ×${n}`);

/** The pages the report counts: source pages, and after pagination when it is known. */
function pagesItem(report: ImportReportData, layout: LayoutState): ReportItem {
  const source = plural(report.pages, 'page');
  let summary: string;
  if (report.paginated) summary = `${source} in the source; ${plural(report.paginated.pages, 'page')} once laid out with the theme.`;
  else if (layout === 'pending') summary = `${source} in the source. Laying out the pages…`;
  else summary = `${source} in the source.`;
  return { id: 'pages', label: 'Pages', count: report.paginated?.pages ?? report.pages, summary, tone: 'neutral' };
}

function clippedItem(report: ImportReportData, layout: LayoutState): ReportItem {
  const clipped = report.clippedPages;
  const n = clipped.length;
  const pending = !report.paginated && layout === 'pending';
  return {
    id: 'clipped',
    label: 'Pages cut off on the Homebrewery',
    count: n,
    summary:
      n === 0
        ? 'None: every page fit.'
        : `Content ran past the bottom of ${plural(n, 'page')} and was hidden on the Homebrewery. Here it flows onto new pages instead.`,
    tone: n ? 'info' : 'neutral',
    details: n
      ? {
          label: 'Pages that were cut off',
          items: clipped.map((c) =>
            c.paginatedPages !== undefined
              ? `Page ${c.page}: now ${plural(c.paginatedPages, 'page')}`
              : `Page ${c.page}: about ${plural(c.estimatedPages, 'page')}${pending ? ' (laying out…)' : ''}`,
          ),
        }
      : undefined,
  };
}

/** Source pages that became several pages but weren't cut off upstream (a layout difference). */
function grownItem(report: ImportReportData): ReportItem | null {
  const clipped = new Set(report.clippedPages.map((c) => c.page));
  const grown = (report.paginated?.grown ?? []).filter((g) => !clipped.has(g.page));
  if (!grown.length) return null;
  return {
    id: 'grown',
    label: 'Pages that grew',
    count: grown.length,
    summary:
      grown.length === 1
        ? '1 source page needs more room here than on the Homebrewery and continues on a new page.'
        : `${grown.length} source pages need more room here than on the Homebrewery and continue on new pages.`,
    tone: 'info',
    details: { label: 'Pages that grew', items: grown.map((g) => `Page ${g.page}: now ${plural(g.pages, 'page')}`) },
  };
}

function variablesItem(report: ImportReportData): ReportItem {
  const { definitions, mode } = report.variables;
  const n = definitions.length;
  const names = [...new Set(definitions.map((d) => d.name))];
  return {
    id: 'variables',
    label: 'Variable definitions',
    count: n,
    summary:
      n === 0
        ? 'None.'
        : mode === 'expand'
          ? `${plural(n, 'definition')} found. Variables aren’t supported here, so their values were written into the text.`
          : `${plural(n, 'definition')} found and left as written.`,
    tone: n ? 'info' : 'neutral',
    details: n
      ? {
          label: 'Variables',
          code: false,
          items: names.map((name) => {
            const pages = [...new Set(definitions.filter((d) => d.name === name).map((d) => d.page))];
            return `${name} (page ${pages.join(', ')})`;
          }),
        }
      : undefined,
  };
}

function unresolvedItem(report: ImportReportData): ReportItem | null {
  const { unresolved, mode } = report.variables;
  if (!unresolved.length) return null;
  return {
    id: 'unresolved',
    label: 'Variable references left as text',
    count: unresolved.length,
    summary:
      mode === 'expand'
        ? `${plural(unresolved.length, 'reference')} to variables that were never defined; the text shows them as written.`
        : `${plural(unresolved.length, 'reference')} kept as written.`,
    tone: mode === 'expand' ? 'warning' : 'info',
    details: { label: 'References', code: true, items: unresolved.map((u) => `page ${u.page}: ${u.call}`) },
  };
}

function rawHtmlItem(report: ImportReportData): ReportItem {
  const { count, samples } = report.rawHtml;
  return {
    id: 'raw-html',
    label: 'Raw HTML kept',
    count,
    summary: count === 0 ? 'None.' : `${plural(count, 'piece')} of HTML the editor has no block for ${count === 1 ? 'is' : 'are'} kept as is. Edit ${count === 1 ? 'it' : 'them'} in the code popover.`,
    tone: count ? 'info' : 'neutral',
    details: samples.length ? { label: 'Raw HTML samples', code: true, items: samples } : undefined,
  };
}

function commentsItem(report: ImportReportData): ReportItem {
  const n = report.commentsDropped;
  return {
    id: 'comments',
    label: 'HTML comments dropped',
    count: n,
    summary: n === 0 ? 'None.' : `${plural(n, 'comment')} removed. Comments never showed on the page.`,
    tone: n ? 'info' : 'neutral',
  };
}

function unknownClassesItem(report: ImportReportData): ReportItem {
  const unknown = report.unknownClasses;
  if (unknown === null) {
    return { id: 'unknown-classes', label: 'Unknown classes', count: null, summary: 'Not checked: the theme’s stylesheets didn’t load.', tone: 'warning' };
  }
  const n = unknown.length;
  return {
    id: 'unknown-classes',
    label: 'Unknown classes',
    count: n,
    summary:
      n === 0
        ? 'None: the theme or the brew’s CSS styles every class used.'
        : `${plural(n, 'class', 'classes')} used in the brew ${n === 1 ? 'is' : 'are'} not in the theme’s stylesheets or the brew’s CSS, so ${n === 1 ? 'it has' : 'they have'} no effect.`,
    tone: n ? 'warning' : 'neutral',
    details: n ? { label: 'Unknown classes', code: true, items: unknown.map((c) => `.${c.name} ×${c.count}`) } : undefined,
  };
}

function transparentItem(report: ImportReportData): ReportItem {
  const n = sum(report.transparentElements);
  return {
    id: 'transparent',
    label: 'Tags that lost their attributes',
    count: n,
    summary: n === 0 ? 'None.' : `The text inside ${n === 1 ? 'this tag' : `these ${n} tags`} is kept, but the tags and their attributes (colours, sizes, classes) are not.`,
    tone: n ? 'warning' : 'neutral',
    details: n ? { label: 'Tags', code: true, items: counted(report.transparentElements, (t) => (/^[a-z]+$/.test(t) ? `<${t}>` : t)) } : undefined,
  };
}

function sanitizerItem(report: ImportReportData): ReportItem | null {
  const { elements, attributes } = report.sanitizer;
  const n = sum(elements) + sum(attributes);
  if (!n) return null;
  return {
    id: 'sanitizer',
    label: 'Removed for safety',
    count: n,
    summary: 'Scripts, event handlers and other HTML that could run code or load other pages were removed.',
    tone: 'warning',
    details: { label: 'Removed', code: true, items: [...counted(elements, (t) => `<${t}>`), ...counted(attributes, (a) => `${a}=`)] },
  };
}

function styleTagsItem(report: ImportReportData): ReportItem | null {
  const n = report.styleTagsLifted;
  if (!n) return null;
  return {
    id: 'style-tags',
    label: '<style> tags moved to the brew’s CSS',
    count: n,
    summary: `${plural(n, '<style> tag')} from the text ${n === 1 ? 'is' : 'are'} now part of the brew’s CSS (Style panel).`,
    tone: 'neutral',
  };
}

function liftedItem(report: ImportReportData): ReportItem | null {
  const { markers, footers, pageNumbers, objects } = report.lifted;
  const n = markers + footers + pageNumbers + objects;
  if (!n) return null;
  const items = [
    markers ? `${plural(markers, 'page marker')} (covers, page counting)` : '',
    footers ? plural(footers, 'footer') : '',
    pageNumbers ? plural(pageNumbers, 'page number') : '',
    objects ? `${plural(objects, 'positioned object')} (images and text placed on the page)` : '',
  ].filter(Boolean);
  return {
    id: 'lifted',
    label: 'Moved into page settings',
    count: n,
    summary: 'Page decorations became settings of their page. Edit them in the Inspector.',
    tone: 'neutral',
    details: { label: 'Page settings', items },
  };
}

function positionedItem(report: ImportReportData): ReportItem | null {
  const list = report.positionedInFlow;
  if (!list.length) return null;
  return {
    id: 'positioned',
    label: 'Positioned elements kept in the text',
    count: list.length,
    summary: 'These elements are positioned on the page but stay in the text flow; check where they land.',
    tone: 'info',
    details: {
      label: 'Positioned elements',
      code: true,
      items: list.map((p) => `page ${p.page}: <${p.tag}${p.classes.length ? ` class="${p.classes.join(' ')}"` : ''}> (${p.reason})`),
    },
  };
}

function lostItem(report: ImportReportData): ReportItem | null {
  if (!report.lost.length) return null;
  return {
    id: 'lost',
    label: 'Details not kept',
    count: report.lost.length,
    summary: 'The page model has no place for these details.',
    tone: 'warning',
    details: { label: 'Details not kept', items: report.lost },
  };
}

function warningsItem(report: ImportReportData, notes: readonly string[]): ReportItem | null {
  const items = [...notes, ...report.warnings];
  if (!items.length) return null;
  return { id: 'warnings', label: 'Notes', count: items.length, summary: 'Worth checking before you create the brew.', tone: 'warning', details: { label: 'Notes', items } };
}

export interface ReportItemsOptions {
  layout: LayoutState;
  /** More notes from the import page (theme fallback, shortened title, file encoding). */
  notes?: readonly string[];
}

/** The report as a list of items, in reading order. */
export function reportItems(report: ImportReportData, { layout, notes = [] }: ReportItemsOptions): ReportItem[] {
  const items: Array<ReportItem | null> = [
    pagesItem(report, layout),
    clippedItem(report, layout),
    grownItem(report),
    variablesItem(report),
    unresolvedItem(report),
    rawHtmlItem(report),
    commentsItem(report),
    unknownClassesItem(report),
    transparentItem(report),
    sanitizerItem(report),
    styleTagsItem(report),
    liftedItem(report),
    positionedItem(report),
    lostItem(report),
    warningsItem(report, notes),
  ];
  return items.filter((item): item is ReportItem => item !== null);
}

/** One line for screen readers and the page status: "3 pages; 2 notes to check." */
export function reportHeadline(report: ImportReportData, notes: readonly string[] = []): string {
  const attention = reportItems(report, { layout: 'done', notes }).filter((i) => i.tone === 'warning' && (i.count ?? 1) > 0).length;
  const pages = plural(report.paginated?.pages ?? report.pages, 'page');
  return attention ? `${pages}; ${plural(attention, 'item')} to check in the report.` : `${pages}; nothing needs your attention.`;
}
