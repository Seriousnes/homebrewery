import type { MenuEntry, MenuItem } from '../menuTypes';

/** The activatable items of a menu in display order (groups flattened, separators dropped). */
export function flattenMenuItems(entries: readonly MenuEntry[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator') continue;
    if (entry.type === 'group') {
      for (const child of entry.items) if (child.type !== 'separator') out.push(child);
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function menuItemRole(item: MenuItem): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' {
  return item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem';
}

/** Next enabled index from `from` in direction `step` (wrapping); `from` -1 with step 1 finds the first. */
export function nextEnabled(items: readonly MenuItem[], from: number, step: 1 | -1): number {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const index = (((from + step * i) % n) + n) % n;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}
