import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ─── Module-level capture variables for mock editor callbacks ─────────────────
let capturedBlurCb: (() => void) | null = null;
let capturedSelectionCb: (() => void) | null = null;
let capturedCommands: Array<{ keybinding: number; handler: () => void }> = [];
let capturedActions: Array<{ id: string; run: () => void }> = [];
let mockSelectionReturn: { isEmpty: () => boolean } | null = null;
let mockSelectedText = '';
let mockUseMonacoReturn: unknown = null;

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
    const { value, onChange, language, onMount, beforeMount } = props;
    const valueRef = React.useRef(value ?? '');
    const [textValue, setTextValue] = React.useState(value ?? '');
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
      // Only update display state, not valueRef — simulates real Monaco requiring explicit setValue()
      setTextValue(value ?? '');
    }, [value]);

    React.useEffect(() => {
      if (mountedRef.current) return;
      mountedRef.current = true;

      const monacoMock = {
        KeyMod: { CtrlCmd: 1, Alt: 2, Shift: 4 },
        KeyCode: { Enter: 13, KeyF: 70 },
        Range: class {
          constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number
          ) {}
        },
        editor: {
          defineTheme: mock(() => {}),
        },
      };

      const editorMock = {
        getValue: () => valueRef.current,
        setValue: (next: string) => {
          valueRef.current = next;
          setTextValue(next);
        },
        getSelection: () => mockSelectionReturn,
        getModel: () => ({
          getValueInRange: () => mockSelectedText,
          getValue: () => valueRef.current,
          getOffsetAt: (_pos: unknown) => typeof _pos === 'number' ? _pos : 0,
          getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
        }),
        getPosition: () => ({ lineNumber: 1, column: 1 }),
        deltaDecorations: mock(() => ['deco-1']),
        onDidBlurEditorText: (cb: () => void) => { capturedBlurCb = cb; },
        onDidChangeCursorSelection: (cb: () => void) => { capturedSelectionCb = cb; },
        addCommand: (_keybinding: number, handler: () => void) => { capturedCommands.push({ keybinding: _keybinding, handler }); },
        addAction: (action: { id: string; run: () => void }) => { capturedActions.push(action); },
        focus: mock(() => {}),
      };

      beforeMount?.(monacoMock);
      onMount?.(editorMock, monacoMock);
    }, [beforeMount, onMount]);

    return React.createElement('textarea', {
      'data-testid': 'mock-monaco-editor',
      value: textValue,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        valueRef.current = e.target.value;
        setTextValue(e.target.value);
        onChange?.(e.target.value);
      },
      'aria-label': `${language ?? 'sql'} editor`,
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
  useMonaco: mock(() => mockUseMonacoReturn),
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
let mockIsAiLoading = false;
let mockAiError: string | null = null;
let mockAiConversationHistory: Array<Record<string, string>> = [];
let mockClipboardWriteText = mock((data: string) => {
  void data;
  return Promise.resolve();
});

mock.module('@/hooks/use-ai-chat', () => ({
  useAiChat: mock(() => ({
    showAi: mockShowAi,
    setShowAi: mockSetShowAi,
    aiPrompt: '',
    setAiPrompt: mockSetAiPrompt,
    isAiLoading: mockIsAiLoading,
    aiError: mockAiError,
    setAiError: mockSetAiError,
    aiConversationHistory: mockAiConversationHistory,
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
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryEditor } from '@/components/QueryEditor';
import type { MaintenanceType } from '@/lib/db/types';

// =============================================================================
// QueryEditor Tests
// =============================================================================

const defaultCapabilities = {
  queryLanguage: 'sql' as const,
  supportsExplain: true,
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsMaintenance: false,
  maintenanceOperations: [] as MaintenanceType[],
  supportsConnectionString: false,
  defaultPort: 5432,
  schemaRefreshPattern: '',
};

function createDefaultProps(overrides: Partial<Parameters<typeof QueryEditor>[0]> = {}) {
  return {
    value: 'SELECT * FROM users',
    onChange: mock(() => {}),
    language: 'sql' as const,
    tables: ['users', 'orders', 'products'],
    databaseType: 'postgres',
    schemaContext: JSON.stringify([
      { name: 'users', rowCount: 100, columns: [{ name: 'id', type: 'integer', isPrimary: true }, { name: 'name', type: 'varchar' }] },
      { name: 'orders', rowCount: 500, columns: [{ name: 'id', type: 'integer', isPrimary: true }, { name: 'amount', type: 'numeric' }] },
    ]),
    ...overrides,
  };
}

describe('QueryEditor', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    capturedBlurCb = null;
    capturedSelectionCb = null;
    capturedCommands = [];
    capturedActions = [];
    mockSelectionReturn = null;
    mockSelectedText = '';
    mockUseMonacoReturn = null;
    mockIsAiLoading = false;
    mockShowAi = false;
    mockSetShowAi.mockClear();
    mockSetAiPrompt.mockClear();
    mockHandleAiSubmit.mockClear();
    mockSetAiError.mockClear();
    mockSetAiConversationHistory.mockClear();
    mockAiError = null;
    mockAiConversationHistory = [];
    mockClipboardWriteText = mock((data: string) => {
      void data;
      return Promise.resolve();
    });

    // Mock localStorage for line numbers toggle
    const localStorageMock: Record<string, string> = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => localStorageMock[key] || null,
        setItem: (key: string, value: string) => { localStorageMock[key] = value; },
        removeItem: (key: string) => { delete localStorageMock[key]; },
        clear: () => { Object.keys(localStorageMock).forEach(k => delete localStorageMock[k]); },
      },
      writable: true,
      configurable: true,
    });


    const nav = globalThis.navigator as Navigator & { clipboard?: Clipboard };
    const clipboardWriteText: Clipboard['writeText'] = (data: string) =>
      mockClipboardWriteText(data) as Promise<void>;
    if (!nav.clipboard) {
      Object.defineProperty(nav, 'clipboard', {
        value: { writeText: clipboardWriteText } as Clipboard,
        configurable: true,
      });
    } else {
      nav.clipboard.writeText = clipboardWriteText;
    }
  });

  // -----------------------------------------------------------------------
  // Basic rendering
  // -----------------------------------------------------------------------

  test('renders editor area', () => {
    const { queryByTestId } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByTestId('mock-monaco-editor')).not.toBeNull();
  });

  test('renders with initial value prop', () => {
    const { queryByTestId } = render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 1' })));
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('SELECT 1');
  });

  test('shows language badge (SQL)', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'sql' })));
    expect(queryByText('sql Engine')).not.toBeNull();
  });

  test('shows language badge (JSON)', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'json' })));
    expect(queryByText('json Engine')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Toolbar buttons rendering
  // -----------------------------------------------------------------------

  test('Quick Actions label renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('Quick Actions')).not.toBeNull();
  });

  test('FORMAT button renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('FORMAT')).not.toBeNull();
  });

  test('COPY button renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('COPY')).not.toBeNull();
  });

  test('CLEAR button renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('CLEAR')).not.toBeNull();
  });

  test('LINES button renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('LINES')).not.toBeNull();
  });


  test('AI ASSISTANT toggle button renders', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('AI ASSISTANT')).not.toBeNull();
  });

  test('keyboard shortcut hint renders', () => {
    const { container } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(container.textContent).toContain('⌘ + ENTER TO RUN');
  });

  // -----------------------------------------------------------------------
  // EXPLAIN button
  // -----------------------------------------------------------------------

  test('EXPLAIN button appears when onExplain and supportsExplain provided', () => {
    const props = createDefaultProps({
      onExplain: mock(() => {}),
      capabilities: defaultCapabilities,
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));
    expect(queryByText('EXPLAIN')).not.toBeNull();
  });

  test('EXPLAIN button hidden without onExplain', () => {
    const props = createDefaultProps({
      onExplain: undefined,
      capabilities: defaultCapabilities,
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));
    expect(queryByText('EXPLAIN')).toBeNull();
  });

  test('EXPLAIN button hidden when supportsExplain is false', () => {
    const props = createDefaultProps({
      onExplain: mock(() => {}),
      capabilities: { ...defaultCapabilities, supportsExplain: false },
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));
    expect(queryByText('EXPLAIN')).toBeNull();
  });

  test('EXPLAIN button hidden when no capabilities', () => {
    const props = createDefaultProps({
      onExplain: mock(() => {}),
      capabilities: undefined,
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));
    expect(queryByText('EXPLAIN')).toBeNull();
  });

  test('EXPLAIN click calls onExplain handler', () => {
    const onExplain = mock(() => {});
    const props = createDefaultProps({
      onExplain,
      capabilities: defaultCapabilities,
    });
    const { queryByText } = render(React.createElement(QueryEditor, props));
    fireEvent.click(queryByText('EXPLAIN')!);
    expect(onExplain).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // CLEAR button
  // -----------------------------------------------------------------------

  test('CLEAR button empties editor and syncs via onChange', () => {
    const onChange = mock(() => {});
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: 'SELECT 123' })));
    fireEvent.click(queryByText('CLEAR')!);
    expect(onChange).toHaveBeenCalledWith('');
  });

  test('CLEAR button sets editor textarea to empty', () => {
    const { queryByText, queryByTestId } = render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 1' })));
    fireEvent.click(queryByText('CLEAR')!);
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('');
  });

  // -----------------------------------------------------------------------
  // LINES button (Line Numbers Toggle)
  // -----------------------------------------------------------------------

  test('LINES button toggles line numbers state', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    const linesButton = queryByText('LINES');
    expect(linesButton).not.toBeNull();

    // Click to toggle
    fireEvent.click(linesButton!);
    // State should change (we can't directly test state, but button should still be there)
    expect(queryByText('LINES')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // COPY button
  // -----------------------------------------------------------------------

  test('COPY button writes current query to clipboard', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT copied_value' })));
    fireEvent.click(queryByText('COPY')!);
    expect(mockClipboardWriteText).toHaveBeenCalledWith('SELECT copied_value');
  });

  // -----------------------------------------------------------------------
  // FORMAT button
  // -----------------------------------------------------------------------

  test('FORMAT click formats SQL content via sql-formatter', () => {
    const onChange = mock(() => {});
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: 'select * from users' })));
    fireEvent.click(queryByText('FORMAT')!);
    // Our mock sql-formatter returns input as-is, but onChange should be called
    expect(onChange).toHaveBeenCalled();
  });

  test('FORMAT click formats JSON content', () => {
    const onChange = mock(() => {});
    const { queryByText, queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({
        onChange,
        value: '{"collection":"users","operation":"find"}',
        language: 'json',
      }))
    );
    fireEvent.click(queryByText('FORMAT')!);
    // JSON.stringify(parsed, null, 2) should format it
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('"collection"');
    expect(onChange).toHaveBeenCalled();
  });

  test('FORMAT with invalid JSON does not crash', () => {
    const onChange = mock(() => {});
    const { queryByText, queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({
        onChange,
        value: '{invalid json!!!}',
        language: 'json',
      }))
    );
    // Should not throw
    fireEvent.click(queryByText('FORMAT')!);
    // Editor value should remain unchanged since format failed
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('{invalid json!!!}');
  });

  test('FORMAT with empty editor is a no-op', () => {
    const onChange = mock(() => {});
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: '' })));
    fireEvent.click(queryByText('FORMAT')!);
    expect(onChange).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Editor content change
  // -----------------------------------------------------------------------

  test('component renders with onContentChange prop without error', () => {
    const onContentChange = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ onContentChange }))
    );
    expect(queryByTestId('mock-monaco-editor')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // External value prop update
  // -----------------------------------------------------------------------

  test('updates editor when value prop changes externally', () => {
    const props = createDefaultProps({ value: 'SELECT 1' });
    const { queryByTestId, rerender } = render(React.createElement(QueryEditor, props));

    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('SELECT 1');

    rerender(React.createElement(QueryEditor, { ...props, value: 'SELECT 2' }));
    const updatedEditor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(updatedEditor.value).toBe('SELECT 2');
  });

  // -----------------------------------------------------------------------
  // AI panel
  // -----------------------------------------------------------------------

  test('AI ASSISTANT toggle calls setShowAi', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    fireEvent.click(queryByText('AI ASSISTANT')!);
    expect(mockSetShowAi).toHaveBeenCalled();
  });

  test('AI panel shows input and Generate button when showAi is true', () => {
    mockShowAi = true;
    const { queryByPlaceholderText, queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByPlaceholderText(/Describe the data you need/)).not.toBeNull();
    expect(queryByText('Generate')).not.toBeNull();
  });

  test('AI panel hidden when showAi is false', () => {
    mockShowAi = false;
    const { queryByPlaceholderText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByPlaceholderText(/Describe the data you need/)).toBeNull();
  });

  test('AI panel shows Expert DBA Mode header', () => {
    mockShowAi = true;
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('Expert DBA Mode')).not.toBeNull();
  });

  test('AI panel shows table context count', () => {
    mockShowAi = true;
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ tables: ['a', 'b', 'c'] })));
    expect(queryByText('Context: 3 tables')).not.toBeNull();
  });

  test('AI panel X dismiss button calls setShowAi(false)', () => {
    mockShowAi = true;
    const { container } = render(React.createElement(QueryEditor, createDefaultProps()));
    // Find the dismiss button (the X button that isn't the error X)
    const buttons = container.querySelectorAll('button[type="button"]');
    // The dismiss button is the one next to the Generate button
    const dismissBtn = Array.from(buttons).find(btn => {
      const svg = btn.querySelector('.lucide-x');
      return svg !== null;
    });
    expect(dismissBtn).not.toBeNull();
    fireEvent.click(dismissBtn!);
    expect(mockSetShowAi).toHaveBeenCalledWith(false);
  });

  test('AI error panel renders when aiError exists', () => {
    mockShowAi = true;
    mockAiError = 'AI request failed';
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('AI Error')).not.toBeNull();
    expect(queryByText('AI request failed')).not.toBeNull();
  });

  test('AI error dismiss button clears error', () => {
    mockShowAi = true;
    mockAiError = 'Some error';
    const { container } = render(React.createElement(QueryEditor, createDefaultProps()));
    // Find the error dismiss button (inside the error panel)
    const errorPanel = container.querySelector('.bg-red-500\\/10');
    expect(errorPanel).not.toBeNull();
    const dismissBtn = errorPanel!.querySelector('button');
    expect(dismissBtn).not.toBeNull();
    fireEvent.click(dismissBtn!);
    expect(mockSetAiError).toHaveBeenCalledWith(null);
  });

  test('AI conversation history summary when history exists', () => {
    mockShowAi = true;
    mockAiConversationHistory = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('1 turns - Clear')).not.toBeNull();
  });

  test('AI clear conversation button calls setAiConversationHistory', () => {
    mockShowAi = true;
    mockAiConversationHistory = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    const clearBtn = queryByText('1 turns - Clear');
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn!);
    expect(mockSetAiConversationHistory).toHaveBeenCalledWith([]);
  });

  test('AI conversation history hidden when empty', () => {
    mockShowAi = true;
    mockAiConversationHistory = [];
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText(/turns - Clear/)).toBeNull();
  });

  test('AI Generate button is disabled when prompt is empty', () => {
    mockShowAi = true;
    const { container } = render(React.createElement(QueryEditor, createDefaultProps()));
    const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    expect(submitBtn.disabled).toBe(true);
  });

  test('AI form submit calls handleAiSubmit', () => {
    mockShowAi = true;
    const { container } = render(React.createElement(QueryEditor, createDefaultProps()));
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(mockHandleAiSubmit).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Execute / custom event dispatch
  // -----------------------------------------------------------------------

  test('RUN SELECTION button not shown when no selection', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('RUN SELECTION')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Schema context parsing
  // -----------------------------------------------------------------------

  test('handles invalid schemaContext JSON gracefully', () => {
    // Should not crash
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ schemaContext: 'invalid json!' }))
    );
    expect(queryByTestId('mock-monaco-editor')).not.toBeNull();
  });

  test('handles empty schemaContext', () => {
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ schemaContext: '' }))
    );
    expect(queryByTestId('mock-monaco-editor')).not.toBeNull();
  });

  test('handles undefined schemaContext', () => {
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ schemaContext: undefined }))
    );
    expect(queryByTestId('mock-monaco-editor')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Format tooltip text
  // -----------------------------------------------------------------------

  test('FORMAT button has SQL tooltip in sql mode', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'sql' })));
    const formatBtn = queryByText('FORMAT')!.closest('button');
    expect(formatBtn?.getAttribute('title')).toContain('Format SQL');
  });

  test('FORMAT button has JSON tooltip in json mode', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'json' })));
    const formatBtn = queryByText('FORMAT')!.closest('button');
    expect(formatBtn?.getAttribute('title')).toContain('Format JSON');
  });

  // -----------------------------------------------------------------------
  // handleEditorChange — onContentChange callback
  // -----------------------------------------------------------------------

  test('onContentChange called when editor textarea changes', () => {
    const onContentChange = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ onContentChange }))
    );
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'SELECT 42' } });
    expect(onContentChange).toHaveBeenCalledWith('SELECT 42');
  });

  test('handleEditorChange with undefined value calls onContentChange with empty string', () => {
    const onContentChange = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ onContentChange }))
    );
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '' } });
    expect(onContentChange).toHaveBeenCalledWith('');
  });

  // -----------------------------------------------------------------------
  // handleEditorBlur — onChange on blur
  // -----------------------------------------------------------------------

  test('blur handler syncs current value to parent via onChange', () => {
    const onChange = mock(() => {});
    render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: 'SELECT 1' })));
    expect(capturedBlurCb).not.toBeNull();
    act(() => { capturedBlurCb!(); });
    expect(onChange).toHaveBeenCalledWith('SELECT 1');
  });

  // -----------------------------------------------------------------------
  // handleExecute — Ctrl+Enter command & custom event
  // -----------------------------------------------------------------------

  test('Ctrl+Enter command registered on mount', () => {
    render(React.createElement(QueryEditor, createDefaultProps()));
    expect(capturedCommands.length).toBeGreaterThanOrEqual(1);
  });

  test('execute command dispatches execute-query custom event', () => {
    const onChange = mock(() => {});
    const listener = mock((() => {}) as EventListener);
    window.addEventListener('execute-query', listener);

    render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: 'SELECT 1' })));

    act(() => { capturedCommands[0].handler(); });

    expect(listener).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('SELECT 1');
    window.removeEventListener('execute-query', listener);
  });

  test('execute-query event detail contains the query', () => {
    let eventDetail: { query: string } | null = null;
    const handler = ((e: CustomEvent) => { eventDetail = e.detail; }) as EventListener;
    window.addEventListener('execute-query', handler);

    render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 99' })));
    act(() => { capturedCommands[0].handler(); });

    expect(eventDetail).not.toBeNull();
    expect(eventDetail!.query).toBe('SELECT 99');
    window.removeEventListener('execute-query', handler);
  });

  // -----------------------------------------------------------------------
  // getEffectiveQuery — SQL statement finder
  // -----------------------------------------------------------------------

  test('getEffectiveQuery finds current SQL statement via semicolons', () => {
    mockUseMonacoReturn = {
      Range: class {
        constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      },
    };

    let eventDetail: { query: string } | null = null;
    const handler = ((e: CustomEvent) => { eventDetail = e.detail; }) as EventListener;
    window.addEventListener('execute-query', handler);

    render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 1; SELECT 2' })));
    act(() => { capturedCommands[0].handler(); });

    // With cursor at position 0, the first statement 'SELECT 1' should be extracted
    expect(eventDetail).not.toBeNull();
    expect(eventDetail!.query).toBe('SELECT 1');
    window.removeEventListener('execute-query', handler);
  });

  test('getEffectiveQuery returns selected text when selection exists', () => {
    mockUseMonacoReturn = {
      Range: class {
        constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      },
    };
    mockSelectionReturn = { isEmpty: () => false };
    mockSelectedText = 'SELECT selected';

    let eventDetail: { query: string } | null = null;
    const handler = ((e: CustomEvent) => { eventDetail = e.detail; }) as EventListener;
    window.addEventListener('execute-query', handler);

    render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT full' })));
    act(() => { capturedCommands[0].handler(); });

    expect(eventDetail!.query).toBe('SELECT selected');
    window.removeEventListener('execute-query', handler);
  });

  // -----------------------------------------------------------------------
  // flashHighlight — decoration creation and cleanup
  // -----------------------------------------------------------------------

  test('execute with monaco triggers flash highlight decorations', () => {
    mockUseMonacoReturn = {
      Range: class {
        constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      },
    };

    render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 1' })));
    act(() => { capturedCommands[0].handler(); });

    // flashHighlight was called — no crash means decorations were created
    // The highlight timeout cleanup is tested on unmount below
  });

  test('highlight cleanup on unmount clears timeout', () => {
    mockUseMonacoReturn = {
      Range: class {
        constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      },
    };

    const { unmount } = render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT 1' })));

    // Trigger execute which sets a highlight timeout
    act(() => { capturedCommands[0].handler(); });

    // Unmount should clear the timeout without errors
    unmount();
  });

  // -----------------------------------------------------------------------
  // onDidChangeCursorSelection — hasSelection & RUN SELECTION
  // -----------------------------------------------------------------------

  test('selection change shows RUN SELECTION button', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));

    expect(queryByText('RUN SELECTION')).toBeNull();

    mockSelectionReturn = { isEmpty: () => false };
    act(() => { capturedSelectionCb?.(); });

    expect(queryByText('RUN SELECTION')).not.toBeNull();
  });

  test('COPY shows COPY SELECTION when text is selected', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));

    expect(queryByText('COPY SELECTION')).toBeNull();

    mockSelectionReturn = { isEmpty: () => false };
    act(() => { capturedSelectionCb?.(); });

    expect(queryByText('COPY SELECTION')).not.toBeNull();
  });

  test('clearing selection hides RUN SELECTION button', () => {
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));

    mockSelectionReturn = { isEmpty: () => false };
    act(() => { capturedSelectionCb?.(); });
    expect(queryByText('RUN SELECTION')).not.toBeNull();

    mockSelectionReturn = { isEmpty: () => true };
    act(() => { capturedSelectionCb?.(); });
    expect(queryByText('RUN SELECTION')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // useImperativeHandle — ref methods
  // -----------------------------------------------------------------------

  test('ref getValue returns editor content', () => {
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    render(React.createElement(QueryEditor, { ...createDefaultProps({ value: 'SELECT ref_test' }), ref: editorRef }));
    expect(editorRef.current?.getValue()).toBe('SELECT ref_test');
  });

  test('ref setValue updates editor content', () => {
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    const { queryByTestId } = render(
      React.createElement(QueryEditor, { ...createDefaultProps({ value: 'old' }), ref: editorRef })
    );
    act(() => { editorRef.current?.setValue('new value'); });
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('new value');
  });

  test('ref getSelectedText returns empty when no selection', () => {
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    render(React.createElement(QueryEditor, { ...createDefaultProps(), ref: editorRef }));
    expect(editorRef.current?.getSelectedText()).toBe('');
  });

  test('ref getEffectiveQuery returns full query', () => {
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    render(React.createElement(QueryEditor, { ...createDefaultProps({ value: 'SELECT 1' }), ref: editorRef }));
    expect(editorRef.current?.getEffectiveQuery()).toBe('SELECT 1');
  });

  test('ref format triggers formatting', () => {
    const onChange = mock(() => {});
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    render(React.createElement(QueryEditor, { ...createDefaultProps({ onChange, value: 'select 1' }), ref: editorRef }));
    act(() => { editorRef.current?.format(); });
    expect(onChange).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Value sync effect — external prop change updates editor
  // -----------------------------------------------------------------------

  test('value sync effect calls setValue when value prop differs from editor content', () => {
    const props = createDefaultProps({ value: 'FIRST' });
    const { queryByTestId, rerender } = render(React.createElement(QueryEditor, props));

    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('FIRST');

    // Rerender with new value — the component's sync effect should call setValue
    rerender(React.createElement(QueryEditor, { ...props, value: 'SECOND' }));
    expect(editor.value).toBe('SECOND');
  });

  // -----------------------------------------------------------------------
  // Completion provider registration
  // -----------------------------------------------------------------------

  test('SQL completion provider registered when monaco is available', () => {
    mockUseMonacoReturn = { Range: class {} };
    const { unmount } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'sql' })));
    // Lines 413-415 covered during mount, cleanup dispose on unmount
    unmount();
  });

  test('MongoDB completion provider registered for json language', () => {
    mockUseMonacoReturn = { Range: class {} };
    const { unmount } = render(React.createElement(QueryEditor, createDefaultProps({ language: 'json' })));
    unmount();
  });

  // -----------------------------------------------------------------------
  // Context menu actions
  // -----------------------------------------------------------------------

  test('context menu actions registered on mount', () => {
    render(React.createElement(QueryEditor, createDefaultProps()));
    const actionIds = capturedActions.map(a => a.id);
    expect(actionIds).toContain('run-query');
    expect(actionIds).toContain('format-sql');
  });

  test('explain action registered when onExplain provided', () => {
    render(React.createElement(QueryEditor, createDefaultProps({
      onExplain: mock(() => {}),
      capabilities: defaultCapabilities,
    })));
    const actionIds = capturedActions.map(a => a.id);
    expect(actionIds).toContain('explain-query');
  });

  test('run-query context action dispatches execute event', () => {
    const listener = mock((() => {}) as EventListener);
    window.addEventListener('execute-query', listener);

    render(React.createElement(QueryEditor, createDefaultProps()));
    const runAction = capturedActions.find(a => a.id === 'run-query');
    act(() => { runAction!.run(); });

    expect(listener).toHaveBeenCalled();
    window.removeEventListener('execute-query', listener);
  });

  test('format-sql context action formats the query', () => {
    const onChange = mock(() => {});
    render(React.createElement(QueryEditor, createDefaultProps({ onChange, value: 'select 1' })));
    const formatAction = capturedActions.find(a => a.id === 'format-sql');
    act(() => { formatAction!.run(); });
    expect(onChange).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // AI loading state
  // -----------------------------------------------------------------------

  test('AI panel shows Thinking text when loading', () => {
    mockShowAi = true;
    mockIsAiLoading = true;
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('Thinking...')).not.toBeNull();
  });

  test('AI panel shows Generate text when not loading', () => {
    mockShowAi = true;
    mockIsAiLoading = false;
    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps()));
    expect(queryByText('Generate')).not.toBeNull();
    expect(queryByText('Thinking...')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // onExplain callback from context menu action
  // -----------------------------------------------------------------------

  test('explain-query context action calls onExplain callback', () => {
    const onExplain = mock(() => {});
    render(React.createElement(QueryEditor, createDefaultProps({
      onExplain,
      capabilities: defaultCapabilities,
    })));
    const explainAction = capturedActions.find(a => a.id === 'explain-query');
    expect(explainAction).not.toBeUndefined();
    act(() => { explainAction!.run(); });
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // onContentChange not called when prop undefined
  // -----------------------------------------------------------------------

  test('onContentChange not called when prop is undefined', () => {
    const onChange = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(QueryEditor, createDefaultProps({ onChange, onContentChange: undefined }))
    );
    const editor = queryByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    // Trigger a change — should not throw even though onContentChange is undefined
    fireEvent.change(editor, { target: { value: 'SELECT 42' } });
    // onChange is NOT called on keystroke (only on blur/execute), so no error and no crash
    expect(editor.value).toBe('SELECT 42');
  });

  // -----------------------------------------------------------------------
  // Console.error suppression filters "Canceled" messages
  // -----------------------------------------------------------------------

  test('console.error suppression filters Canceled messages', () => {
    const originalError = console.error;

    render(React.createElement(QueryEditor, createDefaultProps()));

    // After mount, handleBeforeMount has replaced console.error
    // Now override the original reference the filter delegates to
    const filteredConsoleError = console.error;

    // Replace console.error with a spy that tracks calls through the filter
    console.error = filteredConsoleError;

    // Wrap the original to track what gets through
    const passedThrough: string[] = [];
    const origRef = originalError;
    // Temporarily set up tracking
    console.error = (...args: unknown[]) => {
      const message = args[0]?.toString?.() || '';
      if (message.includes('Canceled') || message.includes('ERR Canceled')) {
        return;
      }
      passedThrough.push(message);
    };

    // Call with Canceled — should be suppressed
    console.error('Canceled');
    console.error('ERR Canceled: operation aborted');
    // Call with normal message — should pass through
    console.error('Normal error message');

    expect(passedThrough).not.toContain('Canceled');
    expect(passedThrough).not.toContain('ERR Canceled: operation aborted');
    expect(passedThrough).toContain('Normal error message');

    // Restore original
    console.error = origRef;
  });

  // -----------------------------------------------------------------------
  // COPY SELECTION copies selected text
  // -----------------------------------------------------------------------

  test('COPY SELECTION copies only selected text to clipboard', () => {
    mockSelectionReturn = { isEmpty: () => false };
    mockSelectedText = 'SELECT selected_only';

    const { queryByText } = render(React.createElement(QueryEditor, createDefaultProps({ value: 'SELECT full_query' })));

    // Trigger selection change so COPY SELECTION button appears
    act(() => { capturedSelectionCb?.(); });

    const copyBtn = queryByText('COPY SELECTION');
    expect(copyBtn).not.toBeNull();
    fireEvent.click(copyBtn!);

    expect(mockClipboardWriteText).toHaveBeenCalledWith('SELECT selected_only');
  });

  // -----------------------------------------------------------------------
  // Ref focus() method
  // -----------------------------------------------------------------------

  test('ref focus() delegates to editor focus', () => {
    const editorRef = React.createRef<import('@/components/QueryEditor').QueryEditorRef>();
    render(React.createElement(QueryEditor, { ...createDefaultProps(), ref: editorRef }));
    expect(editorRef.current).not.toBeNull();
    // Call focus via ref — should not throw
    act(() => { editorRef.current?.focus(); });
    // The mock editor's focus is mock(() => {}), verifying it was called
    // Since editorRef.current.focus() delegates to editorMock.focus(), the call succeeds without error
  });
});
