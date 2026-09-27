// Which editor session a /new, /edit/:editId or /local/:localId URL shows (plan §9, P7.2, issue #4).
// One React key per session: a new key mounts a new editor (and flushes the old one), the same key
// keeps it.
//
// - /edit/:editId is keyed by its editId, so opening the same brew again keeps the editor.
// - /local/:localId is keyed by `local:<id>` (localSessionId); a signed-out /new brew's first write
//   adopts that id, so the move to /local/:localId keeps the editor too.
// - /new is keyed by its history entry: "New brew" (or "Start over") mounts a fresh one.
// - The first save of a /new brew (or "Save mine as a copy") adopts the new editId into the
//   running session, so the navigation to /edit/:editId keeps the same editor mounted: autosave
//   keeps its version bookkeeping and nothing is reloaded (see the autosave notes).
// - A session that moves on to a copy lets go of the brew it held: that brew's URL (Back, recent
//   brews, any link) then gets a key of its own and mounts an editor that loads it.

export interface EditorSessions {
  /** editId → the key of the session that holds it (while this route stays mounted). */
  adopted: Readonly<Record<string, string>>;
  /** editId → how many times a session let it go (a copy took its place); part of its next key. */
  released: Readonly<Record<string, number>>;
}

export const NO_SESSIONS: EditorSessions = { adopted: {}, released: {} };

/** The adopted key of local brew `localId` (local ids and editIds never collide: editIds have no ':'). */
export const localSessionId = (localId: string): string => `local:${localId}`;

/** The React key for the editor at this URL. */
export function editorSessionKey(sessions: EditorSessions, editId: string | undefined, locationKey: string, localId?: string): string {
  if (localId) return sessions.adopted[localSessionId(localId)] ?? localSessionId(localId);
  if (editId) {
    const adopted = sessions.adopted[editId];
    if (adopted) return adopted;
    const released = sessions.released[editId] ?? 0;
    return released > 0 ? `edit:${editId}#${released}` : `edit:${editId}`;
  }
  return `new:${locationKey}`;
}

/**
 * The session `sessionKey` now holds brew `editId` (created or copied): keep it for /edit/:editId.
 * `from`: the brew it held until now (a copy's original), which it no longer shows.
 */
export function adoptSession(sessions: EditorSessions, sessionKey: string, editId: string, from: string | null = null): EditorSessions {
  const releases = from !== null && from !== editId;
  if (sessions.adopted[editId] === sessionKey && !releases) return sessions;
  const adopted = { ...sessions.adopted, [editId]: sessionKey };
  let released = sessions.released;
  if (releases) {
    if (adopted[from] === sessionKey) delete adopted[from];
    released = { ...released, [from]: (released[from] ?? 0) + 1 };
  }
  return { adopted, released };
}

/** Router state of /new after "Start over": drafts written before this time are ignored. */
export interface NewPageState {
  hbDraftDiscardedAt?: number;
}

export function draftDiscardedAt(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as NewPageState).hbDraftDiscardedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
