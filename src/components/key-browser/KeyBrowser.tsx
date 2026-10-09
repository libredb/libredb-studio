"use client";

/**
 * A sampled walk of an engine's key space, drawn as the tree its names imply.
 *
 * THE KEYS ARE ALREADY HERE, so opening a row asks the server for nothing: the walk accumulates
 * batches and the tree is arranged from what has arrived. That is the whole reason this is a panel
 * rather than a reader — `SCAN` can only answer a cursor, so the only way to be fast on a keystroke
 * is to hold what the walk has seen and rearrange it locally.
 *
 * WHAT IS DRAWN IS A SAMPLE, and it says so. `Scanned n/m` is the walk's progress against the count
 * the declaration's `totalScope` names: the server's own key count on Redis, and on etcd the exact
 * count of the range the walk covers. An engine that publishes no count declares `none`, and the line is
 * `Scanned n` alone. A folder's number is how many keys the walk found under it, and
 * a prefix whose keys have not arrived yet does not appear at all. The alternative, presenting a
 * sample as a catalog, is the defect this panel exists to avoid.
 *
 * A FOLDER IS A NAME, NOT A THING. `app:*`, or `apisix/*` under a `/` separator, is a row this client
 * drew because two keys begin with those bytes; nothing on the server can be asked about it. That is
 * why a folder is not clickable into a query the way a table is, and why the row says `shape` rather
 * than claiming an object.
 *
 * THE ROOT OF THE TREE IS A DATABASE WHERE THE ENGINE DECLARES ONE, which is the one thing above a
 * key that really exists. A Redis key space belongs to a numbered database, the walk takes that
 * number, and the reader picks it from the engine's own container list, so the tree is drawn under
 * that row rather than floating free. An engine whose connection is one key space (etcd) declares no
 * such level: its tree starts at the keys' first segments, and a key that begins with the separator
 * hangs under the separator's own root row (spec 4.6).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Database,
  Folder,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DatabaseConnection } from "@/lib/types";
import { keyScanShape, type ContainerLevelSpec, type KeyScanCapability } from "@/lib/db/types";
import {
  buildKeyTree,
  filterKeyTree,
  flattenKeyTree,
  keyName,
  keyRowNames,
  keyTreeWindow,
  KEY_ROW_HEIGHT,
  levelScope,
  pathKey,
  sentPattern,
  splitKey,
  type KeyTreeNode,
  type KeyTreeRow,
} from "./tree";
import { useKeyDatabases } from "./use-key-databases";
import { HELD_KEY_LIMIT, useKeyScan } from "./use-key-scan";

export interface KeyBrowserProps {
  readonly connection: DatabaseConnection;
  /** What this provider declares a batch to be. Absent means no walk, and the shell draws nothing. */
  readonly capability: KeyScanCapability;
  /**
   * The container level a walk is pointed at, when the engine declares one to choose from.
   *
   * Absent means the engine has no level above a key that this panel can name — the walk then goes
   * wherever the engine puts the session, which is what it did before there was anything to choose.
   * The spec is passed rather than the capabilities so the panel cannot invent a label or a depth for
   * a level the engine did not declare: the engine's own WORD for it ("Database") is what the
   * dropdown is labelled with.
   */
  readonly databaseLevel?: ContainerLevelSpec;
  /**
   * A pattern the shell asked to see, from a key-prefix row's own menu.
   *
   * Applied ONCE per request and then owned by the panel, so a reader can edit or clear it afterwards.
   */
  readonly request?: KeyPatternRequest;
  /**
   * A key the reader activated, with the type this panel already knows about it.
   *
   * THE TYPE COMES FROM THE PAGE, so activating a key costs no request of its own: the server sends
   * each key's type with the batch it arrived in. `null` is a key no page described, and the shell
   * decides what to do with that — refusing is as reasonable as opening the editor on a command that
   * finds out.
   *
   * THE DATABASE COMES WITH IT for the same reason and one more: this panel WALKS one numbered
   * database, a key lives in exactly one of them, and Redis has no database-qualified key syntax — so
   * a generated `GET <key>` cannot name the database it belongs to. The number is what lets the shell
   * run the read where the key actually is; `null` is the engine's own session database, which is
   * nothing to override and the call the shell has always taken.
   *
   * AN ENGINE THAT DECLARES A KEY KIND HAS NO TYPE TO SEND, and the shell opens that kind's Source tab
   * for the key instead of a generated read (spec 4.6); the panel hands over the same full name either
   * way.
   *
   * Absent means nobody is listening, and the rows are then not clickable: a row that looks
   * actionable and does nothing is worse than one that plainly is not.
   */
  readonly onOpenKey?: (key: string, type: string | null, database: number | null) => void;
}

/**
 * A pattern somebody asked this panel to show — a key-prefix row's own name, handed over from the
 * object tree's row menu.
 *
 * AN OBJECT AND NOT A STRING, because this is a REQUEST rather than a value: the same pattern asked
 * for twice is a second request, and a string would be indistinguishable from the one already here —
 * so a caller could never ask again, and the panel could never tell an ask from its own state.
 */
export interface KeyPatternRequest {
  /**
   * The pattern the row named, in the walk's declared shape and ready to send: a `MATCH` glob under
   * `glob`, and the literal prefix every walked key begins with under `prefix` (spec 4.6).
   */
  readonly pattern: string;
  /**
   * The container the row lives in, when the row names one.
   *
   * A KEY PATTERN ROW BELONGS TO A DATABASE, and the row menu's item is offered on the rows of every
   * database the object tree lists - so a request that carried the pattern alone would walk whichever
   * database the panel happened to be in, and answer about a key space the reader never pointed at.
   * The NAME rather than a number because that is what the engine listed and what this panel's own
   * choice is made of; an engine whose containers are not numbers cannot be walked by number at all.
   */
  readonly database?: string;
}

/**
 * The picker's stand-in for "the database the session is already in".
 *
 * A SENTINEL BECAUSE THE VALUE CANNOT BE EMPTY: Radix refuses an empty `SelectItem` value, and the
 * fact this one carries is not an absence — it is the engine's own answer, which is exactly what an
 * absent `database` on the wire means.
 */
const SESSION_DATABASE = "__session__";

/**
 * A container name a walk can be POINTED AT, or null.
 *
 * `KeyScanOptions.database` is a number, so a container the engine named something else — a schema, a
 * bucket, a keyspace whose names are words — is one this panel cannot address: nothing is sent for it
 * and the engine answers with the session's, which is a real answer rather than a guess.
 */
function addressable(name: string | null): string | null {
  return name !== null && /^\d+$/.test(name) ? name : null;
}

/**
 * What the last press of a prefix's Load more did, in the row's own words.
 *
 * ABSENT IS NOT ZERO. A prefix nobody has asked about has no outcome to report and says nothing, while
 * a page that came back holding only keys already in the tree is a real answer that has to be shown —
 * otherwise the press looks like a button that does nothing, which is exactly what it is not.
 */
function outcomeOf(added: number | undefined): string {
  if (added === undefined) return "";
  return added === 0 ? " · nothing new in that page" : ` · +${added} new`;
}

/**
 * Every path from the top level down to `scope`, each as its `pathKey`: the folders a level walk draws
 * open, so the level it lists is visible under them (Keys panel levels, spec 3.6).
 */
function scopeChain(scope: readonly string[]): ReadonlySet<string> {
  return new Set(scope.map((_, index) => pathKey(scope.slice(0, index + 1))));
}

/**
 * One drawn row: a row of the key tree, or the database that tree hangs under.
 *
 * ONE UNION RATHER THAN A CHILD ELEMENT, because the two scroll and window together: a database row
 * outside the window would sit above a slice of prefixes while the reader scrolled, which is exactly
 * the disagreement virtualising a list is supposed to prevent. `kind` is what discriminates, so every
 * branch below is told apart the way the tree's own rows are.
 */
type PanelRow = KeyTreeRow | { readonly kind: "database"; readonly name: string; readonly label: string };

export function KeyBrowser({ connection, capability, databaseLevel, request, onOpenKey }: KeyBrowserProps) {
  const [pattern, setPattern] = useState(request?.pattern ?? "");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A request's database is the panel's INITIAL choice, exactly as its pattern is the initial
  // pattern: on mount the sync below has nothing to compare against, so a row's own database would
  // otherwise be dropped on the very first handover - the case the item exists for.
  const [chosen, setChosen] = useState<string | null>(request?.database ?? null);
  const [databaseOpen, setDatabaseOpen] = useState(true);
  const [answered, setAnswered] = useState<KeyPatternRequest | undefined>(request);

  /*
   * A REQUEST IS APPLIED ON THE RENDER IT ARRIVES, which is React's own escape hatch for state derived
   * from a prop and the shape `useProviderMetadata` uses for its reset. An effect would commit one
   * render showing the OLD pattern — and that render already walks, because the walk follows the
   * pattern — so the panel would take a page of the previous question and then throw it away.
   *
   * IDENTITY IS THE QUESTION AND NOT THE TEXT: a request for the pattern already on screen changes
   * nothing, because the sample in the tree IS the answer to it.
   */
  if (answered !== request) {
    setAnswered(request);
    if (request !== undefined) {
      setPattern(request.pattern);
      // The row's own database travels with it: a request that changed the pattern but not the
      // database would answer about the key space the panel was already in.
      if (request.database !== undefined) setChosen(request.database);
      // The filter belongs to the keys that were on screen, and those are about to be replaced: left
      // on, it would hide the answer to the request that was just made.
      setTerm("");
    }
  }

  /**
   * The walk's shape, read once through the one helper (spec 3.4). Every text below that names a
   * separator or a pattern is derived from it, so a `glob` declaration draws today's panel byte for
   * byte and a `prefix` one draws etcd's.
   */
  const shape = useMemo(() => keyScanShape(capability), [capability]);
  const separator = shape.separator;
  const prefixed = shape.pattern === "prefix";
  /** What the box sends for the text in it: the text under `glob`, the text as a prefix under `prefix`. */
  const sent = sentPattern(pattern, shape);
  /**
   * Whether this engine lists its key space one level at a time (Keys panel levels, spec 3.6). Every
   * behaviour and every sentence below that differs from today's is gated on it, so an engine without
   * `levels` draws and asks exactly what it did.
   */
  const levels = capability.levels !== undefined;
  /** The path whose level the panel's own walk lists, and its identity as a map key. */
  const scope = useMemo(() => levelScope(sent, shape), [sent, shape]);
  const scopeKey = pathKey(scope);
  const {
    names,
    answered: databasesAnswered,
    sessionDefault,
    error: databasesError,
  } = useKeyDatabases(connection, databaseLevel);

  /*
   * THE DATABASE THE WALK READS, which is a name until the last moment because that is what the
   * engine listed.
   *
   * ONLY A CHOICE IS SENT, and that is not an optimisation. The engine answers "which database is
   * this session in?" itself, so a first page that carried the session's own number would be asking
   * for what it was already getting — and the walk would then be RESTARTED the moment the container
   * list arrived, because the request's question changed under it. Nothing is sent until somebody
   * chooses, and an absent `database` is the engine's own default.
   *
   * `chosen` is only honoured while this engine still lists it: a reader who picked database 3 and
   * then switched to a server with two of them gets the session's own rather than a number that
   * server never offered.
   */
  const listed = chosen !== null && names.includes(chosen) && addressable(chosen) !== null ? chosen : null;
  /**
   * Whether the panel is waiting for the container list before it can walk the database it was asked
   * for.
   *
   * A REQUEST THAT NAMES A DATABASE IS NOT AN ANSWER ABOUT ONE. The panel cannot point the walk at a
   * container it has not been told exists, so starting one anyway would take a page of the session's
   * database and replace it a moment later - the visible flash of one database's keys under another
   * database's name, for no answer. The wait ends when the list answers, whatever it answers: a
   * refused list is a real answer about the list, and the walk then goes where the panel says it does.
   */
  const waitingForChosenDatabase = chosen !== null && !databasesAnswered && databasesError === null;
  /** What the panel says the walk is reading: the choice, or the engine's own session database. */
  const walked = listed ?? sessionDefault;
  const database = listed === null ? undefined : Number(listed);
  /*
   * A NEW QUESTION OPENS THE SCOPE'S CHAIN, applied on the render it arrives, as `request` is above. A
   * Browse Keys handover to `sales/` draws `sales/` open with its level listed under it, and every folder
   * left open by the previous question closes: its listing belonged to the walk being replaced.
   *
   * THE QUESTION IS EXACTLY WHAT THE WALK KEYS ON: the connection and capability objects, the database
   * and the sent prefix, compared by identity. The walk restarts, and drops every folder's listing, when
   * any of them is a new value, even a rebuilt object with the same content, so an identity narrower than
   * that would leave a folder drawn open and empty. The question is recorded whatever `levels` is, so
   * a level connection reached again through an engine without levels is a new question too; only the
   * re-open is gated, which keeps the engines without levels drawing what they always did.
   */
  const question = { connection, capability, database, sent };
  const [asked, setAsked] = useState<typeof question | null>(null);
  if (
    asked === null ||
    asked.connection !== connection ||
    asked.capability !== capability ||
    asked.database !== database ||
    asked.sent !== sent
  ) {
    setAsked(question);
    if (levels) setOpen(scopeChain(scope));
  }

  /**
   * The database row the tree hangs under, or null when there is no database to draw.
   *
   * It names the database the walk is actually reading — the choice, or the engine's own session
   * database — because that is the fact a reader looking at a key needs.
   */
  const databaseRow =
    databaseLevel !== undefined && walked !== null ? { name: walked, label: databaseLevel.label } : null;

  const {
    keys,
    folders,
    scanned,
    total,
    clustered,
    types,
    busy,
    scanningAll,
    exhausted,
    stoppedBy,
    skipped,
    error,
    nodeCursors,
    nodeLoading,
    nodeAdded,
    scanMore,
    scanAll,
    loadMoreUnder,
    stop,
    reset,
  } = useKeyScan({ connection, capability, pattern: sent, database });

  /**
   * Whether the tree is holding as much as this panel takes.
   *
   * Derived from the keys rather than asked of the walk, because it is the TREE's state: the walk
   * stops taking pages when it is reached, and the panel draws one sentence for that bound — the
   * same number `Scan all` ends its own budget at, worded so a reader can tell the two apart.
   */
  // Keys plus server folders, the sum the hook's own limit reads (Keys panel levels, spec 3.6); with no
  // folders, which is every engine without levels, it is the key count it always was.
  const heldFull = keys.length + folders.length >= HELD_KEY_LIMIT;

  /*
   * Start the walk again from cursor `"0"`.
   *
   * `reset` and then one page, in that order and in one place, because two callers want exactly this:
   * the effect below, when the question the walk answers has changed, and the panel's own refresh
   * button, when the reader wants the same question asked again. The generation `reset` bumps is what
   * makes it safe while a page is still in the air — that answer is dropped rather than mixed in.
   */
  const restart = useCallback(() => {
    reset();
    void scanMore();
  }, [reset, scanMore]);

  /*
   * THE REFRESH BUTTON. Under levels it also closes every folder but the scope's chain (Keys panel
   * levels, spec 3.6): `reset` clears every folder's cursor, and a folder left open with no cursor would
   * draw open and empty with no gesture left to list it. A folder lists again when the reader opens it.
   */
  const refresh = useCallback(() => {
    if (levels) setOpen(scopeChain(scope));
    restart();
  }, [levels, restart, scope]);

  /*
   * The first page loads itself, and it is re-taken when the walk's question changes.
   *
   * A panel whose first gesture is "find the Scan button" reads as broken until somebody finds it,
   * and the walk is what the panel IS rather than something done to it. `restart` is the dependency
   * and not `pattern` alone: it changes exactly when the connection, the pattern or the database
   * changes — a different question, so a different walk — and it is stable for a given question, so a
   * re-render of the same one does not restart anything. A walk restarted on every render would
   * request its first page for ever.
   *
   * `waitingForChosenDatabase` is the one case where the walk does NOT start yet, and it is read here
   * rather than left to the restart above: the database a row asked for is only usable once the
   * engine has confirmed it exists, and a page taken before that is a page thrown away.
   */
  useEffect(() => {
    if (waitingForChosenDatabase) return;
    restart();
  }, [restart, waitingForChosenDatabase]);

  /**
   * Hand a leaf to the shell, with the type this panel already has for it.
   *
   * A FOLDER IS NOT HANDED OVER: it has no value, so there is nothing to read and the shell has no
   * command to open. Activating one opens it, which is what a reader means by clicking a folder.
   */
  const openKey = useCallback(
    (node: KeyTreeNode) => {
      // The FULL name, the one join every reader uses (spec 4.6): a key that begins with the separator
      // keeps it, because its first segment is empty and the join puts it back.
      const name = keyName(node.path, shape);
      // `database` is the walked database as a number, or undefined while nothing was chosen, which the
      // shell reads as "the engine's own", exactly as an absent `database` does on the wire.
      onOpenKey?.(name, types.get(name) ?? null, database ?? null);
    },
    [database, onOpenKey, shape, types],
  );

  const tree = useMemo(() => buildKeyTree(keys, shape, folders), [keys, shape, folders]);
  const filtering = term.trim() !== "";
  const visible = useMemo(() => filterKeyTree(tree, term, shape), [tree, term, shape]);
  /** The server folders' paths, by `pathKey`: a folder the server named pages its own level. */
  const serverFolderKeys = useMemo(
    () => new Set(folders.map((folder) => pathKey(splitKey(folder, shape).slice(0, -1)))),
    [folders, shape],
  );
  /**
   * The folders above the scope, by `pathKey` (Keys panel levels, spec 3.6). The panel's walk lists the
   * scope's level only, so a folder above it holds the one row on the way down and nobody asked for its
   * level: until it is listed it is an unlisted folder, and it lists its level when opened as one does.
   */
  const ancestorKeys = useMemo(
    () => (levels ? new Set([...scopeChain(scope)].filter((key) => key !== scopeKey)) : new Set<string>()),
    [levels, scope, scopeKey],
  );

  /**
   * Open or close a folder, and LIST A SERVER FOLDER on the reader's first expand (Keys panel levels,
   * spec 3.6).
   *
   * The decision is taken here, from the `open` set of this render, and never inside the `setOpen`
   * updater: React may call an updater twice in development, and a request sent from one would be sent
   * twice. A folder is listed once: not when it already has a cursor, not while its page is in flight,
   * and not when a filter is what holds it open, because typing must not fan out requests.
   */
  const toggleFolder = useCallback(
    (node: KeyTreeNode) => {
      const key = pathKey(node.path);
      // The scope row is the walk's own level, listed by the walk under the typed prefix: even when its
      // parent's listing names it a folder, listing it as one would ask for keys outside that prefix.
      const listable = key !== scopeKey && (node.serverFolder === true || ancestorKeys.has(key));
      const unlisted = listable && !nodeCursors.has(key) && !nodeLoading.has(key);
      // An unlisted folder that holds no rows opens only when its level can be listed now: under a filter,
      // or with the panel held full, it would open empty with no row to list it, so the press changes
      // nothing. One whose rows are already held, a folder above the prefix, opens without a listing.
      if (levels && unlisted && node.children.length === 0 && !open.has(key) && (filtering || heldFull)) return;
      if (levels && !open.has(key) && unlisted) void loadMoreUnder(node.path);
      setOpen((previous) => {
        const next = new Set(previous);
        // One write for both directions: a twisty that only ever added would be a row that cannot be
        // closed, and the copy is what makes React see a new Set.
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [ancestorKeys, filtering, heldFull, levels, loadMoreUnder, nodeCursors, nodeLoading, open, scopeKey],
  );
  // While a filter is on, every surviving folder is open: a match two levels down that stayed
  // collapsed would look like no match at all, which is the one answer a filter must never give.
  const canLoadMore = useCallback(
    (path: readonly string[]) => {
      if (levels) {
        // Under levels each LEVEL has its own row (Keys panel levels, spec 3.6): the scope's pages the
        // panel's own walk, a server folder's pages its own listing, and no other node lists anything.
        if (filtering || heldFull) return false;
        const key = pathKey(path);
        if (key === scopeKey) return !exhausted;
        // A folder above the scope pages its level only once it has been listed: before that the walk
        // drew it open on the way down, and a row under it would offer a level nobody asked for.
        if (ancestorKeys.has(key)) return nodeCursors.has(key) && nodeCursors.get(key) !== "0";
        return serverFolderKeys.has(key) && nodeCursors.get(key) !== "0";
      }
      /*
       * THREE REASONS NOT TO OFFER IT, and each is a fact rather than a preference.
       *
       * The walk is SPENT: a cursor of `"0"` at the database level means the sample IS the keyspace,
       * so every prefix in it is complete and a "there may be more" row would be a lie.
       *
       * The prefix is SPENT: its own scoped walk came back `"0"`, which is the one thing that proves
       * there is nothing more under it.
       *
       * A FILTER IS ON: the visible tree is a view of what is held, and a row that pulled more keys
       * into it would make what a reader sees depend on clicks the filter's term does not explain.
       * Clearing the box brings the rows back.
       */
      // THE TREE IS FULL: a press could not add anything, and a row offering what it cannot deliver
      // is the same defect as one the server would answer "nothing more" to.
      if (exhausted || filtering || heldFull) return false;
      return nodeCursors.get(pathKey(path)) !== "0";
    },
    [ancestorKeys, exhausted, filtering, heldFull, levels, nodeCursors, scopeKey, serverFolderKeys],
  );
  const rows = useMemo(
    () =>
      flattenKeyTree(visible, (path) => filtering || open.has(pathKey(path)), canLoadMore, {
        // The top level is a level too, and under levels every load-more row counts the rows listed.
        rootLoadMore: levels && scope.length === 0,
        countRows: levels,
      }),
    [visible, filtering, open, canLoadMore, levels, scope],
  );
  /**
   * A row's indentation, in pixels.
   *
   * THE DATABASE ROW PUSHES EVERYTHING UNDER IT DOWN ONE LEVEL, so the tree's own `8 + depth * 12`
   * induction still lines a key up with a row of the same depth elsewhere in the product rather than
   * with the database's children.
   */
  const indent = (depth: number): number => 8 + (depth + (databaseRow === null ? 0 : 1)) * 12;
  /** The ARIA level of a row: the database is one, the prefixes are one deeper when it is drawn. */
  const ariaLevel = (depth: number): number => depth + (databaseRow === null ? 0 : 1) + 1;

  /*
   * THE WINDOW'S FOUR NUMBERS. Height is measured in the attach callback rather than an effect,
   * because writing state synchronously inside an effect is an error in this repository and a ref
   * callback runs after the same layout - which is also what `ObjectTree` does for its own tree.
   *
   * `pinned` is what keeps a focused row in the window: the reader tabs to a row, focus is on it, and
   * without the pin a scroll would unmount it from under them, which is the one way a virtualised
   * tree is worse for a keyboard reader than none. Scrolling unpins, so the window follows the
   * scrollbar again the moment focus is not what is being kept.
   */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedRow, setFocusedRow] = useState(-1);
  const [pinned, setPinned] = useState(false);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element !== null) setViewportHeight(element.clientHeight);
  }, []);
  const onScroll = useCallback((event: { currentTarget: HTMLDivElement }) => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
    setPinned(false);
  }, []);

  /**
   * The rows the window runs over: the key rows when the database row is folded away or absent, and
   * the database row plus them when it is drawn.
   */
  const panelRows = useMemo<PanelRow[]>(() => {
    const keyRows = databaseRow === null || databaseOpen ? rows : [];
    if (databaseRow === null) return keyRows;
    return [{ kind: "database", name: databaseRow.name, label: databaseRow.label }, ...keyRows];
  }, [databaseRow, databaseOpen, rows]);
  const [windowStart, windowEnd] = keyTreeWindow(panelRows.length, scrollTop, viewportHeight, pinned ? focusedRow : -1);

  /*
   * WHAT THE TWO NUMBERS OF THE PROGRESS LINE ARE, because they are not the same kind of number and
   * the obvious wording says they are.
   *
   * On Redis the denominator is the server's own `DBSIZE`: EVERY key the database holds, whatever
   * pattern is in hand. The numerator is what the walk has been HANDED, and a `MATCH` narrows that to
   * the keys that passed it, so with a pattern on, the fraction is not a walk position at all. Redis
   * walks the whole table and filters; a walk that has finished with `user:*` reports `137` because
   * 137 keys match, and "Scanned 137/1531" invites a reader to wait for a walk that is already over.
   * So the word follows the question: a plain walk is Scanned, a pattern is Matched.
   *
   * UNDER A `walk` SCOPE THE PAIR IS A FRACTION WHATEVER THE PREFIX (spec 4.6). The denominator is the
   * exact count of the keys this walk covers, the prefix's range or the whole key space, and a prefix
   * walk is a position in an ordered range rather than a filtered pass, so the word stays Scanned. The
   * tooltip says what both numbers are, since neither word explains the pair on its own.
   *
   * UNDER `none` THERE IS NO DENOMINATOR (Keys panel totals). The engine publishes no key count and its
   * pages pin no revision, so the provider answers a total of 0 that nothing reads: the line is the
   * numerator alone, the word stays Scanned whatever the prefix, and the tooltip says that no total is
   * shown and why.
   */
  const walkScoped = shape.totalScope === "walk";
  // An engine that publishes no key count (`"none"`): the line is the numerator alone, and `total` is not read.
  const uncounted = shape.totalScope === "none";
  // A level walk lists folders and keys, so its line says Listed (Keys panel levels, spec 3.6).
  const progressPrefix = levels ? "Listed" : walkScoped || uncounted || pattern === "" ? "Scanned" : "Matched";
  const progressSuffix = total === null || uncounted ? "" : walkScoped || pattern === "" ? `/${total}` : ` of ${total}`;
  /*
   * THE NUMERATOR NEVER READS ABOVE THE PANEL'S OWN BUDGET, and that is the whole point of clamping a
   * number that is otherwise honest: `scanned` counts what the server HANDED over, and a page is
   * counted whole even when the held limit truncates its tail, so the walk's own tally can sit keys -
   * up to a batch - above ten thousand. Printed unclamped beside the sentence that declares ten
   * thousand the limit, it asks one question ("so there is more than ten thousand in there?") whose
   * answer is no, since the tree holds ten thousand and the sentence says so. The clamp is for
   * DISPLAY only: the walk's bound keeps counting what crossed the wire, which is what bounds work.
   */
  const counted = Math.min(scanned, HELD_KEY_LIMIT);
  /*
   * WHAT A CLUSTERED SERVER'S COUNTS ARE: one node's, and the panel says so in words rather than in
   * a footnote. `SCAN` and `DBSIZE` are per node and neither has a cluster-wide form, so on a
   * three-master deployment the number this panel divides by is a third of the key space at most -
   * a figure reported as "every key this database holds" is the claim the review caught (#1094).
   *
   * `true` only: a server that did not read its own `INFO cluster` says nothing about itself here,
   * and "not clustered" would be a claim from a refusal.
   */
  const nodeScoped = clustered === true;
  const countScope = levels
    ? "Folders and keys of this level listed so far: this engine lists one folder at a time and publishes no count, so no total is shown"
    : uncounted
      ? "keys read so far: this engine publishes no key count, so no total is shown"
      : walkScoped
        ? sent === ""
          ? "out of every key this connection may read"
          : `out of the keys under ${sent} this connection may read`
        : nodeScoped
          ? "out of every key this NODE holds (this server is clustered: SCAN and DBSIZE are per node)"
          : "out of every key this database holds";

  /** Whether a level can still be asked for more: the scope's own walk, or a listed server folder's. */
  const levelHasMore = (key: string): boolean =>
    key === scopeKey ? !exhausted : nodeCursors.has(key) && nodeCursors.get(key) !== "0";
  /**
   * A server folder nobody has listed yet: it has a name, and nothing under it is counted. A folder above
   * the scope is one too until its own level is listed.
   */
  const unlistedFolder = (node: KeyTreeNode): boolean =>
    (node.serverFolder === true || ancestorKeys.has(pathKey(node.path))) &&
    pathKey(node.path) !== scopeKey &&
    !nodeCursors.has(pathKey(node.path));
  /**
   * A folder's badge under levels (Keys panel levels, spec 3.6): the rows its level has listed, with a
   * `+` while that level has more pages. A level lists its own entries and never its subfolders'
   * contents, so no folder has a key count to show; an unlisted folder shows nothing, and its title
   * says it is unlisted rather than counting rows that were never asked for.
   */
  const levelBadge = (node: KeyTreeNode): string =>
    unlistedFolder(node)
      ? ""
      : `${node.children.length.toLocaleString("en-US")}${levelHasMore(pathKey(node.path)) ? "+" : ""}`;
  const levelBadgeTitle = (node: KeyTreeNode): string => {
    // A folder drawn open and not listed (a folder above the scope, drawn open on the way down) lists
    // its level on the next open, so the way there is to close it first.
    if (unlistedFolder(node) && open.has(pathKey(node.path)) && !nodeLoading.has(pathKey(node.path))) {
      return "Not listed yet: close and reopen the folder to list it";
    }
    if (unlistedFolder(node)) return "Not listed yet: open the folder to list it";
    const listed = node.children.length;
    const more = levelHasMore(pathKey(node.path)) ? "; more pages remain" : "";
    return `${listed.toLocaleString("en-US")} entr${listed === 1 ? "y" : "ies"} listed in this folder${more}`;
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="key-browser">
      <div className="flex items-center gap-1 pb-2">
        <Input
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder={
            levels
              ? `Prefix, e.g. app${separator}config${separator}`
              : prefixed
                ? `Key prefix, e.g. ${separator}app${separator}config${separator}`
                : `Match pattern, e.g. app${separator}cache${separator}*`
          }
          aria-label={prefixed ? "Key prefix" : "Match pattern"}
          // A `*` typed into a prefix is data, and the box says so where a reader looks (spec 4.6).
          title={
            levels
              ? `Lists the folders and keys directly under exactly this text. A * is part of the prefix, except in a trailing ${separator}*, which is read as the folder it names.`
              : prefixed
                ? `Walks the keys that begin with exactly this text. A * is part of the prefix, except in a trailing ${separator}*, which is read as the folder it names.`
                : undefined
          }
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        {/*
          WHICH DATABASE THE WALK IS IN, from the engine's own list. Drawn only where the engine
          declared a level to choose from, and left empty while that read is in flight or refused:
          the walk itself does not wait for it, because an absent database means the session's own.

          THE PROJECT'S OWN SELECT AND NOT A NATIVE ONE, which is a colour and not a taste: a native
          `<option>` list is painted by the browser, and this application declares no `color-scheme`,
          so the popup came out light with the dark theme's text on it — a menu a reader has to guess
          at. `SelectContent` is the themed surface every other picker in the product opens.
        */}
        {databaseLevel !== undefined && (
          <Select
            value={walked ?? SESSION_DATABASE}
            onValueChange={(value) => setChosen(value === SESSION_DATABASE ? null : value)}
            disabled={names.length === 0}
          >
            <SelectTrigger
              size="sm"
              aria-label={databaseLevel.label}
              title={`${databaseLevel.label} to walk`}
              // The component's `sm` trigger is 32px and this panel's rows are 28, so the SAME variant
              // is asked for the height rather than an `!` override: `tailwind-merge` sees one group
              // and keeps the later value, which is the one written here.
              className="h-7 data-[size=sm]:h-7 w-[4.5rem] shrink-0 px-1.5 py-0 font-mono text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* A real item rather than a `placeholder`, because it is a real ANSWER: it means "the
                  database the session is already in", which is what the engine walks when nothing was
                  chosen. Radix refuses an empty item value, so the sentinel stands for it. */}
              <SelectItem value={SESSION_DATABASE} className="text-xs">
                session
              </SelectItem>
              {names.map((name) => (
                <SelectItem key={name} value={name} className="font-mono text-xs">
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/*
          ASK AGAIN. The walk is a sample of a key space that changes under it, so re-reading it is a
          normal thing to want rather than a recovery from a failure — and it is the only way to see a
          key somebody else wrote without leaving the panel.
        */}
        <button
          type="button"
          data-testid="key-browser-refresh"
          onClick={refresh}
          aria-label={levels ? "List this prefix again" : "Scan this database again"}
          title={levels ? "List this prefix again" : "Scan this database again"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand"
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span
          className="text-[10px] tabular-nums text-muted-foreground"
          data-testid="key-browser-progress"
          title={countScope}
        >
          {progressPrefix} {counted}
          {progressSuffix}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void scanMore()}
            disabled={busy || scanningAll || exhausted || heldFull}
            className="rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {levels ? "List more" : "Scan more"}
          </button>
          <button
            type="button"
            onClick={() => (scanningAll ? stop() : void scanAll())}
            disabled={(busy && !scanningAll) || heldFull}
            className="rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {scanningAll ? "Stop" : levels ? "List all of this level" : "Scan all"}
          </button>
        </div>
      </div>

      {/* Under levels a level can hold folders and no keys, and its folders must be filterable too
          (Keys panel levels, spec 3.6). */}
      {(levels ? keys.length + folders.length : keys.length) > 0 && (
        <div className="pb-2">
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={levels ? "Filter the folders and keys listed" : "Filter the keys found"}
            aria-label={levels ? "Filter the folders and keys listed" : "Filter the keys found"}
            /*
              WHAT IT MATCHES, on the row itself, because the box takes two kinds of answer and the
              reader cannot tell which one it wants: a word names a SEGMENT (`cache`), and the rest of
              a path names a KEY (`queue:jobs:failed:2026:09:23`). Both are answered — see
              `filterKeyTree` — and the tooltip is where that is stated rather than guessed at.
            */
            title={
              levels
                ? `Narrows the folders and keys already listed, without asking the server. Matches any part of a full name, or one of its \`${separator}\`-separated segments.`
                : `Narrows the keys already loaded, without asking the server. Matches any part of a key's full name, or one of its \`${separator}\`-separated segments.`
            }
            className="h-7 text-xs"
          />
        </div>
      )}

      {/*
        A FAILED PAGE IS A BANNER, NOT A REPLACEMENT. A page that failed did not invalidate the pages
        that did — the keys already in the tree are still answers the server really gave — so taking
        the tree away would hide correct data because a later request could not be made. It is now
        load-bearing rather than a preference: a scoped Load more can fail on its own, and blanking
        the panel for it would punish the reader for one prefix.
      */}
      {error !== null && (
        <div
          className="mb-2 flex items-start gap-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5"
          data-testid="key-browser-error"
        >
          <TriangleAlert strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="break-words text-[10px] leading-relaxed text-muted-foreground">{error}</p>
        </div>
      )}

      {/*
        THE DATABASE LIST IS ITS OWN REPORT, because it is its own read. A refusal there is not a
        refusal of the walk — the panel still walks the session's database — so the two sentences are
        drawn separately rather than ranked into one slot, and the reader can tell which read failed.
      */}
      {databasesError !== null && (
        <div
          className="mb-2 flex items-start gap-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5"
          data-testid="key-browser-databases-error"
        >
          <TriangleAlert strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="break-words text-[10px] leading-relaxed text-muted-foreground">
            {`Reading the databases failed: ${databasesError}`}
          </p>
        </div>
      )}

      {/* VISIBLE, NOT ONLY IN A TOOLTIP: the counts are what the whole panel divides by, and a reader
          who cannot see that they are one node's will take them for the key space (#1094). Drawn only
          where the server's own `INFO cluster` said so - a reply the provider could not read claims
          nothing. */}
      {nodeScoped && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-clustered">
          Clustered server: SCAN and DBSIZE answer for one node at a time, so these counts are this node&apos;s.
        </p>
      )}

      {/* THE OTHER BOUND, and it is drawn from the tree's own size so there is one sentence for it
          wherever it ends the walk: the reader gets it whether a `Scan all` loop stopped on it, or
          `Scan more` quietly refused because a tree that is full cannot be given more. */}
      {heldFull && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-held">
          {levels
            ? `Holding ${HELD_KEY_LIMIT.toLocaleString("en-US")} keys and folders, which is this panel's limit. Narrow the prefix to list a smaller part of the key space.`
            : `Holding ${HELD_KEY_LIMIT.toLocaleString("en-US")} keys, which is this panel's limit. Narrow the ${prefixed ? "prefix" : "pattern"} to walk a smaller key space.`}
        </p>
      )}

      {stoppedBy !== null && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-stopped">
          {stoppedBy}
        </p>
      )}

      {/* THE KEYS A PAGE LEFT OUT, counted rather than drawn (spec 4.6): a key that is not UTF-8 text has
          no name a row could carry, because one decoded with replacement characters would address a
          different key. The reason is the provider's own words. */}
      {skipped !== null && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-skipped">
          {`${skipped.count.toLocaleString("en-US")} key${skipped.count === 1 ? "" : "s"} left out of this walk: ${skipped.reason}`}
        </p>
      )}

      {/* Suppressed by an error because it is a claim about the DATABASE, and a read that failed is
          not evidence about what the database holds. */}
      {error === null && rows.length === 0 && (
        <div
          className="flex flex-col items-center px-2 py-6 text-center text-muted-foreground"
          data-testid="key-browser-empty"
        >
          {busy ? (
            <LoaderCircle strokeWidth={1.5} className="h-5 w-5 animate-spin text-brand/40" />
          ) : (
            <>
              <KeyRound strokeWidth={1.5} className="h-5 w-5" />
              <span className="mt-2 text-xs font-medium">
                {filtering
                  ? "No key matches the filter"
                  : levels
                    ? sent === ""
                      ? "Nothing is listed at the top level"
                      : `Nothing is listed under ${sent}`
                    : "This database holds no keys the walk has seen"}
              </span>
            </>
          )}
        </div>
      )}

      {/*
        THE ROWS ARE WINDOWED to what the box can show, for the reason a ten-thousand-key prefix must
        be: the keys are a real array the filter walks on every keystroke, and a window of a few dozen
        rows is what keeps 6,000 rows from costing 6,000 DOM nodes.

        THE DATABASE ROW IS IN THE SAME WINDOW rather than pinned above it, because a row fixed over a
        scrolling slice of prefixes would disagree with them about where the list starts. This is the
        recipe `ObjectTree` already uses: a measured box, flat rows at a fixed height, and the ARIA
        pair taken from the FULL level — `aria-setsize` is the whole set, so a screen reader is told
        how long the list really is while the window hides most of it.
      */}
      <div
        ref={attach}
        role="tree"
        aria-label="Keys"
        tabIndex={-1}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <div role="presentation" className="relative" style={{ height: panelRows.length * KEY_ROW_HEIGHT }}>
          {panelRows.slice(windowStart, windowEnd).map((row, offset) => {
            const index = windowStart + offset;
            const top = index * KEY_ROW_HEIGHT;
            // Focus is what the window stays aware of: a row the reader tabbed to must not be
            // unmounted by the scroll that follows, which would leave focus on a container with
            // nothing under it.
            const focus = (): void => {
              setFocusedRow(index);
              setPinned(true);
            };
            {
              /*
            THE DATABASE THE KEYS ARE IN, drawn as the tree's root because that is what it is: on an
            engine that declares a level, a key space belongs to one numbered database, and a tree that
            began at its first folder would leave the reader to guess which one they were looking at.

            It carries the SERVER'S OWN count (`DBSIZE`, which travels with every page) rather than the
            sample's, and it stands down to nothing until a page has answered — the one slot both kinds
            of row use, so one edge answers "how much is in this row" throughout.
          */
            }
            if (row.kind === "database") {
              return (
                <div
                  key="database"
                  role="treeitem"
                  aria-level={1}
                  aria-setsize={1}
                  aria-posinset={1}
                  aria-expanded={databaseOpen}
                  tabIndex={0}
                  data-testid="key-browser-database"
                  title={`${row.label} ${row.name}`}
                  onClick={() => setDatabaseOpen((wasOpen) => !wasOpen)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    // A held key would toggle once per auto-repeat, for the reason the key row states.
                    if (event.repeat) return;
                    setDatabaseOpen((wasOpen) => !wasOpen);
                  }}
                  onFocus={focus}
                  style={{ top, paddingLeft: 8 }}
                  className="absolute inset-x-0 flex h-6 cursor-pointer select-none items-center gap-1 rounded pr-7 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-brand"
                >
                  <ChevronRight
                    strokeWidth={1.5}
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                      databaseOpen && "rotate-90",
                    )}
                  />
                  <Database strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{row.name}</span>
                  <span
                    data-testid="key-browser-database-total"
                    title={
                      nodeScoped
                        ? "Keys in this database as THIS NODE counts them: the server is clustered, and SCAN and DBSIZE have no cluster-wide form"
                        : "Keys in this database, as the server counts them"
                    }
                    className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground"
                  >
                    {total === null || uncounted ? "" : total.toLocaleString("en-US")}
                  </span>
                </div>
              );
            }

            if (row.kind === "loadMore") {
              const key = pathKey(row.path);
              // Under levels the scope's row presses the panel's own walk, whose page is `busy`; every
              // other row presses its folder's own listing (Keys panel levels, spec 3.6).
              const ownLevel = levels && key === scopeKey;
              const loading = ownLevel ? busy : nodeLoading.has(key);
              return (
                <button
                  key={`more:${key}`}
                  type="button"
                  data-testid="key-browser-load-more"
                  disabled={loading}
                  onClick={() => void (ownLevel ? scanMore() : loadMoreUnder(row.path))}
                  /*
                   * THE ROW SAYS WHAT A PRESS IS WORTH BEFORE IT IS PRESSED, in the declared shape.
                   * Under `glob`, `MATCH` is applied per batch and is not indexed; under `prefix`, a
                   * page reads the range the walk above already reads. Either way the keys that come
                   * back are then deduplicated, so one press can legitimately add nothing at all, a
                   * fact that has to be on the row rather than discovered by pressing it repeatedly.
                   */
                  title={
                    levels
                      ? "Ask the server for the next page of this folder. A page lists folders and keys of this level only, and each folder lists its own level when opened."
                      : prefixed
                        ? "Ask the server for the next page of the keys under this prefix. The walk above reads the same range in the same order, so a page can hold only keys already loaded."
                        : "Ask the server for one more page under this prefix. It answers a batch of buckets rather than a listing, so a page can hold only keys already loaded."
                  }
                  // One level deeper than the folder it belongs to, so it reads as following the
                  // children above it rather than as one of them.
                  onFocus={focus}
                  style={{ top, paddingLeft: indent(row.depth) }}
                  // `pr-7` and not a token gutter: the object tree reserves the same 28px on every
                  // row so that a right-hand number is never under the scrollbar, which is a
                  // measured defect this project has already fixed once (`TreeRow`).
                  className="absolute inset-x-0 flex h-6 items-center gap-1 rounded pr-7 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="h-3.5 w-3.5 shrink-0" />
                  {loading ? (
                    <LoaderCircle
                      strokeWidth={1.5}
                      className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : (
                    <PackageOpen strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {loading
                      ? levels
                        ? "Listing this folder..."
                        : "Asking for one more page..."
                      : `${levels ? "Load more of this folder" : "Click to load more"}${outcomeOf(nodeAdded.get(key))}`}
                  </span>
                  {/*
                      THE COUNT THIS PRESS IS MEASURED AGAINST, in the same right-hand column every
                      other row keeps its number in. Without it a page of duplicates looks like a dead
                      button; with it the reader can see the number the press is trying to move.
                    */}
                  <span
                    data-testid="key-browser-load-more-count"
                    className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground"
                  >
                    {levels
                      ? `${row.count.toLocaleString("en-US")} entr${row.count === 1 ? "y" : "ies"} listed`
                      : `${row.count.toLocaleString("en-US")} key${row.count === 1 ? "" : "s"}`}
                  </span>
                </button>
              );
            }

            const { node, depth, folder } = row;
            const key = pathKey(node.path);
            const isOpen = filtering || open.has(key);
            // The FULL name, the one join every reader uses, and the three names the row gives its node,
            // all in the declared separator (spec 4.6).
            const name = keyName(node.path, shape);
            const names = keyRowNames(node, folder, shape, levels);
            /*
             * A NODE CAN BE TWO THINGS AT ONCE, and this is the row where that shows: `user:42` is
             * a key AND a prefix of `user:42:profile`, so it has a value to read and children to
             * open. The row is the KEY and the twisty is the FOLDER, which is the split the object
             * tree already makes between activating a table and expanding its columns - and it is
             * what makes a row that was drawn only as a folder reachable as a key.
             *
             * A node that is only a folder keeps the whole row as its toggle, because there is
             * nothing else for a click to mean there.
             */
            const readable = node.isKey && onOpenKey !== undefined;
            const activate = (): void => {
              if (readable) openKey(node);
              else if (folder) toggleFolder(node);
            };
            return (
              <div
                key={key}
                role="treeitem"
                aria-expanded={folder ? isOpen : undefined}
                aria-level={ariaLevel(depth)}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                onFocus={focus}
                tabIndex={0}
                // The FULL name, which is what a key is identified by, and the folder form beside it
                // when the row is a prefix too, because a reader needs to know both and the label can
                // only say one: `keyRowNames` words both in the declared separator.
                title={names.title}
                onClick={activate}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  // Every auto-repeat of a held key is another keydown, and without this one long
                  // press opened a tab per repeat. Prevented all the same, so it never scrolls.
                  if (event.repeat) return;
                  activate();
                }}
                // The project's own row recipe, plus the database row above this one, so a key two
                // levels down lines up with a table two levels down in the object tree.
                style={{ top, paddingLeft: indent(depth) }}
                className={cn(
                  "absolute inset-x-0 flex h-6 cursor-default select-none items-center gap-1 rounded pr-7 outline-none hover:bg-accent",
                  "focus-visible:ring-1 focus-visible:ring-brand",
                  // A leaf is actionable only when somebody will act on it, so the pointer follows the
                  // wiring rather than the row's kind.
                  (readable || folder) && "cursor-pointer",
                )}
              >
                {folder ? (
                  /*
                   * THE TWISTY IS ITS OWN CONTROL, and it has to be now that a row can be a key as
                   * well as a folder: one press cannot mean both "read this value" and "open these
                   * children". `stopPropagation` keeps the press off the row, and `tabIndex={-1}` is
                   * the object tree's own choice - arrow keys are what a tree gives a keyboard for
                   * this, so a second tab stop per row would be noise rather than access.
                   *
                   * `-m-1.5 p-1.5` grows the target to 26 by 26 around the 14px glyph without moving
                   * anything, which is the measurement `TreeRow` records for its own twisty.
                   */
                  <button
                    type="button"
                    data-testid="key-browser-twisty"
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${names.toggle}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFolder(node);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="-m-1.5 flex h-3.5 w-3.5 box-content shrink-0 items-center justify-center rounded-sm p-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand"
                  >
                    <ChevronRight
                      strokeWidth={1.5}
                      className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                    />
                  </button>
                ) : (
                  // A leaf keeps the column so labels line up down a level, the way the object tree
                  // pads a row with no twisty.
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                {folder ? (
                  <Folder strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-hue-yellow/70" />
                ) : (
                  <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {/* A row that is a key says the KEY's name, because that is what activating it
                      addresses; a row that is only a prefix says the prefix it stands for. */}
                <span className="truncate font-mono text-xs">{names.label}</span>
                {/*
                    A FOLDER COUNTS THE KEYS THE WALK HOLDS UNDER IT, and a leaf carries no number.

                    THE BADGE IS THE NUMBER THAT MOVES. A prefix's contents grow as pages arrive — the
                    global walk's, and one press of this prefix's own Load more — and the reader's
                    question in front of a folder is "how much is in here". The number of ROWS it opens
                    to is the other half of the same fact, and it is on the tooltip: it is smaller, it
                    is what the child count used to show, and reading it as the amount of data under a
                    prefix is how a folder of 670 keys came to wear a `2`. The `+` in the count's
                    tooltip is the sample's own admission: keys a page has not reached are not counted,
                    and a count that pretended otherwise would be a total nobody read.
                  */}
                {/*
                    A ROW THAT IS BOTH carries BOTH numbers, which is the whole reason this column is
                    two cells rather than one: the type says what the row itself is worth reading as,
                    and the count says how much sits under it. A row that is only one of the two shows
                    only its own, and the type leads so that the count keeps the outer edge every
                    folder's number has.
                  */}
                {folder && node.isKey && (
                  <span
                    data-testid="key-browser-type"
                    className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground"
                  >
                    {types.get(name) ?? ""}
                  </span>
                )}
                {folder ? (
                  <span
                    data-testid="key-browser-folder-count"
                    className={cn(
                      "shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground",
                      !node.isKey && "ml-auto",
                    )}
                    title={
                      levels
                        ? levelBadgeTitle(node)
                        : `${node.count.toLocaleString("en-US")} key${node.count === 1 ? "" : "s"} loaded under this prefix so far, in ${node.children.length} row${node.children.length === 1 ? "" : "s"}`
                    }
                  >
                    {levels ? levelBadge(node) : node.count.toLocaleString("en-US")}
                  </span>
                ) : (
                  /*
                    A LEAF'S TYPE, in the same right-hand column the folders use for their count, so
                    one edge carries "what this row is" for every row.
                    
                    NOTHING IS DRAWN WHEN THE SERVER HAS NOT SAID. The type travels with the page the
                    key arrived in, so this is empty only where a page could not describe its keys —
                    and an empty cell is the honest drawing, since a guess here would be a claim about
                    the value that nobody made.
                  */
                  <span
                    data-testid="key-browser-type"
                    className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground"
                  >
                    {types.get(name) ?? ""}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
