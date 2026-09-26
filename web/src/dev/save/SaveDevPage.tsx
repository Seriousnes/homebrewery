// /dev/save[?edit=<editId>]: a real brew in EditorCanvas (with pagination) under useAutosave,
// with the save status, the conflict dialog, the "Restore unsaved changes" banner and local
// history. Without ?edit it is a new brew (/new flow): the first save POSTs and the URL takes
// the new editId without reloading the editor. Needs the API (HB_API_URL for Vite).
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { describeApiError, register, useBrewForEdit, useLogin, useLogout, useMe } from '@/api';
import { Button, Spinner, UiRoot } from '@/ui';
import { SaveDevEditor } from './SaveDevEditor';
import styles from './SaveDevPage.module.css';

const TEST_PASSWORD = 'Passw0rd!';

export function SaveDevPage() {
  const [params] = useSearchParams();
  // The brew to load is fixed for the page's life: later URL changes come from this editor
  // creating a brew (new brew, "Save mine as a copy"), which must not reload it.
  const [initialEditId] = useState(() => params.get('edit'));
  const brew = useBrewForEdit(initialEditId ?? undefined, { meta: { errorPolicy: 'manual' }, retry: false });

  let body;
  if (!initialEditId) body = <SaveDevEditor brew={null} />;
  else if (brew.data) body = <SaveDevEditor brew={brew.data} />;
  else if (brew.error)
    body = (
      <p className={styles.message} role="alert" data-testid="dev-save-error">
        Couldn't load {initialEditId}: {describeApiError(brew.error)}
      </p>
    );
  else body = <Spinner label="Loading the brew" />;

  return (
    <div className={styles.frame}>
      <UiRoot className={styles.chrome}>
        <header className={styles.bar}>
          <strong>/dev/save</strong>
          <Account />
        </header>
      </UiRoot>
      {body}
    </div>
  );
}

function Account() {
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const loginMutation = useLogin();
  const logoutMutation = useLogout();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createAccount = async () => {
    setBusy(true);
    setError(null);
    const email = `dev-save-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
    try {
      await register({ email, password: TEST_PASSWORD });
      await loginMutation.mutateAsync({ email, password: TEST_PASSWORD });
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={styles.account} data-testid="dev-account" data-user={me.data?.handle ?? ''}>
      {me.data ? `Signed in as ${me.data.handle}` : me.isLoading ? 'Checking sign-in…' : 'Signed out'}
      {me.data ? (
        <Button size="sm" variant="ghost" onClick={() => logoutMutation.mutate()}>
          Sign out
        </Button>
      ) : (
        <Button size="sm" onClick={() => void createAccount()} loading={busy}>
          Create a test account
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
