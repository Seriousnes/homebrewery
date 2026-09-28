// Where the table controls go (pure, so it is unit tested without layout): under the table,
// above it when there is no room below, else pinned to the bottom of the visible area while the
// table is in view; hidden while the table is scrolled out. Viewport coordinates.

export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface ControlsPlacement {
  top: number;
  left: number;
  hidden: boolean;
}

/** Gap between the table and the controls, and between the controls and the visible area's edges. */
export const CONTROLS_GAP = 4;

export function placeTableControls(table: Box, clip: Box, size: { width: number; height: number }): ControlsPlacement {
  const { width, height } = size;
  const left = Math.max(clip.left + CONTROLS_GAP, Math.min(table.left, clip.right - width - CONTROLS_GAP));
  if (table.bottom < clip.top || table.top > clip.bottom) return { top: 0, left, hidden: true };
  const below = table.bottom + CONTROLS_GAP;
  if (below + height <= clip.bottom - CONTROLS_GAP) return { top: Math.max(below, clip.top + CONTROLS_GAP), left, hidden: false };
  const above = table.top - CONTROLS_GAP - height;
  if (above >= clip.top + CONTROLS_GAP) return { top: above, left, hidden: false };
  // A table taller than the space: at the bottom of the visible area, over the table.
  return { top: Math.max(clip.top + CONTROLS_GAP, clip.bottom - CONTROLS_GAP - height), left, hidden: false };
}
