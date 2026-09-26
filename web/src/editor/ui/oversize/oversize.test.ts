// Oversize warnings (P4.8): which block, which fixes, and the fixes themselves (one undo step
// each; pagination clears the flag once the block fits). Line-model layout in jsdom; the DOM
// measurements (shrink image) are covered by web/e2e/sections/oversize.spec.ts.
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { mountPaginated, type MountedEditor } from '../../pagination/testEditor';
import { BLOCK, DOC, H, P, PAGE } from '../../pagination/testing';
import { allowSplitting, describeBlock, goToPage, makeWide, offendingBlock, oversizeFixes, oversizeWarnings, oversizedPages, shrinkImages } from './oversize';

let m: MountedEditor | undefined;
afterEach(() => {
  m?.destroy();
  m = undefined;
});

/** A 12-row theme block (taller than a 10-line column) after a heading, then a paragraph. */
const tallBlock = (attrs: Record<string, unknown> = {}) =>
  DOC(PAGE({ columns: 2, pid: 'aaaaaaaa', ...attrs }, H(2, 'Head'), BLOCK(['monster'], ...Array.from({ length: 12 }, (_, k) => P(`row ${k}`))), P('after')));

function mount(doc: PMNode): MountedEditor {
  m = mountPaginated(doc, { lines: { columns: 1 } });
  m.settle();
  return m;
}

describe('oversize warnings', () => {
  it('finds the oversized page and its block (after the headings kept with it)', () => {
    const e = mount(tallBlock());
    expect(oversizedPages(e.editor.state.doc).map((p) => p.index)).toEqual([0]);
    const block = offendingBlock(e.editor.state.doc, 0)!;
    expect(block.node.type.name).toBe('themeBlock');
    expect(describeBlock(block.node)).toBe('Theme block “monster”');
    expect(oversizeWarnings(e.editor.state)).toMatchObject([
      { index: 0, pid: 'aaaaaaaa', label: 'Theme block “monster”', fixes: { makeWide: true, allowSplitting: true, shrinkImages: false } },
    ]);
  });

  it('offers no "make wide" on a 1-column page or for a block that is wide already', () => {
    const e = mount(tallBlock({ columns: 1 }));
    expect(oversizeFixes(e.editor.state, 0).makeWide).toBe(false);
    expect(oversizeFixes(e.editor.state, 0, 2).makeWide).toBe(true); // laid out in 2 columns after all
  });

  it('make wide adds the class, in one undo step', () => {
    const e = mount(tallBlock());
    expect(makeWide(0)(e.editor.state, e.editor.view.dispatch)).toBe(true);
    const block = offendingBlock(e.editor.state.doc, 0)!;
    expect(block.node.attrs.classes).toEqual(['monster', 'wide']);
    expect(oversizeFixes(e.editor.state, 0).makeWide).toBe(false);
    e.editor.commands.undo();
    expect(offendingBlock(e.editor.state.doc, 0)!.node.attrs.classes).toEqual(['monster']);
  });

  it('allow splitting sets break-inside: auto (and display: block on a theme block)', () => {
    const e = mount(tallBlock());
    expect(allowSplitting(0)(e.editor.state, e.editor.view.dispatch)).toBe(true);
    const style = String(offendingBlock(e.editor.state.doc, 0)!.node.attrs.style);
    expect(style).toMatch(/display: block/);
    expect(style).toMatch(/break-inside: auto/);
    expect(oversizeFixes(e.editor.state, 0).allowSplitting).toBe(false);
    expect(allowSplitting(0)(e.editor.state)).toBe(false);
  });

  it('shrink image needs the rendered page (it measures)', () => {
    const e = mount(tallBlock());
    expect(shrinkImages(0)(e.editor.state, e.editor.view.dispatch, e.editor.view)).toBe(false); // no image
  });

  it('go to page puts the cursor on the page (a selectable block is selected)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('one')), PAGE({ columns: 1 }, P('two'))));
    expect(goToPage(1)(e.editor.state, e.editor.view.dispatch)).toBe(true);
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
    expect(goToPage(5)(e.editor.state)).toBe(false);
  });

  it('the warning clears when the layout changes so the block fits', () => {
    const e = mount(tallBlock());
    expect(e.editor.state.doc.child(0).attrs.oversized).toBe(true);
    // Remove four rows: the block now fits a column.
    const block = offendingBlock(e.editor.state.doc, 0)!;
    let end = block.pos + 1;
    for (let k = 0; k < 4; k++) end += block.node.child(k).nodeSize;
    e.editor.view.dispatch(e.editor.state.tr.delete(block.pos + 1, end));
    e.settle();
    expect(oversizedPages(e.editor.state.doc)).toEqual([]);
  });
});
