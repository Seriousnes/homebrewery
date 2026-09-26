// Brew item icons that the UI kit's set (web/src/ui/iconPaths.ts) doesn't have. Decorative, in
// currentColor, on the kit's 24×24 grid with its stroke style.
import clsx from 'clsx';
import styles from './BrewItem.module.css';

type IconName = 'pencil' | 'pages' | 'clock' | 'calendar' | 'link' | 'clone';

const PATHS: Record<IconName, string> = {
  pencil: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  pages: 'M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  clone: 'M8 8h12v12H8z M16 8V4H4v12h4 M14 11v6 M11 14h6',
};

export function BrewIcon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={clsx(styles.icon, className)}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
