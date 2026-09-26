// Theme class completion in the Style drawer (P3.6).
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { classNameCompletion, inSelector } from './classCompletion';

describe('inSelector', () => {
  it('tells selectors from declaration values', () => {
    expect(inSelector('')).toBe(true);
    expect(inSelector('.page { color: red; }\n')).toBe(true);
    expect(inSelector('.page { margin: 0')).toBe(false);
    expect(inSelector('.page { color: red; ')).toBe(true); // nested rule / property position
    expect(inSelector('@media print { ')).toBe(true);
    expect(inSelector('a:hover ')).toBe(true); // top level: pseudo-classes are selectors
    expect(inSelector('.x { content: "{"; ')).toBe(true);
    expect(inSelector('/* .x { */ ')).toBe(true);
    expect(inSelector('/* unfinished comment ')).toBe(false);
  });
});

function complete(doc: string, names: string[]): CompletionResult | null {
  const state = EditorState.create({ doc, extensions: [css()] });
  const source = classNameCompletion(() => names);
  return source(new CompletionContext(state, doc.length, false)) as CompletionResult | null;
}

describe('classNameCompletion', () => {
  const names = ['monster', 'frame', 'wide'];

  it('offers theme classes after a dot in a selector', () => {
    const result = complete('.page .mon', names);
    expect(result?.from).toBe('.page .'.length);
    expect(result?.options.map((o) => o.label)).toEqual(names);
    expect(complete('h2.', names)?.from).toBe(3);
    expect(complete('.page {\n}\n.', names)).not.toBeNull();
  });

  it('stays out of values and plain text', () => {
    expect(complete('.page { margin: 0.', names)).toBeNull();
    expect(complete('.page { margin: 1.5', names)).toBeNull();
    expect(complete('.page', [])).toBeNull();
    expect(complete('page', names)).toBeNull();
  });
});
