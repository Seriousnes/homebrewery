// CI and the local runs use the same tools: the Playwright container image of the CI e2e jobs
// (and of e2e/run-linux.mjs, which reads it from ci.yml) carries the browsers of one Playwright
// release, which must be the @playwright/test that npm ci installs, or CI can't launch them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(path.join(webDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const lock = JSON.parse(readFileSync(path.join(webDir, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string } | undefined>;
};

describe('CI parity', () => {
  it("every Playwright image in ci.yml is the installed @playwright/test's", () => {
    const versions = Array.from(ci.matchAll(/mcr\.microsoft\.com\/playwright:v([\w.-]+?)-noble/g), (m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([lock.packages['node_modules/@playwright/test']?.version]));
  });
});
