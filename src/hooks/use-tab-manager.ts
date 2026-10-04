"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { ColumnSchema, DatabaseConnection, QueryTab } from "@/lib/types";
import type { DatabaseObject } from "@/lib/db/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { generateTableQuery, generateSelectQuery, generateCountQuery, objectSegment } from "@/lib/query-generators";
import { objectPathLabel, pathKey } from "@/lib/db/object-path";
import { resolveTabType } from "@/lib/editor/tab-language";
import { logger } from "@/lib/logger";
import { newLocalId } from "@/lib/ids";
import { useStableCallback } from "@/hooks/use-stable-callback";

/** A tab `closeTab` removed, where it sat, and the workspace it sat in, so its Undo can put it back (#747). */
interface ClosedTab {
  tab: QueryTab;
  index: number;
  /** The tab to its right when it closed, or null when it was last: the anchor that survives other closes. */
  nextTabId: string | null;
  workspaceKey: string;
}

/**
 * How many rows a tree click asks for (#816).
 *
 * It used to be written into the generated statement — `LIMIT 50`, `FETCH FIRST 50 ROWS
 * ONLY`, `SELECT TOP 50` — and that is exactly what disengaged pagination: a statement
 * carrying its own bound is returned untouched by the limiter, which drops the requested
 * offset with it, so the page after the first was the first again. Carried as an
 * EXECUTION OPTION instead, the preview cap is a bound this layer applied and can
 * advance, and a `LIMIT n` in the editor means only what the user meant by it.
 *
 * It matches the "Select Top 50" label in `ProviderLabels.selectAction`.
 */
export const PREVIEW_PAGE_SIZE = 50;

/**
 * How a shell runs the statement a tree click just opened.
 *
 * Wider than the two arguments this used to take, because the page size now travels
 * beside the query rather than inside it. Both shells satisfy it with their own
 * `executeQuery` — `useQueryExecution` in `Studio.tsx`, `useQueryAdapter` in
 * `StudioWorkspace.tsx` — and the embedded one forwards the options to its host's
 * `onQueryExecute`, which has always accepted them (`src/workspace/types.ts`).
 */
export type RunTabStatement = (query: string, tabId: string, isExplain?: boolean, options?: { limit?: number }) => void;

const DEFAULT_TAB: QueryTab = {
  id: "default",
  name: "Query 1",
  query: "",
  result: null,
  isExecuting: false,
  type: "sql",
};

/** The tab a Source read is mounted in: an ADDRESS, an empty query and no result (#789). */
function sourceTab(id: string, object: DatabaseObject): QueryTab {
  return {
    id,
    // The QUALIFIED path and not the object's label: two containers may hold a routine of the
    // same name, and the tab strip is the only place a reader can tell two open Source tabs
    // apart.
    name: `Source: ${objectPathLabel(object.path)}`,
    query: "",
    result: null,
    isExecuting: false,
    type: "sql",
    source: { path: object.path, kind: object.kind },
  };
}

const WORKSPACE_STORAGE_PREFIX = "libredb_workspace_tabs_v1";

interface PersistedTabState {
  id: string;
  name: string;
  query: string;
  type: QueryTab["type"];
  /**
   * A Source tab's ADDRESS, and never one character of its definition (#789 Phase 2).
   *
   * `SourceTabState` also carries the document, the failure sentence, the active part and the
   * read token; none of the four is written here, and the reason is arithmetic rather than
   * taste. This record is one `JSON.stringify` of the WHOLE workspace, written by the
   * `setItem` below with no `try`/`catch` around it, against an origin quota of about 5 MiB
   * that ten other collections in this application already share. A definition the user did
   * not type is unbounded from the shell's point of view - the route bounds one part at a
   * million characters - so persisting it is a `QuotaExceededError` waiting for a large enough
   * object, and the symptom would not be a broken Source tab: an uncaught throw in that timer
   * stops tab persistence for EVERYTHING.
   *
   * So a restored Source tab carries the address alone and RE-READS, which costs one request
   * per restored tab and is the same read the tab issued when it was opened. The viewer
   * already treats "no document and no failure" as its cue to read, so nothing else is needed
   * to make it happen.
   */
  source?: { path: readonly string[]; kind: string };
  /**
   * The numbered database a key tab belongs to, and the one extra field here that costs
   * nothing to keep (the #1095 review).
   *
   * It is one small INTEGER that only the engine's own database list can produce and nothing
   * in the shell can grow, so it is not the unbounded payload the `source` docblock above
   * refuses: that refusal exists so a large object cannot exhaust the origin quota this record
   * shares, and no input makes this number large. Dropping the field, on the other hand, puts
   * the reviewer's `(nil)` back in a form nobody would notice: the statement that reads the key
   * cannot name its database, so a restored key tab with no override silently runs against the
   * session's database and answers the same `(nil)` a fresh activation used to.
   *
   * ABSENT AND ABSENT ALONE, which is why this key is written only for a tab that has one and
   * restored only when the stored value is a number. `0` is a database somebody walked and is
   * persisted as one; an ordinary tab's record is the record it has always been, so nothing
   * downstream can read a `0`, a `null` or a string as an override that was never there.
   *
   * THE EMBEDDED SHELL CANNOT MINT ONE, and that is why nothing in `use-query-adapter` reads
   * this field. Its host callback is keyed by connection id and takes no per-run database, and
   * the key panel, the only surface that walks one database, is withheld from that shell by
   * `Sidebar`'s `objectSource` gate, added by the same commit that added
   * `QueryTab.databaseOverride`. A tab in the embedded shell therefore never carries an
   * override to honour, and persisting this field does not hand the embedded path a value it
   * must act on.
   */
  databaseOverride?: number;
}

/**
 * Is what came back out of `JSON.parse` an ADDRESS, rather than something shaped like one?
 *
 * This is the first persisted field anything DEREFERENCES, and that is the whole reason it
 * needs a check the other four do not (#789 Phase 2, round 1 finding 2). `id`, `name`,
 * `query` and `type` are strings that get rendered; a truncated or hand-edited one is a wrong
 * label. `source` is branched on by the editor pane and its `path` is read by the viewer's
 * `pathKey(path)` on the first line of its body, so a record carrying `source: {}` renders a
 * pane that throws "undefined is not an object (evaluating 'path.join')". MEASURED before this
 * function existed: that throw happens during a mount rather than inside the LOAD effect's
 * `try`, nothing here catches it, there is no error boundary around the pane, and the whole
 * shell white-screens with the reader unable to reach the tab strip to close the tab.
 *
 * `source: null` was survivable only by accident: it threw on `tab.source.path` INSIDE the
 * effect's `try`, so the fallback ran and every other tab in the workspace was lost with it.
 * Both shapes are now dropped key by key, so a bad address costs its own tab's source arm and
 * nothing else. An unreadable stored value is not a state to recover into: the entry says the
 * tab is a Source tab and cannot say for which object, and the honest answer is the ordinary
 * empty tab the record's other four fields already describe.
 *
 * The elements of `path` are deliberately NOT walked. A non-string segment reaches the route,
 * which validates the whole request shape server-side and answers its own sentence, and the
 * viewer renders that sentence: one refusal in the pane beats a second vocabulary here.
 */
function isStoredSourceAddress(value: unknown): value is { path: readonly string[]; kind: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { path?: unknown; kind?: unknown };
  return Array.isArray(candidate.path) && typeof candidate.kind === "string";
}

interface PersistedWorkspaceState {
  activeTabId: string;
  tabs: PersistedTabState[];
}

interface UseTabManagerParams {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  schema: readonly DetailedObject[];
  persistWorkspace?: boolean;
}

export function useTabManager({ activeConnection, metadata, schema, persistWorkspace }: UseTabManagerParams) {
  const [tabs, setTabs] = useState<QueryTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>("default");
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");
  const [isWorkspaceHydrated, setIsWorkspaceHydrated] = useState(false);

  const workspaceKey = useMemo(
    () => `${WORKSPACE_STORAGE_PREFIX}:${activeConnection?.id ?? "default"}`,
    [activeConnection?.id],
  );
  const shouldPersistWorkspace = persistWorkspace ?? process.env.NODE_ENV !== "test";

  const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // LOAD EFFECT — restore tabs from localStorage on connection switch
  useEffect(() => {
    // Deliberate: this flag has no derivable value during render (it exists purely to gate
    // the SAVE EFFECT below from writing back a load in progress), so there is no "don't use
    // an effect" alternative here — it is intentionally the reset half of a two-effect
    // load/ready handshake, not state that could be computed instead of set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsWorkspaceHydrated(false);
    if (!shouldPersistWorkspace) return;

    const storage = typeof globalThis !== "undefined" && "localStorage" in globalThis ? globalThis.localStorage : null;
    if (!storage) return;

    try {
      const raw = storage.getItem(workspaceKey);
      if (!raw) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const parsed = JSON.parse(raw) as PersistedWorkspaceState;
      if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const restoredTabs: QueryTab[] = parsed.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        query: tab.query,
        type: tab.type,
        result: null,
        isExecuting: false,
        // The address only, and an absent OR malformed key stays absent: every record written
        // before this field existed is a tab that is not a Source tab, and there is no
        // migration because "no source" is exactly what those records mean. The three
        // read-state fields are deliberately not restored, so the viewer issues the read
        // (#789). See `isStoredSourceAddress` for why this one field is checked and the other
        // four are not.
        ...(isStoredSourceAddress(tab.source) ? { source: { path: tab.source.path, kind: tab.source.kind } } : {}),
        // The same spread-not-write rule as the factory that mints a key tab, and the same
        // reason: `undefined` is not database `0`, it is the absence of an override, so a
        // restored ordinary tab comes back without the key at all. The check is a `typeof`
        // against `"number"` and deliberately no heavier: a stored `true` is a hand-edited
        // record rather than the record this hook writes, and refusing it costs that tab an
        // override instead of sending a database nobody walked. See `PersistedTabState`.
        ...(typeof tab.databaseOverride === "number" ? { databaseOverride: tab.databaseOverride } : {}),
      }));

      const hasActiveTab = restoredTabs.some((tab) => tab.id === parsed.activeTabId);
      setTabs(restoredTabs);
      setActiveTabId(hasActiveTab ? parsed.activeTabId : restoredTabs[0].id);
    } catch (error) {
      logger.warn("Failed to restore workspace tabs; falling back to a single empty tab", {
        route: "use-tab-manager",
        error: error instanceof Error ? error.message : String(error),
      });
      setTabs([DEFAULT_TAB]);
      setActiveTabId(DEFAULT_TAB.id);
    }
    // NOTE: hydration flag stays false — set by ready effect below.
  }, [workspaceKey, shouldPersistWorkspace]);

  // READY EFFECT — flips the flag on the first render after the LOAD EFFECT reset it
  useEffect(() => {
    if (!shouldPersistWorkspace || isWorkspaceHydrated) return;
    // Deliberate: this is the flip half of the same handshake as the LOAD EFFECT's reset
    // above — it must run in an effect because it depends on that reset having already
    // committed. The flag is the only trigger it needs: the LOAD EFFECT is the sole writer
    // of `tabs`/`activeTabId` on a connection switch and it resets the flag in the same
    // pass, so every render in which this effect has work to do is already a render in
    // which `isWorkspaceHydrated` changed. Listing the tabs here only re-ran the guard.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsWorkspaceHydrated(true);
  }, [shouldPersistWorkspace, isWorkspaceHydrated]);

  // SAVE EFFECT — debounced write to localStorage (500ms)
  useEffect(() => {
    if (!shouldPersistWorkspace) return;
    const storage = typeof globalThis !== "undefined" && "localStorage" in globalThis ? globalThis.localStorage : null;
    if (!isWorkspaceHydrated || !storage) return;

    const timer = setTimeout(() => {
      const serialized: PersistedWorkspaceState = {
        activeTabId,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          name: tab.name,
          query: tab.query,
          type: tab.type,
          // Two fields of `SourceTabState` and never the other four: see `PersistedTabState`.
          ...(tab.source === undefined ? {} : { source: { path: tab.source.path, kind: tab.source.kind } }),
          // Spread for the same reason the restore effect spreads: an ordinary tab's record must
          // not grow a `databaseOverride` key, because a stored `undefined` reads back as
          // "the connection's own database" by accident rather than by the type saying so.
          ...(tab.databaseOverride === undefined ? {} : { databaseOverride: tab.databaseOverride }),
        })),
      };
      storage.setItem(workspaceKey, JSON.stringify(serialized));
    }, 500);

    return () => clearTimeout(timer);
  }, [tabs, activeTabId, workspaceKey, shouldPersistWorkspace, isWorkspaceHydrated]);

  const updateTabById = useCallback((tabId: string, updates: Partial<QueryTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)));
  }, []);

  const updateCurrentTab = useCallback(
    (updates: Partial<QueryTab>) => {
      updateTabById(activeTabId, updates);
    },
    [activeTabId, updateTabById],
  );

  const addTab = useCallback(() => {
    const newId = newLocalId();
    setTabs((prev) => [
      ...prev,
      {
        id: newId,
        name: `Query ${prev.length + 1}`,
        query: "",
        result: null,
        isExecuting: false,
        type: resolveTabType(metadata?.capabilities),
      },
    ]);
    setActiveTabId(newId);
  }, [metadata]);

  /*
   * The Undo toasts still on screen, and the workspace the hook is showing (#747).
   *
   * Each toast closes over the tab it names rather than sharing one "last closed" slot: sonner
   * keeps several toasts up at once, so a shared slot let the Undo under `Closed "Query 1"`
   * restore Query 2. A closed tab belongs to the workspace it was closed in, so a connection
   * switch dismisses the outstanding toasts, and a click that lands during the dismissal is
   * checked against the workspace key: restoring it into another connection duplicated the
   * `default` id there and the SAVE EFFECT persisted the duplicate.
   */
  const undoToastIdsRef = useRef<Array<string | number>>([]);
  const workspaceKeyRef = useRef(workspaceKey);
  useEffect(() => {
    workspaceKeyRef.current = workspaceKey;
    for (const id of undoToastIdsRef.current) toast.dismiss(id);
    undoToastIdsRef.current = [];
  }, [workspaceKey]);

  const reopenClosedTab = useCallback((closed: ClosedTab) => {
    if (closed.workspaceKey !== workspaceKeyRef.current) return;
    setTabs((prev) => {
      // A tab id is unique in a workspace. It is already present when this Undo was clicked
      // before, or when a Source tab, whose id is derived from its address, was opened again.
      if (prev.some((t) => t.id === closed.tab.id)) return prev;
      // Back before its right-hand neighbour when that tab is still open. The index alone is
      // stale as soon as another tab to its left closes too, which is the ordinary way to tidy up.
      const anchor = closed.nextTabId === null ? -1 : prev.findIndex((t) => t.id === closed.nextTabId);
      const next = [...prev];
      next.splice(anchor === -1 ? Math.min(closed.index, next.length) : anchor, 0, closed.tab);
      return next;
    });
    setActiveTabId(closed.tab.id);
  }, []);

  // One identity for the strip, whose memoized bar must not re-render on a keystroke (X5):
  // the handler reads `tabs` and `activeTabId`, both of which change with the query on
  // every keystroke, so a plain `useCallback` would mint a new function each time.
  const closeTab = useStableCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    const closed: ClosedTab = { tab: tabs[index], index, nextTabId: tabs[index + 1]?.id ?? null, workspaceKey };

    // The last-tab guard is evaluated again inside the updater, against the state actually
    // being written: two closes batched into one commit both pass the check above.
    setTabs((prev) => (prev.length === 1 ? prev : prev.filter((t) => t.id !== id)));
    if (activeTabId === id) {
      const remaining = tabs.filter((t) => t.id !== id);
      setActiveTabId(remaining[remaining.length - 1].id);
    }

    const toastId = toast(`Closed "${closed.tab.name}"`, {
      action: { label: "Undo", onClick: () => reopenClosedTab(closed) },
    });
    undoToastIdsRef.current.push(toastId);
  });

  /**
   * Open a tab holding the statement for one object and RUN it, or focus the one already open
   * for that object, on this connection, while its statement is unedited. A focused tab whose
   * last run failed is run again, in place. Takes the object's PATH and nothing else (#789).
   *
   * The path is the address and the name is only a label (standing ruling 2), so the
   * lookup that finds this object's columns joins on the path, segment by segment, the
   * same key `describeObjects` joins on. It used to compare `t.name === tableName`, which
   * both missed an object outside the session default container and could match the wrong
   * one where two containers hold the same name.
   *
   * The tab is still named after the object's own segment, which is what it was named
   * before: a tab reading `customers` over a statement that says `app.customers` is the
   * label doing its job.
   *
   * Takes executeQuery as a callback param to avoid a circular dependency.
   */
  const handleTableClick = useCallback(
    (
      path: readonly string[],
      executeQueryFn: RunTabStatement,
      /**
       * Columns to generate from, for an object the schema cache does NOT hold.
       *
       * The Redis generator is type-aware and reads a key's type off a `type` column (#427), which
       * the schema carries for a prefix GROUP and cannot for one key: a key is not a schema node. The
       * key browser knows the type already — the server sends each key's type with the page it
       * arrived in — so it hands it over. The alternative is worse than one more parameter: the
       * generator would fall back to asking `TYPE`, and the editor would open on a command that only
       * reports the type of the value nobody has read yet.
       */
      columnsOverride?: readonly ColumnSchema[],
      /**
       * The numbered database this tab belongs to, for a caller that knows the object came from one
       * that is not the connection's own.
       *
       * The key browser is the only such caller: it walks ONE numbered database and every key is a
       * key OF that one, which is a fact the statement reading it cannot carry (Redis has no
       * database-qualified key syntax) and the schema cache cannot answer (see `QueryTab`). Absent
       * means the ordinary activation, whose tab reaches whatever database the connection names.
       */
      databaseOverride?: number,
    ) => {
      const key = pathKey(path);
      /*
       * A data tab already open for this object, on this connection, in this database, and still
       * on the statement it was opened with, is FOCUSED and not run again: the rule
       * `openSourceTab` keeps for a Source tab. Measured before this, three activations of one
       * table left three identical tabs and three reads, and clicking twice did what pressing
       * Space twice does.
       *
       * The connection is part of the match because two connections can hold the same path, and
       * a tab opened on one can outlive the switch to another where storage is unavailable: the
       * load effect then returns before it resets the tabs.
       *
       * A matched tab whose last run FAILED is run again, in that tab. It holds no rows to keep,
       * only the error, and activating the object is the reader asking for its data.
       *
       * The query comparison is what keeps the reader's work out of reach. A tab whose
       * statement has been edited is never captured, so the activation opens a fresh one.
       *
       * Read from the committed `tabs`, as `openSourceTab` reads it. Two activations inside one
       * React batch both miss and both open, which no gesture reaches: separate DOM events flush
       * between them. The id is not derived from the address the way a Source tab's is, because
       * an edited tab and a fresh one for the same object must be able to stand side by side.
       */
      const open = tabs.find(
        (tab) =>
          tab.origin !== undefined &&
          tab.origin.connectionId === activeConnection?.id &&
          pathKey(tab.origin.path) === key &&
          tab.origin.databaseOverride === databaseOverride &&
          tab.query === tab.origin.query,
      );
      if (open !== undefined) {
        setActiveTabId(open.id);
        if (open.runError !== undefined) {
          // The same call, options and deferral as the fresh tab's run below.
          setTimeout(() => executeQueryFn(open.query, open.id, false, { limit: PREVIEW_PAGE_SIZE }), 100);
        }
        return;
      }

      const capabilities = metadata?.capabilities;
      const tableName = objectSegment(path);
      // Look the object up exactly as handleGenerateSelect does: the Redis generator is
      // type-aware, and the sampled key type lives on the schema node's `type` column (#427).
      const table = schema.find((t) => pathKey(t.path) === key);
      const columns = columnsOverride ?? table?.columns ?? [];
      // A group's readable pieces ride on its schema entry, and only the etcd arm reads them (#1089 4.7).
      const newQuery = capabilities
        ? generateTableQuery(path, capabilities, columns, { readRanges: table?.readRanges })
        : `SELECT * FROM ${path.join(".")};`;

      const newId = newLocalId();
      const newTab: QueryTab = {
        id: newId,
        name: tableName,
        query: newQuery,
        result: null,
        isExecuting: false,
        type: resolveTabType(capabilities),
        // Spread rather than written, so an ordinary activation's tab is the record it has always
        // been: absent means "the connection's own database" and a key of `undefined` is not that.
        ...(databaseOverride === undefined ? {} : { databaseOverride }),
        // Written with the same spread rule, so the origin says "no override" by absence too.
        origin: {
          path,
          ...(activeConnection === null ? {} : { connectionId: activeConnection.id }),
          ...(databaseOverride === undefined ? {} : { databaseOverride }),
          query: newQuery,
        },
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
      // The preview cap travels HERE and not in `newQuery`. `isExplain` is false
      // explicitly because the options are the fourth argument, and a tree click is a
      // results run.
      setTimeout(() => executeQueryFn(newQuery, newId, false, { limit: PREVIEW_PAGE_SIZE }), 100);
    },
    [activeConnection, metadata, schema, tabs],
  );

  /** The same address and the same join as `handleTableClick`, without the run (#789). */
  const handleGenerateSelect = useCallback(
    (path: readonly string[]) => {
      const capabilities = metadata?.capabilities;
      const tableName = objectSegment(path);
      const key = pathKey(path);
      const table = schema.find((t) => pathKey(t.path) === key);
      const columns = table?.columns || [];

      // The group's readable pieces and the connection's own mode, which only the etcd arm reads (#1089 6.4):
      // on a read-only connection Generate Command writes the read alone.
      const scope = { readRanges: table?.readRanges, readOnly: activeConnection?.readOnly === true };
      const newQuery = capabilities
        ? generateSelectQuery(path, columns, capabilities, scope)
        : `SELECT\n${columns.map((c) => `  ${c.name}`).join(",\n") || "  *"}\nFROM ${path.join(".")}\nWHERE 1=1\nLIMIT 100;`;

      const tabType = resolveTabType(capabilities);

      const newId = newLocalId();
      setTabs((prev) => [
        ...prev,
        {
          id: newId,
          name: `Query: ${tableName}`,
          query: newQuery,
          result: null,
          isExecuting: false,
          type: tabType,
        },
      ]);
      setActiveTabId(newId);
    },
    [activeConnection, metadata, schema],
  );

  const handleGenerateCount = useCallback(
    (path: readonly string[]) => {
      const capabilities = metadata?.capabilities;
      if (capabilities === undefined) return;
      const query = generateCountQuery(path, capabilities);
      if (query === null) return;
      const id = newLocalId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          name: `Count: ${objectSegment(path)}`,
          query,
          result: null,
          isExecuting: false,
          type: resolveTabType(capabilities),
        },
      ]);
      setActiveTabId(id);
    },
    [metadata],
  );

  /**
   * Open one object's DEFINITION in a read-only Source tab, or focus the one already open
   * against that object (#789 Phase 2).
   *
   * The tab carries the ADDRESS and nothing else. It holds no document, no failure and no
   * read token, and that absence is the instruction: the viewer reads when it is handed
   * neither, so a freshly opened tab and a tab restored from storage take the same path.
   *
   * The match is `pathKey(path)` plus the KIND, and both halves are load-bearing.
   * `pathKey` rather than a join or a `JSON.stringify` per standing ruling 5g: its separator
   * is a control character no engine admits inside an identifier, so `["a.b"]` and
   * `["a", "b"]` cannot collide, while JSON escaping rewrites exotic names. And the kind,
   * because one name addresses more than one object of different kinds in one container on
   * MySQL, MariaDB and DuckDB, measured in this epic, so matching on the path alone would
   * focus the procedure's tab for a reader who asked for the table's definition.
   *
   * `type` is the neutral `"sql"`. Nothing reads it on a Source tab: the tab bar's icon and
   * the editor pane both branch on `source` being present, and the definition's own Monaco
   * language travels on the PART the provider built rather than on the tab.
   */
  const openSourceTab = useCallback(
    (object: DatabaseObject) => {
      const key = pathKey(object.path);
      const matchesAddress = (tab: QueryTab): boolean =>
        tab.source !== undefined && tab.source.kind === object.kind && pathKey(tab.source.path) === key;
      /*
       * A Source tab already open for this address is FOCUSED rather than minted again, and
       * the read from `tabs` here is the committed list, which is what carries the id of a
       * tab restored from `localStorage` with an id this function did not choose.
       */
      const open = tabs.find(matchesAddress);
      if (open !== undefined) {
        setActiveTabId(open.id);
        return;
      }
      /*
       * The id is DERIVED FROM THE ADDRESS rather than minted, and that is what makes two
       * opens inside one React batch safe (#789 Phase 2, round 1 finding 3).
       *
       * The defect: the dedup above reads the `tabs` of the render that built this callback,
       * so two calls in ONE batch both miss and, with a minted id, both append. The tab strip
       * then held two tabs with identical names, the first orphaned and read by nothing. Two
       * separate DOM events flush between them, which is why no gesture in this shell reaches
       * it; a host callback calling the embedded adapter twice does.
       *
       * MEASURED, and it is why the dedup was not simply moved inside the updater, which is
       * the obvious fix: `setActiveTabId` runs when the event runs, while the updater runs at
       * the next render, so an id resolved inside the updater is not yet known at the moment
       * the active tab is set. With that shape the strip held one tab and `activeTabId` named
       * the second call's unused id, so `currentTab` fell back to `tabs[0]` and the reader
       * pressing View Source twice landed on the query tab.
       *
       * Deriving the id closes both halves at once: both calls in the batch compute the same
       * id, so the second finds the first's append inside the updater and neither the strip
       * nor the active id can disagree. Uniqueness is not weakened: the address of a Source
       * tab is unique by construction, because this is the only function that mints one and
       * it refuses to mint a second for an address already open.
       *
       * ENCODED, and that is not decoration. Every other tab id in this shell is random
       * alphanumeric, and `StudioTabBar` moves focus with
       * `querySelector('[role="tab"][data-tab-id="<id>"]')`, so putting an object NAME inside
       * an id puts it inside a CSS selector. MEASURED: an Oracle-shaped routine segment,
       * `"char"(integer)`, made that selector invalid and the arrow key threw a DOMException
       * that took the whole strip down. `encodeURIComponent` leaves only characters an
       * attribute selector accepts, and it is applied to each part separately so the two
       * cannot run together: an encoded kind cannot contain the separator.
       */
      const newId = `source:${encodeURIComponent(object.kind)}:${encodeURIComponent(key)}`;
      setTabs((prev) => (prev.some(matchesAddress) ? prev : [...prev, sourceTab(newId, object)]));
      setActiveTabId(newId);
    },
    [tabs],
  );

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    currentTab,
    editingTabId,
    setEditingTabId,
    editingTabName,
    setEditingTabName,
    addTab,
    closeTab,
    updateCurrentTab,
    updateTabById,
    handleTableClick,
    handleGenerateSelect,
    handleGenerateCount,
    openSourceTab,
  };
}
