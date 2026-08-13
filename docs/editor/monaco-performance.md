# Monaco Editor Performance Optimization

This document details the analysis of Monaco Editor performance issues in LibreDB Studio and the implemented solutions.

> **Status: historical record.** It describes one optimization pass and the code as that
> pass left it, and it is kept for the rationale — why the editor is semi-uncontrolled,
> why completion items are pre-computed, why the PostgreSQL schema fetch is one CTE. It
> is not a description of today's editor: the source is. Where a passage below describes
> code that has since been **deleted**, it says so inline rather than being quietly
> updated, because a rationale is worth nothing once it no longer says what it was
> reasoning about. Everything not marked that way still matches the code.
>
> The current interfaces live in [`src/components/QueryEditor.tsx`](../../src/components/QueryEditor.tsx).

## Identified Issues

### 1. Parent State Update on Every Keystroke (CRITICAL)

**Problem:** QueryEditor was operating as a controlled component, sending state updates to the parent component (Studio.tsx) on every keystroke.

```typescript
// OLD - Called on every character
onChange={(val) => updateCurrentTab({ query: val })}
```

**Impact:**
- 10-20 setState calls per second
- Continuous re-rendering of Studio.tsx + QueryEditor
- Completion provider re-registration
- Schema props recalculation

**Solution:** Converted QueryEditor to a semi-uncontrolled component:
- Editor maintains its own internal state
- Parent is notified only on blur, execute, or explicit sync
- setValue() is called via ref on tab changes

```typescript
// NEW - Sync only on blur/execute
const handleEditorBlur = () => {
  onChange?.(editorRef.current?.getValue());
};
```

### 2. AI Streaming onChange Loop (CRITICAL) — REMOVED

> **The code below no longer exists.** The in-editor AI chat and its streaming loop
> lived in `src/hooks/use-ai-chat.ts`, deleted with the panel in #331 T3; the agent rail
> replaced it and streams nothing into the editor. The entry below records why the loop
> was buffered, for the next feature that streams into a Monaco instance.

**Problem:** During AI streaming, parent state was updated on every chunk.

```typescript
// OLD - Parent re-render on every chunk
while (true) {
  const { done, value } = await reader.read();
  fullAiResponse += chunk;
  onChange(fullAiResponse); // 10-20 re-renders per second
}
```

**Solution:** Buffered updates using requestAnimationFrame:

```typescript
// NEW - Buffered update with RAF
let rafId: number | null = null;
const updateEditor = () => {
  editorRef.current?.setValue(fullAiResponse);
  rafId = null;
};

while (true) {
  const { done, value } = await reader.read();
  fullAiResponse += chunk;
  if (!rafId) {
    rafId = requestAnimationFrame(updateEditor);
  }
}
```

### 3. Inline Props Creation (HIGH)

**Problem:** New array/string was created on every render.

```typescript
// OLD - New reference on every render
tables={schema.map(s => s.name)}
schemaContext={JSON.stringify(schema)}
```

**Solution:** Memoization with useMemo:

```typescript
// NEW - Recalculate only when schema changes
const tableNames = useMemo(() => schema.map(s => s.name), [schema]);
const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);
```

> **Half of this is gone.** `QueryEditorProps.tables` and the `tableNames` memo that fed
> it (`use-connection-manager.ts`, `use-connection-adapter.ts`) were removed in #331 T3:
> the completion provider builds its table items by parsing `schemaContext`, and
> `tables` only fed the AI panel's "Context: N tables" badge, which went with the panel.
> The `schemaContext` memo is the surviving half and still works exactly as shown.

### 4. Monaco Editor Options Inline Object (HIGH)

**Problem:** Editor options object was created inline on every render.

```typescript
// OLD - New object on every render
<Editor
  options={{
    minimap: { enabled: false },
    fontSize: 13,
    // ... 20+ properties
  }}
/>
```

**Solution:** Static options defined outside component:

```typescript
// NEW - Single reference, never recreated
const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  // ... all options
} as const;

<Editor options={EDITOR_OPTIONS} />
```

### 5. Completion Provider Excessive Array Generation (HIGH)

**Problem:** All items were recreated on every completion trigger.

```typescript
// OLD - 100+ objects per trigger
suggestions.push(...SQL_KEYWORDS.map(kw => ({...})));
suggestions.push(...SQL_FUNCTIONS.map(f => ({...})));
// ... same for parsedSchema
```

**Solution:**
1. Pre-compute static items outside the component
2. useMemo cache for schema items
3. Lazy filtering - only items matching the prefix

```typescript
// NEW - Pre-computed static items
const KEYWORD_ITEMS = SQL_KEYWORDS.map(kw => ({
  label: kw,
  labelLower: kw.toLowerCase(),
  kind: 17,
  insertText: kw,
  detail: 'SQL Keyword'
}));

// Schema cache
const schemaCompletionCache = useMemo(() => ({
  tableItems: parsedSchema.map(...),
  columnMap: new Map(...),
  allColumns: new Map(...)
}), [parsedSchema]);

// Lazy filtering
const shouldFilter = prefix.length >= 2;
KEYWORD_ITEMS.forEach(item => {
  if (!shouldFilter || item.labelLower.startsWith(prefix)) {
    suggestions.push({...item, range});
  }
});
```

### 6. Backend N+1 Query Pattern (HIGH)

**Problem:** PostgreSQL schema fetch executed 4 separate queries per table.

```
1 query (tables) + N * 4 queries (columns, pk, fk, indexes)
= 401 queries for 100 tables!
```

**Solution:** Single CTE-based query to fetch all information:

```sql
WITH tables_info AS (...),
     columns_info AS (...),
     pk_info AS (...),
     fk_info AS (...),
     index_info AS (...)
SELECT ... FROM tables_info
LEFT JOIN columns_info ...
LEFT JOIN pk_info ...
LEFT JOIN fk_info ...
LEFT JOIN index_info ...
```

### 7. Key-Based Force Re-render (MEDIUM)

**Problem:** QueryHistory and SavedQueries used key prop causing component destroy/recreate.

```typescript
// OLD - Component destroy/recreate
<QueryHistory key={historyKey} ... />
```

**Solution:** refreshTrigger prop for data refresh only:

```typescript
// NEW - Only triggers useEffect
<QueryHistory refreshTrigger={historyKey} ... />

// Inside component
useEffect(() => {
  setHistory(storage.getHistory());
}, [refreshTrigger]);
```

### 8. console.error Hook Cleanup (MEDIUM)

**Problem:** console.error override was not being cleaned up.

**Solution:** Tracking with useRef and useEffect cleanup:

```typescript
const originalConsoleErrorRef = useRef<typeof console.error | null>(null);

useEffect(() => {
  return () => {
    if (originalConsoleErrorRef.current) {
      console.error = originalConsoleErrorRef.current;
    }
  };
}, []);
```

### 9. flashHighlight Race Condition (MEDIUM)

**Problem:** Rapid consecutive executions could cause decoration conflicts.

**Solution:** Timeout ref tracking and cleanup:

```typescript
const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
const activeDecorationsRef = useRef<string[]>([]);

const flashHighlight = (range) => {
  // Clear previous highlight
  if (highlightTimeoutRef.current) {
    clearTimeout(highlightTimeoutRef.current);
  }
  if (activeDecorationsRef.current.length > 0) {
    editorRef.current?.deltaDecorations(activeDecorationsRef.current, []);
  }

  // Create new decoration
  const decorations = editorRef.current.deltaDecorations([], [...]);
  activeDecorationsRef.current = decorations;

  // Cleanup timeout
  highlightTimeoutRef.current = setTimeout(() => {
    editorRef.current?.deltaDecorations(activeDecorationsRef.current, []);
    activeDecorationsRef.current = [];
  }, 1000);
};
```

## Expected Performance Improvements

| Metric | Before | After |
|--------|--------|-------|
| setState calls (100 character input) | ~100 | ~2-3 |
| Completion trigger time (1000 tables) | ~200ms | ~20ms |
| Schema fetch time (100 tables) | ~5s (401 queries) | ~500ms (1 query) |
| AI streaming render (removed, see issue 2) | 10-20/sec | 1-2/sec |

## File Changes

| File | Change |
|------|--------|
| `src/components/QueryEditor.tsx` | Uncontrolled component, lazy completion, cleanup fixes |
| `src/components/Studio.tsx` | Props memoization, tab sync logic |
| `src/components/QueryHistory.tsx` | refreshTrigger prop |
| `src/components/SavedQueries.tsx` | refreshTrigger prop |
| `src/lib/db/providers/sql/postgres.ts` | Optimized schema query |

## API Changes

The additions this pass made, minus the members that have since been deleted: the ref's
`toggleAi` and `QueryEditorProps.tables` went with the in-editor AI chat in #331 T3. What
either interface holds TODAY is in
[`src/components/QueryEditor.tsx`](../../src/components/QueryEditor.tsx) — read it there
rather than here.

### QueryEditorRef

```typescript
interface QueryEditorRef {
  getSelectedText: () => string;
  getEffectiveQuery: () => string;
  getValue: () => string;
  setValue: (value: string) => void;  // NEW
  focus: () => void;
  format: () => void;
}
```

### QueryEditorProps

```typescript
interface QueryEditorProps {
  value: string;
  onChange?: (val: string) => void;  // Now optional
  onContentChange?: (val: string) => void;  // NEW - For real-time sync
  // ... other props
}
```

### QueryHistoryProps / SavedQueriesProps

```typescript
interface QueryHistoryProps {
  // ... existing props
  refreshTrigger?: number;  // NEW
}
```

## Testing Recommendations

1. **Typing performance:** No lag when rapidly typing 100+ characters
2. **AI streaming:** UI should not freeze during streaming _(no longer applicable — the
   streaming panel was removed, see issue 2)_
3. **Tab switching:** Query should be preserved when switching tabs
4. **Schema fetch:** Should complete under 1 second for large databases
5. **Completion:** Should open instantly with 1000+ tables/columns

## Future Improvements

1. **Virtual scrolling for completion:** For very large schemas
2. **Web Worker for schema parsing:** Parse without blocking main thread
3. **Incremental completion:** Incremental filtering while typing
4. **Connection pooling optimization:** Provider cache tuning
