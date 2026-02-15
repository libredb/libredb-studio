import { describe, test, expect } from 'bun:test';
import { aggregate } from '@/components/PivotTable';

describe('aggregate', () => {
  test('count returns length of values array', () => {
    expect(aggregate([1, 2, 3], 'count')).toBe('3');
  });

  test('count with mixed types', () => {
    expect(aggregate([1, 'a', null, undefined], 'count')).toBe('4');
  });

  test('count with empty array', () => {
    expect(aggregate([], 'count')).toBe('0');
  });

  test('sum of numbers', () => {
    expect(aggregate([10, 20, 30], 'sum')).toBe('60.00');
  });

  test('sum with non-numeric values filtered', () => {
    expect(aggregate([10, 'abc', 20], 'sum')).toBe('30.00');
  });

  test('sum with all non-numeric returns 0', () => {
    expect(aggregate(['abc', 'def'], 'sum')).toBe('0');
  });

  test('sum with empty array returns 0', () => {
    expect(aggregate([], 'sum')).toBe('0');
  });

  test('avg of numbers', () => {
    expect(aggregate([10, 20, 30], 'avg')).toBe('20.00');
  });

  test('avg with non-numeric filtered', () => {
    expect(aggregate([10, 'abc', 30], 'avg')).toBe('20.00');
  });

  test('avg with all non-numeric returns 0', () => {
    expect(aggregate(['abc'], 'avg')).toBe('0');
  });

  test('min of numbers', () => {
    expect(aggregate([30, 10, 20], 'min')).toBe('10');
  });

  test('min with negatives', () => {
    expect(aggregate([-5, 0, 5], 'min')).toBe('-5');
  });

  test('min with all non-numeric returns dash', () => {
    expect(aggregate(['abc'], 'min')).toBe('-');
  });

  test('max of numbers', () => {
    expect(aggregate([30, 10, 20], 'max')).toBe('30');
  });

  test('max with negatives', () => {
    expect(aggregate([-5, 0, 5], 'max')).toBe('5');
  });

  test('max with all non-numeric returns dash', () => {
    expect(aggregate(['abc'], 'max')).toBe('-');
  });

  test('sum with decimal values', () => {
    expect(aggregate([1.5, 2.5], 'sum')).toBe('4.00');
  });

  test('avg of single value', () => {
    expect(aggregate([42], 'avg')).toBe('42.00');
  });
});
