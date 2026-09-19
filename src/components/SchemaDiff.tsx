"use client";

import { appFetch } from "@/lib/config/base-path";
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useReadGeneration } from "@/hooks/use-read-generation";
import { connectionResolutionKey } from "@/hooks/use-connection-payload";
import {
  GitCompare,
  Plus,
  Minus,
  PenLine,
  Camera,
  FileCode,
  ChevronRight,
  ChevronDown,
  Clock,
  Database,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SchemaSnapshot, DatabaseType, DatabaseConnection } from "@/lib/types";
import { detailedObjects, type DetailedObject } from "@/lib/db/detailed-object";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";
import { storage } from "@/lib/storage";
import { newLocalId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { useAllConnections } from "@/hooks/use-all-connections";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { SchemaDiff as SchemaDiffType, TableDiff } from "@/lib/schema-diff/types";
import { SnapshotTimeline } from "@/components/SnapshotTimeline";

interface SchemaDiffProps {
  schema: readonly DetailedObject[];
  connection: DatabaseConnection | null;
}

/**
 * Read one connection's objects from the database.
 *
 * Two reads of the object surface, where this used to be one call to
 * `POST /api/db/schema-snapshot` (#789). That route read the flat schema, which no longer
 * exists, and the two things it hand-rolled around that read are things `getOrCreateProvider`
 * does for every object route already: it opens the SSH tunnel (#457), and it returns the
 * handle this connection already holds rather than opening a second one, which is what #498
 * needed on an engine that admits only one writer to its file.
 *
 * `provider-meta` decides which kinds are asked for, exactly as the object browser's own read
 * does, and for the same measured reason: a diff is over relations, and asking for every
 * declared kind would list routines and triggers this comparison cannot use.
 *
 * It sits outside the component because BOTH sides of a diff need it. The remote side always
 * called it; the "Current Schema" side read a prop instead, so a diff taken right after a DDL
 * change compared the database against a copy of itself from before the change and reported
 * no differences (#884).
 */
function readPayload(conn: DatabaseConnection): { connectionId: string } | { connection: DatabaseConnection } {
  return conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : { connection: conn };
}

/**
 * Which DATABASE a read of this connection would reach, as a string two renders can compare.
 *
 * The connection OBJECT cannot answer this and neither can its id, and they fail in opposite
 * directions. The object is rebuilt per render by the embedded host, so identity says "a
 * different database" about one that never moved. The id SURVIVES being pointed somewhere
 * else - a connection edited in place keeps it - so the id says "the same database" about a
 * different host. Between them sits the only question a read has: what would I be sent, and
 * would it reach the same place.
 *
 * So the key is derived from the payload `readLiveSchema` actually posts, through the same
 * function, which is what keeps the two from drifting: a field that starts or stops
 * addressing a database changes both answers at once.
 *
 * Key ORDER is not normalised. Two objects carrying the same fields in a different insertion
 * order key differently, and the cost of that is one extra read - the safe direction - so it
 * is not worth the recursion; within one panel the object comes from one builder.
 */
function readTargetKey(conn: DatabaseConnection): string {
  const payload = readPayload(conn);
  // A managed connection is read BY ITS SEED: the route resolves the credentials at the
  // other end and is sent nothing else, so nothing else about the object can change what
  // comes back - not even a host field a caller has filled in beside it.
  if (!("connection" in payload)) return payload.connectionId;
  return connectionResolutionKey(payload.connection);
}

async function readLiveSchema(conn: DatabaseConnection): Promise<DetailedObject[]> {
  const payload = readPayload(conn);
  const post = (path: string, body: unknown) =>
    appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const metaRes = await post("/api/db/provider-meta", payload);
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta.error);
  const kinds = relationKindIds(meta.capabilities as ProviderCapabilities);
  if (kinds.length === 0) throw new Error(`${conn.name} declares no object kinds a schema diff can compare`);

  const res = await post("/api/db/objects/inventory", { ...payload, kinds, includeColumns: true });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  return [...detailedObjects(data.objects ?? [], data.details ?? [])];
}

export function SchemaDiff({ schema, connection }: SchemaDiffProps) {
  const [snapshots, setSnapshots] = useState<SchemaSnapshot[]>(() => storage.getSchemaSnapshots());
  const [sourceId, setSourceId] = useState<string>("current");
  const [targetId, setTargetId] = useState<string>("");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);
  /** True while a snapshot's own read is in flight. State, because the button reads it. */
  const [snapshotting, setSnapshotting] = useState(false);
  /**
   * The same fact as a ref, because the GUARD cannot read the state.
   *
   * Two Enter presses land in the same tick, before React has re-rendered, so both see the
   * `snapshotting` the callback closed over — `false` — and both save. A ref is written and
   * read synchronously, which is what a re-entrancy guard needs.
   */
  const snapshotInFlight = useRef(false);
  /**
   * The reason the last snapshot was not saved, and the connection it was about.
   *
   * Carried together for the reason `liveRead` is: a failure on the connection the user has
   * left is not a failure of the one they are looking at, and a banner about the other
   * database over a working panel is its own small lie. Derived rather than cleared by an
   * effect, so there is no render where the wrong one is on screen.
   *
   * THREE things clear it and no read is among them: a new attempt (`takeSnapshot` clears it
   * before it begins, so the report always describes the latest press of Save), a snapshot
   * that succeeds, and the Dismiss on the banner. A read of the connection that works used to
   * clear it as well, which is how the message the whole fix existed for lasted one tick -
   * the read that overtakes a snapshot IS such a read. What a read may say is whether Current
   * Schema is fresh; that is `liveRead.error`, a different fact on its own line, and the two
   * never write each other.
   */
  const [snapshotFailure, setSnapshotFailure] = useState<{ connectionId: string; reason: string } | null>(null);

  /**
   * Which read is the current one.
   *
   * Three things read this connection now - the panel opening, a snapshot, and a target
   * being chosen to compare against - and any of them can settle after another has already
   * started. A counter is what settles that, and the repository already states the rule
   * once in `useReadGeneration`: begin a read, and every write it performs asks first
   * whether it is still the one that matters.
   *
   * Comparing the connection OBJECT instead was the earlier attempt and it is not safe:
   * `use-connection-adapter.ts` builds `activeConnection` with a `useMemo` over a prop the
   * embedded host supplies, so a host that hands over a fresh array per render produces a
   * fresh object per render, and a read would then be discarded on a connection that never
   * changed - the snapshot silently not saved, with nothing on screen.
   */
  const reads = useReadGeneration();

  /**
   * The same rule for the OTHER connection's reads, on a counter of its own.
   *
   * `fetchRemoteSchema` was outside any counter, so two of them in a row raced: whichever
   * landed LAST wrote its snapshot and made itself the target, which is the connection the
   * user asked for FIRST, and whichever landed first cleared "Fetching..." while the other
   * was still out. It gets its own counter rather than sharing `reads`, because the two
   * sequence different things: a remote read is a read of a DIFFERENT database, and
   * putting them on one counter would have the panel's own read of the connection on screen
   * discarded because someone fetched a schema from somewhere else - Current Schema then
   * silently falling back to the explorer's copy, which is the defect this panel exists to
   * have stopped doing.
   */
  const remoteReads = useReadGeneration();

  /**
   * Nothing this panel started may write after the panel is gone.
   *
   * `BottomPanel` mounts one view at a time, so LEAVING the Diff tab unmounts this. The
   * label input and Cancel are locked while a snapshot's read is in flight, to stop the save
   * being closed out from under it - and changing tabs walked straight past that lock: the
   * read settled afterwards and the snapshot was written for a panel that was gone, with no
   * banner, no refreshed list and nothing on screen that it had happened. Superseding both
   * counters on the way out makes every write those reads still intend to perform ask a
   * question whose answer is already no.
   *
   * Both counters are stable for the life of the hook, so this cleanup runs on unmount and
   * at no other time - it does not supersede reads on an ordinary re-render.
   *
   * The counters are not the whole answer, and `mounted` is the rest of it. A counter says
   * whether a read is still the one that MATTERS; it cannot say whether anyone is left to
   * be told, and those are different questions the moment a write runs WHATEVER the counter
   * answers. Three do: a superseded snapshot reports "press Save again", and both `finally`
   * blocks hand their button back deliberately unconditionally, because a read that loses
   * the race still has to stop the panel reading "Reading..." for good. Every one of them is
   * right while the panel is on screen and is a write to a dead component after it is gone.
   * So the same cleanup that supersedes the reads also puts this down, and the three writes
   * that do not ask the counter ask this instead - one bit, set in one place, rather than a
   * second mechanism beside the first.
   *
   * Re-armed in the effect BODY, not just initialised: React's StrictMode mounts, runs this
   * cleanup and mounts again, and a flag only ever set to false there would leave the panel
   * unable to report anything for the rest of its life in development.
   */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reads.supersede();
      remoteReads.supersede();
    };
  }, [reads, remoteReads]);

  /**
   * The objects the database holds, and WHICH DATABASE they were read from.
   *
   * Carried together rather than cleared on a switch, because the panel outlives one:
   * holding the previous database's objects made "Current Schema" mean the OTHER connection
   * until the new read landed, and for good if that read failed.
   *
   * The target is `readTargetKey`'s answer and not the connection object, because the object
   * is the wrong keepsake twice over: held, it is a captured copy of something the host
   * rebuilds, and compared, its identity moves when nothing about the database did.
   *
   * `error` is the other half. The panel falls back to the explorer's copy, and that copy is
   * precisely what #884 is about, so the reason is state that reaches the screen rather than
   * a log line that reaches nobody standing in front of the panel.
   */
  const [liveRead, setLiveRead] = useState<{
    target: string;
    objects: readonly DetailedObject[] | null;
    error: string | null;
  } | null>(null);

  /**
   * What every read of this panel's own connection is keyed on, and what every read of it is
   * matched against. The empty string is "no connection", which no real key can be.
   *
   * It is one value for both because they are one question asked twice - "would a read reach
   * the same database?" - and answering it two different ways is what the two findings this
   * closes were. The effect asked it by OBJECT IDENTITY, so a host handing over a rebuilt
   * object read again and destroyed the snapshot in flight. The guard asked it by ID, so a
   * connection edited to point at another host matched the previous database's read and
   * showed it as Current Schema.
   *
   * The id is still exactly right for a different question, and both remaining uses ask that
   * one: WHICH CONNECTION, as the user's list names it, not which database it reaches.
   * `snapshotFailure` carries the id so a report is not shown over a connection the user has
   * moved to, and a stored snapshot is stamped with it so the list can say where it came
   * from. An in-place edit is the same entry in that list and keeps its report; choosing
   * another connection is a different entry and does not. What the id cannot answer is
   * whether the objects in hand came from where this connection now points.
   */
  const readTarget = connection ? readTargetKey(connection) : "";

  /**
   * The connection object itself, for the two effects below that are keyed on `readTarget`.
   *
   * They need the object to read with and must not re-run when only its identity changes, and
   * those two cannot both be served by the dependency list. A ref serves the first. It is
   * written in an effect rather than during render - a render-phase write is impure, and this
   * is declared ABOVE both readers so React has already run it by the time either fires on
   * the same commit - and it is read rather than captured, so a read always goes out with the
   * host's CURRENT object and never a stale copy of it.
   */
  const latestConnection = useRef(connection);
  useEffect(() => {
    latestConnection.current = connection;
  }, [connection]);

  const readForThisConnection = liveRead?.target === readTarget ? liveRead : null;
  const liveSchema = readForThisConnection?.objects ?? null;
  const liveSchemaError = readForThisConnection?.error ?? null;
  const snapshotError =
    snapshotFailure !== null && snapshotFailure.connectionId === connection?.id ? snapshotFailure.reason : null;

  /**
   * Begin a read of this connection, and hand back both the promise and the question every
   * write it performs has to ask first.
   *
   * The write is left to the caller rather than done here, and deliberately: a `setState`
   * reached through a helper called straight from an effect is what the React lint rules
   * forbid, and the shape they accept - settle first, then write - is also the honest one,
   * because the two callers want different things from a failure. The panel opening falls
   * back to the explorer's copy and says so; a snapshot saves nothing at all.
   */
  const beginRead = useCallback(
    (conn: DatabaseConnection) => ({ read: readLiveSchema(conn), isCurrent: reads.begin() }),
    [reads],
  );

  // Keyed on `readTarget`, not on the connection object. A host that rebuilds the object
  // without moving it re-rendered this panel into a read it had no reason to make, and that
  // read went through the same counter as everything else - so it superseded a snapshot the
  // user had pressed Save on, which saved nothing and blamed them for a race they did not
  // cause. Keyed on the ID instead it would never re-read a connection edited in place, and
  // the previous database's objects would stand as Current Schema for good rather than for a
  // moment. The key is what asks neither of those wrong questions.
  useEffect(() => {
    const conn = latestConnection.current;
    if (!conn) return;
    const { read, isCurrent } = beginRead(conn);
    read
      .then((objects) => {
        if (!isCurrent()) return;
        setLiveRead({ target: readTarget, objects, error: null });
        // The snapshot report is NOT touched here, and that is the whole of this fix. This
        // write says one thing - Current Schema is fresh - and a snapshot that was not
        // written stays not written however many reads land afterwards. Clearing it here put
        // the silence straight back, because the read that OVERTAKES a snapshot is exactly a
        // read of this connection that succeeds: in the ordinary order the overtaken one
        // answers first and raises the banner, this one answers a tick later and wiped it.
        // The stale banner this used to guard against is answered by the two things that
        // really do spend the report - pressing Save again, which clears it at the start of
        // the attempt, and the Dismiss on the banner itself - and by the connection it
        // carries, which keeps it off a database the user is not looking at.
      })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (isCurrent()) setLiveRead({ target: readTarget, objects: null, error: reason });
        logger.warn("Failed to read the current schema for a diff; falling back to the explorer's copy", {
          route: "SchemaDiff",
          error: reason,
        });
      });
  }, [readTarget, beginRead]);

  /**
   * A comparison reads the database again.
   *
   * Without this the panel answers the question it was opened with rather than the one being
   * asked: take a snapshot, change the database, pick that snapshot as the target, and both
   * sides are the moment of the snapshot - "No differences found" again, which is the whole
   * defect wearing different clothes. The read happens when a target is CHOSEN, because that
   * is the moment a person asks to be told the difference.
   */
  useEffect(() => {
    // Only when one side of the comparison IS the database. Two snapshots against each
    // other are two files; reading the connection for them is a round trip that changes
    // nothing either side shows.
    const conn = latestConnection.current;
    if (!conn || !targetId) return;
    if (sourceId !== "current" && targetId !== "current") return;
    const { read, isCurrent } = beginRead(conn);
    read
      .then((objects) => {
        if (!isCurrent()) return;
        setLiveRead({ target: readTarget, objects, error: null });
        // Same rule as the read when the panel opens, and this is the call site that did the
        // damage: choosing a target is the commonest way a snapshot in flight gets overtaken,
        // so this read and the snapshot it superseded are two halves of one gesture. It
        // reports on Current Schema and on nothing else.
      })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        // Falling back to the last copy rather than emptying the side, which would report
        // every object as removed; the banner says why it may be out of date.
        if (isCurrent()) setLiveRead({ target: readTarget, objects: null, error: reason });
      });
    // On `readTarget` for the reason the effect above is, and it matters here too: a chosen
    // target is the commonest way a snapshot gets overtaken, so a rebuilt object re-running
    // THIS one destroys a snapshot just as surely.
  }, [targetId, sourceId, readTarget, beginRead]);

  /** True while the Refresh button's own read is in flight. State, because the button reads it. */
  const [refreshing, setRefreshing] = useState(false);
  /**
   * The same fact as a ref, because the GUARD cannot read the state - exactly as
   * `snapshotInFlight` cannot read `snapshotting`.
   *
   * Two clicks land in the same tick, before React has re-rendered, so both see the
   * `refreshing` the callback closed over - `false` - and the `disabled` that would have
   * stopped the second is not on the button yet. The counter keeps the older read from
   * WRITING, so the data stays right; what breaks is the screen, and it is the thing
   * `fetchRemoteSchema` was fixed for: the first read to settle runs the `finally` and hands
   * the button back to "Refresh" while the read the user is waiting for is still out.
   */
  const refreshInFlight = useRef(false);

  /**
   * Read the database again on demand.
   *
   * The effect above reads when a target is CHOSEN, and "chosen" is a value CHANGING: the
   * Select reports a selection only when it lands on something else, so picking the target
   * that is already picked re-renders nothing and re-reads nothing. Every other way of
   * asking is worse - there is no target at all to re-pick before one is chosen, and when
   * the target is a snapshot the only way to make the value change is to select something
   * else and come back, which reads the database twice to answer one question. So the panel
   * shipped with exactly one way to see a change: leave the Diff tab and return, because
   * `BottomPanel` mounts one view at a time and returning is a remount. That is the step
   * this whole piece of work exists to remove, and it was still the only one.
   *
   * A button, therefore, rather than a cleverer rule about the Select. It works from any
   * state the panel can be in, it says what it does, and it is the one affordance a person
   * does not have to be told about. It goes through the same counter as every other read of
   * this connection, so a refresh and a snapshot in flight cannot both decide what Current
   * Schema means - the newer one wins and the older says so, exactly as choosing a target
   * already does.
   *
   * Pressed TWICE in one tick it reads once: `disabled` is a re-render behind the second
   * click, so the ref is what actually makes a second read impossible rather than unlikely.
   */
  const refreshCurrentSchema = useCallback(() => {
    if (!connection || refreshInFlight.current) return;
    refreshInFlight.current = true;
    const { read, isCurrent } = beginRead(connection);
    setRefreshing(true);
    read
      .then((objects) => {
        if (isCurrent()) setLiveRead({ target: readTarget, objects, error: null });
      })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        // Same fallback as the other two reads: the last copy rather than an empty side,
        // which would report every object as removed, and a banner saying why.
        if (isCurrent()) setLiveRead({ target: readTarget, objects: null, error: reason });
        logger.warn("Failed to re-read the current schema for a diff", {
          route: "SchemaDiff",
          error: reason,
        });
      })
      .finally(() => {
        // Unconditional: a refresh that is superseded still has to give the button back,
        // and the button is disabled while it is true. Asking `isCurrent()` here instead
        // would leave it disabled for good, because a snapshot or a target being chosen
        // supersedes this read on the SAME counter - and the guard above means the read
        // running this `finally` is the only refresh there is.
        //
        // Unconditional on the COUNTER, that is. There is no button to give back once the
        // panel has left the screen, so the state write asks `mounted` - the one question
        // the counter cannot answer. The ref beside it stays unguarded on purpose: it dies
        // with the component, and a remount builds a fresh one.
        refreshInFlight.current = false;
        if (mounted.current) setRefreshing(false);
      });
  }, [connection, readTarget, beginRead]);

  /** What "Current Schema" means on both sides of the diff, and in a new snapshot. */
  const currentSchema = liveSchema ?? schema;

  /**
   * Freeze the schema the database holds AT THIS MOMENT, not the one the panel read when
   * it opened.
   *
   * #884 moved "Current Schema" off the explorer's copy and onto a read of the connection,
   * but that read sits in an effect keyed on `[connection]` alone, so it happens once and
   * not again for as long as the panel stays open. The sequence the Diff tab exists for —
   * snapshot, change the database, compare — still answered "No differences found": the
   * snapshot froze that first copy, and so did the other side of the comparison. Measured
   * against PostgreSQL 16 with the panel left open. Leaving the tab and coming back was
   * the only thing that helped, and it helped because `BottomPanel` mounts one view at a
   * time, so returning is a remount and the effect runs again — not a step anyone would
   * guess, and not one the panel tells you about.
   *
   * Reading here fixes both halves at once, because the same read becomes the new
   * `liveRead`: the snapshot records the database, and the "Current Schema" it will be
   * compared against is refreshed to the same instant.
   *
   * A read that fails saves NOTHING. A snapshot is kept to be compared against later, so a
   * silently stale one is the defect again with a longer fuse; the banner says why and the
   * label stays typed so the button can be pressed again.
   */
  const takeSnapshot = useCallback(async () => {
    if (!connection || snapshotInFlight.current) return;
    snapshotInFlight.current = true;
    setSnapshotting(true);
    setSnapshotFailure(null);
    try {
      // The same read that becomes "Current Schema", so the snapshot and the side it will
      // be compared against are the same instant.
      const { read, isCurrent } = beginRead(connection);
      const objects = await read;
      if (!isCurrent()) {
        // Something asked for a newer read while this one was in flight - choosing a target
        // does, and so does this connection being pointed at another database while the read
        // is out. What no longer reaches here is the embedded host handing over a fresh
        // connection OBJECT for the same database: that re-rendered the panel into a read it
        // had no reason to make, and this branch then blamed the user for a race nothing in
        // the world had caused. The two things left are both somebody asking for something
        // newer. Returning quietly here saved nothing and said nothing, so the button came
        // back to "Save" and the user believed it had. The banner stays until the user acts:
        // a later read landing is not a snapshot, and clearing it on one put the silence
        // straight back. Pressing Save again is the retry, Dismiss is the way out.
        //
        // Unless the panel is what superseded it. Leaving the Diff tab supersedes both
        // counters on the way out, so an unmount arrives here looking exactly like a target
        // being chosen - and "Press Save again" is addressed to somebody standing in front
        // of a panel that no longer exists. There is no banner to raise and no Save to press;
        // the write is a write to a dead component, so it is not made.
        if (mounted.current) {
          setSnapshotFailure({
            connectionId: connection.id,
            reason: "the schema was read again before this finished. Press Save again",
          });
        }
        return;
      }
      setLiveRead({ target: readTarget, objects, error: null });
      const snapshot: SchemaSnapshot = {
        // Random, not the clock. `Date.now()` is the id two snapshots taken in the same
        // millisecond SHARE, and every use of a snapshot id keys on it being one snapshot:
        // React lists the two Selects by it and complains about duplicate keys, Delete on
        // either one removes BOTH because `deleteSchemaSnapshot` filters by id, and the
        // store keeps only the last 50 - so when the twin that is still selected falls off
        // that end, `?.schema || []` hands the diff an empty side and the panel reports the
        // WHOLE database as removed. Same millisecond is not exotic here: Save twice, or a
        // remote fetch beside a snapshot, and the clock has not moved. `newLocalId` is the
        // generator this repository already uses for the things a browser names for itself,
        // and it works on the plain-HTTP channels where `crypto.randomUUID` is undefined.
        id: newLocalId(),
        connectionId: connection.id,
        connectionName: connection.name,
        databaseType: connection.type,
        schema: JSON.parse(JSON.stringify(objects)),
        createdAt: new Date(),
        label: snapshotLabel.trim() || undefined,
      };
      // Inside the try as well: snapshots live in localStorage and a snapshot is a whole
      // schema, so a quota refusal is an ordinary outcome rather than an exotic one.
      // Inside the try, so a write that throws reaches the same banner the read failure
      // does rather than escaping as an unhandled rejection.
      //
      // It does NOT catch a full disk. `storage.saveSchemaSnapshot` returns nothing and
      // `local-storage.ts` swallows the quota error, so a refused write is reported here as
      // a snapshot taken. That is the store's to fix - every caller of it has the same
      // problem and none of them can see the failure - and it predates this change.
      storage.saveSchemaSnapshot(snapshot);
      setSnapshots(storage.getSchemaSnapshots());
      setSnapshotLabel("");
      setShowLabelInput(false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A read can fail AFTER the panel has gone - the tab is changed, the request then
      // times out - and the banner it would raise has no screen to be raised on. The log
      // below is made either way: a log is a record of what the database said, which is the
      // rule `fetchRemoteSchema` already states, and it is the only trace left of a read
      // that failed for a panel nobody was watching.
      if (mounted.current) setSnapshotFailure({ connectionId: connection.id, reason });
      logger.warn("Nothing was saved for this snapshot", { route: "SchemaDiff", error: reason });
    } finally {
      // In `finally`, not at the end of each branch: a throw between them would otherwise
      // leave the button reading "Reading..." for the life of the panel, with nothing on
      // screen saying why, and `snapshotInFlight` stuck true so no later press does anything.
      //
      // Which is a reason to run it whatever the COUNTER says, not whatever is left of the
      // panel: the button it hands back is gone once the panel is, so the state write asks
      // `mounted` first. The ref is left alone for the reason the refresh one is.
      snapshotInFlight.current = false;
      if (mounted.current) setSnapshotting(false);
    }
  }, [connection, readTarget, snapshotLabel, beginRead]);

  // Delete snapshot
  const deleteSnapshot = useCallback(
    (id: string) => {
      storage.deleteSchemaSnapshot(id);
      setSnapshots(storage.getSchemaSnapshots());
      if (sourceId === id) setSourceId("current");
      if (targetId === id) setTargetId("");
    },
    [sourceId, targetId],
  );

  /**
   * The snapshot a side names that the store cannot produce, if there is one.
   *
   * `?.schema || []` used to stand in the memo below, and that empty array is a second
   * defect wearing the id's clothes: "this snapshot is gone" and "this schema was empty"
   * are different statements, and the fallback quietly turned the first into the second.
   * The panel then answered with every table and every column listed as REMOVED - a
   * catastrophe that never happened, on the one screen a user consults to find out whether
   * one did. An id that cannot collide stops two snapshots sharing a row; it does not stop
   * a lookup from failing, so it cannot be the whole of this.
   *
   * A side goes missing for reasons that have nothing to do with a colliding id, which is
   * why this is not the id fix repeated: the store keeps the last 50 snapshots, so a
   * selected one falls off that end once 50 more are taken; localStorage is shared between
   * tabs, so another tab can delete the one this panel is pointing at; and clearing site
   * data empties the store under a panel that is still open. `deleteSnapshot` puts both
   * Selects back when it is the one doing the deleting, and that was the only route ever
   * covered - it cannot see any of the three above.
   *
   * "current" is never looked up: it is not a stored record, and the live side has its own
   * fallback to the explorer's copy and its own banner when a read fails.
   */
  const missingSnapshotId = useMemo(() => {
    if (!targetId) return null;
    const absent = (id: string) => id !== "current" && !snapshots.some((s) => s.id === id);
    if (absent(sourceId)) return sourceId;
    if (absent(targetId)) return targetId;
    return null;
  }, [sourceId, targetId, snapshots]);

  // Compute diff
  const diff = useMemo<SchemaDiffType | null>(() => {
    if (!targetId) return null;
    if (sourceId === targetId) return null;
    // A side that does not exist ends the comparison. The diff engine is not asked a
    // question whose only possible answer is a fiction; the panel says what is actually
    // wrong instead, rendered from `missingSnapshotId`.
    if (missingSnapshotId) return null;

    const side = (id: string) => (id === "current" ? currentSchema : snapshots.find((s) => s.id === id)?.schema);
    const sourceSchema = side(sourceId);
    const targetSchema = side(targetId);
    // The same fact as the guard above, said again in the one place that would otherwise
    // need a `[]` to satisfy the types. Not a second mechanism: a resolution that fails
    // ends the comparison here too, rather than standing an empty array in for a schema.
    if (!sourceSchema || !targetSchema) return null;

    return diffSchemas(sourceSchema, targetSchema);
  }, [sourceId, targetId, currentSchema, snapshots, missingSnapshotId]);

  // Generate migration SQL
  const migrationSQL = useMemo(() => {
    if (!diff || !diff.hasChanges) return "";
    const dialect = connection?.type || "postgres";
    return generateMigrationSQL(diff, dialect as DatabaseType);
  }, [diff, connection]);

  // Get all connections for cross-connection comparison
  const { connections: allConnections } = useAllConnections();
  const [fetchingRemote, setFetchingRemote] = useState(false);
  /**
   * Why the last remote fetch brought nothing back, and which database was asked.
   *
   * The failure reached the log and nowhere else: the spinner went down, the target stayed
   * where it was, and the panel went on showing the comparison the user had just asked to
   * replace - so the screen says "this is that database" when it is not, which is the
   * silent-stale-side defect this panel exists to have stopped, entered by another door.
   *
   * Its own state rather than `snapshotFailure`, though the banner below is deliberately
   * the same shape and the same Dismiss: that report is about the connection ON SCREEN and
   * is keyed to it, this one is about ANOTHER database, and pressing Save must not spend a
   * report about a fetch it has nothing to do with.
   *
   * Spent where the snapshot report is spent and nowhere else - at the start of the next
   * attempt, which is also what a fetch that WORKS clears it with, and the Dismiss on the
   * banner. No read clears it: a later read landing is not the fetch that failed, and
   * clearing on one is how the snapshot message used to last a single tick.
   */
  const [remoteFailure, setRemoteFailure] = useState<{ connectionName: string; reason: string } | null>(null);

  // Fetch schema from a remote connection
  const fetchRemoteSchema = useCallback(
    async (connId: string) => {
      const conn = allConnections.find((c) => c.id === connId);
      if (!conn) return;

      // Sequenced like every other read in this panel, and it was the one that was not.
      // Pick one connection, change your mind, pick another: two reads are out, and the
      // one that answers LAST wrote its snapshot and made itself the target - so the
      // target ended up being the database asked for first, chosen by network timing. The
      // one that answered first cleared "Fetching..." while the other was still running,
      // so the panel also said it had finished when it had not.
      const isCurrent = remoteReads.begin();
      setFetchingRemote(true);
      // Cleared at the START of the attempt, exactly as `takeSnapshot` clears its own
      // report: the message always describes the latest thing the user asked for, so a
      // fetch that works leaves nothing of the one that failed behind it.
      setRemoteFailure(null);
      try {
        const objects = await readLiveSchema(conn);
        // A superseded fetch writes NOTHING: not the snapshot, which would litter the list
        // with a database the user turned away from, and above all not the target.
        if (!isCurrent()) return;

        // Auto-save as snapshot
        const snapshot: SchemaSnapshot = {
          // Random for the reason the snapshot above is: `remote-${Date.now()}` collides
          // with a second fetch in the same millisecond exactly as the clock id did.
          id: `remote-${newLocalId()}`,
          connectionId: conn.id,
          connectionName: conn.name,
          databaseType: conn.type,
          schema: objects,
          createdAt: new Date(),
          label: `Live: ${conn.name}`,
        };
        storage.saveSchemaSnapshot(snapshot);
        setSnapshots(storage.getSchemaSnapshots());
        setTargetId(snapshot.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Logged whether or not it is still the current read: a log is a record of what the
        // database said, not a claim on the screen.
        logger.warn("Failed to fetch the remote schema for a diff", {
          route: "SchemaDiff",
          error: reason,
        });
        // On screen only for the read the user is actually waiting on, and through the same
        // counter that decides who may write the target - the one question a failure has to
        // ask before it speaks. A connection turned away from, failing afterwards, is not
        // the question being answered; and the unmount supersedes this counter too, so
        // there is no banner raised on a panel that has left the screen.
        if (isCurrent()) setRemoteFailure({ connectionName: conn.name, reason });
      } finally {
        // Only the current read may say the fetching is over. A stale one clearing this is
        // the spinner disappearing while a fetch the user is waiting for is still out.
        if (isCurrent()) setFetchingRemote(false);
      }
    },
    [allConnections, remoteReads],
  );

  /**
   * The user choosing a target that is already stored - which SUPERSEDES the remote side.
   *
   * The counter above sequences remote reads against each other and was never the whole
   * race, because a remote read is not the only thing that sets the target and the other
   * thing is instant: this writes it in the same tick as the click. So pick a connection,
   * change your mind, pick a snapshot from the list, and the read you turned away from
   * landed afterwards and made ITSELF the target - the panel showing a comparison nobody
   * asked for, and the choice the user actually made gone from under them.
   *
   * `supersede()` rather than a third mechanism, and rather than a flag the fetch consults:
   * it is the counter that is already there, saying the one thing that has to be true - a
   * read that was running when the user chose something else is no longer the read that
   * matters, so every write it still intends to perform asks a question whose answer is now
   * no. That covers the snapshot as well as the target, because `fetchRemoteSchema` asks
   * once, before either.
   *
   * The busy indicator is put down HERE and nowhere else, and it has to be: superseding is
   * what stops the abandoned read running `setFetchingRemote(false)` in its `finally`, so
   * leaving it would hang "Fetching..." on screen for the life of the panel with nothing
   * outstanding behind it. It is also the honest reading - nothing the user is waiting for
   * is out any more. A LATER fetch raises it again on its own `begin()`, and only that
   * newest read may clear it, which is the rule the counter held before this and still does.
   *
   * Both ways of choosing a stored target go through here - the Target select and the
   * timeline's Compare, which is on screen precisely while a remote fetch has not landed -
   * so the defect is closed at the choice rather than at one of its two buttons.
   */
  const chooseTarget = useCallback(
    (id: string) => {
      remoteReads.supersede();
      setFetchingRemote(false);
      setTargetId(id);
    },
    [remoteReads],
  );

  const getActionBadge = (action: string) => {
    switch (action) {
      case "added":
        return (
          <Badge className="bg-hue-green-tint/20 text-hue-green border-hue-green-tint/30 text-xs">
            <Plus strokeWidth={1.5} className="w-2.5 h-2.5 mr-0.5" />
            {"Added"}
          </Badge>
        );
      case "removed":
        return (
          <Badge className="bg-hue-red-tint/20 text-hue-red border-hue-red-tint/30 text-xs">
            <Minus className="w-2.5 h-2.5 mr-0.5" />
            {"Removed"}
          </Badge>
        );
      case "modified":
        return (
          <Badge className="bg-hue-yellow-tint/20 text-hue-yellow border-hue-yellow-tint/30 text-xs">
            <PenLine strokeWidth={1.5} className="w-2.5 h-2.5 mr-0.5" />
            {"Modified"}
          </Badge>
        );
      default:
        return null;
    }
  };

  const formatSnapshotLabel = (s: SchemaSnapshot) => {
    const date = new Date(s.createdAt).toLocaleString();
    return `${s.label || s.connectionName} (${date})`;
  };

  return (
    <div className="h-full flex flex-col bg-sunken">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hairline bg-surface flex-wrap">
        <GitCompare strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-rose" />
        <span className="text-xs font-medium text-fg-tertiary">Schema Diff</span>

        <div className="h-4 w-px bg-fill-strong" />

        {/* Source selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-fg-subtle">Source</span>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger className="h-7 w-[180px] text-xs bg-fill border-hairline-strong">
              <SelectValue placeholder="Select source" />
            </SelectTrigger>
            <SelectContent className="bg-overlay border-hairline-strong">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database strokeWidth={1.5} className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock strokeWidth={1.5} className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-fg-subtle text-xs">vs</span>

        {/* Target selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-fg-subtle">Target</span>
          <Select
            value={targetId}
            onValueChange={(v) => {
              if (v.startsWith("conn:")) {
                fetchRemoteSchema(v.replace("conn:", ""));
              } else {
                chooseTarget(v);
              }
            }}
          >
            <SelectTrigger className="h-7 w-[180px] text-xs bg-fill border-hairline-strong">
              <SelectValue placeholder="Select target" />
            </SelectTrigger>
            <SelectContent className="bg-overlay border-hairline-strong">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database strokeWidth={1.5} className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock strokeWidth={1.5} className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
              {allConnections.filter((c) => c.id !== connection?.id).length > 0 && (
                <>
                  <div className="px-2 py-1 text-[0.625rem] text-fg-subtle border-t border-hairline mt-1">
                    {"Fetch from connection"}
                  </div>
                  {allConnections
                    .filter((c) => c.id !== connection?.id)
                    .map((c) => (
                      <SelectItem key={`conn:${c.id}`} value={`conn:${c.id}`} className="text-xs">
                        <div className="flex items-center gap-1">
                          <Database strokeWidth={1.5} className="w-3 h-3 text-hue-blue" /> {c.name}
                          {c.environment === "production" && (
                            <TriangleAlert strokeWidth={1.5} className="w-3 h-3 text-danger" />
                          )}
                        </div>
                      </SelectItem>
                    ))}
                </>
              )}
            </SelectContent>
          </Select>
          {fetchingRemote && <span className="text-xs text-fg-muted animate-pulse">Fetching...</span>}
        </div>

        <div className="flex-1" />

        {/* Read the database again on demand. The only way to see a change used to be
            leaving the tab and coming back, because that remounts the panel - a step nobody
            would guess and the one this work exists to remove.

            Locked while a SNAPSHOT is reading too, for the reason the label input, Save and
            Cancel are: this goes through the same counter, so a refresh pressed before the
            snapshot's read lands supersedes it, and the user who typed a label and pressed
            Save gets nothing saved and "Press Save again" for their trouble. The lock is one
            way round on purpose - Save is not locked while a refresh is out - because only
            one of the two produces something the user asked to keep, and a refresh that
            loses the race costs a round trip and says so on the button. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
          onClick={refreshCurrentSchema}
          disabled={!connection || refreshing || snapshotting}
        >
          <RefreshCw strokeWidth={1.5} className={cn("w-3 h-3", refreshing && "animate-spin")} />{" "}
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>

        {/* Snapshot controls */}
        {showLabelInput ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Label (optional)..."
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && takeSnapshot()}
              disabled={snapshotting}
              className="h-7 px-2 text-xs bg-fill border border-hairline-strong rounded text-fg-secondary focus:outline-none focus:border-brand-tint w-32 disabled:opacity-60"
              autoFocus
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-brand"
              onClick={takeSnapshot}
              disabled={snapshotting}
            >
              {snapshotting ? "Reading..." : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-fg-muted"
              // Closed while a read is in flight: the panel would go away and the snapshot
              // would still be written, which is a save nobody is watching for.
              disabled={snapshotting}
              onClick={() => setShowLabelInput(false)}
            >
              {"Cancel"}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
            onClick={() => setShowLabelInput(true)}
            disabled={!connection}
          >
            <Camera className="w-3 h-3" /> Snapshot
          </Button>
        )}

        {diff?.hasChanges && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
            onClick={() => setShowMigration(!showMigration)}
          >
            <FileCode className="w-3 h-3" /> {showMigration ? "Diff View" : "SQL Migration"}
          </Button>
        )}
      </div>

      {liveSchemaError && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-warning-tint/10 text-warning">
          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs">
            {`Current Schema is the explorer's last copy, which may be out of date: ${liveSchemaError}`}
          </span>
        </div>
      )}

      {/* Its own line, because the panel's read can be failing at the same time and the two
          are different facts: one says what Current Schema means, the other says a snapshot
          you asked for was not written. Showing only the first left the second silent. */}
      {snapshotError !== null && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-warning-tint/10 text-warning">
          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs">{`No snapshot was saved: ${snapshotError}`}</span>
          {/* The way out, and it is a button rather than a rule about which reads clear the
              report - a rule is what wiped the message in the first place. Nothing else here
              is an exit a user could rely on: pressing Save again is a retry that can fail
              again, leaving the connection only hides the report until they come back, and
              "it goes away when you reopen the panel" is something they would have to guess.
              This clears the report and nothing else; the panel's own warning above is
              derived from the last read and has its own way out, the next read that works. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 ml-auto text-xs text-warning hover:text-fg-bright"
            onClick={() => setSnapshotFailure(null)}
          >
            {"Dismiss"}
          </Button>
        </div>
      )}

      {/* A third line, beside the two above, because it is a third fact: not what Current
          Schema means, and not a snapshot that went unwritten, but a database the user asked
          to compare AGAINST that never arrived - so the comparison on screen is still the
          old one. It said nothing at all before this, which is the worst of the three: the
          spinner stopped and the panel looked finished. Same shape and same Dismiss as the
          snapshot report rather than a second style of error surface, because it is the same
          kind of statement - something you asked for was not done, spent only by you. */}
      {remoteFailure !== null && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-warning-tint/10 text-warning">
          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs">
            {`Nothing was fetched from ${remoteFailure.connectionName}, so the comparison on screen is not that database: ${remoteFailure.reason}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 ml-auto text-xs text-warning hover:text-fg-bright"
            onClick={() => setRemoteFailure(null)}
          >
            {"Dismiss"}
          </Button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {!targetId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-fg-subtle gap-3">
            <GitCompare strokeWidth={1.5} className="w-10 h-10 opacity-30" />
            <p className="text-xs">Select source and target to compare schemas</p>
            <p className="text-xs text-fg-faint">Take a snapshot first, then compare with the current schema</p>

            {/* Snapshot Timeline */}
            {snapshots.length > 0 && (
              <div className="mt-4 w-full max-w-2xl px-4">
                <SnapshotTimeline
                  snapshots={snapshots}
                  onCompare={(sourceId, targetId) => {
                    setSourceId(sourceId);
                    chooseTarget(targetId);
                  }}
                  onDelete={deleteSnapshot}
                />
              </div>
            )}
          </div>
        ) : missingSnapshotId ? (
          /* The snapshot a side names is not in the store any more. What stood here was a
             full diff computed against an empty array - the whole database reported as
             removed - which is the loudest thing this panel can say and was not true. It
             says what is actually the matter instead, and offers the only move there is:
             pick something else. */
          <div className="flex-1 flex flex-col items-center justify-center text-fg-subtle gap-2 px-6 text-center">
            <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-warning" />
            <span className="text-xs">{"This snapshot is no longer stored, so there is nothing to compare"}</span>
            <span className="text-xs text-fg-faint">
              {"Only the last 50 snapshots are kept, and another tab may have deleted it. Choose a different one."}
            </span>
          </div>
        ) : showMigration && migrationSQL ? (
          <div className="flex-1 overflow-auto p-4">
            <pre className="text-xs font-mono text-fg-secondary bg-raised border border-hairline-strong rounded-lg p-4 overflow-auto whitespace-pre-wrap">
              {migrationSQL}
            </pre>
          </div>
        ) : diff && diff.hasChanges ? (
          <>
            {/* Table List */}
            <div className="w-64 border-r border-hairline overflow-auto">
              <div className="p-2 border-b border-hairline">
                <div className="text-xs text-fg-muted px-2 mb-1">
                  {diff.summary.added} added, {diff.summary.removed} removed, {diff.summary.modified} modified
                </div>
              </div>
              {diff.tables.map((table) => (
                <button
                  key={table.tableName}
                  onClick={() => setSelectedTable(table.tableName)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-fill transition-colors",
                    selectedTable === table.tableName && "bg-fill-strong",
                  )}
                >
                  {selectedTable === table.tableName ? (
                    <ChevronDown strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                  ) : (
                    <ChevronRight strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                  )}
                  <span className="text-fg-secondary">{table.tableName}</span>
                  <span className="ml-auto">{getActionBadge(table.action)}</span>
                </button>
              ))}
            </div>

            {/* Table Detail */}
            <div className="flex-1 overflow-auto p-4">
              {selectedTable ? (
                <TableDiffDetail diff={diff.tables.find((t) => t.tableName === selectedTable)!} />
              ) : (
                <div className="h-full flex items-center justify-center text-fg-subtle text-xs">
                  {"Select a table to view diff details"}
                </div>
              )}
            </div>
          </>
        ) : diff && !diff.hasChanges ? (
          <div className="flex-1 flex items-center justify-center text-fg-subtle gap-2">
            <span className="text-xs">No differences found between source and target</span>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-fg-subtle gap-2">
            <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5" />
            <span className="text-xs">Cannot compare same schema with itself</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TableDiffDetail({ diff }: { diff: TableDiff }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-tertiary" />
        <h3 className="text-xs font-medium text-fg">{diff.tableName}</h3>
        <Badge
          className={cn(
            "text-xs",
            diff.action === "added" && "bg-hue-green-tint/20 text-hue-green",
            diff.action === "removed" && "bg-hue-red-tint/20 text-hue-red",
            diff.action === "modified" && "bg-hue-yellow-tint/20 text-hue-yellow",
          )}
        >
          {diff.action}
        </Badge>
      </div>

      {/* Columns */}
      {diff.columns.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Columns</h4>
          <div className="space-y-1">
            {/* Keyed by the name the row is ABOUT, not by its position: the diff is
                recomputed whenever either side changes, and the rows come back in a
                different order, which had React reusing one column's row for another's.
                The inner `changes` lists are keyed by their own text — each entry names a
                different attribute ("Type changed:", "Nullable changed:", …), so the text
                is unique within a row and survives a reorder the way the index did not. */}
            {diff.columns.map((col) => (
              <div
                key={col.columnName}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  col.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  col.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                  col.action === "modified" && "bg-hue-yellow-tint/5 border border-hue-yellow-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary min-w-[120px]">{col.columnName}</span>
                {col.action === "modified" && (
                  <div className="flex flex-col gap-0.5">
                    {col.changes.map((change) => (
                      <span key={change} className="text-xs text-fg-muted">
                        {change}
                      </span>
                    ))}
                  </div>
                )}
                {col.action === "added" && <span className="text-xs text-hue-green font-mono">{col.targetType}</span>}
                {col.action === "removed" && <span className="text-xs text-hue-red font-mono">{col.sourceType}</span>}
                <span className="ml-auto">{getActionIcon(col.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indexes */}
      {diff.indexes.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Indexes</h4>
          <div className="space-y-1">
            {diff.indexes.map((idx) => (
              <div
                key={idx.indexName}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  idx.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  idx.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                  idx.action === "modified" && "bg-hue-yellow-tint/5 border border-hue-yellow-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary">{idx.indexName}</span>
                {idx.changes.map((change) => (
                  <span key={change} className="text-xs text-fg-muted">
                    {change}
                  </span>
                ))}
                <span className="ml-auto">{getActionIcon(idx.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {diff.foreignKeys.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Foreign Keys</h4>
          <div className="space-y-1">
            {/* Keyed by the action as well as the column: a foreign key repointed at
                another table is TWO entries under one column name, because the diff
                engine keys an FK by `columnName→table.column` and reports the old one
                removed and the new one added. The column name alone gave React two
                children with the same key. */}
            {diff.foreignKeys.map((fk) => (
              <div
                key={`${fk.action}:${fk.columnName}`}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  fk.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  fk.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary">{fk.columnName}</span>
                {fk.changes.map((change) => (
                  <span key={change} className="text-xs text-fg-muted">
                    {change}
                  </span>
                ))}
                <span className="ml-auto">{getActionIcon(fk.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getActionIcon(action: string) {
  switch (action) {
    case "added":
      return <Plus strokeWidth={1.5} className="w-3 h-3 text-hue-green" />;
    case "removed":
      return <Minus className="w-3 h-3 text-hue-red" />;
    case "modified":
      return <PenLine strokeWidth={1.5} className="w-3 h-3 text-hue-yellow" />;
    default:
      return null;
  }
}
