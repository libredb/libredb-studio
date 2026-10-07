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
import { containerDepth, enumerableKinds, isCountSampled, isCountUnavailable } from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { collapseRows, filterRows, normalizeQuery, searchExpanded } from "./filter";
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
  | { readonly route: "list"; readonly container: readonly string[]; readonly kind: string }
  | { readonly route: "describe"; readonly path: readonly string[]; readonly kind: string };

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
  | { readonly kind: "objects"; readonly key: string }
  /**
   * One object's detail, keyed by its OBJECT ROW ID.
   *
   * A fourth arm rather than a reuse of `objects`, because `slotKey` prefixes with the arm name
   * and that prefix is the only thing keeping the key spaces disjoint. `pathKey(["app","orders",
   * "table"])` is both the folder id of a container `orders` under catalog `app` on a two-level
   * engine and the object id of table `orders` in schema `app` on a one-level engine; those two
   * shapes never coexist on one connection, and a separate arm is what makes that argument
   * unnecessary rather than load-bearing.
   */
  | { readonly kind: "details"; readonly key: string };

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
  /** `describeObject` answers, keyed by OBJECT row id. Absent is unread; `columns: []` is an answer. */
  readonly details: Readonly<Record<string, ObjectDetail>>;
  readonly expanded: ReadonlySet<string>;
  /** Failures by slot key, so a retry clears exactly the read it re-issues. */
  readonly failures: Readonly<Record<string, TreeReadFailure>>;
  /**
   * Slot keys the filter's read action issued, so the status line can tell a read in flight from
   * one nobody asked for. Thrown away with the cache on a connection change.
   */
  readonly searchIssued: ReadonlySet<string>;
}

/**
 * How many reads one press of the filter's read action issues.
 *
 * Every object route meters into the shared `query` bucket, 120 requests per 60 seconds
 * (`src/lib/api/rate-limit.ts`), which the SQL editor spends from too. A fifth of it per press
 * leaves the editor its room, and a schema with hundreds of unread folders is read in steps the
 * reader can see and stop.
 */
export const SEARCH_READ_BATCH = 24;

export interface TreeSearch {
  /** Matching object rows in the filtered view. */
  readonly matches: number;
  /** Reads the filter cannot see past and nobody has issued yet. */
  readonly unread: number;
  /** Reads the action issued that have not answered. */
  readonly reading: number;
  /** Reads that answered with a failure. Opening that folder retries it, as it always has. */
  readonly failed: number;
  /** Issue the next `SEARCH_READ_BATCH` unread reads. */
  readUnread(): void;
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
  /** Present exactly while a query is active. */
  readonly search?: TreeSearch;
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
    details: {},
    expanded: new Set(),
    failures: {},
    searchIssued: new Set(),
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
 * An object row wants its own detail, which is where the columns come from. That is a change to
 * standing ruling 5d and not a hole in it: the ruling was about the LISTING surface, which is
 * container-scoped and still cannot fill a kind's `childKinds`, while `describeObject` is
 * object-scoped and already implemented by every provider.
 *
 * `row.expanded !== undefined` is in the object arm and is load-bearing. Two of the five callers
 * filter on `expanded` (`pending` and `refresh`) and three do not (`isBusy`, `failureFor`,
 * `toggle`), so without the test a PostgreSQL `function` row, a SQLite `trigger` row and an
 * Oracle `package` row would each resolve a `details:<id>` slot no read can ever fill. It reads
 * the fact the walk already computed rather than recomputing it, so this function stays free of
 * the spec.
 */
function listRead(container: readonly string[], kind: string): TreeRead {
  return { request: { route: "list", container, kind }, slot: { kind: "objects", key: pathKey([...container, kind]) } };
}

function childContainersRead(parent: readonly string[]): TreeRead {
  return { request: { route: "containers", parent }, slot: { kind: "containers", key: pathKey(parent) } };
}

function readFor(row: TreeRowModel, depth: 0 | 1 | 2): TreeRead | undefined {
  // A folder row always carries its kind id (`flatten.ts` builds it from the kind's spec); the
  // field is optional on the row model because an object row's comes from the object instead.
  // Reading it here rather than asserting it is what keeps the request's `kind` a plain string.
  // A folder row's id is `pathKey([...path, kindId])`, the key `listRead` builds, so the slot has
  // one source whether a row or the filter's read action asks for it.
  if (row.kind === "folder" && row.kindId !== undefined) return listRead(row.path, row.kindId);
  // An object row always carries its kind id, and reading it rather than asserting it is what
  // keeps the request's `kind` a plain string, exactly as the folder arm above does.
  if (row.kind === "object" && row.kindId !== undefined && row.expanded !== undefined) {
    return {
      request: { route: "describe", path: row.path, kind: row.kindId },
      slot: { kind: "details", key: row.id },
    };
  }
  if (row.kind === "container") {
    // A container above the deepest level holds containers; only the deepest one holds folders.
    return row.path.length < depth
      ? childContainersRead(row.path)
      : { request: { route: "counts", container: row.path }, slot: { kind: "counts", key: pathKey(row.path) } };
  }
  // A COLUMN row, which is a leaf and asks for nothing. Stated rather than reached by falling off
  // the end, so a later arm cannot silently start answering for it.
  return undefined;
}

/**
 * The read each OPEN row asks for, once per slot, in row order.
 *
 * Takes row GROUPS because a filtered tree has two: the reader's own rows, which drive every
 * automatic read exactly as before, and the OBJECT rows of the filtered view, which can be open
 * where the reader's own folder is collapsed. The filtered view's containers and folders are
 * deliberately not a group: they are open because the filter opened them, and a read derived from
 * that would make a keystroke issue requests (U25).
 */
function openReads(groups: readonly (readonly TreeRowModel[])[], depth: 0 | 1 | 2): TreeRead[] {
  const reads = new Map<string, TreeRead>();
  for (const group of groups) {
    for (const row of group) {
      if (row.expanded !== true) continue;
      const read = readFor(row, depth);
      if (read !== undefined) reads.set(slotKey(read.slot), read);
    }
  }
  return [...reads.values()];
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Everything the filter cannot see past: an unlisted container above the leaf level, and an unread
 * folder under a known leaf container (D6).
 *
 * A folder whose count is an exact `0` holds nothing to find, and one the engine refused to count
 * cannot be listed either, so neither is counted. A bounded count is a floor, `0+` included, so it
 * is. Failed reads are counted apart and left out of `reads`, so the press does not hammer a slot
 * that just answered 429.
 */
function unreadReads(
  cache: TreeCache,
  kinds: readonly ObjectKindSpec[],
  depth: 0 | 1 | 2,
): { readonly reads: readonly TreeRead[]; readonly failed: number } {
  const reads: TreeRead[] = [];
  let failed = 0;
  const consider = (read: TreeRead) => {
    if (isSlotFilled(cache, read.slot)) return;
    if (cache.failures[slotKey(read.slot)] !== undefined) failed += 1;
    else reads.push(read);
  };
  for (const container of cache.containers) {
    if (container.path.length < depth) consider(childContainersRead(container.path));
  }
  const leaves =
    depth === 0
      ? [[]]
      : cache.containers.filter((container) => container.path.length === depth).map((container) => container.path);
  for (const path of leaves) {
    const counts = cache.counts[pathKey(path)];
    for (const spec of kinds) {
      const count = counts?.[spec.id];
      if (count !== undefined && (isCountUnavailable(count) || (!isCountSampled(count) && count.count === 0))) continue;
      consider(listRead(path, spec.id));
    }
  }
  return { reads, failed };
}

function isSlotFilled(cache: TreeCache, slot: ReadSlot): boolean {
  switch (slot.kind) {
    case "containers":
      return cache.containersRead.has(slot.key);
    case "counts":
      return cache.counts[slot.key] !== undefined;
    case "objects":
      return cache.objects[slot.key] !== undefined;
    // A relation with no columns answers `{path, columns: [], indexes: [], foreignKeys: []}`,
    // which is a PRESENT value, so absent-versus-empty needs no second set here the way
    // `containersRead` was needed: the key is the answer.
    case "details":
      return cache.details[slot.key] !== undefined;
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
    case "details":
      return { ...cache, details: { ...cache.details, [slot.key]: data as ObjectDetail } };
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

/**
 * Keeps exactly the detail slots `refresh` is re-issuing, so a collapsed object cannot go stale.
 *
 * An object whose detail is dropped is CLOSED as well. Left open, it is an open row with an empty
 * slot the moment anything shows it again, and the filter shows it on a keystroke: typing its name
 * would issue a describe, which is the one thing the filter promises never to do (U25). Closed, it
 * reads only when the reader opens it, as any closed table does.
 */
function withOnlyDetails(cache: TreeCache, keep: ReadonlySet<string>): TreeCache {
  const details: Record<string, ObjectDetail> = {};
  const expanded = new Set(cache.expanded);
  for (const [key, detail] of Object.entries(cache.details)) {
    if (keep.has(key)) details[key] = detail;
    else expanded.delete(key);
  }
  return { ...cache, details, expanded };
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
  // What the walk DEREFERENCES, and both fields are dereferenced rather than merely read.
  // `column.name` goes through `pathKey`, which calls `replaceAll` on it, so a non-string throws
  // INSIDE the walk; `column.type` has `.split("(")` called on it in the row. Neither `isPrimary`
  // nor `nullable` is checked: both are truthiness reads that are safe on anything, and this is
  // not a schema check.
  if (read.slot.kind === "details") {
    return (
      isRecord(data) &&
      Array.isArray(data.columns) &&
      data.columns.every(
        (column) => isRecord(column) && typeof column.name === "string" && typeof column.type === "string",
      )
    );
  }
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
    case "describe":
      return { path: request.path, kind: request.kind };
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
 *
 * `readsColumns` defaults to FALSE, and the default is for a caller that passes a SOURCE: the
 * standalone shell passes none and `ObjectTree` resolves that case to true, because its own
 * route always exists. A host that has not implemented `describeObject` gets no twisty rather
 * than a twisty over a read that cannot succeed (B76).
 *
 * `query` is the filter box's text. While it normalizes to non-empty, `rows` is the filtered VIEW
 * from `filter.ts`; every automatic read is still derived from the unfiltered rows, so typing reads
 * nothing.
 */
export function useTreeNodes(
  connection: DatabaseConnection,
  capabilities: ProviderCapabilities,
  deferred = false,
  source?: ObjectSource,
  readsColumns = false,
  query = "",
): TreeNodes {
  const connectionId = connection.id;
  const [stored, setStored] = useState<TreeCache>(() => emptyCache(connectionId));
  const connectionRef = useRef(connectionId);
  const inFlight = useRef(new Set<string>());
  // Absent means this application's own routes, which is the standalone shell. Resolved here
  // rather than defaulted in the signature so the two shells share one call path below.
  const reader = source ?? httpObjectSource;

  // The kinds that draw a folder. A kind only the Keys panel enumerates is declared and draws
  // none, so no key name reaches the tree (#1089 3.4).
  const kinds = useMemo(() => enumerableKinds(capabilities), [capabilities]);
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

  const treeRows = useMemo(
    () =>
      flattenTree({
        kinds,
        containers: cache.containers,
        expanded: cache.expanded,
        counts: cache.counts,
        objects: cache.objects,
        details: cache.details,
        readsColumns,
        containerDepth: depth,
      }),
    [cache, depth, kinds, readsColumns],
  );

  const needle = normalizeQuery(query);
  /**
   * What the reader collapsed WHILE filtering, which is the filter's and never the tree's (D4).
   * Keyed by connection and needle, so a new query or a new connection starts fully open without an
   * effect to reset it.
   */
  const [collapsedState, setCollapsedState] = useState<{
    readonly connectionId: string;
    readonly needle: string;
    readonly ids: ReadonlySet<string>;
  }>({ connectionId, needle: "", ids: NO_IDS });
  const collapsed =
    collapsedState.connectionId === connectionId && collapsedState.needle === needle ? collapsedState.ids : NO_IDS;

  const filtered = useMemo(() => {
    if (needle === "") return undefined;
    const searchRows = flattenTree({
      kinds,
      containers: cache.containers,
      expanded: searchExpanded(cache.expanded, cache.containers, cache.objects),
      counts: cache.counts,
      objects: cache.objects,
      details: cache.details,
      readsColumns,
      containerDepth: depth,
    });
    const { rows: matched, matches } = filterRows(searchRows, needle);
    return { rows: collapseRows(matched, collapsed), matches };
  }, [cache, collapsed, depth, kinds, needle, readsColumns]);

  const rows = filtered?.rows ?? treeRows;

  const unread = useMemo(
    () => (filtered === undefined ? undefined : unreadReads(cache, kinds, depth)),
    [cache, depth, filtered, kinds],
  );
  const readGroups = useMemo(
    () => (filtered === undefined ? [treeRows] : [treeRows, filtered.rows.filter((row) => row.kind === "object")]),
    [filtered, treeRows],
  );

  const root = useMemo(() => rootRead(depth), [depth]);

  const pending = useMemo(() => {
    const reads: TreeRead[] = [];
    // The escape hatch, and the whole of it: a deferred connection wants ZERO catalog
    // reads, so the derivation that drives every fetch answers with nothing (#765).
    if (deferred) return reads;
    if (!isSlotFilled(cache, root.slot) && cache.failures[slotKey(root.slot)] === undefined) reads.push(root);
    for (const read of openReads(readGroups, depth)) {
      if (isSlotFilled(cache, read.slot) || cache.failures[slotKey(read.slot)] !== undefined) continue;
      reads.push(read);
    }
    return reads;
  }, [cache, deferred, depth, readGroups, root]);

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
      // A CLOSED object says nothing, which is the rule `flatten.ts` already holds for the slot
      // beside this one: `unavailable` is derived from the detail and the detail is only read
      // while the row is open, so a closed object never reports "No columns reported". This slot
      // reached the render by another path. `readFor` answers for an object row whose `expanded`
      // is merely DEFINED, and `false` is defined, so a table whose describe was refused kept the
      // engine's sentence after the reader collapsed it, in the `ml-auto` space its row count
      // wants, for the life of the connection. A folder and a container are NOT gated here and
      // must not be: their read is about the row itself and is offered whether or not it is open,
      // which is how they behaved before an object row had a read at all.
      if (row.kind === "object" && row.expanded !== true) return undefined;
      const read = readFor(row, depth);
      return read === undefined ? undefined : cache.failures[slotKey(read.slot)];
    },
    [cache.failures, depth],
  );

  const objectFor = useCallback(
    // A COLUMN row is not an object. The lookup below MISSES for one today, because a column row
    // carries no kind id and its path names the column, but `ObjectKindSpec.id` is an OPEN string
    // and a miss that rests on that is not a guarantee. Without this arm a row that ever did
    // address itself like its parent would hand `TreeRow` the parent table, and every column row
    // would draw the table's status icon and its row count.
    (row: TreeRowModel) => (row.kind === "column" ? undefined : objectIndex.get(objectKey(row.path, row.kindId ?? ""))),
    [objectIndex],
  );

  const toggle = useCallback(
    (id: string) => {
      const opening = rows.find((row) => row.id === id);
      // A container or folder in the FILTERED view is open because the filter opened it, so closing
      // it is the filter's business: writing it to `expanded` would change the reader's tree behind
      // the filter and fire reads for rows they never opened (D4).
      if (filtered !== undefined && (opening?.kind === "container" || opening?.kind === "folder")) {
        setCollapsedState({
          connectionId,
          needle,
          ids: collapsed.has(id) ? new Set([...collapsed].filter((other) => other !== id)) : new Set(collapsed).add(id),
        });
        return;
      }
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
    [apply, collapsed, connectionId, depth, filtered, needle, rows],
  );

  /**
   * Read every answer the tree is currently showing again, in place (#789, MAJOR 1).
   *
   * WHAT IS RE-READ: the container listing, plus one read for every OPEN row, which is
   * exactly the set `pending` derives when a cache is empty. A container the reader has
   * COLLAPSED is not re-read; its cache is left alone and the next expansion shows what was
   * there before, which is the same staleness an unopened folder has always had and costs
   * nothing until the reader asks. A collapsed OBJECT is the one exception, and the statement
   * that drops its columns says why.
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
   * containers read, one counts read per open container, one listing per open folder, and one
   * describe per open OBJECT. A reader with three schemas open and two folders expanded pays six
   * reads, the same six first paint made. A 43,000-object catalog with everything collapsed pays
   * one. The describes are the new cost and are written down rather than argued away: a reader
   * with thirty tables expanded pays thirty-six reads per DDL statement instead of six, into the
   * 120-request-per-60-second `query` bucket `/api/db/objects/describe` shares with
   * `/api/db/query`, and a 429 renders as that row's own failure sentence.
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
    const reads: TreeRead[] = [root, ...openReads(readGroups, depth)];
    // Every detail this call is NOT re-reading is dropped. The rest of this function ISSUES over
    // a filled slot so the stale rows stay on screen while the new answer is in flight, and that
    // is right for a container, a count and a listing, whose rows are visible. A COLLAPSED
    // object's columns are not on screen at all, so there is nothing to keep, and keeping them
    // means a `CREATE TABLE`/`ALTER TABLE` leaves a wrong column list behind a twisty with
    // nothing able to evict it.
    const reread = new Set(reads.flatMap((read) => (read.slot.kind === "details" ? [read.slot.key] : [])));
    apply((current) => withOnlyDetails(current, reread));
    for (const read of reads) void run(connectionId, connection, reader, read);
  }, [apply, connection, connectionId, deferred, depth, readGroups, reader, root, run]);

  const loadContainers = useCallback(() => apply((current) => forgetRoot(current, root.slot)), [apply, root]);

  const readUnread = useCallback(() => {
    if (unread === undefined) return;
    const batch = unread.reads
      .filter((read) => !cache.searchIssued.has(slotKey(read.slot)))
      .slice(0, SEARCH_READ_BATCH);
    apply((current) => ({
      ...current,
      searchIssued: new Set([...current.searchIssued, ...batch.map((read) => slotKey(read.slot))]),
    }));
    for (const read of batch) void run(connectionId, connection, reader, read);
  }, [apply, cache.searchIssued, connection, connectionId, reader, run, unread]);

  const search = useMemo((): TreeSearch | undefined => {
    if (filtered === undefined || unread === undefined) return undefined;
    const reading = unread.reads.filter((read) => cache.searchIssued.has(slotKey(read.slot))).length;
    return {
      matches: filtered.matches,
      unread: unread.reads.length - reading,
      reading,
      failed: unread.failed,
      readUnread,
    };
  }, [cache.searchIssued, filtered, readUnread, unread]);

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
    search,
  };
}
