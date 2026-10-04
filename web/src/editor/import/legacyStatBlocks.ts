// Legacy-renderer stat blocks in V3 text → monster frames.
//
// Upstream's legacy renderer drew a stat block for `___` followed by a `>` quote (Legacy/5ePHB
// style.less `hr+blockquote`; `___` twice: full width, `hr + hr + blockquote`). V3 themes have
// no such rule, so a brew copied from a legacy brew without its ```metadata block (renderer:
// legacy) imports as a plain quote with bullets. The quote becomes what V3's monster snippet
// (themes/V3/5ePHB/snippets/monsterblock.gen.js) writes:
//
//   hr, hr, blockquote › h2, p, hr, ul › li › strong …   →   div.block.monster.frame.wide › h2, p, hr, dl › dt, dd …
//
// - Only a quote that starts with an `## name` heading counts: a V3 brew can put a rule before
//   an ordinary quote.
// - `- **Label** value` lists become `**Label** :: value` definition lists.
// - Adjacent paragraphs get the `:` spacer between them (div.blank), as the snippet does; the
//   legacy CSS spaced them with `p + p` padding.

/** Every item starts with a bold label: `- **Armor Class** 8`. */
function isStatList(list: Element): boolean {
  const items = Array.from(list.children);
  return items.length > 0 && items.every((li) => li.tagName === 'LI' && firstContent(li)?.nodeName === 'STRONG');
}

/** The first child that isn't whitespace. */
function firstContent(el: Element): ChildNode | undefined {
  return Array.from(el.childNodes).find((n) => n.nodeType !== 3 /* TEXT_NODE */ || (n.textContent ?? '').trim() !== '');
}

function listToDefinitions(list: Element, doc: Document): HTMLDListElement {
  const dl = doc.createElement('dl');
  for (const li of Array.from(list.children)) {
    const dt = doc.createElement('dt');
    dt.append(firstContent(li)!);
    const dd = doc.createElement('dd');
    dd.append(...Array.from(li.childNodes));
    while (dd.firstChild?.nodeType === 3 /* TEXT_NODE */) {
      const trimmed = (dd.firstChild.textContent ?? '').replace(/^\s+/, '');
      if (trimmed) {
        dd.firstChild.textContent = trimmed;
        break;
      }
      dd.firstChild.remove();
    }
    dl.append(dt, dd);
  }
  return dl;
}

/** Converts legacy stat blocks in a rendered page; returns how many were converted. */
export function convertLegacyStatBlocks(root: ParentNode, doc: Document): number {
  let count = 0;
  for (const quote of Array.from(root.querySelectorAll('blockquote'))) {
    if (quote.firstElementChild?.tagName !== 'H2') continue;
    const rules: Element[] = [];
    for (let prev = quote.previousElementSibling; prev?.tagName === 'HR'; prev = prev.previousElementSibling) rules.push(prev);
    if (rules.length === 0) continue;

    const block = doc.createElement('div');
    block.className = rules.length > 1 ? 'block monster frame wide' : 'block monster frame';
    for (const attr of Array.from(quote.attributes)) {
      if (attr.name === 'class') block.classList.add(...quote.classList);
      else block.setAttribute(attr.name, attr.value);
    }
    for (const child of Array.from(quote.children)) {
      if ((child.tagName === 'UL' || child.tagName === 'OL') && isStatList(child)) child.replaceWith(listToDefinitions(child, doc));
    }
    for (const p of Array.from(quote.querySelectorAll(':scope > p + p'))) {
      const blank = doc.createElement('div');
      blank.className = 'blank';
      p.before(blank);
    }
    block.append(...Array.from(quote.childNodes));
    quote.replaceWith(block);
    for (const hr of rules) hr.remove();
    count++;
  }
  return count;
}
