import type { AccountInfo } from '@/api';

/** The server's admin role name (Homebrewery.Core Roles.Admin). */
export const ADMIN_ROLE = 'Admin';

export function hasRole(account: AccountInfo | null | undefined, role: string): boolean {
  return Boolean(account?.roles.includes(role));
}
