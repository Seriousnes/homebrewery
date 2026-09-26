// Which stored 'new' draft /new loads (P7.2, SAVE-8, SAVE-12). Kept small: the route module
// imports it, so it must not pull in the editor (only drafts.ts types and the create signal).
import { isOpenableVersion } from '@/editor/EditorApp/editorAppModel';
import { draftOwnedBy, type Draft } from '@/editor/save/drafts';
import { createdFromDraft, pendingNewBrewCreates, type NewBrewCreate } from '@/editor/save/newBrewCreates';

/** How long /new waits for an earlier session's create (its request times out after 60 s). */
export const CREATE_WAIT_MS = 65_000;

/**
 * Why a stored draft is or isn't loaded: 'none' (no draft), 'loaded', 'discarded' (written before
 * "Start over"), 'newer' (a newer editor's), 'created' (this tab turned it into a brew),
 * 'otherUser' (another user's: withheld until its owner signs in here).
 */
export type NewDraftReason = 'none' | 'loaded' | 'discarded' | 'newer' | 'created' | 'otherUser';

export interface NewDraftChoice {
  /** The draft to load, or null. */
  draft: Draft | null;
  /** Another user's draft, kept back: loaded if its owner signs in before anything is typed. */
  withheld: Draft | null;
  reason: NewDraftReason;
}

export interface NewDraftContext {
  /** "Start over" time (NewPageState.hbDraftDiscardedAt), or null. */
  discardedAt: number | null;
  /** The signed-in user's id, or null. */
  userId: string | null;
  /** Default: the create signal (createdFromDraft). */
  createdFrom?: (draft: Draft) => NewBrewCreate | null;
}

export function chooseNewDraft(
  draft: Draft | null,
  { discardedAt, userId, createdFrom = createdFromDraft }: NewDraftContext,
): NewDraftChoice {
  const skip = (reason: NewDraftReason): NewDraftChoice => ({ draft: null, withheld: null, reason });
  if (!draft) return skip('none');
  // After "Start over", a write that raced the discard is not the author's draft.
  if (discardedAt !== null && draft.updatedAt <= discardedAt) return skip('discarded');
  if (!isOpenableVersion(draft.docSchemaVersion)) return skip('newer');
  // An earlier /new session in this tab created a brew from it (e.g. its unmount save after "New
  // brew"): loading it again would make a second brew.
  if (createdFrom(draft)) return skip('created');
  if (!draftOwnedBy(draft, userId)) return { draft: null, withheld: draft, reason: 'otherUser' };
  return { draft, withheld: null, reason: 'loaded' };
}

/**
 * Waits until the creates of new brews running in this tab have answered (at most `timeoutMs`).
 * Returns whether there were any.
 */
export async function waitForRunningCreates(timeoutMs = CREATE_WAIT_MS): Promise<boolean> {
  const running = pendingNewBrewCreates();
  if (!running.length) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(running.map((create) => create.settled)), timeout]);
  clearTimeout(timer);
  return true;
}
