import type { ReactNode } from 'react';
import type { IconName } from './iconPaths';

interface MenuItemBase {
  id: string;
  label: string;
  /**
   * Custom visual content shown in place of the label text (e.g. a theme preview); `label` stays
   * the accessible name (aria-label) and the typeahead text.
   */
  content?: ReactNode;
  icon?: IconName;
  /** Display only, e.g. "Ctrl+B". */
  shortcut?: string;
  disabled?: boolean;
  /** Close the menu after activating (default true). */
  closeOnSelect?: boolean;
}

export interface MenuActionItem extends MenuItemBase {
  type?: 'item';
  onSelect: () => void;
}

export interface MenuCheckboxItem extends MenuItemBase {
  type: 'checkbox';
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** One choice of a set; put a set in a group. */
export interface MenuRadioItem extends MenuItemBase {
  type: 'radio';
  checked: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  type: 'separator';
  id?: string;
}

/**
 * Opens a nested menu of `items` (ArrowRight, Enter, Space, a click or the pointer on it); ArrowLeft
 * or Escape goes back to it. Its shortcut and closeOnSelect are not used.
 */
export interface MenuSubmenuItem extends MenuItemBase {
  type: 'submenu';
  items: readonly MenuEntry[];
}

/** A labelled group (role=group). Groups don't nest. */
export interface MenuGroup {
  type: 'group';
  id: string;
  label: string;
  items: readonly MenuLeaf[];
}

export type MenuItem = MenuActionItem | MenuCheckboxItem | MenuRadioItem | MenuSubmenuItem;
export type MenuLeaf = MenuItem | MenuSeparator;
export type MenuEntry = MenuLeaf | MenuGroup;
