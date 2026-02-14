import type { QueryResult } from '@/lib/types';

export const mockSelectResult: QueryResult = {
  rows: [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
    { id: 3, name: 'Charlie', email: 'charlie@example.com' },
  ],
  fields: ['id', 'name', 'email'],
  rowCount: 3,
  executionTime: 12,
};

export const mockEmptyResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 0,
  executionTime: 1,
};

export const mockInsertResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 1,
  executionTime: 5,
};

export const mockPaginatedResult: QueryResult = {
  rows: Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
  })),
  fields: ['id', 'name', 'email'],
  rowCount: 50,
  executionTime: 25,
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true,
    totalReturned: 50,
    wasLimited: true,
  },
};

export const mockExplainResult: QueryResult = {
  rows: [
    { 'QUERY PLAN': 'Seq Scan on users  (cost=0.00..10.00 rows=100 width=540)' },
  ],
  fields: ['QUERY PLAN'],
  rowCount: 1,
  executionTime: 2,
  explainPlan: {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      'Total Cost': 10.0,
      'Plan Rows': 100,
    },
  },
};

export const mockSensitiveDataResult: QueryResult = {
  rows: [
    { id: 1, name: 'Alice', email: 'alice@example.com', ssn: '123-45-6789', salary: '85000.00' },
    { id: 2, name: 'Bob', email: 'bob@test.com', ssn: '987-65-4321', salary: '92000.00' },
  ],
  fields: ['id', 'name', 'email', 'ssn', 'salary'],
  rowCount: 2,
  executionTime: 8,
};
