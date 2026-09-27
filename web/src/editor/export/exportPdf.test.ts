import { describe, expect, it, vi } from 'vitest';
import type { BrewForEdit } from '@/api/types';
import type { ThemeChain } from '../canvas/themeLoader';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import { exportBrewPdf, exportStoredBrewPdf } from './exportPdf';

const doc = {
  type: 'doc',
  content: [{ type: 'page', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Inn' }] }] }],
};
const chain = { theme: 'Blank', source: 'static', styles: [] } as unknown as ThemeChain;
const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

describe('exportBrewPdf', () => {
  it('renders the HTML export and names the file after the title', async () => {
    const render = vi.fn((_html: string, _options: { signal?: AbortSignal }) => Promise.resolve({ pdf, missingFiles: 1 }));

    const result = await exportBrewPdf(doc, { chain, title: 'The Inn: Part 1', lang: 'de', probe: null, render });

    expect(render).toHaveBeenCalledOnce();
    const html = render.mock.calls[0]![0];
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('The Inn</h1>');
    expect(result).toMatchObject({ pdf, filename: 'The Inn Part 1.pdf', missingFiles: 1 });
    expect(result.report.pages).toBe(1);
  });

  it('stops before rendering when cancelled', async () => {
    const controller = new AbortController();
    const render = vi.fn();
    const pending = exportBrewPdf(doc, { chain, probe: null, render, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(render).not.toHaveBeenCalled();
  });
});

describe('exportStoredBrewPdf', () => {
  it("exports a saved brew with its theme, CSS, language and title", async () => {
    const brew = {
      doc,
      docSchemaVersion: DOC_SCHEMA_VERSION,
      style: '.page h1 { color: rgb(1, 2, 3); }',
      meta: { title: 'Stored', lang: 'fr', theme: '5eDMG' },
    } as unknown as BrewForEdit;
    const loadChain = vi.fn(() => Promise.resolve(chain));
    const render = vi.fn((_html: string, _options: { signal?: AbortSignal }) => Promise.resolve({ pdf, missingFiles: 0 }));

    const result = await exportStoredBrewPdf(brew, { title: 'Stored brew', loadChain, render });

    expect(loadChain).toHaveBeenCalledWith('5eDMG', { signal: undefined });
    const html = render.mock.calls[0]![0];
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('rgb(1, 2, 3)');
    expect(result.filename).toBe('Stored brew.pdf');
  });
});
