// Create an account, then sign in with it. A taken email also gets 200 from the API (no account
// enumeration, BS-5), so the sign-in that follows fails: the form then suggests signing in.
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { describeApiError, loginFailure, useLogin, useRegister } from '@/api';
import { paths } from '@/app/paths';
import { Button, TextField } from '@/ui';
import styles from './AuthForms.module.css';
import { PASSWORD_RULES, registerErrors } from './authErrors';
import { FormError } from './FormError';

export interface RegisterFormProps {
  /** The account was created (sign-in follows). */
  onRegistered?: () => void;
  /** Where the sign-in link in error messages returns to. */
  returnTo?: string | null;
  autoFocus?: boolean;
}

type Field = 'email' | 'password' | 'confirm';

export function RegisterForm({ onRegistered, returnTo, autoFocus = false }: RegisterFormProps) {
  const register = useRegister({ meta: { errorPolicy: 'manual' } });
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<{ message: ReactNode; attempt: number } | null>(null);
  const attempt = useRef(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const pending = register.isPending || login.isPending;

  const focusField = (field: Field | undefined) => {
    const ref = field === 'email' ? emailRef : field === 'password' ? passwordRef : field === 'confirm' ? confirmRef : null;
    if (ref) requestAnimationFrame(() => ref.current?.focus());
  };

  const fail = (message: ReactNode) => {
    attempt.current += 1;
    setFormError({ message, attempt: attempt.current });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = email.trim();
    const errors: Partial<Record<Field, string>> = {};
    if (!trimmed) errors.email = 'Enter your email address.';
    if (!password) errors.password = 'Choose a password.';
    if (!confirm) errors.confirm = 'Enter the password again.';
    else if (password && confirm !== password) errors.confirm = "The passwords don't match.";
    setFieldErrors(errors);
    setFormError(null);
    const firstInvalid = (['email', 'password', 'confirm'] as const).find((field) => errors[field]);
    if (firstInvalid) {
      focusField(firstInvalid);
      return;
    }

    register.mutate(
      { email: trimmed, password },
      {
        onSuccess: () => {
          onRegistered?.();
          login.mutate(
            { email: trimmed, password, remember: true },
            {
              onError: (error) => {
                if (loginFailure(error) === 'invalid') {
                  fail(
                    <>
                      Couldn&apos;t sign in with this email and password. If you already have an account,{' '}
                      <Link className={styles.link} to={paths.login(returnTo)}>
                        sign in
                      </Link>{' '}
                      instead.
                    </>,
                  );
                } else {
                  fail(`Your account was created, but signing in failed: ${describeApiError(error)}`);
                }
              },
            },
          );
        },
        onError: (error) => {
          const result = registerErrors(error);
          setFieldErrors({ email: result.email, password: result.password });
          if (result.form) fail(result.form);
          focusField(result.email ? 'email' : result.password ? 'password' : undefined);
        },
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-label="Create an account">
      <FormError key={formError?.attempt}>{formError?.message}</FormError>
      <TextField
        ref={emailRef}
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
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
        name="new-password"
        autoComplete="new-password"
        required
        hint={PASSWORD_RULES}
        value={password}
        error={fieldErrors.password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <TextField
        ref={confirmRef}
        label="Confirm password"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        value={confirm}
        error={fieldErrors.confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={pending}>
          Create account
        </Button>
      </div>
    </form>
  );
}
