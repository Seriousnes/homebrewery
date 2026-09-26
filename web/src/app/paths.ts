// Route paths (plan §9) and safe "return to" handling for the sign-in flow. Build links with
// these helpers instead of string templates so ids and handles are always encoded.

const enc = encodeURIComponent;

function withReturnTo(path: string, returnTo?: string | null): string {
  const target = returnTo ? safeReturnTo(returnTo, '') : '';
  return target && target !== '/' ? `${path}?returnTo=${enc(target)}` : path;
}

export const paths = {
  home: '/',
  new: '/new',
  edit: (editId: string) => `/edit/${enc(editId)}`,
  share: (shareId: string) => `/share/${enc(shareId)}`,
  user: (handle: string) => `/user/${enc(handle)}`,
  vault: '/vault',
  import: '/import',
  account: '/account',
  admin: '/admin',
  /** The sign-in page; returnTo (a same-site path) is where it goes after signing in. */
  login: (returnTo?: string | null) => withReturnTo('/login', returnTo),
  register: (returnTo?: string | null) => withReturnTo('/register', returnTo),
} as const;

/** Pages that are themselves the sign-in flow: never return to them, never prompt over them. */
export function isAuthPath(pathname: string): boolean {
  return /^\/(?:login|register)(?:\/|$)/i.test(pathname);
}

/**
 * A same-site path to go to after signing in, or `fallback`. Only absolute paths on this origin
 * are accepted ('/edit/abc?x#p2'); other origins, protocol-relative ('//evil'), backslash tricks
 * ('/\\evil'), control characters and the sign-in pages themselves are refused.
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value.length > 2000) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, 'http://return.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'http://return.invalid') return fallback;
  if (isAuthPath(url.pathname)) return fallback;
  return url.pathname + url.search + url.hash;
}

/** The current location as a returnTo value. */
export function locationPath(location: { pathname: string; search: string; hash: string }): string {
  return location.pathname + location.search + location.hash;
}
