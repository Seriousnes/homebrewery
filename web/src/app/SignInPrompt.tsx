// The sign-in dialog (plan §9: "401 shows a sign-in prompt"). Mounted once at the router root, it
// listens to the API layer's onSignInRequired (every 401 raises it) and to openSignInPrompt().
// It stays closed on /login and /register, and while an inline sign-in form is on the page (the
// 401 page renders one). It opens after a short delay so that a page whose load just failed with
// 401 can put its inline form up first, instead of a dialog flashing over it.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { onSignInRequired } from '@/api';
import { LoginForm } from '@/pages/auth/LoginForm';
import { Dialog, toast } from '@/ui';
import styles from './SignInPrompt.module.css';
import { isAuthPath, locationPath, paths } from './paths';
import { closeSignInPrompt, openSignInPrompt, SIGN_IN_PROMPT_DELAY_MS, useSignInPrompt } from './signInPromptStore';

export function SignInPrompt() {
  const prompt = useSignInPrompt();
  const location = useLocation();

  useEffect(
    () =>
      onSignInRequired(({ error }) => {
        // The sign-in pages are the prompt themselves.
        if (isAuthPath(window.location.pathname)) return;
        // A failed request ('api': the session may have ended), or a "Sign in" button ('user').
        openSignInPrompt(error ? 'api' : 'user', error);
      }),
    [],
  );

  const wanted = prompt.requested && prompt.inlineForms === 0 && !isAuthPath(location.pathname);
  const [shown, setShown] = useState(false);
  if (!wanted && shown) setShown(false);
  useEffect(() => {
    if (!wanted) return;
    const timer = window.setTimeout(() => setShown(true), SIGN_IN_PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [wanted]);

  const open = wanted && shown;
  const description =
    prompt.reason === 'api'
      ? 'You need to be signed in to do that. Your session may have ended.'
      : 'Sign in to your Homebrewery account.';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSignInPrompt();
      }}
      title="Sign in"
      description={description}
      size="sm"
      data-testid="sign-in-prompt"
    >
      <LoginForm
        onSuccess={(account) => {
          closeSignInPrompt();
          toast({ title: account ? `Signed in as ${account.handle}.` : "You're signed in.", tone: 'success' });
        }}
      />
      <p className={styles.footer}>
        No account yet?{' '}
        <Link className={styles.link} to={paths.register(locationPath(location))} onClick={() => closeSignInPrompt()}>
          Create one
        </Link>
      </p>
    </Dialog>
  );
}
