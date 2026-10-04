// hbfmToDoc in jsdom: no layout, so the probe is mountInlineProbe (computed styles see inline
// styles and the <style> below only). Theme-dependent lifting is covered by the S3 Playwright
// harness (e2e/import).
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountInlineProbe, type Probe } from '../canvas/probe';
import { schema } from '../schema/testing';
import { tocEntries } from '../toc';
import { hbfmToDoc, ImportError, type HbfmToDocOptions } from './hbfmToDoc';

const options: HbfmToDocOptions = { probe: () => Promise.resolve(mountInlineProbe()) };
let sheet: HTMLStyleElement;

beforeEach(() => {
  // What the theme would say: pages are positioned (containing block), footers/page numbers too.
  sheet = document.createElement('style');
  sheet.textContent = '.page { position: relative } .pageNumber, .footnote { position: absolute }';
  document.head.appendChild(sheet);
});
afterEach(() => {
  sheet.remove();
  document.body.innerHTML = '';
});

const pages = (doc: JSONContent) => doc.content ?? [];
const types = (page: JSONContent | undefined) => (page?.content ?? []).map((n) => n.type);
const text = (n: JSONContent | undefined): string => (n?.text ?? '') + (n?.content ?? []).map(text).join('');

describe('hbfmToDoc', () => {
  it('splits pages, keeps \\page classes and styles, marks pages manual', async () => {
    const { doc, report } = await hbfmToDoc('# One\n\nFirst page.\n\\page {wide,color:red,data-x=1}\n## Two\n\nSecond page.', options);
    expect(pages(doc)).toHaveLength(2);
    expect(report.pages).toBe(2);
    expect(pages(doc).map((p) => String(p.attrs?.kind))).toEqual(['manual', 'manual']);
    expect(types(pages(doc)[0])).toEqual(['heading', 'paragraph']);
    expect(pages(doc)[1]?.attrs).toMatchObject({ classes: ['wide'], style: 'color: red;', attributes: { 'data-x': '1' } });
    expect(text(pages(doc)[1])).toBe('TwoSecond page.');
  });

  it('reads metadata and CSS, and lifts <style> tags into the brew CSS', async () => {
    const raw = '```metadata\ntitle: T\ntheme: Blank\n```\n\n```css\n.a { color: red }\n```\n\nText <!-- a comment -->\n\n<style>.b { color: blue }</style>\n\nMore';
    const { style, meta, report, doc } = await hbfmToDoc(raw, options);
    expect(meta).toMatchObject({ title: 'T', theme: 'Blank' });
    expect(report.theme).toBe('Blank');
    expect(style).toBe('.a { color: red }\n\n\n.b { color: blue }');
    expect(report.styleTagsLifted).toBe(1);
    expect(report.commentsDropped).toBe(1);
    expect(JSON.stringify(doc)).not.toContain('color: blue');
  });

  it('rejects legacy-renderer brews', async () => {
    await expect(hbfmToDoc('```metadata\nrenderer: legacy\n```\n\n# x', options)).rejects.toBeInstanceOf(ImportError);
  });

  it('lifts markers, the footer and the page number into page attributes', async () => {
    const { doc, report } = await hbfmToDoc('{{frontCover}}\n\n# Cover\n\n{{pageNumber,auto}}\n{{footnote PART 1 | INTRO}}\n', options);
    const page = pages(doc)[0]!;
    expect(page.attrs).toMatchObject({ markers: ['frontCover'], footer: 'PART 1 | INTRO', pageNumber: true });
    expect(types(page)).toEqual(['heading']);
    expect(report.lifted).toEqual({ markers: 1, footers: 1, pageNumbers: 1, objects: 0 });
  });

  it("lifts an older brew's <div class='pageNumber auto'> into the page number, not a page object", async () => {
    const { doc, report } = await hbfmToDoc("# One\n\n<div class='pageNumber auto'></div>\n\\page\n<div class='pageNumber auto'></div>\n\nTwo", options);
    expect(pages(doc).map((p): unknown[] => [p.attrs?.pageNumber, p.attrs?.objects])).toEqual([
      [true, []],
      [true, []],
    ]);
    expect(types(pages(doc)[1])).toEqual(['paragraph']);
    expect(report.lifted).toEqual({ markers: 0, footers: 0, pageNumbers: 2, objects: 0 });
  });

  it('lifts absolutely positioned images and text into page objects', async () => {
    const md = [
      'Before',
      '',
      '![art](/assets/a.png){position:absolute,top:10px,right:0,width:50%}',
      '',
      '{{pageNumber 7}}',
      '',
      'After',
    ].join('\n');
    const { doc, report } = await hbfmToDoc(md, options);
    const page = pages(doc)[0]!;
    expect(page.attrs?.objects).toEqual([
      { id: 'o1-1', kind: 'image', classes: [], style: 'position: absolute; top: 10px; right: 0px; width: 50%;', src: '/assets/a.png' },
      { id: 'o1-2', kind: 'text', classes: ['pageNumber'], style: '', text: '7' },
    ]);
    expect(types(page)).toEqual(['paragraph', 'paragraph']);
    expect(report.lifted.objects).toBe(2);
    expect(report.lost.some((l) => l.includes('alt text "art"'))).toBe(true);
  });

  it('keeps positioned elements with rich content in the flow', async () => {
    const md = '{{artist,position:absolute,bottom:160px,left:100px\n##### Homebrew Mug\n[naturalcrit](https://homebrew.naturalcrit.com)\n}}';
    const { doc, report } = await hbfmToDoc(md, options);
    expect(types(pages(doc)[0])).toEqual(['themeBlock']);
    expect(report.positionedInFlow).toEqual([expect.objectContaining({ page: 1, tag: 'div', classes: ['artist'] })]);
  });

  it('keeps a positioned span with an image, alone on its line, as a rawHtml block', async () => {
    const md = '{{logo,position:absolute,top:10px ![](/assets/logo.svg)}}\n\n# Title';
    const { doc, report } = await hbfmToDoc(md, options);
    const page = pages(doc)[0]!;
    expect(types(page)).toEqual(['rawHtml', 'heading']);
    expect(String(page.content?.[0]?.attrs?.html)).toMatch(/^<span class="inline-block logo" style="position:absolute; top:10px;"><img /);
    expect(report.positionedInFlow).toEqual([expect.objectContaining({ page: 1, tag: 'span', classes: ['logo'] })]);
    expect(report.rawHtml.count).toBe(1);
  });

  it('leaves a positioned span that shares its line with text in the paragraph', async () => {
    const { doc } = await hbfmToDoc('Before {{logo,position:absolute ![](/a.png)}} after', options);
    expect(types(pages(doc)[0])).toEqual(['paragraph']);
  });

  it('expands variables across pages (render twice) and reports the definitions', async () => {
    const { doc, report } = await hbfmToDoc('Hello $[name]!\n\\page\n[name]: Bob\n\nPage $[HB_pageNumber]', options);
    expect(text(pages(doc)[0])).toBe('Hello Bob!');
    expect(text(pages(doc)[1])).toBe('Page 2');
    expect(report.variables.definitions).toEqual([{ name: 'name', page: 2, form: 'block' }]);
  });

  it('never evaluates code in variable math', async () => {
    const { doc } = await hbfmToDoc('$[constructor.constructor(1)()] $[toString] $[constructor]', options);
    expect(text(pages(doc)[0])).toBe('$[constructor.constructor(1)()] $[toString] $[constructor]');
  });

  it('keeps unknown HTML as rawHtml and counts it', async () => {
    const { doc, report } = await hbfmToDoc('<section class="x">Raw</section>\n\nText', options);
    expect(types(pages(doc)[0])).toEqual(['rawHtml', 'paragraph']);
    expect(report.rawHtml.count).toBe(1);
  });

  it('sanitizes scripts and handlers out of the text', async () => {
    const { doc, report } = await hbfmToDoc('<script>alert(1)</script>\n\n<p onclick="alert(1)">x</p>\n\n<img src=x onerror=alert(1)>', options);
    expect(JSON.stringify(doc)).not.toMatch(/alert|onclick|onerror/);
    expect(report.sanitizer.elements.script).toBe(1);
  });

  it("keeps variable syntax as written with variables: 'keep'", async () => {
    const { doc, report } = await hbfmToDoc('Hello $[name]!\n\\page\n[name]: Bob', { ...options, variables: 'keep' });
    expect(text(pages(doc)[0])).toBe('Hello $[name]!');
    expect(text(pages(doc)[1])).toBe('[name]: Bob');
    expect(report.variables).toEqual({ mode: 'keep', definitions: [{ name: 'name', page: 2, form: 'block' }], unresolved: [{ page: 1, call: '$[name]' }] });
  });

  it('lists only $[…] calls as unresolved (plain [text] is ordinary markdown)', async () => {
    const { doc, report } = await hbfmToDoc('See [Title of Work] and $[missing].', options);
    expect(text(pages(doc)[0])).toBe('See [Title of Work] and $[missing].');
    expect(report.variables.unresolved).toEqual([{ page: 1, call: '$[missing]' }]);
  });

  it('imports an empty text as one page, and CRLF text like LF', async () => {
    const empty = await hbfmToDoc('', options);
    expect(pages(empty.doc)).toHaveLength(1);
    expect(empty.report.commentsDropped).toBe(0);
    const crlf = await hbfmToDoc('# A\r\n\r\ntext\r\n\\page\r\nB', options);
    const lf = await hbfmToDoc('# A\n\ntext\n\\page\nB', options);
    expect(crlf.doc).toEqual(lf.doc);
  });

  it('reports nothing removed for clean HBFM, and counts tags whose attributes are dropped', async () => {
    const { report } = await hbfmToDoc('# T\n\n{{note\nx\n}}\n\n<font color="red">red</font> <span style="color:blue">b</span> <em class="x">e</em>', options);
    expect(report.sanitizer).toEqual({ elements: {}, attributes: {} });
    expect(report.transparentElements).toEqual({ font: 1, 'span (without inline-block)': 1, 'em[class|style|id]': 1 });
  });

  it('keeps \\page tags on the page the way upstream applies them (id ignored)', async () => {
    const { doc } = await hbfmToDoc('A\n\\page {#nope,frontCover,background:red,data-x=1,onclick=alert(1)}\nB', options);
    expect(pages(doc)[1]?.attrs).toMatchObject({ id: null, classes: ['frontCover'], style: 'background: red;', attributes: { 'data-x': '1' } });
    expect(JSON.stringify(doc)).not.toContain('alert');
  });

  it('marks multi-line definition lists', async () => {
    const { doc } = await hbfmToDoc('Term\n::Def one\n::Def two', options);
    expect(pages(doc)[0]?.content?.[0]).toMatchObject({ type: 'definitionList', attrs: { multiline: true } });
  });

  // Plan §6.6: images store their natural size. The probe waits for the images; the sizes it read
  // go into the image nodes (a size the author wrote stays; failed images get none).
  it('records the natural size of the images the probe loaded', async () => {
    const files: Record<string, [number, number]> = { 'a.png': [200, 100], 'c.svg': [64, 32] }; // b.png failed
    let waited = 0;
    const probe = (): Promise<Probe> => {
      const inline = mountInlineProbe();
      const imagesReady = (): Promise<boolean> => {
        waited++;
        for (const img of Array.from(inline.root.querySelectorAll('img'))) {
          const [w, h] = files[img.getAttribute('src') ?? ''] ?? [0, 0];
          Object.defineProperties(img, { complete: { get: () => true }, naturalWidth: { get: () => w }, naturalHeight: { get: () => h } });
        }
        return Promise.resolve(true);
      };
      return Promise.resolve({ ...inline, imagesReady });
    };
    const { doc, report } = await hbfmToDoc('![A](a.png) ![B](b.png) <img src="c.svg" width="50">\n\n![Again](a.png){width:50%}', { probe });
    expect(waited).toBe(1);
    const sizes: unknown[] = [];
    const walk = (n: JSONContent) => {
      if (n.type === 'image') sizes.push([n.attrs?.src, n.attrs?.width, n.attrs?.height]);
      n.content?.forEach(walk);
    };
    walk(doc);
    expect(sizes).toEqual([
      ['a.png', 200, 100],
      ['b.png', null, null],
      ['c.svg', 50, null],
      ['a.png', 200, 100],
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('warns when images do not finish loading', async () => {
    const probe = (): Promise<Probe> => Promise.resolve({ ...mountInlineProbe(), imagesReady: () => Promise.resolve(false) });
    const { report } = await hbfmToDoc('![A](a.png)', { probe });
    expect(report.warnings).toEqual([expect.stringMatching(/images did not finish loading/i)]);
  });

  // UI-8: upstream's generator listed every heading level and let the theme's --TOC decide, so a
  // brew that re-includes h4 (.tocDepthH4 / .tocIncludeH4) listed it. The imported toc must too.
  it('imports {{toc,wide …}} listing every level, so the theme decides about h4–h6', async () => {
    const { doc } = await hbfmToDoc('{{toc,wide\n# Contents\n}}\n\\page\n## Section\n\n{{tocDepthH4\n#### Sub-section\n}}', options);
    const toc = pages(doc)[0]?.content?.[0];
    expect(toc).toMatchObject({ type: 'toc', attrs: { depth: 6 } });
    const entries = tocEntries(PMNode.fromJSON(schema, doc), { depth: Number(toc?.attrs?.depth) });
    expect(entries.map((e) => [e.text, e.level, e.page])).toEqual([
      ['Section', 2, '2'],
      ['Sub-section', 4, '2'],
    ]);
  });
});
