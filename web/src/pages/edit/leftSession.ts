// A brew created by an editor session the user has already left: the unmount save of a /new brew
// (or a copy that landed after the user went elsewhere). The page stays where the user went; the
// brew goes into Recent brews and a toast says it was saved.
import type { BrewForEdit } from '@/api';
import { recordRecentBrew } from '@/app/recentBrews';
import { displayTitle } from '@/editor/EditorApp/editorAppModel';
import { toast } from '@/ui';

export function noteCreatedAfterLeaving(brew: BrewForEdit, reason: 'new' | 'copy'): void {
  const title = displayTitle(brew.meta.title);
  recordRecentBrew('edit', { id: brew.editId, title });
  toast({
    id: `created-after-leaving:${brew.editId}`,
    title: reason === 'new' ? 'Your new brew was saved' : 'Your copy was saved',
    description: `“${title}” is in Recent brews.`,
    tone: 'success',
  });
}
