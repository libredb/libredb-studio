import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ── Mock Monaco Editor with React.createElement (not plain objects) ─────────
mock.module('@monaco-editor/react', () => ({
  default: function MockEditor(props: {
    value?: string;
    onChange?: (value: string | undefined) => void;
    language?: string;
    height?: string;
    theme?: string;
    loading?: React.ReactNode;
    onMount?: (...args: unknown[]) => void;
    beforeMount?: (...args: unknown[]) => void;
    options?: Record<string, unknown>;
  }) {
    return React.createElement('textarea', {
      'data-testid': 'mock-monaco-editor',
      value: props.value ?? '',
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(e.target.value),
      'aria-label': `${props.language ?? 'sql'} editor`,
    });
  },
  Editor: function MockEditor(props: {
    value?: string;
    onChange?: (value: string | undefined) => void;
    language?: string;
  }) {
    return React.createElement('textarea', {
      'data-testid': 'mock-monaco-editor',
      value: props.value ?? '',
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(e.target.value),
    });
  },
  loader: {
    init: mock(() => Promise.resolve()),
    config: mock(() => {}),
  },
  useMonaco: mock(() => null),
}));

// ── Mock framer-motion ──────────────────────────────────────────────────────
mock.module('framer-motion', () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', props, children as React.ReactNode);

  return {
    motion: new Proxy({}, {
      get: () => passthrough,
    }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// ── Mock use-ai-chat hook ───────────────────────────────────────────────────
const mockSetShowAi = mock(() => {});
const mockSetAiPrompt = mock(() => {});
const mockSetAiError = mock(() => {});
const mockSetAiConversationHistory = mock(() => {});
const mockHandleAiSubmit = mock(async () => {});
let mockShowAi = false;

mock.module('@/hooks/use-ai-chat', () => ({
  useAiChat: mock(() => ({
    showAi: mockShowAi,
    setShowAi: mockSetShowAi,
    aiPrompt: '',
    setAiPrompt: mockSetAiPrompt,
    isAiLoading: false,
    aiError: null,
    setAiError: mockSetAiError,
    aiConversationHistory: [],
    setAiConversationHistory: mockSetAiConversationHistory,
    handleAiSubmit: mockHandleAiSubmit,
  })),
}));

// ── Mock sql-formatter ──────────────────────────────────────────────────────
mock.module('sql-formatter', () => ({
  format: mock((sql: string) => sql),
}));

// ── Mock editor/sql-completions ─────────────────────────────────────────────
mock.module('@/lib/editor/sql-completions', () => ({
  registerSQLCompletionProvider: mock(() => ({ dispose: mock(() => {}) })),
}));

// ── Mock editor/mongodb-completions ─────────────────────────────────────────
mock.module('@/lib/editor/mongodb-completions', () => ({
  registerMongoDBCompletionProvider: mock(() => ({ dispose: mock(() => {}) })),
}));

// ── Mock lucide-react icons ─────────────────────────────────────────────────
mock.module('lucide-react', () => {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === '__esModule') return true;
      return (props: Record<string, unknown>) =>
        React.createElement('span', { 'data-icon': prop, className: props.className as string });
    },
  });
});

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { QueryEditor } from '@/components/QueryEditor';

// =============================================================================
// QueryEditor Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof QueryEditor>[0]> = {}) {
  return {
    value: 'SELECT * FROM users',
    onChange: mock(() => {}),
    language: 'sql' as const,
    tables: ['users', 'orders', 'products'],
    databaseType: 'postgres',
    schemaContext: JSON.stringify([
      { name: 'users', columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'varchar' }] },
    ]),
    ...overrides,
  };
}

describe('QueryEditor', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockShowAi = false;
    mockSetShowAi.mockClear();
    mockSetAiPrompt.mockClear();
    mockHandleAiSubmit.mockClear();
  });

  // ── 1. Renders editor area ────────────────────────────────────────────────

  test('renders editor area', () => {
    const props = createDefaultProps();
    const { queryByTestId } = render(React.createElement(QueryEditor, props));

    const editor = queryByTestId('mock-monaco-editor');
    expect(editor).not.toBeNull();
  });

  // ── 2. Shows language badge ───────────────────────────────────────────────

  test('shows language badge (SQL)', () => {
    const props = createDefaultProps({ language: 'sql' });
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('sql Engine')).not.toBeNull();
  });

  test('shows language badge (JSON)', () => {
    const props = createDefaultProps({ language: 'json' });
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('json Engine')).not.toBeNull();
  });

  // ── 3. AI toggle button renders ───────────────────────────────────────────

  test('AI ASSISTANT toggle button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('AI ASSISTANT')).not.toBeNull();
  });

  // ── 4. Format button renders for SQL mode ─────────────────────────────────

  test('FORMAT button renders', () => {
    const props = createDefaultProps({ language: 'sql' });
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('FORMAT')).not.toBeNull();
  });

  // ── 5. Renders with initial value prop ────────────────────────────────────

  test('renders with initial value prop', () => {
    const props = createDefaultProps({ value: 'SELECT 1' });
    const { queryByTestId } = render(React.createElement(QueryEditor, props));

    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();
    expect(editor!.value).toBe('SELECT 1');
  });

  // ── 6. COPY button renders ────────────────────────────────────────────────

  test('COPY button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('COPY')).not.toBeNull();
  });

  // ── 7. CLEAR button renders ───────────────────────────────────────────────

  test('CLEAR button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('CLEAR')).not.toBeNull();
  });

  // ── 8. Explain button appears when onExplain and capabilities provided ────

  test('EXPLAIN button appears when onExplain and capabilities.supportsExplain provided', () => {
    const props = createDefaultProps({
      onExplain: mock(() => {}),
      capabilities: {
        queryLanguage: 'sql',
        supportsExplain: true,
        supportsCreateTable: true,
        maintenanceOperations: [],
        supportsTransactions: true,
      },
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('EXPLAIN')).not.toBeNull();
  });

  test('EXPLAIN button does not appear without onExplain', () => {
    const props = createDefaultProps({
      onExplain: undefined,
      capabilities: {
        queryLanguage: 'sql',
        supportsExplain: true,
        supportsCreateTable: true,
        maintenanceOperations: [],
        supportsTransactions: true,
      },
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));

    expect(queryByText('EXPLAIN')).toBeNull();
  });
});
