// The editor route (plan §9): one layout route for /new, /edit/:editId and /local/:localId
// (web/src/app/routes.tsx), so the editor stays mounted when a new brew's first save moves the URL
// to /edit/:editId (signed in) or /local/:localId (signed out, issue #4). editorSession.ts decides
// which URLs share an editor.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { queryKeys } from '@/api';
import { onSignedOut } from '@/app/signOutHooks';
import { LocalBrewSession } from '@/pages/local/LocalBrewSession';
import { NewBrewSession } from '@/pages/new/NewBrewSession';
import { adoptSession, editorSessionKey, NO_SESSIONS } from './editorSession';
import { EditBrewSession } from './EditBrewSession';

export default function EditorRoute() {
  const { editId, localId } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState(NO_SESSIONS);
  // Bumped by a deliberate sign-out: every session mounts again, as the signed-out visitor.
  const [signOuts, setSignOuts] = useState(0);
  const key = editorSessionKey(sessions, editId, location.key, localId);
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

  return <BrewSession key={`${signOuts}/${key}`} sessionKey={key} editId={editId ?? null} localId={localId ?? null} adopt={adopt} />;
}

interface BrewSessionProps {
  sessionKey: string;
  editId: string | null;
  localId: string | null;
  adopt: (sessionKey: string, editId: string, from?: string | null) => void;
}

/** A session is a new brew, a local one or a loaded one for its whole life, whatever the URL says later. */
function BrewSession({ sessionKey, editId, localId, adopt }: BrewSessionProps) {
  const [initial] = useState({ editId, localId });
  if (initial.localId !== null) return <LocalBrewSession localId={initial.localId} />;
  return initial.editId === null ? (
    <NewBrewSession sessionKey={sessionKey} adopt={adopt} />
  ) : (
    <EditBrewSession editId={initial.editId} sessionKey={sessionKey} adopt={adopt} />
  );
}
