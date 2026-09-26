// The import preview's zoom (P6.3): one page fits the preview box's width.

/** Page width before the theme is measured (US Letter, 8.5in at 96 px/in). */
export const DEFAULT_PAGE_WIDTH = 816;
/** Room for the canvas margins and the viewport's scrollbar. */
const FIT_PADDING = 40;
const MIN_ZOOM = 0.25;

/** The zoom (0.25 to 1, two decimals) that fits one page of `pageWidth` into `width`. */
export function fitZoom(width: number, pageWidth = DEFAULT_PAGE_WIDTH): number {
  if (!(width > 0) || !(pageWidth > 0)) return 1;
  const zoom = (width - FIT_PADDING) / pageWidth;
  return Math.round(Math.min(1, Math.max(MIN_ZOOM, zoom)) * 100) / 100;
}
