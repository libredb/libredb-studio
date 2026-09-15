"use client";

import { useState, useCallback, useMemo } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { ObjectSource } from "@/components/object-tree";
import type { ObjectSourceApplier, ObjectSourceReader } from "@/components/object-source";
import { EDIT_PLAN_EXECUTABLE_LIMIT } from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import { useReadGeneration } from "@/hooks/use-read-generation";
import type { WorkspaceConnection, WorkspaceObjectReader } from "@/workspace/types";

/**
 * The largest host answer this shell will read, in UTF-16 code units, and the arithmetic behind
 * every term of it (#789 Phase 3, from discussion #778).
 *
 * WHY THIS EXISTS HERE. The two edit routes bound only what they RECEIVE: `grep -nE "LIMIT|length"`
 * over `src/app/api/db/objects/edit-plan/route.ts` and `.../edit-apply/route.ts` finds exactly three
 * bounds and all three are inbound, the body bytes (`EDIT_BODY_BYTE_LIMIT`), the submitted text
 * (`EDIT_CHARACTER_LIMIT`) and the plan's executable length (`EDIT_PLAN_EXECUTABLE_LIMIT`). Nothing
 * there bounds what they ANSWER: `libraryFact` in `src/lib/db/providers/keyvalue/redis.ts` builds
 * `observed` straight from `FUNCTION LIST`, and a refusal sentence is whatever the engine said. So
 * the hazard is on BOTH shells and only its author differs: there a provider's catalog read, here a
 * plain JavaScript object an adopter constructed.
 *
 * WHAT HAS CHANGED UNDER THIS PARAGRAPH SINCE IT WAS WRITTEN, said here because the round-1 text
 * closed on "the standalone half is filed rather than claimed as covered" and that is no longer the
 * state. `src/lib/api/object-edit-wire.ts` now bounds every string its four shape predicates accept
 * (D80), and `ObjectSourceView` runs those predicates on every build answer on EITHER shell, so the
 * per-string half of the hazard is closed for both. THIS BOUND DOES NOT BECOME REDUNDANT: it
 * measures the WHOLE answer, which no per-string bound can, and it measures it BEFORE any predicate
 * walks the object, so an answer too large to read is refused rather than traversed.
 *
 * What the hazard IS, on either shell. The answer reaches `ApplyPreviewDialog`, and the dialog
 * bounds exactly one of the strings in it, the plan's executable text, which it refuses to draw a
 * diff above. Every other supplied string in a plan or an outcome, `refusal.sentence`,
 * `refusal.hint`, `revision.reason` and each consequence's `fact.observed`, is rendered verbatim
 * into an element with nothing in front of it. Phase 2's `isSourceDocumentShape` bounds its three
 * host-supplied strings with `SOURCE_CHARACTER_LIMIT` for this reason, MEASURED: a part carrying a
 * five-million-character truncation reason passed that predicate before the bound was added, and
 * the whole of it reached a `div`.
 *
 * THE NUMBER, derived from two constants this repository already publishes rather than picked:
 * - `EDIT_PLAN_EXECUTABLE_LIMIT` (1,200,000) is the whole executable text of a plan.
 * - A plan carries that text a second time at most: a step's `provider` segments hold their own
 *   framing text, while its `user` segments are offsets and hold none, so the segments cannot
 *   exceed the step text they describe. Hence the factor of two.
 * - `SOURCE_CHARACTER_LIMIT` (1,000,000) is one part's text as a READ may answer it, which bounds
 *   the build's `preimage.text` and a conflict outcome's `current.text`. Neither answer carries
 *   both, and the sum takes both anyway.
 * So the largest LEGITIMATE answer either method can produce is about 3,400,000 characters and
 * this bound is 4,400,000, which leaves a million characters for identifiers, sentences and keys.
 *
 * What it costs, stated as a cost: a host that answers a well-formed plan above this size has its
 * apply refused, with a sentence, on a shell where nothing else would have stopped it.
 */
const EMBEDDED_ANSWER_CHARACTER_LIMIT = EDIT_PLAN_EXECUTABLE_LIMIT * 2 + SOURCE_CHARACTER_LIMIT * 2;

/** OURS, and it says nothing was sent, because a build refusal happens before any apply. */
const UNREADABLE_BUILD_ANSWER =
  "The host answered the apply preview with more text than LibreDB can read, so nothing was previewed and nothing was sent.";

/**
 * OURS, and it deliberately does NOT say the apply failed. The apply was sent, the host answered,
 * and the answer could not be read, so the only honest sentence is that we cannot say. The pane
 * renders a rejection from `apply` as `interrupted` with `committed: "unknown"`, which is the
 * same fact in the outcome vocabulary.
 */
const UNREADABLE_APPLY_ANSWER =
  "The apply was sent and the host answered with more text than LibreDB can read, so LibreDB cannot say whether this change landed. Re-read this definition before trying again.";

/**
 * The host's answer, COPIED as it is counted, and the copy is what everything downstream reads.
 *
 * A copy rather than a measurement of the host's own object, and that is the whole repair of fix
 * round 1. The round-1 form counted the answer and then handed the ORIGINAL on, which made the
 * bound a claim about how many times a value is read and by whom. Two host answers broke it,
 * both MEASURED inside `tests/components/studio/embedded-source.test.tsx` before this form
 * existed:
 * - REUSE. The walk carried one `seen` set across the whole answer, so every occurrence after the
 *   first cost nothing, while `ApplyPreviewDialog` draws `consequences.map` occurrence by
 *   occurrence. Six consequences that were ONE object holding a one-million-character `observed`
 *   were accepted and all six were drawn: 6,000,456 characters in the DOM against a 4,400,000
 *   bound.
 * - A GETTER. The walk read a property, the shape predicate read it again and the renderer a third
 *   time. An `observed` answering "small" once and two million characters afterwards measured as
 *   five characters and drew 2,000,076. The same trick makes the bytes a reader approves differ
 *   from the bytes a host is later handed, which is this shell's only tie to the sealed-plan rule:
 *   there is no plan token on this path, so the snapshot IS the seal.
 *
 * So each property is read EXACTLY ONCE, into a copy, and the copy is what is returned. The
 * measured characters are the drawn characters by construction.
 *
 * OVER THE SAME KEYS THE SHAPE CHECK READS, which is `Object.getOwnPropertyNames` and not
 * `Object.entries`. `hasExactKeys` in `src/lib/api/object-edit-wire.ts` reads own property NAMES,
 * enumerable or not, so a non-enumerable `observed` is judged, narrowed and rendered while an
 * `Object.entries` walk never sees it at all. That was the third defeat, found while repairing the
 * first two and tested beside them.
 *
 * `seen` holds each source object's copy AND what that copy cost, so a repeated reference is
 * charged again without being walked again, and a CYCLE terminates: a back edge meets an
 * in-progress entry whose recorded cost is still zero, is charged nothing, and takes the copy that
 * is being built, so the copy carries the cycle rather than refusing it.
 *
 * Not `JSON.stringify(value).length`, for three reasons and only the third is about the copy.
 * `stringify` answers `undefined` rather than a string for an undefined input, so the length read
 * would throw, and a host that returns nothing is a shape this seam must survive. It honours
 * `toJSON`, so a host object could answer a short string for itself and pass a bound its real
 * strings do not. And its copy is unbounded: it is complete before its length can be looked at,
 * where this one stops the moment the budget is gone. That last reason is a difference of degree
 * and not of kind, and the round-1 docblock overstated it: this walk allocates a key-name array
 * per object level before the budget can abort inside that level, so a host answer with five
 * million one-character keys allocates a five-million-entry array first. Smaller than a copy of
 * the strings themselves, and bounded by nothing here either.
 *
 * A pathologically DEEP host answer overflows the stack here rather than being counted. That is a
 * RangeError inside the `async` wrapper below, so it becomes a rejected promise and a visible
 * failed build or failed apply, which is the same outcome as an overrun and never a page-level
 * throw.
 */
interface AnswerCopy {
  /** How much budget is LEFT; the walk throws the seam's sentence as soon as it goes negative. */
  left: number;
  readonly sentence: string;
  readonly seen: Map<object, { readonly copy: unknown; cost: number }>;
}

function spend(walk: AnswerCopy, characters: number): void {
  walk.left -= characters;
  if (walk.left < 0) throw new Error(walk.sentence);
}

function copyWithin(value: unknown, walk: AnswerCopy): unknown {
  if (typeof value === "string") {
    spend(walk, value.length);
    return value;
  }
  // Numbers, booleans, null, undefined and a function all cost nothing and are carried through as
  // they are. Nothing renders them by length, and the shape predicates refuse the ones that are
  // not what a field declares.
  if (typeof value !== "object" || value === null) return value;

  const already = walk.seen.get(value);
  if (already !== undefined) {
    spend(walk, already.cost);
    return already.copy;
  }

  const before = walk.left;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    const entry = { copy, cost: 0 };
    walk.seen.set(value, entry);
    for (const item of value) copy.push(copyWithin(item, walk));
    entry.cost = before - walk.left;
    return copy;
  }

  const copy: Record<string, unknown> = {};
  const entry = { copy, cost: 0 };
  walk.seen.set(value, entry);
  for (const key of Object.getOwnPropertyNames(value)) {
    spend(walk, key.length);
    // ONE read of the property, which is what makes a getter's second answer unreachable.
    const held = copyWithin((value as Record<string, unknown>)[key], walk);
    // `defineProperty` and not an assignment, because `copy["__proto__"] = x` sets the prototype
    // instead of adding a key, and a host answer names its own keys.
    Object.defineProperty(copy, key, { value: held, enumerable: true, writable: true, configurable: true });
  }
  entry.cost = before - walk.left;
  return copy;
}

/**
 * The snapshot of the host's answer, or a THROW carrying `sentence`, which both seams turn into a
 * visible failure.
 *
 * WHAT THE HOST GETS BACK, said out loud because it is a constraint on an adopter: the plan handed
 * to `objectEditor.apply` is this snapshot of the plan the reader approved, not the object the
 * host built. A host must therefore bind its own preview to its own apply through a VALUE the plan
 * carries, `planId`, rather than through object identity: a `WeakMap` keyed on the plan it
 * returned will not find this one. That is the cost of the bytes drawn being the bytes sent.
 */
function withinAnswerBound(answer: unknown, sentence: string): unknown {
  return copyWithin(answer, { left: EMBEDDED_ANSWER_CHARACTER_LIMIT, sentence, seen: new Map() });
}

interface UseConnectionAdapterParams {
  connections: WorkspaceConnection[];
  onSchemaFetch: (connectionId: string) => Promise<readonly DetailedObject[]>;
  onObjectsFetch: WorkspaceObjectReader;
}

export function useConnectionAdapter({
  connections: externalConnections,
  onSchemaFetch,
  onObjectsFetch,
}: UseConnectionAdapterParams) {
  const connections: DatabaseConnection[] = useMemo(
    () =>
      externalConnections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: new Date(),
        managed: true,
        // A hand-written field list, so a host field this forgets is dropped in silence.
        // Forgetting this one reads the catalog the host asked it not to (#765).
        skipObjectScan: c.skipObjectScan,
      })),
    [externalConnections],
  );

  // The selection is held by ID, not by object, so it resolves against the host's
  // CURRENT list during render instead of being repaired by an effect one render
  // later. Holding the object also meant a host that renamed a connection in place
  // kept being served the captured one — the "still in the list?" test matched on
  // id, so nothing re-synced.
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [schema, setSchema] = useState<readonly DetailedObject[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  /** The connection whose deferred catalog read the user has explicitly asked for, by id. */
  const [scanRequested, setScanRequested] = useState<string | null>(null);

  // Resolution is by id ONLY — no positional tail. An embedded shell still shows
  // the host's first connection when nothing has been chosen yet, but that fallback
  // is resolved once and then HELD as the id below, because re-resolving it
  // positionally on every render let the host move the selection: prepend or
  // reorder the list and the editor silently points at a database nobody picked,
  // with a schema re-fetch behind it (StudioWorkspace keys that fetch on
  // `activeConnection?.id`).
  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );

  // React's documented adjust-state-while-rendering guard (react.dev, "You Might
  // Not Need an Effect" — adjusting some state when a prop changes). It commits
  // the fallback for both ways the id can fail to resolve: nothing chosen yet, and
  // the chosen connection dropped by the host. It terminates — the id it commits
  // comes from the very list it just failed against, so the next pass resolves —
  // and an empty list falls straight through, leaving `activeConnection` null.
  if (!activeConnection && connections.length > 0) {
    setActiveConnectionId(connections[0].id);
  }

  const setActiveConnection = useCallback((conn: DatabaseConnection | null) => {
    setActiveConnectionId(conn?.id ?? null);
  }, []);

  /**
   * Which catalog read is the CURRENT one (#789).
   *
   * `onSchemaFetch` is the HOST's callback, so its latency is not this hook's to bound: a read
   * for connection A can settle after the reader has moved to B, and every write below asks
   * first. The rule is stated once in `useReadGeneration` and used by both shells rather than
   * written twice, which is how the standalone hook came to have it and this one not.
   */
  const reads = useReadGeneration();

  const readSchema = useCallback(
    async (conn: DatabaseConnection) => {
      const isCurrent = reads.begin();
      setIsLoadingSchema(true);
      try {
        const result = await onSchemaFetch(conn.id);
        if (isCurrent()) setSchema(result);
      } catch {
        // A read the reader has moved on from reports nothing at all: clearing the list here
        // would blame the CURRENT connection for a read that was never issued against it.
        if (isCurrent()) setSchema([]);
      } finally {
        // Only the current read owns the flag; a superseded one clearing it would report the
        // newer read as finished while it is still in flight.
        if (isCurrent()) setIsLoadingSchema(false);
      }
    },
    [onSchemaFetch, reads],
  );

  /**
   * Whether THIS connection's catalog reads are deferred right now (#765).
   *
   * The same rule as `src/hooks/use-connection-manager.ts`, written again rather than
   * shared, because these two hooks share no state and no request layer: one reads the
   * studio's own routes and the other calls back into the host. What is shared is the
   * FIELD, and the reader's request is held here too as the connection's id rather than as
   * a boolean, so the next deferred connection is not already loaded.
   */
  const scanDeferred = useCallback(
    (conn: DatabaseConnection) => conn.skipObjectScan === true && scanRequested !== conn.id,
    [scanRequested],
  );

  const fetchSchema = useCallback(
    async (conn: DatabaseConnection) => {
      if (scanDeferred(conn)) {
        // This supersedes any read in flight, exactly as a read does: the reader has moved to a
        // connection that reads NOTHING, so an answer still on its way for the previous one must
        // not land under this connection's name.
        reads.supersede();
        // Nothing was read for THIS connection, so the previous one's tables may not stay
        // on screen under its name (D31). `readSchema` is the only other writer.
        setSchema([]);
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

  /** Read what opening this connection would have read, because the user asked. */
  const loadObjects = useCallback(() => {
    if (activeConnection === null) return;
    setScanRequested(activeConnection.id);
    void readSchema(activeConnection);
  }, [activeConnection, readSchema]);

  /**
   * What the object tree reads through, in this shell (#789, B76).
   *
   * The tree's own default posts to `/api/db/objects/*`, and this package ships no such route:
   * that path belongs to whatever server the host mounted the workspace in, and the connection
   * built above carries no host, port or file path for it to open anyway. So each read is
   * translated into the host's own call, one lazy read at a time.
   *
   * The connection arrives as an ARGUMENT rather than through the closure, which is what keeps
   * this value stable across renders: the tree re-issues its reads whenever its source changes
   * identity, so a source rebuilt per render would read for ever.
   */
  const objectSource = useMemo<ObjectSource>(
    () => (conn, request) => {
      switch (request.route) {
        case "containers":
          return onObjectsFetch.listContainers(conn.id, request.parent);
        case "counts":
          return onObjectsFetch.countObjects(conn.id, request.container);
        case "list":
          return onObjectsFetch.listObjects(conn.id, request.container, request.kind);
      }
    },
    [onObjectsFetch],
  );

  /**
   * The source read's own seam, which is not a tree read (#789 Phase 2).
   *
   * Beside `objectSource` and deliberately not a fourth arm inside it. That switch is
   * exhaustive with no `default`, so a fourth arm would have to produce a value for a host that
   * declared no `readObjectSource`, which is a state the seam does not reach at all: this value
   * is `undefined` in exactly that case, and an absent reader is what removes the affordance.
   * The tree's request union is also the tree CACHE's vocabulary, and a definition is not a
   * cached listing.
   *
   * `undefined` when the host declared nothing, which is the B76 answer rather than an errored
   * read: no reader, so no `onViewSource`, so no menu item, so no tab, so nothing to fail.
   *
   * `useMemo` for the same reason `objectSource` is one: the viewer's read effect lists its
   * reader among its dependencies, so a value rebuilt on every render would re-run it, and the
   * connection arrives as an ARGUMENT rather than through this closure so the identity does not
   * move when the selection does.
   *
   * `async` IS LOAD-BEARING and it is the whole host-trust guard on this seam. A host is
   * ordinary JavaScript, so the declared `Promise<ObjectSourceDocument>` is not a runtime
   * guarantee, and the viewer's read effect does `reader(...).then(...)` with no `try`. Measured
   * on the plain-arrow form: a host that threw before returning gave an uncaught `Error` out of
   * `commitHookEffectListMount`, and a host that returned `undefined` gave
   * `TypeError: undefined is not an object (evaluating '...then')` at the same place. Both are
   * render-phase throws, so they take the adopter's whole page down rather than one tab. The
   * `async` wrapper turns the first into a rejection the viewer's error arm already renders with
   * the host's own sentence, and the second into a resolved non-document the viewer's shape
   * check already refuses. Two tests in
   * `tests/components/studio/embedded-source.test.tsx` drive exactly these two shapes.
   */
  const sourceReader = useMemo<ObjectSourceReader | undefined>(() => {
    const read = onObjectsFetch.readObjectSource;
    if (read === undefined) return undefined;
    return async (conn, path, kind) => read(conn.id, path, kind);
  }, [onObjectsFetch]);

  /**
   * The APPLY seam, built beside `sourceReader` and for all of its reasons (#789 Phase 3).
   *
   * `undefined` when the host declared no `objectEditor`, which is what withholds `onApply` from
   * the pane, which is what leaves an existing adopter's Source tab exactly as Phase 2 shipped it:
   * no bar, no sentence, no draft. The absent-affordance rule the read seam states, applied to a
   * seam that WRITES, where it matters more.
   *
   * BOUND, on both methods, and that is not a style choice. `const { build } = host.objectEditor`
   * followed by `build(...)` calls with no receiver, so an adopter whose `build` reaches
   * `this.clients[id]` gets a TypeError instead of a plan. The read seam's docblock above records
   * the same fault for a provider, and this is the same fault on the other direction of travel.
   *
   * `async` IS LOAD-BEARING, exactly as it is on `sourceReader`, and the measurement behind it is
   * the read seam's: a host that threw before returning gave an uncaught `Error` and a host that
   * returned `undefined` gave `TypeError: undefined is not an object (evaluating '...then')`.
   * `ObjectSourceView` calls both of these methods with `.then(onValue, onError)` and no `try`, so
   * without the wrapper the first is a throw inside a click handler and the second is a TypeError
   * at the same place. With it, the first is a rejection the pane reports as a failed build or a
   * failed apply, and the second is a resolved non-answer the pane's own shape narrowing refuses.
   *
   * WHAT THIS SEAM DOES NOT DO is narrow the host's answer to `ObjectEditBuild` or
   * `ObjectEditOutcome`. `ObjectSourceApplier` returns `unknown` on both methods and
   * `ObjectSourceView` narrows with `isObjectEditBuildResponseShape` and
   * `isObjectEditOutcomeShape` before it draws anything, so a second copy of those predicates here
   * would be a second implementation of one boundary, on one of the two shells. The size bound
   * above is here because this is the file that could carry it, and NOT because the standalone
   * path is covered: measured, its two routes bound only what they receive. That measurement and
   * the filing that follows from it are in the bound's own docblock.
   */
  const sourceApplier = useMemo<ObjectSourceApplier | undefined>(() => {
    const editor = onObjectsFetch.objectEditor;
    if (editor === undefined) return undefined;
    return {
      async build(connection, request) {
        return withinAnswerBound(await editor.build(connection.id, request), UNREADABLE_BUILD_ANSWER);
      },
      async apply(connection, plan, _planToken, acknowledged) {
        return withinAnswerBound(await editor.apply(connection.id, plan, acknowledged), UNREADABLE_APPLY_ANSWER);
      },
    };
  }, [onObjectsFetch]);

  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // The embedded shell's stand-in for `useProviderMetadata`: it has no
  // `/api/db/provider-meta` of its own and holds no credentials to describe, so
  // the host declares each connection's capabilities and wording alongside it
  // (#427). Absent stays `null` — the same value this hook returned before the
  // fields existed, which every consumer already reads as "provider unknown".
  const metadata = useMemo<ProviderMetadata | null>(() => {
    const declared = externalConnections.find((c) => c.id === activeConnection?.id);
    if (!declared?.capabilities) return null;
    // `labels` is optional for the host on purpose: every consumer reads it
    // through `?.` and falls back to its own base wording, so a host that only
    // knows the capabilities does not have to restate fifteen strings. It is
    // optional on `ProviderMetadata` too, so this passes it through as-is rather
    // than casting `undefined` into a field declared required.
    return { capabilities: declared.capabilities, labels: declared.labels };
  }, [externalConnections, activeConnection]);

  return {
    metadata,
    connections,
    setConnections: (() => {}) as React.Dispatch<React.SetStateAction<DatabaseConnection[]>>,
    activeConnection,
    setActiveConnection,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse: null as "healthy" | "degraded" | "error" | null,
    fetchSchema,
    /** Whether the active connection is holding its catalog reads back. */
    objectScanDeferred: activeConnection !== null && scanDeferred(activeConnection),
    loadObjects,
    objectSource,
    /** The host's own source read, or `undefined` where it declared none. */
    sourceReader,
    /** The host's own object editor, or `undefined` where it declared none. */
    sourceApplier,
    schemaContext,
  };
}
