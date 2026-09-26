import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { handleErrorMessage, readWelcomeState } from './accountState';

const problem = (status: number, body: Record<string, unknown> = {}) => ApiError.fromResponse(new Response(null, { status }), { status, ...body });

describe('handleErrorMessage', () => {
  it('shows the API validation message on the field', () => {
    const rules = "A handle is 3 to 32 characters: lower-case letters a-z, digits, '-' and '_'.";
    expect(handleErrorMessage(problem(400, { errors: { handle: [rules] } }))).toBe(rules);
  });

  it('shows the 409 detail', () => {
    expect(handleErrorMessage(problem(409, { title: 'Handle taken', detail: "The handle 'bob' is already in use." }))).toBe(
      "The handle 'bob' is already in use.",
    );
    expect(handleErrorMessage(problem(409, { title: 'Handle taken' }))).toMatch(/already taken/);
  });

  it('leaves 401, network and server errors to the error policy', () => {
    expect(handleErrorMessage(problem(401))).toBeNull();
    expect(handleErrorMessage(problem(500))).toBeNull();
    expect(handleErrorMessage(ApiError.network(new TypeError('x')))).toBeNull();
    expect(handleErrorMessage(new Error('x'))).toBeNull();
  });
});

describe('readWelcomeState', () => {
  it('accepts the state /register passes, with a safe returnTo', () => {
    expect(readWelcomeState({ welcome: true, returnTo: '/edit/abc' })).toEqual({ welcome: true, returnTo: '/edit/abc' });
    expect(readWelcomeState({ welcome: true, returnTo: 'https://evil.example' })).toEqual({ welcome: true, returnTo: null });
    expect(readWelcomeState({ welcome: true })).toEqual({ welcome: true, returnTo: null });
    expect(readWelcomeState(null)).toBeNull();
    expect(readWelcomeState({ welcome: 'yes' })).toBeNull();
  });
});
