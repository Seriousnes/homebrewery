// Runs upstream's own markdown test suites (tests/markdown/*.test.js, written for marked-hbfm)
// against the importer's renderer: 'marked-hbfm' is mocked with one createHbfmRenderer()
// instance, which keeps state between calls the way marked-hbfm's module-level instance does
// (the suites rely on that, e.g. for heading slugs and cross-page variables).
import { describe, expect, it, test, vi } from 'vitest';

vi.mock('marked-hbfm', async () => {
  const { createHbfmRenderer } = await import('./renderer');
  const renderer = createHbfmRenderer();
  return { hbfm: { render: (text: string, page?: number) => renderer.render(text, page), marked: renderer.marked, validate: () => [] } };
});

const suites = import.meta.glob('../../../../../tests/markdown/*.test.js');

// The suites use Jest's globals.
Object.assign(globalThis, { describe, it, test, expect });

for (const [file, load] of Object.entries(suites).sort(([a], [b]) => a.localeCompare(b))) {
  describe(file.replace(/^.*\//, ''), async () => {
    await load();
  });
}
