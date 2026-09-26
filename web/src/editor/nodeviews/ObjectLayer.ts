// ObjectLayer (P5.3, plan §4.9): the editing surface for page objects, as a ProseMirror plugin
// view of the PageObjects extension (objects/extension.ts). PageView renders the objects
// themselves (chrome with data-object-id, contenteditable=false; stopEvent and ignoreMutation keep
// ProseMirror out of them). This layer adds, next to the pages inside .hb-canvas:
//
//   div.layer                       absolutely positioned at the canvas origin (canvas pixels)
//     div.frame[role=group]         over the selected object; focusable; drag to move
//       span.handle × 8             drag to resize
//     div.toolbar[role=toolbar]     send backward, bring forward, edit text | put back in text, delete
//     span[aria-live]               announces keyboard moves
//
// Pointer: click an object to select it (Alt+click, or a click where there is no text, for an
// object behind the text), drag it (or its frame) to move, drag a handle to resize
// (images keep their aspect ratio on corner handles, Shift toggles that), double-click a text
// object to edit it in place. Keyboard on the frame: arrows move by 1px (Shift: 10px),
// Alt/Ctrl+arrows resize, Enter/F2 edits text, Delete removes, Ctrl+] / Ctrl+[ change the
// z-order (with Shift: to front / back), Escape returns to the text.
//
// Every change is committed as one transaction when the gesture ends (one undo step); pointer
// deltas are divided by the canvas zoom. While dragging, only the object's own style attribute is
// changed in the DOM (PageView ignores chrome mutations). A move writes left/top (and
// right/bottom: auto only when the theme or the style anchored the object there); a resize writes
// left/top/width/height in px. Both keep at least PAGE_STRIP px of the object on its page
// (clampToPage): objects may bleed past the edges, but never leave the page. A gesture follows its
// object while the document changes under it (sync; resolve by the page's pid after a re-split).
import type { EditorState, PluginView } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { moveRovingFocus, syncRovingTabIndex } from '@/ui';
import { ICONS, type IconDef, type IconName } from '@/ui/iconPaths';
import { deleteObject, moveObjectInZOrder, putObjectInText, selectObject, updateObject } from '../objects/commands';
import { findObject, objectsOf, px, withStyle, type ZOrderMove } from '../objects/model';
import styles from '../objects/objectLayer.module.css';
import { findObjectByPid, OBJECT_SELECTION, pageNodeAt, selectedObject, type ObjectRef } from '../objects/state';
import type { PageObject } from '../schema';
import { OBJECT_ID_ATTR } from './PageView';

export type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: readonly HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface ObjectLayerOptions {
  /** The canvas zoom (transform scale); pointer deltas are divided by it. Default: measured. */
  zoom?: () => number;
}

/** Object geometry in page pixels (border box) plus the style it was measured with. */
export interface ObjectGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Anchored extends ObjectGeometry {
  /** the object's style with left/top in px and right/bottom released */
  base: string;
  /** padding + border, subtracted from width/height when box-sizing is content-box */
  boxWidth: number;
  boxHeight: number;
}

interface DragSession {
  mode: 'move' | HandleName;
  pointerId: number;
  startX: number;
  startY: number;
  zoom: number;
  /** follows the selection through transactions (sync) */
  ref: ObjectRef;
  /** the pid of the object's page, to find it again after pagination re-split the page */
  pid: unknown;
  kind: PageObject['kind'];
  /** the element's style attribute before the gesture (restored when nothing changed) */
  original: string | null;
  anchored: Anchored | null;
  /** the page's padding box (page px), measured when the drag starts moving */
  page: PageSize;
  /** style shown during the drag */
  current: string | null;
  /** whether clampToPage held the object back */
  clamped: boolean;
}

interface EditSession {
  /** follows the selection through transactions (sync) */
  ref: ObjectRef;
  /** the pid of the object's page, to find it again after pagination re-split the page */
  pid: unknown;
  el: HTMLElement;
  /** the page element, non-editable while its object is edited */
  pageEl: HTMLElement | null;
  original: string;
  done: boolean;
}

const MIN_SIZE = 8;
/** Pixels of an object that stay inside its page when it is moved or resized (clampToPage). */
export const PAGE_STRIP = 16;

export interface PageSize {
  width: number;
  height: number;
}
/** Screen pixels a pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 3;

function svgIcon(doc: Document, name: IconName): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  const def: IconDef = ICONS[name];
  svg.setAttribute('stroke-width', String(def.strokeWidth ?? 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', def.d);
  svg.append(path);
  return svg;
}

const sameRect = (a: DOMRect, b: DOMRect, eps: number) =>
  Math.abs(a.left - b.left) <= eps && Math.abs(a.top - b.top) <= eps && Math.abs(a.width - b.width) <= eps && Math.abs(a.height - b.height) <= eps;

/**
 * Measures an object element and re-anchors its style at left/top (page px). When the object was
 * anchored by right/bottom (inline or from its classes), those are released so moving and
 * resizing work from the top-left corner; the element keeps its place. Mutates the element's
 * style attribute to the returned `base`.
 */
export function anchorElement(el: HTMLElement, style: string, zoom: number): Anchored {
  const cs = getComputedStyle(el);
  const marginLeft = parseFloat(cs.marginLeft) || 0;
  const marginTop = parseFloat(cs.marginTop) || 0;
  const left = el.offsetLeft - marginLeft;
  const top = el.offsetTop - marginTop;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const contentBox = cs.boxSizing !== 'border-box';
  const boxWidth = contentBox
    ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
    : 0;
  const boxHeight = contentBox
    ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    : 0;
  const before = el.getBoundingClientRect();
  let base = withStyle(style, { left: px(left), top: px(top), right: null, bottom: null, inset: null });
  el.setAttribute('style', base);
  if (!sameRect(before, el.getBoundingClientRect(), Math.max(1, zoom))) {
    // A class (or the style) still anchors it at right/bottom: release them.
    base = withStyle(base, { right: 'auto', bottom: 'auto' });
    el.setAttribute('style', base);
  }
  return { base, left: Math.round(left), top: Math.round(top), width, height, boxWidth, boxHeight };
}

/** The geometry a resize drag gives (page px, border box). */
export function resizeGeometry(start: ObjectGeometry, handle: HandleName, dx: number, dy: number, keepRatio: boolean): ObjectGeometry {
  let { left, top, width, height } = start;
  if (handle.includes('e')) width = start.width + dx;
  if (handle.includes('w')) width = start.width - dx;
  if (handle.includes('s')) height = start.height + dy;
  if (handle.includes('n')) height = start.height - dy;
  const corner = handle.length === 2;
  if (keepRatio && corner && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    if (Math.abs(width / start.width - 1) >= Math.abs(height / start.height - 1)) height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(MIN_SIZE, width);
  height = Math.max(MIN_SIZE, height);
  if (handle.includes('w')) left = start.left + (start.width - width);
  if (handle.includes('n')) top = start.top + (start.height - height);
  return { left, top, width, height };
}

/**
 * `g` (page px) shifted so that at least min(strip, its size) of it stays inside the page's
 * padding box (`page`: clientWidth/clientHeight, page px); unchanged when the page is unmeasured.
 * Objects may still bleed past the edges (cover art does); they only can't leave the page, where the
 * theme's overflow clip would hide them out of reach of the pointer (review finding UI-9).
 */
export function clampToPage(g: ObjectGeometry, page: PageSize, strip = PAGE_STRIP): ObjectGeometry & { clamped: boolean } {
  if (!(page.width > 0 && page.height > 0)) return { ...g, clamped: false };
  const sx = Math.min(strip, g.width);
  const sy = Math.min(strip, g.height);
  const left = Math.min(Math.max(g.left, sx - g.width), page.width - sx);
  const top = Math.min(Math.max(g.top, sy - g.height), page.height - sy);
  return { left, top, width: g.width, height: g.height, clamped: left !== g.left || top !== g.top };
}

/** The padding box of the page an object element sits on (page px, zoom-free). */
function pageSizeOf(el: HTMLElement): PageSize {
  const page = el.parentElement;
  return { width: page?.clientWidth ?? 0, height: page?.clientHeight ?? 0 };
}

export class ObjectLayer implements PluginView {
  readonly root: HTMLElement;
  private readonly view: EditorView;
  private readonly options: ObjectLayerOptions;
  private readonly frame: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly live: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly buttons: Record<'backward' | 'forward' | 'edit' | 'unplace' | 'delete', HTMLButtonElement>;
  private ref: ObjectRef | null = null;
  private target: HTMLElement | null = null;
  private session: DragSession | null = null;
  private editing: EditSession | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  constructor(view: EditorView, options: ObjectLayerOptions = {}) {
    this.view = view;
    this.options = options;
    const doc = view.dom.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = styles.layer!;
    this.root.setAttribute('data-hb-object-layer', '');
    this.root.setAttribute('contenteditable', 'false');

    this.hint = doc.createElement('span');
    this.hint.id = `hb-object-hint-${Math.random().toString(36).slice(2, 8)}`;
    this.hint.className = styles.visuallyHidden!;
    this.hint.textContent =
      'Arrow keys move the object, with Shift by 10 pixels. Alt or Control with arrow keys resizes it. Enter edits a text object. Delete removes it. Escape returns to the text. Alt+click selects an object behind the text.';

    this.frame = doc.createElement('div');
    this.frame.className = styles.frame!;
    this.frame.tabIndex = 0;
    this.frame.setAttribute('role', 'group');
    this.frame.setAttribute('aria-roledescription', 'page object');
    this.frame.setAttribute('aria-describedby', this.hint.id);
    this.frame.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Delete Enter Escape Control+BracketRight Control+BracketLeft');
    this.frame.setAttribute('data-testid', 'object-frame');
    for (const name of HANDLES) {
      const handle = doc.createElement('span');
      handle.className = styles.handle!;
      handle.setAttribute('data-handle', name);
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (e) => this.onHandlePointerDown(e, name));
      this.frame.append(handle);
    }
    this.frame.addEventListener('pointerdown', this.onFramePointerDown);
    this.frame.addEventListener('dblclick', this.onFrameDoubleClick);
    this.frame.addEventListener('keydown', this.onFrameKeyDown);
    this.frame.addEventListener('pointermove', this.onPointerMove);
    this.frame.addEventListener('pointerup', this.onPointerUp);
    this.frame.addEventListener('pointercancel', this.onPointerCancel);
    this.frame.addEventListener('lostpointercapture', this.onPointerCancel);

    this.toolbar = doc.createElement('div');
    this.toolbar.className = styles.toolbar!;
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'Page object');
    this.toolbar.setAttribute('data-testid', 'object-toolbar');
    const button = (key: keyof ObjectLayer['buttons'], label: string, icon: IconName, onClick: () => void, shortcut?: string) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = styles.button!;
      b.setAttribute('aria-label', label);
      b.title = shortcut ? `${label} (${shortcut})` : label;
      b.setAttribute('data-action', key);
      b.append(svgIcon(doc, icon));
      b.addEventListener('click', onClick);
      this.toolbar.append(b);
      return b;
    };
    this.buttons = {
      backward: button('backward', 'Send backward', 'chevronDown', () => this.reorder('backward', true), 'Ctrl+['),
      forward: button('forward', 'Bring forward', 'chevronUp', () => this.reorder('forward', true), 'Ctrl+]'),
      edit: button('edit', 'Edit text', 'paragraph', () => this.startEditing(), 'Enter'),
      unplace: button('unplace', 'Put back in text', 'image', () => this.putBackInText()),
      delete: button('delete', 'Delete object', 'trash', () => this.deleteSelected(), 'Delete'),
    };
    this.toolbar.addEventListener('keydown', this.onToolbarKeyDown);

    this.live = doc.createElement('span');
    this.live.className = styles.visuallyHidden!;
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('data-testid', 'object-status');

    this.root.append(this.hint, this.frame, this.toolbar, this.live);
    this.hide();

    view.dom.addEventListener('pointerdown', this.onViewPointerDown);
    view.dom.addEventListener('focusin', this.onViewFocusIn);
    const win = doc.defaultView;
    win?.addEventListener('resize', this.onWindowResize);
    if (typeof ResizeObserver !== 'undefined') this.resizeObserver = new ResizeObserver(() => this.place());
    if (typeof MutationObserver !== 'undefined') this.mutationObserver = new MutationObserver(() => this.place());
    this.attach();
    this.sync(view.state);
  }

  // -------------------------------------------------------------------------------------------
  // Plugin view
  // -------------------------------------------------------------------------------------------

  update(view: EditorView): void {
    this.attach();
    this.sync(view.state);
  }

  destroy(): void {
    this.finishEditing(true);
    this.view.dom.removeEventListener('pointerdown', this.onViewPointerDown);
    this.view.dom.removeEventListener('focusin', this.onViewFocusIn);
    this.view.dom.ownerDocument.defaultView?.removeEventListener('resize', this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.root.remove();
  }

  /** The layer sits next to the ProseMirror root, inside .hb-canvas (which may change). */
  private attach(): void {
    const parent = this.view.dom.parentElement;
    if (!parent || this.root.parentElement === parent) return;
    parent.append(this.root);
    this.mutationObserver?.disconnect();
    this.mutationObserver?.observe(parent, { attributes: true, attributeFilter: ['style', 'data-zoom'] });
  }

  private sync(state: EditorState): void {
    const ref = this.view.editable ? selectedObject(state) : null;
    // A gesture's object moves with the document (a late image or font load repaginating an
    // earlier page, a queued snippet): commit to where it is now, not where it started.
    if (ref && this.session?.ref.id === ref.id) this.session.ref = ref;
    if (ref && this.editing?.ref.id === ref.id) this.editing.ref = ref;
    const edit = this.editing;
    if (edit && (!ref || ref.id !== edit.ref.id || !edit.el.isConnected)) {
      // Not from inside a view update: finishing may dispatch.
      queueMicrotask(() => {
        if (this.editing === edit) this.finishEditing(true);
      });
    }
    const changed = ref?.id !== this.ref?.id || ref?.pagePos !== this.ref?.pagePos;
    this.ref = ref;
    const target = ref ? this.findElement(ref) : null;
    if (target !== this.target) {
      if (this.target) this.resizeObserver?.unobserve(this.target);
      this.target = target;
      if (target) this.resizeObserver?.observe(target);
      // A re-render (PageView rebuilt the chrome) during a drag: show the drag's style again.
      if (target && this.session?.current) target.setAttribute('style', this.session.current);
    }
    if (changed || target) this.describe();
    this.place();
  }

  // -------------------------------------------------------------------------------------------
  // Lookup and geometry
  // -------------------------------------------------------------------------------------------

  /** The page element and index of a page-object element inside the editor, or null. */
  private refFromElement(el: Element): ObjectRef | null {
    const pageEl = el.parentElement;
    if (!pageEl || pageEl.parentElement !== this.view.dom) return null;
    const id = el.getAttribute(OBJECT_ID_ATTR);
    if (!id) return null;
    const index = Array.from(this.view.dom.children).indexOf(pageEl);
    if (index < 0 || index >= this.view.state.doc.childCount) return null;
    let pagePos = 0;
    for (let i = 0; i < index; i++) pagePos += this.view.state.doc.child(i).nodeSize;
    return { pagePos, id };
  }

  private findElement(ref: ObjectRef): HTMLElement | null {
    const pageEl = this.view.nodeDOM(ref.pagePos);
    if (!(pageEl instanceof HTMLElement)) return null;
    for (const child of Array.from(pageEl.children)) {
      if (child.getAttribute(OBJECT_ID_ATTR) === ref.id && child instanceof HTMLElement) return child;
    }
    return null;
  }

  private object(ref: ObjectRef | null = this.ref): PageObject | undefined {
    if (!ref) return undefined;
    const page = pageNodeAt(this.view.state.doc, ref.pagePos);
    return page ? findObject(objectsOf(page.attrs), ref.id) : undefined;
  }

  /** The pid of the page at `ref` (see resolve). */
  private pidOf(ref: ObjectRef): unknown {
    return pageNodeAt(this.view.state.doc, ref.pagePos)?.attrs.pid;
  }

  /**
   * Where a gesture's object is now: `ref` while it holds the object, else the object on the page
   * with `pid` (the selection was dropped, e.g. pagination re-split the page), else null (gone).
   */
  private resolve(ref: ObjectRef, pid: unknown): ObjectRef | null {
    return this.object(ref) ? ref : findObjectByPid(this.view.state.doc, pid, ref.id);
  }

  /** Transform scale of the canvas (client px per canvas px). */
  private zoom(): number {
    const fromOption = this.options.zoom?.();
    if (fromOption && Number.isFinite(fromOption) && fromOption > 0) return fromOption;
    const parent = this.root.parentElement;
    if (parent && parent.offsetWidth > 0) {
      const scale = parent.getBoundingClientRect().width / parent.offsetWidth;
      if (scale > 0 && Number.isFinite(scale)) return scale;
    }
    return 1;
  }

  private hide(): void {
    this.frame.hidden = true;
    this.toolbar.hidden = true;
  }

  private onWindowResize = () => this.place();

  /** Positions the frame over the selected object (canvas px) and the toolbar next to it. */
  private place(): void {
    const target = this.target;
    if (!this.ref || !target || !target.isConnected || !this.root.isConnected) {
      this.hide();
      return;
    }
    const zoom = this.zoom();
    const origin = this.root.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const left = (r.left - origin.left) / zoom;
    const top = (r.top - origin.top) / zoom;
    const width = r.width / zoom;
    const height = r.height / zoom;
    this.root.style.setProperty('--hb-object-inverse-zoom', String(1 / zoom));
    Object.assign(this.frame.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    this.frame.hidden = false;
    const editing = this.editing !== null;
    this.toolbar.hidden = editing || this.session?.anchored != null;
    // Above the object, or below it when there's no room above (the top of the canvas).
    const side = top * zoom < 48 ? 'bottom' : 'top';
    this.toolbar.setAttribute('data-side', side);
    Object.assign(this.toolbar.style, { left: `${left}px`, top: `${side === 'top' ? top : top + height}px` });
  }

  /** Accessible name and toolbar state for the selected object. */
  private describe(): void {
    const object = this.object();
    if (!object) return;
    const objects = objectsOf(pageNodeAt(this.view.state.doc, this.ref!.pagePos)?.attrs ?? {});
    const index = objects.findIndex((o) => o.id === object.id);
    const what = object.kind === 'image' ? 'Image object' : `Text object “${(object.text ?? '').slice(0, 40)}”`;
    const classes = object.classes.length ? `, ${object.classes.join(' ')}` : '';
    this.frame.setAttribute('aria-label', `${what}${classes} (${index + 1} of ${objects.length})`);
    this.frame.setAttribute('data-object-kind', object.kind);
    this.buttons.edit.hidden = object.kind !== 'text';
    this.buttons.unplace.hidden = object.kind !== 'image';
    this.buttons.backward.disabled = index <= 0;
    this.buttons.forward.disabled = index >= objects.length - 1;
    syncRovingTabIndex(this.toolbar);
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  // -------------------------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------------------------

  private select(ref: ObjectRef | null): void {
    selectObject(ref)(this.view.state, this.view.dispatch);
  }

  /** Focuses the selection frame (after selecting from a menu or the toolbar). */
  focusFrame(): void {
    if (!this.frame.hidden) this.frame.focus({ preventScroll: true });
  }

  /**
   * The object a pointer press is meant for: the object element under it, or, when the press
   * lands on no text (the page's margins, the empty part of the column wrapper) or Alt is held,
   * the topmost object whose box contains the point. Images sit behind the text in most themes
   * (5ePHB: `.page img { z-index: -1 }`), so the text layer is usually what the pointer hits.
   */
  private objectAt(e: PointerEvent): { el: Element; ref: ObjectRef } | null {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return null;
    const direct = target.closest(`[${OBJECT_ID_ATTR}]`);
    const directRef = direct ? this.refFromElement(direct) : null;
    if (direct && directRef) return { el: direct, ref: directRef };
    const pageEl = target.closest('.page');
    if (!pageEl || pageEl.parentElement !== this.view.dom) return null;
    const empty = target === pageEl || (target.parentElement === pageEl && target.matches('div.columnWrapper'));
    if (!empty && !e.altKey) return null;
    const candidates = Array.from(pageEl.children).filter((c) => c.hasAttribute(OBJECT_ID_ATTR));
    const win = pageEl.ownerDocument.defaultView;
    const z = (el: Element) => {
      const value = parseInt(win?.getComputedStyle(el).zIndex ?? '', 10);
      return Number.isFinite(value) ? value : 0;
    };
    let best: { el: Element; z: number; index: number } | null = null;
    candidates.forEach((el, index) => {
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const zi = z(el);
      if (!best || zi > best.z || (zi === best.z && index > best.index)) best = { el, z: zi, index };
    });
    const found = best as { el: Element } | null;
    const ref = found ? this.refFromElement(found.el) : null;
    return found && ref ? { el: found.el, ref } : null;
  }

  private onViewPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.view.editable) return;
    const hit = this.objectAt(e);
    if (!hit) {
      if (this.ref && !this.editing) this.select(null);
      return;
    }
    if (this.editing?.el === hit.el) return; // placing the caret in the text being edited
    e.preventDefault(); // no text selection, no native drag, no caret in the page
    this.select(hit.ref);
    this.focusFrame();
    this.beginDrag(e, 'move');
  };

  /** Focus arriving in the text (not in an object being edited) ends the object selection. */
  private onViewFocusIn = (e: FocusEvent) => {
    if (e.target === this.view.dom && this.ref && !this.editing) this.select(null);
  };

  // -------------------------------------------------------------------------------------------
  // Dragging and resizing
  // -------------------------------------------------------------------------------------------

  private onFramePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.editing || e.target !== this.frame) return;
    e.preventDefault();
    this.focusFrame();
    this.beginDrag(e, 'move');
  };

  private onHandlePointerDown(e: PointerEvent, handle: HandleName): void {
    if (e.button !== 0 || this.editing) return;
    e.preventDefault();
    e.stopPropagation();
    this.focusFrame();
    this.beginDrag(e, handle);
  }

  private beginDrag(e: PointerEvent, mode: DragSession['mode']): void {
    const ref = this.ref;
    const object = this.object();
    if (!ref || !object || !this.target) return;
    this.session = {
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      zoom: this.zoom(),
      ref,
      pid: this.pidOf(ref),
      kind: object.kind,
      original: this.target.getAttribute('style'),
      anchored: null,
      page: { width: 0, height: 0 },
      current: null,
      clamped: false,
    };
    try {
      this.frame.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
  }

  /** The style a drag with deltas (dx, dy) in page px gives, from the anchored start. */
  private dragStyle(session: DragSession, dx: number, dy: number, shiftKey: boolean): string {
    const a = session.anchored!;
    if (session.mode === 'move') {
      const g = clampToPage({ left: a.left + dx, top: a.top + dy, width: a.width, height: a.height }, session.page);
      session.clamped = g.clamped;
      return withStyle(a.base, { left: px(g.left), top: px(g.top) });
    }
    const keepRatio = session.kind === 'image' ? !shiftKey : shiftKey;
    const g = clampToPage(resizeGeometry(a, session.mode, dx, dy, keepRatio), session.page);
    session.clamped = g.clamped;
    return withStyle(a.base, {
      left: px(g.left),
      top: px(g.top),
      width: px(g.width - a.boxWidth),
      height: px(g.height - a.boxHeight),
    });
  }

  private onPointerMove = (e: PointerEvent) => {
    const session = this.session;
    if (!session || e.pointerId !== session.pointerId) return;
    const target = this.target;
    const object = this.object(session.ref);
    if (!target || !object) return;
    const screenDx = e.clientX - session.startX;
    const screenDy = e.clientY - session.startY;
    if (!session.anchored) {
      if (Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD) return;
      session.anchored = anchorElement(target, object.style, session.zoom);
      session.page = pageSizeOf(target);
      this.frame.setAttribute('data-dragging', '');
    }
    const style = this.dragStyle(session, screenDx / session.zoom, screenDy / session.zoom, e.shiftKey);
    session.current = style;
    target.setAttribute('style', style);
    this.place();
  };

  private onPointerUp = (e: PointerEvent) => {
    const session = this.session;
    if (!session || e.pointerId !== session.pointerId) return;
    this.endDrag(true);
  };

  private onPointerCancel = (e: PointerEvent) => {
    const session = this.session;
    if (!session || e.pointerId !== session.pointerId) return;
    this.endDrag(e.type === 'lostpointercapture' && session.current !== null);
  };

  private endDrag(commit: boolean): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.frame.removeAttribute('data-dragging');
    try {
      if (this.frame.hasPointerCapture(session.pointerId)) this.frame.releasePointerCapture(session.pointerId);
    } catch {
      /* ignore */
    }
    const ref = this.resolve(session.ref, session.pid);
    const object = ref ? this.object(ref) : undefined;
    if (commit && ref && session.current && object && session.current !== object.style) {
      updateObject(ref, { style: session.current })(this.view.state, this.view.dispatch);
      this.announce(`${session.mode === 'move' ? 'Object moved' : 'Object resized'}${session.clamped ? '. Kept on the page' : ''}`);
    } else if (this.target && session.anchored) {
      // Nothing to commit: back to the stored style.
      if (session.original === null) this.target.removeAttribute('style');
      else this.target.setAttribute('style', session.original);
    }
    this.place();
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------------------------

  private onFrameKeyDown = (e: KeyboardEvent) => {
    if (e.target !== this.frame || this.editing || !this.ref) return;
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      if (this.session) return;
      if (e.altKey || e.ctrlKey || e.metaKey) this.nudge('resize', arrow[0] * step, arrow[1] * step);
      else this.nudge('move', arrow[0] * step, arrow[1] * step);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      const forward = e.code === 'BracketRight';
      this.reorder(e.shiftKey ? (forward ? 'front' : 'back') : forward ? 'forward' : 'backward', false);
      return;
    }
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelected();
        return;
      case 'Enter':
      case 'F2':
        if (this.object()?.kind === 'text') {
          e.preventDefault();
          this.startEditing();
        }
        return;
      case 'Escape':
        e.preventDefault();
        if (this.session) {
          this.endDrag(false);
          return;
        }
        this.select(null);
        this.view.focus();
        return;
      default:
    }
  };

  /** One keyboard step: move by (dx, dy), or grow/shrink by (dx, dy), committed at once. */
  private nudge(kind: 'move' | 'resize', dx: number, dy: number): void {
    const ref = this.ref;
    const object = this.object();
    const target = this.target;
    if (!ref || !object || !target) return;
    const a = anchorElement(target, object.style, this.zoom());
    const wanted =
      kind === 'move'
        ? { left: a.left + dx, top: a.top + dy, width: a.width, height: a.height }
        : { left: a.left, top: a.top, width: Math.max(MIN_SIZE, a.width + dx), height: Math.max(MIN_SIZE, a.height + dy) };
    const g = clampToPage(wanted, pageSizeOf(target));
    const style =
      kind === 'move'
        ? withStyle(a.base, { left: px(g.left), top: px(g.top) })
        : withStyle(a.base, {
            ...(g.clamped ? { left: px(g.left), top: px(g.top) } : {}),
            width: px(g.width - a.boxWidth),
            height: px(g.height - a.boxHeight),
          });
    if (!updateObject(ref, { style })(this.view.state, this.view.dispatch)) target.setAttribute('style', object.style);
    const now = this.object();
    if (now) {
      const where = kind === 'move' ? `left ${g.left}, top ${g.top}` : `${g.width} by ${g.height}`;
      this.announce(`${kind === 'move' ? `Moved to ${where}` : `Resized to ${where}`}${g.clamped ? '. Kept on the page' : ''}`);
    }
  }

  private onToolbarKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof Element && moveRovingFocus(this.toolbar, e.key, e.target, 'horizontal')) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.focusFrame();
    }
  };

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------

  private reorder(move: ZOrderMove, fromToolbar: boolean): void {
    if (!this.ref) return;
    if (moveObjectInZOrder(this.ref, move)(this.view.state, this.view.dispatch)) {
      this.announce(move === 'forward' || move === 'front' ? 'Brought forward' : 'Sent backward');
    }
    if (!fromToolbar) this.focusFrame();
    else if (this.buttons.forward.disabled || this.buttons.backward.disabled) this.focusFrame();
  }

  deleteSelected(): void {
    if (!this.ref) return;
    if (deleteObject(this.ref)(this.view.state, this.view.dispatch)) this.announce('Object deleted');
    this.view.focus();
  }

  /** 'Put back in text' for the selected image object, near where it is on the page. */
  putBackInText(): void {
    const ref = this.ref;
    const target = this.target;
    if (!ref) return;
    let hint: number | null = null;
    if (target) {
      const r = target.getBoundingClientRect();
      // The object and the frame lie over the text: let the hit test see through them.
      const restore = [target, this.frame, this.toolbar].map((el) => [el, el.style.pointerEvents] as const);
      for (const [el] of restore) el.style.pointerEvents = 'none';
      try {
        hint = this.view.posAtCoords({ left: r.left + 2, top: r.top + 2 })?.pos ?? null;
      } finally {
        for (const [el, value] of restore) el.style.pointerEvents = value;
      }
    }
    putObjectInText(ref, hint)(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  // -------------------------------------------------------------------------------------------
  // Editing a text object in place
  // -------------------------------------------------------------------------------------------

  private onFrameDoubleClick = (e: MouseEvent) => {
    if (this.object()?.kind !== 'text') return;
    e.preventDefault();
    this.startEditing();
  };

  startEditing(): void {
    const ref = this.ref;
    const el = this.target;
    const object = this.object();
    if (!ref || !el || object?.kind !== 'text' || this.editing) return;
    // ProseMirror's root is the editing host of everything inside it, pages included, so an
    // editable object would only be part of it (focus and typing would go to ProseMirror). The
    // page is made non-editable for the edit: the object becomes an editing host of its own.
    // PageView ignores the page's attribute changes; its stopEvent keeps ProseMirror out of the
    // object's key and input events.
    const pageEl = el.parentElement;
    pageEl?.setAttribute('contenteditable', 'false');
    this.editing = { ref, pid: this.pidOf(ref), el, pageEl, original: el.textContent ?? '', done: false };
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      el.contentEditable = 'true';
    }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.setAttribute('data-hb-object-editing', '');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', 'Text object');
    el.addEventListener('keydown', this.onEditKeyDown);
    el.addEventListener('blur', this.onEditBlur);
    this.frame.setAttribute('data-editing', '');
    this.place();
    el.focus({ preventScroll: true });
    const selection = el.ownerDocument.getSelection();
    if (selection) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.announce('Editing text. Enter to finish, Escape to cancel.');
  }

  private onEditKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.finishEditing(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.finishEditing(false, true);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      // Select all = the object's text (P8.2). Natively it selected ProseMirror's whole root,
      // which took the focus and ended the edit.
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const selection = el.ownerDocument.getSelection();
      if (selection) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };

  private onEditBlur = () => {
    this.finishEditing(true);
  };

  /** Ends in-place editing: `save` commits the text (one step), otherwise it is restored. */
  private finishEditing(save: boolean, refocus = false): void {
    const edit = this.editing;
    if (!edit || edit.done) return;
    edit.done = true;
    this.editing = null;
    const { el, original, pageEl } = edit;
    pageEl?.removeAttribute('contenteditable');
    el.removeEventListener('keydown', this.onEditKeyDown);
    el.removeEventListener('blur', this.onEditBlur);
    const text = (el.textContent ?? '').replace(/\r?\n/g, ' ');
    el.contentEditable = 'false';
    el.removeAttribute('data-hb-object-editing');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    el.ownerDocument.getSelection()?.removeAllRanges();
    this.frame.removeAttribute('data-editing');
    const ref = this.resolve(edit.ref, edit.pid);
    if (save && text !== original && ref) {
      updateObject(ref, { text })(this.view.state, this.view.dispatch);
      this.announce('Text saved');
    } else {
      el.textContent = original;
    }
    this.place();
    if (refocus) this.focusFrame();
  }

  /** For tests: whether a text object is being edited. */
  get isEditing(): boolean {
    return this.editing !== null;
  }
}

/** Meta name re-exported for code that selects objects without the commands module. */
export { OBJECT_SELECTION };
