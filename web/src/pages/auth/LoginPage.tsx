// /login. After signing in (or when already signed in) it goes to ?returnTo (a same-site path),
// else home.
import { Link, Navigate, useSearchParams } from 'react-router';
import { useMe } from '@/api';
import { paths, safeReturnTo } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import styles from './AuthForms.module.css';
import { LoginForm } from './LoginForm';

export default function LoginPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));

  if (me.data) return <Navigate to={returnTo} replace />;

  return (
    <SitePage title="Sign in" width="narrow" lead="Sign in to save your brews and find them again on any device.">
      <div className={styles.card}>
        <LoginForm autoFocus data-testid="login-form" />
      </div>
      <p className={styles.footer}>
        New to the Homebrewery?{' '}
        <Link className={styles.link} to={paths.register(returnTo)}>
          Create an account
        </Link>
      </p>
    </SitePage>
  );
}
