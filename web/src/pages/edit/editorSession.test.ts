import { describe, expect, it } from 'vitest';
import { adoptSession, draftDiscardedAt, editorSessionKey, NO_SESSIONS } from './editorSession';

describe('editorSession', () => {
  it('keys /edit by editId and /new by its history entry', () => {
    expect(editorSessionKey(NO_SESSIONS, 'abc', 'k1')).toBe('edit:abc');
    expect(editorSessionKey(NO_SESSIONS, 'abc', 'k2')).toBe('edit:abc');
    expect(editorSessionKey(NO_SESSIONS, undefined, 'k1')).toBe('new:k1');
    expect(editorSessionKey(NO_SESSIONS, undefined, 'k2')).toBe('new:k2');
  });

  it('a created brew keeps the session that created it', () => {
    const newKey = editorSessionKey(NO_SESSIONS, undefined, 'k1');
    const sessions = adoptSession(NO_SESSIONS, newKey, 'created1');
    expect(editorSessionKey(sessions, 'created1', 'k2')).toBe(newKey);
    // Other brews, and a later /new, get their own sessions.
    expect(editorSessionKey(sessions, 'other', 'k3')).toBe('edit:other');
    expect(editorSessionKey(sessions, undefined, 'k4')).toBe('new:k4');
    // A copy made from an edit session.
    const copied = adoptSession(sessions, 'edit:other', 'copy1');
    expect(editorSessionKey(copied, 'copy1', 'k5')).toBe('edit:other');
    expect(editorSessionKey(copied, 'created1', 'k5')).toBe(newKey);
    expect(adoptSession(copied, 'edit:other', 'copy1')).toBe(copied);
  });

  it('a session that moves on to a copy lets go of the original: its URL gets a session of its own', () => {
    const edited = adoptSession(NO_SESSIONS, 'edit:A', 'C', 'A');
    expect(editorSessionKey(edited, 'C', 'k1')).toBe('edit:A');
    const original = editorSessionKey(edited, 'A', 'k1');
    expect(original).not.toBe('edit:A');
    expect(editorSessionKey(edited, 'A', 'k2')).toBe(original);
    // A second copy from the session that reopened the original.
    const again = adoptSession(edited, original, 'C2', 'A');
    expect(editorSessionKey(again, 'C2', 'k3')).toBe(original);
    expect(new Set([editorSessionKey(again, 'A', 'k3'), original, 'edit:A']).size).toBe(3);
    // A /new session: its created brew, then a copy of that.
    const created = adoptSession(NO_SESSIONS, 'new:k1', 'N');
    const copied = adoptSession(created, 'new:k1', 'C', 'N');
    expect(editorSessionKey(copied, 'C', 'k2')).toBe('new:k1');
    expect(editorSessionKey(copied, 'N', 'k2')).not.toBe('new:k1');
  });

  it('reads the "Start over" time from the router state', () => {
    expect(draftDiscardedAt({ hbDraftDiscardedAt: 123 })).toBe(123);
    expect(draftDiscardedAt(null)).toBeNull();
    expect(draftDiscardedAt({ hbDraftDiscardedAt: 'x' })).toBeNull();
    expect(draftDiscardedAt({ hbDraftDiscardedAt: Number.NaN })).toBeNull();
  });
});
