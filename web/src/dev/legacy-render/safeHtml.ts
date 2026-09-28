// Upstream's safeHTML (legacy/client/homebrew/brewRenderer/safeHTML.js), for the S3 harness
// only: the reference render must sanitize exactly as upstream did. The importer uses DOMPurify
// (editor/import/sanitize.ts) instead.

let div: HTMLDivElement | null = null;

// oxlint-disable-next-line no-control-regex -- the characters upstream strips before checking for javascript:
const IGNORED = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205f\u3000]/g;
const BLACKLIST_TAGS = ['script', 'noscript', 'noembed'];
const BLACKLIST_ATTRS: Array<(attr: Attr) => boolean> = [
  (a) => a.localName.indexOf('on') === 0,
  (a) => a.localName.indexOf('type') === 0 && /submit/i.test(a.value),
  (a) => a.value.replace(IGNORED, '').toLowerCase().trim().indexOf('javascript:') === 0,
];

export function safeHTML(htmlString: string): string {
  div ??= document.implementation.createHTMLDocument('').createElement('div');
  div.innerHTML = htmlString;
  div.querySelectorAll('*').forEach((element) => {
    if (BLACKLIST_TAGS.includes(element.localName.toLowerCase())) {
      element.remove();
      return;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (BLACKLIST_ATTRS.some((test) => test(attribute))) element.removeAttribute(attribute.name);
    }
  });
  return div.innerHTML;
}
