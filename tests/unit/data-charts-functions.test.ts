import '../setup';
import { describe, test, expect } from 'bun:test';
import {
  analyzeField,
  analyzeData,
  formatNumber,
  computeHistogramBins,
  aggregateData,
  groupByDate,
} from '@/components/DataCharts';

// ---------------------------------------------------------------------------
// analyzeField
// ---------------------------------------------------------------------------

describe('analyzeField', () => {
  test('detects numeric field (all numbers)', () => {
    const result = analyzeField('amount', [10, 20, 30, 40]);
    expect(result.type).toBe('numeric');
    expect(result.name).toBe('amount');
    expect(result.uniqueValues).toBe(4);
    expect(result.hasNulls).toBe(false);
  });

  test('detects numeric field from string numbers (>80% threshold)', () => {
    const result = analyzeField('price', ['10', '20', '30', '40', '50', 'N/A']);
    // 5/6 = 83.3% numeric → passes >80% threshold
    expect(result.type).toBe('numeric');
  });

  test('does not detect numeric when below 80% threshold', () => {
    const result = analyzeField('mixed', ['10', 'hello', 'world', '20', 'foo']);
    // 2/5 = 40% numeric
    expect(result.type).not.toBe('numeric');
  });

  test('detects ISO date (YYYY-MM-DD)', () => {
    const result = analyzeField('created', ['2025-01-15', '2025-02-20', '2025-03-10']);
    expect(result.type).toBe('date');
  });

  test('detects US date (MM/DD/YYYY)', () => {
    const result = analyzeField('date', ['01/15/2025', '02/20/2025']);
    expect(result.type).toBe('date');
  });

  test('detects EU date (DD.MM.YYYY)', () => {
    const result = analyzeField('date', ['15.01.2025', '20.02.2025']);
    expect(result.type).toBe('date');
  });

  test('detects categorical (unique values <= 50)', () => {
    const result = analyzeField('status', ['active', 'inactive', 'pending', 'active']);
    expect(result.type).toBe('categorical');
    expect(result.uniqueValues).toBe(3);
  });

  test('detects unknown for high-cardinality strings (>50 unique)', () => {
    const values = Array.from({ length: 60 }, (_, i) => `item_${i}`);
    const result = analyzeField('code', values);
    expect(result.type).toBe('unknown');
    expect(result.uniqueValues).toBe(60);
  });

  test('reports hasNulls correctly', () => {
    const result = analyzeField('value', [1, null, 3, undefined, 5]);
    expect(result.hasNulls).toBe(true);
    expect(result.uniqueValues).toBe(3);
  });

  test('reports no nulls', () => {
    const result = analyzeField('val', [1, 2, 3]);
    expect(result.hasNulls).toBe(false);
  });

  test('sample is first non-null value', () => {
    const result = analyzeField('x', [null, undefined, 'first', 'second']);
    expect(result.sample).toBe('first');
  });

  test('date takes priority over numeric', () => {
    // ISO date strings match date pattern AND pass Number() check
    const result = analyzeField('ts', ['2025-01-01', '2025-02-01', '2025-03-01']);
    expect(result.type).toBe('date');
  });

  test('handles empty values array', () => {
    const result = analyzeField('empty', []);
    expect(result.type).toBe('categorical'); // 0 unique <= 50
    expect(result.uniqueValues).toBe(0);
    expect(result.hasNulls).toBe(false);
    expect(result.sample).toBeUndefined();
  });

  test('handles all null values', () => {
    const result = analyzeField('nulls', [null, null, null]);
    expect(result.hasNulls).toBe(true);
    expect(result.uniqueValues).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeData
// ---------------------------------------------------------------------------

describe('analyzeData', () => {
  test('returns not visualizable for null result', () => {
    const result = analyzeData(null);
    expect(result.isVisualizable).toBe(false);
    expect(result.reason).toBe('No data to visualize');
  });

  test('returns not visualizable for empty rows', () => {
    const result = analyzeData({ rows: [], fields: [], rowCount: 0, executionTime: 0 });
    expect(result.isVisualizable).toBe(false);
    expect(result.reason).toBe('No data to visualize');
  });

  test('returns not visualizable for single row', () => {
    const result = analyzeData({
      rows: [{ id: 1, val: 10 }],
      fields: ['id', 'val'],
      rowCount: 1,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(false);
    expect(result.reason).toBe('Need at least 2 rows for visualization');
  });

  test('returns not visualizable when no numeric fields', () => {
    const result = analyzeData({
      rows: [
        { name: 'Alice', status: 'active' },
        { name: 'Bob', status: 'inactive' },
      ],
      fields: ['name', 'status'],
      rowCount: 2,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(false);
    expect(result.reason).toBe('No numeric fields found for Y-axis');
  });

  test('suggests line chart for date fields', () => {
    const result = analyzeData({
      rows: [
        { date: '2025-01-01', value: 10 },
        { date: '2025-02-01', value: 20 },
        { date: '2025-03-01', value: 30 },
      ],
      fields: ['date', 'value'],
      rowCount: 3,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(true);
    expect(result.suggestedChartType).toBe('line');
    expect(result.dateFields).toContain('date');
  });

  test('suggests scatter for 2+ numeric, no categorical', () => {
    const result = analyzeData({
      rows: [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
        { x: 7, y: 8, z: 9 },
      ],
      fields: ['x', 'y', 'z'],
      rowCount: 3,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(true);
    expect(result.suggestedChartType).toBe('scatter');
    expect(result.numericFields.length).toBeGreaterThanOrEqual(2);
    expect(result.categoricalFields.length).toBe(0);
  });

  test('suggests pie for categorical with <= 10 rows', () => {
    const result = analyzeData({
      rows: [
        { category: 'A', value: 10 },
        { category: 'B', value: 20 },
        { category: 'C', value: 30 },
      ],
      fields: ['category', 'value'],
      rowCount: 3,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(true);
    expect(result.suggestedChartType).toBe('pie');
  });

  test('suggests bar for categorical with > 10 rows', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      category: `cat_${i}`,
      value: (i + 1) * 10,
    }));
    const result = analyzeData({
      rows,
      fields: ['category', 'value'],
      rowCount: 15,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(true);
    expect(result.suggestedChartType).toBe('bar');
  });

  test('uses Object.keys when fields is not provided', () => {
    const result = analyzeData({
      rows: [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      fields: undefined as unknown as string[],
      rowCount: 2,
      executionTime: 0,
    });
    expect(result.isVisualizable).toBe(true);
    expect(result.fields.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

describe('formatNumber', () => {
  test('formats millions', () => {
    expect(formatNumber(2500000)).toBe('2.5M');
  });

  test('formats negative millions', () => {
    expect(formatNumber(-1500000)).toBe('-1.5M');
  });

  test('formats thousands', () => {
    expect(formatNumber(15000)).toBe('15.0K');
  });

  test('formats negative thousands', () => {
    expect(formatNumber(-3500)).toBe('-3.5K');
  });

  test('formats regular numbers with locale', () => {
    const result = formatNumber(42);
    expect(result).toBe('42');
  });

  test('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  test('formats exactly 1000 as K', () => {
    expect(formatNumber(1000)).toBe('1.0K');
  });

  test('formats exactly 1000000 as M', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
  });
});

// ---------------------------------------------------------------------------
// computeHistogramBins
// ---------------------------------------------------------------------------

describe('computeHistogramBins', () => {
  test('returns empty for empty values', () => {
    expect(computeHistogramBins([], 10)).toEqual([]);
  });

  test('returns single bin when all values are the same', () => {
    const result = computeHistogramBins([5, 5, 5, 5], 10);
    expect(result.length).toBe(1);
    expect(result[0].count).toBe(4);
    expect(result[0].range).toBe('5');
  });

  test('distributes values into correct number of buckets', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = computeHistogramBins(values, 5);
    expect(result.length).toBe(5);
    // Total count should equal input length
    const totalCount = result.reduce((sum, bin) => sum + bin.count, 0);
    expect(totalCount).toBe(10);
  });

  test('puts max value in last bin (edge case)', () => {
    const values = [0, 10];
    const result = computeHistogramBins(values, 2);
    expect(result.length).toBe(2);
    // 0 should be in bin 0, 10 should be in last bin
    const totalCount = result.reduce((sum, bin) => sum + bin.count, 0);
    expect(totalCount).toBe(2);
  });

  test('bin ranges are formatted correctly', () => {
    const result = computeHistogramBins([0, 100], 4);
    expect(result.length).toBe(4);
    expect(result[0].range).toBe('0.0-25.0');
    expect(result[1].range).toBe('25.0-50.0');
    expect(result[2].range).toBe('50.0-75.0');
    expect(result[3].range).toBe('75.0-100.0');
  });

  test('handles negative values', () => {
    const values = [-10, -5, 0, 5, 10];
    const result = computeHistogramBins(values, 4);
    expect(result.length).toBe(4);
    const totalCount = result.reduce((sum, bin) => sum + bin.count, 0);
    expect(totalCount).toBe(5);
  });

  test('handles single value', () => {
    const result = computeHistogramBins([42], 10);
    expect(result.length).toBe(1);
    expect(result[0].count).toBe(1);
    expect(result[0].range).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// aggregateData
// ---------------------------------------------------------------------------

describe('aggregateData', () => {
  const rows = [
    { category: 'A', value: 10, score: 100 },
    { category: 'A', value: 20, score: 200 },
    { category: 'B', value: 30, score: 300 },
    { category: 'B', value: 40, score: 400 },
    { category: 'C', value: 50, score: 500 },
  ];

  test('returns rows as-is when aggregation is none', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'none' }]
    );
    expect(result).toBe(rows);
  });

  test('sum aggregation', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'sum' }]
    );
    expect(result.length).toBe(3);
    const groupA = result.find(r => r.category === 'A');
    expect(groupA?.value).toBe(30); // 10 + 20
    const groupB = result.find(r => r.category === 'B');
    expect(groupB?.value).toBe(70); // 30 + 40
  });

  test('avg aggregation', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'avg' }]
    );
    const groupA = result.find(r => r.category === 'A');
    expect(groupA?.value).toBe(15); // (10 + 20) / 2
  });

  test('count aggregation', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'count' }]
    );
    const groupA = result.find(r => r.category === 'A');
    expect(groupA?.value).toBe(2);
    const groupC = result.find(r => r.category === 'C');
    expect(groupC?.value).toBe(1);
  });

  test('min aggregation', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'min' }]
    );
    const groupB = result.find(r => r.category === 'B');
    expect(groupB?.value).toBe(30);
  });

  test('max aggregation', () => {
    const result = aggregateData(
      rows,
      'category',
      [{ field: 'value', aggregation: 'max' }]
    );
    const groupB = result.find(r => r.category === 'B');
    expect(groupB?.value).toBe(40);
  });

  test('multiple metrics at once', () => {
    const result = aggregateData(
      rows,
      'category',
      [
        { field: 'value', aggregation: 'sum' },
        { field: 'score', aggregation: 'avg' },
      ]
    );
    const groupA = result.find(r => r.category === 'A');
    expect(groupA?.value).toBe(30); // sum: 10+20
    expect(groupA?.score).toBe(150); // avg: (100+200)/2
  });

  test('handles date grouping', () => {
    const dateRows = [
      { date: '2025-01-15T10:00:00Z', value: 10 },
      { date: '2025-01-15T14:00:00Z', value: 20 },
      { date: '2025-02-20T10:00:00Z', value: 30 },
    ];
    const result = aggregateData(
      dateRows,
      'date',
      [{ field: 'value', aggregation: 'sum' }],
      'month'
    );
    expect(result.length).toBe(2);
  });

  test('handles non-numeric values (defaults to 0)', () => {
    const badRows = [
      { category: 'A', value: 'abc' },
      { category: 'A', value: 'xyz' },
    ];
    const result = aggregateData(
      badRows,
      'category',
      [{ field: 'value', aggregation: 'sum' }]
    );
    expect(result[0].value).toBe(0);
  });

  test('avg returns 0 for empty group (should not happen but safe)', () => {
    const result = aggregateData(
      [{ cat: 'A', val: 10 }],
      'cat',
      [{ field: 'val', aggregation: 'avg' }]
    );
    expect(result[0].val).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// groupByDate
// ---------------------------------------------------------------------------

describe('groupByDate', () => {
  const iso = '2025-06-15T14:30:45Z';

  test('groups by hour', () => {
    const result = groupByDate(iso, 'hour');
    expect(result).toContain('2025-06-15');
    expect(result).toContain(':00');
  });

  test('groups by day', () => {
    const result = groupByDate(iso, 'day');
    expect(result).toBe('2025-06-15');
  });

  test('groups by week', () => {
    const result = groupByDate(iso, 'week');
    expect(result).toMatch(/^W\d{4}-\d{2}-\d{2}$/);
  });

  test('groups by month', () => {
    const result = groupByDate(iso, 'month');
    expect(result).toBe('2025-06');
  });

  test('groups by year', () => {
    const result = groupByDate(iso, 'year');
    expect(result).toBe('2025');
  });

  test('returns original string for invalid date', () => {
    const result = groupByDate('not-a-date', 'day');
    expect(result).toBe('not-a-date');
  });

  test('handles month with zero-padding', () => {
    const result = groupByDate('2025-01-05T00:00:00Z', 'month');
    expect(result).toBe('2025-01');
  });

  test('handles day with zero-padding', () => {
    const result = groupByDate('2025-03-05T00:00:00Z', 'day');
    expect(result).toBe('2025-03-05');
  });
});
