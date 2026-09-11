"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { DatabaseConnection, TableRelations } from "@/lib/types";
import { tagObjectKinds, type DetailedObject } from "@/lib/db/detailed-object";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { logger } from "@/lib/logger";
import {
  buildConnectionPayload,
  NO_SERVED_SEEDS,
  SEED_CONFIG_UNREADABLE_REASON,
  type ManagedConnectionPayload,
  type ServedSeeds,
} from "./use-connection-payload";

/** Pending-seed poll: 1s ticks, give up after 30. NEXT_PUBLIC_MANAGED_POLL_MS
 * shortens the tick in source builds and tests only — NEXT_PUBLIC_ values are
 * inlined at build time, so packaged artifacts always use the default. */
const MANAGED_POLL_MAX_ATTEMPTS = 30;

export function useConnectionManager(storageReady = false) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  /**
   * The server's own seed descriptors, kept alongside the merged list rather than
   * folded into it. The merge deliberately prefers an existing editable copy over the
   * server's version, so afterwards there is no way to tell a copy that still matches
   * its seed from one the user has since pointed elsewhere — and that is exactly the
   * question a run has to answer before it may persist a bare `seed:<id>`.
   */
  const [servedSeeds, setServedSeeds] = useState<ServedSeeds>(NO_SERVED_SEEDS);
  const [schema, setSchema] = useState<readonly DetailedObject[]>([]);
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
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [pulseState, setConnectionPulse] = useState<"healthy" | "degraded" | "error" | null>(null);
  /**
   * The connection whose deferred catalog read the reader has explicitly asked for, by
   * id. Null means nobody has asked for any, which is where a session starts.
   */
  const [scanRequested, setScanRequested] = useState<string | null>(null);

  const { toast } = useToast();

  /**
   * Which catalog read is the CURRENT one, as a counter (#789 review, Minor 8).
   *
   * A read writes the schema up to three times and every write used to land under
   * whichever connection was on screen when its answer arrived. Two of those writes are
   * merely stale, and the third is worse: the object inventory DECORATES the list with
   * kinds, so connection A's kinds applied to connection B's list tag nothing where the
   * names differ and tag WRONGLY where they coincide, and `relationObjects` and
   * `rowWritableObjects` then hide a row of B's or offer an import into a view on the
   * strength of a declaration about A. That is a stale result that HIDES objects rather
   * than one that shows old ones, which is why it is closed here rather than left with
   * the phase 2 merge that has had the same shape for longer.
   *
   * A counter rather than an abort signal because the request is not the thing to cancel:
   * the deferred path in `fetchSchema` issues no request at all and still supersedes a
   * read in flight, so what is being sequenced is the READ, not the socket.
   */
  const currentRead = useRef(0);

  // Read schema for a connection — two phases so a slow/failing stats query
  // never blocks the table list:
  //   1. /api/db/schema/list      → tables + columns + PKs (fast)  → render tree
  //   2. /api/db/schema/relations → foreign keys + indexes (heavy) → async merge
  //
  // Unguarded on purpose: `fetchSchema` below is the guarded entry point every caller
  // uses, and `loadObjects` is the one call that is allowed past the guard.
  const readSchema = useCallback(
    async (conn: DatabaseConnection) => {
      const generation = ++currentRead.current;
      /** Whether this read is still the one on screen. Every write below asks first. */
      const isCurrent = () => currentRead.current === generation;
      setIsLoadingSchema(true);

      const payload = conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : conn; // bare conn for backward compat with schema route
      // The object routes refuse a body that names neither `connection` nor `connectionId`,
      // where the two schema routes accept a bare connection AS the whole body. One payload
      // for both would be a 400 on every unmanaged connection.
      const objectPayload =
        conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : { connection: conn };
      const init = (path: string, body: unknown = payload): [string, RequestInit] => [
        path,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ];

      // Phase 1 — structural list (blocks; this is what the explorer needs)
      try {
        const response = await appFetch(...init("/api/db/schema/list"));
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to fetch schema");
        }
        const list: DetailedObject[] = await response.json();
        if (!isCurrent()) return;
        setSchema(list);
        setSchemaError(null);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        // A read the reader has moved on from reports nothing at all, toast included: the
        // failure belongs to a connection that is no longer on screen, and clearing the
        // list or naming an error here would blame the CURRENT connection for a read that
        // was never issued against it.
        if (!isCurrent()) return;
        // Nothing read for THIS connection, so nothing may stay on screen as its
        // tables — the previous connection's list is not evidence about this one.
        setSchema([]);
        setSchemaError(errorMessage);
        toast({ title: "Schema Error", description: errorMessage, variant: "destructive" });
        return; // finally still clears the loading flag; skip relations
      } finally {
        // Only the current read owns the flag; a superseded one clearing it would report
        // the newer read as finished while it is still in flight.
        if (isCurrent()) setIsLoadingSchema(false);
      }

      // Phase 1b — the kind and the segments of each object, from the object surface, joined
      // onto the list above (#789). The flat reading says what an object is CALLED and never
      // what it IS, and every consumer filter reads the kind, so without this the diagram
      // draws a routine and an import offers a view as a target.
      //
      // Best-effort, and deliberately not a phase-1 failure: through Phase 1 the four object
      // methods are optional, so an engine that has not been migrated answers 501, and that is
      // a loss of DETAIL rather than of objects. Nothing is ever removed from the list here, so
      // a refused inventory leaves exactly the explorer the flat reading built. The assertable
      // evidence is the list itself, which carries no kinds, rather than this log line.
      //
      // ONLY THE RELATION KINDS ARE ASKED FOR, which the review round measured twice.
      //
      //  - Correctness. The flat readings hold relations and nothing else (`postgres.ts:225`
      //    is `'BASE TABLE','MATERIALIZED VIEW'`, `mysql.ts:280` is `'BASE TABLE'`), so every
      //    routine, trigger, sequence and event in the answer is an object the join can never
      //    match and can only CONTEST. Measured on MySQL 26.7.0, where standing ruling 3's
      //    `foo` really exists as a table, a procedure, a function, a trigger and an event in
      //    one database: the table, the procedure and the event carry the identical address
      //    `["task25c_fix1_probe","foo"]`, so they answer the flat name at the same rank,
      //    `resolveObjectAddress` refuses to choose and the TABLE comes back untagged. Every
      //    25a filter then goes quiet for it. Asking for relation kinds tags it `table`.
      //  - Cost. Each kind is one sequential `listObjects` round trip per container inside
      //    the route. Measured against the dvdrental database on PostgreSQL 18: 7 listings
      //    returning 59 objects before, 3 listings returning 22 objects after, per container,
      //    on every connection select and on every DDL-triggered refresh
      //    (`use-query-execution.ts`).
      //
      // The kinds come from the provider's own declaration and never from a list written
      // here: `role` is the provider's word about its own engine, and a hardcoded set of ids
      // would be wrong for every engine this repo has not heard of. `/api/db/provider-meta`
      // is the cheapest read in the app for this - it constructs the provider and reads its
      // capabilities WITHOUT opening a connection (see that route) - so the extra request
      // costs no socket, no pool client and no catalog statement.
      //
      // With no declaration there is nothing to ask FOR, and the request is not sent at all:
      // asking for every kind is the defect above, and an engine that declares no object
      // kinds could not have tagged anything anyway. Both cases leave the flat list standing
      // untagged, which is what a 501 from the object surface already does.
      try {
        const metaRes = await appFetch(...init("/api/db/provider-meta", objectPayload));
        if (!metaRes.ok) throw new Error(`provider metadata unavailable (${metaRes.status})`);
        const { capabilities } = (await metaRes.json()) as { capabilities: ProviderCapabilities };
        const kinds = relationKindIds(capabilities);
        if (kinds.length === 0) throw new Error("the provider declares no relation kinds");

        const objectsRes = await appFetch(...init("/api/db/objects/inventory", { ...objectPayload, kinds }));
        if (objectsRes.ok) {
          const { objects, truncated, defaultContainer } = (await objectsRes.json()) as {
            objects?: DatabaseObject[];
            truncated?: { limit: number; reason: string };
            defaultContainer?: string[];
          };
          // A saturated inventory leaves its tail untagged, and untagged reads as "nothing
          // was declared about this object" in every consumer. Nothing on screen separates
          // that from an engine with no object surface at all, so the incompleteness is at
          // least stated. Turning it into something a READER can see needs a surface this
          // hook does not have and Task 26 is expected to settle when the flat reading goes.
          if (truncated !== undefined) {
            logger.warn("Object inventory truncated; objects beyond the limit keep no kind", {
              route: "use-connection-manager",
              limit: truncated.limit,
              reason: truncated.reason,
            });
          }
          // The session default container travels with the inventory and breaks the tie this
          // join could not: the flat reading above is a reading of ONE container and drops
          // that container from every name it writes, so a bare `orders` answers to every
          // `orders` on the server. Measured on SQL Server holding `dbo.orders` as a view
          // beside `sales.orders`: the entry came back untagged, and untagged is KEPT by
          // `rowWritableObjects`, so the view was offered row writes (#789). Absent when the
          // engine could not say, and the join keeps its refusal then.
          if (objects !== undefined && isCurrent()) {
            setSchema((prev) => tagObjectKinds(prev, objects, defaultContainer));
          }
        } else {
          const body = await objectsRes.json().catch(() => ({}));
          logger.debug("Object inventory unavailable; the schema keeps no kinds", {
            route: "use-connection-manager",
            status: objectsRes.status,
            reason: typeof body.error === "string" ? body.error : undefined,
          });
        }
      } catch (error) {
        logger.debug("Object inventory failed; the schema keeps no kinds", {
          route: "use-connection-manager",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Phase 2 — relationships + indexes (best-effort; never breaks the list)
      try {
        const relRes = await appFetch(...init("/api/db/schema/relations"));
        if (!relRes.ok) {
          const errorData = await relRes.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to fetch schema relations");
        }
        const relations: TableRelations[] = await relRes.json();
        if (!isCurrent()) return;
        const byName = new Map(relations.map((r) => [r.name, r]));
        setSchema((prev) =>
          prev.map((t) => {
            const r = byName.get(t.name);
            return r ? { ...t, foreignKeys: r.foreignKeys, indexes: r.indexes } : t;
          }),
        );
      } catch (error) {
        // Foreign keys / indexes are non-essential for browsing — log and move on.
        logger.error("Failed to load schema relations (FK/indexes); table list unaffected", error, {
          route: "use-connection-manager",
        });
      }
    },
    [toast],
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
        currentRead.current++;
        // Nothing was read for THIS connection, so nothing may stay on screen or in the AI
        // prompt as its objects. `readSchema` is the only writer of these two, so returning
        // without clearing them leaves the PREVIOUS connection's tables under this
        // connection's name - D31 again (see `readSchema`'s own catch), and the grounding
        // failure #414 measured, since `schemaContext` is what the AI panels and the agent
        // rail are handed.
        setSchema([]);
        setSchemaError(null);
        return;
      }
      await readSchema(conn);
    },
    [readSchema, scanDeferred],
  );

  /**
   * Read what opening this connection would have read, because the reader asked.
   *
   * It records the request against the connection's id before reading, so the tree's own
   * root read is released by the same press: the panel that offers this action is
   * rendered from `objectScanDeferred`.
   */
  const loadObjects = useCallback(() => {
    const conn = activeConnection;
    if (conn === null) return;
    setScanRequested(conn.id);
    void readSchema(conn);
  }, [activeConnection, readSchema]);

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
   */
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // Initialize connections once storage sync is ready
  useEffect(() => {
    if (!storageReady) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
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

    const fetchManaged = async (): Promise<{
      merged: DatabaseConnection[] | null;
      pendingSeeds: string[];
      failed: boolean;
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
        const body = (await managedRes.json().catch(() => ({}))) as { reason?: string };
        if (!cancelled && body.reason === SEED_CONFIG_UNREADABLE_REASON) setServedSeeds({ loaded: false });
        return { merged: null, pendingSeeds: [], failed: true };
      }
      const { connections: managedConns, pendingSeeds } = (await managedRes.json()) as {
        connections?: ManagedConnectionPayload[];
        pendingSeeds?: string[];
      };
      if (!cancelled) setServedSeeds({ loaded: true, seeds: managedConns ?? [] });
      return {
        merged: managedConns && managedConns.length > 0 ? mergeManagedConnections(managedConns) : null,
        pendingSeeds: pendingSeeds ?? [],
        failed: false,
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
              setActiveConnection((prev) => prev ?? merged[0] ?? null);
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

    const initializeConnections = async () => {
      const loadedConnections = storage.getConnections();

      // Fetch managed (seed) connections
      let managedMerged = false;
      try {
        const { merged, pendingSeeds } = await fetchManaged();
        if (cancelled) return;
        if (merged) {
          setConnections(merged);
          managedMerged = true;

          if (merged.length > 0) {
            const savedId = storage.getActiveConnectionId();
            const saved = savedId ? merged.find((c: DatabaseConnection) => c.id === savedId) : null;
            setActiveConnection(saved ?? merged[0]);
          }
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

      if (!managedMerged) {
        setConnections(loadedConnections);
        if (loadedConnections.length > 0) {
          const savedId = storage.getActiveConnectionId();
          const saved = savedId ? loadedConnections.find((c: DatabaseConnection) => c.id === savedId) : null;
          setActiveConnection(saved ?? loadedConnections[0]);
        }
      }
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
    };
  }, [storageReady]);

  // Persist active connection ID
  useEffect(() => {
    if (activeConnection) {
      storage.setActiveConnectionId(activeConnection.id);
    }
  }, [activeConnection]);

  // Connection pulse — quick health check every 60s
  useEffect(() => {
    if (!activeConnection) return;
    const checkHealth = async () => {
      try {
        const res = await appFetch("/api/db/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildConnectionPayload(activeConnection)),
        });
        setConnectionPulse(res.ok ? "healthy" : "degraded");
      } catch {
        setConnectionPulse("error");
      }
    };
    checkHealth().catch(() => {});
    const interval = setInterval(checkHealth, 60000);
    return () => clearInterval(interval);
  }, [activeConnection]);

  return {
    connections,
    setConnections,
    servedSeeds,
    activeConnection,
    setActiveConnection,
    schema,
    setSchema,
    schemaError,
    isLoadingSchema,
    // Derived rather than reset in the pulse effect: with no active connection
    // there is nothing to report on, and the render already knows that.
    connectionPulse: activeConnection === null ? null : pulseState,
    fetchSchema,
    /**
     * Whether the active connection is holding its catalog reads back. False with no
     * active connection: there is nothing to defer, not a deferral.
     */
    objectScanDeferred: activeConnection !== null && scanDeferred(activeConnection),
    loadObjects,
    schemaContext,
  };
}
