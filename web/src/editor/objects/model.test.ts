import { describe, expect, it } from 'vitest';
import {
  coverOf,
  imageStyleFromObject,
  newObjectId,
  objectStyleFromImage,
  parseDeclarations,
  patchObject,
  px,
  pxValue,
  removeObject,
  reorderObject,
  serializeDeclarations,
  styleValue,
  textObject,
  withCover,
  withStyle,
} from './model';

describe('style declarations', () => {
  it('parses declarations, keeping semicolons inside url() and strings', () => {
    expect(parseDeclarations('position:absolute; background: url("a;b.png") ; content: ";"; --HB_x: 1')).toEqual([
      ['position', 'absolute'],
      ['background', 'url("a;b.png")'],
      ['content', '";"'],
      ['--HB_x', '1'],
    ]);
    expect(parseDeclarations(null)).toEqual([]);
    expect(parseDeclarations('garbage; :x; y:')).toEqual([]);
    expect(serializeDeclarations([['a', '1'], ['b', '2']])).toBe('a: 1; b: 2;');
  });

  it('sets, replaces and removes properties in place', () => {
    const style = 'position: absolute; bottom: 0px; right: -80px; height: 45%;';
    expect(withStyle(style, { bottom: null, right: null, left: '10px', top: '20px' })).toBe('position: absolute; height: 45%; left: 10px; top: 20px;');
    expect(withStyle(style, { height: '100px' })).toBe('position: absolute; bottom: 0px; right: -80px; height: 100px;');
    expect(withStyle('LEFT: 1px; left: 2px', { left: '3px' })).toBe('left: 3px;');
    expect(styleValue('left: 1px; left: 2px', 'left')).toBe('2px');
    expect(styleValue('', 'left')).toBeNull();
  });

  it('reads pixel values', () => {
    expect(pxValue('12px')).toBe(12);
    expect(pxValue('-3.5px')).toBe(-3.5);
    expect(pxValue('0')).toBe(0);
    expect(pxValue('45%')).toBeNull();
    expect(pxValue(null)).toBeNull();
    expect(px(12.6)).toBe('13px');
  });
});

describe('object lists', () => {
  const a = textObject('a', 'A', { left: 0, top: 0 });
  const b = textObject('b', 'B', { left: 0, top: 0 });
  const c = textObject('c', 'C', { left: 0, top: 0 });

  it('reorders (z-order) and refuses no-op moves', () => {
    expect(reorderObject([a, b, c], 'a', 'forward')?.map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(reorderObject([a, b, c], 'a', 'front')?.map((o) => o.id)).toEqual(['b', 'c', 'a']);
    expect(reorderObject([a, b, c], 'c', 'back')?.map((o) => o.id)).toEqual(['c', 'a', 'b']);
    expect(reorderObject([a, b, c], 'b', 'backward')?.map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(reorderObject([a, b, c], 'a', 'backward')).toBeNull();
    expect(reorderObject([a, b, c], 'c', 'front')).toBeNull();
    expect(reorderObject([a, b, c], 'x', 'front')).toBeNull();
  });

  it('patches and removes by id', () => {
    expect(patchObject([a, b], 'b', { text: 'Z' })?.[1]?.text).toBe('Z');
    expect(patchObject([a, b], 'b', { text: 'B' })).toBeNull();
    expect(patchObject([a, b], 'x', { text: 'Z' })).toBeNull();
    expect(removeObject([a, b], 'a')).toEqual([b]);
    expect(removeObject([a, b], 'x')).toBeNull();
  });

  it('makes ids that are not taken', () => {
    let n = 0;
    const seq = [0.5, 0.5, 0.25];
    const random = () => seq[n++]!;
    const first = newObjectId([], random);
    expect(newObjectId([{ ...a, id: first }], random)).not.toBe(first);
  });
});

describe('inline image ⇄ object styles', () => {
  it('drops flow placement for an object and keeps the rest', () => {
    expect(objectStyleFromImage('float: right; margin: 4px; width: 50%; filter: sepia(1);', { left: 1, top: 2 })).toBe(
      'width: 50%; filter: sepia(1); position: absolute; left: 1px; top: 2px;',
    );
    expect(imageStyleFromObject('position: absolute; top: 0; right: -80px; height: 45%; z-index: -1;')).toBe('height: 45%;');
    expect(imageStyleFromObject('position: absolute; top: 0;')).toBeNull();
  });
});

describe('cover markers', () => {
  it('reads and replaces the cover marker only', () => {
    expect(coverOf(['skipCounting', 'partCover'])).toBe('partCover');
    expect(coverOf(['skipCounting'])).toBeNull();
    expect(coverOf('x')).toBeNull();
    expect(withCover(['frontCover', 'skipCounting'], 'backCover')).toEqual(['backCover', 'skipCounting']);
    expect(withCover(['frontCover', 'resetCounting'], null)).toEqual(['resetCounting']);
    expect(withCover(null, 'insideCover')).toEqual(['insideCover']);
  });
});
