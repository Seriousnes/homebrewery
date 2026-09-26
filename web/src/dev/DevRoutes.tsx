import { Route, Routes } from 'react-router';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { DevIndex } from './DevIndex';
import { devPages } from './registry';

/** Element of the lazy `/dev/*` route (web/src/app/routes.tsx): /dev and every /dev/<name>. */
export function DevRoutes() {
  return (
    <Routes>
      <Route index element={<DevIndex pages={devPages} />} />
      {devPages.map((page) => (
        <Route key={page.path} path={page.path.slice('/dev/'.length)} element={page.element} />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
