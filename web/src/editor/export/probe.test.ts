import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentText, createIframeProbe, excludedHeadings, HEADING_INDEX_ATTR, pageSizes, textFonts, usedCssUrls } from './probe';

/**
 * The test document with `css` and `body` (jsdom: no layout, no FontFaceSet, and only a document
 * with a window has stylesheets).
 */
function documentWith(css: string, body: string): Document {
  const style = document.createElement('style');
  style.setAttribute('data-probe-test', '');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = body;
  return document;
}

afterEach(() => {
  document.body.innerHTML = '';
  for (const el of Array.from(document.head.querySelectorAll('[data-probe-test]'))) el.remove();
});

describe('usedCssUrls', () => {
  it("keeps the url()s of rules that match an element, in any media, with pseudo-elements and states dropped", () => {
    const doc = documentWith(
      [
        '.page .note { background: url(http://x.test/note.png) }',
        '.page .missing { background: url(http://x.test/missing.png) }',
        '.page .note::before { background: url(http://x.test/before.png) }',
        '.page a:hover { background: url(http://x.test/hover.png) }',
        '@media print { .page .note { border-image: url(http://x.test/print.png) } }',
        '@supports (display: grid) { .gone { background: url(http://x.test/gone.png) } }',
        '.page .note { color: red }',
      ].join('\n'),
      '<div class="page"><div class="note">n</div><a href="#x">a</a></div>',
    );
    expect([...usedCssUrls(doc)].sort()).toEqual(['http://x.test/before.png', 'http://x.test/hover.png', 'http://x.test/note.png', 'http://x.test/print.png']);
  });

  it('keeps what it cannot judge: selectors querySelector rejects', () => {
    // (jsdom drops @font-face src and @page backgrounds; the e2e specs cover those in browsers.)
    const doc = documentWith('.page:unknown-pseudo(1) { background: url(http://x.test/odd.png) }', '<div class="page"></div>');
    expect([...usedCssUrls(doc)]).toEqual(['http://x.test/odd.png']);
  });
});

describe('excludedHeadings', () => {
  it('reads the computed --TOC of the marked headings', () => {
    document.body.innerHTML = `<h2 ${HEADING_INDEX_ATTR}="0">A</h2><h2 ${HEADING_INDEX_ATTR}="1" data-toc="exclude">B</h2><h2 ${HEADING_INDEX_ATTR}="2" data-toc="'include'">C</h2><h2 data-toc="exclude">unmarked</h2>`;
    // The value as a theme gives it (jsdom has no cascade for custom properties).
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (el: Element) => ({ getPropertyValue: (name: string) => (name === '--TOC' ? (el.getAttribute('data-toc') ?? '') : '') }) as CSSStyleDeclaration,
    );
    try {
      expect([...excludedHeadings(document)]).toEqual([1]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('contentText', () => {
  it('reads strings, counters and quotes of a computed content value', () => {
    expect(contentText('none')).toBe('');
    expect(contentText('normal')).toBe('');
    expect(contentText('"Page " counter(page-numbers)')).toBe('Page 0123456789');
    expect(contentText("'a\\'b' counters(x, \".\")")).toBe("a'b0123456789.");
    expect(contentText('open-quote')).toBe('“”‘’"\'');
  });
});

describe('textFonts', () => {
  it('collects the font and characters of every text', () => {
    documentWith('', '<p style="font: italic 700 12px Foo, serif">Hello</p><p style="font-family: Bar">ab<b style="font-family: Baz">c</b></p><div style="display: none; font-family: Hidden">x</div>');
    const fonts = textFonts(document);
    const entries = Array.from(fonts);
    expect(entries.some(([font, text]) => font.includes('Foo') && font.includes('italic') && font.includes('700') && text === 'Helo')).toBe(true);
    expect(entries.some(([font, text]) => font.includes('Bar') && text === 'ab')).toBe(true);
    expect(entries.some(([font, text]) => font.includes('Baz') && text === 'c')).toBe(true);
    expect(entries.some(([font]) => font.includes('Hidden'))).toBe(false);
  });
});

describe('pageSizes', () => {
  it('measures every page of div.pages', () => {
    const doc = documentWith('', '<div class="pages"><div class="page"></div><div class="page"></div><div><div class="page"></div></div></div>');
    expect(pageSizes(doc)).toEqual([
      { width: 0, height: 0 },
      { width: 0, height: 0 },
    ]);
  });
});

describe('createIframeProbe', () => {
  it('lays the document out in a hidden, script-less iframe and removes it afterwards', async () => {
    const probe = createIframeProbe({ fontsTimeoutMs: 100 });
    const html = `<!DOCTYPE html><html><head><style>.page .note { background: url(http://x.test/n.png) } .gone { background: url(http://x.test/g.png) }</style></head><body class="hb-canvas"><div class="pages"><div class="page"><div class="note"></div><h2 ${HEADING_INDEX_ATTR}="0">T</h2></div></div></body></html>`;
    const result = await probe(html);
    expect(result.cssUrls.has('http://x.test/n.png')).toBe(true);
    expect(result.cssUrls.has('http://x.test/g.png')).toBe(false);
    expect(result.pageSizes).toHaveLength(1);
    expect(result.fontsSettled).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('gives the iframe no script permission and hides it from assistive technology', async () => {
    let seen: HTMLIFrameElement | null = null;
    const observer = new MutationObserver(() => {
      seen ??= document.querySelector('iframe');
    });
    observer.observe(document.body, { childList: true });
    await createIframeProbe({ fontsTimeoutMs: 50 })('<!DOCTYPE html><html><body></body></html>');
    observer.disconnect();
    expect(seen).not.toBeNull();
    expect(seen!.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(seen!.getAttribute('aria-hidden')).toBe('true');
    expect(seen!.getAttribute('tabindex')).toBe('-1');
  });
});
