// Vitest fixtures for the list pages (never import from app code).
import type { BrewSummary } from '@/api';

/** A BrewSummary with sensible defaults (published, one author 'alice', dated 1 Jan 2026). */
export function summary(shareId: string, overrides: Partial<BrewSummary> = {}): BrewSummary {
  return {
    shareId,
    editId: null,
    title: shareId,
    description: '',
    tags: [],
    authors: ['alice'],
    theme: '5ePHB',
    lang: 'en',
    pageCount: 1,
    views: 0,
    published: true,
    thumbnailUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastViewedAt: null,
    role: null,
    locked: false,
    ...overrides,
  };
}
