// Navbar-only icons that the UI kit's set (web/src/ui/iconPaths.ts) doesn't have. Decorative.

interface NavIconProps {
  size?: number;
  className?: string;
}

/** A clock with a counter-clockwise arrow ("recent"). */
export function HistoryIcon({ size = 16, className }: NavIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3.2l2.2 1.4"
      />
    </svg>
  );
}

/** A question mark in a circle ("help"). */
export function HelpIcon({ size = 16, className }: NavIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.3-1.9 1.6-1.9 2.8"
      />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** A simple d20 outline for the brand link. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path d="M12 1.5 21.5 7v10L12 22.5 2.5 17V7Zm0 2.3L5.3 7.7 12 8.9l6.7-1.2Zm-7.5 5.4v6.3l5.2-5.4Zm15 0-5.2.9 5.2 5.4ZM12 10.6 7 15.8h10Zm-6.3 6.8L11 20.3v-2.9Zm12.6 0L13 17.4v2.9Z" />
    </svg>
  );
}
