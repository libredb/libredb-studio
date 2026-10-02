"use client";

/**
 * The sampled walk a keys panel is driven by.
 *
 * THE CURSOR LIVES HERE AND NOWHERE ELSE. `SCAN` is stateless on the server — a cursor is a
 * position in a hash table rather than a handle — so there is nothing to hold open and nothing to
 * release: the hook keeps the position between pages, hands it back on the next request, and a
 * reload simply starts again at `"0"`. That is why a page costs a round trip instead of owning a
 * session, and why `Stop` can be an ordinary flag rather than a cancellation protocol.
 *
 * THE SAMPLE IS THE POINT, NOT A SHORTCOMING OF THIS CODE. A walk stopped at a batch holds some of
 * the keys, and `scanned` counts what the walk has been HANDED rather than what it uniquely found:
 * a key returned twice while the table rehashes was still walked twice, and a progress indicator
 * that quietly deduplicated would drift below the denominator it is measured against. The tree, by
 * contrast, merges duplicates, because two rows for one key would be a lie about the keyspace.
 *
 * `Scan all` IS BOUNDED, and the bound is declared rather than discovered. Redis's `SCAN` is O(N)
 * over the whole keyspace, so an unbounded "all" against a key space of millions is a request that
 * never returns and a server that is busy while it does not. The cap is a number this client chose,
 * in keys, and the panel says so in its own words when a walk stops on it — a cap nobody can see is
 * the defect that sentence exists to prevent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { keyScanShape, type KeyScanCapability, type KeyScanOptions, type KeyScanPage } from "@/lib/db/types";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";
import { isUnderPrefix, pathKey, pathPattern } from "./tree";

/**
 * How many keys one `Scan all` may walk before it stops and says it did.
 *
 * Ten thousand is a client-side budget and not an engine limit: at the default batch of 500 it is
 * twenty round trips, which is a gesture a person will wait for and a load a server will answer. A
 * key space larger than this is one where the right answer is "narrow the pattern".
 *
 * A key a page LEFT OUT counts as one it named (spec 4.6): the server read it and it took its room on
 * the page, so a walk of keys that are not UTF-8 text spends this budget as a walk of named keys does.
 * Counted by names alone, such a prefix would be read whole by a gesture that says it stops here.
 */
export const SCAN_ALL_MAX_KEYS = 10_000;

/**
 * How many keys the tree may HOLD, across every page of the walk and every press of Load more.
 *
 * `SCAN_ALL_MAX_KEYS` bounds ONE GESTURE, and that is a different question: a reader can press Scan
 * more a hundred times, or press Load more down a hundred prefixes, and each press is bounded while
 * the tree they all feed is not. The tree is not virtualised away from memory — the rows are windowed
 * in the DOM, but the keys are a real array a filter walks on every keystroke — so an unbounded total
 * is a panel that gets slower the longer it is used, with no way for the reader to see where it is
 * spending itself.
 *
 * The same number as the gesture cap is deliberate rather than a coincidence: it is one budget for
 * "how much of a key space this panel will hold", stated once, and the two sentences the panel says
 * are worded so a reader can tell which bound they just met.
 */
export const HELD_KEY_LIMIT = 10_000;

/** The batch size to ask for, kept inside what the provider declared it will accept. */
function batchSize(capability: KeyScanCapability): number {
  return Math.min(capability.defaultCount, capability.maxCount);
}

export interface KeyScanResult {
  /** Distinct keys the walk has seen, in the order it saw them. */
  readonly keys: readonly string[];
  /** Keys the walk has been handed, repeats included. */
  readonly scanned: number;
  /**
   * The page's `total`, in the scope the declaration's `totalScope` names, or null before the first
   * page answers: the server's own key count for the database under `"database"` (Redis), and the exact
   * count of the keys this walk covers at its pinned revision under `"walk"` (etcd, spec 4.6).
   */
  readonly total: number | null;
  /**
   * Whether the answers describe ONE NODE of a clustered deployment.
   *
   * `SCAN` and `DBSIZE` are per node and neither has a cluster-wide form, so on a cluster every count
   * on this panel is one node's and nothing else. `undefined` is a server that did not say either way,
   * which is what a refused `INFO cluster` leaves behind: a panel that called a node's count "every
   * key this database holds" is the defect this exists to prevent.
   */
  readonly clustered: boolean | undefined;
  /**
   * Each key's value type, by key name, as last answered by the server.
   *
   * A KEY ABSENT FROM THIS MAP IS ONE NO PAGE HAS DESCRIBED, and a row draws nothing for it rather
   * than guessing — see `KeyScanPage.types`. Types arrive WITH their page, so a row is never drawn
   * beside a type that is still on its way.
   */
  readonly types: ReadonlyMap<string, string>;
  /**
   * The keys the walk's pages left out, added up across the global walk's pages, or null while none
   * was (spec 4.6).
   *
   * A page leaves out a key it cannot give a name: on etcd, one that is not UTF-8 text, because a name
   * decoded with replacement characters would address a different key. The reason is the provider's,
   * from the latest page that left one out. A prefix's Load more adds nothing here, for the reason it
   * adds nothing to `scanned`: its pages overlap the global walk's.
   */
  readonly skipped: { readonly count: number; readonly reason: string } | null;
  /** True while one page is in flight. */
  readonly busy: boolean;
  /** True while a `Scan all` is running, so the panel can offer `Stop` rather than a second press. */
  readonly scanningAll: boolean;
  /** True once a walk reached cursor `"0"`, which is the only signal the server gives. */
  readonly exhausted: boolean;
  /** What ended a `Scan all` before the walk was spent, when something did. */
  readonly stoppedBy: string | null;
  /** The sentence a failed page answered with, in the route's own words where it gave one. */
  readonly error: string | null;
  /**
   * Where each PREFIX's own walk stands, by `pathKey`.
   *
   * Absent means that prefix has never been scoped, which is not the same as "no more": the whole
   * point of a scoped walk is that the global sample cannot answer the question. `"0"` means the
   * scoped walk reached the end of that prefix and there is provably nothing more under it.
   */
  readonly nodeCursors: ReadonlyMap<string, string>;
  /** Prefixes whose scoped page is in flight, so a row can say so instead of taking a second press. */
  readonly nodeLoading: ReadonlySet<string>;
  /**
   * How many NEW keys the last scoped page added, by `pathKey`.
   *
   * THE ONE NUMBER THAT TELLS A READER THEIR PRESS DID SOMETHING. A scoped page is filtered by the
   * server and then deduplicated here, so it can come back holding nothing this tree did not already
   * have — a true answer that looks exactly like a dead button. `0` is recorded rather than left
   * absent for that reason: absent means "never pressed", and the two must not read alike.
   */
  readonly nodeAdded: ReadonlyMap<string, number>;
}

export interface KeyScanControls {
  /**
   * Take one more batch from wherever the walk stands. Resolves false when it asked for none: the
   * tree is full, the walk is spent, or a page of this walk is already in flight.
   */
  readonly scanMore: () => Promise<boolean>;
  /**
   * Page until the walk is spent, the cap is reached, the tree is full, someone presses Stop, or a
   * page fails.
   */
  readonly scanAll: () => Promise<void>;
  /**
   * Take one more batch of the walk scoped to ONE PREFIX, for the row under an open folder.
   *
   * The keys it brings back join the tree and NOT the walk's own progress: `scanned` counts what the
   * GLOBAL walk has been handed, and a scoped page hands back keys the global walk may already have
   * counted. Adding them would push the progress line above its own denominator.
   */
  readonly loadMoreUnder: (path: readonly string[]) => Promise<void>;
  /** Ask a running `Scan all` to stop after the page in flight. */
  readonly stop: () => void;
  /** Throw the walk away and start again at cursor `"0"`. */
  readonly reset: () => void;
}

export function useKeyScan(options: {
  readonly connection: DatabaseConnection;
  readonly capability: KeyScanCapability;
  /**
   * The walk's pattern as the route takes it, or `""` for every key: a `MATCH` glob under a `glob`
   * declaration, and the literal prefix every walked key begins with under a `prefix` one.
   */
  readonly pattern: string;
  /**
   * Which numbered database to walk, for an engine that has more than one.
   *
   * ABSENT IS NOT ZERO, and the difference is the whole point of the field being optional. Absent
   * leaves the choice to the engine, which answers with the database the SESSION is already in;
   * `0` is a specific database that a connection is not necessarily sitting in. A caller that
   * defaulted this to `0` would move the walk off the session's database the moment somebody
   * declared a level to choose from.
   */
  readonly database?: number;
}): KeyScanResult & KeyScanControls {
  const { connection, capability, pattern, database } = options;
  /**
   * The walk's shape, read once through the one helper (spec 3.4): the separator a Load more joins its
   * prefix with, the pattern it builds, and the word the Scan all sentence uses.
   */
  const shape = useMemo(() => keyScanShape(capability), [capability]);

  const [keys, setKeys] = useState<readonly string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [clustered, setClustered] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [scanningAll, setScanningAll] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [stoppedBy, setStoppedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeCursors, setNodeCursors] = useState<ReadonlyMap<string, string>>(new Map());
  const [nodeLoading, setNodeLoading] = useState<ReadonlySet<string>>(new Set());
  const [nodeAdded, setNodeAdded] = useState<ReadonlyMap<string, number>>(new Map());
  const [types, setTypes] = useState<ReadonlyMap<string, string>>(new Map());
  const [skipped, setSkipped] = useState<{ readonly count: number; readonly reason: string } | null>(null);

  /*
   * Refs, not state, and the reason is the loop rather than performance. `scanAll` takes several
   * pages inside ONE commit, so every value it reads to decide whether to keep going — the cursor,
   * the count, whether the walk is spent, whether a page failed — has to be one the page it just
   * took can update before the next decision. Read from state and the loop decides on the values
   * the last RENDER saw, which is the state before its own first request.
   */
  const cursor = useRef("0");
  /*
   * WHICH WALK EVERY ANSWER BELONGS TO.
   *
   * `walk` counts the walks this hook has started and `pageInFlight` names the one whose page is in
   * the air, and the pair answers two questions one boolean used to get wrong.
   *
   * IS A PAGE IN THE AIR FOR THE WALK I AM ABOUT TO TAKE? `scanMore` refuses only when the page in
   * flight belongs to the CURRENT walk, because two pages of one walk would both read the same
   * cursor and both advance from it. A page from a walk somebody threw away is not in this one's
   * way: it is about to be dropped on landing, and refusing to start would leave a freshly reset
   * panel waiting for an answer it has already decided not to use.
   *
   * IS THIS ANSWER STILL MINE? A page lands after its walk was discarded and must not write
   * anything — not the cursor, not the keys, not the progress, not a failure. This is what makes
   * changing the pattern or the database mid-walk a clean restart rather than a sample mixed from
   * two walks, which is the state the panel is least able to explain.
   */
  const walk = useRef(0);
  const pageInFlight = useRef<number | null>(null);
  const stopped = useRef(false);
  const spent = useRef(false);
  const scannedKeys = useRef(0);
  // The pages' skipped keys, added up in a ref for the reason `scannedKeys` is: `scanAll` takes
  // several pages inside one commit, and each must add to what the last one wrote.
  const skippedKeys = useRef<{ readonly count: number; readonly reason: string } | null>(null);
  const failure = useRef<string | null>(null);
  const alive = useRef(true);
  /*
   * The keys the tree has already been handed.
   *
   * Two pages can name the same key — a `SCAN` may return it twice, and a scoped page certainly
   * overlaps the global walk — and a tree cannot draw one key twice. Deduplicating HERE rather than
   * leaving it to `buildKeyTree` is what keeps the accumulated list bounded: without it, every scoped
   * page would append its whole batch again, and a reader pressing Load more down a deep prefix would
   * grow the array until the search that feeds the tree was the slowest thing on screen.
   */
  const walked = useRef(new Set<string>());
  /*
   * Each prefix's own walk, keyed by `pathKey`. In a ref because the read has to see what the last
   * scoped page wrote, exactly as the global cursor does, and mirrored into state below because a row
   * has to RENDER the difference between "never asked" and "asked and there is no more".
   */
  const nodeCursor = useRef(new Map<string, string>());
  const nodeInFlight = useRef(new Set<string>());
  /*
   * The types the server has answered with, accumulated across pages. In a ref beside its mirror for
   * the same reason the cursors are: a page records what it learned before the next decision, and a
   * row has to render it.
   */
  const knownTypes = useRef(new Map<string, string>());

  useEffect(() => {
    // Set on the way IN as well as cleared on the way out: React runs an effect twice on one mount
    // in development, and a cleanup that only ever wrote `false` would leave the second mount
    // permanently ignoring its own answers.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * One page, from a cursor and a pattern the CALLER names.
   *
   * Parameterised rather than reading this hook's own cursor and pattern, because there are two
   * walks now: the global one this hook drives, and one per prefix that a reader asks for by pressing
   * Load more. They differ in exactly these two arguments and in nothing else.
   */
  const readPageAt = useCallback(
    async (at: string, match: string, count: number): Promise<KeyScanPage> => {
      const payload = buildConnectionPayload(connection);
      const request: KeyScanOptions = {
        cursor: at,
        count,
        ...(match === "" ? {} : { pattern: match }),
        // Absent rather than `undefined`: the field is omitted from the body entirely, and the route
        // reads an absent `database` as "the session's", which is exactly what a panel with no
        // database chosen means.
        ...(database === undefined ? {} : { database }),
      };
      const response = await appFetch("/api/db/keys/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ...request }),
      });

      // A route that answered with no body still answered something worth showing, so the status
      // stands in for the sentence rather than the read being reported as a parse error.
      const body = (await response.json().catch(() => ({}))) as Partial<KeyScanPage> & { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `The key walk failed with HTTP ${response.status}`);
      }
      return {
        keys: body.keys ?? [],
        cursor: body.cursor ?? "0",
        total: body.total ?? 0,
        types: body.types ?? {},
        // Absent stays absent: a provider that could not read `INFO cluster` says nothing about the
        // deployment's shape, and a panel that drew "clustered: false" there would be claiming a
        // plain server from a refusal.
        clustered: body.clustered,
        // Passed through as it came: `scanMore` adds it up and `loadMoreUnder` leaves it alone (spec 4.6).
        skipped: body.skipped,
      };
    },
    [connection, database],
  );

  /**
   * The names in a page the tree does not hold yet, and the record that it now does.
   *
   * One function because two callers need the same two steps in the same order, and a caller that
   * read `walked` before the other had written it would append a batch twice.
   */
  const absorb = useCallback((names: readonly string[]): string[] => {
    const fresh: string[] = [];
    for (const name of names) {
      // A repeat is skipped before the limit is even consulted: a key already held is not a key that
      // the limit is being asked about, and a page of nothing but repeats must not be read as "the
      // tree is full" when it is merely "you have seen these".
      if (walked.current.has(name)) continue;
      if (walked.current.size >= HELD_KEY_LIMIT) break;
      walked.current.add(name);
      fresh.push(name);
    }
    return fresh;
  }, []);

  /**
   * Record what a page said about its keys' types.
   *
   * ONE WRITE PER PAGE, and the mirror is REPLACED rather than mutated, because React compares the
   * reference: a map mutated in place would render as unchanged and the type would never appear.
   */
  const absorbTypes = useCallback((page: KeyScanPage): void => {
    const entries = Object.entries(page.types);
    if (entries.length === 0) return;
    for (const [name, type] of entries) knownTypes.current.set(name, type);
    setTypes(new Map(knownTypes.current));
  }, []);

  const scanMore = useCallback(async (): Promise<boolean> => {
    // One page at a time PER WALK. Two in flight for the same walk would both read the same cursor
    // and both advance from it, so the second answer would overwrite the position the first one
    // earned and the walk would skip whatever lay between them. A spent walk is refused for the same
    // reason it is spent. A page belonging to an ABANDONED walk is not in this one's way — see `walk`.
    const mine = walk.current;
    // A tree that is FULL cannot be given anything, so this walk would buy a page to drop it: the
    // panel's own sentence is what the reader should be reading instead of a request in flight.
    if (walked.current.size >= HELD_KEY_LIMIT) return false;
    if (spent.current || pageInFlight.current === mine) return false;
    pageInFlight.current = mine;
    setBusy(true);

    try {
      const page = await readPageAt(cursor.current, pattern, batchSize(capability));
      // The walk this page belongs to may have been thrown away while it was in the air, and a
      // discarded walk's answer is not an answer to the current one: it would land keys from a
      // database or a pattern nobody is looking at any more, beside a cursor from that walk.
      if (!alive.current || mine !== walk.current) return true;
      cursor.current = page.cursor;
      scannedKeys.current += page.keys.length;
      failure.current = null;
      /*
       * What the page LEFT OUT, added up across the global walk's pages (spec 4.6). A page that left
       * nothing out, with no `skipped` or with a count of 0, changes nothing, so the panel draws no
       * line for it.
       */
      if (page.skipped !== undefined && page.skipped.count > 0) {
        skippedKeys.current = {
          count: (skippedKeys.current?.count ?? 0) + page.skipped.count,
          reason: page.skipped.reason,
        };
        setSkipped(skippedKeys.current);
      }
      const fresh = absorb(page.keys);
      absorbTypes(page);
      setKeys((previous) => (fresh.length === 0 ? previous : [...previous, ...fresh]));
      setScanned(scannedKeys.current);
      setTotal(page.total);
      setClustered(page.clustered);
      setError(null);
      // Cursor `"0"` is the only end-of-walk signal Redis publishes, so it is the only one this
      // can set: there is no total to compare against that a concurrent write would not move.
      if (page.cursor === "0") {
        spent.current = true;
        setExhausted(true);
      }
    } catch (thrown) {
      // A failure from an abandoned walk is dropped for the reason its answer would be: it describes
      // a read the panel has already replaced, and reporting it would put a sentence about the old
      // walk on the new one.
      if (!alive.current || mine !== walk.current) return true;
      // The cursor is deliberately NOT advanced on a failure. The position already held is the
      // last one the server acknowledged, so retrying re-asks the batch that failed rather than
      // skipping it.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      failure.current = message;
      setError(message);
    } finally {
      // Only the walk that owns the slot may free it, and only the walk still current may say the
      // panel is idle: an abandoned page landing after its successor started would otherwise clear
      // the spinner the successor is showing.
      if (pageInFlight.current === mine) pageInFlight.current = null;
      if (alive.current && mine === walk.current) setBusy(false);
    }
    return true;
  }, [absorb, absorbTypes, capability, pattern, readPageAt]);

  const scanAll = useCallback(async (): Promise<void> => {
    // A page in flight for the CURRENT walk is one this loop is already waiting on, so a second press
    // is refused. An abandoned walk's page is not: `reset` stopped that loop by flag, and this one is
    // starting a walk of its own.
    if (pageInFlight.current === walk.current) return;
    stopped.current = false;
    setScanningAll(true);
    setStoppedBy(null);

    /*
     * ONE EXIT, AND NO `try`/`finally` AROUND THE LOOP.
     *
     * The obvious shape is a `finally` that clears `scanningAll`, and it was written that way first.
     * It is not needed — `scanMore` catches its own failures, so nothing escapes the loop — and it
     * costs a false positive: `react/memo-dependencies` cannot see a reference inside a `try` that
     * has a `finally`, so it reported `scanMore` as an extra dependency of a callback that calls it
     * on the line above. A comment asking the linter to look again is the alternative, and this is
     * better: the reason the walk ended is computed as a value and applied once, which is also what
     * makes "stopped" and "hit the cap" ordered rather than racing in a `finally`.
     */
    let reason: string | null = null;
    while (!stopped.current && !spent.current && failure.current === null) {
      // oxlint-disable-next-line no-await-in-loop -- each page starts at the cursor the last one wrote.
      const asked = await scanMore();
      /*
       * A REFUSAL ENDS THE LOOP. Asked again, `scanMore` would refuse again, and awaiting a promise
       * that has already resolved never yields to the event loop: no page, no render and no Stop
       * press would run, and the tab would freeze. The refusal the panel's Scan all meets is the FULL
       * TREE. A Load more fills the tree with keys the walk does not count, so the tree can reach
       * `HELD_KEY_LIMIT` while the walk is short of its cap and its cursor is live. The limit's
       * sentence is the panel's, drawn from the tree's size, so this exit adds none of its own.
       */
      if (!asked) break;
      // The keys the walk was handed and the keys its pages left out: see `SCAN_ALL_MAX_KEYS`.
      const walkedKeys = scannedKeys.current + (skippedKeys.current?.count ?? 0);
      if (walkedKeys >= SCAN_ALL_MAX_KEYS && !spent.current) {
        const limit = SCAN_ALL_MAX_KEYS.toLocaleString("en-US");
        // The word for what narrows a walk follows the declaration: a prefix, or a `MATCH` pattern.
        const narrow = shape.pattern === "prefix" ? "prefix" : "pattern";
        reason = `Stopped after ${limit} keys. Narrow the ${narrow} to walk a smaller key space.`;
        break;
      }
    }

    if (!alive.current) return;
    setScanningAll(false);
    if (reason !== null) setStoppedBy(reason);
    // Applied after the cap's sentence rather than instead of it, so a Stop pressed in the same turn
    // is what a reader sees: the two are ordered, not merged.
    if (stopped.current) setStoppedBy("Stopped.");
  }, [scanMore, shape]);

  /**
   * One page of a walk scoped to ONE PREFIX, for the Load more row under an open folder.
   *
   * WHY THIS EXISTS AT ALL. The global walk is a SAMPLE of the keyspace, so a prefix's contents in the
   * tree are whatever that sample happened to include — and a deep prefix can be entirely absent from
   * a thousand keys of a million. A scoped walk asks the server about that prefix directly, which is
   * the only way to answer "is there more under here" truthfully. It is also why, under a `glob`
   * declaration, the answer is not free: `MATCH` is applied per batch server-side and is not indexed,
   * so this costs the server a full pass over the keyspace, exactly as the global walk's every page
   * does. Under a `prefix` declaration the server reads the prefix's own byte range, a page at a time
   * (spec 4.6).
   *
   * IT RUNS ONE WALK PER PREFIX AND KEEPS ITS CURSOR, so pressing Load more twice continues that
   * prefix rather than restarting it. `nodeCursor` is the authority and the state below is its mirror
   * for rendering, for the same reason the global cursor is a ref: the decision has to read what the
   * last page wrote.
   *
   * IT DOES NOT TOUCH THE WALK'S PROGRESS. `scanned` and `total` are the global walk's, and a scoped
   * page hands back keys the global walk may already have counted — adding them would push the
   * progress line past its own denominator. It also does not set the loop's failure flag: a prefix
   * that refuses is not a reason to end the walk somebody started at the database level.
   *
   * THE ANSWER IS FILTERED, because `MATCH` is a glob with no escape and a real key segment can
   * contain `*` or `[`, and a prefix walk's answer is held to the prefix's segments the same way. See
   * `isUnderPrefix`.
   */
  const loadMoreUnder = useCallback(
    async (path: readonly string[]): Promise<void> => {
      const key = pathKey(path);

      // The tree is full: a scoped page would be filtered, deduplicated against a tree that already
      // holds its keys, and dropped — so the row is not offered and a press that somehow arrives
      // spends nothing.
      if (walked.current.size >= HELD_KEY_LIMIT) return;

      // One page per prefix at a time, for the reason `scanMore` gives about the global walk: two in
      // flight would both read this prefix's cursor and both advance from it.
      if (nodeInFlight.current.has(key)) return;
      // Which walk this prefix's page belongs to. A scoped page is dropped when the walk it was asked
      // for has been thrown away, exactly as a global page is: its keys are from the prefix of a walk
      // nobody is holding any more.
      const mine = walk.current;
      nodeInFlight.current.add(key);
      setNodeLoading((previous) => new Set(previous).add(key));

      try {
        /*
         * THE PATTERN COMES FROM `pathPattern`, in the walk's declared shape and from the folder's PATH.
         * Under `glob` it is `prefixPattern` over the joined name, the helper the row menu's handover
         * builds its own pattern with, so the two cannot drift: the prefix half is escaped and the glob
         * is not, because a real key segment can contain a glob metacharacter (`a[b:1` groups to a
         * prefix holding `[`), and an unescaped one opens a character class matching a different set of
         * keys entirely. Under `prefix` it is the path's name and its separator, `/apisix/` for the
         * folder `["", "apisix"]` and `/` for the root row (spec 4.6), with nothing read out of the
         * name, so a folder whose last segment is `*` is walked over its own range and not over the
         * range of the folder above it. The asymmetry runs the other way in the filter below:
         * `isUnderPrefix` compares REAL key names, so it stays unescaped, because a key that genuinely
         * contains `*` would be corrupted by it.
         */
        const page = await readPageAt(
          nodeCursor.current.get(key) ?? "0",
          pathPattern(path, shape),
          /*
           * THE LARGEST BATCH THE ENGINE DECLARES, where the global walk takes the default.
           *
           * A scoped walk is asked in PRESSES, and every press is a batch of buckets the server has to
           * filter one by one: `MATCH` is not indexed, so a smaller count does not make a press cheaper
           * — it makes more presses for the same answer, which is the thing a reader is already
           * impatient with. The global walk keeps `defaultCount` because Scan more there is a
           * deliberate step a person is watching.
           */
          capability.maxCount,
        );
        if (!alive.current || mine !== walk.current) return;
        nodeCursor.current.set(key, page.cursor);
        setNodeCursors(new Map(nodeCursor.current));

        const fresh = absorb(page.keys.filter((name) => isUnderPrefix(name, path, shape)));
        absorbTypes(page);
        setKeys((previous) => (fresh.length === 0 ? previous : [...previous, ...fresh]));
        // Recorded whatever the answer: a page that added nothing is the case this number exists to
        // report, and leaving it out would draw that press as one that never happened.
        setNodeAdded((previous) => new Map(previous).set(key, fresh.length));
        setError(null);
      } catch (thrown) {
        if (!alive.current || mine !== walk.current) return;
        // NOT written to the loop's failure flag: see this callback's own note. The panel shows the
        // sentence and keeps the keys it already has, because a page that failed did not invalidate
        // the pages that did not.
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      } finally {
        nodeInFlight.current.delete(key);
        if (alive.current) {
          setNodeLoading((previous) => {
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [absorb, absorbTypes, capability, readPageAt, shape],
  );

  const stop = useCallback((): void => {
    // Read by the loop between pages, so this stops a walk rather than a request: the page already
    // in flight lands, is counted, and is the last one.
    stopped.current = true;
  }, []);

  const reset = useCallback((): void => {
    // THE WALK IS RENUMBERED FIRST, so every page still in the air belongs to a walk that is no
    // longer this one and is dropped when it lands. Everything below assumes nothing older than this
    // line can write again.
    walk.current += 1;
    stopped.current = true;
    cursor.current = "0";
    spent.current = false;
    scannedKeys.current = 0;
    skippedKeys.current = null;
    failure.current = null;
    // Every prefix's walk goes with the global one: the keys they brought are about to leave the
    // tree, and a cursor left standing would answer the NEXT walk's Load more with keys from this one.
    nodeCursor.current.clear();
    nodeInFlight.current.clear();
    walked.current.clear();
    knownTypes.current.clear();
    setKeys([]);
    setScanned(0);
    setSkipped(null);
    setTotal(null);
    setClustered(undefined);
    setExhausted(false);
    setStoppedBy(null);
    setError(null);
    setNodeCursors(new Map());
    setNodeLoading(new Set());
    setNodeAdded(new Map());
    setTypes(new Map());
  }, []);

  return {
    keys,
    scanned,
    total,
    clustered,
    skipped,
    types,
    busy,
    scanningAll,
    exhausted,
    stoppedBy,
    error,
    nodeCursors,
    nodeLoading,
    nodeAdded,
    scanMore,
    scanAll,
    loadMoreUnder,
    stop,
    reset,
  };
}
