import { hbfm } from 'marked-hbfm';
import { describe, expect, it } from 'vitest';
import { migrateDoc } from './migrations';
import { HeadingSlugger, headingSlugSourceFromHtml, isGeneratedSlug, slugify } from './slug';
import { DOC_SCHEMA_VERSION } from './version';

const TITLES = [
  'Hello, World!',
  'Hello, World!',
  'Hello, World!',
  'The Wandering Inn',
  'Ünïcödé Straße 42',
  "Don't stop — go",
  'Chapter 1: The *Beginning*',
  'A & B < C',
  'snake_case and kebab-case',
  '日本語の見出し',
  'Émile Zola',
  'Title-1',
  'Title',
  'Title',
];

describe('heading slugs', () => {
  it('match marked-hbfm heading ids (marked-gfm-heading-id, globalSlugs)', () => {
    const html = hbfm.render(TITLES.map((t) => `## ${t}`).join('\n'), 0);
    const upstream = [...html.matchAll(/<h2 id="([^"]*)">(.*?)<\/h2>/g)].map((m) => ({ id: m[1], inner: m[2] ?? '' }));
    expect(upstream).toHaveLength(TITLES.length);

    const slugger = new HeadingSlugger();
    const ours = upstream.map(({ inner }) => slugger.slug(headingSlugSourceFromHtml(inner)));
    expect(ours).toEqual(upstream.map((u) => u.id));
  });

  it('slugify lowercases, drops punctuation and turns spaces into hyphens', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('Two  spaces')).toBe('two--spaces');
    expect(slugify('Ünïcödé')).toBe('ünïcödé');
  });

  it('recognises generated slugs', () => {
    expect(isGeneratedSlug('title', 'Title')).toBe(true);
    expect(isGeneratedSlug('title-3', 'Title')).toBe(true);
    expect(isGeneratedSlug('title-x', 'Title')).toBe(false);
    expect(isGeneratedSlug('intro', 'Title')).toBe(false);
  });

  it('reserved ids are skipped and empty slugs give null', () => {
    const slugger = new HeadingSlugger();
    slugger.reserve('intro');
    expect(slugger.slug('Intro')).toBe('intro-1');
    expect(slugger.slug('!!!')).toBeNull();
  });
});

describe('migrateDoc', () => {
  it('is a no-op for the current version and rejects newer or invalid versions', () => {
    const doc = { type: 'doc', content: [] };
    expect(DOC_SCHEMA_VERSION).toBe(1);
    expect(migrateDoc(doc, 1)).toBe(doc);
    expect(() => migrateDoc(doc, 2)).toThrow(RangeError);
    expect(() => migrateDoc(doc, 0)).toThrow(RangeError);
  });
});
