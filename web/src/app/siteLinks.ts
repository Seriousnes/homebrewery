// External links used by the navbar and the error pages (legacy help.navitem.jsx and
// error-navitem.jsx). They still point at upstream's community pages; change them here when the
// fork gets its own.

const ISSUE_TEMPLATE = [
  '- **Browser(s)** :',
  '- **Operating System** :',
  '- **Issue** :',
].join('\n');

export const siteLinks = {
  /** Where "Report an issue" goes (a pre-filled Reddit post, as upstream). */
  reportIssue: `https://www.reddit.com/r/homebrewery/submit?selftext=true&text=${encodeURIComponent(ISSUE_TEMPLATE)}`,
  faq: 'https://homebrewery.naturalcrit.com/faq',
  /** A new GitHub issue with `details` (an error report) in the body. */
  bugReport: (details: string) =>
    `https://github.com/naturalcrit/homebrewery/issues/new?body=${encodeURIComponent(details.slice(0, 4000))}`,
} as const;
