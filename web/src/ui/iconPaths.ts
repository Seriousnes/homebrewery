// The app's icon set: stroke icons on a 24×24 grid (round caps and joins, stroke 2 unless noted).
// Drawn for this project; no icon font or third-party set. Add icons here; <Icon name> picks them up.

export interface IconDef {
  /** Path data (several subpaths allowed). */
  d: string;
  strokeWidth?: number;
}

// Circle helper for path data: a full circle as two arcs.
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const cloud = 'M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 17.8 10a4.25 4.25 0 0 1-.3 8.5z';
const page = 'M4 4h16v16H4z';

export const ICONS = {
  // Marks
  bold: { d: 'M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z' },
  italic: { d: 'M19 4h-9 M14 20H5 M15 4 9 20' },
  underline: { d: 'M7 4v6a5 5 0 0 0 10 0V4 M5 20h14' },
  strike: { d: 'M16.5 6.5C15.6 5 14 4 12 4 9.2 4 7.5 5.5 7.5 7.5c0 1.8 1.4 2.8 4.5 3.5 M4 12h16 M7.5 17.5C8.4 19 10 20 12 20c2.8 0 4.5-1.5 4.5-3.5 0-.9-.3-1.6-1-2.2' },
  code: { d: 'M9 7 4 12l5 5 M15 7l5 5-5 5' },
  superscript: { d: 'M4 8l8 10 M12 8 4 18 M15.5 6a2 2 0 1 1 3.4 1.4L15.5 11H20' },
  subscript: { d: 'M4 5l8 10 M12 5 4 15 M15.5 15a2 2 0 1 1 3.4 1.4L15.5 20H20' },
  link: { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },

  // Blocks
  paragraph: { d: 'M13 4v16 M17 4v16 M19 4H9.5a4.5 4.5 0 0 0 0 9H13' },
  heading: { d: 'M6 4v16 M18 4v16 M6 12h12' },
  heading1: { d: 'M4 6v12 M12 6v12 M4 12h8 M17 10l3-2v10' },
  heading2: { d: 'M4 6v12 M12 6v12 M4 12h8 M16 10.5a2.25 2.25 0 1 1 4 1.4L16 18h5' },
  heading3: { d: 'M4 6v12 M12 6v12 M4 12h8 M16.5 8.5H20l-2.2 3.2a2.6 2.6 0 1 1-1.8 4.6' },
  bulletList: { d: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01' },
  orderedList: { d: 'M10 6h10 M10 12h10 M10 18h10 M4 5l1.5-1v5 M4 15.5a1.5 1.5 0 1 1 2.6 1L4 20h3' },
  quote: { d: 'M5 7h5v6l-2 4H6l1.5-4H5z M14 7h5v6l-2 4h-2l1.5-4H14z' },
  alignLeft: { d: 'M4 6h16 M4 10h10 M4 14h16 M4 18h10' },
  alignCenter: { d: 'M4 6h16 M7 10h10 M4 14h16 M7 18h10' },
  alignRight: { d: 'M4 6h16 M10 10h10 M4 14h16 M10 18h10' },
  alignJustify: { d: 'M4 6h16 M4 10h16 M4 14h16 M4 18h16' },
  pageBreak: { d: 'M6 3v5h12V3 M6 21v-5h12v5 M3 12h2 M8 12h3 M13 12h3 M19 12h2' },
  columnBreak: { d: 'M3 5h7 M3 9h7 M3 13h4 M7 13v4h6 M10.5 14.5 13 17l-2.5 2.5 M14 5h7 M14 9h7 M17 13h4' },
  columns: { d: `${page} M12 4v16` },
  table: { d: 'M4 5h16v14H4z M4 10h16 M4 14.5h16 M10 5v14' },
  image: { d: 'M4 5h16v14H4z M4 16l4.5-4.5 3 3 3.5-3.5L20 16 M9 9h.01' },
  insert: { d: `${page} M12 8v8 M8 12h8` },
  plus: { d: 'M12 5v14 M5 12h14' },
  minus: { d: 'M5 12h14' },
  braces: { d: 'M8 4H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1 M16 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1' },
  outline: { d: 'M4 5h16 M8 10h12 M8 15h12 M4 20h16' },

  // History and view
  undo: { d: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11' },
  redo: { d: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13' },
  zoomIn: { d: `${circle(11, 11, 7)} M20 20l-4-4 M11 8v6 M8 11h6` },
  zoomOut: { d: `${circle(11, 11, 7)} M20 20l-4-4 M8 11h6` },
  zoomFit: { d: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5' },
  spreadSingle: { d: 'M7 3h10v18H7z' },
  spreadFacing: { d: 'M3 4h8.5v16H3z M12.5 4H21v16h-8.5z' },
  spreadFlow: { d: 'M3 3h5v7H3z M10 3h5v7h-5z M17 3h4v7h-4z M3 14h5v7H3z M10 14h5v7h-5z' },
  panelLeft: { d: `${page} M9 4v16` },
  panelRight: { d: `${page} M15 4v16` },
  eye: { d: `M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z ${circle(12, 12, 3)}` },
  eyeOff: { d: 'M3 3l18 18 M10.6 5.1Q11.3 5 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2 M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2' },
  print: { d: 'M7 9V3h10v6 M7 18H4V9h16v9h-3 M7 14h10v7H7z' },

  // Save states
  saved: { d: `${cloud} M9.5 13.5l2 2 3.5-3.5` },
  saving: { d: `${cloud} M12 16v-5 M9.5 13l2.5-2.5 2.5 2.5` },
  unsaved: { d: `${cloud} M12 13.5h.01`, strokeWidth: 2.5 },
  saveError: { d: `${cloud} M3 3l18 18` },

  // Actions and objects
  trash: { d: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3' },
  copy: { d: 'M9 9h11v11H9z M5 15H4V4h11v1' },
  download: { d: 'M12 4v11 M7 10l5 5 5-5 M5 20h14' },
  upload: { d: 'M12 20V9 M7 14l5-5 5 5 M5 4h14' },
  // A browser window (brews kept on this device).
  device: { d: 'M3 5h18v14H3z M3 9h18 M6 7h.01 M8.5 7h.01' },
  settings: { d: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4' },
  close: { d: 'M6 6l12 12 M18 6 6 18' },
  check: { d: 'M5 12.5l4.5 4.5L19 7' },
  search: { d: `${circle(11, 11, 7)} M20 20l-4-4` },
  // The Vault: an arched gate with a portcullis (the legacy navbar's dungeon).
  vault: { d: 'M3 21h18 M5 21V11a7 7 0 0 1 14 0v10 M9 21V8.5 M12 21V7 M15 21V8.5 M9 13h6 M9 17h6' },
  user: { d: `${circle(12, 8, 4)} M4 21a8 8 0 0 1 16 0` },
  lock: { d: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4' },
  unlock: { d: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.6-1.8' },
  menu: { d: 'M4 6h16 M4 12h16 M4 18h16' },
  more: { d: 'M6 12h.01 M12 12h.01 M18 12h.01', strokeWidth: 3 },
  dragHandle: { d: 'M9 6h.01 M9 12h.01 M9 18h.01 M15 6h.01 M15 12h.01 M15 18h.01', strokeWidth: 3 },

  // Status
  info: { d: `${circle(12, 12, 9)} M12 11v5 M12 8h.01` },
  warning: { d: 'M12 3.5 2.5 20h19z M12 10v4 M12 17h.01' },
  error: { d: `${circle(12, 12, 9)} M15 9l-6 6 M9 9l6 6` },
  success: { d: `${circle(12, 12, 9)} M8 12.5l2.5 2.5L16 9.5` },

  // Chevrons
  chevronDown: { d: 'M6 9l6 6 6-6' },
  chevronUp: { d: 'M6 15l6-6 6 6' },
  chevronLeft: { d: 'M15 6l-6 6 6 6' },
  chevronRight: { d: 'M9 6l6 6-6 6' },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];
