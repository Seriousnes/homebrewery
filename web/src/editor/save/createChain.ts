// A new brew's create chain (SAVE-8): the Idempotency-Key every POST /api/brews of one new brew
// sends, and the POST whose answer never came (network error, timeout, 5xx). Autosave keeps both
// in the 'new' draft; /new hands a loaded draft's chain to the editor it mounts through
// CreateChainContext (useAutosave reads it once), so a create that did go through before the
// reload, crash or "New brew" is answered with its brew instead of making a second one.
import { createContext } from 'react';
import type { Draft } from './drafts';
import type { BrewContent } from './types';

export interface CreateChain {
  /** The Idempotency-Key. */
  key: string;
  /** What a POST with an unknown outcome sent: sent again, exactly, before anything newer. */
  pending: BrewContent | null;
  /** The docSchemaVersion that POST sent. */
  docSchemaVersion: number;
}

/** A new brew's chain from its stored draft, or null (no key: nothing was sent yet). */
export function createChainOf(draft: Draft | null | undefined): CreateChain | null {
  if (!draft || draft.editId !== null || !draft.createKey) return null;
  const pending = draft.pendingVersion == null && draft.pending ? draft.pending : null;
  return { key: draft.createKey, pending, docSchemaVersion: draft.docSchemaVersion };
}

/** The chain of the 'new' draft a page loaded (NewBrewSession); read by useAutosave for a new brew. */
export const CreateChainContext = createContext<CreateChain | null>(null);

/** A fresh Idempotency-Key (a UUID where the browser has one). */
export function newCreateKey(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
