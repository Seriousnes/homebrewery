import type { ReactNode } from 'react';
import { type AccountInfo, useMe } from '@/api';
import { SignInRequired } from '@/pages/auth/SignInRequired';
import { ErrorPage } from '@/pages/errors/ErrorPage';
import { PageLoading } from './PageLoading';
import { ADMIN_ROLE, hasRole } from './roles';

export interface RequireAuthProps {
  /** The page; a function receives the signed-in account. */
  children: ReactNode | ((account: AccountInfo) => ReactNode);
  /** Also require this role (e.g. ADMIN_ROLE from web/src/app/roles.ts); others get a 403 page. */
  role?: string;
}

/**
 * Wrap a page that needs an account (/account, /admin, …). Anonymous visitors get the sign-in
 * page in place (the "Sign in required" prompt); once they sign in, the page renders. A failed
 * account check shows an error page with Retry.
 */
export function RequireAuth({ children, role }: RequireAuthProps) {
  const me = useMe();
  if (me.isPending) return <PageLoading label="Checking your sign-in" />;
  if (me.isError && me.data === undefined) return <ErrorPage error={me.error} onRetry={() => void me.refetch()} />;
  const account = me.data ?? null;
  if (!account) return <SignInRequired />;
  if (role && !hasRole(account, role)) {
    const message = role === ADMIN_ROLE ? 'This page is only for administrators.' : `This page needs the '${role}' role.`;
    return <ErrorPage status={403} message={message} />;
  }
  return <>{typeof children === 'function' ? children(account) : children}</>;
}
