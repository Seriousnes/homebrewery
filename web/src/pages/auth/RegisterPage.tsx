// /register. A new account is signed in right away and sent to /account to pick its public
// handle (the default one is made from the email address); ?returnTo is passed along.
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useMe } from '@/api';
import { paths, safeReturnTo } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import type { AccountWelcomeState } from '../account/accountState';
import styles from './AuthForms.module.css';
import { RegisterForm } from './RegisterForm';

export default function RegisterPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'), '') || null;
  const [registered, setRegistered] = useState(false);

  if (me.data) {
    if (registered) {
      const state: AccountWelcomeState = { welcome: true, returnTo };
      return <Navigate to={paths.account} replace state={state} />;
    }
    return <Navigate to={returnTo ?? paths.home} replace />;
  }

  return (
    <SitePage title="Create an account" width="narrow" lead="Save your brews, share them and find them again on any device.">
      <div className={styles.card}>
        <RegisterForm autoFocus returnTo={returnTo} onRegistered={() => setRegistered(true)} />
      </div>
      <p className={styles.footer}>
        Already have an account?{' '}
        <Link className={styles.link} to={paths.login(returnTo)}>
          Sign in
        </Link>
      </p>
    </SitePage>
  );
}
