import { describe, test, expect } from 'bun:test';
import { cn } from '@/lib/utils';

describe('cn (classname merge utility)', () => {
  test('merges multiple class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  test('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra');
  });

  test('merges tailwind classes correctly', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  test('handles undefined and null inputs', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });

  test('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });
});
