// After signing in (or creating an account) in this tab, a user with brews on this device is asked
// once what to do with them (issue #4): upload them all, review them on /local, or later. Nothing
// is uploaded without that choice. A page loaded already signed in is not asked; /local and the
// editor's "Upload" stay available at any time.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, queryKeys, requestSignIn, useMe } from '@/api';
import { defaultLocalBrews } from '@/editor/local/localBrews';
import { uploadLocalBrews } from '@/editor/local/upload';
import { Button, Dialog, toast } from '@/ui';
import { paths } from './paths';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function LocalBrewsSignInPrompt() {
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = me.isSuccess ? (me.data?.id ?? null) : undefined;
  // undefined: not known yet; null: signed out.
  const previous = useRef<string | null | undefined>(undefined);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const before = previous.current;
    previous.current = userId;
    if (before !== null || !userId) return; // only a sign-in seen in this tab
    let cancelled = false;
    void defaultLocalBrews()
      .count()
      .catch(() => 0)
      .then((n) => {
        if (cancelled || n === 0) return;
        setCount(n);
        setOpen(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const uploadAll = async () => {
    setUploading(true);
    try {
      let ids: string[];
      try {
        ids = (await defaultLocalBrews().list()).map((b) => b.id);
      } catch (error) {
        // The brews stay where they are; the dialog stays open to try again.
        toast({
          title: 'Couldn’t read the brews on this device',
          description: `${error instanceof Error ? error.message : String(error)} Nothing was uploaded; try again.`,
          tone: 'error',
        });
        return;
      }
      const result = await uploadLocalBrews(ids);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      setOpen(false);
      const signedOut = result.failed.find((f) => f.error instanceof ApiError && f.error.status === 401);
      if (signedOut) requestSignIn(signedOut.error as ApiError);
      if (result.failed.length === 0) {
        toast({ title: `Uploaded ${plural(result.uploaded.length, 'brew', 'brews')}`, description: 'They are in your account now.', tone: 'success' });
      } else {
        toast({
          title: `Uploaded ${result.uploaded.length} of ${result.uploaded.length + result.failed.length}`,
          description: 'The others are still on this device.',
          tone: 'warning',
          action: { label: 'Review', onAction: () => void navigate(paths.local) },
        });
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!uploading) setOpen(next);
      }}
      title={`You have ${plural(count, 'brew', 'brews')} on this device`}
      description="Made while you were signed out, they are only in this browser. Upload them to keep them in your account; you can also do it later from Brews on this device."
      data-testid="local-brews-prompt"
      footer={
        <>
          <Button variant="ghost" disabled={uploading} onClick={() => setOpen(false)} data-testid="local-prompt-later">
            Later
          </Button>
          <Button
            variant="secondary"
            disabled={uploading}
            onClick={() => {
              setOpen(false);
              void navigate(paths.local);
            }}
            data-testid="local-prompt-review"
          >
            Review
          </Button>
          <Button variant="primary" icon="upload" loading={uploading} onClick={() => void uploadAll()} data-testid="local-prompt-upload-all">
            Upload all
          </Button>
        </>
      }
    />
  );
}
