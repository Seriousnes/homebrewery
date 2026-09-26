// Port of legacy client/homebrew/navbar/account.navitem.jsx. Signed out: a "Sign in" link that
// comes back to this page. Signed in: the handle, opening a panel with the user's brews, the
// account page, the admin pages (Admin role) and "Sign out".
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { useMe } from '@/api';
import { isAuthPath, locationPath, paths } from '@/app/paths';
import { ADMIN_ROLE, hasRole } from '@/app/roles';
import { useSignOut } from '@/app/useSignOut';
import { Icon } from '@/ui';
import { NavDisclosure } from './NavDisclosure';
import { NavLinkItem } from './NavItem';
import styles from './Navbar.module.css';

export function AccountNavItem() {
  const me = useMe();
  const location = useLocation();
  const signInRef = useRef<HTMLAnchorElement>(null);
  // After "Sign out" the panel and its trigger are gone; focus goes to the "Sign in" link that
  // replaces them instead of being dropped on <body>.
  const focusSignIn = useRef(false);
  const { signOut, pending } = useSignOut(() => {
    focusSignIn.current = true;
  });
  const account = me.data ?? null;

  useEffect(() => {
    if (!account && focusSignIn.current && signInRef.current) {
      focusSignIn.current = false;
      signInRef.current.focus();
    }
  });

  if (me.isPending) {
    // Keeps the bar from jumping when the account arrives.
    return <span className={styles.placeholder} aria-hidden="true" />;
  }

  if (!account) {
    const onAuthPage = isAuthPath(location.pathname);
    return (
      <NavLinkItem
        ref={signInRef}
        to={onAuthPage ? paths.login() : paths.login(locationPath(location))}
        tone="teal"
        icon={<Icon name="user" />}
        collapsible
        data-testid="nav-sign-in"
      >
        Sign in
      </NavLinkItem>
    );
  }

  const isAdmin = hasRole(account, ADMIN_ROLE);
  return (
    <NavDisclosure
      label={account.handle}
      aria-label={`Account: ${account.handle}`}
      icon={<Icon name="user" />}
      tone="orange"
      collapsible
      triggerClassName={styles.handle}
      panelLabel="Account"
      data-testid="nav-account"
    >
      {(close) => (
        <>
          <p className={styles.panelNote}>
            Signed in as <strong>{account.handle}</strong>
            {account.email ? (
              <>
                <br />
                {account.email}
              </>
            ) : null}
          </p>
          <ul className={styles.panelList}>
            <li>
              <Link className={styles.panelLink} to={paths.user(account.handle)}>
                My brews
              </Link>
            </li>
            <li>
              <Link className={styles.panelLink} to={paths.account}>
                Account settings
              </Link>
            </li>
            {isAdmin ? (
              <li>
                <Link className={styles.panelLink} to={paths.admin}>
                  Admin
                </Link>
              </li>
            ) : null}
            <li>
              <button
                type="button"
                className={styles.panelLink}
                aria-disabled={pending || undefined}
                onClick={() => {
                  close();
                  signOut();
                }}
              >
                <span className={styles.panelLinkRow}>
                  <Icon name="close" size={14} />
                  {pending ? 'Signing out…' : 'Sign out'}
                </span>
              </button>
            </li>
          </ul>
        </>
      )}
    </NavDisclosure>
  );
}
