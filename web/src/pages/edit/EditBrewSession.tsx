// /edit/:editId (plan §9): GET /api/brews/edit/{editId}, then the editor with autosave. A 401
// shows the sign-in form in place (the brew loads once signed in), 403 and 404 their error pages;
// a stored "unsaved changes" draft for this brew is offered above the canvas.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { type BrewForEdit, type DeleteBrewResponse, queryKeys, useBrewForEdit, useMe } from '@/api';
import { PageLoading } from '@/app/PageLoading';
import { paths } from '@/app/paths';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { appBrewFromEdit, baselineOf, docForEditor, isOpenableVersion } from '@/editor/EditorApp/editorAppModel';
import { ErrorPage } from '@/pages/errors';
import { toast } from '@/ui';
import { noteCreatedAfterLeaving } from './leftSession';
import { NewerVersionPage } from './NewerVersionPage';
import { useMountedRef } from './useMountedRef';

export interface EditBrewSessionProps {
  editId: string;
  sessionKey: string;
  /** Keep this session mounted for another editId (a copy made from the conflict dialog), which replaces `from`. */
  adopt: (sessionKey: string, editId: string, from?: string | null) => void;
}

export function EditBrewSession({ editId, sessionKey, adopt }: EditBrewSessionProps) {
  const query = useBrewForEdit(editId);
  // The brew as this session opened it. Once loaded, the editor stays: later refetch failures (a
  // session that expired) are autosave's to report, and after "Save mine as a copy" the
  // original's query is dropped while this session goes on with the copy.
  const [opened, setOpened] = useState<BrewForEdit | null>(null);
  if (opened === null && query.data) setOpened(query.data);
  const brew = opened ?? query.data;
  if (brew && !isOpenableVersion(brew.docSchemaVersion)) return <NewerVersionPage />;
  if (brew) return <LoadedEditor brew={brew} sessionKey={sessionKey} adopt={adopt} />;
  if (query.error) return <ErrorPage error={query.error} onRetry={() => void query.refetch()} />;
  return <PageLoading label="Loading the brew…" />;
}

function LoadedEditor({ brew, sessionKey, adopt }: { brew: BrewForEdit; sessionKey: string; adopt: EditBrewSessionProps['adopt'] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const mounted = useMountedRef();
  // Read once: the editor owns the document (the cached brew is patched after every save).
  const [initial] = useState(() => ({ content: docForEditor(brew.doc, brew.docSchemaVersion), brew: appBrewFromEdit(brew), baseline: baselineOf(brew) }));
  // The brew this editor holds now (a copy replaces it).
  const held = useRef(brew.editId);

  const onDeleted = (result: DeleteBrewResponse) => {
    toast({ title: result.brewDeleted ? 'Brew deleted' : 'You left the brew', tone: 'success' });
    const handle = me.data?.handle;
    void navigate(handle ? paths.user(handle) : paths.home, { replace: true });
  };

  return (
    <LazyEditorApp
      mode="edit"
      saving="server"
      content={initial.content}
      brew={initial.brew}
      baseline={initial.baseline}
      recent="edit"
      autoFocus
      heading={(title) => `Editing ${title}`}
      onCreated={(created, reason) => {
        // The user left before the copy landed: stay where they went.
        if (!mounted.current) {
          noteCreatedAfterLeaving(created, reason);
          return;
        }
        // "Save mine as a copy": the same editor now edits the copy. The original's URL gets an
        // editor of its own, which loads it again: the cached original predates the conflict.
        const from = held.current;
        held.current = created.editId;
        adopt(sessionKey, created.editId, from);
        queryClient.removeQueries({ queryKey: queryKeys.brews.edit(from), exact: true });
        void navigate(paths.edit(created.editId));
      }}
      onDeleted={onDeleted}
    />
  );
}
