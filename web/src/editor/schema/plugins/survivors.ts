// Which nodes of the new document were already in the old one: used where a copy (paste) and its
// original share an id (heading custom ids, page pids) and the original must keep it.
import type { Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';

/** Whether the node at `pos` of the new document is the one that had `id` before the change. */
export type Survives = (pos: number, id: string) => boolean;

/**
 * `before()` (old position → id) mapped through `transactions`: true for a new position that an
 * old node with the same id maps to. Content inserted right before a node maps it past the
 * insertion (assoc 1), so a copy pasted in front of its original doesn't take the original's
 * place. A deleted node maps next to where it was; the id found there decides. Computed on the
 * first call only (callers ask only when two nodes share an id).
 */
export function survivors(transactions: readonly Transaction[], before: () => Map<number, string>): Survives {
  let after: Map<number, string> | null = null;
  return (pos, id) => {
    if (!after) {
      const mapping = new Mapping();
      for (const tr of transactions) mapping.appendMapping(tr.mapping);
      after = new Map();
      for (const [old, oldId] of before()) after.set(mapping.map(old, 1), oldId);
    }
    return after.get(pos) === id;
  };
}
