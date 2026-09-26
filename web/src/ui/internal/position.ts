// Placement of floating UI (popovers, menus, tooltips) next to an anchor, in viewport coordinates
// (the floating element is position: fixed). Pure, so it is unit tested without layout.

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-start` | `${Side}-end`;

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PositionInput {
  anchor: RectLike;
  floating: { width: number; height: number };
  viewport: { width: number; height: number };
  placement?: Placement;
  /** Gap between anchor and floating element. */
  offset?: number;
  /** Minimum distance from the viewport edges. */
  padding?: number;
}

export interface PositionResult {
  top: number;
  left: number;
  /** The placement used after flipping. */
  placement: Placement;
  /** Space available on the chosen side: set as max-height (top/bottom) so long content scrolls. */
  maxHeight: number;
  maxWidth: number;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

export function parsePlacement(placement: Placement): { side: Side; align: Align } {
  const [side, align] = placement.split('-') as [Side, Align | undefined];
  return { side, align: align ?? 'center' };
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

export function computePosition({
  anchor,
  floating,
  viewport,
  placement = 'bottom-start',
  offset = 4,
  padding = 8,
}: PositionInput): PositionResult {
  const { side: preferred, align } = parsePlacement(placement);
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const space: Record<Side, number> = {
    top: anchor.top - offset - padding,
    bottom: viewport.height - bottom - offset - padding,
    left: anchor.left - offset - padding,
    right: viewport.width - right - offset - padding,
  };
  const vertical = preferred === 'top' || preferred === 'bottom';
  const size = vertical ? floating.height : floating.width;
  let side = preferred;
  if (space[side] < size && space[OPPOSITE[side]] > space[side]) side = OPPOSITE[side];

  let top: number;
  let left: number;
  let maxHeight = viewport.height - 2 * padding;
  let maxWidth = viewport.width - 2 * padding;
  const height = Math.min(floating.height, maxHeight);
  const width = Math.min(floating.width, maxWidth);

  if (vertical) {
    maxHeight = Math.max(0, space[side]);
    const h = Math.min(height, maxHeight);
    top = side === 'bottom' ? bottom + offset : anchor.top - offset - h;
    const start = align === 'start' ? anchor.left : align === 'end' ? right - width : anchor.left + (anchor.width - width) / 2;
    left = clamp(start, padding, viewport.width - padding - width);
  } else {
    maxWidth = Math.max(0, space[side]);
    const w = Math.min(width, maxWidth);
    left = side === 'right' ? right + offset : anchor.left - offset - w;
    const start = align === 'start' ? anchor.top : align === 'end' ? bottom - height : anchor.top + (anchor.height - height) / 2;
    top = clamp(start, padding, viewport.height - padding - height);
  }

  const used: Placement = align === 'center' ? side : `${side}-${align}`;
  return { top: Math.round(top), left: Math.round(left), placement: used, maxHeight: Math.floor(maxHeight), maxWidth: Math.floor(maxWidth) };
}
