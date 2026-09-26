// Focus helpers for dialogs, popovers, menus and toolbars.

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isHidden(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return true;
  // Layout-based check where the browser supports it (jsdom doesn't).
  return typeof el.checkVisibility === 'function' ? !el.checkVisibility({ visibilityProperty: true }) : false;
}

/** Focusable elements under `root` (tabindex -1 included), in DOM order. */
export function getFocusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !isHidden(el));
}

/** Elements under `root` reachable with Tab, in DOM order; one radio per group. */
export function getTabbables(root: ParentNode): HTMLElement[] {
  const radios = new Map<string, HTMLInputElement>();
  const out: HTMLElement[] = [];
  for (const el of getFocusables(root)) {
    if (el.tabIndex < 0) continue;
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const key = `${el.form?.id ?? ''}|${el.name}`;
      const seen = radios.get(key);
      if (seen) {
        if (el.checked && !seen.checked) out[out.indexOf(seen)] = el;
        if (el.checked) radios.set(key, el);
        continue;
      }
      radios.set(key, el);
    }
    out.push(el);
  }
  return out;
}

/**
 * The tabbable element that follows `el` in the page's tab order, skipping portaled layers
 * (popovers, dialogs, toasts), or null at the end.
 */
export function tabbableAfter(el: HTMLElement): HTMLElement | null {
  const doc = el.ownerDocument;
  const inLayer = (node: Element) => node.closest('[data-hb-portal-root]') !== null;
  const page = getTabbables(doc.body).filter((node) => !inLayer(node));
  for (const node of page) {
    if (node !== el && !el.contains(node) && el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) return node;
  }
  return null;
}

/** Focus without scrolling the page (scroll containers still reveal the element). */
export function focusElement(el: HTMLElement | null | undefined, options: FocusOptions = { preventScroll: true }): boolean {
  if (!el || !el.isConnected) return false;
  el.focus(options);
  return el.ownerDocument.activeElement === el;
}

/** Focus the first tabbable element in `root`; else `root` itself when it is focusable. */
export function focusFirst(root: HTMLElement): boolean {
  const first = getTabbables(root)[0];
  if (first) return focusElement(first);
  return focusElement(root);
}

/** The deepest active element (through shadow roots). */
export function activeElement(doc: Document = document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * Keep Tab inside `container`: call from its keydown handler. Returns true when it moved focus
 * (and prevented the default).
 */
export function trapTab(event: KeyboardEvent | { key: string; shiftKey: boolean; target: EventTarget | null; preventDefault(): void }, container: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const tabbables = getTabbables(container);
  const first = tabbables[0];
  const last = tabbables.at(-1);
  const target = event.target as Node | null;
  if (!first || !last) {
    event.preventDefault();
    focusElement(container);
    return true;
  }
  const outside = !target || !container.contains(target);
  if (event.shiftKey && (target === first || target === container || outside)) {
    event.preventDefault();
    focusElement(last);
    return true;
  }
  if (!event.shiftKey && (target === last || target === container || outside)) {
    event.preventDefault();
    focusElement(first);
    return true;
  }
  return false;
}
