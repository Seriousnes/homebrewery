// Natural image sizes (plan §6.6): image.attrs.width/height hold the file's natural size, so a
// saved document knows every image's box before the file loads (ImageView renders it; pagination
// treats an image with both as sized). The importer waits for the images in its probe, reads their
// natural sizes there and writes them into the image nodes generateJSON made. In the editor,
// ImageWithView's natural-size plugin (objects/imageView.ts) then finds nothing left to record.
import type { JSONContent } from '@tiptap/core';

export interface NaturalSize {
  width: number;
  height: number;
}

/** The natural sizes of the loaded images under `root`, by src attribute (failed and pending ones left out). */
export function naturalImageSizes(root: ParentNode): Map<string, NaturalSize> {
  const sizes = new Map<string, NaturalSize>();
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (src === null || sizes.has(src) || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) continue;
    sizes.set(src, { width: img.naturalWidth, height: img.naturalHeight });
  }
  return sizes;
}

/**
 * Writes the natural size of its src into every image node of `doc` (in place) that has neither
 * width nor height. A width or height the author gave (HTML attributes) is left as written.
 * Returns the number of images sized.
 */
export function applyNaturalSizes(doc: JSONContent, sizes: ReadonlyMap<string, NaturalSize>): number {
  if (sizes.size === 0) return 0;
  let count = 0;
  const visit = (node: JSONContent) => {
    const attrs = node.attrs;
    if (node.type === 'image' && attrs && typeof attrs.src === 'string' && attrs.width == null && attrs.height == null) {
      const size = sizes.get(attrs.src);
      if (size) {
        attrs.width = size.width;
        attrs.height = size.height;
        count++;
      }
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return count;
}
