import { describe, expect, it } from 'vitest';
import { createHbfmRenderer } from './hbfm/renderer';
import { sanitizeImportHtml, sanitizeImportHtmlDetailed } from './sanitize';

describe('sanitizeImportHtml', () => {
  it('keeps what the schema holds: classes, styles, ids, data-/aria-, table and image attributes', () => {
    const html = [
      '<div class="block note" id="n1" style="color: red;" data-x="1" aria-label="note"><h5 id="h">T</h5></div>',
      '<p align="Center"><span class="inline-block pink" style="width:10px">s</span></p>',
      '<table><thead><tr><th align="center" colspan="2">H</th></tr></thead><tbody><tr><td rowspan="2" width="50%">c</td></tr></tbody></table>',
      '<p><img loading="lazy" src="/a.png" alt="A" style="--HB_src:url(/a.png);" title="t"></p>',
      '<ol start="3"><li>x</li></ol>',
      '<dl><dt>T</dt><dd>D</dd></dl>',
      '<div class="columnSplit"></div><div class="blank"></div>',
      '<p><a href="#p3" title="go">link</a> <i class="df d12-2"></i> <sup>a</sup><sub>b</sub></p>',
    ].join('');
    expect(sanitizeImportHtml(html)).toBe(html);
  });

  it('keeps markdeep SVG diagrams', () => {
    const svg = createHbfmRenderer().render('```asciiArt\n+--+\n|  |\n+--+\n```');
    expect(svg).toContain('<svg');
    const out = sanitizeImportHtml(svg);
    expect(out).toContain('<svg');
    expect(out).toContain('<path');
  });

  it('removes scripts, event handlers, javascript: URLs, iframes, forms and styles', () => {
    const { html, removed } = sanitizeImportHtmlDetailed(
      [
        '<p onclick="alert(1)" onmouseover="x()">a</p>',
        '<script>alert(1)</script>',
        '<a href="javascript:alert(1)">x</a>',
        '<a href=" jav&#x09;ascript:alert(1)">y</a>',
        '<img src="x" onerror="alert(1)">',
        '<iframe src="https://example.com"></iframe>',
        '<object data="x"></object><embed src="x">',
        '<form action="/x"><input name="a"><button formaction="/y">b</button></form>',
        '<style>.page{}</style><link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0">',
        '<svg><script>alert(1)</script><foreignObject><p>x</p></foreignObject><use href="#a"></use></svg>',
        '<div contenteditable="true" tabindex="0">e</div>',
      ].join(''),
    );
    expect(html).not.toMatch(/on\w+=/i);
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|<form|<input|<button|<style|<link|<meta|<foreignobject|<use/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/contenteditable|tabindex/);
    expect(html).toContain('<p>a</p>');
    expect(removed.elements.script).toBe(2);
    expect(removed.elements.iframe).toBe(1);
    expect(removed.attributes.onclick).toBe(1);
  });

  it('reports no removals for clean pages (DOMPurify scaffolding is not content)', () => {
    for (const html of ['', 'text', '<p>a</p>', '<div class="block note"><p>x</p></div>\n\n<p>y</p>\n', ' <p>a</p> ']) {
      expect(sanitizeImportHtmlDetailed(html).removed, JSON.stringify(html)).toEqual({ elements: {}, attributes: {} });
    }
    const rendered = createHbfmRenderer().render('# Title\n\n{{note\n##### Note\nText\n}}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(sanitizeImportHtmlDetailed(rendered).removed).toEqual({ elements: {}, attributes: {} });
  });

  it('still counts a <remove> or <body> tag the author wrote (text kept)', () => {
    const { html, removed } = sanitizeImportHtmlDetailed('<p><remove>kept</remove></p><body onload="x()">b</body>');
    expect(html).toBe('<p>kept</p>b');
    expect(removed.elements).toEqual({ remove: 1 });
  });

  it('keeps the text of tags without a rule', () => {
    expect(sanitizeImportHtml('<p><font color="red">red</font> <marquee>m</marquee></p>')).toBe('<p><font color="red">red</font> m</p>');
  });
});
