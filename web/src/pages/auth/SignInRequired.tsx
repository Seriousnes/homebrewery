// The 401 page: a page that needs an account (RequireAuth) or an API load that answered 401. The
// sign-in form is right on the page; while it is shown the sign-in dialog stays closed.
import { type ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { locationPath, paths } from '@/app/paths';
import { registerInlineSignIn } from '@/app/signInPromptStore';
import { SitePage } from '@/app/SitePage';
import styles from './AuthForms.module.css';
import { LoginForm } from './LoginForm';

export interface SignInRequiredProps {
  title?: string;
  message?: ReactNode;
}

export function SignInRequired({ title = 'Sign in required', message }: SignInRequiredProps) {
  const location = useLocation();
  useEffect(() => registerInlineSignIn(), []);
  return (
    <SitePage title={title} width="narrow" lead={message ?? 'You need to sign in to see this page.'} data-testid="sign-in-required">
      <div className={styles.card}>
        <LoginForm data-testid="inline-sign-in" />
      </div>
      <p className={styles.footer}>
        No account yet?{' '}
        <Link className={styles.link} to={paths.register(locationPath(location))}>
          Create one
        </Link>
      </p>
    </SitePage>
  );
}
