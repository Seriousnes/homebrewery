import { createContext, useContext } from 'react';

/**
 * Where pages put their own navbar content: 'title' (the brew title, in the middle) and 'items'
 * (page actions such as share, print, the save status or an ErrorNavItem, placed before the
 * site-wide items). Render them with <NavbarPortal slot="…"> from web/src/app/NavbarPortal.tsx.
 */
export type NavbarSlot = 'title' | 'items';

export type NavbarSlotElements = Readonly<Record<NavbarSlot, HTMLElement | null>>;

export const NO_NAVBAR_SLOTS: NavbarSlotElements = { title: null, items: null };

export const NavbarSlotsContext = createContext<NavbarSlotElements>(NO_NAVBAR_SLOTS);

export function useNavbarSlot(slot: NavbarSlot): HTMLElement | null {
  return useContext(NavbarSlotsContext)[slot];
}
