"use client";

/**
 * The lazy cache behind the object tree (#789).
 *
 * Three answers are cached, each keyed by where it lands rather than by what asked for it:
 * containers by their parent's path, counts by their container's path, and a folder's objects by
 * that folder's row id. A key that is ABSENT means the read has not happened; a key holding an
 * empty array or an empty record means the engine answered and there is nothing there. Collapsing
 * those two is what makes a tree spin forever or show an empty folder that was never read, so
 * every derivation below asks whether the key exists and never whether its value is empty.
 *
 * Nothing is fetched here that a visible row did not ask for. The reads are DERIVED from the rows
 * `flattenTree` produced: a read is wanted when a row is open, its slot is empty and it carries no
 * failure. That one derivation drives the fetch, the busy state and the retry, so a row cannot be
 * busy without a read being in flight, and a read cannot be in flight without its row showing it.
 *
 * No state is written synchronously from an effect. oxlint's `react/set-state-in-effect` is an
 * error outside `src/components/ui/**` and it follows the call, so the loader writes only after
 * its await and "in flight" is derived rather than stored.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";
import { containerDepth, declaredKinds } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, KindCount, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { containerRowId, flattenTree, pathKey, type TreeRowModel } from "./flatten";

/** How a read addresses its connection: a seed by id, anything else in full. */
type ConnectionPayload = ReturnType<typeof buildConnectionPayload>;

/**
 * One read the tree wants, named rather than spelled as a route and a bag of fields.
 *
 * It is a union rather than `{ route, body }` because it is what crosses the seam below, and a
 * source implementing that seam has to dispatch on it: a record would put a cast at every
 * implementation, which is the shape `isRenderableShape` exists to keep out of the render.
 */
export type ObjectReadRequest =
  | { readonly route: "containers"; readonly parent?: readonly string[] }
  | { readonly route: "counts"; readonly container: readonly string[] }
  | { readonly route: "list"; readonly container: readonly string[]; readonly kind: string };

/**
 * Who answers this tree's reads (#789, B76).
 *
 * The standalone shell posts them to its own `/api/db/objects/*`, which is the default and what
 * `httpObjectSource` builds. The EMBEDDED shell cannot: this package ships no API routes at all
 * (`package.json`'s `exports` map carries components and types), so that path belongs to whatever
 * server the host mounted the workspace in, and the connection it is handed carries no host, port
 * or file path for a route to open anyway. So the host answers instead, through
 * `StudioWorkspaceProps.onObjectsFetch`, and every read stays LAZY: the seam is per read rather
 * than one flat catalog, which is the whole point of the tree on a schema holding tens of
 * thousands of objects.
 *
 * It takes the CONNECTION rather than closing over one, so a source is a stable value with no
 * per-connection identity: a source rebuilt per render would change the effect's dependency on
 * every pass and re-issue reads for ever.
 *
 * The answer is `unknown` on purpose. A host is ordinary JavaScript and its declared return type
 * is not a runtime guarantee, so what it hands back goes through the same `isRenderableShape`
 * check as a route's body rather than being trusted into the render.
 */
export type ObjectSource = (connection: DatabaseConnection, request: ObjectReadRequest) => Promise<unknown>;

/**
 * A read that did not answer.
 *
 * One field, and it used to carry a second: a flag for HTTP 501
 * `OBJECT_SURFACE_UNIMPLEMENTED`, which the object routes answered while the surface was
 * optional and only some engines implemented it. Every engine implements it now, the route
 * cannot produce that status, and a rendering branch for a status nothing answers is a
 * screen no user can reach.
 */
export interface TreeReadFailure {
  /** The engine's or the route's own sentence, never a rewrite of it. */
  readonly message: string;
}

/** Where one read's answer lands. `key` addresses the slot; `kind` says which map holds it. */
type ReadSlot =
  | { readonly kind: "containers"; readonly key: string }
  | { readonly kind: "counts"; readonly key: string }
  | { readonly kind: "objects"; readonly key: string };

interface TreeRead {
  readonly request: ObjectReadRequest;
  readonly slot: ReadSlot;
}

/** The root read, whose slot is never an objects slot: the tree's top holds no folder. */
type RootSlot = Extract<ReadSlot, { kind: "containers" | "counts" }>;

interface RootRead extends TreeRead {
  readonly slot: RootSlot;
}

interface TreeCache {
  readonly connectionId: string;
  /** Every container known so far, at every level, flat. `flattenTree` nests them by path. */
  readonly containers: readonly Container[];
  /** Parent path keys whose children have been listed. Needed because "no children" is an answer. */
  readonly containersRead: ReadonlySet<string>;
  readonly counts: Readonly<Record<string, Record<string, KindCount>>>;
  readonly objects: Readonly<Record<string, readonly DatabaseObject[]>>;
  readonly expanded: ReadonlySet<string>;
  /** Failures by slot key, so a retry clears exactly the read it re-issues. */
  readonly failures: Readonly<Record<string, TreeReadFailure>>;
}

export interface TreeNodes {
  readonly rows: readonly TreeRowModel[];
  /** The first read for this connection has not answered yet. */
  readonly rootLoading: boolean;
  /** The first read for this connection failed. Nothing below it can be true. */
  readonly rootFailure?: TreeReadFailure;
  /** This row's own read is in flight. */
  isBusy(row: TreeRowModel): boolean;
  /** This row's own read failed. */
  failureFor(row: TreeRowModel): TreeReadFailure | undefined;
  /** The object an object row was built from, for the fields the row model does not carry. */
  objectFor(row: TreeRowModel): DatabaseObject | undefined;
  toggle(id: string): void;
  /** Read every answer the tree is currently showing again, in place. */
  refresh(): void;
  /** Read the top of the tree again, keeping whatever the reader has opened. */
  loadContainers(): void;
}

function slotKey(slot: ReadSlot): string {
  return `${slot.kind}:${slot.key}`;
}

/** An object's identity for lookup, built from the two fields a row carries: never a joined path. */
function objectKey(path: readonly string[], kind: string): string {
  return JSON.stringify([kind, ...path]);
}

function emptyCache(connectionId: string): TreeCache {
  return {
    connectionId,
    containers: [],
    containersRead: new Set(),
    counts: {},
    objects: {},
    expanded: new Set(),
    failures: {},
  };
}

/**
 * The first read for a connection.
 *
 * An engine with no container level has nothing to list, so it reads the counts of the one
 * container it has, whose path is empty. That is the same rule `enumerateContainers` in
 * `src/lib/api/object-route.ts` applies server-side, and calling `/containers` there instead would
 * ask five engines for a method they have no reason to implement.
 */
function rootRead(depth: 0 | 1 | 2): RootRead {
  return depth === 0
    ? { request: { route: "counts", container: [] }, slot: { kind: "counts", key: "" } }
    : { request: { route: "containers" }, slot: { kind: "containers", key: "" } };
}

/**
 * The read one open row wants, or nothing.
 *
 * An object row is a LEAF in Phase 1 (standing ruling 5d): the provider surface is
 * container-scoped, so nothing can list an object's children and nothing is asked for them.
 */
function readFor(row: TreeRowModel, depth: 0 | 1 | 2): TreeRead | undefined {
  // A folder row always carries its kind id (`flatten.ts` builds it from the kind's spec); the
  // field is optional on the row model because an object row's comes from the object instead.
  // Reading it here rather than asserting it is what keeps the request's `kind` a plain string.
  if (row.kind === "folder" && row.kindId !== undefined) {
    return {
      request: { route: "list", container: row.path, kind: row.kindId },
      slot: { kind: "objects", key: row.id },
    };
  }
  if (row.kind === "container") {
    // A container above the deepest level holds containers; only the deepest one holds folders.
    return row.path.length < depth
      ? { request: { route: "containers", parent: row.path }, slot: { kind: "containers", key: pathKey(row.path) } }
      : { request: { route: "counts", container: row.path }, slot: { kind: "counts", key: pathKey(row.path) } };
  }
  return undefined;
}

function isSlotFilled(cache: TreeCache, slot: ReadSlot): boolean {
  switch (slot.kind) {
    case "containers":
      return cache.containersRead.has(slot.key);
    case "counts":
      return cache.counts[slot.key] !== undefined;
    case "objects":
      return cache.objects[slot.key] !== undefined;
  }
}

/** The children of `parentKey`, replaced wholesale, so a re-read cannot leave a dropped one behind. */
function mergeContainers(
  existing: readonly Container[],
  parentKey: string,
  listed: readonly Container[],
): readonly Container[] {
  return [...existing.filter((container) => pathKey(container.path.slice(0, -1)) !== parentKey), ...listed];
}

/**
 * The active container, OPENED, the moment the engine names it (#789).
 *
 * This is the second half of what a connection reads on first paint: the container list,
 * then the kind counts of the one container the session is already in. The fact comes
 * from the ENGINE through `Container.isSessionDefault`, so nothing here knows that Oracle
 * means the connecting user and MySQL means `DATABASE()`, and an engine that publishes no
 * such container simply opens nothing, which is a real case rather than a hypothetical
 * one: measured on SQL Server 2022, `listContainers(["libredb_objects_two"])` marks none
 * of `db_owner`, `dbo`, `guest` or `warehouse`, because the session is in a different
 * database and the flag is about the connected one (#789).
 *
 * PostgreSQL is NOT that case, and an earlier version of this comment said it was.
 * Measured in the browser on PostgreSQL 18.4: `CONTAINERS_SQL` marks
 * `n.nspname = current_schema()`, so a default `search_path` opens `public` on first
 * paint while `app` stays closed. The reading the comment was reaching for still holds
 * and is the reason nothing here branches on the type id: `current_schema()` is
 * PostgreSQL's answer to "which container is the session in", the same question Oracle
 * answers with the connecting user and MySQL with `DATABASE()`, and this consumer only
 * ever reads the flag.
 *
 * `expanded` is keyed by row id, so the id comes from `containerRowId` in `flatten.ts`
 * rather than from a second copy of that rule here.
 *
 * A container listing arriving again re-opens it, which is what a reader pressing the
 * root retry or the explicit load asks for: those are first paint happening again. A
 * container the reader has since COLLAPSED stays collapsed, because nothing re-lists its
 * parent in between.
 */
function withSessionDefault(expanded: ReadonlySet<string>, listed: readonly Container[]): ReadonlySet<string> {
  const active = listed.find((container) => container.isSessionDefault === true);
  return active === undefined ? expanded : new Set(expanded).add(containerRowId(active.path));
}

function store(cache: TreeCache, slot: ReadSlot, data: unknown): TreeCache {
  switch (slot.kind) {
    case "containers":
      return {
        ...cache,
        containers: mergeContainers(cache.containers, slot.key, data as readonly Container[]),
        containersRead: new Set(cache.containersRead).add(slot.key),
        expanded: withSessionDefault(cache.expanded, data as readonly Container[]),
      };
    case "counts":
      return { ...cache, counts: { ...cache.counts, [slot.key]: data as Record<string, KindCount> } };
    case "objects":
      return { ...cache, objects: { ...cache.objects, [slot.key]: data as readonly DatabaseObject[] } };
  }
}

function withFailure(cache: TreeCache, slot: ReadSlot, failure: TreeReadFailure): TreeCache {
  return { ...cache, failures: { ...cache.failures, [slotKey(slot)]: failure } };
}

function withoutFailure(cache: TreeCache, slot: ReadSlot): TreeCache {
  const failures = { ...cache.failures };
  delete failures[slotKey(slot)];
  return { ...cache, failures };
}

/**
 * Empty the ROOT slot as well as its failure, which is what makes the reconciler read it again.
 *
 * Only the root, and the type says so: `rootRead` answers a containers slot on an engine with
 * container levels and a counts slot on one without, and `loadContainers` is the only caller.
 * Every other re-read goes through `refresh`, which ISSUES the read rather than emptying the slot,
 * so that the rows stay on screen while it is in flight. A general `forget` had a third arm for an
 * objects slot that nothing could reach after that change.
 */
function forgetRoot(cache: TreeCache, slot: RootSlot): TreeCache {
  const emptied = withoutFailure(cache, slot);
  if (slot.kind === "containers") {
    const containersRead = new Set(emptied.containersRead);
    containersRead.delete(slot.key);
    return { ...emptied, containersRead };
  }
  const counts = { ...emptied.counts };
  delete counts[slot.key];
  return { ...emptied, counts };
}

class ObjectReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a body can be rendered, checked at the seam rather than trusted into the render.
 *
 * What is checked is exactly what the walk DEREFERENCES: a list must be a list of objects carrying
 * a `path` array, because `flatten.ts` slices and joins it, and a counts record's values must be
 * objects, because `isCountUnavailable` asks `"unavailable" in count` and a bare number throws
 * there. It is not a schema check, and it deliberately says nothing about `name` or `kind`: a
 * missing label renders as a blank row, which is ugly and not a crash.
 *
 * `Array.isArray` alone is not the check (it passes `[null]`), and the cost of trusting the cast is
 * not a degraded row: a wrong shape throws INSIDE the render, which unmounts the tree and takes
 * every panel that could have reported it with it. Measured, on the first run of this task's own
 * suite: one route answering `{}` where a list belonged broke React's root for every later test in
 * the file. So a bad body is reported through the failure path the tree already has.
 */
function isRenderableShape(read: TreeRead, data: unknown): boolean {
  if (read.slot.kind === "counts") return isRecord(data) && Object.values(data).every(isRecord);
  return Array.isArray(data) && data.every((entry) => isRecord(entry) && Array.isArray(entry.path));
}

/**
 * The request body a route takes, which is the read's own fields beside the connection.
 *
 * Written out per route rather than spread from the request, so the field names the routes parse
 * are pinned here and a rename cannot pass silently. `parent` absent and `parent: undefined` are
 * the same body once serialized, and the top-level containers read is the case that sends none.
 */
function requestBody(request: ObjectReadRequest): Record<string, unknown> {
  switch (request.route) {
    case "containers":
      return { parent: request.parent };
    case "counts":
      return { container: request.container };
    case "list":
      return { container: request.container, kind: request.kind };
  }
}

/**
 * The default source: this application's own object routes.
 *
 * `buildConnectionPayload` sends a managed seed by id and anything else in full, which is how
 * every other db route is called and the only way a connection the server has never heard of can
 * be read at all.
 */
const httpObjectSource: ObjectSource = async (connection, request) => {
  const payload: ConnectionPayload = buildConnectionPayload(connection);
  const response = await appFetch(`/api/db/objects/${request.route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...requestBody(request) }),
  });
  // A route that answered with no body at all still answered something worth showing, so the
  // status stands in for the sentence rather than the read being reported as a parse error.
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ObjectReadError(body.error ?? `The object read failed with HTTP ${response.status}`);
  }
  return body;
};

async function readThrough(source: ObjectSource, connection: DatabaseConnection, read: TreeRead): Promise<unknown> {
  const data = await source(connection, read.request);
  // Checked whoever answered: a route's body and a host callback's return are both ordinary
  // values this tree is about to dereference, and only one of them has a type declaration.
  if (!isRenderableShape(read, data)) {
    throw new ObjectReadError(`The ${read.request.route} reading answered with a body this tree cannot render`);
  }
  return data;
}

function toFailure(error: unknown): TreeReadFailure {
  if (error instanceof ObjectReadError) return { message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * The lazy object-tree cache for one connection.
 *
 * Takes the CONNECTION rather than its id, for two reasons that only look like one. The
 * request needs `buildConnectionPayload`, which is how every other db route is called and
 * the only way a connection the server has never heard of can be read at all: posting a
 * bare id restricted this tree to managed seed connections. And `deferred` is a property
 * of the connection (`skipObjectScan`), which the owner of that flag resolves.
 *
 * `deferred` suppresses EVERY read rather than just the first: a deferred tree renders no
 * rows, so there is nothing else to ask for, and "nothing is read while deferred" is then
 * one line that a mutation can be pointed at instead of a property of two derivations
 * agreeing.
 */
export function useTreeNodes(
  connection: DatabaseConnection,
  capabilities: ProviderCapabilities,
  deferred = false,
  source?: ObjectSource,
): TreeNodes {
  const connectionId = connection.id;
  const [stored, setStored] = useState<TreeCache>(() => emptyCache(connectionId));
  const connectionRef = useRef(connectionId);
  const inFlight = useRef(new Set<string>());
  // Absent means this application's own routes, which is the standalone shell. Resolved here
  // rather than defaulted in the signature so the two shells share one call path below.
  const reader = source ?? httpObjectSource;

  const kinds = useMemo(() => declaredKinds(capabilities), [capabilities]);
  const depth = useMemo(() => containerDepth(capabilities), [capabilities]);

  // The cache is thrown away by DERIVING it rather than by resetting it in an effect: a connection
  // change must not leave the previous engine's tree on screen for even one commit, and there is
  // no state to write for that.
  const fresh = useMemo(() => emptyCache(connectionId), [connectionId]);
  const cache = stored.connectionId === connectionId ? stored : fresh;

  useEffect(() => {
    connectionRef.current = connectionId;
  }, [connectionId]);

  /**
   * Apply a change on behalf of ONE connection.
   *
   * A read that settles after the reader has moved on must not land on the connection that
   * replaced it, and the connection it belongs to must still be able to fill a cache that has
   * already been thrown away. Both are decided by the id the read carried, never by what is
   * currently stored.
   */
  const applyFor = useCallback((connId: string, change: (cache: TreeCache) => TreeCache) => {
    setStored((previous) => {
      if (previous.connectionId === connId) return change(previous);
      if (connectionRef.current === connId) return change(emptyCache(connId));
      return previous;
    });
  }, []);

  const apply = useCallback(
    (change: (cache: TreeCache) => TreeCache) => applyFor(connectionId, change),
    [applyFor, connectionId],
  );

  const run = useCallback(
    // The connection is passed rather than read from the closure, so a read that settles late
    // was made against the connection that asked for it and not against whichever is current.
    async (connId: string, conn: DatabaseConnection, connReader: ObjectSource, read: TreeRead) => {
      const key = `${connId}|${slotKey(read.slot)}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const data = await readThrough(connReader, conn, read);
        // The failure goes with the answer. A re-read issued over a FAILED slot (`refresh`)
        // would otherwise leave the row reporting a refusal the engine has since withdrawn,
        // and `pending` would never re-issue it because a failure suppresses the derivation.
        applyFor(connId, (current) => store(withoutFailure(current, read.slot), read.slot, data));
      } catch (error) {
        applyFor(connId, (current) => withFailure(current, read.slot, toFailure(error)));
      } finally {
        inFlight.current.delete(key);
      }
    },
    [applyFor],
  );

  const rows = useMemo(
    () =>
      flattenTree({
        kinds,
        containers: cache.containers,
        expanded: cache.expanded,
        counts: cache.counts,
        objects: cache.objects,
        containerDepth: depth,
      }),
    [cache, depth, kinds],
  );

  const root = useMemo(() => rootRead(depth), [depth]);

  const pending = useMemo(() => {
    const reads: TreeRead[] = [];
    // The escape hatch, and the whole of it: a deferred connection wants ZERO catalog
    // reads, so the derivation that drives every fetch answers with nothing (#765).
    if (deferred) return reads;
    if (!isSlotFilled(cache, root.slot) && cache.failures[slotKey(root.slot)] === undefined) reads.push(root);
    for (const row of rows) {
      if (row.expanded !== true) continue;
      const read = readFor(row, depth);
      if (read === undefined || isSlotFilled(cache, read.slot) || cache.failures[slotKey(read.slot)] !== undefined) {
        continue;
      }
      reads.push(read);
    }
    return reads;
  }, [cache, deferred, depth, root, rows]);

  useEffect(() => {
    for (const read of pending) void run(connectionId, connection, reader, read);
  }, [connection, connectionId, reader, pending, run]);

  const pendingKeys = useMemo(() => new Set(pending.map((read) => slotKey(read.slot))), [pending]);

  const objectIndex = useMemo(() => {
    const index = new Map<string, DatabaseObject>();
    for (const list of Object.values(cache.objects)) {
      for (const object of list) index.set(objectKey(object.path, object.kind), object);
    }
    return index;
  }, [cache.objects]);

  const isBusy = useCallback(
    (row: TreeRowModel) => {
      const read = readFor(row, depth);
      return read !== undefined && pendingKeys.has(slotKey(read.slot));
    },
    [depth, pendingKeys],
  );

  const failureFor = useCallback(
    (row: TreeRowModel) => {
      const read = readFor(row, depth);
      return read === undefined ? undefined : cache.failures[slotKey(read.slot)];
    },
    [cache.failures, depth],
  );

  const objectFor = useCallback(
    (row: TreeRowModel) => objectIndex.get(objectKey(row.path, row.kindId ?? "")),
    [objectIndex],
  );

  const toggle = useCallback(
    (id: string) => {
      const opening = rows.find((row) => row.id === id);
      const read = opening === undefined ? undefined : readFor(opening, depth);
      apply((current) => {
        const expanded = new Set(current.expanded);
        const willOpen = !expanded.has(id);
        if (willOpen) expanded.add(id);
        else expanded.delete(id);
        const next = { ...current, expanded };
        // Reopening a row whose read failed asks again. The failure is the reason it looks empty,
        // so leaving it in place would make the row permanently unreadable after one timeout.
        return willOpen && read !== undefined ? withoutFailure(next, read.slot) : next;
      });
    },
    [apply, depth, rows],
  );

  /**
   * Read every answer the tree is currently showing again, in place (#789, MAJOR 1).
   *
   * WHAT IS RE-READ: the container listing, plus one read for every OPEN row, which is
   * exactly the set `pending` derives when a cache is empty. A container the reader has
   * COLLAPSED is not re-read; its cache is left alone and the next expansion shows what was
   * there before, which is the same staleness an unopened folder has always had and costs
   * nothing until the reader asks.
   *
   * WHY NOTHING IS DERIVED FROM THE STATEMENT, which is the interesting half. The caller is
   * the DDL refresh in `use-query-execution.ts`, and it holds a statement, not a container.
   * Deriving one would mean parsing a qualified object name out of arbitrary DDL, and three
   * measured facts say that answer would be wrong more often than it is useful:
   *
   * - The trigger itself is coarse. `ProviderCapabilities.schemaRefreshPattern` is
   *   `(CREATE|DROP|ALTER|TRUNCATE)\b` on the base provider and names no object at all, so
   *   `CREATE SCHEMA`, `CREATE DATABASE` and `CREATE USER` all arrive here. The first two
   *   change the CONTAINER LIST, which no per-container invalidation can express.
   * - One statement can change more than one container: `DROP SCHEMA x CASCADE`,
   *   `ALTER TABLE a.t RENAME TO b.t`, `CREATE TRIGGER ... ON other.table`.
   * - The parse is per engine. Identifier quoting is `"`, backtick or `[]` depending on the
   *   engine and case folding differs, so a derivation would have to branch on the engine to
   *   be right, and a WRONG container is the worst outcome available: it re-reads a container
   *   nobody changed and leaves the changed one stale, silently.
   *
   * WHAT IT COSTS on a large schema, which is the question that makes the blunt answer
   * defensible. The bound is the TREE's expansion state, not the size of the database: one
   * containers read, one counts read per open container, one listing per open folder. A
   * reader with three schemas open and two folders expanded pays six reads, the same six
   * first paint made. A 43,000-object catalog with everything collapsed pays one.
   *
   * The reads are ISSUED rather than the slots emptied, and that is deliberate: forgetting
   * first would leave the root slot unfilled for the length of one round trip, and
   * `rootLoading` is derived from exactly that, so every `CREATE TABLE` would replace the
   * whole sidebar with a spinner. `store` overwrites, so the stale rows stay on screen until
   * the new answer lands.
   */
  const refresh = useCallback(() => {
    // A deferred connection wants ZERO catalog reads (#765), and a DDL statement it ran does
    // not change that: the reader asked for nothing to be read and nothing is.
    if (deferred) return;
    const reads: TreeRead[] = [root];
    for (const row of rows) {
      if (row.expanded !== true) continue;
      const read = readFor(row, depth);
      if (read !== undefined) reads.push(read);
    }
    for (const read of reads) void run(connectionId, connection, reader, read);
  }, [connection, connectionId, deferred, depth, reader, root, rows, run]);

  const loadContainers = useCallback(() => apply((current) => forgetRoot(current, root.slot)), [apply, root]);

  return {
    rows,
    // A deferred tree is not loading. Nothing was asked for, so a spinner would report a
    // read that is never going to answer.
    rootLoading: !deferred && !isSlotFilled(cache, root.slot) && cache.failures[slotKey(root.slot)] === undefined,
    rootFailure: cache.failures[slotKey(root.slot)],
    isBusy,
    failureFor,
    objectFor,
    toggle,
    refresh,
    loadContainers,
  };
}
