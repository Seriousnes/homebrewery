// "5 minutes ago" without a date library (upstream used Moment's fromNow()).

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** A short relative time such as "just now", "5 minutes ago", "yesterday" or "in 2 days". */
export function formatRelativeTime(time: number | string | Date, now: number = Date.now(), locale?: string): string {
  const ms = time instanceof Date ? time.getTime() : typeof time === 'string' ? Date.parse(time) : time;
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.round((ms - now) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size * 0.95 || unit === 'minute') {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(seconds, 'second');
}

/** A full, locale-formatted date and time for a title or <time> tooltip. */
export function formatDateTime(time: number | string | Date, locale?: string): string {
  const date = time instanceof Date ? time : new Date(time);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
