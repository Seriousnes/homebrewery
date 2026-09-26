import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { describeApiError, isApiError, queryKeys, useLogout } from '@/api';
import { toast } from '@/ui';
import { clearRecentBrews } from './recentBrews';
import { notifySignedOut, runBeforeSignOut } from './signOutHooks';

export const SIGNED_OUT_TOAST_ID = 'account:signed-out';

/**
 * Sign out (navbar account menu, account page). Pending saves go first (signOutHooks.ts), then
 * POST /api/account/logout. A 401 means the session had already ended, which is the outcome the
 * user asked for, so it doesn't open the sign-in prompt. Other failures toast. Signing out also
 * forgets this browser's recent brews (the next person at a shared computer would see their
 * titles) and tells the pages (onSignedOut). The callbacks are the mutation's own, so they run
 * even when the caller unmounts because `me` became null. `onSignedOut` runs after that.
 */
export function useSignOut(onSignedOut?: () => void) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const started = useRef(false);

  const signedOut = () => {
    clearRecentBrews();
    toast({ id: SIGNED_OUT_TOAST_ID, title: "You're signed out.", tone: 'success' });
    notifySignedOut();
    onSignedOut?.();
  };

  const logout = useLogout({
    meta: { errorPolicy: 'manual' },
    onSuccess: signedOut,
    onError: (error) => {
      if (isApiError(error) && error.status === 401) {
        queryClient.setQueryData(queryKeys.account.me(), null);
        signedOut();
        return;
      }
      toast({ title: "Couldn't sign out", description: describeApiError(error), tone: 'error' });
    },
  });

  const signOut = () => {
    if (logout.isPending || started.current) return;
    started.current = true;
    setSaving(true);
    void runBeforeSignOut().finally(() => {
      started.current = false;
      setSaving(false);
      logout.mutate();
    });
  };

  return { signOut, pending: saving || logout.isPending };
}
