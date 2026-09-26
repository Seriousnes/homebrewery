// The vault's state in the URL (plan §9: /vault → GET /api/vault): ?q=&author=&sort=&dir=&page=
// &pageSize=. Upstream's vault links (?title=&author=&count=&sort=createdAt|updatedAt&page=) are
// read too. Pure, so the rules are unit tested on their own.
import type { VaultDir, VaultSearchParams, VaultSort } from '@/api';
import { defaultDirFor } from '@/ported/listPage/listModel';

export const VAULT_SORTS = ['relevance', 'title', 'created', 'updated', 'views'] as const satisfies readonly VaultSort[];
export const VAULT_SORT_LABELS: Record<VaultSort, string> = {
  relevance: 'Relevance',
  title: 'Title',
  created: 'Created',
  updated: 'Updated',
  views: 'Views',
};

/** Upstream's choices for "Results per page"; the API allows 1–60. */
export const PAGE_SIZES = [10, 20, 40, 60] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 60;
export const MAX_PAGE = 10_000;
/** The API refuses longer searches (errors.q). */
export const MAX_QUERY_LENGTH = 256;

export interface VaultQuery {
  q: string;
  author: string;
  /** null: the server's default (relevance with q, else updated). */
  sort: VaultSort | null;
  /** null: the sort's default (title A to Z, others newest/most first). */
  dir: VaultDir | null;
  page: number;
  pageSize: number;
}

export function parseVaultSort(value: string | null | undefined): VaultSort | null {
  switch (value?.trim().toLowerCase()) {
    case 'relevance':
      return 'relevance';
    case 'title':
    case 'alpha':
      return 'title';
    case 'created':
    case 'createdat':
      return 'created';
    case 'updated':
    case 'updatedat':
      return 'updated';
    case 'views':
      return 'views';
    default:
      return null;
  }
}

export function parseVaultDir(value: string | null | undefined): VaultDir | null {
  const v = value?.trim().toLowerCase();
  return v === 'asc' || v === 'desc' ? v : null;
}

function positiveInt(value: string | null, fallback: number, max: number): number {
  if (value == null || !/^\s*\d+\s*$/.test(value)) return fallback;
  const n = Number.parseInt(value, 10);
  return n >= 1 ? Math.min(n, max) : fallback;
}

export function readVaultQuery(params: URLSearchParams): VaultQuery {
  return {
    q: params.get('q') ?? params.get('title') ?? '',
    author: params.get('author') ?? '',
    sort: parseVaultSort(params.get('sort')),
    dir: parseVaultDir(params.get('dir')),
    page: positiveInt(params.get('page'), 1, MAX_PAGE),
    pageSize: positiveInt(params.get('pageSize') ?? params.get('count'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

/** The canonical URL query (defaults left out, upstream's keys dropped). */
export function writeVaultQuery(query: VaultQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (query.q.trim()) out.set('q', query.q.trim());
  if (query.author.trim()) out.set('author', query.author.trim());
  if (query.sort) out.set('sort', query.sort);
  if (query.dir) out.set('dir', query.dir);
  if (query.page > 1) out.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_PAGE_SIZE) out.set('pageSize', String(query.pageSize));
  return out;
}

/** What GET /api/vault is asked. */
export function vaultSearchParams(query: VaultQuery): VaultSearchParams {
  const params: VaultSearchParams = { page: query.page, pageSize: query.pageSize };
  if (query.q.trim()) params.q = query.q.trim();
  if (query.author.trim()) params.author = query.author.trim();
  if (query.sort) params.sort = query.sort;
  if (query.dir) params.dir = query.dir;
  return params;
}

/** The sort the server applies (BrewListService): relevance needs a search. */
export function effectiveSort(query: Pick<VaultQuery, 'q' | 'sort'>): VaultSort {
  const hasQ = query.q.trim() !== '';
  if (!query.sort) return hasQ ? 'relevance' : 'updated';
  return query.sort === 'relevance' && !hasQ ? 'updated' : query.sort;
}

export function effectiveDir(sort: VaultSort, dir: VaultDir | null): VaultDir {
  return dir ?? defaultDirFor(sort);
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/**
 * Up to ten page links around the current page (upstream's window): pages 1–10 near the start,
 * the last ten near the end, otherwise five before and four after.
 */
export function pageWindow(page: number, pages: number): { start: number; end: number } {
  if (page <= 6) return { start: 1, end: Math.min(pages, 10) };
  if (page + 4 >= pages) return { start: Math.max(1, pages - 9), end: pages };
  return { start: page - 5, end: page + 4 };
}
