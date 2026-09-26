// `const { confirm, dialog } = useConfirmAction()`: render `dialog` once, call confirm(request)
// from a button. After a failed request the admin data is fetched again (the page may be stale:
// e.g. another admin unlocked the brew), and errors the central policy leaves to the caller
// (409, 400 with field errors) are toasted unless the request handles them itself.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useState } from 'react';
import { classifyApiError, describeApiError, isApiError, queryKeys } from '@/api';
import { toast } from '@/ui';
import { ConfirmActionDialog, type ConfirmRequest } from './ConfirmActionDialog';

export function useConfirmAction(): { confirm: (request: ConfirmRequest & { errorTitle?: string }) => void; dialog: ReactNode } {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ request: ConfirmRequest; open: boolean } | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest & { errorTitle?: string }) => {
      const onError = (error: unknown) => {
        if (request.onError) request.onError(error);
        else if (classifyApiError(error) === 'caller') {
          toast({ title: request.errorTitle ?? "Couldn't complete that", description: describeApiError(error), tone: 'error' });
        }
        // A rejected form (400) changed nothing; anything else may mean the page is out of date.
        if (!(isApiError(error) && error.status === 400)) void queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
      };
      setState({ request: { ...request, onError }, open: true });
    },
    [queryClient],
  );

  const dialog = state ? (
    <ConfirmActionDialog request={state.request} open={state.open} onClose={() => setState((old) => (old ? { ...old, open: false } : old))} />
  ) : null;
  return { confirm, dialog };
}
