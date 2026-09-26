import { describe, expect, it } from 'vitest';
import { formatDateTime, formatRelativeTime } from './relativeTime';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it.each([
    [NOW - 10_000, 'just now'],
    [NOW + 10_000, 'just now'],
    [NOW - 50_000, '1 minute ago'],
    [NOW - 5 * MIN, '5 minutes ago'],
    [NOW - 3 * HOUR, '3 hours ago'],
    [NOW - DAY, 'yesterday'],
    [NOW - 3 * DAY, '3 days ago'],
    [NOW - 14 * DAY, '2 weeks ago'],
    [NOW - 60 * DAY, '2 months ago'],
    [NOW - 800 * DAY, '2 years ago'],
    [NOW + 2 * DAY, 'in 2 days'],
  ])('%s → %s', (time, expected) => {
    expect(formatRelativeTime(time, NOW, 'en')).toBe(expected);
  });

  it('accepts ISO strings and dates, and returns "" for invalid input', () => {
    expect(formatRelativeTime(new Date(NOW - 2 * HOUR).toISOString(), NOW, 'en')).toBe('2 hours ago');
    expect(formatRelativeTime(new Date(NOW - 2 * HOUR), NOW, 'en')).toBe('2 hours ago');
    expect(formatRelativeTime('not a date', NOW, 'en')).toBe('');
    expect(formatDateTime('not a date', 'en')).toBe('');
  });

  it('formats full dates', () => {
    expect(formatDateTime(NOW, 'en')).toMatch(/2026/);
  });
});
