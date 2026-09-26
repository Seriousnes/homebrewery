// Page objects (plan §4.9, P5.3): pure helpers for page.attrs.objects and the page's cover
// markers. No DOM, no ProseMirror state: commands.ts builds transactions from these.
//
// An object's position lives in its `style` (position: absolute plus offsets). Moving writes
// `left`/`top`, resizing `width`/`height` (px); every other declaration is kept in place.
import type { PageObject } from '../schema';
import { normalizePageObjects } from '../schema';

// ---------------------------------------------------------------------------------------------
// Style declarations
// ---------------------------------------------------------------------------------------------

/** One declaration: [property, value]. Properties are lower case (custom properties as written). */
export type Declaration = [property: string, value: string];

/** Splits a style attribute into declarations (`;` inside strings and url()/parentheses kept). */
export function parseDeclarations(style: string | null | undefined): Declaration[] {
  if (!style) return [];
  const out: Declaration[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const part = style.slice(start, end);
    const colon = part.indexOf(':');
    if (colon > 0) {
      const raw = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      if (raw && value) out.push([raw.startsWith('--') ? raw : raw.toLowerCase(), value]);
    }
  };
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(style.length);
  return out;
}

/** Declarations back to a style attribute, in the cssText form (`a: b; c: d;`). */
export function serializeDeclarations(declarations: readonly Declaration[]): string {
  return declarations.map(([p, v]) => `${p}: ${v};`).join(' ');
}

/** The value of `property` in `style` (the last one wins, as in CSS), or null. */
export function styleValue(style: string | null | undefined, property: string): string | null {
  let value: string | null = null;
  for (const [p, v] of parseDeclarations(style)) if (p === property) value = v;
  return value;
}

/**
 * `style` with the given properties set (string) or removed (null). Existing declarations keep
 * their place; new ones are appended in the order given.
 */
export function withStyle(style: string | null | undefined, patch: Readonly<Record<string, string | null>>): string {
  const decls = parseDeclarations(style);
  const done = new Set<string>();
  const out: Declaration[] = [];
  for (const [p, v] of decls) {
    if (!(p in patch)) {
      out.push([p, v]);
      continue;
    }
    const next = patch[p];
    if (next === null || next === undefined || done.has(p)) continue; // removed, or a duplicate
    out.push([p, next]);
    done.add(p);
  }
  for (const [p, v] of Object.entries(patch)) {
    if (v !== null && !done.has(p)) out.push([p, v]);
  }
  return serializeDeclarations(out);
}

/** `12px` / `12.5px` / `0` → number; anything else (%, em, auto) → null. */
export function pxValue(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === '0') return 0;
  const m = /^(-?\d+(?:\.\d+)?)px$/i.exec(v);
  return m ? Number(m[1]) : null;
}

/** A pixel length for a style, rounded to whole pixels. */
export const px = (n: number): string => `${Math.round(n)}px`;

// ---------------------------------------------------------------------------------------------
// Object lists
// ---------------------------------------------------------------------------------------------

/** The page's objects, cleaned (normalizePageObjects). */
export function objectsOf(attrs: { objects?: unknown }): PageObject[] {
  return normalizePageObjects(attrs.objects);
}

export function findObject(objects: readonly PageObject[], id: string): PageObject | undefined {
  return objects.find((o) => o.id === id);
}

/** An id not used by any of `objects`. */
export function newObjectId(objects: readonly PageObject[], random: () => number = Math.random): string {
  const used = new Set(objects.map((o) => o.id));
  for (;;) {
    const id = `o-${Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** `objects` with object `id` changed by `patch` (null when there is no such object or nothing changes). */
export function patchObject(objects: readonly PageObject[], id: string, patch: Partial<Omit<PageObject, 'id'>>): PageObject[] | null {
  const index = objects.findIndex((o) => o.id === id);
  if (index < 0) return null;
  const current = objects[index]!;
  const next: PageObject = { ...current, ...patch };
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  return objects.map((o, i) => (i === index ? next : o));
}

export function removeObject(objects: readonly PageObject[], id: string): PageObject[] | null {
  const next = objects.filter((o) => o.id !== id);
  return next.length === objects.length ? null : next;
}

/** z-order: later objects paint over earlier ones (same z-index), so order is stacking order. */
export type ZOrderMove = 'forward' | 'backward' | 'front' | 'back';

export function reorderObject(objects: readonly PageObject[], id: string, move: ZOrderMove): PageObject[] | null {
  const index = objects.findIndex((o) => o.id === id);
  if (index < 0) return null;
  const target = move === 'forward' ? index + 1 : move === 'backward' ? index - 1 : move === 'front' ? objects.length - 1 : 0;
  if (target < 0 || target >= objects.length || target === index) return null;
  const next = [...objects];
  const [object] = next.splice(index, 1);
  next.splice(target, 0, object!);
  return next;
}

export interface NewObjectPlacement {
  left: number;
  top: number;
  width?: number;
  height?: number;
}

/** left/top (and width/height when given) as style properties; missing sizes are left alone. */
function placementPatch(at: NewObjectPlacement): Record<string, string> {
  const patch: Record<string, string> = { left: px(at.left), top: px(at.top) };
  if (at.width !== undefined) patch.width = px(at.width);
  if (at.height !== undefined) patch.height = px(at.height);
  return patch;
}

/** A new positioned image object. */
export function imageObject(id: string, src: string, at: NewObjectPlacement, classes: string[] = [], baseStyle?: string | null): PageObject {
  const style = withStyle(baseStyle, {
    position: 'absolute',
    ...placementPatch(at),
  });
  return { id, kind: 'image', classes, style, src };
}

/** A new positioned text object. */
export function textObject(id: string, text: string, at: NewObjectPlacement, classes: string[] = []): PageObject {
  const style = withStyle(null, {
    position: 'absolute',
    left: px(at.left),
    top: px(at.top),
    width: at.width !== undefined ? px(at.width) : null,
  });
  return { id, kind: 'text', classes, style, text };
}

// ---------------------------------------------------------------------------------------------
// Converting between inline images and objects
// ---------------------------------------------------------------------------------------------

/** Declarations that position an element in the text flow or on the page. */
const PLACEMENT = ['position', 'left', 'top', 'right', 'bottom', 'inset', 'float', 'clear', 'z-index'];

/** An inline image's style as an object's: placed at `at` (page px), flow-only declarations dropped. */
export function objectStyleFromImage(imageStyle: string | null | undefined, at: NewObjectPlacement): string {
  const drop = Object.fromEntries([...PLACEMENT, 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'shape-outside'].map((p) => [p, null]));
  return withStyle(imageStyle, {
    ...drop,
    position: 'absolute',
    ...placementPatch(at),
  });
}

/** An object's style as an inline image's: positioning dropped, size and the rest kept. */
export function imageStyleFromObject(objectStyle: string | null | undefined): string | null {
  const style = withStyle(objectStyle, Object.fromEntries(PLACEMENT.map((p) => [p, null])));
  return style === '' ? null : style;
}

// ---------------------------------------------------------------------------------------------
// Cover markers
// ---------------------------------------------------------------------------------------------

/** Page markers that switch a page to a cover layout (theme `.page:has(.frontCover)` …). */
export const COVER_MARKERS = ['frontCover', 'insideCover', 'partCover', 'backCover'] as const;
export type CoverMarker = (typeof COVER_MARKERS)[number];

export const COVER_LABELS: Record<CoverMarker, string> = {
  frontCover: 'Front cover',
  insideCover: 'Inside cover',
  partCover: 'Part cover',
  backCover: 'Back cover',
};

export function isCoverMarker(value: string): value is CoverMarker {
  return (COVER_MARKERS as readonly string[]).includes(value);
}

/** The page's cover marker, or null. */
export function coverOf(markers: unknown): CoverMarker | null {
  if (!Array.isArray(markers)) return null;
  return (markers as unknown[]).find((m): m is CoverMarker => typeof m === 'string' && isCoverMarker(m)) ?? null;
}

/** `markers` with exactly `cover` as its cover marker (null: none); other markers kept. */
export function withCover(markers: unknown, cover: CoverMarker | null): string[] {
  const rest = Array.isArray(markers) ? (markers as unknown[]).filter((m): m is string => typeof m === 'string' && !isCoverMarker(m)) : [];
  return cover ? [cover, ...rest] : rest;
}
