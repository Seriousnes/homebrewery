import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { loginError, registerErrors } from './authErrors';

const problem = (status: number, body: Record<string, unknown>) => ApiError.fromResponse(new Response(null, { status }), { status, ...body });

describe('loginError', () => {
  it('maps Identity 401 details', () => {
    expect(loginError(problem(401, { detail: 'Failed' }), false)).toEqual({
      message: 'The email or password is not correct.',
      focus: 'password',
      needsTwoFactor: false,
    });
    expect(loginError(problem(401, { detail: 'LockedOut' }), false).message).toMatch(/locked/);
    expect(loginError(problem(401, { detail: 'NotAllowed' }), false).message).toMatch(/Confirm your email/);
  });

  it('asks for a two-factor code, then reports a wrong one', () => {
    expect(loginError(problem(401, { detail: 'RequiresTwoFactor' }), false)).toEqual({ message: '', focus: 'code', needsTwoFactor: true });
    expect(loginError(problem(401, { detail: 'Failed' }), true)).toEqual({
      message: 'The code is not correct. Try again.',
      focus: 'code',
      needsTwoFactor: true,
    });
  });

  it('describes other failures', () => {
    expect(loginError(ApiError.network(new TypeError('x')), false)).toMatchObject({ focus: null, needsTwoFactor: false });
    expect(loginError(problem(429, { title: 'Too many requests' }), false).message).toMatch(/Too many requests/);
  });
});

describe('registerErrors', () => {
  it('puts Identity error codes on the right fields', () => {
    const error = problem(400, {
      title: 'One or more validation errors occurred.',
      errors: {
        PasswordTooShort: ['Passwords must be at least 6 characters.'],
        PasswordRequiresDigit: ["Passwords must have at least one digit ('0'-'9')."],
        InvalidEmail: ["Email 'x' is invalid."],
        InvalidUserName: ["Username 'x' is invalid."],
        Other: ['Something else.'],
      },
    });
    expect(registerErrors(error)).toEqual({
      email: "Email 'x' is invalid. Username 'x' is invalid.",
      password: "Passwords must be at least 6 characters. Passwords must have at least one digit ('0'-'9').",
      form: 'Something else.',
    });
  });

  it('falls back to a form message', () => {
    expect(registerErrors(problem(500, { title: 'Server error' }))).toEqual({ form: 'The server had a problem. Try again.' });
    expect(registerErrors(ApiError.network(new TypeError('x'))).form).toBeTruthy();
  });
});
