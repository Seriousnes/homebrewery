// What the inspector shows (P3.5): the element chain around the selection (breadcrumbs), the
// inspected target, and the current page with its section. Pure functions over EditorState, plus
// InspectorStore, a useSyncExternalStore source that follows an editor.
//
// Targets are resolved from the current state whenever they are needed (positions move under
// pagination), never kept from a render. A breadcrumb the author picked ("pin") is a position
// mapped through every transaction; it is dropped when the selection leaves that element.
import type { Editor } from '@tiptap/core';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { genericValues, markRangeAt, sectionRange, sectionSettings, type EditTarget, type GenericValues, type SectionSettings } from '@/editor/commands/attrs';
import { fragmentChain } from '@/editor/pagination/fragments';
import { HB_ATTR_TYPES } from '@/editor/schema/attrs';
import { normalizePageObjects, type PageAttrs, type PageKind } from '@/editor/schema/nodes/page';

const INSPECTABLE = new Set<string>(HB_ATTR_TYPES);

const TYPE_LABELS: Record<string, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulletList: 'Bullet list',
  orderedList: 'Numbered list',
  listItem: 'List item',
  blockquote: 'Quote',
  codeBlock: 'Code block',
  horizontalRule: 'Horizontal rule',
  image: 'Image',
  table: 'Table',
  tableRow: 'Table row',
  tableHeader: 'Header cell',
  tableCell: 'Table cell',
  definitionList: 'Definition list',
  themeBlock: 'Theme block',
  inlineBox: 'Inline box',
  page: 'Page',
  span: 'Span',
};

/** A human name for a node or mark type ("Heading 2", "Theme block"). */
export function typeLabel(type: string, attrs?: Record<string, unknown>): string {
  if (type === 'heading' && typeof attrs?.level === 'number') return `Heading ${attrs.level}`;
  return TYPE_LABELS[type] ?? type;
}

/** One element of the chain, as rendered (no positions: they change under pagination). */
export interface ChainItem {
  /** Stable per level: 'n<depth>:<type>' for nodes, 'm<index>' for span marks. */
  key: string;
  kind: 'node' | 'mark';
  type: string;
  label: string;
  values: GenericValues;
  /** Heading: the id is the author's own (customId), not the generated slug. */
  customId: boolean;
  /** A block split across pages by pagination. */
  continued: boolean;
}

/** A chain item with the edit target it resolves to in a given state. */
export interface ResolvedItem extends ChainItem {
  target: EditTarget;
}

/** Span marks that cover the whole selection inside one textblock (outermost first). */
function spanMarks(state: EditorState): Mark[] {
  const { selection, doc } = state;
  const { $from, $to } = selection;
  if (selection instanceof NodeSelection || !$from.parent.inlineContent || $from.parent !== $to.parent) return [];
  const spanType = doc.type.schema.marks.span;
  if (!spanType) return [];
  if (selection.empty) return $from.marks().filter((m) => m.type === spanType);
  let common: Mark[] | null = null;
  doc.nodesBetween($from.pos, $to.pos, (node) => {
    if (!node.isInline) return true;
    const marks: readonly Mark[] = node.marks.filter((m) => m.type === spanType);
    common = common === null ? [...marks] : common.filter((m) => m.isInSet(marks));
    return false;
  });
  return common ?? [];
}

/** The element chain around the selection: inspectable ancestors (page excluded), then spans. */
export function resolveChain(state: EditorState): ResolvedItem[] {
  const { selection, doc } = state;
  const { $from, $to } = selection;
  const items: ResolvedItem[] = [];
  const push = (key: string, kind: 'node' | 'mark', type: string, attrs: Record<string, unknown>, target: EditTarget, continued: boolean) => {
    const values = genericValues(state, target);
    if (!values) return;
    items.push({
      key,
      kind,
      type,
      label: typeLabel(type, attrs),
      values,
      customId: type === 'heading' && attrs.customId === true,
      continued,
      target,
    });
  };
  const nodeItem = (node: PMNode, pos: number, depth: number) => {
    if (!INSPECTABLE.has(node.type.name) || node.type.name === 'page') return;
    push(`n${depth}:${node.type.name}`, 'node', node.type.name, node.attrs, { kind: 'node', pos }, fragmentChain(doc, pos).length > 1);
  };

  const selected = selection instanceof NodeSelection ? selection.node : null;
  const depth = selected ? $from.depth : $from.sharedDepth($to.pos);
  for (let d = 1; d <= depth; d++) nodeItem($from.node(d), $from.before(d), d);
  if (selected) nodeItem(selected, $from.pos, depth + 1);

  spanMarks(state).forEach((mark, i) => {
    const range = markRangeAt(doc, $from.pos, mark);
    if (range) push(`m${i}`, 'mark', 'span', mark.attrs, { kind: 'mark', ...range }, false);
  });
  return items;
}

// ─── Pins (a breadcrumb the author picked) ──────────────────────────────────────────────────────

export type Pin = { kind: 'node'; pos: number; type: string } | { kind: 'mark'; from: number; to: number };

export function pinOf(item: ResolvedItem): Pin {
  return item.target.kind === 'node'
    ? { kind: 'node', pos: item.target.pos, type: item.type }
    : { kind: 'mark', from: item.target.from, to: item.target.to };
}

/** The pin after `tr`, or null when its element was deleted. */
export function mapPin(pin: Pin, tr: Transaction): Pin | null {
  if (!tr.docChanged) return pin;
  if (pin.kind === 'node') {
    const result = tr.mapping.mapResult(pin.pos, 1);
    return result.deleted ? null : { ...pin, pos: result.pos };
  }
  const from = tr.mapping.map(pin.from, 1);
  const to = tr.mapping.map(pin.to, -1);
  return from < to ? { kind: 'mark', from, to } : null;
}

function matchesPin(item: ResolvedItem, pin: Pin): boolean {
  if (pin.kind === 'node') return item.target.kind === 'node' && item.target.pos === pin.pos && item.type === pin.type;
  return item.target.kind === 'mark' && item.target.from === pin.from && item.target.to === pin.to;
}

/** Index of the inspected item: the pinned one while it is in the chain, else the innermost. */
export function targetIndex(chain: readonly ResolvedItem[], pin: Pin | null): number {
  if (pin) {
    const index = chain.findIndex((item) => matchesPin(item, pin));
    if (index >= 0) return index;
  }
  return chain.length - 1;
}

// ─── Page ───────────────────────────────────────────────────────────────────────────────────────

export interface ObjectInfo {
  id: string;
  kind: 'image' | 'text';
  classes: string[];
  style: string;
  /** Short description for the list: the text, or the image's file name. */
  label: string;
}

export interface PageInfo {
  /** 0-based index of the page holding the selection. */
  index: number;
  count: number;
  /** Stable page id (PageIds); null until assigned. */
  pid: string | null;
  kind: PageKind;
  section: { start: number; end: number; settings: SectionSettings };
  markers: string[];
  attributes: Record<string, string>;
  objects: ObjectInfo[];
}

function objectLabel(o: { kind: 'image' | 'text'; src?: string; text?: string }): string {
  if (o.kind === 'text') {
    const text = (o.text ?? '').replace(/\s+/g, ' ').trim();
    return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : 'Text';
  }
  const src = o.src ?? '';
  if (src.startsWith('data:')) return 'Embedded image';
  const name = src.split(/[?#]/)[0]!.split('/').filter(Boolean).at(-1) ?? '';
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  return decoded || 'Image';
}

/** The page that holds the selection's start, with its section and objects. */
export function resolvePage(state: EditorState): PageInfo | null {
  const { doc, selection } = state;
  if (doc.childCount === 0) return null;
  const index = Math.min(selection.$from.index(0), doc.childCount - 1);
  const page = doc.child(index);
  const attrs = page.attrs as PageAttrs;
  const { start, end } = sectionRange(doc, index);
  return {
    index,
    count: doc.childCount,
    pid: typeof attrs.pid === 'string' ? attrs.pid : null,
    kind: attrs.kind === 'auto' ? 'auto' : 'manual',
    section: { start, end, settings: sectionSettings(doc, index) },
    markers: Array.isArray(attrs.markers) ? [...attrs.markers] : [],
    attributes: attrs.attributes && typeof attrs.attributes === 'object' ? { ...attrs.attributes } : {},
    objects: normalizePageObjects(attrs.objects).map((o) => ({
      id: o.id,
      kind: o.kind,
      classes: o.classes,
      style: o.style,
      label: objectLabel(o),
    })),
  };
}

// ─── Snapshot and store ─────────────────────────────────────────────────────────────────────────

export interface InspectorSnapshot {
  chain: ChainItem[];
  /** Key of the inspected item, or null when nothing inspectable is selected. */
  targetKey: string | null;
  /**
   * Changes when the inspected element changes (another element selected), not when it only
   * moves: fields keyed by it keep their drafts while pagination shifts positions.
   */
  targetId: number;
  page: PageInfo | null;
}

const EMPTY: InspectorSnapshot = { chain: [], targetKey: null, targetId: 0, page: null };

const strip = ({ target: _target, ...item }: ResolvedItem): ChainItem => item;

/** Where the current target is, to tell "same element, moved" from "another element". */
type Tracked = Pin & { id: number };

/**
 * The inspector's view of an editor for useSyncExternalStore: `subscribe` / `getSnapshot`. The
 * snapshot is recomputed on every transaction and replaced only when its content changed, so
 * pagination transactions that only move things re-render nothing.
 */
export class InspectorStore {
  readonly editor: Editor;
  private pin: Pin | null = null;
  private tracked: Tracked | null = null;
  private nextId = 1;
  private snapshot: InspectorSnapshot = EMPTY;
  private json = '';
  private listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  /** The document the pin and the tracked target refer to. */
  private doc: PMNode | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    this.refresh(false);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) this.attach();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.detach?.();
        this.detach = null;
      }
    };
  };

  getSnapshot = (): InspectorSnapshot => this.snapshot;

  /** The inspected item, resolved in the editor's current state. */
  target(): ResolvedItem | null {
    const state = this.state();
    if (!state) return null;
    const chain = resolveChain(state);
    return chain[targetIndex(chain, this.pin)] ?? null;
  }

  /** Inspect the chain item `key` (a breadcrumb). The innermost item unpins. */
  select(key: string): void {
    const state = this.state();
    if (!state) return;
    const chain = resolveChain(state);
    const index = chain.findIndex((item) => item.key === key);
    if (index < 0) return;
    this.pin = index === chain.length - 1 ? null : pinOf(chain[index]!);
    this.refresh(true);
  }

  private state(): EditorState | null {
    return this.editor.isDestroyed ? null : this.editor.state;
  }

  private attach(): void {
    const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
      for (const tr of [transaction, ...appendedTransactions]) {
        if (this.pin) this.pin = mapPin(this.pin, tr);
        if (this.tracked) {
          const mapped = mapPin(this.tracked, tr);
          this.tracked = mapped ? { ...mapped, id: this.tracked.id } : null;
        }
      }
      this.refresh(true);
    };
    const onDestroy = () => {
      this.snapshot = EMPTY;
      this.json = '';
      for (const listener of this.listeners) listener();
    };
    this.editor.on('transaction', onTransaction);
    this.editor.on('destroy', onDestroy);
    this.detach = () => {
      this.editor.off('transaction', onTransaction);
      this.editor.off('destroy', onDestroy);
    };
    // Transactions while detached were not mapped: positions from before them mean nothing now.
    if (this.editor.state.doc !== this.doc) {
      this.pin = null;
      this.tracked = null;
    }
    this.refresh(true);
  }

  private refresh(notify: boolean): void {
    const state = this.state();
    if (!state) return;
    const chain = resolveChain(state);
    const index = targetIndex(chain, this.pin);
    if (this.pin && (index < 0 || !matchesPin(chain[index]!, this.pin))) this.pin = null;
    const target = chain[index] ?? null;
    let targetId = 0;
    if (target) {
      const where = pinOf(target);
      const same =
        this.tracked !== null &&
        (where.kind === 'node'
          ? this.tracked.kind === 'node' && this.tracked.pos === where.pos && this.tracked.type === where.type
          : this.tracked.kind === 'mark' && this.tracked.from === where.from && this.tracked.to === where.to);
      this.tracked = { ...where, id: same ? this.tracked!.id : this.nextId++ };
      targetId = this.tracked.id;
    } else this.tracked = null;
    this.doc = state.doc;
    const next: InspectorSnapshot = { chain: chain.map(strip), targetKey: target?.key ?? null, targetId, page: resolvePage(state) };
    const json = JSON.stringify(next);
    if (json === this.json) return;
    this.snapshot = next;
    this.json = json;
    if (notify) for (const listener of this.listeners) listener();
  }
}
