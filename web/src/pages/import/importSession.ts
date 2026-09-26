// /import keeps what the visitor pasted, typed or loaded for the rest of the browser tab
// (sessionStorage), so it survives going to the sign-in or register page and coming back (P6.1:
// "keep the pasted text across the sign-in"). A per-tab convenience only: every access is wrapped,
// and the page works the same without it (blocked storage, a private window, quota).

export const IMPORT_SESSION_KEY = 'hb-import-session';

export type ImportTab = 'paste' | 'file' | 'link';
export type ImportSourceKind = 'paste' | 'file' | 'link';

/** The text that was converted and where it came from. */
export interface LoadedSource {
  kind: ImportSourceKind;
  text: string;
  /** "pasted text", the file name, or the upstream share id. */
  label: string;
  /** e.g. the file's encoding note. */
  note?: string;
}

export interface ImportSession {
  tab: ImportTab;
  paste: string;
  link: string;
  loaded: LoadedSource | null;
}

export const EMPTY_SESSION: ImportSession = { tab: 'paste', paste: '', link: '', loaded: null };

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): SessionStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const TABS: readonly string[] = ['paste', 'file', 'link'];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Stored form: a loaded paste that equals the paste field isn't stored twice. */
interface Stored {
  v: 1;
  tab: ImportTab;
  paste: string;
  link: string;
  loaded: (Omit<LoadedSource, 'text'> & { text?: string; samePaste?: true }) | null;
}

export function parseImportSession(raw: string | null): ImportSession | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const s = value as Partial<Stored>;
  if (s.v !== 1) return null;
  const paste = str(s.paste);
  const tab = TABS.includes(str(s.tab)) ? (s.tab as ImportTab) : 'paste';
  let loaded: LoadedSource | null = null;
  const l = s.loaded;
  if (l && typeof l === 'object' && TABS.includes(str(l.kind))) {
    const text = l.samePaste ? paste : str(l.text);
    if (text) loaded = { kind: l.kind, text, label: str(l.label), ...(l.note ? { note: str(l.note) } : {}) };
  }
  return { tab, paste, link: str(s.link), loaded };
}

export function readImportSession(store: SessionStore | null = defaultStore()): ImportSession | null {
  try {
    return parseImportSession(store?.getItem(IMPORT_SESSION_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Saves the session; when it doesn't fit, tries again without the loaded text, then gives up. */
export function writeImportSession(session: ImportSession, store: SessionStore | null = defaultStore()): boolean {
  if (!store) return false;
  const { loaded } = session;
  const samePaste = loaded?.kind === 'paste' && loaded.text === session.paste;
  const full: Stored = {
    v: 1,
    tab: session.tab,
    paste: session.paste,
    link: session.link,
    loaded: loaded ? { kind: loaded.kind, label: loaded.label, ...(loaded.note ? { note: loaded.note } : {}), ...(samePaste ? { samePaste: true } : { text: loaded.text }) } : null,
  };
  const attempts: Stored[] = [full];
  if (loaded && !samePaste) attempts.push({ ...full, loaded: null });
  for (const attempt of attempts) {
    try {
      store.setItem(IMPORT_SESSION_KEY, JSON.stringify(attempt));
      return true;
    } catch {
      // Quota: try the smaller form.
    }
  }
  try {
    store.removeItem(IMPORT_SESSION_KEY);
  } catch {
    // Blocked storage.
  }
  return false;
}

export function clearImportSession(store: SessionStore | null = defaultStore()): void {
  try {
    store?.removeItem(IMPORT_SESSION_KEY);
  } catch {
    // Blocked storage: nothing was kept.
  }
}
