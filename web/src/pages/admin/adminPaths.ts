// The admin module's own routes (nested under the shell's `admin/*` route). Build links with these
// so ids, handles and queries are always encoded.
const enc = encodeURIComponent;

/** The review queue's heading id on /admin/locks. */
export const REVIEW_QUEUE_ANCHOR = 'review-queue';

export const adminPaths = {
  overview: '/admin',
  /** The user search, optionally with a query (?q=). */
  users: (q?: string) => (q?.trim() ? `/admin/users?q=${enc(q.trim())}` : '/admin/users'),
  user: (handle: string) => `/admin/users/${enc(handle)}`,
  brews: '/admin/brews',
  /** A brew by internal id, share id or edit id. */
  brew: (id: string) => `/admin/brews/${enc(id.trim())}`,
  locks: '/admin/locks',
  reviewQueue: `/admin/locks#${REVIEW_QUEUE_ANCHOR}`,
  notifications: '/admin/notifications',
  newNotification: '/admin/notifications/new',
  notification: (id: string) => `/admin/notifications/${enc(id)}`,
} as const;

export interface AdminSectionLink {
  id: 'overview' | 'users' | 'brews' | 'locks' | 'notifications';
  label: string;
  to: string;
  /** Only the exact path is "current" (the overview). */
  end?: boolean;
}

export const ADMIN_SECTIONS: readonly AdminSectionLink[] = [
  { id: 'overview', label: 'Overview', to: adminPaths.overview, end: true },
  { id: 'users', label: 'Users', to: adminPaths.users() },
  { id: 'brews', label: 'Brews', to: adminPaths.brews },
  { id: 'locks', label: 'Locks', to: adminPaths.locks },
  { id: 'notifications', label: 'Notifications', to: adminPaths.notifications },
];
