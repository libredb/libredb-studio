/**
 * The Keys panel's level page over an OPC UA address space (#1677).
 *
 * ONE LEVEL IS ONE BROWSE, which is the whole difference from the MQTT provider. MQTT has no
 * command that lists topics, so a read is a subscription and a window and a sample. OPC UA has
 * Browse, so a level page is one request about one node and it is never a sample: measured, a
 * single Browse of the busiest node under `i=85` answered its 100 children in one call.
 *
 * THE LEVEL IS ADDRESSED BY RE-BROWSING FROM THE ROOT, not by translating the path in one call.
 * `TranslateBrowsePathToNodeIds` would do it in one request, measured at 4 ms against 5 ms for
 * walking down level by level at depth 4, but it is not one of the eight services O-S1 allows and
 * O-S1's value is that the list is exhaustive. At the fixture's measured depth of 7 the walk costs seven
 * Browses and about 10 ms on loopback, which is a page a reader waits on once per folder they open.
 *
 * A CURSOR IS NOT A CONTINUATION POINT. The level contract wants a cursor valid in every process
 * serving the connection; a continuation point is session state, and a scarce one (OPC PLC allows
 * 10 at once, asyncua hands none back at all). So every continuation point this module receives is
 * consumed inside the same request, or released, and the cursor it answers with is a name.
 *
 * THE THREE CURSOR SPELLINGS ARE THE ROUTE'S, NOT THIS MODULE'S, and getting that wrong broke the
 * panel while every test here passed. `"0"` starts a level and `"0"` ends one - the route sends it
 * for the first press (`route.ts` `readCursor`) and `use-key-scan.ts` treats `page.cursor === "0"`
 * as the ONLY end-of-walk signal, so a level that ended with `""` left every button enabled
 * forever and the next press was answered HTTP 400. Between those two, a cursor of ours is
 * `after:<entry>`: prefixed, because an entry of a level can itself be named `0` and a bare `0`
 * would then read as the end of the level it was in the middle of; and `opaque` is declared, so the
 * route hands the string back to us exactly as it came.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { errorForStatus } from "./errors";
import type { KeyScanCapability, KeyScanPage } from "@/lib/db/types";
import type { OpcuaNodeId, OpcuaReadOnlyClient, OpcuaReference, OpcuaServerLimits } from "./client";
import { browseChunkSize, chunked } from "./limits";
import {
  OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS,
  OPCUA_BROWSE_LEVEL_MAX_REFERENCES,
  OPCUA_OBJECTS_FOLDER,
  OPCUA_TYPE,
} from "./constants";
import { OPCUA_PATH_SEPARATOR, pathKey, pathSegments } from "./node-id";

/** Batch size a page accepts, and the most it will answer. */
const OPCUA_KEY_SCAN_DEFAULT_COUNT = 200;
const OPCUA_KEY_SCAN_MAX_COUNT = 1_000;

/**
 * The route's start and end sentinel, and the prefix every cursor of ours carries.
 *
 * `"0"` is the contract's word for both ends (`KeyScanOptions.cursor` and `KeyScanPage.cursor` in
 * `src/lib/db/types.ts`), which is why a cursor of ours is never a bare entry name: a node really
 * can be called `0`.
 */
const OPCUA_LEVEL_END = "0";
const OPCUA_LEVEL_CURSOR_PREFIX = "after:";

/** What the root level is called in a sentence, since its own prefix is the empty string. */
const OPCUA_OBJECTS_LEVEL = "Objects";

/**
 * What the panel is told about this walk.
 *
 * `totalScope: "none"`: a server publishes no count of its nodes, and a number produced from what
 * one Browse happened to return would be a total with nothing behind it. `pattern: "prefix"`,
 * because a path key is a literal prefix and not a glob. `levels` with no `rootKind`, because the
 * walk's first segment is `Objects` and no row of another kind stands for it.
 */
export const OPCUA_KEY_SCAN: KeyScanCapability = Object.freeze({
  defaultCount: OPCUA_KEY_SCAN_DEFAULT_COUNT,
  maxCount: OPCUA_KEY_SCAN_MAX_COUNT,
  separator: OPCUA_PATH_SEPARATOR,
  // Opaque, because a LEVEL cursor is `after:<the last entry returned>` and not a number: the
  // contract asks for start-after semantics so a level that changes order between calls neither
  // skips an entry nor repeats one, and an ordinal into a list re-browsed each time cannot promise
  // that. An `opaque` declaration is also what makes the route hand our own spelling back to us.
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "none",
  levels: {},
});

/**
 * Which of a level's rows really hold children, measured by browsing them.
 *
 * A SERVER PUBLISHES NO SUCH FLAG, and the ONE place that matters is this one: a row drawn as a
 * folder that opens empty is a lie the reader pays for with a click, and a leaf that really has
 * children hides them. Part 4's ReferenceDescription carries the node id, the browse name, the
 * display name, the node class, the reference type and the type definition - nothing about
 * children - so the only way to know is to ask, which is what this does: one extra Browse round
 * over the level, in chunks the server will take.
 *
 * IT IS ASKED ABOUT THE PAGE AND NOT THE LEVEL, which is the difference between a bounded cost and
 * one that grows with the server. Measured on a level 10,000 children wide - the width the Milo
 * demo server really has, recorded in `walk.ts` - asking about every child cost 501 Browse requests
 * to answer one page of 200 rows, and the whole 501 again on the next page: paging that one folder
 * was about 25,000 requests. Asked about the slice instead, a page of 200 is 10 requests at 20
 * nodes each whatever the level holds, which is why `levelSlice` runs first and this runs on what
 * it returned.
 *
 * The alternative, deriving it from the node class, draws every Variable as a folder - measured on
 * this repository's own in-process server, `Plant/Temperature` came out a folder with nothing
 * inside it.
 *
 * Methods are never asked about: they are listed and never browsed, and asking would spend a
 * request to learn what O-S1 already decided.
 */
export async function childBearingNodes(
  client: OpcuaReadOnlyClient,
  rows: readonly { readonly nodeId: OpcuaNodeId; readonly nodeClass: string }[],
  limits: OpcuaServerLimits = {},
): Promise<ReadonlySet<OpcuaNodeId>> {
  const asked = rows.filter((row) => row.nodeClass !== "Method").map((row) => row.nodeId);
  const bearing = new Set<OpcuaNodeId>();
  for (const batch of chunked(asked, browseChunkSize(limits))) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps the load on the server fixed.
    const answers = await client.browse(batch);
    for (const [at, answer] of answers.entries()) {
      const nodeId = batch[at];
      if (nodeId === undefined) continue;
      // A continuation point means there are more children than one answer carried, which is
      // itself the answer to "does it have any": released, because the page never follows it.
      if (answer.continuationPoint !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the release follows the answer that handed back the point.
        await client.releaseBrowseContinuationPoints([answer.continuationPoint]);
      }
      if (answer.references.length > 0) bearing.add(nodeId);
    }
  }
  return bearing;
}

/**
 * What a level row is, before it becomes a page.
 *
 * `nodeId` travels with the row because the panel's next request names the PATH and this module
 * would otherwise have to walk down to it again to read its value.
 */
export interface OpcuaLevelRow {
  readonly key: string;
  readonly nodeId: OpcuaNodeId;
  readonly nodeClass: string;
}

/**
 * The node one path names, found by browsing down from `i=85` one segment at a time.
 *
 * A segment is matched on its BrowseName's name, which is what a path key's segments are made of.
 * A segment that matches nothing is a config error rather than an empty page: the reader asked for
 * a folder that is not there, and an empty list would say the folder exists and is empty.
 *
 * TWO PARENTS ARE NOT A PROBLEM HERE, and that is the point of addressing by path. Re-measured on
 * the documented fixture: 41 of its 6,769 nodes hang off more than one parent - 39 of them twice,
 * two of them thirty times - so a node has more than one path; each path resolves to the same node,
 * and the row the reader opened is the row they get back.
 */
export async function resolvePath(client: OpcuaReadOnlyClient, segments: readonly string[]): Promise<OpcuaNodeId> {
  let current: OpcuaNodeId = OPCUA_OBJECTS_FOLDER;
  for (const [depth, want] of segments.entries()) {
    // The WHOLE level, not the first answer: a child whose reference lands on a later page would
    // otherwise read as absent, and the continuation point would be left held. `browseLevel` is the
    // one function that follows and releases them, so the walk down uses it too.
    // oxlint-disable-next-line no-await-in-loop -- one segment at a time: each Browse starts from the node the one before it answered.
    const references = await browseLevel(client, current);
    const hit = references.find((reference) => reference.browseName === want);
    if (hit === undefined) {
      /*
       * WHAT THE READER CAN ACT ON COMES FIRST, and for a path typed into the prefix box that is
       * usually their own spelling. The sentence used to offer one cause only - "the address space
       * may have changed since this folder was opened" - which is the right guess for a folder the
       * panel opened minutes ago and the wrong one for `telemetry` typed where the server named
       * `Telemetry`: measured in a browser, typing a lower-case segment answered a paragraph about
       * the server changing. So a name on this level that differs only in case or surrounding space
       * is NAMED, and the general cause stays for when there is no such name.
       */
      const near = references.find(
        (reference) => reference.browseName.trim().toLowerCase() === want.trim().toLowerCase(),
      );
      const where = segments.slice(0, depth).join(OPCUA_PATH_SEPARATOR) || "Objects";
      throw new DatabaseConfigError(
        near === undefined
          ? `No node named ${want} under ${where}. A browse name is matched exactly, and the address space may also ` +
              "have changed since this folder was opened; reading the level above it again shows what is there now."
          : `No node named ${want} under ${where}. This level holds ${near.browseName}, which differs from it only ` +
              "in case or spacing, and a browse name is matched exactly.",
        OPCUA_TYPE,
      );
    }
    current = hit.nodeId;
  }
  return current;
}

/**
 * Every child of one node, following hierarchical references and consuming every continuation
 * point the server hands back inside this one call.
 *
 * The release path matters as much as the follow path: measured, OPC PLC allows ten browse
 * continuation points at once across the whole session, which a plant's own SCADA clients share.
 * A page that stopped early without releasing would hold one until the session closed.
 *
 * A REFUSED BROWSE IS NOT AN EMPTY NODE, and nothing here read the difference. A Browse answers
 * per node: measured on the documented fixture, `ns=9;s=NoSuchNode` came back with status
 * `BadNodeIdUnknown` and an EMPTY reference list, which this function returned as `[]` - so a
 * folder the reader could not be told about opened as a folder with nothing in it, and the walk
 * down a path reported "No node named X" for a level the server had refused outright. The status is
 * now read before the references, as the history read already does.
 *
 * A SERVER THAT NEVER STOPS PAGING IS STOPPED HERE. Past `OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS` continued pages, or
 * once the level holds more than `OPCUA_BROWSE_LEVEL_MAX_REFERENCES` references with a point still to follow, the
 * point is handed back and the level is refused rather than shown in part.
 */
export async function browseLevel(
  client: OpcuaReadOnlyClient,
  nodeId: OpcuaNodeId,
): Promise<readonly OpcuaReference[]> {
  const [first] = await client.browse([nodeId]);
  if (first === undefined) return [];
  requireBrowsed(first.statusCode);
  const references: OpcuaReference[] = [...first.references];
  let point = first.continuationPoint;
  let continued = 0;
  while (point !== undefined) {
    if (continued >= OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS || references.length > OPCUA_BROWSE_LEVEL_MAX_REFERENCES) {
      // oxlint-disable-next-line no-await-in-loop -- the one point still held, handed back before the refusal.
      await client.releaseBrowseContinuationPoints([point]);
      throw new QueryError(OPCUA_LEVEL_PAST_BOUND, OPCUA_TYPE);
    }
    continued += 1;
    // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it, in order.
    const [next] = await client.browseNext([point]);
    if (next === undefined) break;
    requireBrowsed(next.statusCode);
    references.push(...next.references);
    point = next.continuationPoint;
  }
  return references;
}

/** The refusal of a level the server kept listing past either bound, in Studio's words. */
const OPCUA_LEVEL_PAST_BOUND =
  `The server kept listing this node's references past what one level takes (more than ` +
  `${OPCUA_BROWSE_LEVEL_MAX_REFERENCES.toLocaleString("en-US")} references, or more than ` +
  `${OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS} continued pages), so the level is refused rather than shown in part. ` +
  "Studio handed the server's continuation point back.";

/**
 * The server's own answer about one Browse, read rather than assumed.
 *
 * `Good` and every `Good...` variant pass, and so does `Uncertain...`, which carries references
 * worth drawing. Anything else is the server refusing, and the error table turns it into a sentence
 * the reader can act on - `BadNodeIdUnknown` says a saved `ns=` id may address nothing after a
 * restart, which is the likeliest cause of a refused level.
 */
function requireBrowsed(statusCode: string): void {
  if (statusCode.startsWith("Good") || statusCode.startsWith("Uncertain")) return;
  throw errorForStatus(statusCode);
}

/**
 * The level a pattern names, and the text its entries must begin with.
 *
 * TWO PATTERNS REACH HERE AND ONLY ONE OF THEM ENDS WITH THE SEPARATOR. The panel sends a folder's
 * own prefix when a reader opens it (`OpcPlc/`), and it sends the FILTER BOX verbatim when a reader
 * types in it (`sentPattern` in `src/components/key-browser/tree.ts`), which is how `OpcPlc` with no
 * separator arrives. Measured against the route before this was handled: a pattern of `Plant`
 * listed the children of `Plant/`, whose keys hold a separator after the pattern, and the route
 * answered HTTP 500 blaming the provider for leaving the level it was asked for.
 *
 * So a pattern is split at its LAST separator: everything up to and including it is the level to
 * browse, and the whole pattern is what an entry of that level must begin with. A pattern that
 * already ends with the separator keeps the whole level, which is the folder case, unchanged.
 */
export function levelScope(pattern: string): {
  readonly path: string;
  readonly segments: readonly string[];
} {
  const cut = pattern.lastIndexOf(OPCUA_PATH_SEPARATOR);
  const path = cut === -1 ? "" : pattern.slice(0, cut + 1);
  const segments = pathSegments(path);
  /*
   * AN EMPTY STEP CAN ONLY BE TYPED, NEVER WRITTEN: `escapeSegment` turns a separator inside a
   * browse name into `%2F`, so `A//B/` names no node. Refused here by name, because resolving it
   * asked the server for a child with no name and the answer was the measured "No node named
   * under A", which blames the address space for what a reader typed.
   *
   * THE DOUBLE SEPARATOR IS CHECKED ON THE TEXT, not on the segments, because `pathSegments` pops
   * EVERY trailing empty segment: a typed `A//` lost its empty step before the segment check could
   * see it, the level then resolved to `A`, and no child key of `A` begins with `A//` - so the
   * filter box answered "this folder is empty" for a folder that is not, which is the one failure
   * this whole function exists to prevent.
   */
  if (path.includes(`${OPCUA_PATH_SEPARATOR}${OPCUA_PATH_SEPARATOR}`) || segments.includes("")) {
    throw new DatabaseConfigError(
      `A node path holds no empty step: ${JSON.stringify(pattern)} has a separator with nothing between it and ` +
        "the next one. Type the path with one separator between names.",
      OPCUA_TYPE,
    );
  }
  return { path, segments };
}

/** A page's worth of a level: its rows, the budget they are drawn against, and whether the level ran out. */
export interface OpcuaLevelSlice {
  readonly pattern: string;
  readonly rows: readonly OpcuaLevelRow[];
  /**
   * The entry budget, carried because a row is not always ONE entry: a Variable that bears children
   * is a key AND a folder, and `levelPage` holds the two lists together to this number the way the
   * route does.
   */
  readonly count: number;
  /** True when these rows reach the end of the level, before the budget above is applied. */
  readonly exhausted: boolean;
  /** Nodes left out because the server gave them no browse name, if any were. */
  readonly nameless?: { readonly count: number; readonly reason: string };
}

/**
 * The rows one page of a level holds, chosen before anything is measured about them.
 *
 * ORDER AND CURSOR ARE THIS FUNCTION'S TO MEET, and both are decided on the path KEY alone. Entries
 * are sorted by UTF-8 byte order, which the contract names, and not by JavaScript's UTF-16
 * comparison: the two disagree on every browse name outside the BMP. The cursor names the last key
 * this page returned and the next page starts at the first key AFTER it in that order - after it,
 * rather than at the position following it, so a node deleted between two pages neither restarts
 * the level nor repeats a row.
 *
 * NOTHING HERE DEPENDS ON WHETHER A ROW IS A FOLDER, and that is deliberate: folder-ness costs a
 * Browse per row to measure honestly, so it is measured for these rows only, after this. A cursor
 * that named a folder by its prefix would change spelling the moment that measurement changed, and
 * the row would be served twice.
 */
export function levelSlice(
  pattern: string,
  references: readonly OpcuaReference[],
  options: { readonly cursor: string; readonly count: number },
): OpcuaLevelSlice {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > OPCUA_KEY_SCAN_MAX_COUNT)
    throw new DatabaseConfigError(
      `A page holds 1 to ${OPCUA_KEY_SCAN_MAX_COUNT.toLocaleString("en-US")} nodes.`,
      OPCUA_TYPE,
    );

  const scope = levelScope(pattern);

  /** One row per path key, deduplicated: the contract allows no entry twice on one level page. */
  const byKey = new Map<string, OpcuaLevelRow>();
  let nameless = 0;
  for (const reference of references) {
    /*
     * A NODE THE SERVER GIVES NO NAME HAS NO ROW THAT COULD ADDRESS IT, and one of them used to
     * take the whole level with it. `QualifiedName.name` is `string | null` in the library and
     * `library.ts` substitutes `""` for a null, so the path key became the level's own prefix -
     * `""` at the root - which the route refuses outright: measured through the real route, ONE
     * such reference answered `500 opcua answered a key outside the level it was asked for: ""`
     * for the entire root page, and the Keys panel is this engine's only listing surface. It is
     * left out and counted instead, the way etcd leaves out a key that is not UTF-8 text.
     */
    if (reference.browseName === "") {
      nameless += 1;
      continue;
    }
    const key = pathKey([...scope.segments, reference.browseName]);
    // What a filter box typed is kept and the rest dropped: `Plant` keeps `Plant` and `Plant1` and
    // drops `Pump`, while `Plant/` keeps the whole of that folder's level.
    if (!key.startsWith(pattern)) continue;
    /*
     * A DUPLICATE BROWSE NAME IS ANSWERED ONCE, AND THE ONE THAT WINS CAN HOLD CHILDREN. Part 3
     * does not make a browse name unique among a node's children, and two children of one name
     * produce one path key, so one of them cannot be drawn. Keeping the one that is not a Method
     * loses less - the node ids differ either way, which `docs/providers/opcua.md` section 6.4
     * states as a known cost of naming a node by its path.
     */
    const held = byKey.get(key);
    if (held !== undefined && (held.nodeClass !== "Method" || reference.nodeClass === "Method")) continue;
    byKey.set(key, {
      key,
      nodeId: reference.nodeId,
      nodeClass: reference.nodeClass,
    });
  }

  // UTF-8 byte order, which the contract names: `Buffer.compare` is that order, and `<` is not.
  const sorted = [...byKey.values()].sort((a, b) => byteOrder(a.key, b.key));
  const resume = resumeAt(options.cursor, scope.path, sorted);
  const rows = sorted.slice(resume, resume + options.count);
  return {
    pattern,
    rows,
    count: options.count,
    exhausted: rows.length === 0 || resume + rows.length >= sorted.length,
    ...(nameless === 0
      ? {}
      : {
          nameless: {
            count: nameless,
            reason:
              `${nameless.toLocaleString("en-US")} node${nameless === 1 ? "" : "s"} on this level ` +
              "carry no browse name, and a row has no name to address them by. The server's own node " +
              "ids still read them: name one in a read request.",
          },
        }),
  };
}

/**
 * One level page, to the level-provider contract (`KeyScanLevels` in `src/lib/db/types.ts`).
 *
 * WHAT THE PANEL IS OWED. Two lists: `keys`, the entries directly under the pattern, and
 * `prefixes`, the folders one separator deeper, each ending in the separator. The route refuses a
 * key whose remainder after the pattern holds a separator, refuses a folder that is not exactly one
 * level deeper, refuses either twice, and refuses more than `count` of the two together, so this
 * function answers in that shape or not at all.
 *
 * A ROW CAN BE BOTH, AND ON EVERY OPC UA SERVER ONE IS. `Server/ServerStatus` is a Variable with a
 * structured value AND eight children: drawn as a folder alone it is a twisty and nothing else, so
 * its value - the server's state, start time and build info - can be reached only by someone who
 * already knows to type `{"read":["i=2256"]}` in the console. Measured on OPC PLC 2.15.10 through
 * the real route: `Server/ServerStatus` came back in `prefixes`, never in `keys`, with no entry in
 * `types`, and `KeyBrowser.tsx`'s `readable = node.isKey && onOpenKey !== undefined` was false. The
 * panel is written for the dual row - `tree.ts`'s `keyRowNames` even has a title for one ("X is a
 * key and a folder") - and the route's own checks accept it, so a Variable that bears children is
 * answered in BOTH lists. An Object that bears children is a folder only: it has no Value attribute
 * at all, and reading one answers `BadAttributeIdInvalid`.
 *
 * `folders` is the measurement `childBearingNodes` took of these rows. With none to hand - which is
 * a page built from a capture - no row is a folder, because the alternative is to guess from the
 * node class and that draws Variables as folders that open empty.
 */
export function levelPage(slice: OpcuaLevelSlice, folders: ReadonlySet<OpcuaNodeId> = new Set()): KeyScanPage {
  const keys: string[] = [];
  const prefixes: string[] = [];
  const types: Record<string, string> = {};
  /*
   * THE BUDGET IS COUNTED IN ENTRIES, NOT ROWS, because a dual row is two of them and the route
   * refuses a page whose two lists together exceed `count`. The rows were chosen before any of this
   * was measured - which is what keeps a folder page to ten Browses instead of five hundred - so
   * the tail that no longer fits is dropped here and the cursor names the last row that did.
   */
  let kept: OpcuaLevelRow | undefined;
  let trimmed = false;
  /**
   * What the page read and left out: a node the server gave no name, or the key half of a dual row
   * that did not fit a page of one. Both go in the one field the contract has for it.
   */
  let skipped: { readonly count: number; readonly reason: string } | undefined = slice.nameless;
  for (const row of slice.rows) {
    const folder = folders.has(row.nodeId);
    /*
     * WHICH ROWS OPEN, stated as the rule really is rather than as a claim about classes. A row
     * that is NOT a folder always opens: it is the only way to reach it, and a node with no value
     * of its own says so in its document rather than showing a bare `BadAttributeIdInvalid` - an
     * Object carries no Value attribute at all (Part 3 5.5.1), and `Locations` and `NetworkSet`,
     * both childless Objects, are on the first page the panel draws. A row that IS a folder opens
     * as well when it is a Variable, because then it has a value worth reading beside its children;
     * an Object with children is a folder alone, since opening it would add nothing to the twisty.
     */
    const readable = !folder || row.nodeClass === "Variable";
    const cost = (folder ? 1 : 0) + (readable ? 1 : 0);
    if (keys.length + prefixes.length + cost > slice.count) {
      /*
       * A dual row alone over a page of one: the folder wins, because the twisty is the only way
       * into the subtree and the value is reachable on any page of two or more. The cursor still
       * advances past it, so the walk never stalls - and the page SAYS it left the key out, through
       * the one field the contract has for "read and left out", rather than dropping it in silence.
       */
      if (kept !== undefined) {
        trimmed = true;
        break;
      }
      prefixes.push(`${row.key}${OPCUA_PATH_SEPARATOR}`);
      skipped = {
        count: 1,
        reason:
          `${row.key} is both a node with a value and a folder, which is two entries, and this page holds ` +
          "one. Its folder is here; ask for a page of two or more to see its value as well.",
      };
      kept = row;
      trimmed = true;
      break;
    }
    if (folder) prefixes.push(`${row.key}${OPCUA_PATH_SEPARATOR}`);
    if (readable) {
      keys.push(row.key);
      types[row.key] = row.nodeClass.toLowerCase();
    }
    kept = row;
  }

  return {
    keys,
    prefixes,
    types,
    ...(skipped === undefined ? {} : { skipped }),
    // A server publishes no count of its nodes, so the page carries none.
    total: 0,
    // `"0"` is the contract's end of walk and the only end the panel reads; until then the cursor
    // names the key this page ended on, prefixed so it can never be mistaken for that `"0"`.
    cursor:
      kept === undefined || (slice.exhausted && !trimmed) ? OPCUA_LEVEL_END : `${OPCUA_LEVEL_CURSOR_PREFIX}${kept.key}`,
  };
}

/** UTF-8 byte order over two path keys, which `Buffer.compare` is and `<` is not. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Where a page begins: 0 for a start, and otherwise the first key past the cursor's own.
 *
 * A CURSOR IS BOUND TO ITS LEVEL, which the contract allows and which both peers do (etcd carries a
 * digest, S3 has a sentence of its own for a foreign one). Measured before this was bound: a cursor
 * from a sibling level, `Objects/Z/Q`, was not found among the root's entries, `findIndex` answered
 * -1, `-1 + 1` was 0, and the root's FIRST page came back as the second page of another level - a
 * walk that repeats rows and says nothing. A cursor that is not ours, or not this level's, is now a
 * sentence naming what to do.
 */
function resumeAt(cursor: string, path: string, sorted: readonly OpcuaLevelRow[]): number {
  if (cursor === OPCUA_LEVEL_END) return 0;
  if (!cursor.startsWith(OPCUA_LEVEL_CURSOR_PREFIX)) {
    throw new DatabaseConfigError(
      `This cursor was not written by the OPC UA provider: ${JSON.stringify(cursor)}. Open the folder again to ` +
        "start its level from the top.",
      OPCUA_TYPE,
    );
  }
  const entry = cursor.slice(OPCUA_LEVEL_CURSOR_PREFIX.length);
  const level = keyLevel(entry);
  if (level !== path) {
    throw new DatabaseConfigError(
      `This cursor names an entry of ${JSON.stringify(level || OPCUA_OBJECTS_LEVEL)} and this page is about ` +
        `${JSON.stringify(path || OPCUA_OBJECTS_LEVEL)}. Open the folder again to start its level from the top.`,
      OPCUA_TYPE,
    );
  }
  // Strictly after, by name: a node removed between two pages is simply no longer there, and the
  // page resumes at whatever now follows the name it was told rather than at a position.
  const at = sorted.findIndex((row) => byteOrder(row.key, entry) > 0);
  return at === -1 ? sorted.length : at;
}

/** The level a path key sits in: everything up to and including its last separator, `""` at the root. */
function keyLevel(key: string): string {
  const cut = key.lastIndexOf(OPCUA_PATH_SEPARATOR);
  return cut === -1 ? "" : key.slice(0, cut + 1);
}
