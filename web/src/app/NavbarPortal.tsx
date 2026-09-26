import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type NavbarSlot, useNavbarSlot } from './navbarSlotsContext';

export interface NavbarPortalProps {
  slot: NavbarSlot;
  children: ReactNode;
}

/**
 * Renders a page's navbar content into the shell's navbar (see navbarSlotsContext.ts). Nothing
 * renders outside the app shell (dev pages) or before the navbar has mounted.
 *
 *   <NavbarPortal slot="title">{brew.title}</NavbarPortal>
 *   <NavbarPortal slot="items"><ShareNavItem … /><ErrorNavItem … /></NavbarPortal>
 */
export function NavbarPortal({ slot, children }: NavbarPortalProps) {
  const target = useNavbarSlot(slot);
  return target ? createPortal(children, target) : null;
}
