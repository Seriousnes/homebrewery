import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { schema } from '../schema/testing';
import { ImportReport, recordPaginatedPages, sectionPageCounts } from './importReport';

const page = (kind: 'manual' | 'auto', content: JSONContent[] = [{ type: 'paragraph' }], attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'page',
  attrs: { kind, ...attrs },
  content,
});

describe('ImportReport', () => {
  it('starts empty, with the variables mode', () => {
    const data = new ImportReport(3, '5ePHB', 'keep').toJSON();
    expect(data).toMatchObject({
      pages: 3,
      theme: '5ePHB',
      clippedPages: [],
      variables: { mode: 'keep', definitions: [], unresolved: [] },
      paginated: null,
      rawHtml: { count: 0, samples: [] },
      commentsDropped: 0,
      unknownClasses: null,
      sanitizer: { elements: {}, attributes: {} },
      transparentElements: {},
      lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
      lost: [],
      warnings: [],
    });
    expect(new ImportReport(1, 'Blank').toJSON().variables.mode).toBe('expand');
  });

  it('sums sanitizer removals and transparent tags', () => {
    const report = new ImportReport(1, '5ePHB');
    report.addSanitizerRemovals({ elements: { script: 1 }, attributes: { onclick: 2 } });
    report.addSanitizerRemovals({ elements: { script: 2, iframe: 1 }, attributes: {} });
    report.addTransparent('font');
    report.addTransparent('font');
    report.addTransparent('span (without inline-block)');
    expect(report.data.sanitizer).toEqual({ elements: { script: 3, iframe: 1 }, attributes: { onclick: 2 } });
    expect(report.data.transparentElements).toEqual({ font: 2, 'span (without inline-block)': 1 });
  });

  it('inspect() counts rawHtml nodes and classes no stylesheet knows', () => {
    const report = new ImportReport(1, '5ePHB');
    const doc: JSONContent = {
      type: 'doc',
      content: [
        page('manual', [
          { type: 'themeBlock', attrs: { classes: ['note', 'purple'] }, content: [{ type: 'paragraph' }] },
          { type: 'rawHtml', attrs: { html: `<section class="x">${'y'.repeat(200)}</section>` } },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a', marks: [{ type: 'span', attrs: { classes: ['pen', 'purple'] } }] },
              { type: 'icon', attrs: { font: 'df', glyph: 'd12-2' } },
            ],
          },
        ], { markers: ['frontCover'], objects: [{ id: 'o1', kind: 'text', classes: ['banner'], style: '', text: 'B' }] }),
      ],
    };
    report.inspect(doc, new Set(['note', 'frontCover', 'banner', 'df', 'd12-2']));
    expect(report.data.rawHtml.count).toBe(1);
    expect(report.data.rawHtml.samples[0]).toMatch(/^<section class="x">y+…$/);
    expect(report.data.rawHtml.samples[0]!.length).toBe(81);
    expect(report.data.unknownClasses).toEqual([
      { name: 'purple', count: 2 },
      { name: 'pen', count: 1 },
    ]);
  });

  it('inspect() leaves unknownClasses null when no stylesheet was loaded', () => {
    const report = new ImportReport(1, 'NoSuchTheme');
    report.inspect({ type: 'doc', content: [page('manual')] }, null);
    expect(report.data.unknownClasses).toBeNull();
  });

  it('setPaginatedPages() fills in a clipped page', () => {
    const report = new ImportReport(2, '5ePHB');
    report.data.clippedPages.push({ page: 2, estimatedPages: 3 });
    report.setPaginatedPages(2, 4);
    report.setPaginatedPages(1, 9); // not clipped: ignored
    expect(report.data.clippedPages).toEqual([{ page: 2, estimatedPages: 3, paginatedPages: 4 }]);
  });
});

describe('pagination hook', () => {
  const paginated: JSONContent = { type: 'doc', content: [page('manual'), page('manual'), page('auto'), page('auto'), page('manual')] };

  it('sectionPageCounts() counts each manual page with the auto pages after it', () => {
    expect(sectionPageCounts(paginated)).toEqual([1, 3, 1]);
    expect(sectionPageCounts({ type: 'doc', content: [page('auto'), page('auto')] })).toEqual([2]);
    expect(sectionPageCounts({ type: 'doc' })).toEqual([]);
  });

  it('accepts a ProseMirror document too', () => {
    expect(sectionPageCounts(schema.nodeFromJSON(paginated))).toEqual([1, 3, 1]);
  });

  it('recordPaginatedPages() returns a new report with the grown pages', () => {
    const report = new ImportReport(3, '5ePHB');
    report.data.clippedPages.push({ page: 2, estimatedPages: 2 });
    const before = report.toJSON();
    const after = recordPaginatedPages(before, paginated);
    expect(after.paginated).toEqual({ pages: 5, grown: [{ page: 2, pages: 3 }] });
    expect(after.clippedPages).toEqual([{ page: 2, estimatedPages: 2, paginatedPages: 3 }]);
    expect(before.paginated).toBeNull();
    expect(before.clippedPages[0]!.paginatedPages).toBeUndefined();
  });
});
