"use client";

import { appFetch, SESSION_REQUIRED_CODE } from "@/lib/config/base-path";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { detailedObjects, schemaContextOf, type DetailedObject } from "@/lib/db/detailed-object";
import { containerDepth, declaresCatalogSessions, relationKindIds } from "@/lib/db/object-kinds";
import { sessionDefaultContainer } from "@/lib/db/container-walk";
import type { Container, DatabaseObject, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";
import { useReadGeneration } from "@/hooks/use-read-generation";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { logger } from "@/lib/logger";
import {
  connectionAllowed,
  connectionsUnderPolicy,
  CUSTOM_CONNECTIONS_ALLOWED,
  readConnectionPolicy,
  type ConnectionPolicy,
} from "@/lib/connection-policy";
import {
  NO_SERVED_SEEDS,
  SEED_CONFIG_UNREADABLE_REASON,
  type ManagedConnectionPayload,
  type ServedSeeds,
} from "./use-connection-payload";

/** Pending-seed poll: 1s ticks, give up after 30. NEXT_PUBLIC_MANAGED_POLL_MS
 * shortens the tick in source builds and tests only — NEXT_PUBLIC_ values are
 * inlined at build time, so packaged artifacts always use the default. */
const MANAGED_POLL_MAX_ATTEMPTS = 30;

/** One array, so a render that lists no database hands out the same one. */
const NO_CATALOGS: readonly string[] = [];

/**
 * Managed-list refresh after the first load (#1502): the interval
 * never runs more often than the floor and never less often than the cap, while focus and visibility
 * refresh at once, bounded only by the refresh's in-flight guard. NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS
 * moves the floor in source builds and tests only, because NEXT_PUBLIC_ values are inlined at
 * build time, exactly like the poll tick above.
 */
export const MANAGED_REFRESH_DEFAULT_FLOOR_MS = 5000;
export const MANAGED_REFRESH_MAX_MS = 60000;

/** Milliseconds between two refreshes: max(cacheHint, floor), capped at MANAGED_REFRESH_MAX_MS. */
export function managedRefreshIntervalMs(cacheHint: number | null): number {
  const floor = Number(process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS) || MANAGED_REFRESH_DEFAULT_FLOOR_MS;
  return Math.min(Math.max(cacheHint ?? 0, floor), MANAGED_REFRESH_MAX_MS);
}

/**
 * The query parameter a link uses to open the editor on one connection, by the connection's full id
 * in this browser: `seed:<id>` for a seed, as `GET /api/connections/managed` lists it.
 */
const CONNECTION_LINK_PARAM = "connection";

/**
 * The connection id the address asks the editor to open, or null when it names none. The parameter
 * leaves the address bar as it is read, whether or not it names a connection this reader can open:
 * it is an instruction for this load, and kept there a reload would follow it again and a copied
 * address would pass it on.
 *
 * Read from `window.location`, not through `useSearchParams` or the page's `searchParams` prop. The
 * editor's page is prerendered: a client component that calls `useSearchParams` there fails
 * `next build` without a Suspense boundary above it, which would put a fallback in place of the
 * prerendered editor, and the `searchParams` prop would render the page per request instead. The
 * link is wanted once, after the list has loaded, and only the effect that loads the list knows
 * that moment.
 *
 * Removed with `history.replaceState` and a null state. Next's router patches `replaceState` so it
 * follows a change made this way, but it passes through untouched any call whose state already
 * carries its own `__NA` marker. `window.history.state` carries it, so handing that back would leave
 * the router holding the old address, which it writes back into the address bar on its next update.
 */
function takeLinkedConnectionId(): string | null {
  const url = new URL(window.location.href);
  const linked = url.searchParams.get(CONNECTION_LINK_PARAM);
  if (linked === null) return null;
  url.searchParams.delete(CONNECTION_LINK_PARAM);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return linked;
}

/**
 * The containers a connect-time schema read should scan, scoped to the session default on a
 * two-level engine so a multi-catalog cluster is not walked whole on every connect (#1402).
 *
 * Left unscoped (`undefined`), `/api/db/objects/inventory` enumerates every container itself: on a
 * depth-2 engine (catalog → schema) that is one `listContainers()` call per catalog, which on a
 * Trino cluster with Hive or Iceberg catalogs is a full metastore walk on every page load. The top
 * level alone marks which catalog is the session default (every provider sets `isSessionDefault`
 * there, #789), so one cheap top-level listing decides whether a second, narrower listing is worth
 * making at all - the other catalogs are left for the tree to read lazily, same as it always has.
 *
 * A single-level engine (`depth` 0 or 1) has nothing to scope: `enumerateContainers` there is
 * already one listing, so this returns `undefined` and leaves the route to make it as before. It
 * also falls back to `undefined` - the unscoped read - when no catalog is pinned or the pinned one
 * has no schemas of its own, rather than inventing a "scan nothing" request the route rejects.
 */
interface ScopedContainers {
  readonly containers: readonly (readonly string[])[];
  /**
   * The deepest-level default among the scoped containers, read with `sessionDefaultContainer`
   * (`container-walk.ts`) so a provider defect that flags more than one container declines here
   * exactly as it would in the unscoped route, instead of this picking the first one.
   */
  readonly defaultContainer?: readonly string[];
}

async function scopedContainers(payload: object, depth: 0 | 1 | 2): Promise<ScopedContainers | undefined> {
  if (depth !== 2) return undefined;

  const post = (body: unknown): [string, RequestInit] => [
    "/api/db/objects/containers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  ];

  const topRes = await appFetch(...post(payload));
  if (!topRes.ok) return undefined;
  const top = (await topRes.json()) as Container[];
  const defaultTopPath = sessionDefaultContainer(top);
  if (defaultTopPath === undefined) return undefined;

  const childRes = await appFetch(...post({ ...payload, parent: defaultTopPath }));
  if (!childRes.ok) return undefined;
  const children = (await childRes.json()) as Container[];
  if (children.length === 0) return undefined;

  const defaultContainer = sessionDefaultContainer(children);
  return {
    containers: children.map((container) => container.path),
    ...(defaultContainer === undefined ? {} : { defaultContainer }),
  };
}

export function useConnectionManager(storageReady = false) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  /**
   * The active connection as last committed, for the managed refresh: the refresh runs inside
   * the storage effect, whose closure never sees a later render, and it has to know which
   * connection is open to keep it open or to say that it is gone. It holds `visibleActive`, the
   * connection the user sees, so a connection the custom connections policy hides never counts as
   * the open one.
   */
  const activeConnectionRef = useRef<DatabaseConnection | null>(null);
  /**
   * The id of a `?connection=` link the first load could not open, which a later managed refresh
   * opens or decides (settlePendingLink in the storage effect). A ref rather than a variable of
   * that effect because the reader's own selection, made through the setter this hook returns,
   * cancels it.
   */
  const pendingLinkIdRef = useRef<string | null>(null);
  /**
   * The connection the person has used in this page, by id: picked it, loaded its objects, or sent it a statement.
   *
   * A connection the page made active by itself (the one open last time at sign-in or on a reload, a linked one, a
   * fallback) has not been used, and while it has not, a connection whose provider declares `resumesBilledCompute`
   * reads nothing past its declaration (CL-CORE-2): measured on Databend Cloud, a sign-in with no click read the
   * inventory twice, and each read resumes a suspended warehouse, which is billed while it runs. The ref is what a read
   * already in flight asks, so a pick made while it waits for the declaration is honoured by it.
   */
  const [usedId, setUsedId] = useState<string | null>(null);
  const usedIdRef = useRef<string | null>(null);
  /** The connection whose catalog read stopped at its declaration for the reason above, to be read once it is used. */
  const heldIdRef = useRef<string | null>(null);
  const markUsed = useCallback((id: string | null) => {
    usedIdRef.current = id;
    setUsedId(id);
  }, []);
  /**
   * The server's own seed descriptors, kept alongside the merged list rather than
   * folded into it. The merge deliberately prefers an existing editable copy over the
   * server's version, so afterwards there is no way to tell a copy that still matches
   * its seed from one the user has since pointed elsewhere — and that is exactly the
   * question a run has to answer before it may persist a bare `seed:<id>`.
   */
  const [servedSeeds, setServedSeeds] = useState<ServedSeeds>(NO_SERVED_SEEDS);
  /**
   * What the server lets this user do with connections of their own (`ALLOW_CUSTOM_CONNECTIONS`),
   * read once from `GET /api/connections/policy` before any connection is made active.
   *
   * The list and the active connection this hook RETURNS are derived from it rather than filtered
   * into state. The shell rebuilds `connections` from storage after a save or a delete
   * (`src/components/Studio.tsx`), and a list filtered once on load would take a refused
   * connection back in on the next rebuild; a derived one cannot. The refused connections stay in
   * the user's storage, so they come back if the operator switches custom connections on again.
   */
  const [policy, setPolicy] = useState<ConnectionPolicy>(CUSTOM_CONNECTIONS_ALLOWED);
  const visibleConnections = useMemo(() => connectionsUnderPolicy(connections, policy), [connections, policy]);
  /** Null rather than a connection the server refuses, whichever path made it active. */
  const visibleActive =
    activeConnection !== null && connectionAllowed(activeConnection, policy) ? activeConnection : null;
  const [schema, setSchema] = useState<readonly DetailedObject[]>([]);
  /**
   * The container the session resolves a bare name in, as the inventory reported it, so the
   * editor can tell which tables complete to a qualified name (#1397). Written with `schema`
   * and cleared with it, so it never describes another connection's catalog.
   */
  const [defaultContainer, setDefaultContainer] = useState<readonly string[] | undefined>(undefined);
  /**
   * Why the object browser is empty, in the engine's own words, or null when it is
   * empty because the database really has nothing in it.
   *
   * Kept because a failed read used to leave the PREVIOUS connection's tables on
   * screen under the new connection's name, row counts and all (D31, measured in
   * Chrome across two connections). Clearing the tree alone would fix the lie and
   * leave a second one: an empty explorer reads as "no tables here", which is not
   * what happened.
   */
  const [schemaError, setSchemaError] = useState<string | null>(null);
  /** A server-level connection's databases and the active one everything reads (#1530). */
  const [catalogState, setCatalogState] = useState<{
    readonly connectionId: string;
    readonly catalogs: readonly string[];
    readonly active?: string;
  } | null>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  /**
   * The connection whose deferred catalog read the reader has explicitly asked for, by
   * id. Null means nobody has asked for any, which is where a session starts.
   */
  const [scanRequested, setScanRequested] = useState<string | null>(null);

  const { toast } = useToast();

  /**
   * Which catalog read is the CURRENT one (#789 review, Minor 8).
   *
   * Stated once in `useReadGeneration` and used by both shells: the embedded adapter had the
   * same race and shipped without the guard, because the rule lived inside this hook rather
   * than beside both of its readers. What it costs, and why a counter rather than an abort
   * signal, is written there.
   */
  const reads = useReadGeneration();

  /*
    One read of the object surface, and it is the only catalog reading this hook does (#789).

    It was three requests until the flat schema reading was deleted: `/api/db/schema/list` for
    names and columns, `/api/db/objects/inventory` for the kind and the address, and
    `/api/db/schema/relations` for foreign keys and indexes, with a join on the display NAME
    holding the first two together. That join is gone with the reading it existed for, and so is
    every defect it carried: a name containing a dot lost its columns, a bare `orders` answered to
    every `orders` on the server, and an object the flat read never named could not be tagged at
    all.

    `/api/db/provider-meta` still comes first, and it is the cheapest read in the app: it
    constructs the provider and reads its capabilities WITHOUT opening a connection, so the extra
    request costs no socket, no pool client and no catalog statement. Its answer decides which
    kinds are asked for.

    ONLY THE RELATION KINDS ARE ASKED FOR. Measured against dvdrental on PostgreSQL 18 while the
    join still existed: 7 listings returning 59 objects for every kind against 3 listings
    returning 22 for the relation kinds, per container, on every connection select and every
    DDL-triggered refresh (`use-query-execution.ts`). The consumers of this list draw rows,
    columns and foreign keys, which is what `role: "relation"` declares; a routine or a trigger in
    it would be a row the diagram and the import target cannot use. The kinds come from the
    provider`s own declaration and never from a list written here.

    Unguarded on purpose: `fetchSchema` below is the guarded entry point every caller uses, and
    `loadObjects` is the one call that is allowed past the guard.
  */
  const readSchema = useCallback(
    async (conn: DatabaseConnection, chosenCatalog?: string) => {
      /** Whether this read is still the one on screen. Every write below asks first. */
      const isCurrent = reads.begin();
      heldIdRef.current = null;
      setIsLoadingSchema(true);

      const payload = conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : { connection: conn };
      const init = (path: string, body: unknown = payload): [string, RequestInit] => [
        path,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ];

      try {
        const metaRes = await appFetch(...init("/api/db/provider-meta"));
        if (!metaRes.ok) {
          const body = await metaRes.json().catch(() => ({}));
          throw new Error(body.error || `The provider metadata could not be read (${metaRes.status})`);
        }
        const { capabilities } = (await metaRes.json()) as { capabilities: ProviderCapabilities };
        // The declaration opens no connection; the inventory does, and on a connection whose every request can resume
        // compute billed while it runs, it is read only once the person uses the connection (`usedIdRef` above).
        if (capabilities.resumesBilledCompute === true && usedIdRef.current !== conn.id) {
          if (isCurrent()) {
            heldIdRef.current = conn.id;
            // Nothing was read for THIS connection, so the previous one's objects may not stay as its own (D31).
            setSchema([]);
            setDefaultContainer(undefined);
            setSchemaError(null);
          }
          return;
        }

        // A server-level connection reads one database (#1530): the chosen one, else the remembered
        // one while the server still lists it, else the first.
        let scope: { parent?: readonly string[] } = {};
        if (declaresCatalogSessions(capabilities)) {
          const containersRes = await appFetch(...init("/api/db/objects/containers"));
          if (!containersRes.ok) {
            const body = await containersRes.json().catch(() => ({}));
            throw new Error(body.error || "Failed to list the server's databases");
          }
          const listed = ((await containersRes.json()) as Container[]).map((container) => container.name);
          const wanted = chosenCatalog ?? storage.getActiveCatalog(conn.id) ?? undefined;
          const chosen = wanted !== undefined && listed.includes(wanted) ? wanted : listed[0];
          if (!isCurrent()) return;
          setCatalogState({
            connectionId: conn.id,
            catalogs: listed,
            ...(chosen === undefined ? {} : { active: chosen }),
          });
          if (chosen === undefined) {
            setSchema([]);
            setDefaultContainer(undefined);
            setSchemaError(null);
            return;
          }
          storage.setActiveCatalog(conn.id, chosen);
          scope = { parent: [chosen] };
        } else if (isCurrent()) {
          setCatalogState(null);
        }

        const kinds = relationKindIds(capabilities);
        // A true statement about the engine rather than a failure: nothing declared a kind whose
        // rows this list renders, so there is nothing to ask for and nothing to show. It is not
        // reported as an error, because no reading failed.
        if (kinds.length === 0) {
          if (isCurrent()) {
            setSchema([]);
            setDefaultContainer(undefined);
            setSchemaError(null);
          }
          return;
        }

        // A chosen database is already the scope; the session-default lookup is for the other engines.
        const scoped =
          scope.parent === undefined ? await scopedContainers(payload, containerDepth(capabilities)) : undefined;
        const objectsRes = await appFetch(
          ...init("/api/db/objects/inventory", {
            ...payload,
            ...scope,
            kinds,
            includeColumns: true,
            ...(scoped === undefined ? {} : { containers: scoped.containers }),
          }),
        );
        if (!objectsRes.ok) {
          const body = await objectsRes.json().catch(() => ({}));
          throw new Error(body.error || "Failed to read the database objects");
        }
        // Scoping this read bypasses the route's own enumeration, so its `defaultContainer` -
        // computed only on the walk we skipped - is never on this response; the one `scoped`
        // read off the same containers call stands in for it.
        const {
          objects,
          details,
          truncated,
          defaultContainer: routeDefaultContainer,
        } = (await objectsRes.json()) as {
          objects?: DatabaseObject[];
          details?: ObjectDetail[];
          truncated?: { limit: number; reason: string };
          defaultContainer?: readonly string[];
        };
        if (!Array.isArray(objects)) throw new Error("The object inventory answered a body this list cannot render");
        if (!isCurrent()) return;
        // A saturated inventory leaves its tail out of the list entirely, and an object nobody
        // was shown reads as an object the database does not hold. Stating it in the log is the
        // weaker half of the answer: a surface a READER can see is still owed and is tracked on
        // issue #789, which is what this cites now. The path it used to cite is git-ignored, so
        // the citation reached every clone and the published package pointing at nothing.
        if (truncated !== undefined) {
          logger.warn("Object inventory truncated; objects beyond the limit are not listed", {
            route: "use-connection-manager",
            limit: truncated.limit,
            reason: truncated.reason,
          });
        }
        setSchema(detailedObjects(objects, details ?? []));
        setDefaultContainer(scoped?.defaultContainer ?? routeDefaultContainer);
        setSchemaError(null);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        // A read the reader has moved on from reports nothing at all, toast included: the
        // failure belongs to a connection that is no longer on screen, and clearing the
        // list or naming an error here would blame the CURRENT connection for a read that
        // was never issued against it.
        if (!isCurrent()) return;
        // Nothing read for THIS connection, so nothing may stay on screen as its
        // objects - the previous connection's list is not evidence about this one.
        setSchema([]);
        setDefaultContainer(undefined);
        setSchemaError(errorMessage);
        toast({ title: "Schema Error", description: errorMessage, variant: "destructive" });
      } finally {
        // Only the current read owns the flag; a superseded one clearing it would report
        // the newer read as finished while it is still in flight.
        if (isCurrent()) setIsLoadingSchema(false);
      }
    },
    [reads, toast],
  );

  /**
   * Whether THIS connection's catalog reads are deferred right now (#765).
   *
   * One rule with one reader, deliberately: the two shells and the statement-refresh
   * path all reach the catalog through `fetchSchema`, and a guard written at each call
   * site is three copies of a rule that only has to be wrong in one of them to make the
   * escape hatch read the catalog anyway.
   *
   * The reader's request is held as the connection's ID rather than as a boolean, and
   * the answer is DERIVED from it. A boolean would leave the NEXT deferred connection
   * already loaded, and clearing it in an effect is both a frame late and an error under
   * `react/set-state-in-effect`.
   */
  const scanDeferred = useCallback(
    (conn: DatabaseConnection) => conn.skipObjectScan === true && scanRequested !== conn.id,
    [scanRequested],
  );

  const fetchSchema = useCallback(
    async (conn: DatabaseConnection) => {
      if (scanDeferred(conn)) {
        // This supersedes any read in flight, exactly as a read does (Minor 8): the reader
        // has moved to a connection that reads NOTHING, so an answer still on its way for the
        // previous one must not land under this connection's name.
        reads.supersede();
        // Nothing was read for THIS connection, so nothing may stay on screen or in the AI
        // prompt as its objects. `readSchema` is the only writer of these two, so returning
        // without clearing them leaves the PREVIOUS connection's tables under this
        // connection's name - D31 again (see `readSchema`'s own catch), and the grounding
        // failure #414 measured, since `schemaContext` is what the AI panels and the agent
        // rail are handed.
        setSchema([]);
        setDefaultContainer(undefined);
        setSchemaError(null);
        // The superseded read will not clear this: its own `finally` asks whether it is still
        // current and it is not. Nothing is being read here, so a spinner would report a read
        // that is never going to answer.
        setIsLoadingSchema(false);
        return;
      }
      await readSchema(conn);
    },
    [readSchema, reads, scanDeferred],
  );

  /**
   * Read what opening this connection would have read, because the reader asked.
   *
   * It records the request against the connection's id before reading, so the tree's own
   * root read is released by the same press: the panel that offers this action is
   * rendered from `objectScanDeferred`.
   */
  const loadObjects = useCallback(() => {
    const conn = visibleActive;
    if (conn === null) return;
    markUsed(conn.id);
    setScanRequested(conn.id);
    void readSchema(conn);
  }, [visibleActive, readSchema, markUsed]);

  /**
   * The setter the shell picks connections with. A selection of the reader's own cancels a pending
   * link, so a refresh that lists the linked connection later does not switch away from the
   * reader's choice and discard its editor state. The hook's own selections use the raw setter.
   *
   * A pick is a use of the connection. Picking the one already active changes nothing the shell's
   * connection effect reads, so the read a restore held for it is taken here.
   */
  const selectConnection = useCallback(
    (next: DatabaseConnection | null) => {
      pendingLinkIdRef.current = null;
      markUsed(next?.id ?? null);
      setActiveConnection(next);
      if (next !== null && next === activeConnectionRef.current && heldIdRef.current === next.id) {
        void fetchSchema(next);
      }
    },
    [fetchSchema, markUsed],
  );

  /**
   * The setter the shell makes a connection active with when the person deleted the active one: the
   * first one left is the page's choice, not the person's, so it is not marked used, and a connection
   * whose requests resume billed compute is held as a restored one is (CL-CORE-2). The delete is the
   * person's own act, though, so it cancels a pending link as a pick does.
   */
  const activateFallback = useCallback((next: DatabaseConnection | null) => {
    pendingLinkIdRef.current = null;
    setActiveConnection(next);
  }, []);

  /**
   * The person sent the active connection a statement, which uses it as a pick does: the read a
   * restore held for it is taken now, while the statement already wakes its compute.
   */
  const markActiveUsed = useCallback(() => {
    const conn = visibleActive;
    if (conn === null || usedIdRef.current === conn.id) return;
    markUsed(conn.id);
    if (heldIdRef.current === conn.id) void fetchSchema(conn);
  }, [visibleActive, markUsed, fetchSchema]);

  /** Makes `catalog` the active database (#1530), remembered for this connection, and reads it. */
  const setActiveCatalog = useCallback(
    (catalog: string) => {
      const conn = visibleActive;
      if (conn === null) return;
      storage.setActiveCatalog(conn.id, catalog);
      void readSchema(conn, catalog);
    },
    [visibleActive, readSchema],
  );

  /**
   * The schema as the AI panels and the agent rail are handed it.
   *
   * MEASURED after the object surface was joined in, because the review asked what the two
   * new fields cost the prompt (#789). Against the live PostgreSQL 18 `dvdrental` database,
   * 15 objects with their columns, indexes and foreign keys: 13,179 bytes before, 13,825
   * after. That is 646 bytes, +4.9 percent, roughly 160 tokens, and it is a per-OBJECT
   * constant of about 43 bytes rather than anything that scales with columns, so a 500-object
   * schema pays about 21 KB on a serialisation already over 400 KB. Both fields stay: `path`
   * is the only thing in here that ADDRESSES an object, which is what a model otherwise
   * guesses at when it qualifies a name (#414), and `kind` is what stops it drafting an
   * INSERT against a view or a routine. A prompt that is 5 percent larger and says what its
   * objects are is the better trade, and the number is recorded so the next reader does not
   * have to measure it again.
   *
   * `schemaContextOf` rather than a bare `JSON.stringify`, for the one field a prompt may not
   * carry: a group's `readRanges`, which can name a key (etcd spec E13). Every other byte is
   * the same.
   */
  const schemaContext = useMemo(() => schemaContextOf(schema), [schema]);

  // Initialize connections once storage sync is ready
  useEffect(() => {
    if (!storageReady) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    // The policy this mount read, for the seed poll and the managed refresh as well as the first selection.
    let currentPolicy: ConnectionPolicy = CUSTOM_CONNECTIONS_ALLOWED;
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Merge the server's managed (seed) connections with the user's own,
    // persisting editable copies of new seeds. Used by the initial fetch AND
    // the pending-seed poll below, so both produce identical lists.
    const mergeManagedConnections = (managedConns: ManagedConnectionPayload[]): DatabaseConnection[] => {
      const userConns = storage.getConnections();
      const dismissed = new Set(storage.getDismissedSeeds());
      const merged: DatabaseConnection[] = [];

      // Add managed:true connections (always from server)
      for (const mc of managedConns) {
        if (mc.managed) {
          merged.push({ ...mc, createdAt: new Date(mc.createdAt) });
        } else {
          // managed:false — editable user copy
          if (mc.seedId && dismissed.has(mc.seedId)) continue; // user deleted it; do not re-add
          const existingCopy = userConns.find((uc: DatabaseConnection) => uc.seedId === mc.seedId);
          if (existingCopy) {
            merged.push(existingCopy);
          } else {
            const userCopy: DatabaseConnection = { ...mc, createdAt: new Date(mc.createdAt), managed: false };
            storage.saveConnection(userCopy);
            merged.push(userCopy);
          }
        }
      }

      // Add remaining user connections (not from seeds)
      const seedIds = new Set(managedConns.map((mc) => mc.seedId));
      const mergedIds = new Set(merged.map((c) => c.id));
      for (const uc of userConns) {
        // Skip if this user connection came from a seed (by seedId or id match)
        if (uc.seedId && seedIds.has(uc.seedId)) continue;
        if (mergedIds.has(uc.id)) continue;
        merged.push(uc);
      }

      return merged;
    };

    const fetchManaged = async ({
      quiet = false,
    }: {
      quiet?: boolean;
    } = {}): Promise<{
      merged: DatabaseConnection[] | null;
      pendingSeeds: string[];
      failed: boolean;
      cacheHint: number | null;
      sessionEnded: boolean;
    }> => {
      const managedRes = await appFetch("/api/connections/managed");
      // A non-OK response is a transient failure, NOT "nothing pending" — the
      // poll below must keep retrying (bounded by its attempt budget) instead
      // of treating it as an authoritative empty pendingSeeds.
      if (!managedRes.ok) {
        // A failure the server ATTRIBUTED to its own seed configuration is recorded as
        // an unread seed list rather than left as the empty one this state started with
        // (B37): downstream, "the server serves no seeds" and "nobody could read the
        // seeds" are different sentences, and only this response can tell them apart.
        // Any other failure — a 404 where the route does not exist at all, as in the
        // platform embed — is not evidence about that configuration and says nothing.
        // A quiet read (the refresh below) records nothing on failure: only the initial load and the
        // pending-seed poll may mark the served seeds unread, so a refresh that fails changes nothing at all.
        const body = (await managedRes.json().catch(() => ({}))) as { reason?: string; code?: string };
        if (!quiet && !cancelled && body.reason === SEED_CONFIG_UNREADABLE_REASON) {
          setServedSeeds({ loaded: false });
        }
        // The session-required answer, which appFetch has already handed to the page's session-ended
        // handler: the first load then leaves a `?connection=` link for the page sign-in returns to.
        const sessionEnded = managedRes.status === 401 && body.code === SESSION_REQUIRED_CODE;
        return { merged: null, pendingSeeds: [], failed: true, cacheHint: null, sessionEnded };
      }
      const {
        connections: managedConns,
        pendingSeeds,
        cacheHint,
      } = (await managedRes.json()) as {
        connections?: ManagedConnectionPayload[];
        pendingSeeds?: string[];
        cacheHint?: unknown;
      };
      if (!cancelled) setServedSeeds({ loaded: true, seeds: managedConns ?? [] });
      return {
        merged: managedConns && managedConns.length > 0 ? mergeManagedConnections(managedConns) : null,
        pendingSeeds: pendingSeeds ?? [],
        failed: false,
        // The server's seed cache lifetime in ms (SEED_CACHE_TTL_MS); the refresh interval follows it,
        // between the floor and the one-minute cap (managedRefreshIntervalMs).
        cacheHint: typeof cacheHint === "number" && Number.isFinite(cacheHint) ? cacheHint : null,
        sessionEnded: false,
      };
    };

    // A seed being created asynchronously on the server (e.g. the SQLite
    // sample file copy at boot) is advertised via pendingSeeds. Poll quietly
    // until it appears so the sample shows up without a page refresh; give up
    // after the attempt budget and never surface errors — the sample is a
    // nicety, not a dependency.
    const startSeedPoll = (pendingSeeds: string[]) => {
      const dismissed = new Set(storage.getDismissedSeeds());
      if (!pendingSeeds.some((seedId) => !dismissed.has(seedId))) return;

      const pollMs = Number(process.env.NEXT_PUBLIC_MANAGED_POLL_MS) || 1000;
      let attempts = 0;
      let inFlight = false;
      pollTimer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        attempts += 1;
        fetchManaged()
          .then(({ merged, pendingSeeds: stillPending, failed }) => {
            if (cancelled) return;
            if (merged) {
              setConnections(merged);
              setActiveConnection((prev) =>
                prev !== null && connectionAllowed(prev, currentPolicy)
                  ? prev
                  : (connectionsUnderPolicy(merged, currentPolicy)[0] ?? null),
              );
            }
            if (failed) return; // transient HTTP failure — keep polling until the attempt budget runs out
            const dismissedNow = new Set(storage.getDismissedSeeds());
            if (!stillPending.some((seedId) => !dismissedNow.has(seedId))) stopPoll();
          })
          .catch(() => {
            // Silent — same contract as the initial managed fetch.
          })
          .finally(() => {
            inFlight = false;
            if (attempts >= MANAGED_POLL_MAX_ATTEMPTS) stopPoll();
          });
      }, pollMs);
    };

    /*
      The managed list after the first load (#1502).

      A discovered database is added or removed on the server while a tab is open, so the
      list is read again: every max(cacheHint, floor) ms capped at a minute, only while the
      tab is visible, and at once when the window regains focus or the document becomes
      visible. One read at a time, like the seed poll: a trigger that arrives while a read is
      in flight is absorbed by it.

      It reads quietly: a refresh that fails changes nothing, servedSeeds included.
    */
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let refreshInFlight = false;

    /*
      A `?connection=` link the first load could not open (selectInitialConnection below). The
      server re-reads its seed file only once its seed cache has expired, so a link for a database
      created moments ago can arrive before that database is listed: a refresh that lists it opens
      it, whenever it runs. A miss counts only one seed-cache lifetime (the first load's cacheHint,
      recorded in initializeConnections) after the first load answered, because a refresh on focus
      or visibilitychange runs at once and the server answers it from the cache that load read.
      Only the first miss after that tells the user. A connection the reader chooses meanwhile
      cancels the link (selectConnection above).
    */
    pendingLinkIdRef.current = null;
    let firstLoadAnsweredAt = 0;
    let firstLoadCacheHint: number | null = null;

    const settlePendingLink = (next: DatabaseConnection[]) => {
      const linkedId = pendingLinkIdRef.current;
      if (linkedId === null) return;
      const linked = connectionsUnderPolicy(next, currentPolicy).find((c) => c.id === linkedId);
      if (linked !== undefined) {
        pendingLinkIdRef.current = null;
        setActiveConnection(linked);
        return;
      }
      if (Date.now() < firstLoadAnsweredAt + (firstLoadCacheHint ?? 0)) return;
      pendingLinkIdRef.current = null;
      toast({
        title: "Connection not available",
        description: "The link names a connection that is not available to you, so it was not opened.",
        variant: "destructive",
      });
    };

    /*
      The active connection keeps its object identity while its id is still listed, and the
      refreshed list carries that same object in place of its fresh copy: every way of picking a
      connection (sidebar, mobile list and header, command palette) hands the list's object to
      setActiveConnection, and a new object for the same connection resets the transaction,
      discards edits and re-reads the schema (Studio's connection-change effect). When its id is
      gone, the first remaining connection becomes active and the user is told, once, because
      the next refresh finds the new active connection listed.

      Listed means listed for the user: the policy's view of the new list, the view this hook
      returns, so a connection ALLOW_CUSTOM_CONNECTIONS hides is never kept, chosen or made
      active. The hidden ones stay in the list state, as they do after the first load.
    */
    const applyManagedRefresh = (next: DatabaseConnection[]) => {
      const active = activeConnectionRef.current;
      const selectable = connectionsUnderPolicy(next, currentPolicy);
      setConnections(
        active !== null && next.some((c) => c.id === active.id)
          ? next.map((c) => (c.id === active.id ? active : c))
          : next,
      );
      if (active === null) {
        setActiveConnection((prev) =>
          prev !== null && connectionAllowed(prev, currentPolicy) ? prev : (selectable[0] ?? null),
        );
        return;
      }
      if (selectable.some((c) => c.id === active.id)) return;
      setActiveConnection(selectable[0] ?? null);
      toast({ title: "Connection removed", description: `${active.name} is no longer available.` });
    };

    const refreshManaged = () => {
      if (refreshInFlight || document.visibilityState !== "visible") return;
      refreshInFlight = true;
      fetchManaged({ quiet: true })
        .then(({ merged, failed }) => {
          if (cancelled || failed) return;
          // An empty list is an answer too: the server withdrew every managed entry, and
          // fetchManaged maps it to `merged: null`, so what remains is the user's own list.
          const next = merged ?? storage.getConnections();
          applyManagedRefresh(next);
          settlePendingLink(next);
        })
        .catch((err) => {
          logger.debug("Managed connection refresh failed", {
            route: "use-connection-manager",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };

    const startManagedRefresh = (cacheHint: number | null) => {
      refreshTimer = setInterval(refreshManaged, managedRefreshIntervalMs(cacheHint));
      window.addEventListener("focus", refreshManaged);
      document.addEventListener("visibilitychange", refreshManaged);
    };

    const stopManagedRefresh = () => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      refreshTimer = null;
      window.removeEventListener("focus", refreshManaged);
      document.removeEventListener("visibilitychange", refreshManaged);
    };

    /**
     * The first selection of this load, made from the connections the reader will see, the
     * policy's view of `list`: the connection a link names, else the one the reader had open last
     * time, else the first of them.
     *
     * A link naming nothing in that view keeps the default. When the managed list answered, the
     * refreshes decide (settlePendingLink above), because the seed may not be listed yet. When
     * it did not answer, the reader is told that the list could not be loaded, never that the
     * connection is unavailable, which nothing here knows. When the session has ended, the link
     * stays where it is: the session-ended handler has already sent the tab to sign in with this
     * address, link included, as the page to come back to.
     *
     * A miss reads the same whatever its cause: an id that does not exist, a seed the server did
     * not list for this reader's role, and a connection of the user's own that the
     * custom-connections policy hides. The first two read the same on purpose, because telling
     * them apart would tell a reader which seed ids exist for other roles; the third is a
     * connection the server would refuse to open, so it is not one the link may open either.
     */
    const selectInitialConnection = (
      list: DatabaseConnection[],
      { answered, sessionEnded }: { answered: boolean; sessionEnded: boolean },
    ) => {
      const selectable = connectionsUnderPolicy(list, currentPolicy);
      const linkedId = sessionEnded ? null : takeLinkedConnectionId();
      const linked = linkedId === null ? undefined : selectable.find((c) => c.id === linkedId);
      if (linked !== undefined) {
        setActiveConnection(linked);
        return;
      }
      if (linkedId !== null && answered) pendingLinkIdRef.current = linkedId;
      if (linkedId !== null && !answered) {
        toast({
          title: "Connections not loaded",
          description:
            "The link names a connection, but the connection list could not be loaded, so it was not opened. Reload the page to try again.",
          variant: "destructive",
        });
      }
      if (selectable.length === 0) return;
      const savedId = storage.getActiveConnectionId();
      const saved = savedId ? selectable.find((c: DatabaseConnection) => c.id === savedId) : null;
      setActiveConnection(saved ?? selectable[0]);
    };

    const initializeConnections = async () => {
      const loadedConnections = storage.getConnections();
      // Read before anything is selected, so the first active connection is one the server opens.
      currentPolicy = await readConnectionPolicy();
      if (cancelled) return;
      setPolicy(currentPolicy);

      // Fetch managed (seed) connections
      let managedMerged = false;
      // Only an initial fetch that ANSWERED starts the refresh, for the reason the catch below
      // gives for the seed poll: where this route does not exist, every refresh would be one
      // more useless request.
      let managedAnswered = false;
      let managedCacheHint: number | null = null;
      let managedSessionEnded = false;
      try {
        const { merged, pendingSeeds, failed, cacheHint, sessionEnded } = await fetchManaged();
        if (cancelled) return;
        managedAnswered = !failed;
        managedCacheHint = cacheHint;
        managedSessionEnded = sessionEnded;
        firstLoadAnsweredAt = Date.now();
        firstLoadCacheHint = cacheHint;
        if (merged) {
          setConnections(merged);
          managedMerged = true;
          selectInitialConnection(merged, { answered: true, sessionEnded: false });
        }
        startSeedPoll(pendingSeeds);
      } catch {
        // Managed connections are optional — don't break app. Deliberately NO
        // speculative seed poll when this initial fetch fails (rejection here,
        // or failed:true reaching startSeedPoll as empty pendingSeeds): when
        // embedded in libredb-platform this endpoint does not exist, and
        // polling on failure would fire up to 30 useless requests per mount.
        // A transient boot-time failure is rare (this same server just served
        // the page) and self-heals on refresh; the failure tolerance inside
        // the poll only guards the window where a pending seed was actually
        // observed.
      }

      // A load whose managed request threw after it was unmounted selects nothing and says nothing,
      // so a link stays in the address bar for the mount that replaces this one.
      if (cancelled) return;
      if (!managedMerged) {
        setConnections(loadedConnections);
        selectInitialConnection(loadedConnections, { answered: managedAnswered, sessionEnded: managedSessionEnded });
      }

      if (managedAnswered) startManagedRefresh(managedCacheHint);
    };

    initializeConnections().catch((err) => {
      logger.warn("Connection initialization failed", {
        route: "use-connection-manager",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      cancelled = true;
      stopPoll();
      stopManagedRefresh();
    };
  }, [storageReady, toast]);

  // Persist active connection ID
  useEffect(() => {
    activeConnectionRef.current = visibleActive;
    if (visibleActive) {
      storage.setActiveConnectionId(visibleActive.id);
    }
  }, [visibleActive]);

  return {
    connections: visibleConnections,
    setConnections,
    servedSeeds,
    activeConnection: visibleActive,
    setActiveConnection: selectConnection,
    schema,
    setSchema,
    schemaError,
    isLoadingSchema,
    fetchSchema,
    /**
     * Whether the active connection is holding its catalog reads back. False with no
     * active connection: there is nothing to defer, not a deferral.
     */
    objectScanDeferred: visibleActive !== null && scanDeferred(visibleActive),
    loadObjects,
    /**
     * Whether the page made the active connection active by itself, at sign-in, on a reload, from a
     * link or as a fallback, and the person has not used it since. While it is, a connection whose
     * provider declares `resumesBilledCompute` reads nothing past its declaration: this hook holds
     * the inventory, and the shell holds the object tree with the same answer. False with no active
     * connection.
     */
    activeAwaitsUse: visibleActive !== null && usedId !== visibleActive.id,
    markActiveUsed,
    activateFallback,
    schemaContext,
    defaultContainer,
    // Only the active connection's (#1530): a list read for the one before it is not this one's.
    catalogs:
      catalogState !== null && catalogState.connectionId === visibleActive?.id ? catalogState.catalogs : NO_CATALOGS,
    activeCatalog:
      catalogState !== null && catalogState.connectionId === visibleActive?.id ? catalogState.active : undefined,
    setActiveCatalog,
    /**
     * Whether the server lets this user create, edit or open connections of their own. The shell
     * withholds every control that would make one while it is false.
     */
    customConnections: policy.customConnections,
  };
}
