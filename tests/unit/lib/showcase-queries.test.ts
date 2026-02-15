import { describe, test, expect } from 'bun:test';
import {
  SHOWCASE_QUERIES,
  getRandomShowcaseQuery,
  getRandomQueryByDifficulty,
  getDefaultQuery,
} from '@/lib/showcase-queries';

describe('showcase-queries', () => {
  // ── SHOWCASE_QUERIES constant ──────────────────────────────────────────
  test('SHOWCASE_QUERIES is a non-empty array', () => {
    expect(Array.isArray(SHOWCASE_QUERIES)).toBe(true);
    expect(SHOWCASE_QUERIES.length).toBeGreaterThan(0);
  });

  test('each query has required fields', () => {
    for (const q of SHOWCASE_QUERIES) {
      expect(q).toHaveProperty('title');
      expect(q).toHaveProperty('description');
      expect(q).toHaveProperty('difficulty');
      expect(q).toHaveProperty('query');
      expect(['simple', 'intermediate', 'advanced']).toContain(q.difficulty);
    }
  });

  // ── getRandomShowcaseQuery ─────────────────────────────────────────────
  describe('getRandomShowcaseQuery', () => {
    test('returns a string containing SQL', () => {
      const result = getRandomShowcaseQuery();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should contain SQL keywords
      expect(result.toUpperCase()).toMatch(/SELECT|WITH/);
    });

    test('includes a divider line', () => {
      const result = getRandomShowcaseQuery();
      expect(result).toContain('─────');
    });

    test('includes an intro comment', () => {
      const result = getRandomShowcaseQuery();
      expect(result).toMatch(/^--/); // Starts with comment
    });
  });

  // ── getRandomQueryByDifficulty ─────────────────────────────────────────
  describe('getRandomQueryByDifficulty', () => {
    test('returns a simple query', () => {
      const result = getRandomQueryByDifficulty('simple');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('returns an intermediate query', () => {
      const result = getRandomQueryByDifficulty('intermediate');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('returns an advanced query', () => {
      const result = getRandomQueryByDifficulty('advanced');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('includes divider', () => {
      const result = getRandomQueryByDifficulty('simple');
      expect(result).toContain('─────');
    });
  });

  // ── getDefaultQuery ────────────────────────────────────────────────────
  describe('getDefaultQuery', () => {
    test('returns showcase query for demo mode', () => {
      const result = getDefaultQuery(true);
      expect(result.length).toBeGreaterThan(50);
      expect(result).toContain('--'); // Has comments
    });

    test('returns JSON template for json queryLanguage', () => {
      const result = getDefaultQuery(false, 'json');
      expect(result).toContain('"collection"');
      expect(result).toContain('"operation"');
      expect(result).toContain('"find"');
    });

    test('returns default SQL comment for sql queryLanguage', () => {
      const result = getDefaultQuery(false, 'sql');
      expect(result).toContain('Start typing');
    });

    test('returns default SQL comment when no queryLanguage', () => {
      const result = getDefaultQuery(false);
      expect(result).toContain('Start typing');
    });
  });
});
