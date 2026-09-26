// Document migrations (plan §3.4). DOC_SCHEMA_VERSION is bumped on incompatible schema
// changes; the client migrates older documents on load and saves the new version.
import type { JSONContent } from '@tiptap/core';
import { DOC_SCHEMA_VERSION } from './version';

export type DocMigration = (doc: JSONContent) => JSONContent;

/**
 * MIGRATIONS[n] turns a version-n document into version n + 1. Version 1 is the first schema,
 * so there are none yet.
 */
const MIGRATIONS: Partial<Record<number, DocMigration>> = {};

/**
 * Migrates `json` (stored with schema version `fromVersion`) to DOC_SCHEMA_VERSION. Returns the
 * same object when nothing changes. Throws for versions newer than this client or below 1.
 */
export function migrateDoc(json: JSONContent, fromVersion: number): JSONContent {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new RangeError(`Invalid document schema version: ${fromVersion}`);
  }
  if (fromVersion > DOC_SCHEMA_VERSION) {
    throw new RangeError(
      `Document schema version ${fromVersion} is newer than this editor (${DOC_SCHEMA_VERSION}). Reload the page.`,
    );
  }
  let doc = json;
  for (let v = fromVersion; v < DOC_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new RangeError(`No migration from document schema version ${v}`);
    doc = step(doc);
  }
  return doc;
}
