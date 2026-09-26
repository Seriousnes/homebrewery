import { Link } from 'react-router';

interface DevIndexProps {
  pages: readonly { path: string; title?: string; file: string }[];
}

/** /dev: links to every dev page (see registry.tsx). */
export function DevIndex({ pages }: DevIndexProps) {
  return (
    <main>
      <h1>Dev pages</h1>
      <ul>
        {pages.map((page) => (
          <li key={page.path}>
            <Link to={page.path}>{page.path}</Link>
            {page.title ? ` — ${page.title}` : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
