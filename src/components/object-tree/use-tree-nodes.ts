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
import { ApiErrorCode } from "@/lib/api/error-codes";
import { appFetch } from "@/lib/config/base-path";
import { containerDepth, declaredKinds } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, KindCount, ProviderCapabilities } from "@/lib/db/types";
import { flattenTree, type TreeRowModel } from "./flatten";

/** A read that did not answer. */
export interface TreeReadFailure {
  /** The engine's or the route's own sentence, never a rewrite of it. */
  readonly message: string;
  /**
   * The provider has not been migrated to the object surface yet: HTTP 501 with
   * `OBJECT_SURFACE_UNIMPLEMENTED`. Sixteen of seventeen engines answer that today, so it is the
   * common path rather than an edge, and it has to read as a gap in the provider rather than as an
   * engine holding nothing.
   */
  readonly unimplemented: boolean;
}

/** Where one read's answer lands. `key` addresses the slot; `kind` says which map holds it. */
type ReadSlot =
  | { readonly kind: "containers"; readonly key: string }
  | { readonly kind: "counts"; readonly key: string }
  | { readonly kind: "objects"; readonly key: string; readonly containerKey: string };

interface TreeRead {
  readonly route: "containers" | "counts" | "list";
  /** The request body, without the connection, which the poster adds. */
  readonly body: Record<string, unknown>;
  readonly slot: ReadSlot;
}

interface TreeCache {
  readonly connectionId: string;
  /** Every container known so far, at every level, flat. `flattenTree` nests them by path. */
  readonly containers: readonly Container[];
  /** Parent path keys whose children have been listed. Needed because "no children" is an answer. */
  readonly containersRead: ReadonlySet<string>;
  readonly counts: Readonly<Record<string, Record<string, KindCount>>>;
  readonly objects: Readonly<Record<string, readonly DatabaseObject[]>>;
  /**
   * The container each loaded folder belongs to, recorded from the row that asked for it.
   *
   * `invalidateContainer` needs to find a container's folders, and this is what saves it from
   * rebuilding a folder's row id from the path and the kind. That id rule lives in `flatten.ts`;
   * a second copy of it here is how the two would drift.
   */
  readonly folderContainer: Readonly<Record<string, string>>;
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
  /** Drop one container's counts and the loaded objects of its folders, and read them again. */
  invalidateContainer(path: readonly string[]): void;
  /** Read the top of the tree again, keeping whatever the reader has opened. */
  loadContainers(): void;
}

/** The counts key `flattenTree` documents: the container path joined with `/`, so the root is "". */
function pathKey(path: readonly string[]): string {
  return path.join("/");
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
    folderContainer: {},
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
function rootRead(depth: 0 | 1 | 2): TreeRead {
  return depth === 0
    ? { route: "counts", body: { container: [] }, slot: { kind: "counts", key: "" } }
    : { route: "containers", body: {}, slot: { kind: "containers", key: "" } };
}

/**
 * The read one open row wants, or nothing.
 *
 * An object row is a LEAF in Phase 1 (standing ruling 5d): the provider surface is
 * container-scoped, so nothing can list an object's children and nothing is asked for them.
 */
function readFor(row: TreeRowModel, depth: 0 | 1 | 2): TreeRead | undefined {
  if (row.kind === "folder") {
    return {
      route: "list",
      body: { container: row.path, kind: row.kindId },
      slot: { kind: "objects", key: row.id, containerKey: pathKey(row.path) },
    };
  }
  if (row.kind === "container") {
    // A container above the deepest level holds containers; only the deepest one holds folders.
    return row.path.length < depth
      ? { route: "containers", body: { parent: row.path }, slot: { kind: "containers", key: pathKey(row.path) } }
      : { route: "counts", body: { container: row.path }, slot: { kind: "counts", key: pathKey(row.path) } };
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

function store(cache: TreeCache, slot: ReadSlot, data: unknown): TreeCache {
  switch (slot.kind) {
    case "containers":
      return {
        ...cache,
        containers: mergeContainers(cache.containers, slot.key, data as readonly Container[]),
        containersRead: new Set(cache.containersRead).add(slot.key),
      };
    case "counts":
      return { ...cache, counts: { ...cache.counts, [slot.key]: data as Record<string, KindCount> } };
    case "objects":
      return {
        ...cache,
        objects: { ...cache.objects, [slot.key]: data as readonly DatabaseObject[] },
        folderContainer: { ...cache.folderContainer, [slot.key]: slot.containerKey },
      };
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

/** Empty the slot as well as its failure, which is what makes the reconciler read it again. */
function forget(cache: TreeCache, slot: ReadSlot): TreeCache {
  const emptied = withoutFailure(cache, slot);
  switch (slot.kind) {
    case "containers": {
      const containersRead = new Set(emptied.containersRead);
      containersRead.delete(slot.key);
      return { ...emptied, containersRead };
    }
    case "counts": {
      const counts = { ...emptied.counts };
      delete counts[slot.key];
      return { ...emptied, counts };
    }
    case "objects": {
      const objects = { ...emptied.objects };
      const folderContainer = { ...emptied.folderContainer };
      delete objects[slot.key];
      delete folderContainer[slot.key];
      return { ...emptied, objects, folderContainer };
    }
  }
}

class ObjectReadError extends Error {
  constructor(
    message: string,
    readonly unimplemented: boolean,
  ) {
    super(message);
    this.name = "ObjectReadError";
  }
}

async function postRead(connectionId: string, read: TreeRead): Promise<unknown> {
  const response = await appFetch(`/api/db/objects/${read.route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, ...read.body }),
  });
  // A route that answered with no body at all still answered something worth showing, so the
  // status stands in for the sentence rather than the read being reported as a parse error.
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new ObjectReadError(
      body.error ?? `The object read failed with HTTP ${response.status}`,
      body.code === ApiErrorCode.OBJECT_SURFACE_UNIMPLEMENTED,
    );
  }
  return body;
}

function toFailure(error: unknown): TreeReadFailure {
  if (error instanceof ObjectReadError) return { message: error.message, unimplemented: error.unimplemented };
  return { message: error instanceof Error ? error.message : String(error), unimplemented: false };
}

export function useTreeNodes(connectionId: string, capabilities: ProviderCapabilities): TreeNodes {
  const [stored, setStored] = useState<TreeCache>(() => emptyCache(connectionId));
  const connectionRef = useRef(connectionId);
  const inFlight = useRef(new Set<string>());

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
    async (connId: string, read: TreeRead) => {
      const key = `${connId}|${slotKey(read.slot)}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const data = await postRead(connId, read);
        applyFor(connId, (current) => store(current, read.slot, data));
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
  }, [cache, depth, root, rows]);

  useEffect(() => {
    for (const read of pending) void run(connectionId, read);
  }, [connectionId, pending, run]);

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

  const invalidateContainer = useCallback(
    (path: readonly string[]) => {
      const containerKey = pathKey(path);
      apply((current) => {
        let next = forget(current, { kind: "counts", key: containerKey });
        for (const [folderId, owner] of Object.entries(current.folderContainer)) {
          if (owner !== containerKey) continue;
          next = forget(next, { kind: "objects", key: folderId, containerKey });
        }
        return next;
      });
    },
    [apply],
  );

  const loadContainers = useCallback(() => apply((current) => forget(current, root.slot)), [apply, root]);

  return {
    rows,
    rootLoading: !isSlotFilled(cache, root.slot) && cache.failures[slotKey(root.slot)] === undefined,
    rootFailure: cache.failures[slotKey(root.slot)],
    isBusy,
    failureFor,
    objectFor,
    toggle,
    invalidateContainer,
    loadContainers,
  };
}
