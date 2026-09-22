import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";
import * as ReactNS from "react";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockDiffWithChanges = {
  tables: [
    {
      action: "added",
      tableName: "new_table",
      columns: [{ action: "added", columnName: "id", targetType: "integer", changes: ['Added column "id" (integer)'] }],
      indexes: [],
      foreignKeys: [],
    },
    {
      action: "removed",
      tableName: "old_table",
      columns: [{ action: "removed", columnName: "name", sourceType: "varchar", changes: ['Removed column "name"'] }],
      indexes: [],
      foreignKeys: [],
    },
    {
      action: "modified",
      tableName: "users",
      columns: [
        {
          action: "modified",
          columnName: "email",
          sourceType: "varchar(100)",
          targetType: "varchar(255)",
          changes: ["Type changed: varchar(100) -> varchar(255)"],
        },
      ],
      indexes: [
        { action: "added", indexName: "idx_email", changes: ["Added index idx_email"] },
        { action: "removed", indexName: "idx_old", changes: ["Removed index idx_old"] },
        { action: "modified", indexName: "idx_name", changes: ["Columns changed"] },
      ],
      foreignKeys: [
        { action: "added", columnName: "org_id", changes: ["Added FK on org_id"] },
        { action: "removed", columnName: "dept_id", changes: ["Removed FK on dept_id"] },
      ],
    },
  ],
  summary: { added: 1, removed: 1, modified: 1 },
  hasChanges: true,
};

const mockDiffNoChanges = {
  tables: [],
  summary: { added: 0, removed: 0, modified: 0 },
  hasChanges: false,
};

const mockDiffSchemas = mock(() => structuredClone(mockDiffWithChanges));
const mockGenerateMigrationSQL = mock(() => "CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;");

mock.module("@/lib/schema-diff/diff-engine", () => ({
  diffSchemas: mockDiffSchemas,
}));

mock.module("@/lib/schema-diff/migration-generator", () => ({
  generateMigrationSQL: mockGenerateMigrationSQL,
}));

// ── Mock SnapshotTimeline ────────────────────────────────────────────────────

let capturedTimelineProps: { onCompare?: (s: string, t: string) => void; onDelete?: (id: string) => void } = {};

mock.module("@/components/SnapshotTimeline", () => ({
  SnapshotTimeline: (props: {
    snapshots: unknown[];
    onCompare?: (s: string, t: string) => void;
    onDelete?: (id: string) => void;
  }) => {
    capturedTimelineProps = { onCompare: props.onCompare, onDelete: props.onDelete };
    return React.createElement("div", { "data-testid": "snapshot-timeline" }, `${props.snapshots.length} snapshots`);
  },
}));

// ── Mock UI components ───────────────────────────────────────────────────────

mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, className, ...rest }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { onClick: onClick as () => void, disabled: disabled as boolean, className, ...rest },
      children as React.ReactNode,
    ),
}));

mock.module("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("span", { "data-testid": "badge", className }, children),
}));

// ── Mock Select: capture onValueChange callbacks ─────────────────────────────

// We store onValueChange keyed by the Select's current value prop.
// Source starts with value="current", Target starts with value="".
const selectCallbacks = new Map<string, (v: string) => void>();

mock.module("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => {
    const key = value ?? "__empty__";
    if (onValueChange) selectCallbacks.set(key, onValueChange);
    return React.createElement("div", { "data-testid": `select-${key}` }, children);
  },
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "select-trigger" }, children),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "select-content" }, children),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) =>
    React.createElement("div", { "data-testid": `select-item-${value}`, "data-value": value }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    React.createElement("span", { "data-testid": "select-value" }, placeholder),
}));

// ── Mock storage ─────────────────────────────────────────────────────────────

const mockSnapshots = [
  {
    id: "snap-1",
    connectionId: "test-pg-1",
    connectionName: "TestDB",
    databaseType: "postgres",
    schema: [
      {
        name: "old_table",
        columns: [{ name: "name", type: "varchar", nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      },
      {
        name: "users",
        columns: [{ name: "email", type: "varchar(100)", nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      },
    ],
    createdAt: new Date("2026-01-10T10:00:00Z"),
    label: "Before migration",
  },
];

/**
 * The store, as a store. The panel reads back what it just wrote, because the real one
 * SWALLOWS a quota refusal - `saveSchemaSnapshot` returns nothing and `local-storage.ts`
 * catches the error - so a mock that accepts a write and then answers without it would be
 * testing the panel against a store that does not exist.
 */
const savedSnapshots: unknown[] = [];
const mockGetSchemaSnapshots = mock(() => [...mockSnapshots, ...savedSnapshots]);
const mockSaveSchemaSnapshot = mock((snapshot?: unknown) => {
  if (snapshot !== undefined) savedSnapshots.push(snapshot);
});
const mockDeleteSchemaSnapshot = mock(() => {});
const mockGetConnections = mock(() => [
  {
    id: "remote-1",
    name: "Remote PG",
    type: "postgres",
    host: "remote",
    port: 5432,
    database: "db",
    createdAt: new Date(),
  },
  {
    id: "remote-2",
    name: "Prod DB",
    type: "postgres",
    host: "prod",
    port: 5432,
    database: "db",
    environment: "production",
    createdAt: new Date(),
  },
]);

mock.module("@/lib/storage", () => ({
  storage: {
    getSchemaSnapshots: mockGetSchemaSnapshots,
    saveSchemaSnapshot: mockSaveSchemaSnapshot,
    deleteSchemaSnapshot: mockDeleteSchemaSnapshot,
    getConnections: mockGetConnections,
  },
}));

// ── Watch the panel's own state setters ──────────────────────────────────────

/**
 * A `setState` on an unmounted component is a SILENT no-op in React 19. It does not warn,
 * it does not throw, and nothing outside the component can tell that it happened - measured
 * here, on this React, before these tests were written. So "the panel writes nothing after
 * it is gone" cannot be held by watching the screen, the store or the console: there is
 * nothing to watch. It is held by watching the setters.
 *
 * `useState` is wrapped once, for the whole file, and records only while `stateWrites` is an
 * array - which `recordStateWrites()` switches on for the span of one assertion, so the rest
 * of the suite pays nothing and sees nothing. The real hook does the work; this only counts.
 */
let stateWrites: string[] | null = null;
const realUseState = ReactNS.useState;
const watchedReact = {
  ...ReactNS,
  useState: (initial: unknown) => {
    const [value, set] = (realUseState as (i: unknown) => [unknown, (v: unknown) => void])(initial);
    return [
      value,
      (next: unknown) => {
        if (stateWrites) stateWrites.push(typeof next === "function" ? "fn" : String(JSON.stringify(next)));
        return set(next);
      },
    ];
  },
};
mock.module("react", () => ({ ...watchedReact, default: watchedReact }));

mock.module("@/hooks/use-all-connections", () => ({
  useAllConnections: () => ({
    connections: mockGetConnections(),
    loading: false,
  }),
}));

// ── Imports AFTER mocks ──────────────────────────────────────────────────────

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { render, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { SchemaDiff } from "@/components/SchemaDiff";
import { logger } from "@/lib/logger";
import { mockSchema } from "../fixtures/schemas";
import { mockMySQLConnection, mockPostgresConnection } from "../fixtures/connections";

// ── Helpers ──────────────────────────────────────────────────────────────────

// The clipboard harness, as in tests/components/CodeGenerator.test.tsx: the migration SQL's copy
// button is the shared `CopyButton`, so the test stands in for `navigator.clipboard` and puts the
// original back afterwards.
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { value: clipboard, configurable: true });
}

function renderDiff(overrides: Partial<Parameters<typeof SchemaDiff>[0]> = {}) {
  return render(<SchemaDiff schema={mockSchema} connection={mockPostgresConnection} {...overrides} />);
}

/** Trigger the source Select's onValueChange (source value starts as "current") */
function changeSource(value: string) {
  const fn = selectCallbacks.get("current");
  if (fn) act(() => fn(value));
}

/** Trigger the target Select's onValueChange (target value starts as "") */
function changeTarget(value: string) {
  const fn = selectCallbacks.get("__empty__") || selectCallbacks.get("");
  if (fn) act(() => fn(value));
}

/** Get the target callback for async tests (no act() wrapping) */
function getTargetCallback() {
  return selectCallbacks.get("__empty__") || selectCallbacks.get("");
}

/**
 * Record every state write the panel performs, until `stop()` is called.
 *
 * Switched on AFTER the panel has been unmounted, so what it returns is exactly the set of
 * writes a dead component performed - which must be empty.
 */
function recordStateWrites() {
  stateWrites = [];
  return {
    stop() {
      const seen = stateWrites ?? [];
      stateWrites = null;
      return seen;
    },
  };
}

/** Helper to set native input value and trigger React change handler */
function changeInput(input: HTMLInputElement, value: string) {
  // React controlled inputs need nativeInputValueSetter
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    // fallback
    Object.defineProperty(input, "value", { value, writable: true, configurable: true });
  }
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

/** The Refresh control by its label, which is also its accessible name. */
function refreshButton(view: ReturnType<typeof render>) {
  const buttons = Array.from(view.container.querySelectorAll("button"));
  return buttons.find((b) => /refresh/i.test(b.textContent ?? ""));
}

/**
 * The "No snapshot was saved" banner's own sentence, or "" when there is none.
 *
 * Read back as TEXT rather than asserted present/absent, so a failure prints what the user was
 * actually told. That sentence is most of what these findings cost: a snapshot they pressed
 * Save on, not written, and a line blaming them for a race nothing in the world caused.
 */
function snapshotBanner(view: ReturnType<typeof render>) {
  const span = Array.from(view.container.querySelectorAll("span")).find((el) =>
    el.textContent?.startsWith("No snapshot was saved:"),
  );
  return span?.textContent ?? "";
}

describe("SchemaDiff", () => {
  beforeEach(() => {
    mockDiffSchemas.mockClear();
    mockGenerateMigrationSQL.mockClear();
    mockGetSchemaSnapshots.mockClear();
    mockSaveSchemaSnapshot.mockClear();
    savedSnapshots.length = 0;
    mockDeleteSchemaSnapshot.mockClear();
    mockGetConnections.mockClear();
    selectCallbacks.clear();
    capturedTimelineProps = {};

    // The default behaviour of the two write mocks, restored here rather than only at their
    // declaration: `mockClear` forgets the CALLS and keeps the IMPLEMENTATION, so a test that
    // swaps one for a store with the real filter-by-id or the real 50-row cap would otherwise
    // hand that store to every test after it.
    mockSaveSchemaSnapshot.mockImplementation((snapshot?: unknown) => {
      if (snapshot !== undefined) savedSnapshots.push(snapshot);
    });
    mockDeleteSchemaSnapshot.mockImplementation(() => {});

    mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffWithChanges));
    mockGenerateMigrationSQL.mockImplementation(
      () => "CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;",
    );
    mockGetSchemaSnapshots.mockImplementation(() => [...mockSnapshots]);
    mockGetConnections.mockImplementation(() => [
      {
        id: "remote-1",
        name: "Remote PG",
        type: "postgres",
        host: "remote",
        port: 5432,
        database: "db",
        createdAt: new Date(),
      },
      {
        id: "remote-2",
        name: "Prod DB",
        type: "postgres",
        host: "prod",
        port: 5432,
        database: "db",
        environment: "production",
        createdAt: new Date(),
      },
    ]);
  });

  afterEach(() => {
    cleanup();
    if (originalClipboard === undefined) setClipboard(undefined);
    else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Header
  // ═══════════════════════════════════════════════════════════════════════════

  describe("header", () => {
    test('renders "Schema Diff" title', () => {
      const { getByText } = renderDiff();
      expect(getByText("Schema Diff")).toBeTruthy();
    });

    test("renders Source and Target labels", () => {
      const { getByText } = renderDiff();
      expect(getByText("Source")).toBeTruthy();
      expect(getByText("Target")).toBeTruthy();
    });

    test('renders "vs" separator', () => {
      const { getByText } = renderDiff();
      expect(getByText("vs")).toBeTruthy();
    });

    test('renders "Current Schema" in select options', () => {
      const { getAllByText } = renderDiff();
      expect(getAllByText("Current Schema").length).toBeGreaterThanOrEqual(2);
    });

    test("renders snapshot items in select options", () => {
      const { getAllByText } = renderDiff();
      const items = getAllByText(/Before migration/);
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Empty State
  // ═══════════════════════════════════════════════════════════════════════════

  describe("empty state", () => {
    test("shows instructions when no target selected", () => {
      const { getByText } = renderDiff();
      expect(getByText("Select source and target to compare schemas")).toBeTruthy();
      expect(getByText("Take a snapshot first, then compare with the current schema")).toBeTruthy();
    });

    test("shows SnapshotTimeline when snapshots exist", () => {
      const { container, getByText } = renderDiff();
      expect(container.querySelector('[data-testid="snapshot-timeline"]')).toBeTruthy();
      expect(getByText("1 snapshots")).toBeTruthy();
    });

    test("hides SnapshotTimeline when no snapshots", () => {
      mockGetSchemaSnapshots.mockImplementation(() => []);
      const { container } = renderDiff();
      expect(container.querySelector('[data-testid="snapshot-timeline"]')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Snapshot Controls
  // ═══════════════════════════════════════════════════════════════════════════

  describe("snapshot controls", () => {
    /**
     * The same answer as `answerSchemaReads`, except the INVENTORY half is held open until
     * the returned `release` is called.
     *
     * `provider-meta` still answers at once, so `readLiveSchema` gets all the way to the
     * read that matters and stops THERE. The gate lives in this closure and not in
     * `globalThis.fetch`, which is the point: the caller can swap `globalThis.fetch` for a
     * second connection while this first read is suspended, and release it afterwards.
     */
    function holdSchemaRead(objects: Array<{ name: string }> = [{ name: "users" }], ok = true) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const orig = globalThis.fetch;
      globalThis.fetch = mock((url: string) =>
        String(url).includes("provider-meta")
          ? Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  capabilities: {
                    queryLanguage: "sql",
                    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                  },
                }),
            })
          : held.then(() => ({
              ok,
              json: () =>
                Promise.resolve(
                  ok
                    ? {
                        objects: objects.map((o) => ({ name: o.name, kind: "table", path: ["public", o.name] })),
                        details: objects.map((o) => ({
                          path: ["public", o.name],
                          columns: [],
                          indexes: [],
                          foreignKeys: [],
                        })),
                      }
                    : { error: "the connection you left is gone" },
                ),
            })),
      ) as unknown as typeof fetch;
      return { release, restore: () => void (globalThis.fetch = orig) };
    }

    /**
     * A snapshot now reads the database itself, so these tests have to answer that read.
     * They did not before, when it froze whatever the panel happened to be holding — which
     * is the defect: the sequence the Diff tab exists for (snapshot, change the database,
     * compare) answered "No differences found" with the panel left open, because the
     * snapshot and the other side were both the mount-time copy.
     */
    function answerSchemaReads(objects: Array<{ name: string }> = [{ name: "users" }]) {
      const orig = globalThis.fetch;
      const fetchMock = mock((url: string) =>
        Promise.resolve(
          url.includes("provider-meta")
            ? {
                ok: true,
                json: () =>
                  Promise.resolve({
                    capabilities: {
                      queryLanguage: "sql",
                      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                    },
                  }),
              }
            : {
                ok: true,
                json: () =>
                  Promise.resolve({
                    objects: objects.map((o) => ({ name: o.name, kind: "table", path: ["public", o.name] })),
                    details: objects.map((o) => ({
                      path: ["public", o.name],
                      columns: [],
                      indexes: [],
                      foreignKeys: [],
                    })),
                  }),
              },
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return { fetchMock, restore: () => void (globalThis.fetch = orig) };
    }

    test("renders Snapshot button", () => {
      const { getByText } = renderDiff();
      expect(getByText("Snapshot")).toBeTruthy();
    });

    test("Snapshot button is disabled when no connection", () => {
      const { container } = renderDiff({ connection: null });
      const snapshotBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Snapshot"),
      );
      expect(snapshotBtn?.disabled).toBe(true);
    });

    test("clicking Snapshot shows label input", () => {
      const { getByText, getByPlaceholderText } = renderDiff();
      fireEvent.click(getByText("Snapshot"));
      expect(getByPlaceholderText("Label (optional)...")).toBeTruthy();
      expect(getByText("Save")).toBeTruthy();
      expect(getByText("Cancel")).toBeTruthy();
    });

    test("Cancel button hides label input", () => {
      const { getByText, queryByPlaceholderText } = renderDiff();
      fireEvent.click(getByText("Snapshot"));
      expect(queryByPlaceholderText("Label (optional)...")).toBeTruthy();
      fireEvent.click(getByText("Cancel"));
      expect(queryByPlaceholderText("Label (optional)...")).toBeNull();
    });

    test("Save button calls storage.saveSchemaSnapshot", async () => {
      const { restore } = answerSchemaReads();
      const { getByText, getByPlaceholderText, queryByPlaceholderText } = renderDiff();
      fireEvent.click(getByText("Snapshot"));

      const input = getByPlaceholderText("Label (optional)...") as HTMLInputElement;
      changeInput(input, "My label");
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(saved.connectionId).toBe(mockPostgresConnection.id);
      expect(saved.connectionName).toBe(mockPostgresConnection.name);
      expect(saved.databaseType).toBe(mockPostgresConnection.type);

      // Label input should be hidden after save
      expect(queryByPlaceholderText("Label (optional)...")).toBeNull();
    });

    test("Save with empty label sets label to undefined", async () => {
      const { restore } = answerSchemaReads();
      const { getByText } = renderDiff();
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      expect(
        ((mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>).label,
      ).toBeUndefined();
    });

    test("Enter key in label input triggers snapshot save", async () => {
      const { restore } = answerSchemaReads();
      const { getByText, getByPlaceholderText } = renderDiff();
      fireEvent.click(getByText("Snapshot"));

      const input = getByPlaceholderText("Label (optional)...") as HTMLInputElement;
      changeInput(input, "Enter label");
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
    });

    test("records what the database holds NOW, not what the panel read when it opened", async () => {
      // The whole point of the tab: snapshot, change the database, compare. With the panel
      // left open that answered "No differences found", because the snapshot froze the
      // mount-time copy and so did the other side. The panel is mounted here, the database
      // gains a table, and the snapshot has to carry it.
      const first = answerSchemaReads([{ name: "users" }]);
      const { getByText } = renderDiff();
      await act(async () => {});
      first.restore();

      const second = answerSchemaReads([{ name: "users" }, { name: "added_after_open" }]);
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      second.restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as { schema: Array<{ name: string }> };
      expect(saved.schema.map((o) => o.name).sort()).toEqual(["added_after_open", "users"]);
    });

    test("saves nothing when that read fails, and says why", async () => {
      const first = answerSchemaReads([{ name: "users" }]);
      const { getByText, findByText } = renderDiff();
      await act(async () => {});
      first.restore();

      const orig = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database refused the read" }) }),
      ) as unknown as typeof fetch;
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      globalThis.fetch = orig;

      // A stale snapshot is the defect again with a longer fuse, so nothing is written.
      expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      expect(await findByText(/No snapshot was saved: the database refused the read/)).toBeTruthy();
    });

    test("Enter twice saves once, not twice", async () => {
      const { restore } = answerSchemaReads();
      const { getByText, getByPlaceholderText } = renderDiff();
      await act(async () => {});
      fireEvent.click(getByText("Snapshot"));
      const input = getByPlaceholderText("Label (optional)...") as HTMLInputElement;

      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
    });

    /**
     * The double-Enter guard, measured. `snapshotInFlight` is a ref and not state because
     * both presses land in the SAME tick, before React has re-rendered, so both see the
     * `snapshotting` their callback closed over - `false` - and both begin a read.
     *
     * "One snapshot was saved" is not the measurement, and the test above is green with the
     * guard deleted: the second read supersedes the first, the first asks `isCurrent()` and
     * is told no, so exactly one snapshot is written either way. What the missing guard
     * really costs is the two things below, and they are the two things the user pays for -
     * the database read twice for one press of Save, and a banner blaming them for a race
     * they did not cause.
     */
    test("Enter twice reads the database ONCE, not twice", async () => {
      const mount = answerSchemaReads();
      const { getByText, getByPlaceholderText } = renderDiff();
      await act(async () => {});
      mount.restore();

      // A fresh answer, so the count below is the snapshot's reads and not the mount's.
      const { fetchMock, restore } = answerSchemaReads();
      fireEvent.click(getByText("Snapshot"));
      const input = getByPlaceholderText("Label (optional)...") as HTMLInputElement;
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      restore();

      // `inventory` is the read that matters - the whole object surface of the database.
      // Without the guard this is 2: one press of Save, two round trips to the server.
      const inventoryReads = (fetchMock.mock.calls as unknown[][]).filter((c) =>
        String(c[0]).includes("inventory"),
      ).length;
      expect(inventoryReads).toBe(1);
      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
    });

    test("Enter twice leaves no banner the user did nothing to earn", async () => {
      // The half a person actually sees. Without the guard the first read is superseded by
      // the second, takes that for someone else asking for a newer read, and raises
      // "the schema was read again before this finished. Press Save again" - over a snapshot
      // that WAS saved. The user pressed Save, it worked, and the panel tells them it did not.
      const mount = answerSchemaReads();
      const { getByText, getByPlaceholderText, queryByText } = renderDiff();
      await act(async () => {});
      mount.restore();

      const { restore } = answerSchemaReads();
      fireEvent.click(getByText("Snapshot"));
      const input = getByPlaceholderText("Label (optional)...") as HTMLInputElement;
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      restore();

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      expect(queryByText(/No snapshot was saved/)).toBeNull();
      expect(queryByText(/Press Save again/)).toBeNull();
    });

    test("a storage refusal unlocks the button and says so", async () => {
      // Snapshots live in localStorage and a snapshot is a whole schema, so a quota refusal
      // is ordinary. Before the `finally`, this left the button reading "Reading..." for the
      // life of the panel with nothing on screen explaining it.
      const { restore } = answerSchemaReads();
      mockSaveSchemaSnapshot.mockImplementationOnce(() => {
        throw new Error("the browser refused to store it");
      });
      const { getByText, findByText, queryByText } = renderDiff();
      await act(async () => {});
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      restore();

      expect(await findByText(/No snapshot was saved: the browser refused to store it/)).toBeTruthy();
      expect(queryByText("Reading...")).toBeNull();
      expect(getByText("Save")).toBeTruthy();
    });

    test("says a snapshot failed even while the panel's own read is failing too", async () => {
      // Two different facts: what Current Schema means, and whether the thing you just
      // pressed wrote anything. Only the first used to reach the screen.
      const orig = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database is unreachable" }) }),
      ) as unknown as typeof fetch;

      const { getByText, findByText } = renderDiff();
      await act(async () => {});
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      globalThis.fetch = orig;

      expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      expect(await findByText(/Current Schema is the explorer's last copy/)).toBeTruthy();
      expect(await findByText(/No snapshot was saved: the database is unreachable/)).toBeTruthy();
    });

    test("the same read becomes Current Schema, not just the snapshot", async () => {
      // The other half of this change: the read a snapshot makes is also stored as the
      // panel's own copy, so the snapshot and the side it will be compared against are the
      // same instant. Asserted through the error banner, which is what `liveRead` drives:
      // after a successful snapshot read the panel is no longer falling back to the
      // explorer's copy, even though the read it did on mount had failed.
      const orig = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "mount read failed" }) }),
      ) as unknown as typeof fetch;
      const { getByText, findByText, queryByText } = renderDiff();
      expect(await findByText(/Current Schema is the explorer's last copy/)).toBeTruthy();

      const { restore } = answerSchemaReads([{ name: "users" }, { name: "added_after_open" }]);
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      restore();
      globalThis.fetch = orig;

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      // The banner is gone, which it can only be because the snapshot's read replaced the
      // failed one as Current Schema.
      expect(queryByText(/Current Schema is the explorer's last copy/)).toBeNull();
    });

    test("the Save button is disabled while its read is in flight", async () => {
      const { restore } = answerSchemaReads();
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const orig = globalThis.fetch;
      const passthrough = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (String(url).includes("inventory")) await held;
        return passthrough(url as never, init as never);
      }) as unknown as typeof fetch;

      const { getByText, container } = renderDiff();
      fireEvent.click(getByText("Snapshot"));
      let pending: Promise<unknown> | undefined;
      await act(async () => {
        fireEvent.click(getByText("Save"));
        pending = Promise.resolve();
        await pending;
      });

      const saving = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Reading..."),
      );
      expect(saving?.disabled).toBe(true);
      // The label and Cancel go with it: a label typed now would not reach the snapshot the
      // read is already building, and Cancel would close the panel over a save that is still
      // going to happen.
      expect((container.querySelector("input[placeholder='Label (optional)...']") as HTMLInputElement).disabled).toBe(
        true,
      );
      expect(
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Cancel"))?.disabled,
      ).toBe(true);

      release?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      globalThis.fetch = orig;
      restore();
    });
    test("leaving the Diff tab while a snapshot read is in flight saves nothing", async () => {
      // The lock on the label input and Cancel stops the panel being closed out from under a
      // save that is already running - and it only covers the panel's own buttons. Leaving the
      // tab walks straight past it: `BottomPanel` mounts one view at a time, so changing tabs
      // UNMOUNTS this, the read lands afterwards and the snapshot is written for a panel that
      // is gone, with no banner, no refreshed list, and nothing on screen saying it happened.
      // Measured before the fix: one snapshot saved after the panel had left the screen.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "a_table" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        // Save is pressed, and THAT read is held open.
        const held = holdSchemaRead([{ name: "a_table" }]);
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });

        // The user changes tabs while it is still out. One view at a time, so this is an
        // unmount and not a hidden panel.
        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          view.unmount();
        });

        await act(async () => {
          held.release();
          await new Promise((r) => setTimeout(r, 0));
        });
        held.restore();

        // Nothing is written for a panel that is no longer on screen.
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("leaving the Diff tab while a REMOTE fetch is in flight saves nothing either", async () => {
      // The other read that writes a snapshot. Choosing a connection to compare against
      // auto-saves what it reads as a "Live:" snapshot, so the same tab change leaves the
      // same litter behind - a snapshot of a database nobody is looking at, written by a
      // panel that no longer exists. It runs on its own counter, so it needs its own answer.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "a_table" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        const held = holdSchemaRead([{ name: "remote_table" }]);
        const target = getTargetCallback();
        await act(async () => {
          target?.("conn:remote-1");
        });

        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          view.unmount();
        });

        await act(async () => {
          held.release();
          await new Promise((r) => setTimeout(r, 0));
        });
        held.restore();

        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a snapshot read that lands after the connection changed saves nothing and is not kept", async () => {
      // A read is not instant - it opens a connection and asks a catalog - and the panel
      // stays usable while it runs, so the user can switch connections inside that window.
      // The mount effect has a `cancelled` flag for exactly this; the snapshot's own read
      // needs the same check, or its late answer is written as the CURRENT connection's
      // Current Schema, the identity test then rejects it, and the panel falls silently back
      // to the explorer's copy with no banner - #884 again, on a connection the user is
      // looking at right now.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "a_table" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        // Save is pressed on A, and THAT read is held open.
        const heldA = holdSchemaRead([{ name: "a_table" }]);
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });

        // While it is still in flight the user switches to B, whose own read lands.
        const b = answerSchemaReads([{ name: "b_table" }]);
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={mockMySQLConnection} />);
        });
        b.restore();

        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          heldA.release();
          await new Promise((r) => setTimeout(r, 0));
        });
        heldA.restore();

        // Nothing is written for a connection the user has left.
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();

        // And B's own read is still what Current Schema means.
        mockDiffSchemas.mockClear();
        changeSource("snap-1");
        changeTarget("current");
        const current = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)?.[1] as Array<{ name: string }>;
        expect(current.map((o) => o.name)).toEqual(["b_table"]);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a snapshot read that FAILS after the connection changed leaves the new one alone", async () => {
      // The same window, the other outcome. Writing the old connection's failure onto the
      // new one would put a banner about a database the user is no longer looking at over a
      // panel that is working.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "a_table" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        const heldA = holdSchemaRead([], false);
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });

        const b = answerSchemaReads([{ name: "b_table" }]);
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={mockMySQLConnection} />);
        });
        b.restore();

        await act(async () => {
          heldA.release();
          await new Promise((r) => setTimeout(r, 0));
        });
        heldA.restore();

        expect(view.queryByText(/the connection you left is gone/)).toBeNull();
        mockDiffSchemas.mockClear();
        changeSource("snap-1");
        changeTarget("current");
        const current = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)?.[1] as Array<{ name: string }>;
        expect(current.map((o) => o.name)).toEqual(["b_table"]);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("snapshot, change the database, compare - the sequence the tab exists for", async () => {
      // The whole claim, end to end, with the panel never closed. The earlier fix made the
      // SNAPSHOT read fresh and stopped there, so the other side of the comparison was still
      // frozen at the moment the snapshot was taken and the answer was "No differences
      // found" all the same. Choosing a target is what reads again.
      const a = answerSchemaReads([{ name: "users" }]);
      const { getByText } = renderDiff();
      await act(async () => {});
      a.restore();

      // A snapshot of the schema as it stands: read fresh, so it carries what is there now.
      const b = answerSchemaReads([{ name: "users" }]);
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      b.restore();
      const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as {
        schema: Array<{ name: string }>;
      };
      expect(saved.schema.map((o) => o.name)).toEqual(["users"]);

      // The database gains a table, and a target is chosen WITHOUT leaving the tab.
      const c = answerSchemaReads([{ name: "users" }, { name: "added_between" }]);
      mockDiffSchemas.mockClear();
      changeTarget("snap-1");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      c.restore();

      // Current Schema was read again, so the comparison sees the new table. Without the
      // second read this side would still be the schema of the moment the snapshot was taken.
      const [source] = (mockDiffSchemas.mock.calls as unknown[][]).at(-1) as [Array<{ name: string }>];
      expect(source.map((o) => o.name).sort()).toEqual(["added_between", "users"]);
    });

    test("a snapshot overtaken on the SAME connection says so instead of vanishing", async () => {
      // Choosing a target reads the connection too, so a snapshot in flight can be overtaken
      // without the connection changing at all. Returning quietly there saved nothing and
      // said nothing: the button went back to "Save" and the user believed it had saved.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "users" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        const held = holdSchemaRead([{ name: "users" }]);
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });

        // A target is chosen while that read is still out, which begins a newer one.
        const b = answerSchemaReads([{ name: "users" }]);
        await act(async () => {
          changeTarget("snap-1");
        });
        b.restore();

        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          held.release();
          await new Promise((r) => setTimeout(r, 0));
        });
        held.restore();

        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
        expect(await view.findByText(/read again before this finished/)).toBeTruthy();
        expect(view.queryByText("Reading...")).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    /**
     * Two reads of the SAME connection, settled in an order the test chooses.
     *
     * `holdSchemaRead` gates one read by swapping `globalThis.fetch` wholesale, so it cannot
     * express the ordinary order: the snapshot's own read settling FIRST and the read that
     * overtook it settling after. That order is the common one - the overtaken read was
     * started earlier, so it is answering the older question and usually answers first - and
     * it is the order the defect lives in, so it has to be expressible. `provider-meta` still
     * answers at once; every inventory read parks here until the test settles it by index.
     */
    function queuedSchemaReads() {
      const orig = globalThis.fetch;
      type ReadOutcome = { ok: true; objects: Array<{ name: string }> } | { ok: false; error: string };
      type Answer = { ok: boolean; json: () => Promise<unknown> };
      const pending: Array<(outcome: ReadOutcome) => void> = [];
      globalThis.fetch = mock((url: string) =>
        String(url).includes("provider-meta")
          ? Promise.resolve<Answer>({
              ok: true,
              json: () =>
                Promise.resolve({
                  capabilities: {
                    queryLanguage: "sql",
                    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                  },
                }),
            })
          : new Promise<Answer>((resolve) => {
              pending.push((outcome) =>
                resolve({
                  ok: outcome.ok,
                  json: () =>
                    Promise.resolve(
                      outcome.ok
                        ? {
                            objects: outcome.objects.map((o) => ({
                              name: o.name,
                              kind: "table",
                              path: ["public", o.name],
                            })),
                            details: outcome.objects.map((o) => ({
                              path: ["public", o.name],
                              columns: [],
                              indexes: [],
                              foreignKeys: [],
                            })),
                          }
                        : { error: outcome.error },
                    ),
                }),
              );
            }),
      ) as unknown as typeof fetch;
      /** Let every read that has been ISSUED get as far as this queue. */
      const flush = () =>
        act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      const settle = async (index: number, outcome: ReadOutcome) => {
        pending[index](outcome);
        await flush();
      };
      return { pending, flush, settle, restore: () => void (globalThis.fetch = orig) };
    }

    test("an overtaken snapshot still says so when the newer read settles AFTER it", async () => {
      // The ordinary order, and the one the earlier attempt never ran. The overtaken read
      // was started first, so it is the first to answer: it raises the banner, and the read
      // that overtook it lands a tick later. Clearing the report on any successful read of
      // this connection wiped the banner in that tick, and what the user was left with was a
      // button back at "Save", nothing saved, and nothing on screen - the exact silence the
      // banner exists to end.
      const q = queuedSchemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: [{ name: "users" }] });

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        // Choosing a target begins a newer read of the same connection.
        await act(async () => {
          changeTarget("snap-1");
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        // The overtaken snapshot answers FIRST.
        await q.settle(1, { ok: true, objects: [{ name: "users" }] });
        expect(view.queryByText(/read again before this finished/)).not.toBeNull();

        // The read that overtook it answers second, and it is a read of this connection
        // that worked - which is precisely what used to wipe the banner.
        await q.settle(2, { ok: true, objects: [{ name: "users" }] });

        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
        expect(view.queryByText(/read again before this finished/)).not.toBeNull();
        expect(view.queryByText("Reading...")).toBeNull();
      } finally {
        q.restore();
      }
    });

    test("an overtaken snapshot survives the panel's OWN re-read of the same connection", async () => {
      // The other way a newer read starts. The panel's own effect runs again when the
      // connection it is looking at is POINTED SOMEWHERE ELSE - edited in place, which keeps
      // the id and changes the database - and the snapshot in flight is overtaken all the
      // same, so the banner has to outlive that read too, not just a target selection.
      //
      // It used to be provoked here by a fresh connection object for the same database, which
      // is what the embedded host hands over on an ordinary re-render. That is finding 2's
      // second trigger and no longer reads at all; the test below holds it.
      const q = queuedSchemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: [{ name: "users" }] });

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        // Same id, same entry in the user's list, different database.
        await act(async () => {
          view.rerender(
            <SchemaDiff
              schema={mockSchema}
              connection={{ ...mockPostgresConnection, database: "pointed_elsewhere" }}
            />,
          );
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(1, { ok: true, objects: [{ name: "users" }] });
        expect(view.queryByText(/read again before this finished/)).not.toBeNull();
        await q.settle(2, { ok: true, objects: [{ name: "users" }] });

        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
        expect(view.queryByText(/read again before this finished/)).not.toBeNull();
      } finally {
        q.restore();
      }
    });

    test("a rebuilt connection object for the SAME database does not destroy a snapshot", async () => {
      // Finding 2, second trigger, and nothing a user did. This panel is rendered from the
      // embedded shell too (`studio/BottomPanel.tsx`, via `StudioWorkspace`), and
      // `use-connection-adapter.ts` builds `activeConnection` with a `useMemo` over a prop the
      // host supplies - so a host handing over a fresh array produces a fresh connection
      // OBJECT with the same id, pointing at the same database. Keyed on that object the panel
      // read again, that read went through the same counter as everything else, and the
      // snapshot the user had pressed Save on was superseded: nothing written, and the panel
      // saying "the schema was read again before this finished. Press Save again".
      const q = queuedSchemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: [{ name: "users" }] });

        fireEvent.click(view.getByText("Snapshot"));
        changeInput(view.getByPlaceholderText("Label (optional)...") as HTMLInputElement, "before the migration");
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        // A re-render, not a choice: same id, same host, same database, new object.
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection }} />);
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(1, { ok: true, objects: [{ name: "users" }] });

        // Both halves of what the user gets, in one assertion, so a failure prints both: the
        // snapshot they asked for, and whatever the panel told them about it.
        expect({ snapshots: mockSaveSchemaSnapshot.mock.calls.length, panel: snapshotBanner(view) }).toEqual({
          snapshots: 1,
          panel: "",
        });
        const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as { label?: string };
        expect(saved.label).toBe("before the migration");
        // And no read was made for it: the wasted round trip is the other half of the cost,
        // and it is what made the snapshot unsaveable in the first place.
        expect(q.pending.length).toBe(2);
      } finally {
        q.restore();
      }
    });

    test("a cosmetic field changing mid-read does not destroy a snapshot either", async () => {
      // The same defect through a field the hand-written list never named. `queryTimeout`
      // changes no host, no database and no principal - this repository's own
      // CONNECTION_RELEVANCE classifies it `cosmetic` - and changing it while a snapshot's
      // read was in flight superseded that read: nothing written, and "the schema was read
      // again before this finished. Press Save again" on screen.
      //
      // The five names typed into this file could not have covered it, which is why the key
      // is derived from that table now: it is typed over every field of the connection, so a
      // field nobody classified fails the build rather than reaching here unnoticed.
      const q = queuedSchemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: [{ name: "users" }] });

        fireEvent.click(view.getByText("Snapshot"));
        changeInput(view.getByPlaceholderText("Label (optional)...") as HTMLInputElement, "before the migration");
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        await act(async () => {
          view.rerender(
            <SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, queryTimeout: 60_000 }} />,
          );
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(1, { ok: true, objects: [{ name: "users" }] });

        expect({ snapshots: mockSaveSchemaSnapshot.mock.calls.length, panel: snapshotBanner(view) }).toEqual({
          snapshots: 1,
          panel: "",
        });
        expect(q.pending.length).toBe(2);
      } finally {
        q.restore();
      }
    });

    test("pointing the same entry at another database still supersedes the read", async () => {
      // The other half, and the one a positive list could get wrong: a change that DOES move
      // the database must still win. Same id, same object shape, different host.
      const q = queuedSchemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: [{ name: "users" }] });

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        await act(async () => {
          view.rerender(
            <SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, host: "another-host" }} />,
          );
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(1, { ok: true, objects: [{ name: "users" }] });

        // Nothing written from the abandoned read, and the panel says why rather than going
        // quiet - which is the behaviour the counter exists for.
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        q.restore();
      }
    });

    test("the report follows the connection by id, which an in-place edit keeps and another does not", async () => {
      // What the id is still exactly right for, and it is not "which database". A report is
      // about an ENTRY in the user's connection list: editing that entry - pointing it at
      // another database - leaves the report theirs to answer, and moving to a different entry
      // takes it off a panel it is not about. The read asks the other question, by what it
      // would reach, and this is the proof that closing finding 3 did not take the first
      // question with it.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "users" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database blinked" }) }),
        ) as unknown as typeof fetch;
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();

        // Same entry, pointed at another database. The read this provokes is a different
        // database's, and the report is still about the connection the user is looking at.
        const b = answerSchemaReads([{ name: "elsewhere" }]);
        await act(async () => {
          view.rerender(
            <SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, database: "another_db" }} />,
          );
          await new Promise((r) => setTimeout(r, 0));
        });
        b.restore();
        expect(snapshotBanner(view)).toContain("the database blinked");

        // A different entry, and it is not their report to answer.
        const c = answerSchemaReads([{ name: "mysql_table" }]);
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={mockMySQLConnection} />);
          await new Promise((r) => setTimeout(r, 0));
        });
        c.restore();
        expect(snapshotBanner(view)).toBe("");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a snapshot failure on one connection does not sit over another that is working", async () => {
      // The reason the report carries the connection it is about. A banner over a database
      // the user is not looking at is its own small lie, and the panel outlives a switch.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "a_table" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database blinked" }) }),
        ) as unknown as typeof fetch;
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();

        // The user moves to another database, which reads cleanly.
        const b = answerSchemaReads([{ name: "b_table" }]);
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={mockMySQLConnection} />);
          await new Promise((r) => setTimeout(r, 0));
        });
        b.restore();
        expect(view.queryByText(/No snapshot was saved/)).toBeNull();

        // Back on the connection it was about, it is still true: nothing was written for it,
        // and a later read of it that works does not write it.
        const c = answerSchemaReads([{ name: "a_table" }]);
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={mockPostgresConnection} />);
          await new Promise((r) => setTimeout(r, 0));
        });
        c.restore();
        expect(view.queryByText(/No snapshot was saved: the database blinked/)).not.toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a panel-read failure and a snapshot failure are two facts, and both stay on screen", async () => {
      // One says what "Current Schema" currently means; the other says a snapshot the user
      // asked for was not written. Neither answers the other, so neither may erase it.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "users" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        // Nothing is written for the snapshot.
        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database blinked" }) }),
        ) as unknown as typeof fetch;
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();

        // The panel reads this same connection again and it WORKS. That refreshes Current
        // Schema. It does not write the snapshot, so it does not answer the report.
        //
        // Refresh is what asks for that read. A re-render handing over a rebuilt connection
        // object used to do it and no longer does, which is the whole of finding 2's second
        // trigger: a read nobody asked for is a read that can destroy a snapshot.
        const b = answerSchemaReads([{ name: "users" }]);
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
          await new Promise((r) => setTimeout(r, 0));
        });
        b.restore();

        // The read after that fails, so Current Schema falls back to the explorer's copy.
        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the catalog is gone" }) }),
        ) as unknown as typeof fetch;
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
          await new Promise((r) => setTimeout(r, 0));
        });

        expect(view.queryByText(/which may be out of date: the catalog is gone/)).not.toBeNull();
        expect(view.queryByText(/No snapshot was saved: the database blinked/)).not.toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("Dismiss is the way out, and it clears only the snapshot report", async () => {
      // No read clears the report any more, so there has to be something on the screen that
      // does. Pressing Save again is a retry that can fail again; leaving the connection only
      // hides it. A labelled button is the only exit a user does not have to guess at.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "users" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database blinked" }) }),
        ) as unknown as typeof fetch;
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();

        // The panel's own read of this connection is failing at the same time. Asked for with
        // Refresh: a rebuilt connection object no longer reads, so it cannot be the trigger.
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
          await new Promise((r) => setTimeout(r, 0));
        });
        expect(view.queryByText(/which may be out of date: the database blinked/)).not.toBeNull();

        await act(async () => {
          fireEvent.click(view.getByText("Dismiss"));
        });
        expect(view.queryByText(/No snapshot was saved/)).toBeNull();
        // The panel's own warning is not the snapshot report and is left where it was.
        expect(view.queryByText(/which may be out of date: the database blinked/)).not.toBeNull();

        // Dismissing one report does not silence the next. The label panel is still open -
        // a save that failed leaves what was typed where it was - so Save is still there to
        // press, and failing again says so again.
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a snapshot that works clears the report the last failed one left", async () => {
      // The report is spent when the thing it reports on is done. A new attempt clears it at
      // the start, so a snapshot that is written leaves nothing behind.
      const origFetch = globalThis.fetch;
      try {
        const a = answerSchemaReads([{ name: "users" }]);
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        a.restore();

        globalThis.fetch = mock(() =>
          Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "the database blinked" }) }),
        ) as unknown as typeof fetch;
        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        expect(await view.findByText(/No snapshot was saved: the database blinked/)).toBeTruthy();

        // The label panel is still open after a failure, so the same Save is pressed again.
        const b = answerSchemaReads([{ name: "users" }]);
        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
          await new Promise((r) => setTimeout(r, 0));
        });
        b.restore();

        expect(mockSaveSchemaSnapshot).toHaveBeenCalled();
        expect(view.queryByText(/No snapshot was saved/)).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("comparing two snapshots reads no database at all", async () => {
      const a = answerSchemaReads([{ name: "users" }]);
      const { container } = renderDiff();
      await act(async () => {});
      a.restore();

      const orig = globalThis.fetch;
      const counted = mock(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ objects: [], details: [] }) }),
      );
      globalThis.fetch = counted as unknown as typeof fetch;
      await act(async () => {
        changeSource("snap-1");
        changeTarget("snap-1");
        await new Promise((r) => setTimeout(r, 0));
      });
      globalThis.fetch = orig;

      // Two files against each other. A round trip here changes nothing either side shows.
      expect(counted).not.toHaveBeenCalled();
      expect(container).toBeTruthy();
    });

    test("takeSnapshot does nothing when connection is null", () => {
      // Snapshot button is disabled for null connection, so storage should not be called
      renderDiff({ connection: null });
      expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
    });

    test("snapshot save refreshes snapshot list", async () => {
      const { restore } = answerSchemaReads();
      const { getByText } = renderDiff();
      const callsBefore = mockGetSchemaSnapshots.mock.calls.length;
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
      restore();
      expect(mockGetSchemaSnapshots.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Source/Target Selection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("source/target selection", () => {
    test("selecting a target triggers diff display", () => {
      const { queryByText } = renderDiff();
      changeTarget("snap-1");
      // diff has changes → summary should appear
      expect(queryByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();
    });

    test("selecting same source and target shows same-schema message", () => {
      const { getByText } = renderDiff();
      changeTarget("current");
      // source=current, target=current → same → null diff
      expect(getByText("Cannot compare same schema with itself")).toBeTruthy();
    });

    test("changing source updates diff", () => {
      renderDiff();
      changeSource("snap-1");
      changeTarget("current");
      expect(mockDiffSchemas).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Reading the database again without leaving the tab
  // ═══════════════════════════════════════════════════════════════════════════

  describe("refreshing the current schema", () => {
    /**
     * Every inventory read parked until this test settles it, by index.
     *
     * `pending.length` is therefore the number of reads the panel has ISSUED, which is the
     * measurement these tests are about: the defect is a gesture that issues none.
     *
     * Local rather than borrowed from the snapshot block, which gates reads the same way:
     * the helpers there are scoped to that block, and lifting them out would have rewritten
     * the tests that hold the snapshot rules to prove something about a button.
     */
    function schemaReads() {
      const orig = globalThis.fetch;
      type Outcome = { ok: true; objects: string[] } | { ok: false; error: string };
      type Answer = { ok: boolean; json: () => Promise<unknown> };
      const pending: Array<(outcome: Outcome) => void> = [];
      globalThis.fetch = mock((url: string) => {
        if (String(url).includes("provider-meta")) {
          return Promise.resolve<Answer>({
            ok: true,
            json: () =>
              Promise.resolve({
                capabilities: {
                  queryLanguage: "sql",
                  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                },
              }),
          });
        }
        return new Promise<Answer>((resolve) => {
          pending.push((outcome) =>
            resolve({
              ok: outcome.ok,
              json: () =>
                Promise.resolve(
                  outcome.ok
                    ? {
                        objects: outcome.objects.map((name) => ({ name, kind: "table", path: ["public", name] })),
                        details: outcome.objects.map((name) => ({
                          path: ["public", name],
                          columns: [],
                          indexes: [],
                          foreignKeys: [],
                        })),
                      }
                    : { error: outcome.error },
                ),
            }),
          );
        });
      }) as unknown as typeof fetch;
      /** Let every read that has been ISSUED get as far as this queue. */
      const flush = () =>
        act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      const settle = async (index: number, outcome: Outcome) => {
        pending[index](outcome);
        await flush();
      };
      return { pending, flush, settle, restore: () => void (globalThis.fetch = orig) };
    }

    /** Mount, answer the panel's own read, choose a target, answer that read too. */
    async function openOnADiff(q: ReturnType<typeof schemaReads>) {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = renderDiff();
      });
      await q.flush();
      await q.settle(0, { ok: true, objects: ["users"] });
      await act(async () => {
        changeTarget("snap-1");
      });
      await q.flush();
      await q.settle(1, { ok: true, objects: ["users"] });
      return view;
    }

    /** What "Current Schema" was worth the last time the diff was computed. */
    function currentSideNames() {
      const latest = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
      return (latest[0] as Array<{ name: string }>).map((o) => o.name);
    }

    test("choosing the target that is ALREADY chosen reads nothing", async () => {
      // The defect itself. The panel re-reads when the comparison target CHANGES, and a
      // Select reports a selection only when the value lands on something else - so picking
      // the same target again is the most the panel can even be told: `setTargetId` with the
      // id it already holds. React bails out, the effect keyed on that id does not run, and
      // the database is not read. The gesture a person makes for "look again" does nothing,
      // which is why it cannot be the answer to #35.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        expect(q.pending.length).toBe(2);

        const pickTheSameTargetAgain = selectCallbacks.get("snap-1")!;
        await act(async () => {
          pickTheSameTargetAgain("snap-1");
        });
        await q.flush();

        expect(q.pending.length).toBe(2);
        expect(view.container.textContent).toContain("Schema Diff");
      } finally {
        q.restore();
      }
    });

    test("a fresh read can be asked for without leaving the tab", async () => {
      // The other half of #35, and the half that matters: the panel shipped with exactly one
      // way to see a change - leave the Diff tab and come back, because `BottomPanel` mounts
      // one view at a time and returning is a remount. This is that step removed. The user
      // changes the database, presses the control, and the side that says "current" is the
      // database as it is now.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        expect(currentSideNames()).toEqual(["users"]);

        const refresh = refreshButton(view);
        expect(refresh).toBeTruthy();
        await act(async () => {
          fireEvent.click(refresh!);
        });
        await q.flush();

        // A read was issued, and no remount happened to issue it.
        expect(q.pending.length).toBe(3);
        await q.settle(2, { ok: true, objects: ["added_after_the_snapshot"] });
        expect(currentSideNames()).toEqual(["added_after_the_snapshot"]);
      } finally {
        q.restore();
      }
    });

    test("a slow refresh overtaken by a newer read does not win", async () => {
      // The refresh goes through the panel's read counter rather than around it. Press
      // Refresh, then Save: the snapshot's read is the newer question, and the refresh is
      // the slow one that answers LAST with what the database said BEFORE. Writing on the
      // way out would put a stale "Current Schema" on screen under a snapshot that was just
      // taken - the stale-copy defect this panel exists to have stopped.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);

        await act(async () => {
          fireEvent.click(refreshButton(view)!);
        });
        await q.flush();
        expect(q.pending.length).toBe(3);

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();
        expect(q.pending.length).toBe(4);

        // The newer read answers first...
        await q.settle(3, { ok: true, objects: ["what_the_database_holds_now"] });
        // ...and the refresh, which was started earlier, answers after it with older objects.
        await q.settle(2, { ok: true, objects: ["stale_from_the_refresh"] });

        expect(currentSideNames()).toEqual(["what_the_database_holds_now"]);
        expect(currentSideNames()).not.toContain("stale_from_the_refresh");
        // The snapshot was the current read, so it is kept - superseding runs one way only.
        expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      } finally {
        q.restore();
      }
    });

    test("two clicks in one tick read the database ONCE, not twice", async () => {
      // The same guard the Save button needs, for the same reason: both clicks land in one
      // tick, before React has re-rendered, so both see the `refreshing` the handler closed
      // over - false - and the `disabled` that would have stopped the second is not on the
      // button yet. The counter keeps the older read from WRITING, so the data stays right;
      // what breaks is the screen, because the first read to settle runs the `finally` and
      // hands the button back while the read the user is waiting for is still out.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        const refresh = refreshButton(view)!;

        await act(async () => {
          fireEvent.click(refresh);
          fireEvent.click(refresh);
        });
        await q.flush();

        expect(q.pending.length).toBe(3);
      } finally {
        q.restore();
      }
    });

    test("the button is locked while its own read is in flight, and comes back after", async () => {
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
        });
        await q.flush();

        expect(refreshButton(view)!.disabled).toBe(true);
        expect(refreshButton(view)!.textContent).toContain("Refreshing");

        await q.settle(2, { ok: true, objects: ["users"] });

        expect(refreshButton(view)!.disabled).toBe(false);
        expect(refreshButton(view)!.textContent?.trim()).toBe("Refresh");
      } finally {
        q.restore();
      }
    });

    test("Refresh is locked while a snapshot is reading, so it cannot destroy one", async () => {
      // Finding 2, first trigger. `disabled` was `!connection || refreshing`, and Refresh goes
      // through the same counter as the snapshot - so type a label, press Save, press Refresh
      // before the read lands, and the snapshot's `isCurrent()` is false: nothing is written
      // and the panel says "the schema was read again before this finished. Press Save again".
      // The label input, Save and Cancel are all locked during `snapshotting` for exactly this
      // reason, and this control was not.
      const q = schemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: ["users"] });

        fireEvent.click(view.getByText("Snapshot"));
        changeInput(view.getByPlaceholderText("Label (optional)...") as HTMLInputElement, "before the migration");
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        // Pressed while the snapshot's read is still out.
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(1, { ok: true, objects: ["users"] });

        // Both halves of what the user gets, in one assertion, so a failure prints both.
        expect({ snapshots: mockSaveSchemaSnapshot.mock.calls.length, panel: snapshotBanner(view) }).toEqual({
          snapshots: 1,
          panel: "",
        });
        const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as { label?: string };
        expect(saved.label).toBe("before the migration");
        // The press read nothing: mount and the snapshot, and no third read to supersede it.
        expect(q.pending.length).toBe(2);
        // And the lock lifts with the snapshot, so the control is not left dead behind it.
        expect(refreshButton(view)!.disabled).toBe(false);
      } finally {
        q.restore();
      }
    });

    test("re-pointing the connection reads the NEW database, which keying on the id would not", async () => {
      // The two findings pulling against each other, measured. Keying the panel's read on
      // `connection?.id` closes finding 2's second trigger and opens finding 3 wider: a
      // connection edited to point elsewhere would then never read again, so the previous
      // database's objects would stand as Current Schema for good instead of for a moment.
      // The key is neither identity nor id - same database, no read; same id and a different
      // database, a read - and a rename is not a database either.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        expect(currentSideNames()).toEqual(["users"]);

        // A rebuilt object for the same database reads nothing.
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection }} />);
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        // Neither does a rename. It is what the entry is CALLED, not where it points.
        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, name: "Renamed" }} />);
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        // The same entry pointed at another database does read it, and that read is what
        // Current Schema becomes.
        await act(async () => {
          view.rerender(
            <SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, database: "another_db" }} />,
          );
        });
        await q.flush();
        // TWO reads, because two effects are keyed on the answer and both of their questions
        // changed: the panel's own read of Current Schema, and the read a chosen target asks
        // for. They share the counter, so only the newer of them may write - which is the
        // one settled here.
        expect(q.pending.length).toBe(4);
        await q.settle(3, { ok: true, objects: ["only_in_another_db"] });
        expect(currentSideNames()).toEqual(["only_in_another_db"]);
      } finally {
        q.restore();
      }
    });

    test("a managed connection is keyed by the seed it names, which is all its read is sent", async () => {
      // A managed connection's read posts `seed:<id>` and nothing else - the route resolves the
      // credentials at the other end - so no other field on the object can change what comes
      // back, and one that differs must not provoke a read. The seed itself is a different
      // database and does.
      const managed = { ...mockPostgresConnection, managed: true, seedId: "seed-1" };
      const q = schemaReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = render(<SchemaDiff schema={mockSchema} connection={managed} />);
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: ["users"] });
        expect(q.pending.length).toBe(1);

        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={{ ...managed, host: "somewhere-else" }} />);
        });
        await q.flush();
        expect(q.pending.length).toBe(1);

        await act(async () => {
          view.rerender(<SchemaDiff schema={mockSchema} connection={{ ...managed, seedId: "seed-2" }} />);
        });
        await q.flush();
        expect(q.pending.length).toBe(2);
      } finally {
        q.restore();
      }
    });

    test("the button is disabled when there is no connection to read", () => {
      const view = renderDiff({ connection: null });
      expect(refreshButton(view)!.disabled).toBe(true);
    });

    test("it is a keyboard-reachable control with an accessible name", async () => {
      // A native <button> with a text label: it is in the tab order without a `tabindex`,
      // and Enter and Space activate it because the browser activates buttons - which is
      // exactly why it is a button and not a clickable icon. jsdom implements neither
      // default activation, so what is asserted here is what makes it true in a browser:
      // the element type, an untouched tab order, and a name a screen reader can read.
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        const refresh = refreshButton(view)!;

        expect(refresh.tagName).toBe("BUTTON");
        expect(refresh.getAttribute("tabindex")).toBeNull();
        expect(refresh.getAttribute("aria-hidden")).toBeNull();
        expect(refresh.textContent?.trim()).toBe("Refresh");

        refresh.focus();
        expect(document.activeElement).toBe(refresh);
      } finally {
        q.restore();
      }
    });

    test("a refresh that fails keeps the last copy, says why, and unlocks the button", async () => {
      // Emptying the side would report every object as removed, so the fallback is the same
      // one the panel's own read uses - and the banner is the part that stops it being a
      // silent lie about a schema that may be out of date.
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const q = schemaReads();
      try {
        const view = await openOnADiff(q);
        await act(async () => {
          fireEvent.click(refreshButton(view)!);
        });
        await q.flush();
        await q.settle(2, { ok: false, error: "permission denied for schema public" });

        expect(view.container.textContent).toContain("permission denied for schema public");
        expect(view.container.textContent).toContain("explorer");
        expect(currentSideNames()).toEqual(mockSchema.map((o) => o.name));
        expect(refreshButton(view)!.disabled).toBe(false);
        expect(warn).toHaveBeenCalled();
      } finally {
        q.restore();
        warn.mockRestore();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Diff View (hasChanges = true)
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // Writing after the panel is gone
  // ═══════════════════════════════════════════════════════════════════════════

  describe("writing after the panel is gone", () => {
    /**
     * Every inventory read parked until the test settles it, by index.
     *
     * Local, like the copy in "refreshing the current schema" and for the same stated
     * reason: the blocks gate reads the same way but prove different rules, and lifting one
     * helper out would rewrite tests that hold rules this block is not about.
     */
    function parkedReads() {
      const orig = globalThis.fetch;
      type Outcome = { ok: true; objects: string[] } | { ok: false; error: string };
      type Answer = { ok: boolean; json: () => Promise<unknown> };
      const pending: Array<(outcome: Outcome) => void> = [];
      globalThis.fetch = mock((url: string) => {
        if (String(url).includes("provider-meta")) {
          return Promise.resolve<Answer>({
            ok: true,
            json: () =>
              Promise.resolve({
                capabilities: {
                  queryLanguage: "sql",
                  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                },
              }),
          });
        }
        return new Promise<Answer>((resolve) => {
          pending.push((outcome) =>
            resolve({
              ok: outcome.ok,
              json: () =>
                Promise.resolve(
                  outcome.ok
                    ? {
                        objects: outcome.objects.map((name) => ({ name, kind: "table", path: ["public", name] })),
                        details: outcome.objects.map((name) => ({
                          path: ["public", name],
                          columns: [],
                          indexes: [],
                          foreignKeys: [],
                        })),
                      }
                    : { error: outcome.error },
                ),
            }),
          );
        });
      }) as unknown as typeof fetch;
      const flush = () =>
        act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      const settle = async (index: number, outcome: Outcome) => {
        pending[index](outcome);
        await flush();
      };
      return { pending, flush, settle, restore: () => void (globalThis.fetch = orig) };
    }

    /** Mount, and answer the read the panel makes on the way in, so tests start settled. */
    async function mountSettled(q: ReturnType<typeof parkedReads>) {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = renderDiff();
      });
      await q.flush();
      await q.settle(0, { ok: true, objects: ["users"] });
      return view;
    }

    /** The control by its label, which is also its accessible name. */
    function refreshButton(view: ReturnType<typeof render>) {
      return Array.from(view.container.querySelectorAll("button")).find((b) => /refresh/i.test(b.textContent ?? ""));
    }

    test("a snapshot read that lands after the panel is gone writes no state at all", async () => {
      // Superseding both counters on the way out stops the SAVE, and the test above holds
      // that. It does not stop the panel talking to itself afterwards: an unmount supersedes
      // the read, the snapshot arrives at the branch for a read that lost the race, and that
      // branch raises "Press Save again" - addressed to a person standing in front of a
      // panel that is not there, on a component React has already thrown away. The `finally`
      // hands the Save button back a moment later for the same nobody.
      const q = parkedReads();
      try {
        const view = await mountSettled(q);

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          view.unmount();
        });

        const writes = recordStateWrites();
        await q.settle(1, { ok: true, objects: ["users"] });

        expect(writes.stop()).toEqual([]);
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        q.restore();
      }
    });

    test("a snapshot read that FAILS after the panel is gone writes no state either", async () => {
      // The other half of the same gesture, and it does not go through the superseded
      // branch at all: the read rejects, so the `catch` raises the banner and the `finally`
      // gives the button back, neither of them asking any question first. A tab change
      // followed by a request that times out is the ordinary way to reach it.
      const q = parkedReads();
      try {
        const view = await mountSettled(q);

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        await act(async () => {
          view.unmount();
        });

        const writes = recordStateWrites();
        await q.settle(1, { ok: false, error: "the connection you left is gone" });

        expect(writes.stop()).toEqual([]);
      } finally {
        q.restore();
      }
    });

    test("a Refresh read that lands after the panel is gone writes no state", async () => {
      // The newest read in the panel, and the one whose `finally` is deliberately
      // unconditional: a refresh that loses the race still has to stop the button reading
      // "Refreshing..." for good. That is right while the button exists. Once the tab has
      // been changed there is no button, and the write is to a dead component.
      const q = parkedReads();
      try {
        const view = await mountSettled(q);

        await act(async () => {
          fireEvent.click(refreshButton(view)!);
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        await act(async () => {
          view.unmount();
        });

        const writes = recordStateWrites();
        await q.settle(1, { ok: true, objects: ["users"] });

        expect(writes.stop()).toEqual([]);
      } finally {
        q.restore();
      }
    });

    test("a remote fetch that lands after the panel is gone writes neither state nor a snapshot", async () => {
      // The path added last, on a counter of its own. Everything it writes - the "Live:"
      // snapshot, the list it reads back, the target it selects, the spinner it clears -
      // already asks that counter, and the unmount supersedes it. Pinned here so the answer
      // stays no: this is the one read in the panel that saves to the store without anyone
      // pressing Save.
      const q = parkedReads();
      try {
        const view = await mountSettled(q);

        await act(async () => {
          getTargetCallback()?.("conn:remote-1");
        });
        await q.flush();
        expect(q.pending.length).toBe(2);

        mockSaveSchemaSnapshot.mockClear();
        await act(async () => {
          view.unmount();
        });

        const writes = recordStateWrites();
        await q.settle(1, { ok: true, objects: ["remote_table"] });

        expect(writes.stop()).toEqual([]);
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        q.restore();
      }
    });

    test("the panel still saves a snapshot after StrictMode has mounted it twice", async () => {
      // The cost of holding "is anyone left to tell" as a flag. StrictMode mounts, runs the
      // cleanup and mounts again in development, so a flag only ever put DOWN there leaves
      // the panel unable to report anything for the rest of its life - the save silently
      // not announced, the button stuck on "Reading...". It is put back up on the way in,
      // and this is what says so.
      const q = parkedReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = render(
            <React.StrictMode>
              <SchemaDiff schema={mockSchema} connection={mockPostgresConnection} />
            </React.StrictMode>,
          );
        });
        await q.flush();

        fireEvent.click(view.getByText("Snapshot"));
        await act(async () => {
          fireEvent.click(view.getByText("Save"));
        });
        await q.flush();

        mockSaveSchemaSnapshot.mockClear();
        await q.settle(q.pending.length - 1, { ok: true, objects: ["users"] });

        expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
        // And the panel can still be used, which is the other thing a flag left down eats.
        // A save that succeeds closes the label input, so "Reading..." is off the screen
        // either way; the state behind it is only visible on the way back IN.
        fireEvent.click(view.getByText("Snapshot"));
        const save = Array.from(view.container.querySelectorAll("button")).find((b) =>
          /^(Save|Reading\.\.\.)$/.test(b.textContent?.trim() ?? ""),
        );
        expect(save?.textContent?.trim()).toBe("Save");
        expect(save?.disabled).toBe(false);
      } finally {
        q.restore();
      }
    });
  });

  describe("diff view with changes", () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget("snap-1");
      return result;
    }

    test("shows summary counts", () => {
      const { getByText } = renderWithDiff();
      expect(getByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();
    });

    test("renders all table names in sidebar", () => {
      const { getByText } = renderWithDiff();
      expect(getByText("new_table")).toBeTruthy();
      expect(getByText("old_table")).toBeTruthy();
      expect(getByText("users")).toBeTruthy();
    });

    test("renders action badges for tables", () => {
      const { getByText } = renderWithDiff();
      expect(getByText("Added")).toBeTruthy();
      expect(getByText("Removed")).toBeTruthy();
      expect(getByText("Modified")).toBeTruthy();
    });

    test('shows "Select a table" prompt when no table is selected', () => {
      const { getByText } = renderWithDiff();
      expect(getByText("Select a table to view diff details")).toBeTruthy();
    });

    test("clicking a table shows its detail", () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText("new_table"));
      // TableDiffDetail renders: table heading with action badge
      const badges = document.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find((b) => b.textContent === "added");
      expect(addedBadge).toBeTruthy();
    });

    test("clicking a different table switches detail", () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText("new_table"));
      // new_table detail should show column "id"
      expect(getByText("id")).toBeTruthy();

      fireEvent.click(getByText("old_table"));
      // old_table detail should show column "name"
      expect(getByText("name")).toBeTruthy();
    });

    test("selected table has ChevronDown, others have ChevronRight", () => {
      const { container, getByText } = renderWithDiff();
      fireEvent.click(getByText("new_table"));

      const tableButtons = Array.from(container.querySelectorAll("button"));
      const newTableBtn = tableButtons.find((b) => b.textContent?.includes("new_table"));
      const oldTableBtn = tableButtons.find((b) => b.textContent?.includes("old_table"));

      expect(newTableBtn?.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(oldTableBtn?.querySelector(".lucide-chevron-right")).toBeTruthy();
    });

    test("selected table has highlighted background", () => {
      const { container, getByText } = renderWithDiff();
      fireEvent.click(getByText("users"));

      const usersBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("users"));
      expect(usersBtn?.className).toContain("bg-fill-strong");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // No Changes State
  // ═══════════════════════════════════════════════════════════════════════════

  describe("no changes state", () => {
    test('shows "No differences found" message', () => {
      mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffNoChanges));
      const { getByText } = renderDiff();
      changeTarget("snap-1");
      expect(getByText("No differences found between source and target")).toBeTruthy();
    });

    test("SQL Migration button does not appear when no changes", () => {
      mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffNoChanges));
      const { queryByText } = renderDiff();
      changeTarget("snap-1");
      expect(queryByText("SQL Migration")).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Migration SQL View
  // ═══════════════════════════════════════════════════════════════════════════

  describe("migration SQL", () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget("snap-1");
      return result;
    }

    test("SQL Migration button appears when diff has changes", () => {
      const { getByText } = renderWithDiff();
      expect(getByText("SQL Migration")).toBeTruthy();
    });

    test("clicking SQL Migration shows SQL and changes button text", () => {
      const { getByText, container } = renderWithDiff();
      fireEvent.click(getByText("SQL Migration"));

      expect(container.textContent).toContain("CREATE TABLE new_table");
      expect(container.textContent).toContain("DROP TABLE old_table");
      expect(getByText("Diff View")).toBeTruthy();
    });

    test("toggling back to diff view shows table list again", () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText("SQL Migration"));
      expect(getByText("Diff View")).toBeTruthy();

      fireEvent.click(getByText("Diff View"));
      expect(getByText("SQL Migration")).toBeTruthy();
      expect(getByText("new_table")).toBeTruthy();
    });

    test("migration SQL is rendered in a pre tag", () => {
      const { getByText, container } = renderWithDiff();
      fireEvent.click(getByText("SQL Migration"));
      const pre = container.querySelector("pre");
      expect(pre).toBeTruthy();
      expect(pre!.textContent).toContain("CREATE TABLE");
    });

    // #751: the migration view rendered its SQL in a bare <pre>, so the only way to take it away
    // was a manual text selection. The shared CopyButton is the one every other generated-SQL
    // view uses, and it puts exactly `text` on the clipboard.
    test("offers a copy button that puts exactly the migration SQL on the clipboard", async () => {
      const writeText = mock(async (t: string) => {
        void t;
      });
      setClipboard({ writeText });

      const { getByText, getByTestId } = renderWithDiff();
      fireEvent.click(getByText("SQL Migration"));
      fireEvent.click(getByTestId("schema-diff-migration-copy"));

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;");
      await waitFor(() => expect(getByTestId("schema-diff-migration-copy").textContent).toContain("Copied"));
    });

    test("has no copy button while the diff view is showing", () => {
      const { queryByTestId } = renderWithDiff();
      expect(queryByTestId("schema-diff-migration-copy")).toBeNull();
    });

    test("generateMigrationSQL receives correct dialect", () => {
      renderWithDiff();
      if (mockGenerateMigrationSQL.mock.calls.length > 0) {
        const dialect = (mockGenerateMigrationSQL.mock.calls as unknown[][])[0][1];
        expect(dialect).toBe("postgres");
      }
    });

    test("defaults to postgres dialect when connection is null", () => {
      renderDiff({ connection: null });
      changeTarget("snap-1");
      if (mockGenerateMigrationSQL.mock.calls.length > 0) {
        const dialect = (mockGenerateMigrationSQL.mock.calls as unknown[][])[0][1];
        expect(dialect).toBe("postgres");
      }
    });

    test("schema-diff-migration-copy button renders and copies migration SQL", () => {
      const writeText = mock(async (t: string) => {
        void t;
      });
      const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
      Object.defineProperty(globalThis.navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      try {
        const { getByText, getByTestId } = renderWithDiff();
        fireEvent.click(getByText("SQL Migration"));

        const copyBtn = getByTestId("schema-diff-migration-copy");
        expect(copyBtn).toBeTruthy();
        expect(copyBtn.textContent).toContain("Copy");

        fireEvent.click(copyBtn);
        expect(writeText).toHaveBeenCalledTimes(1);
        expect((writeText.mock.calls as unknown[][])[0][0]).toContain("CREATE TABLE new_table");
      } finally {
        if (originalClipboard === undefined) {
          Object.defineProperty(globalThis.navigator, "clipboard", { value: undefined, configurable: true });
        } else {
          Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
        }
      }
    });

    test("schema-diff-migration-copy button is pinned over the scrollable pre container rather than inside it", () => {
      const { getByText, getByTestId, container } = renderWithDiff();
      fireEvent.click(getByText("SQL Migration"));

      const copyBtn = getByTestId("schema-diff-migration-copy");
      const pre = container.querySelector("pre");
      expect(pre).toBeTruthy();
      expect(copyBtn).toBeTruthy();

      // Structural assertion: The copy button must not sit inside the scrollable pre tag,
      // where scrolling long migration text would carry the button away (#1080).
      expect(pre!.contains(copyBtn)).toBe(false);

      // The pre must be constrained with a scrollable max-height, and the button must be
      // pinned absolutely over the relative wrapper container.
      expect(pre!.className).toContain("overflow-auto");
      expect(pre!.className).toContain("max-h-");
      expect(copyBtn.className).toContain("absolute");

      const parentWrapper = copyBtn.parentElement;
      expect(parentWrapper).toBeTruthy();
      expect(parentWrapper!.className).toContain("relative");
      expect(parentWrapper!.contains(pre!)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TableDiffDetail Sub-Component
  // ═══════════════════════════════════════════════════════════════════════════

  describe("TableDiffDetail", () => {
    function renderAndSelectTable(tableName: string) {
      const result = renderDiff();
      changeTarget("snap-1");
      fireEvent.click(result.getByText(tableName));
      return result;
    }

    // ── Header ──

    test("shows table name and action badge", () => {
      const { container } = renderAndSelectTable("new_table");
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find((b) => b.textContent === "added");
      expect(addedBadge).toBeTruthy();
    });

    test("removed table shows removed badge", () => {
      const { container } = renderAndSelectTable("old_table");
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const removedBadge = Array.from(badges).find((b) => b.textContent === "removed");
      expect(removedBadge).toBeTruthy();
    });

    test("modified table shows modified badge", () => {
      const { container } = renderAndSelectTable("users");
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const modifiedBadge = Array.from(badges).find((b) => b.textContent === "modified");
      expect(modifiedBadge).toBeTruthy();
    });

    // ── Columns ──

    test('renders "Columns" heading when columns exist', () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("Columns")).toBeTruthy();
    });

    test("renders added column with target type", () => {
      const { getByText } = renderAndSelectTable("new_table");
      expect(getByText("id")).toBeTruthy();
      expect(getByText("integer")).toBeTruthy();
    });

    test("renders removed column with source type", () => {
      const { getByText } = renderAndSelectTable("old_table");
      expect(getByText("name")).toBeTruthy();
      expect(getByText("varchar")).toBeTruthy();
    });

    test("renders modified column with change details", () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("email")).toBeTruthy();
      expect(getByText("Type changed: varchar(100) -> varchar(255)")).toBeTruthy();
    });

    test("added column row has the green hue tint background", () => {
      const { getByText } = renderAndSelectTable("new_table");
      const colRow = getByText("id").closest('div[class*="rounded"]');
      expect(colRow?.className).toContain("bg-hue-green-tint/5");
    });

    test("removed column row has the red hue tint background", () => {
      const { getByText } = renderAndSelectTable("old_table");
      const colRow = getByText("name").closest('div[class*="rounded"]');
      expect(colRow?.className).toContain("bg-hue-red-tint/5");
    });

    test("modified column row has the yellow hue tint background", () => {
      const { getByText } = renderAndSelectTable("users");
      const colRow = getByText("email").closest('div[class*="rounded"]');
      expect(colRow?.className).toContain("bg-hue-yellow-tint/5");
    });

    // ── Indexes ──

    test('renders "Indexes" heading when indexes exist', () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("Indexes")).toBeTruthy();
    });

    test("renders index names and changes", () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("idx_email")).toBeTruthy();
      expect(getByText("idx_old")).toBeTruthy();
      expect(getByText("idx_name")).toBeTruthy();
      expect(getByText("Added index idx_email")).toBeTruthy();
      expect(getByText("Removed index idx_old")).toBeTruthy();
      expect(getByText("Columns changed")).toBeTruthy();
    });

    test("index rows have correct backgrounds", () => {
      const { getByText } = renderAndSelectTable("users");
      const addedIdx = getByText("idx_email").closest('div[class*="rounded"]');
      expect(addedIdx?.className).toContain("bg-hue-green-tint/5");
      const removedIdx = getByText("idx_old").closest('div[class*="rounded"]');
      expect(removedIdx?.className).toContain("bg-hue-red-tint/5");
      const modifiedIdx = getByText("idx_name").closest('div[class*="rounded"]');
      expect(modifiedIdx?.className).toContain("bg-hue-yellow-tint/5");
    });

    test('does not render "Indexes" heading when no indexes', () => {
      const { queryByText } = renderAndSelectTable("new_table");
      expect(queryByText("Indexes")).toBeNull();
    });

    // ── Foreign Keys ──

    test('renders "Foreign Keys" heading when FKs exist', () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("Foreign Keys")).toBeTruthy();
    });

    test("renders FK column names and changes", () => {
      const { getByText } = renderAndSelectTable("users");
      expect(getByText("org_id")).toBeTruthy();
      expect(getByText("dept_id")).toBeTruthy();
      expect(getByText("Added FK on org_id")).toBeTruthy();
      expect(getByText("Removed FK on dept_id")).toBeTruthy();
    });

    test("FK rows have correct backgrounds", () => {
      const { getByText } = renderAndSelectTable("users");
      const addedFK = getByText("org_id").closest('div[class*="rounded"]');
      expect(addedFK?.className).toContain("bg-hue-green-tint/5");
      const removedFK = getByText("dept_id").closest('div[class*="rounded"]');
      expect(removedFK?.className).toContain("bg-hue-red-tint/5");
    });

    test('does not render "Foreign Keys" heading when no FKs', () => {
      const { queryByText } = renderAndSelectTable("new_table");
      expect(queryByText("Foreign Keys")).toBeNull();
    });

    // A foreign key REPOINTED at another table is two entries under one column name:
    // the diff engine keys an FK by `columnName→table.column` (`diff-engine.ts`), so
    // it reports the old one removed and the new one added. Keying the rows by the
    // column name alone gave React two children with the same key — one row, and the
    // half of the change the user needed to see missing.
    test("renders both halves of a foreign key that was repointed", () => {
      mockDiffSchemas.mockImplementation(() =>
        structuredClone({
          tables: [
            {
              action: "modified",
              tableName: "users",
              columns: [],
              indexes: [],
              foreignKeys: [
                { action: "removed", columnName: "org_id", changes: ["Removed FK: org_id -> orgs(id)"] },
                { action: "added", columnName: "org_id", changes: ["Added FK: org_id -> tenants(id)"] },
              ],
            },
          ],
          summary: { added: 0, removed: 0, modified: 1 },
          hasChanges: true,
        }),
      );
      const complaints: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        complaints.push(args.map(String).join(" "));
      };
      try {
        const { getByText, getAllByText } = renderDiff();
        changeTarget("snap-1");
        fireEvent.click(getByText("users"));

        expect(getAllByText("org_id")).toHaveLength(2);
        expect(getByText("Removed FK: org_id -> orgs(id)")).toBeTruthy();
        expect(getByText("Added FK: org_id -> tenants(id)")).toBeTruthy();
      } finally {
        console.error = originalError;
      }
      expect(complaints.filter((line) => line.includes("same key"))).toEqual([]);
    });

    test("renders no action icon for unknown column action", () => {
      mockDiffSchemas.mockImplementation(() =>
        structuredClone({
          tables: [
            {
              action: "modified",
              tableName: "users",
              columns: [
                {
                  action: "unchanged",
                  columnName: "created_at",
                  sourceType: "timestamp",
                  targetType: "timestamp",
                  changes: [] as string[],
                },
              ],
              indexes: [],
              foreignKeys: [],
            },
          ],
          summary: { added: 0, removed: 0, modified: 1 },
          hasChanges: true,
        }),
      );
      const { getByText } = renderDiff();
      changeTarget("snap-1");
      fireEvent.click(getByText("users"));

      const colRow = getByText("created_at").closest('div[class*="rounded"]');
      expect(colRow).toBeTruthy();
      expect(colRow!.querySelector("svg")).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SnapshotTimeline Integration
  // ═══════════════════════════════════════════════════════════════════════════

  describe("SnapshotTimeline integration", () => {
    test("onCompare callback sets source and target", () => {
      renderDiff();
      expect(capturedTimelineProps.onCompare).toBeDefined();

      act(() => {
        capturedTimelineProps.onCompare!("snap-1", "current");
      });

      // Diff should be triggered
      expect(mockDiffSchemas).toHaveBeenCalled();
    });

    test("onDelete callback removes snapshot", () => {
      renderDiff();
      expect(capturedTimelineProps.onDelete).toBeDefined();

      act(() => {
        capturedTimelineProps.onDelete!("snap-1");
      });

      expect(mockDeleteSchemaSnapshot).toHaveBeenCalledWith("snap-1");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-Connection Comparison
  // ═══════════════════════════════════════════════════════════════════════════

  describe("cross-connection comparison", () => {
    test('renders "Fetch from connection" section in target selector', () => {
      const { getByText } = renderDiff();
      expect(getByText("Fetch from connection")).toBeTruthy();
    });

    test("renders remote connections", () => {
      const { getByText } = renderDiff();
      expect(getByText("Remote PG")).toBeTruthy();
      expect(getByText("Prod DB")).toBeTruthy();
    });

    test('does not show "Fetch from connection" when no other connections', () => {
      mockGetConnections.mockImplementation(() => []);
      const { queryByText } = renderDiff();
      expect(queryByText("Fetch from connection")).toBeNull();
    });

    test("production connection shows warning icon", () => {
      const { getByText } = renderDiff();
      // Find Prod DB text and check its parent container for the AlertTriangle icon
      const prodText = getByText("Prod DB");
      const wrapper = prodText.closest('[data-testid^="select-item-"]') || prodText.parentElement;
      expect(wrapper).toBeTruthy();
      // Lucide renders class="lucide lucide-triangle-alert ..."
      const alertIcon = wrapper!.querySelector('svg[class*="alert-triangle"], svg[class*="triangle-alert"]');
      expect(alertIcon).toBeTruthy();
    });

    test("selecting a remote connection reads the object inventory, kinds first", async () => {
      // Two requests, not one (#789): `/api/db/provider-meta` decides which kinds a diff can
      // compare, then the inventory is asked for those kinds with their columns. The route it
      // replaces, `/api/db/schema-snapshot`, is deleted.
      const origFetch = globalThis.fetch;
      const mockFetch = mock((url: string) =>
        Promise.resolve(
          url.includes("provider-meta")
            ? {
                ok: true,
                json: () =>
                  Promise.resolve({
                    capabilities: {
                      queryLanguage: "sql",
                      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                    },
                  }),
              }
            : {
                ok: true,
                json: () =>
                  Promise.resolve({
                    objects: [{ name: "users", kind: "table", path: ["public", "users"] }],
                    details: [{ path: ["public", "users"], columns: [], indexes: [], foreignKeys: [] }],
                  }),
              },
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        renderDiff();
        const fn = getTargetCallback();
        expect(fn).toBeTruthy();

        await act(async () => {
          fn!("conn:remote-1");
        });

        // Six requests, in three pairs: the panel reads the CURRENT schema when it opens
        // (#884), it reads it AGAIN when a target is chosen, because that is the moment
        // someone asks to be told the difference, and the remote selection is its own read.
        // Picked out below by the connection they name rather than by position, because the
        // reads interleave.
        expect(mockFetch).toHaveBeenCalledTimes(6);
        const calls = mockFetch.mock.calls as unknown[][];
        const forRemote = calls.filter(([, init]) =>
          String((init as RequestInit | undefined)?.body ?? "").includes('"id":"remote-1"'),
        );
        expect(forRemote).toHaveLength(2);
        expect(forRemote[0][0]).toBe("/api/db/provider-meta");
        const [url, options] = forRemote[1] as [string, RequestInit];
        expect(url).toBe("/api/db/objects/inventory");
        const body = JSON.parse(options.body as string);
        expect(body.connection.id).toBe("remote-1");
        expect(body.kinds).toEqual(["table"]);
        expect(body.includeColumns).toBe(true);

        expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
        const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
        expect(saved.label).toBe("Live: Remote PG");
        expect(saved.schema).toEqual([
          { name: "users", kind: "table", path: ["public", "users"], columns: [], indexes: [], foreignKeys: [] },
        ]);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("Current Schema is read from the database, not from the prop", async () => {
      // The prop is the copy the explorer last read. Compared against a snapshot taken
      // before a DDL change, a stale copy answers "No differences found" for a change that
      // really happened (#884). The remote side always read the database; this is the same
      // read, for the side that says "current".
      const origFetch = globalThis.fetch;
      const mockFetch = mock((url: string) =>
        Promise.resolve(
          url.includes("provider-meta")
            ? {
                ok: true,
                json: () =>
                  Promise.resolve({
                    capabilities: {
                      queryLanguage: "sql",
                      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                    },
                  }),
              }
            : {
                ok: true,
                json: () =>
                  Promise.resolve({
                    // One object the stale prop does not carry: if the panel is reading the
                    // prop, the diff below cannot see it.
                    objects: [
                      { name: "added_after_the_snapshot", kind: "table", path: ["public", "added_after_the_snapshot"] },
                    ],
                    details: [
                      {
                        path: ["public", "added_after_the_snapshot"],
                        columns: [],
                        indexes: [],
                        foreignKeys: [],
                      },
                    ],
                  }),
              },
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        await act(async () => {
          renderDiff();
        });

        const urls = (mockFetch.mock.calls as unknown[][]).map(([url]) => url);
        expect(urls).toEqual(["/api/db/provider-meta", "/api/db/objects/inventory"]);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("drops the previous connection's objects when the connection changes", async () => {
      // The read runs per connection and the panel stays mounted across a switch, so
      // without a reset "Current Schema" kept the OLD database's objects until the new
      // read landed - and for good if it failed. A snapshot taken in that window is
      // stamped with the new connection and holds the old one's objects, which is the
      // stale-copy defect #884 is about, kept for as long as the snapshot is.
      const origFetch = globalThis.fetch;
      let holdInventory = false;
      const inventory = (name: string) => ({
        ok: true,
        json: () =>
          Promise.resolve({
            objects: [{ name, kind: "table", path: ["public", name] }],
            details: [{ path: ["public", name], columns: [], indexes: [], foreignKeys: [] }],
          }),
      });
      globalThis.fetch = mock((url: string) =>
        url.includes("provider-meta")
          ? Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  capabilities: {
                    queryLanguage: "sql",
                    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                  },
                }),
            })
          : holdInventory
            ? new Promise(() => {})
            : Promise.resolve(inventory("only_on_the_first_connection")),
      ) as unknown as typeof fetch;

      try {
        let rendered!: ReturnType<typeof render>;
        await act(async () => {
          rendered = renderDiff();
        });
        changeTarget("snap-1");
        const first = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
        expect((first[0] as { name: string }[])[0].name).toBe("only_on_the_first_connection");

        // The second connection's read never lands, which is the window that matters.
        holdInventory = true;
        await act(async () => {
          rendered.rerender(<SchemaDiff schema={mockSchema} connection={mockMySQLConnection} />);
        });

        const latest = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
        const names = (latest[0] as { name: string }[]).map((o) => o.name);
        expect(names).not.toContain("only_on_the_first_connection");
        expect(names).toEqual(mockSchema.map((o) => o.name));
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("a connection re-pointed at another database is not matched by its id", async () => {
      // Finding 3. The match was `liveRead.connection.id === connection?.id`, and a connection
      // edited in place KEEPS its id - so after pointing an existing connection at a different
      // host or database the panel matched the PREVIOUS read and presented the old database's
      // objects as "Current Schema" until the new read landed. What the user sees is a diff
      // computed against a database they are no longer pointed at: #884's stale copy, entering
      // through the comparison rather than through the effect. Falling back to the explorer's
      // copy is what it did before the comparison was by id, and it is what it does again.
      const origFetch = globalThis.fetch;
      let holdInventory = false;
      const inventory = (name: string) => ({
        ok: true,
        json: () =>
          Promise.resolve({
            objects: [{ name, kind: "table", path: ["public", name] }],
            details: [{ path: ["public", name], columns: [], indexes: [], foreignKeys: [] }],
          }),
      });
      globalThis.fetch = mock((url: string) =>
        url.includes("provider-meta")
          ? Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  capabilities: {
                    queryLanguage: "sql",
                    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                  },
                }),
            })
          : holdInventory
            ? new Promise(() => {})
            : Promise.resolve(inventory("only_in_the_first_database")),
      ) as unknown as typeof fetch;

      try {
        let rendered!: ReturnType<typeof render>;
        await act(async () => {
          rendered = renderDiff();
        });
        changeTarget("snap-1");
        const first = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
        expect((first[0] as Array<{ name: string }>)[0].name).toBe("only_in_the_first_database");

        // The same entry in the user's list, now pointed at another database, and ITS read
        // never lands - which is the window the defect lives in.
        holdInventory = true;
        await act(async () => {
          rendered.rerender(
            <SchemaDiff schema={mockSchema} connection={{ ...mockPostgresConnection, database: "another_db" }} />,
          );
        });

        const latest = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
        const names = (latest[0] as Array<{ name: string }>).map((o) => o.name);
        expect(names).toEqual(mockSchema.map((o) => o.name));
        expect(names).not.toContain("only_in_the_first_database");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("says on screen when the current schema could not be read", async () => {
      // The panel falls back to the explorer's copy, and that copy is exactly what #884
      // is about - so a failure that is only a log line lets the panel answer "No
      // differences found" from a stale side with nothing on screen saying so.
      const origFetch = globalThis.fetch;
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      globalThis.fetch = mock(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "permission denied for schema public" }) }),
      ) as unknown as typeof fetch;

      try {
        let rendered!: ReturnType<typeof render>;
        await act(async () => {
          rendered = renderDiff();
        });
        expect(rendered.container.textContent).toContain("permission denied for schema public");
        expect(rendered.container.textContent).toContain("explorer");
        expect(warn).toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
        warn.mockRestore();
      }
    });

    test('shows "Fetching..." during remote fetch', async () => {
      const origFetch = globalThis.fetch;
      let resolveFetch!: (v: unknown) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      // The metadata read answers immediately; the inventory is the one held open, because it
      // is the request the spinner is about.
      globalThis.fetch = mock((url: string) =>
        url.includes("provider-meta")
          ? Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  capabilities: {
                    queryLanguage: "sql",
                    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                  },
                }),
            })
          : fetchPromise,
      ) as unknown as typeof fetch;

      try {
        const { queryByText } = renderDiff();
        const fn = getTargetCallback();

        // Start the fetch synchronously, then check for Fetching...
        act(() => {
          fn!("conn:remote-1");
        });

        expect(queryByText("Fetching...")).toBeTruthy();

        // Resolve the fetch
        await act(async () => {
          resolveFetch({ ok: true, json: () => Promise.resolve({ objects: [], details: [] }) });
        });

        expect(queryByText("Fetching...")).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("handles fetch error gracefully", async () => {
      const origFetch = globalThis.fetch;
      // The failure goes to the shared logger, not to `console` — every other
      // component/hook in this tree reports through it, and a bare console call is
      // invisible to whatever the operator has wired the logger up to.
      const warn = spyOn(logger, "warn").mockImplementation(() => {});

      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Unauthorized" }),
        }),
      ) as unknown as typeof fetch;

      try {
        renderDiff();
        const fn = getTargetCallback();

        await act(async () => {
          fn!("conn:remote-1");
        });

        expect(warn).toHaveBeenCalled();
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
        warn.mockRestore();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Two remote fetches in a row
  // ═══════════════════════════════════════════════════════════════════════════

  describe("remote fetch sequencing", () => {
    /**
     * Every INVENTORY read parked until this test settles it, by index; `provider-meta`
     * answers at once so each read gets as far as the request the panel is waiting on.
     *
     * Local, like the other two queues in this file, and for the same reason: these tests
     * settle reads OUT OF ORDER, which is the whole measurement, and the helpers that hold
     * the snapshot and Refresh rules do not.
     *
     * Index 0 is the panel's own read of the connection on screen. 1 is the FIRST remote
     * fetch, 2 the SECOND - so "older" is always 1 and "newer" is always 2, whatever order
     * the network answers them in.
     */
    function queuedReads() {
      const orig = globalThis.fetch;
      type Outcome = { ok: true; objects: string[] } | { ok: false; error: string };
      type Answer = { ok: boolean; json: () => Promise<unknown> };
      const pending: Array<(outcome: Outcome) => void> = [];
      globalThis.fetch = mock((url: string) => {
        if (String(url).includes("provider-meta")) {
          return Promise.resolve<Answer>({
            ok: true,
            json: () =>
              Promise.resolve({
                capabilities: {
                  queryLanguage: "sql",
                  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                },
              }),
          });
        }
        return new Promise<Answer>((resolve) => {
          pending.push((outcome) =>
            resolve({
              ok: outcome.ok,
              json: () =>
                Promise.resolve(
                  outcome.ok
                    ? {
                        objects: outcome.objects.map((name) => ({ name, kind: "table", path: ["public", name] })),
                        details: outcome.objects.map((name) => ({
                          path: ["public", name],
                          columns: [],
                          indexes: [],
                          foreignKeys: [],
                        })),
                      }
                    : { error: outcome.error },
                ),
            }),
          );
        });
      }) as unknown as typeof fetch;
      const flush = () =>
        act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      const settle = async (index: number, outcome: Outcome) => {
        pending[index](outcome);
        await flush();
      };
      return { pending, flush, settle, restore: () => void (globalThis.fetch = orig) };
    }

    /**
     * The value the TARGET select is showing - what the user sees chosen.
     *
     * `""` is "nothing chosen yet": the Select mock keys by the value prop, and the panel
     * starts the target as the empty string.
     */
    function targetValue(container: HTMLElement) {
      const selects = Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="select-"]')).filter((n) =>
        n.querySelector('[data-testid="select-trigger"]'),
      );
      return selects[1]?.getAttribute("data-testid")?.replace(/^select-/, "") ?? null;
    }

    /** Which connection each auto-saved "Live:" snapshot was read from, in order. */
    function savedFrom() {
      return (mockSaveSchemaSnapshot.mock.calls as unknown[][]).map(
        (c) => (c[0] as { connectionId: string }).connectionId,
      );
    }

    /** The id of the snapshot written last, which is what the target should be pointing at. */
    function lastSavedId() {
      const calls = mockSaveSchemaSnapshot.mock.calls as unknown[][];
      return (calls.at(-1)?.[0] as { id: string } | undefined)?.id;
    }

    /** The busy indicator, by the text the user reads. */
    function busy(view: ReturnType<typeof render>) {
      return view.queryByText("Fetching...") !== null;
    }

    /**
     * Mount, answer the panel's own read, then pick one connection and change your mind:
     * two remote fetches are out at once and NEITHER has answered.
     */
    async function twoFetchesOut(q: ReturnType<typeof queuedReads>) {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = renderDiff();
      });
      await q.flush();
      await q.settle(0, { ok: true, objects: ["users"] });

      await act(async () => {
        getTargetCallback()?.("conn:remote-1");
      });
      await q.flush();
      await act(async () => {
        getTargetCallback()?.("conn:remote-2");
      });
      await q.flush();

      // Both reads were actually issued - the measurement means nothing otherwise.
      expect(q.pending.length).toBe(3);
      mockSaveSchemaSnapshot.mockClear();
      savedSnapshots.length = 0;
      return view;
    }

    test("the older fetch succeeding LATE writes neither the snapshot nor the target", async () => {
      const q = queuedReads();
      try {
        const view = await twoFetchesOut(q);

        await q.settle(2, { ok: true, objects: ["prod_table"] });
        const chosen = lastSavedId();
        expect(savedFrom()).toEqual(["remote-2"]);
        expect(targetValue(view.container)).toBe(chosen!);
        expect(busy(view)).toBe(false);

        // The one the user turned away from answers afterwards.
        await q.settle(1, { ok: true, objects: ["remote_table"] });

        expect(savedFrom()).toEqual(["remote-2"]);
        expect(targetValue(view.container)).toBe(chosen!);
        expect(busy(view)).toBe(false);
      } finally {
        q.restore();
      }
    });

    test("the older fetch succeeding EARLY writes nothing and leaves the busy indicator up", async () => {
      const q = queuedReads();
      try {
        const view = await twoFetchesOut(q);

        // The FIRST connection answers first, while the second is still out.
        await q.settle(1, { ok: true, objects: ["remote_table"] });

        expect(savedFrom()).toEqual([]);
        expect(targetValue(view.container)).toBe("");
        // The read the user is waiting for is still running, so the panel still says so.
        expect(busy(view)).toBe(true);

        await q.settle(2, { ok: true, objects: ["prod_table"] });

        expect(savedFrom()).toEqual(["remote-2"]);
        expect(targetValue(view.container)).toBe(lastSavedId()!);
        expect(busy(view)).toBe(false);
      } finally {
        q.restore();
      }
    });

    test("the older fetch FAILING LATE changes nothing on screen", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const q = queuedReads();
      try {
        const view = await twoFetchesOut(q);

        await q.settle(2, { ok: true, objects: ["prod_table"] });
        const chosen = lastSavedId();
        expect(busy(view)).toBe(false);

        // A read that loses the race and then fails is still a read that lost the race.
        await q.settle(1, { ok: false, error: "the connection you left is gone" });

        expect(savedFrom()).toEqual(["remote-2"]);
        expect(targetValue(view.container)).toBe(chosen!);
        expect(busy(view)).toBe(false);
        // Logged, because a log is a record of what the database said, not a claim on screen.
        expect(warn).toHaveBeenCalled();
      } finally {
        q.restore();
        warn.mockRestore();
      }
    });

    test("the older fetch FAILING FIRST does not clear the busy indicator", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const q = queuedReads();
      try {
        const view = await twoFetchesOut(q);

        // The abandoned read fails while the one the user is waiting for is still out.
        await q.settle(1, { ok: false, error: "the connection you left is gone" });

        expect(savedFrom()).toEqual([]);
        expect(targetValue(view.container)).toBe("");
        expect(busy(view)).toBe(true);

        await q.settle(2, { ok: true, objects: ["prod_table"] });

        expect(savedFrom()).toEqual(["remote-2"]);
        expect(busy(view)).toBe(false);
      } finally {
        q.restore();
        warn.mockRestore();
      }
    });

    test("the busy indicator goes down only when the NEWEST fetch settles", async () => {
      // Both ways a superseded read can end, in one run: the panel may not say it has
      // finished while the read the user actually asked for is still outstanding, whether
      // the ones it replaced succeeded or failed.
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const q = queuedReads();
      try {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: ["users"] });

        // Three, in order, and the order is the measurement - so they are not collected
        // into one `Promise.all`.
        const pick = async (id: string) => {
          await act(async () => {
            getTargetCallback()?.(id);
          });
          await q.flush();
        };
        await pick("conn:remote-1");
        await pick("conn:remote-2");
        await pick("conn:remote-1");
        expect(q.pending.length).toBe(4);
        mockSaveSchemaSnapshot.mockClear();
        savedSnapshots.length = 0;

        await q.settle(1, { ok: true, objects: ["remote_table"] });
        expect(busy(view)).toBe(true);
        await q.settle(2, { ok: false, error: "the connection you left is gone" });
        expect(busy(view)).toBe(true);
        expect(savedFrom()).toEqual([]);

        await q.settle(3, { ok: true, objects: ["the_one_asked_for"] });
        expect(busy(view)).toBe(false);
        expect(savedFrom()).toEqual(["remote-1"]);
        expect(targetValue(view.container)).toBe(lastSavedId()!);
      } finally {
        q.restore();
        warn.mockRestore();
      }
    });

    /**
     * A remote read is not the only thing that sets the target, and the other thing is
     * INSTANT: picking a stored snapshot writes the target in the same tick as the click.
     * So the two were in a race the counter did not cover. Pick a connection, change your
     * mind, pick a snapshot from the list - and the read you turned away from lands
     * afterwards and makes ITSELF the target. The panel then shows a comparison nobody
     * asked for, and the choice the user actually made is gone from under them.
     *
     * The rule these hold is one sentence: the most recent thing the USER chose is what the
     * panel shows, and a read that was already running when they chose something else may
     * write neither the target, nor a snapshot, nor the busy indicator.
     */
    describe("a stored snapshot chosen while a remote read is out", () => {
      /**
       * Pick something in the TARGET select, whatever value it happens to be showing.
       *
       * Not `getTargetCallback()`: that one is keyed to the empty value the panel starts
       * with, and these tests choose twice, so the second pick has to go through the
       * callback the select is carrying NOW.
       */
      async function pickTarget(q: ReturnType<typeof queuedReads>, view: ReturnType<typeof render>, value: string) {
        const shown = targetValue(view.container) ?? "";
        const fire = selectCallbacks.get(shown) ?? getTargetCallback();
        await act(async () => {
          fire?.(value);
        });
        await q.flush();
      }

      /** Mount and answer the panel's own read, so index 0 is spent and 1 is the next read. */
      async function mounted(q: ReturnType<typeof queuedReads>) {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: ["users"] });
        mockSaveSchemaSnapshot.mockClear();
        savedSnapshots.length = 0;
        return view;
      }

      test("the abandoned remote read may not take the target back", async () => {
        const q = queuedReads();
        try {
          const view = await mounted(q);

          await pickTarget(q, view, "conn:remote-1"); // read 1: the remote fetch
          expect(busy(view)).toBe(true);

          // The change of mind. A stored snapshot is shown AT ONCE, so nothing the user is
          // waiting for is outstanding any more and the panel may not say there is.
          await pickTarget(q, view, "snap-1"); // read 2: the current-schema read that follows
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(false);
          expect(q.pending.length).toBe(3);

          // The read the user turned away from answers now.
          await q.settle(1, { ok: true, objects: ["remote_table"] });

          // Nothing: not the auto-saved "Live:" snapshot, which would litter the list with a
          // database the user turned away from, and above all not the target.
          expect(savedFrom()).toEqual([]);
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(false);

          // The current-schema read the choice itself started reports on Current Schema and
          // on nothing else, so it is no route back to the target either.
          await q.settle(2, { ok: true, objects: ["users"] });
          expect(targetValue(view.container)).toBe("snap-1");
          expect(savedFrom()).toEqual([]);
        } finally {
          q.restore();
        }
      });

      test("choosing from the timeline is the same choice and supersedes the same read", async () => {
        const q = queuedReads();
        try {
          const view = await mounted(q);

          // The timeline is on screen precisely while no target is chosen - which is where a
          // remote fetch leaves the panel until it lands, so this is a second way into the
          // same moment rather than a different one.
          await pickTarget(q, view, "conn:remote-1"); // read 1
          expect(targetValue(view.container)).toBe("");
          expect(busy(view)).toBe(true);

          await act(async () => {
            capturedTimelineProps.onCompare?.("current", "snap-1");
          });
          await q.flush();
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(false);

          await q.settle(1, { ok: true, objects: ["remote_table"] });

          expect(savedFrom()).toEqual([]);
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(false);
        } finally {
          q.restore();
        }
      });

      test("the other direction: a remote fetch started after a stored choice still wins", async () => {
        // Measured rather than assumed. Choosing a stored snapshot leaves nothing in flight
        // that can WRITE the target - it writes it synchronously and what it starts is a read
        // of Current Schema - so there is no superseding to do on this side. This test says
        // so out loud, and stays as the guard that it keeps being true.
        const q = queuedReads();
        try {
          const view = await mounted(q);

          await pickTarget(q, view, "snap-1"); // read 1: the current-schema read
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(false);

          await pickTarget(q, view, "conn:remote-2"); // read 2: the remote fetch
          expect(busy(view)).toBe(true);
          expect(q.pending.length).toBe(3);

          // The read the stored choice left behind answers LATE, and takes nothing back.
          await q.settle(1, { ok: true, objects: ["users"] });
          expect(targetValue(view.container)).toBe("snap-1");
          expect(busy(view)).toBe(true);

          await q.settle(2, { ok: true, objects: ["prod_table"] });
          expect(savedFrom()).toEqual(["remote-2"]);
          expect(targetValue(view.container)).toBe(lastSavedId()!);
          expect(busy(view)).toBe(false);
        } finally {
          q.restore();
        }
      });

      test("the busy indicator survives a stored choice standing between two fetches", async () => {
        const q = queuedReads();
        try {
          const view = await mounted(q);

          await pickTarget(q, view, "conn:remote-1"); // read 1
          await pickTarget(q, view, "snap-1"); // read 2, and the fetch above is abandoned
          expect(busy(view)).toBe(false);
          await pickTarget(q, view, "conn:remote-2"); // read 3
          expect(busy(view)).toBe(true);
          expect(q.pending.length).toBe(4);

          // The abandoned one answers while the one the user IS waiting for is still out. It
          // may not hand the panel back: the spinner going down here is a fetch reported
          // finished that has not finished.
          await q.settle(1, { ok: true, objects: ["remote_table"] });
          expect(busy(view)).toBe(true);
          expect(savedFrom()).toEqual([]);
          expect(targetValue(view.container)).toBe("snap-1");

          // The newest one clears its own.
          await q.settle(3, { ok: true, objects: ["prod_table"] });
          expect(busy(view)).toBe(false);
          expect(savedFrom()).toEqual(["remote-2"]);
          expect(targetValue(view.container)).toBe(lastSavedId()!);
        } finally {
          q.restore();
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // A fetch that FAILS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Nested here rather than in a block of its own, because it is the same path and these
     * are the same reads: the queue, `twoFetchesOut`, `targetValue`, `savedFrom` and `busy`
     * above are exactly what a failure has to be measured against.
     */
    describe("a failure the user can see", () => {
      /** Mount, answer the panel's own read, then ask ONE remote connection for its schema. */
      async function oneFetchOut(q: ReturnType<typeof queuedReads>) {
        let view!: ReturnType<typeof render>;
        await act(async () => {
          view = renderDiff();
        });
        await q.flush();
        await q.settle(0, { ok: true, objects: ["users"] });
        await act(async () => {
          getTargetCallback()?.("conn:remote-1");
        });
        await q.flush();
        expect(q.pending.length).toBe(2);
        return view;
      }

      /** What "Current Schema" was worth the last time the diff was computed. */
      function currentSideNames() {
        const latest = (mockDiffSchemas.mock.calls as unknown[][]).at(-1)!;
        return (latest[0] as Array<{ name: string }>).map((o) => o.name);
      }

      test("a fetch that fails says so, and says the comparison is not the one asked for", async () => {
        // The defect. The fetch failed, the spinner went down, the target stayed where it
        // was - and the only trace was a log line nobody standing in front of the panel can
        // read. The user is looking at the comparison they had BEFORE and believes it is the
        // database they just picked.
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const q = queuedReads();
        try {
          const view = await oneFetchOut(q);
          await q.settle(1, { ok: false, error: "password authentication failed" });

          const text = view.container.textContent ?? "";
          // What the database said...
          expect(text).toContain("password authentication failed");
          // ...which database did not answer...
          expect(text).toContain("Remote PG");
          // ...and what is on screen instead of it. Phrased so it stays true for as long as
          // the banner is up: choosing a stored target afterwards changes the comparison,
          // and a message that said "unchanged" would quietly become a lie.
          expect(text).toMatch(/comparison on screen is not that database/i);

          // Nothing was written, which is why the message has to exist at all.
          expect(targetValue(view.container)).toBe("");
          expect(savedFrom()).toEqual([]);
          expect(busy(view)).toBe(false);
          // Still logged: the log is the record of what the database said, and it stays.
          expect(warn).toHaveBeenCalled();
        } finally {
          q.restore();
          warn.mockRestore();
        }
      });

      test("Dismiss is the way out, exactly as it is for a snapshot that was not saved", async () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const q = queuedReads();
        try {
          const view = await oneFetchOut(q);
          await q.settle(1, { ok: false, error: "password authentication failed" });
          expect(view.container.textContent).toContain("password authentication failed");

          const dismiss = Array.from(view.container.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Dismiss",
          );
          expect(dismiss).toBeTruthy();
          await act(async () => {
            fireEvent.click(dismiss!);
          });

          expect(view.container.textContent).not.toContain("password authentication failed");
        } finally {
          q.restore();
          warn.mockRestore();
        }
      });

      test("an older fetch failing while the newer one is still out says nothing", async () => {
        // The message belongs to the read the user is WAITING on. A connection they turned
        // away from failing afterwards is not their question being answered, and a banner
        // about it would be a report on a database nobody asked about any more.
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const q = queuedReads();
        try {
          const view = await twoFetchesOut(q);

          await q.settle(1, { ok: false, error: "the connection you left is gone" });

          expect(view.container.textContent).not.toContain("the connection you left is gone");
          expect(busy(view)).toBe(true);

          await q.settle(2, { ok: true, objects: ["prod_table"] });

          expect(view.container.textContent).not.toContain("the connection you left is gone");
          expect(savedFrom()).toEqual(["remote-2"]);
          // Logged all the same, whichever read it was.
          expect(warn).toHaveBeenCalled();
        } finally {
          q.restore();
          warn.mockRestore();
        }
      });

      test("an older fetch failing AFTER the newer one landed says nothing either", async () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const q = queuedReads();
        try {
          const view = await twoFetchesOut(q);

          await q.settle(2, { ok: true, objects: ["prod_table"] });
          const chosen = lastSavedId();

          await q.settle(1, { ok: false, error: "the connection you left is gone" });

          expect(view.container.textContent).not.toContain("the connection you left is gone");
          // The comparison the user DID ask for is untouched by the other one's failure.
          expect(targetValue(view.container)).toBe(chosen!);
          expect(busy(view)).toBe(false);
        } finally {
          q.restore();
          warn.mockRestore();
        }
      });

      test("a fetch that works clears the message the failed one left", async () => {
        // Spent by the next attempt, like the snapshot report: a fetch that arrives is the
        // answer to the one that did not.
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const q = queuedReads();
        try {
          const view = await oneFetchOut(q);
          await q.settle(1, { ok: false, error: "password authentication failed" });
          expect(view.container.textContent).toContain("password authentication failed");

          await act(async () => {
            getTargetCallback()?.("conn:remote-2");
          });
          await q.flush();
          await q.settle(2, { ok: true, objects: ["prod_table"] });

          expect(view.container.textContent).not.toContain("password authentication failed");
          expect(targetValue(view.container)).toBe(lastSavedId()!);
        } finally {
          q.restore();
          warn.mockRestore();
        }
      });

      test("the panel's own read, overtaken while it was still out, does not become Current Schema", async () => {
        // Not the remote path: the read the panel makes on the way IN. It is guarded like
        // every other read here, and nothing measured that guard - it was removed while this
        // defect was being reported and the whole suite stayed green. A read from the moment
        // the panel opened winning over a newer one puts a stale "Current Schema" on screen,
        // which is the defect this panel exists to have stopped.
        const q = queuedReads();
        try {
          let view!: ReturnType<typeof render>;
          await act(async () => {
            view = renderDiff();
          });
          await q.flush();
          expect(q.pending.length).toBe(1);

          // A target is chosen while that read is still out: a newer read of the SAME
          // connection, on the same counter, which supersedes it.
          await act(async () => {
            changeTarget("snap-1");
          });
          await q.flush();
          expect(q.pending.length).toBe(2);

          await q.settle(1, { ok: true, objects: ["what_the_database_holds_now"] });
          // The read from the panel opening answers last, with what the database held before.
          await q.settle(0, { ok: true, objects: ["stale_from_the_panel_opening"] });

          expect(currentSideNames()).toEqual(["what_the_database_holds_now"]);
          expect(currentSideNames()).not.toContain("stale_from_the_panel_opening");
          expect(view.container.textContent).toContain("Schema Diff");
        } finally {
          q.restore();
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // formatSnapshotLabel
  // ═══════════════════════════════════════════════════════════════════════════

  describe("formatSnapshotLabel", () => {
    test("snapshot with label shows label", () => {
      const { getAllByText } = renderDiff();
      const matches = getAllByText(/Before migration/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test("snapshot without label shows connectionName", () => {
      mockGetSchemaSnapshots.mockImplementation(() => [{ ...mockSnapshots[0], label: "" }]);
      const { getAllByText } = renderDiff();
      const matches = getAllByText(/TestDB/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Action Badges (sidebar)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("action badges", () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget("snap-1");
      return result;
    }

    test("added badge has the green hue tint styling", () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find((b) => b.textContent?.includes("Added"));
      expect(addedBadge).toBeTruthy();
      expect(addedBadge!.className).toContain("bg-hue-green-tint/20");
    });

    test("removed badge has the red hue tint styling", () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const removedBadge = Array.from(badges).find((b) => b.textContent?.includes("Removed"));
      expect(removedBadge).toBeTruthy();
      expect(removedBadge!.className).toContain("bg-hue-red-tint/20");
    });

    test("modified badge has the yellow hue tint styling", () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const modifiedBadge = Array.from(badges).find((b) => b.textContent?.includes("Modified"));
      expect(modifiedBadge).toBeTruthy();
      expect(modifiedBadge!.className).toContain("bg-hue-yellow-tint/20");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Snapshot identity, and a snapshot that is gone
  // ═══════════════════════════════════════════════════════════════════════════

  describe("snapshot identity", () => {
    /** The 50 in `storage-facade.ts`: `saveSchemaSnapshot` keeps `snapshots.slice(-50)`. */
    const MAX_SNAPSHOTS = 50;

    /** The same answer to both halves of `readLiveSchema` the snapshot tests above use. */
    function answerReads(objects: Array<{ name: string }> = [{ name: "users" }]) {
      const orig = globalThis.fetch;
      globalThis.fetch = mock((url: string) =>
        Promise.resolve(
          String(url).includes("provider-meta")
            ? {
                ok: true,
                json: () =>
                  Promise.resolve({
                    capabilities: {
                      queryLanguage: "sql",
                      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
                    },
                  }),
              }
            : {
                ok: true,
                json: () =>
                  Promise.resolve({
                    objects: objects.map((o) => ({ name: o.name, kind: "table", path: ["public", o.name] })),
                    details: objects.map((o) => ({
                      path: ["public", o.name],
                      columns: [],
                      indexes: [],
                      foreignKeys: [],
                    })),
                  }),
              },
        ),
      ) as unknown as typeof fetch;
      return { restore: () => void (globalThis.fetch = orig) };
    }

    /** One press of Snapshot then Save, awaited. */
    async function saveOnce(getByText: (text: string) => HTMLElement) {
      fireEvent.click(getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });
    }

    type Row = { id: string; label?: string; schema: unknown };

    /**
     * The store as `storage-facade.ts` really behaves: `getSchemaSnapshots` hands back a COPY
     * (a stable reference would leave `setSnapshots` a no-op and the panel would never notice
     * a change), `saveSchemaSnapshot` appends and keeps the last 50, and `deleteSchemaSnapshot`
     * filters by id - which is the line that removes two rows when two rows share one.
     */
    function useStore(initial: Row[]) {
      const rows: Row[] = [...initial];
      mockGetSchemaSnapshots.mockImplementation(() => [...rows]);
      mockSaveSchemaSnapshot.mockImplementation((snapshot?: unknown) => {
        rows.push(snapshot as Row);
        rows.splice(0, Math.max(0, rows.length - MAX_SNAPSHOTS));
      });
      mockDeleteSchemaSnapshot.mockImplementation(((id: string) => {
        const kept = rows.filter((s) => s.id !== id);
        rows.length = 0;
        rows.push(...kept);
      }) as unknown as () => void);
      return rows;
    }

    /** Hold the clock still, so two saves really are in the same millisecond. */
    function freezeClock() {
      const realNow = Date.now;
      Date.now = () => 1_789_751_388_465;
      return () => void (Date.now = realNow);
    }

    test("two snapshots taken in the same millisecond do not share an id", async () => {
      // `Date.now().toString()` is the scheme that fails this: the clock is what the id was,
      // so holding the clock still makes the two ids identical. Measured against the real
      // store before this was fixed - two rows, one id.
      const unfreeze = freezeClock();
      const rows = useStore([]);
      const { restore } = answerReads();
      try {
        const { getByText, container } = renderDiff();
        await saveOnce(getByText);
        await saveOnce(getByText);

        expect(rows.length).toBe(2);
        expect(rows[0].id).not.toBe(rows[1].id);

        // And React therefore has two keys to list them by, not one. Each snapshot is an
        // option in BOTH Selects, so the ids are counted as a set.
        const listed = Array.from(container.querySelectorAll("[data-value]"))
          .map((n) => n.getAttribute("data-value"))
          .filter((v) => v === rows[0].id || v === rows[1].id);
        expect(new Set(listed).size).toBe(2);
      } finally {
        restore();
        unfreeze();
      }
    });

    test("deleting one of two snapshots taken in the same millisecond deletes exactly one", async () => {
      const unfreeze = freezeClock();
      const rows = useStore([]);
      const { restore } = answerReads();
      try {
        const { getByText } = renderDiff();
        await saveOnce(getByText);
        await saveOnce(getByText);
        expect(rows.length).toBe(2);

        const doomed = rows[0].id;
        const survivor = rows[1].id;
        act(() => {
          capturedTimelineProps.onDelete!(doomed);
        });

        // One row clicked, one row gone. With the clock id this left nothing behind.
        expect(rows.map((s) => s.id)).toEqual([survivor]);
      } finally {
        restore();
        unfreeze();
      }
    });

    test("a selected snapshot pushed out of the 50-snapshot window is not compared as an empty database", async () => {
      // No collision is needed for this one, and that is the point: the store keeps the last
      // 50, so the 51st save drops the oldest - and the oldest is the one being compared.
      const older: Row[] = [{ ...mockSnapshots[0] } as Row];
      for (let i = 0; i < MAX_SNAPSHOTS - 1; i++) {
        older.push({ ...mockSnapshots[0], id: `filler-${i}` } as Row);
      }
      const rows = useStore(older);
      const { restore } = answerReads();
      try {
        const { getByText, queryByText } = renderDiff();
        changeTarget("snap-1");
        // It compares while the snapshot is still in the store.
        expect(getByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();

        mockDiffSchemas.mockClear();
        await saveOnce(getByText); // the 51st: "snap-1" falls off the end
        expect(rows.some((s) => s.id === "snap-1")).toBe(false);

        // What the panel used to do here was hand the diff `[]` and report every table and
        // every column in the database as removed. It says what is actually wrong instead.
        expect(getByText(/no longer stored/)).toBeTruthy();
        expect(queryByText(/1 added, 1 removed, 1 modified/)).toBeNull();

        // And the engine was never asked to compare anything against an empty side.
        const emptySided = (mockDiffSchemas.mock.calls as unknown[][]).filter((call) =>
          call.some((arg) => Array.isArray(arg) && arg.length === 0),
        );
        expect(emptySided.length).toBe(0);
      } finally {
        restore();
      }
    });

    test("snapshots written under the old clock scheme still list, still compare and still delete", () => {
      // Records already in a user's browser, ids and all. Nothing migrates them, and after
      // this change nothing needs to: the id is read, never parsed, and the store still
      // finds and removes them by the string they were written with.
      const rows = useStore([
        { ...mockSnapshots[0], id: "1789751388465", label: "Saved before the fix" } as Row,
        { ...mockSnapshots[0], id: "remote-1789751388465", label: "Fetched before the fix" } as Row,
      ]);
      const { getByText, container } = renderDiff();
      expect(container.querySelector('[data-value="1789751388465"]')).toBeTruthy();
      expect(container.querySelector('[data-value="remote-1789751388465"]')).toBeTruthy();

      act(() => {
        capturedTimelineProps.onDelete!("remote-1789751388465");
      });
      expect(mockDeleteSchemaSnapshot).toHaveBeenCalledWith("remote-1789751388465");
      expect(rows.map((s) => s.id)).toEqual(["1789751388465"]);

      // The one left still opens as a side of the comparison.
      changeTarget("1789751388465");
      expect(getByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();
    });

    test("an old pair that already shares an id goes as a pair, and the panel says so rather than reporting the database wiped", async () => {
      // Two records a user already has, both written by `Date.now().toString()` in one
      // millisecond. Nothing repairs those: the store filters by id, so removing one still
      // removes both. What IS repaired is the answer the panel gives afterwards.
      const shared = "1789751388465";
      const rows = useStore([
        { ...mockSnapshots[0], id: shared, label: "Old twin A" } as Row,
        { ...mockSnapshots[0], id: shared, label: "Old twin B" } as Row,
      ]);
      const { restore } = answerReads();
      try {
        const { getByText, queryByText } = renderDiff();
        changeTarget(shared);
        expect(getByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();

        act(() => {
          capturedTimelineProps.onDelete!(shared);
        });
        expect(rows.length).toBe(0); // both, from one click - the old data's own defect

        mockDiffSchemas.mockClear();
        await saveOnce(getByText); // any refresh of the list; the selection still names `shared`
        expect(getByText(/no longer stored/)).toBeTruthy();
        expect(queryByText(/1 added, 1 removed, 1 modified/)).toBeNull();
      } finally {
        restore();
      }
    });
  });
});
