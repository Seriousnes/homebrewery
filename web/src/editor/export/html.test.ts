import { describe, expect, it } from 'vitest';
import { EXPORT_CSP, escapeAttribute, escapeText, exportDocumentHtml, serializeHtml } from './html';

const fragment = (html: string) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

describe('serializeHtml', () => {
  it('writes elements, attributes and text like the browser does', () => {
    const root = fragment('<p class="a b" data-x="1">Hello <strong>world</strong><br>again</p><hr><img src="x.png" alt="">');
    expect(serializeHtml(root)).toBe('<div><p class="a b" data-x="1">Hello <strong>world</strong><br>again</p><hr><img src="x.png" alt=""></div>');
  });

  it('escapes < and > in attributes and text, so nothing reads as markup', () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('alt', '"><script>alert(1)</script>');
    img.setAttribute('title', 'a & b');
    root.append(img, document.createTextNode('</div><script>x</script> & \u00a0'));
    const html = serializeHtml(root);
    expect(html).not.toMatch(/<script/i);
    expect(html).toBe('<div><img alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" title="a &amp; b">&lt;/div&gt;&lt;script&gt;x&lt;/script&gt; &amp; &nbsp;</div>');
    // Parsed back, it is the same content.
    const back = fragment(html);
    expect(back.querySelector('img')?.getAttribute('alt')).toBe('"><script>alert(1)</script>');
    expect(back.firstElementChild?.textContent).toBe('</div><script>x</script> & \u00a0');
  });

  it('drops comments and keeps style text as CSS that cannot close the element', () => {
    const root = document.createElement('div');
    root.append(document.createComment('secret <script>'));
    const style = document.createElement('style');
    style.textContent = 'p::after { content: "</style><script>" }';
    root.append(style);
    const html = serializeHtml(root);
    expect(html).toBe('<div><style>p::after { content: "\\3c /style>\\3c script>" }</style></div>');
  });

  it('keeps SVG names in their case', () => {
    const root = fragment('<svg viewBox="0 0 10 10"><linearGradient id="g"></linearGradient><circle r="1"></circle></svg>');
    const html = serializeHtml(root);
    expect(html).toContain('<svg viewBox="0 0 10 10">');
    expect(html).toContain('<linearGradient id="g"></linearGradient>');
  });

  it('serializes a template\'s content and fragments', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = '<b>t</b>';
    expect(serializeHtml(tpl)).toBe('<template><b>t</b></template>');
    const frag = document.createDocumentFragment();
    frag.append(document.createElement('i'), document.createTextNode('x'));
    expect(serializeHtml(frag)).toBe('<i></i>x');
  });

  it('escapes the helpers', () => {
    expect(escapeText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    expect(escapeAttribute('"<>&')).toBe('&quot;&lt;&gt;&amp;');
  });
});

describe('exportDocumentHtml', () => {
  it('is a document with the CSP, title, stylesheets in order and body.hb-canvas', () => {
    const html = exportDocumentHtml({
      lang: 'fr',
      title: 'Mon <grimoire>',
      styles: [
        { name: 'page', css: '@page { margin: 0 }' },
        { name: 'theme', css: '.page { color: red }' },
        { name: 'empty', css: '  ' },
        { name: 'brew', css: '.x::before { content: "</style>" }' },
      ],
      pages: '<div class="pages ProseMirror" contenteditable="false"></div>',
    });
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="fr">')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`);
    expect(html).toContain('<title>Mon &lt;grimoire&gt;</title>');
    expect(html).toContain('<body class="hb-canvas" lang="fr">\n<div class="pages ProseMirror" contenteditable="false"></div>\n</body>');
    const order = ['page', 'theme', 'brew'].map((name) => html.indexOf(`data-hb-export="${name}"`));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(html).not.toContain('data-hb-export="empty"');
    expect(html).toContain('content: "\\3c /style>"');
    expect(html).not.toMatch(/<script/i);
  });

  it('parses back into the same structure', () => {
    const html = exportDocumentHtml({ lang: '', title: 'T', styles: [], pages: '<div class="pages"><div class="page" id="p1"></div></div>' });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.documentElement.lang).toBe('en');
    expect(parsed.body.className).toBe('hb-canvas');
    expect(parsed.querySelector('body > .pages > .page#p1')).not.toBeNull();
    expect(parsed.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
  });
});
