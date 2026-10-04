"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { detailedObjects, schemaContextOf, type DetailedObject } from "@/lib/db/detailed-object";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { DatabaseObject, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";
import { useReadGeneration } from "@/hooks/use-read-generation";
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

/**
 * Managed-list refresh after the first load (CapRover auto-connect spec, section 11): the interval
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

export function useConnectionManager(storageReady = false) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  /**
   * The active connection as last committed, for the managed refresh: the refresh runs inside
   * the storage effect, whose closure never sees a later render, and it has to know which
   * connection is open to keep it open or to say that it is gone.
   */
  const activeConnectionRef = useRef<DatabaseConnection | null>(null);
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
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [pulseState, setConnectionPulse] = useState<"healthy" | "degraded" | "error" | null>(null);
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
    async (conn: DatabaseConnection) => {
      /** Whether this read is still the one on screen. Every write below asks first. */
      const isCurrent = reads.begin();
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

        const objectsRes = await appFetch(
          ...init("/api/db/objects/inventory", { ...payload, kinds, includeColumns: true }),
        );
        if (!objectsRes.ok) {
          const body = await objectsRes.json().catch(() => ({}));
          throw new Error(body.error || "Failed to read the database objects");
        }
        const { objects, details, truncated, defaultContainer } = (await objectsRes.json()) as {
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
        setDefaultContainer(defaultContainer);
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
        const body = (await managedRes.json().catch(() => ({}))) as { reason?: string };
        if (!quiet && !cancelled && body.reason === SEED_CONFIG_UNREADABLE_REASON) {
          setServedSeeds({ loaded: false });
        }
        return { merged: null, pendingSeeds: [], failed: true, cacheHint: null };
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

    /*
      The managed list after the first load (CapRover auto-connect spec, section 11).

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
      The active connection keeps its object identity while its id is still listed, and the
      refreshed list carries that same object in place of its fresh copy: every way of picking a
      connection (sidebar, mobile list and header, command palette) hands the list's object to
      setActiveConnection, and a new object for the same connection resets the transaction,
      discards edits and re-reads the schema (Studio's connection-change effect). When its id is
      gone, the first remaining connection becomes active and the user is told, once, because
      the next refresh finds the new active connection listed.
    */
    const applyManagedRefresh = (next: DatabaseConnection[]) => {
      const active = activeConnectionRef.current;
      setConnections(
        active !== null && next.some((c) => c.id === active.id)
          ? next.map((c) => (c.id === active.id ? active : c))
          : next,
      );
      if (active === null) {
        setActiveConnection((prev) => prev ?? next[0] ?? null);
        return;
      }
      if (next.some((c) => c.id === active.id)) return;
      setActiveConnection(next[0] ?? null);
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
          applyManagedRefresh(merged ?? storage.getConnections());
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

    const initializeConnections = async () => {
      const loadedConnections = storage.getConnections();

      // Fetch managed (seed) connections
      let managedMerged = false;
      // Only an initial fetch that ANSWERED starts the refresh, for the reason the catch below
      // gives for the seed poll: where this route does not exist, every refresh would be one
      // more useless request.
      let managedAnswered = false;
      let managedCacheHint: number | null = null;
      try {
        const { merged, pendingSeeds, failed, cacheHint } = await fetchManaged();
        if (cancelled) return;
        managedAnswered = !failed;
        managedCacheHint = cacheHint;
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
    activeConnectionRef.current = activeConnection;
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
    defaultContainer,
  };
}
