import { describe, expect, it } from 'vitest';
import { HEADER_ROW_CLASS, rewriteHeaderRowSelector, rewriteHeaderRowSelectorList, splitSelectors } from './headerRowSelectors';

const H = ':where(.hb-header-row)';
const NOT_H = ':where(:not(.hb-header-row))';
const IN_BODY = ':where(tr:not(.hb-header-row), tr:not(.hb-header-row) *)';

describe('rewriteHeaderRowSelector', () => {
  it.each([
    // 5ePHB / Blank / Journal (compiled from style.less)
    ['.page table thead', `.page table thead, .page table tr${H}`],
    ['.page table thead th', `.page table thead th, .page table tr${H} th`],
    ['.page table tbody tr td', `.page table tbody tr${IN_BODY} td`],
    ['.page table tbody tr:nth-child(odd)', `.page table tbody tr:nth-child(odd of ${NOT_H})${IN_BODY}`],
    ['.note table tbody tr:nth-child(odd)', `.note table tbody tr:nth-child(odd of ${NOT_H})${IN_BODY}`],
    // child combinators
    ['table > thead > tr > th', `table > thead > tr > th, table > tbody > tr${H} > th`],
    ['thead > *', `thead > *, tbody > *${H}`],
    ['tbody > tr:first-child td', `tbody > tr:nth-child(1 of ${NOT_H})${NOT_H} td`],
    ['tbody > tr:last-child', `tbody > tr:last-child${NOT_H}`],
    // header rows: position within the header rows
    ['thead tr:last-child', `thead tr:last-child, tbody tr:nth-last-child(1 of ${H})${H}`],
    ['thead tr:nth-child(2) th', `thead tr:nth-child(2) th, tbody tr:nth-child(2)${H} th`],
    // rows in no group: counted within each group, as upstream
    ['table tr:nth-child(even)', `table tr:is(${H}:nth-child(even), ${NOT_H}:nth-child(even of ${NOT_H}))`],
    ['tr:first-child > td', `tr:is(${H}:first-child, ${NOT_H}:nth-child(1 of ${NOT_H})) > td`],
    // descendants of tbody that aren't rows
    ['tbody td', `tbody td${IN_BODY}`],
    ['tbody td:nth-child(2)', `tbody td:nth-child(2)${IN_BODY}`],
    // pseudo-elements stay last
    ['thead th::before', `thead th::before, tr${H} th::before`],
    ['tbody tr::after', `tbody tr${IN_BODY}::after`],
    ['thead::before', `thead::before`],
  ])('%s', (input, expected) => {
    expect(rewriteHeaderRowSelector(input)).toBe(expected);
  });

  it.each([
    '.page p',
    '.page .tr-note',
    'td:nth-child(2)',
    'tr',
    'thead + tbody tr',
    ':is(thead) th',
    'table:has(thead)',
    '.hb-canvas .page h1 + p',
    `.page tr.${HEADER_ROW_CLASS}`,
  ])('leaves %s alone', (input) => {
    expect(rewriteHeaderRowSelector(input)).toBe(input);
  });

  it('is idempotent', () => {
    for (const input of ['.page table thead th', '.page table tbody tr:nth-child(odd)', 'table tr:nth-child(even)', 'tbody td']) {
      const once = rewriteHeaderRowSelector(input);
      expect(rewriteHeaderRowSelectorList(once)).toBe(once);
    }
  });

  it('keeps strings, attribute values and nested lists intact', () => {
    expect(rewriteHeaderRowSelector('thead th[title="a > b, c"]')).toBe(`thead th[title="a > b, c"], tr${H} th[title="a > b, c"]`);
    expect(rewriteHeaderRowSelector('tbody tr:is(.a, .b):nth-child(odd)')).toBe(`tbody tr:is(.a, .b):nth-child(odd of ${NOT_H})${IN_BODY}`);
  });

  it('leaves An+B of S alone', () => {
    expect(rewriteHeaderRowSelector('tbody tr:nth-child(odd of .x)')).toBe(`tbody tr:nth-child(odd of .x)${IN_BODY}`);
  });

  it('ignores relative and malformed selectors', () => {
    expect(rewriteHeaderRowSelector('> thead th')).toBe('> thead th');
    expect(rewriteHeaderRowSelector('thead > > th')).toBe('thead > > th');
    expect(rewriteHeaderRowSelector('thead >')).toBe('thead >');
  });
});

describe('rewriteHeaderRowSelectorList', () => {
  it('rewrites each selector of a list', () => {
    expect(rewriteHeaderRowSelectorList('.a, .page thead th')).toBe(`.a, .page thead th, .page tr${H} th`);
  });

  it('splits only at top-level commas', () => {
    expect(splitSelectors(':is(a, b) c, d[x="1,2"]')).toEqual([':is(a, b) c', 'd[x="1,2"]']);
  });
});
