// Inline images in the editor (plan §6.6, review PG-5).
//
// Natural size: image.attrs.width/height hold the image's natural size. The ImageNaturalSize
// plugin fills them in when an image loads in an editable view (after insert, paste or import),
// outside the undo history, so a saved document knows every image's size before it loads.
//
// Rendering (ImageView): the schema renders width/height as the img's attributes (pagination
// treats an image with both as sized: it never waits for it). Those attributes are presentational
// hints that would fix both dimensions; the view adds data-hb-natural and the canvas.css rule
// `:where(.hb-canvas img[data-hb-natural]) { width: var(--hb-natural-width, auto); height: auto }`
// so layout follows CSS like upstream's attribute-less image while the aspect-ratio hint
// (auto W / H) reserves the right box before the file arrives:
//   no author size            → the natural size (as upstream)
//   width only (theme/author) → proportional height, before and after loading
//   height only (author)      → no width variable, so width follows the ratio
// The src stays in `--HB_src` (the schema's renderHTML), so .wrapLeft/.wrapRight keep working.
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { DOMSerializer } from '@tiptap/pm/model';
import { HbImage } from '../schema';
import { styleValue } from './model';

export const NATURAL_ATTR = 'data-hb-natural';
export const NATURAL_WIDTH_VAR = '--hb-natural-width';

/** Whether the author's style sizes the image by height alone (then the width must follow). */
export function heightOnly(style: unknown): boolean {
  if (typeof style !== 'string') return false;
  const height = styleValue(style, 'height');
  const width = styleValue(style, 'width');
  return height !== null && height !== 'auto' && (width === null || width === 'auto');
}

function positive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Editor view of an inline image: renderHTML's img plus the natural-size hooks. */
export class ImageView implements NodeView {
  readonly dom: HTMLImageElement;
  private node: PMNode;
  private readonly doc: Document;
  private written = new Set<string>();

  constructor(node: PMNode, view?: EditorView) {
    this.node = node;
    this.doc = view?.dom.ownerDocument ?? document;
    this.dom = this.doc.createElement('img');
    this.render(node);
  }

  private render(node: PMNode): void {
    const toDOM = node.type.spec.toDOM;
    const rendered = toDOM ? DOMSerializer.renderSpec(this.doc, toDOM(node)).dom : null;
    const fresh = rendered instanceof Element ? rendered : null;
    const next = new Map<string, string>();
    if (fresh) for (const attr of Array.from(fresh.attributes)) next.set(attr.name, attr.value);
    const natural = positive(node.attrs.width) && positive(node.attrs.height);
    if (natural) {
      next.set(NATURAL_ATTR, '');
      if (!heightOnly(node.attrs.style)) {
        const style = next.get('style');
        const variable = `${NATURAL_WIDTH_VAR}: ${node.attrs.width}px;`;
        next.set('style', style ? `${style.replace(/;?\s*$/, ';')} ${variable}` : variable);
      }
    }
    // src last, so a changed src never loads with stale attributes.
    // ProseMirror's own class (ProseMirror-selectednode) survives attribute changes.
    const selected = this.dom.classList.contains('ProseMirror-selectednode');
    const cls = [next.get('class') ?? '', selected ? 'ProseMirror-selectednode' : ''].filter(Boolean).join(' ');
    if (cls) next.set('class', cls);
    else next.delete('class');
    for (const [name, value] of next) if (name !== 'src' && this.dom.getAttribute(name) !== value) this.dom.setAttribute(name, value);
    for (const name of this.written) if (!next.has(name)) this.dom.removeAttribute(name);
    const src = next.get('src');
    if (src !== undefined && this.dom.getAttribute('src') !== src) this.dom.setAttribute('src', src);
    this.written = new Set(next.keys());
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) this.render(node);
    this.node = node;
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection';
  }
}

export const imageNaturalSizeKey = new PluginKey('hbImageNaturalSize');

/** Transaction meta on the natural-size transactions (autosave should save them; no history). */
export const NATURAL_SIZE_META = 'hbImageNaturalSize';

/** The image node at an img element of the view, or null. */
function imageAt(view: EditorView, img: HTMLImageElement): { pos: number; node: PMNode } | null {
  let pos: number;
  try {
    pos = view.posAtDOM(img, 0);
  } catch {
    return null;
  }
  for (const candidate of [pos, pos - 1]) {
    if (candidate < 0) continue;
    const node = view.state.doc.nodeAt(candidate);
    if (node?.type.name === 'image' && view.nodeDOM(candidate) === img) return { pos: candidate, node };
  }
  return null;
}

/**
 * The transaction that records the natural size of every loaded image in `imgs` whose stored size
 * differs, or null. Exported for tests.
 */
export function naturalSizeTransaction(view: EditorView, imgs: Iterable<HTMLImageElement>): Transaction | null {
  let tr: Transaction | null = null;
  for (const img of imgs) {
    if (!img.isConnected || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) continue;
    const found = imageAt(view, img);
    if (!found) continue;
    // The file that loaded must be the node's (not a stale src).
    if (typeof found.node.attrs.src !== 'string' || img.getAttribute('src') !== found.node.attrs.src) continue;
    const { width, height } = found.node.attrs as { width: unknown; height: unknown };
    if (width === img.naturalWidth && height === img.naturalHeight) continue;
    tr ??= view.state.tr;
    tr.setNodeAttribute(found.pos, 'width', img.naturalWidth).setNodeAttribute(found.pos, 'height', img.naturalHeight);
  }
  return tr?.setMeta('addToHistory', false).setMeta(NATURAL_SIZE_META, true) ?? null;
}

/** Records natural sizes of images as they load (editable views only). */
export function imageNaturalSizePlugin(): Plugin {
  return new Plugin({
    key: imageNaturalSizeKey,
    view(view) {
      const pending = new Set<HTMLImageElement>();
      let scheduled = false;
      let destroyed = false;
      const flush = () => {
        scheduled = false;
        if (destroyed || !view.editable || view.composing) {
          pending.clear();
          return;
        }
        const tr = naturalSizeTransaction(view, pending);
        pending.clear();
        if (tr) view.dispatch(tr);
      };
      const queue = (img: HTMLImageElement) => {
        if (img.classList.contains('ProseMirror-separator')) return;
        pending.add(img);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      };
      const onLoad = (e: Event) => {
        if (e.target instanceof HTMLImageElement) queue(e.target);
      };
      // Images already loaded before this view existed (cache, data: URLs).
      const scan = () => {
        for (const img of Array.from(view.dom.querySelectorAll<HTMLImageElement>('img'))) {
          if (img.complete && img.naturalWidth > 0) queue(img);
        }
      };
      view.dom.addEventListener('load', onLoad, true);
      queueMicrotask(scan);
      return {
        destroy() {
          destroyed = true;
          view.dom.removeEventListener('load', onLoad, true);
        },
      };
    },
  });
}

/**
 * The schema's image with ImageView and the natural-size plugin. Same name ('image'), so
 * buildEditorExtensions({ extensions: [ImageWithView] }) replaces it in place; EditorCanvas
 * includes it (editorNodeViews).
 */
export const ImageWithView = HbImage.extend({
  addNodeView() {
    return ({ node, view }) => new ImageView(node, view);
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), imageNaturalSizePlugin()];
  },
});
