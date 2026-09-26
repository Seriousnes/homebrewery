// Nav.item from legacy client/homebrew/navbar/nav.jsx, split into a router link and a button.
import clsx from 'clsx';
import type { ComponentPropsWithRef, ReactNode, Ref } from 'react';
import { NavLink, type NavLinkProps } from 'react-router';
import styles from './Navbar.module.css';
import { type NavTone, toneClass } from './navTone';

interface NavItemContent {
  icon?: ReactNode;
  tone?: NavTone;
  /** Hide the text on narrow screens (icon only; still read by screen readers). */
  collapsible?: boolean;
}

function Content({ icon, collapsible, children }: NavItemContent & { children?: ReactNode }) {
  return (
    <>
      {icon}
      {children != null ? <span className={clsx(styles.itemLabel, collapsible && styles.collapsible)}>{children}</span> : null}
    </>
  );
}

export interface NavLinkItemProps extends NavItemContent, Omit<NavLinkProps, 'className' | 'children' | 'style'> {
  children?: ReactNode;
  className?: string;
  ref?: Ref<HTMLAnchorElement>;
}

/** A navbar link to an app route; aria-current="page" when it is the current page. */
export function NavLinkItem({ icon, tone, collapsible, children, className, ...rest }: NavLinkItemProps) {
  return (
    <NavLink {...rest} className={clsx(styles.item, toneClass(tone), className)}>
      <Content icon={icon} collapsible={collapsible}>
        {children}
      </Content>
    </NavLink>
  );
}

export interface NavButtonProps extends NavItemContent, ComponentPropsWithRef<'button'> {}

/** A navbar button (an action, or the trigger of a NavDisclosure). */
export function NavButton({ icon, tone, collapsible, children, className, type = 'button', ...rest }: NavButtonProps) {
  return (
    <button {...rest} type={type} className={clsx(styles.item, toneClass(tone), className)}>
      <Content icon={icon} collapsible={collapsible}>
        {children}
      </Content>
    </button>
  );
}
