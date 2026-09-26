// The editor route (plan §9): one layout route for /new and /edit/:editId (web/src/app/routes.tsx),
// so the editor stays mounted when a new brew's first save moves the URL to /edit/:editId.
// editorSession.ts decides which URLs share an editor.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { queryKeys } from '@/api';
import { onSignedOut } from '@/app/signOutHooks';
import { NewBrewSession } from '@/pages/new/NewBrewSession';
import { adoptSession, editorSessionKey, NO_SESSIONS } from './editorSession';
import { EditBrewSession } from './EditBrewSession';

export default function EditorRoute() {
  const { editId } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState(NO_SESSIONS);
  // Bumped by a deliberate sign-out: every session mounts again, as the signed-out visitor.
  const [signOuts, setSignOuts] = useState(0);
  const key = editorSessionKey(sessions, editId, location.key);
  const adopt = useCallback(
    (sessionKey: string, id: string, from: string | null = null) => setSessions((s) => adoptSession(s, sessionKey, id, from)),
    [],
  );

  // Signing out closes the open brew (pending changes were saved first; see signOutHooks.ts):
  // /edit/:editId then shows the sign-in form, and the brew and its local history leave the page.
  // A session that merely expired (a 401 while saving) keeps the editor for "Sign in to save".
  useEffect(
    () =>
      onSignedOut(() => {
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === queryKeys.brews.all[0] && query.queryKey[1] === 'edit' });
        setSessions(NO_SESSIONS);
        setSignOuts((n) => n + 1);
      }),
    [queryClient],
  );

  return <BrewSession key={`${signOuts}/${key}`} sessionKey={key} editId={editId ?? null} adopt={adopt} />;
}

interface BrewSessionProps {
  sessionKey: string;
  editId: string | null;
  adopt: (sessionKey: string, editId: string, from?: string | null) => void;
}

/** A session is a new brew or a loaded one for its whole life, whatever the URL says later. */
function BrewSession({ sessionKey, editId, adopt }: BrewSessionProps) {
  const [initialEditId] = useState(editId);
  return initialEditId === null ? (
    <NewBrewSession sessionKey={sessionKey} adopt={adopt} />
  ) : (
    <EditBrewSession editId={initialEditId} sessionKey={sessionKey} adopt={adopt} />
  );
}
