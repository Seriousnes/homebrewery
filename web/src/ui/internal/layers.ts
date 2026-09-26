// Portal layers, the modal stack and the Escape stack.
//
// Every portaled piece of UI (dialog, popover, menu, tooltip, toaster) renders into its own
// "layer" div inside one shared portal root at the end of <body>. Layers stack in DOM order (a
// popover opened from a dialog comes after it, so it is on top); the toaster's layer sits above
// all of them by z-index.
//
// While a modal is open, everything outside it is made inert: the rest of <body>, and the layers
// that came before it — except the toaster, so toasts stay readable and actionable. Page scroll is
// locked. Escape is routed to the top-most layer that asked for it (a tooltip, then a menu, then
// the dialog under it).

export const PORTAL_ROOT_ATTR = 'data-hb-portal-root';
export const LAYER_ATTR = 'data-hb-layer';
export type LayerKind = 'layer' | 'toast';

let portalRoot: HTMLElement | null = null;

/** The shared portal root (created at the end of <body> on first use). */
export function getPortalRoot(doc: Document = document): HTMLElement {
  if (portalRoot?.isConnected && portalRoot.ownerDocument === doc) return portalRoot;
  const existing = doc.querySelector<HTMLElement>(`[${PORTAL_ROOT_ATTR}]`);
  if (existing) return (portalRoot = existing);
  const root = doc.createElement('div');
  root.setAttribute(PORTAL_ROOT_ATTR, '');
  doc.body.appendChild(root);
  return (portalRoot = root);
}

/** The layer element (portal container) that contains `node`, if any. */
export function layerOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest<HTMLElement>(`[${LAYER_ATTR}]`) ?? null;
}

/** True when `node` is inside a layer that comes after `layer` in DOM order (UI opened from it). */
export function isInLaterLayer(node: Node | null, layer: HTMLElement | null): boolean {
  const other = layerOf(node);
  if (!other || !layer || other === layer) return false;
  return Boolean(layer.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** True when `node` is inside the toaster's layer. */
export function isInToastLayer(node: Node | null): boolean {
  return layerOf(node)?.getAttribute(LAYER_ATTR) === 'toast';
}

// ─── Modal stack ────────────────────────────────────────────────────────────────────────────────

const modalStack: HTMLElement[] = [];
const madeInert = new Set<Element>();
let savedScroll: { overflow: string; paddingRight: string } | null = null;

/** Make `layer` modal until the returned function runs. Modals nest (the last one wins). */
export function pushModalLayer(layer: HTMLElement): () => void {
  modalStack.push(layer);
  syncModalState(layer.ownerDocument);
  return () => {
    const index = modalStack.lastIndexOf(layer);
    if (index >= 0) modalStack.splice(index, 1);
    syncModalState(layer.ownerDocument);
  };
}

export function topModalLayer(): HTMLElement | undefined {
  return modalStack.at(-1);
}

function syncModalState(doc: Document): void {
  const top = modalStack.at(-1);
  const wanted = new Set<Element>();
  if (top) {
    const root = getPortalRoot(doc);
    for (const child of Array.from(doc.body.children)) {
      if (child !== root && !child.contains(top) && !(child instanceof HTMLScriptElement)) wanted.add(child);
    }
    for (const layer of Array.from(root.children)) {
      if (layer === top) break;
      if (layer.getAttribute(LAYER_ATTR) !== 'toast') wanted.add(layer);
    }
  }
  for (const el of Array.from(madeInert)) {
    if (!wanted.has(el)) {
      el.removeAttribute('inert');
      madeInert.delete(el);
    }
  }
  for (const el of wanted) {
    // Leave elements that were inert already (someone else's) alone.
    if (!el.hasAttribute('inert')) {
      el.setAttribute('inert', '');
      madeInert.add(el);
    }
  }
  lockScroll(doc, Boolean(top));
}

function lockScroll(doc: Document, lock: boolean): void {
  const html = doc.documentElement;
  if (lock && !savedScroll) {
    savedScroll = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
    const scrollbar = (doc.defaultView?.innerWidth ?? 0) - html.clientWidth;
    html.style.overflow = 'hidden';
    if (scrollbar > 0) html.style.paddingRight = `${scrollbar}px`;
  } else if (!lock && savedScroll) {
    html.style.overflow = savedScroll.overflow;
    html.style.paddingRight = savedScroll.paddingRight;
    savedScroll = null;
  }
}

// ─── Escape stack ───────────────────────────────────────────────────────────────────────────────

interface EscapeEntry {
  onEscape: (event: KeyboardEvent) => void;
}

const escapeStack: EscapeEntry[] = [];

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  const top = escapeStack.at(-1);
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.onEscape(event);
}

/**
 * Receive Escape while this is the most recently registered open layer. The listener is on the
 * document (bubble phase), so a focused control that handles Escape itself and calls
 * preventDefault or stopPropagation wins.
 */
export function registerEscape(onEscape: (event: KeyboardEvent) => void, doc: Document = document): () => void {
  const entry: EscapeEntry = { onEscape };
  if (escapeStack.length === 0) doc.addEventListener('keydown', handleEscape);
  escapeStack.push(entry);
  return () => {
    const index = escapeStack.indexOf(entry);
    if (index >= 0) escapeStack.splice(index, 1);
    if (escapeStack.length === 0) doc.removeEventListener('keydown', handleEscape);
  };
}
