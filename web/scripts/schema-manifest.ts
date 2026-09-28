/// <reference lib="dom" />
// (The schema's parse-rule callbacks are typed with DOM types; nothing here touches a DOM.)
//
// Writes shared/schema-manifest.json from the editor schema (plan §3.7). The server's
// DocInspector validates saved documents against it, so the client schema stays the single
// source of truth. Runs before `vite build` (the "build" script) and in CI.
//
//   pnpm run schema             write the manifest (only when it changed)
//   ppnpm run schema --check  exit 1 when the committed manifest is stale
import { getSchema } from '@tiptap/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaExtensions } from '../src/editor/schema';
import { buildSchemaManifest, serializeSchemaManifest } from '../src/editor/schema/manifest';

const outFile = fileURLToPath(new URL('../../shared/schema-manifest.json', import.meta.url));
const text = serializeSchemaManifest(buildSchemaManifest(getSchema(schemaExtensions)));
const current = existsSync(outFile) ? readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : null;

if (process.argv.includes('--check')) {
  if (current !== text) {
    console.error(`${outFile} is stale. Run \`pnpm -C web run schema\` and commit it.`);
    process.exit(1);
  }
  console.log(`${outFile} is up to date.`);
} else if (current === text) {
  console.log(`${outFile} is up to date.`);
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(`Wrote ${outFile}`);
}
