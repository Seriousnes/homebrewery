// The sign-in form: the /login page, the "Sign in required" page and the sign-in dialog.
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { type AccountInfo, accountQueries, queryKeys, useLogin } from '@/api';
import { Button, Checkbox, TextField } from '@/ui';
import styles from './AuthForms.module.css';
import { loginError } from './authErrors';
import { FormError } from './FormError';

export interface LoginFormProps {
  /** Runs after sign-in, once `me` has been refetched. */
  onSuccess?: (account: AccountInfo | null) => void;
  /** Focus the email field on mount (pages; the dialog focuses its first field itself). */
  autoFocus?: boolean;
  defaultEmail?: string;
  submitLabel?: string;
  'data-testid'?: string;
}

export function LoginForm({ onSuccess, autoFocus = false, defaultEmail = '', submitLabel = 'Sign in', 'data-testid': testId }: LoginFormProps) {
  const queryClient = useQueryClient();
  const login = useLogin();
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState('');
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; code?: string }>({});
  const [formError, setFormError] = useState<{ message: string; attempt: number } | null>(null);
  const attempt = useRef(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const focusField = (field: 'email' | 'password' | 'code' | null) => {
    // After React has rendered the field (the 2FA field may be new).
    requestAnimationFrame(() => {
      const el = field === 'email' ? emailRef.current : field === 'password' ? passwordRef.current : field === 'code' ? codeRef.current : null;
      el?.focus();
      if (field === 'password' || field === 'code') el?.select();
    });
  };

  // useLogin refetches `me` when something shows it; otherwise it is only marked stale.
  const signedInAccount = async (): Promise<AccountInfo | null> => {
    const key = queryKeys.account.me();
    if (queryClient.getQueryState(key)?.isInvalidated === false) return queryClient.getQueryData<AccountInfo | null>(key) ?? null;
    return queryClient.fetchQuery(accountQueries.me()).catch(() => null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;
    const trimmed = email.trim();
    const errors: typeof fieldErrors = {};
    if (!trimmed) errors.email = 'Enter your email address.';
    if (!password) errors.password = 'Enter your password.';
    if (needsTwoFactor && !code.trim()) errors.code = 'Enter the code from your authenticator app.';
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email || errors.password || errors.code) {
      focusField(errors.email ? 'email' : errors.password ? 'password' : 'code');
      return;
    }
    const codeSent = needsTwoFactor && code.trim() !== '';
    login.mutate(
      { email: trimmed, password, remember, ...(codeSent ? { twoFactorCode: code.trim() } : {}) },
      {
        onSuccess: () => {
          setPassword('');
          setCode('');
          if (onSuccess) void signedInAccount().then(onSuccess);
        },
        onError: (error) => {
          const result = loginError(error, codeSent);
          attempt.current += 1;
          if (result.needsTwoFactor) setNeedsTwoFactor(true);
          setFormError(result.message ? { message: result.message, attempt: attempt.current } : null);
          focusField(result.focus);
        },
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate data-testid={testId} aria-label="Sign in">
      <FormError key={formError?.attempt}>{formError?.message}</FormError>
      <TextField
        ref={emailRef}
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        required
        autoFocus={autoFocus}
        value={email}
        error={fieldErrors.email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <TextField
        ref={passwordRef}
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        error={fieldErrors.password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {needsTwoFactor ? (
        <TextField
          ref={codeRef}
          label="Authentication code"
          hint="The 6-digit code from your authenticator app."
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          error={fieldErrors.code}
          onChange={(event) => setCode(event.target.value)}
        />
      ) : null}
      <Checkbox label="Keep me signed in" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={login.isPending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
