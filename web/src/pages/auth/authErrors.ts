// Messages for the sign-in and registration forms (ASP.NET Identity's MapIdentityApi answers).
import { describeApiError, isApiError, type LoginFailure, loginFailure } from '@/api';

export const PASSWORD_RULES =
  'At least 6 characters, with an upper-case letter, a lower-case letter, a digit and a symbol.';

export interface LoginErrorResult {
  /** The message for the form ('' when the form only needs the 2FA code field). */
  message: string;
  /** Which field to focus. */
  focus: 'email' | 'password' | 'code' | null;
  /** The account needs a two-factor code. */
  needsTwoFactor: boolean;
}

/** What the login form shows for a failed sign-in. `codeSent`: a 2FA code was part of the attempt. */
export function loginError(error: unknown, codeSent: boolean): LoginErrorResult {
  const failure: LoginFailure | null = loginFailure(error);
  switch (failure) {
    case 'invalid':
      return codeSent
        ? { message: 'The code is not correct. Try again.', focus: 'code', needsTwoFactor: true }
        : { message: 'The email or password is not correct.', focus: 'password', needsTwoFactor: false };
    case 'lockedOut':
      return {
        message: 'Too many failed attempts. This account is locked for a few minutes; try again later.',
        focus: null,
        needsTwoFactor: false,
      };
    case 'notAllowed':
      return {
        message: "This account can't sign in yet. Confirm your email address first.",
        focus: null,
        needsTwoFactor: false,
      };
    case 'requiresTwoFactor':
      return {
        message: codeSent ? 'The code is not correct. Try again.' : '',
        focus: 'code',
        needsTwoFactor: true,
      };
    default:
      return { message: describeApiError(error), focus: null, needsTwoFactor: false };
  }
}

export interface ChangePasswordErrors {
  currentPassword?: string;
  newPassword?: string;
  form?: string;
}

/**
 * Field messages from a failed password change (Identity's ValidationProblem keys are error
 * codes: PasswordMismatch and OldPasswordRequired are about the current password, the other
 * Password* codes about the new one).
 */
export function changePasswordErrors(error: unknown): ChangePasswordErrors {
  if (!isApiError(error) || !error.hasFieldErrors) return { form: describeApiError(error) };
  const current: string[] = [];
  const next: string[] = [];
  const form: string[] = [];
  for (const [key, messages] of Object.entries(error.errors)) {
    const k = key.toLowerCase();
    if (k === 'passwordmismatch') current.push('The current password is not correct.');
    else if (k === 'oldpasswordrequired' || k === 'oldpassword') current.push('Enter your current password.');
    else if (k.includes('password')) next.push(...messages);
    else form.push(...messages);
  }
  const join = (list: string[]) => (list.length > 0 ? [...new Set(list)].join(' ') : undefined);
  const result: ChangePasswordErrors = {};
  const c = join(current);
  const n = join(next);
  const f = join(form);
  if (c) result.currentPassword = c;
  if (n) result.newPassword = n;
  if (f) result.form = f;
  if (!c && !n && !f) result.form = describeApiError(error);
  return result;
}

export interface RegisterErrors {
  email?: string;
  password?: string;
  form?: string;
}

/**
 * Field messages from a failed registration. Identity's ValidationProblem keys are error codes
 * (PasswordTooShort, PasswordRequiresDigit, InvalidEmail, DuplicateUserName, …); model binding
 * uses property names.
 */
export function registerErrors(error: unknown): RegisterErrors {
  if (!isApiError(error) || !error.hasFieldErrors) return { form: describeApiError(error) };
  const email: string[] = [];
  const password: string[] = [];
  const form: string[] = [];
  for (const [key, messages] of Object.entries(error.errors)) {
    const k = key.toLowerCase();
    const target = k.includes('password') ? password : k.includes('email') || k.includes('username') ? email : form;
    target.push(...messages);
  }
  const join = (list: string[]) => (list.length > 0 ? [...new Set(list)].join(' ') : undefined);
  const result: RegisterErrors = {};
  const e = join(email);
  const p = join(password);
  const f = join(form);
  if (e) result.email = e;
  if (p) result.password = p;
  if (f) result.form = f;
  if (!e && !p && !f) result.form = describeApiError(error);
  return result;
}
