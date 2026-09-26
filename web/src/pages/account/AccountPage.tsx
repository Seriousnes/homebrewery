// /account (port of legacy client/homebrew/pages/accountPage): the signed-in account, its public
// handle (changed here; the API validates it and its messages show on the field), links to the
// user's brews and the admin pages, the password (changed here: Identity's manage/info), and
// "Sign out". Upstream's Google Drive and save-location
// settings have no counterpart.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type AccountInfo, useChangePassword, useSetHandle, useUserBrews } from '@/api';
import { paths } from '@/app/paths';
import { RequireAuth } from '@/app/RequireAuth';
import { ADMIN_ROLE, hasRole } from '@/app/roles';
import { SitePage } from '@/app/SitePage';
import { useSignOut } from '@/app/useSignOut';
import { changePasswordErrors, PASSWORD_RULES } from '@/pages/auth/authErrors';
import { FormError } from '@/pages/auth/FormError';
import { Button, Icon, TextField } from '@/ui';
import styles from './AccountPage.module.css';
import { HANDLE_RULES, handleErrorMessage, readWelcomeState } from './accountState';

export default function AccountPage() {
  // Here, not in AccountDetails: the details unmount when `me` becomes null on sign-out.
  const { signOut, pending } = useSignOut();
  return (
    <RequireAuth>
      {(account) => <AccountDetails account={account} onSignOut={signOut} signingOut={pending} />}
    </RequireAuth>
  );
}

interface AccountDetailsProps {
  account: AccountInfo;
  onSignOut: () => void;
  signingOut: boolean;
}

function AccountDetails({ account, onSignOut, signingOut }: AccountDetailsProps) {
  const location = useLocation();
  const welcome = readWelcomeState(location.state);
  const isAdmin = hasRole(account, ADMIN_ROLE);
  // Upstream showed the brew count; the list is shared with the user page's query. Silent on failure.
  const brews = useUserBrews(account.handle, { meta: { errorPolicy: 'manual' } });
  const profileId = useId();
  const passwordId = useId();
  const sessionId = useId();

  return (
    <SitePage title="Account" data-testid="account-page">
      {welcome ? (
        <div className={styles.welcome} data-testid="account-welcome">
          <Icon name="success" size={18} />
          <div>
            <p className={styles.welcomeTitle}>Your account is ready.</p>
            <p className={styles.welcomeText}>
              Your public handle was made from your email address. Choose another one below if you&apos;d rather not show it.
              {welcome.returnTo ? (
                <>
                  {' '}
                  <Link className={styles.link} to={welcome.returnTo}>
                    Continue where you were
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        </div>
      ) : null}

      <section className={styles.card} aria-labelledby={profileId}>
        <h2 id={profileId} className={styles.cardTitle}>
          Profile
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>Email</dt>
            <dd data-testid="account-email">{account.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Handle</dt>
            <dd data-testid="account-handle">{account.handle}</dd>
          </div>
          <div>
            <dt>Brews</dt>
            <dd data-testid="account-brew-count">{brews.data ? brews.data.total : brews.isError ? 'Unavailable' : '…'}</dd>
          </div>
          {account.roles.length > 0 ? (
            <div>
              <dt>Roles</dt>
              <dd>{account.roles.join(', ')}</dd>
            </div>
          ) : null}
        </dl>
        <HandleForm account={account} />
        <ul className={styles.links}>
          <li>
            <Link className={styles.link} to={paths.user(account.handle)}>
              Your brews
            </Link>
          </li>
          {isAdmin ? (
            <li>
              <Link className={styles.link} to={paths.admin}>
                Admin pages
              </Link>
            </li>
          ) : null}
        </ul>
      </section>

      <section className={styles.card} aria-labelledby={passwordId}>
        <h2 id={passwordId} className={styles.cardTitle}>
          Password
        </h2>
        <PasswordForm email={account.email ?? null} />
      </section>

      <section className={styles.card} aria-labelledby={sessionId}>
        <h2 id={sessionId} className={styles.cardTitle}>
          Session
        </h2>
        <p className={styles.cardText}>Signing out ends your session in this browser. Unsaved drafts stay on this device.</p>
        <Button onClick={onSignOut} loading={signingOut} data-testid="account-sign-out">
          Sign out
        </Button>
      </section>
    </SitePage>
  );
}

function HandleForm({ account }: { account: AccountInfo }) {
  const setHandle = useSetHandle();
  const [value, setValue] = useState(account.handle);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (setHandle.isPending) return;
    const next = value.trim();
    setStatus('');
    if (!next) {
      setError('Enter a handle.');
      inputRef.current?.focus();
      return;
    }
    if (next.toLowerCase() === account.handle) {
      setError(null);
      setValue(account.handle);
      setStatus(`Your handle is already ${account.handle}.`);
      return;
    }
    setError(null);
    setHandle.mutate(next, {
      onSuccess: (updated) => {
        setValue(updated.handle);
        setStatus(`Your handle is now ${updated.handle}. Your brews are listed at ${paths.user(updated.handle)}.`);
      },
      onError: (failure) => {
        const message = handleErrorMessage(failure);
        if (message) {
          setError(message);
          inputRef.current?.focus();
        }
      },
    });
  };

  return (
    <form className={styles.handleForm} onSubmit={submit} noValidate aria-label="Change your handle">
      <TextField
        ref={inputRef}
        label="Public handle"
        name="handle"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        hint={`Shown on your brews and in your page's address (/user/<handle>). ${HANDLE_RULES}`}
        value={value}
        error={error ?? undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setStatus('');
        }}
        data-testid="handle-input"
      />
      <div className={styles.handleActions}>
        <Button type="submit" variant="primary" loading={setHandle.isPending} data-testid="handle-save">
          Save handle
        </Button>
        <p role="status" className={styles.status} data-testid="handle-status">
          {status}
        </p>
      </div>
    </form>
  );
}

type PasswordField = 'current' | 'next' | 'confirm';

function PasswordForm({ email }: { email: string | null }) {
  const change = useChangePassword(email);
  const [values, setValues] = useState<Record<PasswordField, string>>({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<PasswordField, string>>>({});
  const [formError, setFormError] = useState<{ message: string; attempt: number } | null>(null);
  const [status, setStatus] = useState('');
  const attempt = useRef(0);
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const focus = (field: PasswordField | undefined) => {
    if (field) requestAnimationFrame(() => refs[field].current?.focus());
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (change.isPending) return;
    const found: Partial<Record<PasswordField, string>> = {};
    if (!values.current) found.current = 'Enter your current password.';
    if (!values.next) found.next = 'Choose a new password.';
    if (!values.confirm) found.confirm = 'Enter the new password again.';
    else if (values.next && values.confirm !== values.next) found.confirm = "The passwords don't match.";
    setErrors(found);
    setFormError(null);
    setStatus('');
    const firstInvalid = (['current', 'next', 'confirm'] as const).find((field) => found[field]);
    if (firstInvalid) {
      focus(firstInvalid);
      return;
    }
    change.mutate(
      { oldPassword: values.current, newPassword: values.next },
      {
        onSuccess: () => {
          setValues({ current: '', next: '', confirm: '' });
          setStatus('Your password was changed.');
        },
        onError: (failure) => {
          const result = changePasswordErrors(failure);
          setErrors({ current: result.currentPassword, next: result.newPassword });
          if (result.form) {
            attempt.current += 1;
            setFormError({ message: result.form, attempt: attempt.current });
          }
          focus(result.currentPassword ? 'current' : result.newPassword ? 'next' : undefined);
        },
      },
    );
  };

  const field = (name: PasswordField, label: string, autoComplete: string, hint?: string) => (
    <TextField
      ref={refs[name]}
      label={label}
      type="password"
      name={name === 'current' ? 'current-password' : name === 'next' ? 'new-password' : 'confirm-password'}
      autoComplete={autoComplete}
      required
      hint={hint}
      value={values[name]}
      error={errors[name]}
      onChange={(event) => {
        const value = event.target.value;
        setValues((old) => ({ ...old, [name]: value }));
        setStatus('');
      }}
    />
  );

  return (
    <form className={styles.handleForm} onSubmit={submit} noValidate aria-label="Change your password">
      <FormError key={formError?.attempt}>{formError?.message}</FormError>
      {field('current', 'Current password', 'current-password')}
      {field('next', 'New password', 'new-password', PASSWORD_RULES)}
      {field('confirm', 'Confirm new password', 'new-password')}
      <div className={styles.handleActions}>
        <Button type="submit" variant="primary" loading={change.isPending} data-testid="password-save">
          Change password
        </Button>
        <p role="status" className={styles.status} data-testid="password-status">
          {status}
        </p>
      </div>
    </form>
  );
}
