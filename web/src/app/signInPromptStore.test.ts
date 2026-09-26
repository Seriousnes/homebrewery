import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { closeSignInPrompt, openSignInPrompt, registerInlineSignIn, signInPromptStore } from './signInPromptStore';

afterEach(() => signInPromptStore.reset());

const unauthorized = () => ApiError.fromResponse(new Response(null, { status: 401 }), { title: 'Unauthorized' });

describe('sign-in prompt store', () => {
  it('opens once and keeps the first request', () => {
    const first = unauthorized();
    openSignInPrompt('api', first);
    openSignInPrompt('user', null);
    expect(signInPromptStore.get()).toMatchObject({ requested: true, reason: 'api', error: first });
    closeSignInPrompt();
    expect(signInPromptStore.get()).toMatchObject({ requested: false, error: null });
  });

  it('an inline sign-in form answers pending and later requests', () => {
    openSignInPrompt('api', unauthorized());
    const release = registerInlineSignIn();
    expect(signInPromptStore.get()).toMatchObject({ requested: false, inlineForms: 1 });
    openSignInPrompt('api', unauthorized());
    expect(signInPromptStore.get().requested).toBe(false);
    release();
    release(); // idempotent
    expect(signInPromptStore.get().inlineForms).toBe(0);
    openSignInPrompt('user');
    expect(signInPromptStore.get().requested).toBe(true);
  });

  it('notifies subscribers', () => {
    let calls = 0;
    const unsubscribe = signInPromptStore.subscribe(() => calls++);
    openSignInPrompt();
    closeSignInPrompt();
    closeSignInPrompt(); // no change, no notification
    unsubscribe();
    openSignInPrompt();
    expect(calls).toBe(2);
  });
});
