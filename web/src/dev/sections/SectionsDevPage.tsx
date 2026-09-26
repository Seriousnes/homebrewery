import { PaginationDevPage } from '../pagination/PaginationDevPage';

/**
 * /dev/sections[?theme=…&doc=sections|seams|oversize|journal&zoom=1&css=…]: the pagination harness
 * with a toolbar (page break, section columns, block type) and the layout status, for the section
 * commands, seam editing and oversize warnings (P4.5–P4.8). Same test API (window.__hbPagination).
 */
export function SectionsDevPage() {
  return <PaginationDevPage variant="sections" />;
}
