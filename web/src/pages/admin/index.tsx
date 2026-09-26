// /admin/* (P7.4, plan §8.3 admin rows, §8.6 locks): the admin pages, only for the Admin role.
// Anonymous visitors get the sign-in page in place, other accounts a 403 page (RequireAuth). The
// shell routes `admin/*` here; the sub-pages are this module's own nested routes:
//   /admin                         overview: totals and quick lookups
//   /admin/users?q=                account search
//   /admin/users/:handle           an account and all its brews
//   /admin/brews[/:id]             brew lookup (share, edit or internal id), details and lock tools
//   /admin/locks                   review queue and locked brews
//   /admin/notifications           site notifications
//   /admin/notifications/new|:id   notification form with a live banner preview
import { Route, Routes } from 'react-router';
import { RequireAuth } from '@/app/RequireAuth';
import { ADMIN_ROLE } from '@/app/roles';
import { NotFoundPage } from '@/pages/errors/NotFoundPage';
import BrewsPage from './BrewsPage';
import LocksPage from './LocksPage';
import NotificationEditPage from './NotificationEditPage';
import NotificationsPage from './NotificationsPage';
import OverviewPage from './OverviewPage';
import UserDetailPage from './UserDetailPage';
import UsersPage from './UsersPage';

export default function AdminPage() {
  return (
    <RequireAuth role={ADMIN_ROLE}>
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:handle" element={<UserDetailPage />} />
        <Route path="brews/:id?" element={<BrewsPage />} />
        <Route path="locks" element={<LocksPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="notifications/:id" element={<NotificationEditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </RequireAuth>
  );
}
