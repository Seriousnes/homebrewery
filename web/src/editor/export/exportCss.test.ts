/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CANVAS_PRESENTATION_CSS, collectExportCss, editorCss, exportStylesheets, PROSEMIRROR_CSS } from './exportCss';

// Vitest turns CSS imports (?raw too) into empty strings: give exportCss.ts the real canvas.css.
vi.mock('../canvas/canvas.css?raw', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return { default: fs.readFileSync(path.resolve(process.cwd(), 'src/editor/canvas/canvas.css'), 'utf8') };
});

// Vitest runs from web/.
const canvasCss = readFileSync(resolve(process.cwd(), 'src/editor/canvas/canvas.css'), 'utf8');
const canvasModuleCss = readFileSync(resolve(process.cwd(), 'src/editor/canvas/EditorCanvas.module.css'), 'utf8');

const BASE = 'http://localhost:5173/share/abc';

/** The declarations of the first rule whose selector is `selector` (whitespace squashed). */
function declarations(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} in the CSS`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return body
    .split(';')
    .map((d) => d.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('editorCss', () => {
  it("has EditorCanvas's inherited-property reset for the canvas", () => {
    expect(declarations(CANVAS_PRESENTATION_CSS, ':where(.hb-canvas)')).toEqual(declarations(canvasModuleCss, ':where(.canvas)'));
  });

  it('has canvas.css (the page structure, the upstream base, dl and image rules) and the ProseMirror rules', () => {
    const css = editorCss(BASE);
    for (const rule of [
      '.hb-canvas .page > .columnWrapper',
      '.hb-canvas .page:where(.hb-cols-1)',
      '.hb-canvas .page:where(.hb-cols-2)',
      ':where(.hb-canvas img[data-hb-natural])',
      '.hb-canvas .page dl.hb-dl-multiline > dt::after',
      '.hb-canvas .page li.hb-continued::marker',
    ]) {
      expect(canvasCss).toContain(rule);
      expect(css).toContain(rule);
    }
    expect(css).toContain(PROSEMIRROR_CSS.trim());
    expect(css).not.toContain('/*');
    // Open Sans with absolute URLs (the file is fetched and written in later).
    expect(css).toMatch(/@font-face \{ font-family: 'Open Sans';[^}]*src: url\('http:\/\/localhost:5173\/[^']+\.woff2'\)/);
  });

  it('prints pages only: no backdrop, spacing or shadows', () => {
    const print = CANVAS_PRESENTATION_CSS.slice(CANVAS_PRESENTATION_CSS.indexOf('@media print'));
    expect(print).toContain('background: none !important');
    expect(print).toContain('margin: 0 !important');
    expect(print).toContain('box-shadow: none !important');
  });
});

const answer = (body: string) => Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/css' } }));

describe('collectExportCss', () => {
  it("fetches the chain's stylesheets, inlines imports and makes every url() absolute", async () => {
    const fetch = vi.fn((url: string) => {
      if (url === 'http://localhost:5173/themes/V3/Blank/style.scoped.css') return answer(`@import url('./extra.css');\n/* note */ .hb-canvas .page { background: url('../../../assets/a.png') }`);
      if (url === 'http://localhost:5173/themes/V3/Blank/extra.css') return answer(`.hb-canvas .x { background: url(b.png) }`);
      if (url === 'http://localhost:5173/themes/missing.css') return Promise.resolve(new Response('', { status: 404 }));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const result = await collectExportCss(
      {
        styles: [
          { kind: 'url', href: '/themes/V3/Blank/style.scoped.css' },
          { kind: 'url', href: '/themes/missing.css' },
          { kind: 'css', css: '.page .mine { background: url(/assets/c.png) }', baseUrl: 'http://localhost:5173/api/themes/x' },
        ],
      },
      '.page h1 { color: red } body { counter-reset: page-numbers }',
      { baseUrl: BASE, fetch },
    );
    expect(result.theme).toHaveLength(1);
    expect(result.theme[0]).toContain("url('http://localhost:5173/assets/a.png')");
    expect(result.theme[0]).toContain('http://localhost:5173/themes/V3/Blank/b.png');
    expect(result.theme[0]).not.toContain('@import');
    expect(result.theme[0]).not.toContain('/* note */');
    expect(result.failed).toEqual(['http://localhost:5173/themes/missing.css']);
    // User themes and the brew CSS are scoped as the editor scopes them.
    expect(result.themeCss).toHaveLength(1);
    expect(result.themeCss[0]).toMatch(/^\.hb-canvas \.page \.mine/);
    expect(result.themeCss[0]).toContain('http://localhost:5173/assets/c.png');
    expect(result.brew).toContain('.hb-canvas .page h1');
    expect(result.brew).toMatch(/\.hb-canvas \{\s*counter-reset: page-numbers/);
    expect(exportStylesheets(result).map((s) => s.group)).toEqual(['theme', 'editor', 'theme-css', 'brew']);
  });

  it('leaves out an empty brew CSS and reports failed imports', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    const result = await collectExportCss({ styles: [] }, "@import url('https://fonts.example.com/x.css');", { baseUrl: BASE, fetch });
    expect(result.failed).toContain('https://fonts.example.com/x.css');
    expect(exportStylesheets(result).map((s) => s.group)).toEqual(['editor']);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => {
      controller.abort();
      return answer('.hb-canvas .page {}');
    });
    await expect(collectExportCss({ styles: [{ kind: 'url', href: '/t.css' }] }, '', { baseUrl: BASE, fetch, signal: controller.signal })).rejects.toThrow();
  });
});
