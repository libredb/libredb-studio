import { describe, test, expect } from 'bun:test';
import { TimeSeriesBuffer } from '@/lib/time-series-buffer';

describe('TimeSeriesBuffer', () => {
  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    test('default maxSize is 120', () => {
      const buffer = new TimeSeriesBuffer<number>();
      // Push 121 items — only 120 should remain
      for (let i = 0; i < 121; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(120);
    });

    test('custom maxSize is respected', () => {
      const buffer = new TimeSeriesBuffer<number>(5);
      for (let i = 0; i < 10; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(5);
    });
  });

  // ==========================================================================
  // push + getAll
  // ==========================================================================

  describe('push + getAll', () => {
    test('single item can be pushed and retrieved', () => {
      const buffer = new TimeSeriesBuffer<string>(10);
      buffer.push('hello');
      const all = buffer.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].data).toBe('hello');
      expect(typeof all[0].timestamp).toBe('number');
    });

    test('multiple items are returned in chronological order', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      const all = buffer.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].data).toBe(1);
      expect(all[1].data).toBe(2);
      expect(all[2].data).toBe(3);
    });

    test('getAll returns empty array when buffer is empty', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      expect(buffer.getAll()).toEqual([]);
    });
  });

  // ==========================================================================
  // size
  // ==========================================================================

  describe('size', () => {
    test('empty buffer has size 0', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      expect(buffer.size).toBe(0);
    });

    test('size tracks number of pushes', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      expect(buffer.size).toBe(1);
      buffer.push(2);
      expect(buffer.size).toBe(2);
      buffer.push(3);
      expect(buffer.size).toBe(3);
    });
  });

  // ==========================================================================
  // Circular overflow
  // ==========================================================================

  describe('circular overflow', () => {
    test('pushing more than maxSize drops oldest items', () => {
      const buffer = new TimeSeriesBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4); // overwrites 1

      const all = buffer.getAll();
      expect(all).toHaveLength(3);
      expect(all.map(p => p.data)).toEqual([2, 3, 4]);
    });

    test('size stays at maxSize after overflow', () => {
      const buffer = new TimeSeriesBuffer<number>(3);
      for (let i = 0; i < 10; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(3);
    });

    test('newest items are kept after overflow', () => {
      const buffer = new TimeSeriesBuffer<number>(5);
      for (let i = 0; i < 20; i++) {
        buffer.push(i);
      }
      const all = buffer.getAll();
      expect(all.map(p => p.data)).toEqual([15, 16, 17, 18, 19]);
    });
  });

  // ==========================================================================
  // getRange
  // ==========================================================================

  describe('getRange', () => {
    test('returns points within the specified timestamp range', () => {
      const buffer = new TimeSeriesBuffer<string>(10);
      const now = Date.now();

      // Push items with known timestamps by mocking Date.now
      const originalNow = Date.now;
      let fakeTime = now;
      Date.now = () => fakeTime;

      fakeTime = 1000;
      buffer.push('a');
      fakeTime = 2000;
      buffer.push('b');
      fakeTime = 3000;
      buffer.push('c');
      fakeTime = 4000;
      buffer.push('d');

      Date.now = originalNow;

      const result = buffer.getRange(2000, 3000);
      expect(result).toHaveLength(2);
      expect(result[0].data).toBe('b');
      expect(result[1].data).toBe('c');
    });

    test('returns empty array if no points match the range', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      const originalNow = Date.now;
      Date.now = () => 1000;
      buffer.push(1);
      Date.now = originalNow;

      const result = buffer.getRange(5000, 6000);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // getLast
  // ==========================================================================

  describe('getLast', () => {
    test('returns last n items', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      buffer.push(5);

      const last3 = buffer.getLast(3);
      expect(last3).toHaveLength(3);
      expect(last3.map(p => p.data)).toEqual([3, 4, 5]);
    });

    test('handles n greater than size by returning all items', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);

      const result = buffer.getLast(10);
      expect(result).toHaveLength(2);
      expect(result.map(p => p.data)).toEqual([1, 2]);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    test('resets buffer to empty', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      buffer.clear();
      expect(buffer.getAll()).toEqual([]);
    });

    test('resets size to 0', () => {
      const buffer = new TimeSeriesBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);

      buffer.clear();
      expect(buffer.size).toBe(0);
    });
  });
});
