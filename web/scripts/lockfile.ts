// The versions web/pnpm-lock.yaml pins for web's own dependencies. The lockfile holds two YAML
// documents (pnpm's own version, then the project's packages); the second has web's importer.
//
// Plain erasable TypeScript: the .mjs runners import it directly (Node 24 strips the types).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAll } from 'js-yaml';

type Importer = Partial<Record<'dependencies' | 'devDependencies', Record<string, { version: string } | undefined>>>;

/** The locked version of a direct dependency of web/ (without pnpm's peer suffix), or undefined. */
export function lockedVersion(webDir: string, name: string): string | undefined {
  const documents = loadAll(readFileSync(path.join(webDir, 'pnpm-lock.yaml'), 'utf8')) as ({ importers?: Record<string, Importer> } | null)[];
  const importer = documents.map((document) => document?.importers?.['.']).find((it) => it?.dependencies ?? it?.devDependencies);
  const entry = importer?.dependencies?.[name] ?? importer?.devDependencies?.[name];
  return entry?.version.replace(/\(.*$/, '');
}
