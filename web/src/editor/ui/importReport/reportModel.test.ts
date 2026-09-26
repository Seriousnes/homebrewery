import { describe, expect, it } from 'vitest';
import type { ImportReportData } from '@/editor/import/importReport';
import { fitZoom } from './fitZoom';
import { reportHeadline, reportItems } from './reportModel';

function emptyReport(overrides: Partial<ImportReportData> = {}): ImportReportData {
  return {
    pages: 1,
    theme: '5ePHB',
    clippedPages: [],
    variables: { mode: 'expand', definitions: [], unresolved: [] },
    paginated: null,
    rawHtml: { count: 0, samples: [] },
    commentsDropped: 0,
    styleTagsLifted: 0,
    unknownClasses: [],
    sanitizer: { elements: {}, attributes: {} },
    transparentElements: {},
    lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
    positionedInFlow: [],
    lost: [],
    warnings: [],
    ...overrides,
  };
}

const byId = (report: ImportReportData, layout: 'pending' | 'done' | 'unavailable' = 'done', notes: string[] = []) =>
  Object.fromEntries(reportItems(report, { layout, notes }).map((item) => [item.id, item]));

describe('reportItems', () => {
  it('always lists the counts of plan §7, with 0 for a clean import', () => {
    const items = reportItems(emptyReport(), { layout: 'done' });
    expect(items.map((i) => i.id)).toEqual(['pages', 'clipped', 'variables', 'raw-html', 'comments', 'unknown-classes', 'transparent']);
    for (const item of items.slice(1)) {
      expect(item.count, item.id).toBe(0);
      expect(item.tone, item.id).toBe('neutral');
      expect(item.details, item.id).toBeUndefined();
    }
    expect(items[0]).toMatchObject({ count: 1, summary: '1 page in the source.' });
  });

  it('says the layout is running, then gives the paginated page counts', () => {
    const clipped = emptyReport({ pages: 2, clippedPages: [{ page: 2, estimatedPages: 3 }] });
    const pending = byId(clipped, 'pending');
    expect(pending.pages).toMatchObject({ count: 2, summary: '2 pages in the source. Laying out the pages…' });
    expect(pending.clipped).toMatchObject({ count: 1, tone: 'info' });
    expect(pending.clipped!.details!.items).toEqual(['Page 2: about 3 pages (laying out…)']);
    expect(byId(clipped, 'unavailable').clipped!.details!.items).toEqual(['Page 2: about 3 pages']);

    const done = byId({
      ...clipped,
      clippedPages: [{ page: 2, estimatedPages: 3, paginatedPages: 4 }],
      paginated: { pages: 5, grown: [{ page: 2, pages: 4 }] },
    });
    expect(done.pages).toMatchObject({ count: 5, summary: '2 pages in the source; 5 pages once laid out with the theme.' });
    expect(done.clipped!.details).toEqual({ label: 'Pages that were cut off', items: ['Page 2: now 4 pages'] });
    // A grown page that was also clipped is listed once (under clipped).
    expect(done.grown).toBeUndefined();
  });

  it('lists pages that grew without clipping upstream separately', () => {
    const items = byId(emptyReport({ pages: 3, paginated: { pages: 4, grown: [{ page: 3, pages: 2 }] } }));
    expect(items.grown).toMatchObject({ count: 1, tone: 'info' });
    expect(items.grown!.summary).toBe('1 source page needs more room here than on the Homebrewery and continues on a new page.');
    expect(items.grown!.details!.items).toEqual(['Page 3: now 2 pages']);
  });

  it('describes variable definitions for both modes, and unresolved references', () => {
    const variables: ImportReportData['variables'] = {
      mode: 'expand',
      definitions: [
        { name: 'hp', page: 1, form: 'block' },
        { name: 'hp', page: 3, form: 'inline' },
        { name: 'ac', page: 2, form: 'block' },
      ],
      unresolved: [{ page: 2, call: '$[missing]' }],
    };
    const expand = byId(emptyReport({ variables }));
    expect(expand.variables).toMatchObject({ count: 3, tone: 'info' });
    expect(expand.variables!.summary).toBe('3 definitions found. Variables aren’t supported here, so their values were written into the text.');
    expect(expand.variables!.details!.items).toEqual(['hp (page 1, 3)', 'ac (page 2)']);
    expect(expand.unresolved).toMatchObject({ count: 1, tone: 'warning' });
    expect(expand.unresolved!.details!.items).toEqual(['page 2: $[missing]']);

    const keep = byId(emptyReport({ variables: { ...variables, mode: 'keep' } }));
    expect(keep.variables!.summary).toBe('3 definitions found and left as written.');
    expect(keep.unresolved).toMatchObject({ tone: 'info', summary: '1 reference kept as written.' });
  });

  it('counts raw HTML with samples, comments, unknown classes and tags that lost attributes', () => {
    const items = byId(
      emptyReport({
        rawHtml: { count: 2, samples: ['<section>a</section>', '<svg class="diagram">…'] },
        commentsDropped: 3,
        unknownClasses: [
          { name: 'glow', count: 2 },
          { name: 'odd', count: 1 },
        ],
        transparentElements: { 'span (without inline-block)': 1, font: 4 },
      }),
    );
    expect(items['raw-html']).toMatchObject({ count: 2, tone: 'info' });
    expect(items['raw-html']!.details).toEqual({ label: 'Raw HTML samples', code: true, items: ['<section>a</section>', '<svg class="diagram">…'] });
    expect(items.comments).toMatchObject({ count: 3, summary: '3 comments removed. Comments never showed on the page.' });
    expect(items['unknown-classes']).toMatchObject({ count: 2, tone: 'warning' });
    expect(items['unknown-classes']!.details!.items).toEqual(['.glow ×2', '.odd ×1']);
    expect(items.transparent).toMatchObject({ count: 5, tone: 'warning' });
    // Biggest first; plain tag names in angle brackets.
    expect(items.transparent!.details!.items).toEqual(['<font> ×4', 'span (without inline-block) ×1']);
  });

  it('says unknown classes were not checked when no stylesheet loaded', () => {
    expect(byId(emptyReport({ unknownClasses: null }))['unknown-classes']).toMatchObject({ count: null, tone: 'warning', summary: 'Not checked: the theme’s stylesheets didn’t load.' });
  });

  it('adds the optional items only when they have something to say', () => {
    const items = byId(
      emptyReport({
        sanitizer: { elements: { script: 1 }, attributes: { onclick: 2 } },
        styleTagsLifted: 1,
        lifted: { markers: 1, footers: 2, pageNumbers: 0, objects: 1 },
        positionedInFlow: [{ page: 1, tag: 'div', classes: ['artist'], reason: 'positioned block' }],
        lost: ['Page 2 id "x"'],
        warnings: ['Fonts timed out'],
      }),
      'done',
      ['The theme “x” isn’t available here'],
    );
    expect(items.sanitizer).toMatchObject({ count: 3, tone: 'warning' });
    expect(items.sanitizer!.details!.items).toEqual(['<script> ×1', 'onclick= ×2']);
    expect(items['style-tags']).toMatchObject({ count: 1, summary: '1 <style> tag from the text is now part of the brew’s CSS (Style panel).' });
    expect(items.lifted!.count).toBe(4);
    expect(items.lifted!.details!.items).toEqual(['1 page marker (covers, page counting)', '2 footers', '1 positioned object (images and text placed on the page)']);
    expect(items.positioned!.details!.items).toEqual(['page 1: <div class="artist"> (positioned block)']);
    expect(items.lost).toMatchObject({ count: 1, tone: 'warning' });
    // The page's notes come before the report's own warnings.
    expect(items.warnings!.details!.items).toEqual(['The theme “x” isn’t available here', 'Fonts timed out']);
  });
});

describe('reportHeadline', () => {
  it('says how many pages and whether anything needs attention', () => {
    expect(reportHeadline(emptyReport())).toBe('1 page; nothing needs your attention.');
    expect(reportHeadline(emptyReport({ paginated: { pages: 3, grown: [] }, commentsDropped: 1 }))).toBe('3 pages; nothing needs your attention.');
    expect(reportHeadline(emptyReport({ unknownClasses: [{ name: 'x', count: 1 }], transparentElements: { font: 1 } }))).toBe(
      '1 page; 2 items to check in the report.',
    );
    expect(reportHeadline(emptyReport(), ['A note'])).toBe('1 page; 1 item to check in the report.');
  });
});

describe('fitZoom', () => {
  it('fits one page into the width, between 25% and 100%', () => {
    expect(fitZoom(856)).toBe(1);
    expect(fitZoom(2000)).toBe(1);
    expect(fitZoom(448)).toBe(0.5);
    expect(fitZoom(100)).toBe(0.25);
    expect(fitZoom(448, 408)).toBe(1);
    expect(fitZoom(0)).toBe(1);
    expect(fitZoom(500, 0)).toBe(1);
  });
});
