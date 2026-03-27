# StudioWorkspace Composite Export — Design Specification

**Date:** 2026-03-26
**Status:** Approved
**Context:** libredb-platform's workspace is a basic textarea + HTML table query executor. Studio standalone has 28+ components, Monaco editor, AI copilot, charts, ER diagrams — a full database IDE. The gap exists because the npm package exports individual components, but the orchestration layer (Studio.tsx + 16 hooks + resizable layout + tab manager) is not exported. Platform would need to rebuild the entire workspace wrapper around individual components — essentially rewriting studio inside platform.

**Solution:** Export the entire workspace as a single `<StudioWorkspace />` composite component with callback props. Platform provides data + callbacks, studio provides the full IDE experience.

**Principle:** Additive only — Studio.tsx and all existing code remain unchanged.

---

## 1. Props Interface

```typescript
interface StudioWorkspaceProps {
  // Data — platform provides
  connections: WorkspaceConnection[];
  currentUser?: WorkspaceUser;

  // Core callbacks — required
  onQueryExecute: (connectionId: string, sql: string) => Promise<WorkspaceQueryResult>;
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;

  // Optional callbacks
  onTestConnection?: (config: TestConnectionConfig) => Promise<{ success: boolean; message: string }>;
  onSaveQuery?: (query: SavedQueryInput) => Promise<void>;
  onLoadSavedQueries?: () => Promise<SavedQuery[]>;

  // Feature flags — disabled features hidden from UI
  features?: WorkspaceFeatures;

  // UI customization
  className?: string;
}

interface WorkspaceConnection {
  id: string;
  name: string;
  type: DatabaseType; // 'postgres' | 'mysql' | 'sqlite' | 'oracle' | 'mssql' | 'mongodb' | 'redis'
}

interface WorkspaceUser {
  id: string;
  name?: string;
  role?: string;
}

interface WorkspaceQueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type?: string }[];
  rowCount: number;
  executionTime: number;
}

interface TestConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslEnabled?: boolean;
}

interface SavedQueryInput {
  name: string;
  query: string;
  description?: string;
  connectionType?: string;
  tags?: string[];
}

interface WorkspaceFeatures {
  ai?: boolean;                 // default: false — NL2SQL, QuerySafety AI, DataProfiler AI narrative
  charts?: boolean;             // default: true
  codeGenerator?: boolean;      // default: true
  testDataGenerator?: boolean;  // default: true (uses onQueryExecute)
  schemaDiagram?: boolean;      // default: true
  dataImport?: boolean;         // default: true
  inlineEditing?: boolean;      // default: false (needs special mutation API)
  transactions?: boolean;       // default: false (needs BEGIN/COMMIT/ROLLBACK API)
  connectionManagement?: boolean; // default: false (platform manages connections)
  dataMasking?: boolean;        // default: false
}
```

---

## 2. Architecture

### Dependency Inversion via Adapter Hooks

Studio.tsx uses internal hooks that call API routes and localStorage. StudioWorkspace uses adapter hooks with the same return shape but delegating to callback props.

```
Studio.tsx (standalone)              StudioWorkspace.tsx (embedded)
────────────────────────             ────────────────────────────
useAuth()        → internal JWT      currentUser prop
useConnectionManager() → storage     useConnectionAdapter(props)
useQueryExecution()    → /api/db     useQueryAdapter(props)
useStorageSync() → localStorage      not needed
useTabManager()  → pure UI state     useTabManager() (reused as-is)
useTransactionControl() → /api/db    disabled in v1
useInlineEditing()     → /api/db     disabled in v1
useProviderMetadata()  → /api/db     disabled (no direct DB access)
```

### Adapter Hook Contracts

**useConnectionAdapter(props)** — same shape as useConnectionManager:
- `connections`: from props (reactive to prop changes)
- `activeConnection`: internal state, initialized to first connection
- `setActiveConnection`: setter
- `schema` / `isLoadingSchema`: fetched via `props.onSchemaFetch(connectionId)`
- `fetchSchema`: triggers `onSchemaFetch`
- `tableNames` / `schemaContext`: derived from schema
- No storage operations, no connection CRUD

**useQueryAdapter(props, tabMgr)** — same shape as useQueryExecution:
- `executeQuery(sql?)`: calls `props.onQueryExecute(activeConnectionId, sql)`, stores result in tab
- `cancelQuery`: sets abort flag (best-effort)
- `bottomPanelMode` / `setBottomPanelMode`: internal state
- `historyKey`: increments on each execution (triggers history refresh)
- `safetyCheckQuery` / `forceExecuteQuery`: disabled when `features.ai` is false
- No internal API calls

### Shared UI — No Duplication

Both Studio.tsx and StudioWorkspace.tsx render the same components:
- QueryEditor, ResultsGrid, SchemaExplorer, SchemaDiagram, DataCharts
- Sidebar, StudioTabBar, QueryToolbar, BottomPanel
- ResizablePanelGroup layout, mobile layout

The difference is only in how hooks provide data to these components.

---

## 3. File Structure

All new files — nothing existing is modified.

```
libredb-studio/src/
├── workspace/                          # NEW directory
│   ├── types.ts                        # WorkspaceProps, WorkspaceConnection, etc.
│   ├── StudioWorkspace.tsx             # Composite component
│   ├── defaults.ts                     # Default feature flags
│   └── hooks/
│       ├── use-connection-adapter.ts   # Connection management via props+callbacks
│       └── use-query-adapter.ts        # Query execution via callbacks
├── exports/
│   └── workspace.ts                    # NEW export entry point
```

Modified files (minimal):
```
package.json    → add "./workspace" to exports field
tsup.config.ts  → add workspace entry point
```

---

## 4. v1 Feature Scope

### Included (works via props + callbacks)

| Feature | Component | Why It Works |
|---------|-----------|-------------|
| Monaco SQL editor | QueryEditor | Pure client-side, needs only schema context |
| Virtualized results grid | ResultsGrid | Renders data from onQueryExecute result |
| Schema explorer (sidebar) | SchemaExplorer | Data from onSchemaFetch |
| ER diagram | SchemaDiagram | Pure client-side, reads schema state |
| 8 chart types | DataCharts | Pure client-side, reads query results |
| Code generation | CodeGenerator | Pure client-side, reads schema |
| Test data generation | TestDataGenerator | Generates SQL, uses onQueryExecute |
| Multi-tab workspace | StudioTabBar + useTabManager | Pure UI state, no external deps |
| Resizable panels | ResizablePanelGroup | Pure UI |
| Query history | BottomPanel history tab | In-memory history array |
| Mobile responsive | MobileNav + responsive layout | Pure UI |
| Data import | DataImportModal | Generates SQL, uses onQueryExecute |

### Excluded from v1 (disabled via feature flags)

| Feature | Reason | v2 Path |
|---------|--------|---------|
| NL2SQL | Calls /api/ai/nl2sql | Add `onNL2SQL` callback |
| AI DataProfiler | Calls /api/ai/describe-schema | Add `onAIDescribe` callback |
| QuerySafety AI | Calls /api/ai/query-safety | Add `onQuerySafety` callback |
| AI Autopilot | Calls /api/ai/autopilot | Add `onAIAutopilot` callback |
| Inline editing | Needs mutation API per cell | Add `onCellUpdate` callback |
| Transaction control | Needs BEGIN/COMMIT/ROLLBACK | Add `onTransaction` callback |
| Connection CRUD | Platform manages connections | Add `onConnectionSave/Delete` |
| Data masking | Needs RBAC config | Add `maskingConfig` prop |
| Command palette | Navigation targets don't exist in embedded | Adapt or exclude |
| Storage sync | Platform handles persistence | Not needed |

---

## 5. Platform Integration

### Platform workspace page usage:

```tsx
import { StudioWorkspace } from '@libredb/studio/workspace';

export default async function WorkspacePage() {
  const user = await requireAuth();
  const connections = await ConnectionRepository.findByTenant(user.currentTenantId);

  const serialized = connections.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type.toLowerCase(),
  }));

  return (
    <StudioWorkspace
      connections={serialized}
      currentUser={{ id: user.id, name: user.name }}
      onQueryExecute={async (connectionId, sql) => {
        const res = await fetch('/api/db/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId, sql }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }}
      onSchemaFetch={async (connectionId) => {
        const res = await fetch('/api/db/schema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId }),
        });
        const data = await res.json();
        return data.schema;
      }}
      features={{
        charts: true,
        schemaDiagram: true,
        codeGenerator: true,
        testDataGenerator: true,
        dataImport: true,
      }}
    />
  );
}
```

Platform's existing `/api/db/query` and `/api/db/schema` routes handle auth, RBAC, audit logging — StudioWorkspace doesn't need to know about any of that.

---

## 6. Build & Export

### package.json exports addition:
```json
{
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.js" },
    "./providers": { "import": "./dist/providers.mjs", "require": "./dist/providers.js" },
    "./types": { "import": "./dist/types.mjs", "require": "./dist/types.js" },
    "./components": { "import": "./dist/components.mjs", "require": "./dist/components.js" },
    "./workspace": { "import": "./dist/workspace.mjs", "require": "./dist/workspace.js" }
  }
}
```

### tsup entry point addition:
```typescript
entry: [
  'src/exports/index.ts',
  'src/exports/providers.ts',
  'src/exports/types.ts',
  'src/exports/components.ts',
  'src/exports/workspace.ts',  // NEW
]
```

---

## 7. Testing Strategy

- Unit tests for adapter hooks (mock callbacks, verify they're called correctly)
- Unit tests for feature flag logic (disabled features don't render)
- Component test for StudioWorkspace (renders with minimal props)
- No E2E needed in v1 (platform E2E will cover integration)

---

## 8. What Does NOT Change

- `src/components/Studio.tsx` — untouched
- All 16 existing hooks — untouched
- All 28+ existing components — untouched
- All 33 API routes — untouched
- Existing exports (components, providers, types) — untouched
- Standalone app behavior — identical
