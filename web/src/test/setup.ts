import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// waitFor / findBy* wait for a condition, not for a time: the test timeout (5 s, vite.config.ts)
// is the only bound. Their own default (1 s) failed tests whose condition simply came late on a
// busy machine. Just under the test timeout, so a condition that never comes still fails with
// waitFor's message (what it waited for) rather than a bare timeout.
configure({ asyncUtilTimeout: 4_500 });

afterEach(() => {
  cleanup();
});
