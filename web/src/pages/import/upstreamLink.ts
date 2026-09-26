// What the "From the Homebrewery" field accepts (plan §7, P6.1; proxy P2.8): a share id, or a
// link to a brew on homebrewery.naturalcrit.com. The proxy downloads `/download/<shareId>`, which
// upstream looks up by share id only (legacy/server/page-routes.js:138, getBrew('share')).
//
//   https://homebrewery.naturalcrit.com/share/<id>     the share link (also /download, /source, /print)
//   homebrewery.naturalcrit.com/share/<id>             the same without the scheme
//   <id>                                               a bare share id, 10-14 letters, digits, _ or -
//
// Recognised but refused, each with its own explanation:
//   …/edit/<id>        an edit link: its id is the edit id, which upstream never serves by /download
//   7-9 character ids  old upstream ids; the proxy only accepts 10-14 (plan regex)
//   Google Drive ids   `<googleId><shareId>` (upstream getId, homebrew.api.js:63-89): stored in the
//                      author's Drive, not on upstream's server; dropped (plan §1)

export const UPSTREAM_HOST = 'homebrewery.naturalcrit.com';

/** Share ids the proxy accepts (the API's regex). */
const SHARE_ID = /^[A-Za-z0-9_-]{10,14}$/;
/** Upstream's old, shorter ids ("the DB shows a range of 7 to 14 characters"). */
const LEGACY_ID = /^[A-Za-z0-9_-]{7,9}$/;
/** A Google Drive file id (33-44 characters, starting with 1) followed by a 10-12 character id. */
const GOOGLE_ID = /^1[A-Za-z0-9_-]{32,43}[A-Za-z0-9_-]{10,12}$/;
const ID_CHARS = /^[A-Za-z0-9_-]+$/;
/** Upstream routes whose id is the share id. */
const SHARE_ROUTES = new Set(['share', 'download', 'source', 'print']);

export type UpstreamLinkProblem = 'empty' | 'edit-link' | 'legacy-id' | 'google-drive' | 'other-site' | 'not-a-brew-link' | 'invalid';

export type UpstreamLink = { ok: true; shareId: string } | { ok: false; problem: UpstreamLinkProblem; message: string };

const MESSAGES: Record<UpstreamLinkProblem, string> = {
  empty: 'Paste the brew’s share link or its share id.',
  'edit-link':
    'That is an edit link. The Homebrewery only downloads brews by their share link: open the brew there, choose Share, copy the share link and paste it here.',
  'legacy-id':
    'Share ids of 7 to 9 characters belong to old Homebrewery brews, which can’t be downloaded from here. On the Homebrewery, open the brew, download its text (Source → Download) and upload that file instead.',
  'google-drive':
    'This brew is stored in its author’s Google Drive, which this site doesn’t support. On the Homebrewery, open the brew, download its text (Source → Download) and upload that file instead.',
  'other-site': `That link isn’t on the Homebrewery (${UPSTREAM_HOST}). Paste a share link from there, or upload the brew’s text as a file.`,
  'not-a-brew-link': 'That Homebrewery link doesn’t point to a brew. Paste the brew’s share link (it contains /share/).',
  invalid: 'That doesn’t look like a Homebrewery share link or share id.',
};

const fail = (problem: UpstreamLinkProblem): UpstreamLink => ({ ok: false, problem, message: MESSAGES[problem] });

/** The share id in an id or the last segment of an upstream path. */
function classifyId(id: string, route: 'share' | 'edit' | null): UpstreamLink {
  if (!ID_CHARS.test(id)) return fail('invalid');
  if (route === 'edit') return fail('edit-link');
  if (SHARE_ID.test(id)) return { ok: true, shareId: id };
  if (LEGACY_ID.test(id)) return fail('legacy-id');
  if (GOOGLE_ID.test(id)) return fail('google-drive');
  return fail('invalid');
}

/** A URL from the text: with a scheme, or a bare host name followed by a path. */
function asUrl(text: string): URL | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[\w-]+(\.[\w-]+)+(:\d+)?\//.test(text) ? `https://${text}` : null;
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/** Parses what the user pasted into the "From the Homebrewery" field. */
export function parseUpstreamLink(input: string): UpstreamLink {
  const text = input.trim();
  if (!text) return fail('empty');
  const url = asUrl(text);
  if (!url) {
    // A bare id (anything with a slash, space or dot is not one).
    return /[\s/.:?#]/.test(text) ? fail('invalid') : classifyId(text, null);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('invalid');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== UPSTREAM_HOST) return fail('other-site');
  const segments = url.pathname.split('/').filter(Boolean);
  const [route, id] = segments;
  if (segments.length !== 2 || !route || !id) return fail('not-a-brew-link');
  const name = route.toLowerCase();
  if (name === 'edit') return classifyId(decodeSegment(id), 'edit');
  if (!SHARE_ROUTES.has(name)) return fail('not-a-brew-link');
  return classifyId(decodeSegment(id), 'share');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The share link of an upstream brew (shown after a download). */
export const upstreamShareUrl = (shareId: string): string => `https://${UPSTREAM_HOST}/share/${encodeURIComponent(shareId)}`;
