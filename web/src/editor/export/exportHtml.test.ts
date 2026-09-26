import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_ASSETS, exportDevDocs, EXTERNAL_IMAGE } from '../../dev/export/devDocs';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import { docOf, node, p, page, text } from '../schema/testing';
import { exportBrewHtml, exportDocument, exportFileName, pageRule } from './exportHtml';
import type { ExportProbe, ExportProbeResult } from './probe';
import { HEADING_INDEX_ATTR } from './probe';

const ORIGIN = 'http://localhost:5173';
const BASE = `${ORIGIN}/share/abc123`;
const THEME_CSS_URL = `${ORIGIN}/themes/V3/5ePHB/style.scoped.css`;

const THEME_CSS = [
  "@font-face { font-family: 'Book'; src: url('../../../fonts/5e/Book.woff2') format('woff2'); }",
  "@font-face { font-family: 'Unused'; src: url('../../../fonts/5e/Unused.woff2') format('woff2'); }",
  '.hb-canvas .page { background-image: url("../../../assets/parchmentBackground.jpg"); }',
  '.hb-canvas .page .neverUsed { background-image: url("../../../assets/unused.png"); }',
].join('\n');

const USED_CSS = new Set([`${ORIGIN}/fonts/5e/Book.woff2`, `${ORIGIN}/assets/parchmentBackground.jpg`, `${ORIGIN}${EXPORT_ASSETS.cssImage}`]);

/** A site answering the theme stylesheet and small files for everything else under /assets and /fonts. */
function fakeSite(missing: string[] = []) {
  const requests: string[] = [];
  const fetch = vi.fn((url: string) => Promise.resolve(answer(url)));
  const answer = (url: string): Response => {
    requests.push(url);
    if (missing.some((m) => url.endsWith(m))) return new Response('', { status: 404 });
    if (url === THEME_CSS_URL) return new Response(THEME_CSS, { headers: { 'content-type': 'text/css' } });
    const path = new URL(url).pathname;
    if (path.startsWith('/assets/') || path.startsWith('/fonts/') || path.startsWith('/src/')) return new Response(`bytes of ${path}`, { status: 200 });
    return new Response('', { status: 404 });
  };
  return { fetch, requests };
}

/** A probe that excludes the headings named in `exclude` and uses USED_CSS; records its input. */
function fakeProbe(exclude: string[] = ['Innkeeper'], pages = 3): { probe: ExportProbe; inputs: string[] } {
  const inputs: string[] = [];
  const probe: ExportProbe = (html) => {
    inputs.push(html);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const excluded = new Set<number>();
    for (const el of Array.from(parsed.querySelectorAll(`[${HEADING_INDEX_ATTR}]`))) {
      if (exclude.includes(el.textContent ?? '')) excluded.add(Number(el.getAttribute(HEADING_INDEX_ATTR)));
    }
    const result: ExportProbeResult = {
      excludedHeadings: excluded,
      cssUrls: USED_CSS,
      fontsSettled: true,
      pageSizes: Array.from({ length: pages }, () => ({ width: 816, height: 1056 })),
    };
    return Promise.resolve(result);
  };
  return { probe, inputs };
}

const chain = { styles: [{ kind: 'url' as const, href: '/themes/V3/5ePHB/style.scoped.css' }] };
const b64 = (text: string) => btoa(text);

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

describe('exportBrewHtml', () => {
  it('writes one self-contained document: used files inlined, TOC exclusions applied, page size set', async () => {
    const site = fakeSite();
    const { probe, inputs } = fakeProbe();
    const { html, report, filename } = await exportBrewHtml(exportDevDocs.inn!.content, {
      chain,
      userCss: exportDevDocs.inn!.css,
      lang: 'en',
      title: 'The <Exported> Inn',
      baseUrl: BASE,
      fetch: site.fetch,
      probe,
    });

    // The probe saw the file with absolute URLs and the heading markers.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain(`src="${ORIGIN}${EXPORT_ASSETS.inlineImage}"`);
    expect(inputs[0]).toContain(HEADING_INDEX_ATTR);
    expect(inputs[0]).not.toContain('data:image/jpeg');

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(HEADING_INDEX_ATTR);
    expect(parsed.title).toBe('The <Exported> Inn');
    expect(filename).toBe('The Exported Inn.html');
    expect(parsed.documentElement.lang).toBe('en');
    expect(parsed.querySelectorAll('body.hb-canvas > .pages > .page')).toHaveLength(3);

    // Stylesheets: the page rule first, then the theme, the app's canvas CSS, the brew's.
    const styles = Array.from(parsed.querySelectorAll('style')).map((s) => s.getAttribute('data-hb-export'));
    expect(styles).toEqual(['page', 'theme', 'editor', 'brew']);
    expect(parsed.querySelector('style[data-hb-export="page"]')?.textContent).toContain('size: 816px 1056px;');
    expect(report.pageSize).toBe('816px 1056px');

    // Used url()s are data: URIs, unused ones stay links; images of the pages are written in.
    const theme = parsed.querySelector('style[data-hb-export="theme"]')?.textContent ?? '';
    expect(theme).toContain(`url("data:font/woff2;base64,${b64('bytes of /fonts/5e/Book.woff2')}")`);
    expect(theme).toContain(`url("data:image/jpeg;base64,${b64('bytes of /assets/parchmentBackground.jpg')}")`);
    expect(theme).toContain(`${ORIGIN}/fonts/5e/Unused.woff2`);
    expect(theme).toContain(`${ORIGIN}/assets/unused.png`);
    expect(site.requests).not.toContain(`${ORIGIN}/fonts/5e/Unused.woff2`);
    expect(parsed.querySelector('style[data-hb-export="brew"]')?.textContent).toContain(`data:image/png;base64,${b64(`bytes of ${EXPORT_ASSETS.cssImage}`)}`);
    const inline = parsed.querySelector<HTMLImageElement>('#p1 .columnWrapper img[alt="A cat warrior"]')!;
    expect(inline.getAttribute('src')).toBe(`data:image/jpeg;base64,${b64(`bytes of ${EXPORT_ASSETS.inlineImage}`)}`);
    expect(inline.getAttribute('style')).toContain(`--HB_src: url("data:image/jpeg;base64,`);
    const object = parsed.querySelector('#p1 > img')!;
    expect(object.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);

    // The TOC leaves out what the theme excludes.
    const toc = parsed.querySelector('.toc')!;
    expect(toc.textContent).toContain('Chapter One: Arrival');
    expect(toc.textContent).not.toContain('Innkeeper');

    expect(report).toMatchObject({ pages: 3, external: [], failed: [], removed: 0, fontsSettled: true });
    expect(report.inlined).toBe(5); // font, background, badge, inline image, object image
    expect(report.bytes).toBe(new TextEncoder().encode(html).length);
  });

  it("lists other sites' images and files it couldn't fetch, and leaves them as links", async () => {
    const site = fakeSite([EXPORT_ASSETS.objectImage]);
    const { html, report } = await exportBrewHtml(exportDevDocs.external!.content, { chain, baseUrl: BASE, fetch: site.fetch, probe: fakeProbe().probe });
    expect(report.external).toEqual([EXTERNAL_IMAGE]);
    expect(report.failed).toEqual([`${ORIGIN}${EXPORT_ASSETS.objectImage}`]);
    expect(html).toContain(`src="${EXTERNAL_IMAGE}"`);
    expect(html).toContain(`src="${ORIGIN}${EXPORT_ASSETS.objectImage}"`);
    expect(site.requests.some((r) => r.startsWith('https://images.example.invalid'))).toBe(false);
  });

  it('makes relative links absolute, keeps fragments, and removes active content', async () => {
    const doc = docOf(
      page([
        node('paragraph', undefined, [
          { type: 'text', text: 'share', marks: [{ type: 'link', attrs: { href: '/share/other' } }] },
          text(' '),
          { type: 'text', text: 'page', marks: [{ type: 'link', attrs: { href: '#p1' } }] },
        ]),
        node('rawHtml', { html: '<div data-x="1"><img src="/assets/a.png" srcset="/assets/a@2x.png 2x" alt="" onerror="alert(1)"></div>' }),
      ]),
    );
    const { html, report } = await exportBrewHtml(doc, { chain: { styles: [] }, baseUrl: BASE, fetch: fakeSite().fetch, probe: null });
    expect(html).toContain(`href="${ORIGIN}/share/other"`);
    expect(html).toContain('href="#p1"');
    expect(html).not.toContain('srcset');
    expect(html).not.toContain('onerror');
    expect(html).toContain(`src="data:image/png;base64,${b64('bytes of /assets/a.png')}"`);
    // The schema sanitizes raw HTML when it is stored; stripActiveContent is the second line (serialize.test.ts).
    expect(report.removed).toBe(0);
  });

  it('without a probe, writes in every url() and sets no page size', async () => {
    const site = fakeSite();
    const { html, report } = await exportBrewHtml(docOf(page([p('Hello')])), { chain, baseUrl: BASE, fetch: site.fetch, probe: null });
    expect(site.requests).toContain(`${ORIGIN}/fonts/5e/Unused.woff2`);
    expect(html).not.toContain(`${ORIGIN}/assets/unused.png`);
    expect(report.pageSize).toBeNull();
    expect(html).toContain('@page {\n  margin: 0;\n}');
  });

  it('exports the editor document (pagination finished first)', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: editorNodeViews }), content: docOf(page([p('From the editor')])) });
    expect(exportDocument(editor)).toBe(editor.state.doc);
    const { html } = await exportBrewHtml(editor, { chain: { styles: [] }, baseUrl: BASE, fetch: fakeSite().fetch, probe: null });
    expect(html).toContain('From the editor');
    // Heading ids and page ids of the editor.
    expect(html).toContain('id="p1"');
  });

  it('accepts ProseMirror JSON and nodes', () => {
    const json: JSONContent = docOf(page([p('x')]));
    const fromJson = exportDocument(json);
    expect(fromJson.type.name).toBe('doc');
    expect(exportDocument(fromJson)).toBe(fromJson);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exportBrewHtml(docOf(page([p('x')])), { chain, baseUrl: BASE, fetch: fakeSite().fetch, probe: null, signal: controller.signal })).rejects.toThrow();
  });
});

describe('exportFileName', () => {
  it.each([
    ['The Exported Inn', 'The Exported Inn.html'],
    ['  a/b\\c:d*e?f"g<h>i|j  ', 'a b c d e f g h i j.html'],
    ['...dots...', 'dots.html'],
    ['', 'brew.html'],
    [undefined, 'brew.html'],
    ['x'.repeat(150), `${'x'.repeat(100)}.html`],
    ['Grimoire — édition', 'Grimoire — édition.html'],
  ])('%j → %j', (title, expected) => {
    expect(exportFileName(title)).toBe(expected);
  });
});

describe('pageRule', () => {
  it('sets the size when every page has the same one, unrounded', () => {
    expect(pageRule([{ width: 816, height: 1056 }, { width: 816, height: 1056 }])).toEqual({ css: '@page {\n  size: 816px 1056px;\n  margin: 0;\n}', size: '816px 1056px' });
    expect(pageRule([{ width: 559.359375, height: 793.703125 }]).size).toBe('559.359375px 793.703125px');
  });

  it('only removes the margins when sizes differ or are unknown', () => {
    expect(pageRule([{ width: 816, height: 1056 }, { width: 600, height: 800 }])).toEqual({ css: '@page {\n  margin: 0;\n}', size: null });
    expect(pageRule([]).size).toBeNull();
    expect(pageRule([{ width: 0, height: 0 }]).size).toBeNull();
  });
});
