import { describe, expect, it } from 'vitest';
import blankSnippets from '@themes/V3/Blank/snippets.js';
import phbSnippets from '@themes/V3/5ePHB/snippets.js';
import diceFont from '@themes/fonts/iconFonts/diceFont.js';
import type { ThemeSnippet } from './themeSnippets';

// Checks the @themes alias, the bare-import dedupe for files outside web/ and the type
// shims in src/themes.d.ts against the real theme modules.
describe('theme snippet modules', () => {
  it('load through the @themes alias', () => {
    expect(blankSnippets.map((group) => group.groupName)).toContain('Text Editor');
    expect(phbSnippets.length).toBeGreaterThan(0);
    for (const group of [...blankSnippets, ...phbSnippets]) {
      expect(['text', 'style']).toContain(group.view);
    }
  });

  it('have generators that return markdown', () => {
    const all: ThemeSnippet[] = phbSnippets
      .flatMap((group) => group.snippets)
      .flatMap((snippet) => [snippet, ...(snippet.subsnippets ?? [])]);
    const render = (name: string): string => {
      const gen = all.find((snippet) => snippet.name === name)?.gen;
      return typeof gen === 'function' ? gen({}) : (gen ?? '');
    };
    // Built at import time with lodash + dedent.
    expect(render('Monster Stat Block')).toContain('{{monster,frame');
    // A generator function.
    expect(render('Quote')).toContain('{{quote');
  });

  it('load icon font maps', () => {
    expect(diceFont.df_d12_2).toBe('df d12-2');
  });
});
