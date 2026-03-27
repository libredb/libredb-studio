"use client";

import React, { useState, useMemo } from 'react';
import { Wand2, X, Play, Copy, Check, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableSchema } from '@/lib/types';

interface TestDataGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  tableSchema: TableSchema | null;
  databaseType?: string;
  queryLanguage?: string;
  onExecuteQuery: (query: string) => void;
}

function inferFakerType(colName: string, colType: string): { generator: string; example: string } {
  const name = colName.toLowerCase();
  const type = colType.toLowerCase();

  // Name-based inference
  if (name.includes('email')) return { generator: 'email', example: 'user@example.com' };
  if (name.includes('phone') || name.includes('mobile') || name.includes('tel')) return { generator: 'phone', example: '+1-555-0123' };
  if (name === 'first_name' || name === 'firstname') return { generator: 'firstName', example: 'John' };
  if (name === 'last_name' || name === 'lastname' || name === 'surname') return { generator: 'lastName', example: 'Doe' };
  if (name === 'name' || name === 'full_name' || name === 'fullname') return { generator: 'fullName', example: 'John Doe' };
  if (name.includes('address') || name.includes('street')) return { generator: 'address', example: '123 Main St' };
  if (name.includes('city')) return { generator: 'city', example: 'New York' };
  if (name.includes('country')) return { generator: 'country', example: 'United States' };
  if (name.includes('zip') || name.includes('postal')) return { generator: 'zipCode', example: '10001' };
  if (name.includes('state') || name.includes('province')) return { generator: 'state', example: 'California' };
  if (name.includes('url') || name.includes('website') || name.includes('link')) return { generator: 'url', example: 'https://example.com' };
  if (name.includes('company') || name.includes('organization') || name.includes('org')) return { generator: 'company', example: 'Acme Corp' };
  if (name.includes('title') || name.includes('subject')) return { generator: 'sentence', example: 'A brief title here' };
  if (name.includes('description') || name.includes('bio') || name.includes('about') || name.includes('content') || name.includes('body')) return { generator: 'paragraph', example: 'Lorem ipsum dolor sit amet...' };
  if (name.includes('avatar') || name.includes('image') || name.includes('photo') || name.includes('picture')) return { generator: 'imageUrl', example: 'https://picsum.photos/200' };
  if (name.includes('color') || name.includes('colour')) return { generator: 'color', example: '#3b82f6' };
  if (name.includes('ip')) return { generator: 'ip', example: '192.168.1.1' };
  if (name.includes('username') || name === 'login') return { generator: 'username', example: 'johndoe42' };
  if (name.includes('password') || name.includes('hash') || name.includes('token') || name.includes('secret')) return { generator: 'hash', example: 'a1b2c3d4e5f6...' };
  if (name.includes('price') || name.includes('amount') || name.includes('cost') || name.includes('total') || name.includes('salary')) return { generator: 'price', example: '99.99' };
  if (name.includes('age')) return { generator: 'age', example: '28' };
  if (name.includes('status')) return { generator: 'status', example: 'active' };
  if (name.includes('gender') || name.includes('sex')) return { generator: 'gender', example: 'male' };

  // Type-based inference
  if (type.includes('serial') || name === 'id' || name.endsWith('_id')) return { generator: 'autoIncrement', example: '1' };
  if (type.includes('bool')) return { generator: 'boolean', example: 'true' };
  if (type.includes('int')) return { generator: 'integer', example: '42' };
  if (type.includes('float') || type.includes('double') || type.includes('decimal') || type.includes('numeric')) return { generator: 'decimal', example: '3.14' };
  if (type.includes('date') && !type.includes('time')) return { generator: 'date', example: '2024-03-15' };
  if (type.includes('time')) return { generator: 'datetime', example: '2024-03-15 14:30:00' };
  if (type.includes('uuid')) return { generator: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' };
  if (type.includes('json')) return { generator: 'json', example: '{}' };

  return { generator: 'text', example: 'Lorem ipsum' };
}

// Lightweight fake data generators
const FAKE = {
  autoIncrement: (i: number) => String(i + 1),
  email: (i: number) => `user${i + 1}@example.com`,
  phone: () => `+1-555-${String(Math.floor(Math.random() * 9000) + 1000)}`,
  firstName: () => ['John', 'Jane', 'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry'][Math.floor(Math.random() * 10)],
  lastName: () => ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor'][Math.floor(Math.random() * 10)],
  fullName: () => `${FAKE.firstName()} ${FAKE.lastName()}`,
  address: (i: number) => `${(i + 1) * 100} ${['Main', 'Oak', 'Pine', 'Elm', 'Maple'][Math.floor(Math.random() * 5)]} St`,
  city: () => ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'London', 'Paris', 'Berlin', 'Tokyo', 'Sydney'][Math.floor(Math.random() * 10)],
  country: () => ['United States', 'United Kingdom', 'Canada', 'Germany', 'France', 'Japan', 'Australia', 'Brazil'][Math.floor(Math.random() * 8)],
  zipCode: () => String(Math.floor(Math.random() * 90000) + 10000),
  state: () => ['California', 'New York', 'Texas', 'Florida', 'Illinois', 'Pennsylvania', 'Ohio', 'Georgia'][Math.floor(Math.random() * 8)],
  url: (i: number) => `https://example.com/page/${i + 1}`,
  company: () => ['Acme Corp', 'TechStart', 'GlobalSync', 'NovaTech', 'DataFlow', 'CloudPeak', 'ByteWise', 'NetSphere'][Math.floor(Math.random() * 8)],
  sentence: () => ['Quick update needed', 'New feature request', 'Bug fix applied', 'Performance review', 'System maintenance'][Math.floor(Math.random() * 5)],
  paragraph: () => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
  imageUrl: (i: number) => `https://picsum.photos/200?id=${i}`,
  color: () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
  ip: () => `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
  username: (i: number) => `user_${String.fromCharCode(97 + (i % 26))}${Math.floor(Math.random() * 100)}`,
  hash: () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
  price: () => (Math.random() * 999 + 0.01).toFixed(2),
  age: () => String(Math.floor(Math.random() * 60) + 18),
  status: () => ['active', 'inactive', 'pending', 'archived'][Math.floor(Math.random() * 4)],
  gender: () => ['male', 'female', 'non-binary'][Math.floor(Math.random() * 3)],
  boolean: () => Math.random() > 0.5 ? 'true' : 'false',
  integer: () => String(Math.floor(Math.random() * 10000)),
  decimal: () => (Math.random() * 1000).toFixed(2),
  date: () => { const d = new Date(Date.now() - Math.random() * 365 * 86400000); return d.toISOString().split('T')[0]; },
  datetime: () => { const d = new Date(Date.now() - Math.random() * 365 * 86400000); return d.toISOString().replace('T', ' ').substring(0, 19); },
  uuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }),
  json: () => '{}',
  text: () => ['Sample text', 'Test data', 'Example value', 'Test content', 'Placeholder'][Math.floor(Math.random() * 5)],
};

export function TestDataGenerator({
  isOpen,
  onClose,
  tableName,
  tableSchema,
  queryLanguage,
  onExecuteQuery,
}: TestDataGeneratorProps) {
  const [rowCount, setRowCount] = useState(10);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const columnConfigs = useMemo(() => {
    if (!tableSchema?.columns) return [];
    return tableSchema.columns.map(col => ({
      ...col,
      faker: inferFakerType(col.name, col.type),
    }));
  }, [tableSchema]);

  const generatedQuery = useMemo(() => {
    if (!tableSchema?.columns || columnConfigs.length === 0) return '';

    // Filter out auto-increment columns
    const cols = columnConfigs.filter(c => c.faker.generator !== 'autoIncrement');

    if (queryLanguage === 'json') {
      // MongoDB insertMany
      const docs = Array.from({ length: rowCount }, (_, i) => {
        const doc: Record<string, string> = {};
        for (const col of cols) {
          const gen = FAKE[col.faker.generator as keyof typeof FAKE];
          doc[col.name] = gen ? gen(i) : `value_${i}`;
        }
        return doc;
      });
      return JSON.stringify({ collection: tableName, operation: 'insertMany', documents: docs }, null, 2);
    }

    // SQL INSERT
    const colNames = cols.map(c => `"${c.name}"`).join(', ');
    const rows = Array.from({ length: rowCount }, (_, i) => {
      const values = cols.map(col => {
        const gen = FAKE[col.faker.generator as keyof typeof FAKE];
        const val = gen ? gen(i) : `value_${i}`;
        // Determine if value should be quoted
        const type = col.type.toLowerCase();
        if (type.includes('bool')) return val;
        if (type.includes('int') || type.includes('float') || type.includes('double') || type.includes('decimal') || type.includes('numeric') || type.includes('real')) return val;
        return `'${val.replace(/'/g, "''")}'`;
      });
      return `(${values.join(', ')})`;
    });

    return `INSERT INTO ${tableName} (${colNames})\nVALUES\n  ${rows.join(',\n  ')};`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableSchema, columnConfigs, rowCount, queryLanguage, tableName, refreshKey]);

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedQuery);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#111] border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Wand2 strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-medium text-zinc-200">Test Data Generator</span>
            <span className="text-xs text-zinc-500 font-mono">{tableName}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-zinc-500">
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 border-b border-white/5 bg-[#0a0a0a] flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500r font-medium">Rows:</span>
            <div className="flex items-center gap-1">
              {[5, 10, 25, 50, 100].map(n => (
                <button
                  key={n}
                  onClick={() => setRowCount(n)}
                  className={cn(
                    "px-2 py-0.5 rounded text-xs font-medium transition-colors",
                    rowCount === n
                      ? "bg-amber-500/20 text-amber-400 border border-amber-500/20"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            title="Regenerate random data"
          >
            <RefreshCw strokeWidth={1.5} className="w-3 h-3" /> Regenerate
          </button>
        </div>

        {/* Column mapping preview */}
        <div className="px-5 py-2 border-b border-white/5 bg-[#0a0a0a]">
          <div className="flex flex-wrap gap-1.5">
            {columnConfigs.map(col => (
              <span
                key={col.name}
                className={cn(
                  "text-xs px-1.5 py-0.5 rounded font-mono",
                  col.faker.generator === 'autoIncrement'
                    ? "bg-zinc-800 text-zinc-600 line-through"
                    : "bg-amber-500/10 text-amber-400/80"
                )}
                title={`${col.name} → ${col.faker.generator} (e.g., ${col.faker.example})`}
              >
                {col.name}: {col.faker.generator}
              </span>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 overflow-auto relative">
          <pre className="p-5 text-xs font-mono text-blue-300 whitespace-pre-wrap leading-relaxed">
            {generatedQuery}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/5 bg-[#0a0a0a]">
          <p className="text-xs text-zinc-600">
            {columnConfigs.filter(c => c.faker.generator !== 'autoIncrement').length} columns • {rowCount} rows
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 text-xs font-medium hover:bg-white/10 transition-colors"
            >
              {copied ? <Check strokeWidth={1.5} className="w-3 h-3 text-emerald-400" /> : <Copy strokeWidth={1.5} className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={() => {
                onExecuteQuery(generatedQuery);
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors"
            >
              <Play strokeWidth={1.5} className="w-3 h-3 fill-current" /> Execute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
