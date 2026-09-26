// Prettier formatting (P3.6), as legacy formatCSS did it.
import { describe, expect, it } from 'vitest';
import { collapseSingleDeclarationRules, CssFormatError, formatCss, minimalChange } from './formatCss';

describe('formatCss', () => {
  it('formats with legacy options and puts single-declaration rules on one line', async () => {
    const out = await formatCss(".page{color:red;margin:0}\n.note   h2{font-family:'X'}");
    expect(out).toBe('.page {\n  color: red;\n  margin: 0;\n}\n.note h2 { font-family: "X"; }\n');
  });

  it('keeps nested rules and at-rules intact', async () => {
    const out = await formatCss('@media print{.page{display:none}}');
    expect(out).toBe('@media print {\n  .page { display: none; }\n}\n');
  });

  it('reports syntax errors with their position', async () => {
    const error = await formatCss('.page {\n  color: red;\n').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CssFormatError);
    expect((error as CssFormatError).message).toMatch(/Unclosed block/i);
    expect((error as CssFormatError).line).toBe(1);
  });
});

describe('collapseSingleDeclarationRules', () => {
  it('collapses only rules with exactly one declaration', () => {
    expect(collapseSingleDeclarationRules('.a {\n  color: red;\n}\n.b {\n  x: 1;\n  y: 2;\n}\n')).toBe('.a { color: red; }\n.b {\n  x: 1;\n  y: 2;\n}\n');
    expect(collapseSingleDeclarationRules('.a,\n.b {\n  color: red;\n}\n')).toBe('.a,\n.b { color: red; }\n');
    // A semicolon inside a value is not a single simple declaration: left alone.
    const dataUrl = '.a {\n  background: url(data:image/png;base64,AAAA);\n}\n';
    expect(collapseSingleDeclarationRules(dataUrl)).toBe(dataUrl);
  });
});

describe('minimalChange', () => {
  it('replaces only the changed middle', () => {
    expect(minimalChange('abcXYZdef', 'abc123def')).toEqual({ from: 3, to: 6, insert: '123' });
    expect(minimalChange('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' });
    expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' });
    expect(minimalChange('same', 'same')).toBeNull();
  });
});
