import { NextRequest } from "next/server";
import { handleObjectRequest, ObjectRouteError, optionalDatabase, requireString } from "@/lib/api/object-route";
import { containerDepth } from "@/lib/db/object-kinds";
import {
  keyScanShape,
  type KeyScanCapability,
  type KeyScanOptions,
  type KeyScanPage,
  type KeyScanShape,
} from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * One page of a resumable walk of an engine's own key space.
 *
 * WHY THIS IS NOT AN OBJECT ROUTE. `listObjects` answers a whole folder in one call and is
 * finite by definition, which is true of every catalog-backed engine and false of a Redis key
 * space: there is no prefix index to list from, only `SCAN`, and `SCAN` answers a cursor
 * rather than a listing. A caller that stops at one page holds a SAMPLE, and the only way to
 * hold more is to come back with the cursor it was given. That is a different contract, so it
 * is a different route rather than a flag on an existing one — `includeColumns`-style options
 * on the object routes are exactly how a whole-database eager read got built once before.
 *
 * THE CALLER OWNS THE CURSOR, so this route holds no session and a page costs one round trip.
 * Nothing is cached between two calls, which is what makes `Scan more` a button rather than a
 * state machine, and what lets a cursor survive a reload: a Redis cursor is a position in a
 * hash table, not a handle on this process.
 *
 * THE GATE IS THE DECLARATION, NOT THE METHOD. `getCapabilities().keyScan` is what says this
 * engine has a key space to walk, and it is checked first so a Postgres connection is refused
 * in the route's own words rather than by a provider error from somewhere further down.
 *
 * THE PAIR IS CHECKED TOO, AND IT IS NOT DEAD CODE HERE. `ProviderCapabilities` and
 * `DatabaseProvider` are both published (`src/exports/types.ts`), so an external implementer
 * can declare `keyScan` before writing `scanKeysPage`; that is a real intermediate state, and
 * without this branch it would arrive as a TypeError reading like a crash instead of as the
 * named defect it is. A first-party provider cannot reach it, and a provider test keeps that
 * true.
 *
 * NO DEFAULTS ARE INVENTED FOR A BAD BATCH SIZE. `count` above `maxCount` is refused rather
 * than clamped: clamping would answer a request for 10,000 with 1,000 and say nothing, and the
 * caller can always ask again. `count` is optional, and its default comes from the provider's
 * own declaration rather than from a number written here — two defaults for one engine is how
 * a panel and its provider come to disagree about what a batch is.
 *
 * THE CURSOR AND THE PATTERN ARE READ IN THE DECLARED SHAPE (spec 3.4, 4.6), and neither is parsed. A
 * `decimal` cursor, Redis's, is shape-checked as a run of digits: Redis cursors are opaque, and their
 * decimal spelling is an implementation detail (`SCAN` also accepts `MATCH`-independent reverse-binary
 * forms on a rehashing table), so the check refuses an obviously malformed one in this route's own
 * words while leaving the value itself untouched on the way through. An `opaque` cursor, etcd's, is
 * any non-empty string, passed through as it came, because only the provider that wrote it can read
 * it and that provider refuses one it did not write. A `glob` pattern is trimmed and forwarded; a
 * `prefix` pattern is forwarded as typed, because it is bytes and ` a/` is a different range from
 * `a/`.
 *
 * `database` IS TAKEN ONLY WHERE THERE IS ONE TO NAME. It names the numbered database a walk reads,
 * so an engine that declares a walk and no container level (etcd, whose connection is one key space)
 * is refused it in this route's own words rather than handed a number it has no use for (spec 3.4).
 * `containerDepth` is the rule the Keys panel applies before it sends one at all.
 *
 * `level: true` ASKS FOR ONE LEVEL, AND A LEVEL PAGE IS CHECKED BEFORE IT IS ANSWERED (Keys panel levels, spec 3.3).
 * Only an engine that declares `levels` takes it, and only on an uncounted prefix walk; any other value is refused, and a request without it forwards exactly the four fields it always did.
 * The panel draws each folder a level page answers as complete for its level, so a folder from another level, or one drawn twice, would be a wrong tree with no visible error.
 * Every prefix must therefore sit exactly one separator under the pattern and appear once, every key must sit directly under the pattern, and the page must hold no more entries than the `count` it was asked for.
 * A key walk must carry no prefixes at all, and its count is never checked, because a Redis `SCAN` page may hold more keys than `COUNT`.
 * The page itself is answered unchanged.
 *
 * Budget: shared, through `handleObjectRequest`, with the object routes and `POST /api/db/query`
 * (`src/lib/api/object-route.ts`). A walk a person drives with a progress bar spends the same
 * allowance their statements do, which is why `Scan all` loops client-side on this route rather
 * than asking the server for one unbounded walk.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/keys/scan", async (provider, body) => {
    const capabilities = provider.getCapabilities();
    const capability = capabilities.keyScan;
    if (capability === undefined) {
      throw new ObjectRouteError(
        `${provider.type} declares no key-space walk: its objects are enumerated from a catalog, so there is nothing to page`,
        400,
      );
    }

    const walk = provider.scanKeysPage;
    if (walk === undefined) {
      throw new ObjectRouteError(`${provider.type} declares keyScan but implements no scanKeysPage`, 500);
    }

    const shape = keyScanShape(capability);
    // A level declaration on a walk that is not an uncounted prefix walk is a defect of the DECLARATION
    // (Keys panel levels, spec 3.3), so it is refused on every request, whether or not the request asks
    // for a level, in the words the method check above uses for the same kind of state.
    if (capability.levels !== undefined && (shape.pattern !== "prefix" || shape.totalScope !== "none")) {
      throw new ObjectRouteError(
        `${provider.type} declares levels on a walk that is not an uncounted prefix walk: ` +
          `levels need pattern "prefix" and totalScope "none"`,
        500,
      );
    }
    const options = {
      cursor: readCursor(body, shape),
      pattern: readPattern(body, shape),
      count: readCount(body, capability),
      // Absent means the provider's own session database, which is the provider's answer to give:
      // `SELECT` state lives on the connection and not in this route.
      database: optionalDatabase(body, "database"),
    };
    if (options.database !== undefined && containerDepth(capabilities) === 0) {
      throw new ObjectRouteError(
        `${provider.type} walks one key space and declares no database level: "database" names the numbered ` +
          `database to walk, and this engine has none to name`,
        400,
      );
    }
    // Read after the database refusal, so a request that engine refused before "level" existed is
    // refused in the same words now.
    const level = readLevel(body);
    if (level && capability.levels === undefined) {
      throw new ObjectRouteError(
        `${provider.type} declares no folder listing: its walk pages keys only, so "level" has nothing to ask for`,
        400,
      );
    }
    // `level` travels only when asked, so a walk without it hands the provider exactly the four keys it
    // always did, with no `level` key at all.
    const forwarded: KeyScanOptions = { ...options, ...(level ? { level: true as const } : {}) };
    const page = await walk.call(provider, forwarded);
    checkAnswer(provider.type, page, forwarded, shape.separator);
    return page;
  });
}

/**
 * The cursor the previous page answered with; `"0"` starts a walk.
 *
 * Absent means start, because that is what a caller with no cursor has: a `Scan` button and a
 * `Scan more` button differ in whether they pass one, and requiring the caller to spell `"0"` would
 * make the first press of the first button an error to be fixed rather than a walk to be started.
 *
 * Read in the declared shape: a `decimal` cursor must be a run of digits, and an `opaque` one any
 * non-empty string, handed over exactly as it came.
 */
function readCursor(body: Record<string, unknown>, shape: KeyScanShape): string {
  if (body.cursor === undefined) return "0";
  if (shape.cursor === "opaque") {
    if (typeof body.cursor !== "string" || body.cursor === "") {
      throw new ObjectRouteError('"cursor" must be the cursor the previous page answered with', 400);
    }
    return body.cursor;
  }
  const cursor = requireString(body, "cursor");
  if (!/^\d+$/.test(cursor)) {
    throw new ObjectRouteError('"cursor" must be a decimal cursor the previous page answered with', 400);
  }
  return cursor;
}

/**
 * The walk's pattern, or absent for every key. An empty string is refused rather than passed.
 *
 * A `glob` pattern is trimmed, as every string this route family reads is; a `prefix` pattern is not,
 * because a prefix is bytes and a space at either end is part of the range it names (spec 4.6).
 */
function readPattern(body: Record<string, unknown>, shape: KeyScanShape): string | undefined {
  if (body.pattern === undefined) return undefined;
  if (shape.pattern === "glob") return requireString(body, "pattern");
  if (typeof body.pattern !== "string" || body.pattern === "") {
    throw new ObjectRouteError('"pattern" must be a non-empty string', 400);
  }
  return body.pattern;
}

/**
 * The batch size, defaulted from the provider's declaration and bounded by it.
 *
 * `Number.isSafeInteger` rather than a truthiness test: `0`, `-1`, `1.5` and `NaN` are all
 * real values a caller can send, and a fractional `COUNT` is not something Redis accepts
 * meaningfully even though its parser would take it.
 */
function readCount(body: Record<string, unknown>, capability: KeyScanCapability): number {
  if (body.count === undefined) return capability.defaultCount;
  const count = body.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    throw new ObjectRouteError('"count" must be a positive integer', 400);
  }
  if (count > capability.maxCount) {
    throw new ObjectRouteError(
      `"count" must be at most ${capability.maxCount}, which is the batch size this engine declares`,
      400,
    );
  }
  return count;
}

/**
 * Whether the caller asks for ONE LEVEL of the key space (Keys panel levels, spec 3.3).
 *
 * Absent means a walk of keys, the walk every engine answers. Only the literal `true` asks for a level:
 * `false`, `"true"`, `1` and `null` are values a caller can send, and reading any of them as a choice
 * would forward a question the caller did not spell.
 */
function readLevel(body: Record<string, unknown>): boolean {
  if (body.level === undefined) return false;
  if (body.level !== true) {
    throw new ObjectRouteError('"level" must be true, or absent for a walk of keys only', 400);
  }
  return true;
}

/**
 * Hold a provider's answer to the level contract, or name how it broke it (Keys panel levels, spec 3.3).
 *
 * A key walk's page is never counted here: a Redis `SCAN` page may hold more keys than `COUNT`.
 * A level page is held to its level: with `p` the pattern (or `""`) and `s` the separator, a prefix
 * starts with `p` and ends at the first `s` found from the end of `p`, which also makes it end with `s`
 * and hold no `s` before that one, overlapping occurrences of a longer separator included;
 * no prefix appears twice; a key starts with `p` and holds no `s` after it (a key equal to `p`, a folder
 * marker, passes); no key appears twice; and keys and prefixes together fit in `count`.
 */
function checkAnswer(type: string, page: KeyScanPage, options: KeyScanOptions, separator: string): void {
  if (options.level !== true) {
    if (page.prefixes !== undefined) {
      throw new ObjectRouteError(`${type} answered folder prefixes to a walk that asked for keys only`, 500);
    }
    return;
  }
  const pattern = options.pattern ?? "";
  const prefixes = page.prefixes ?? [];
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    // Searching from the end of the pattern, not between it and the last separator: "x:::" under "::"
    // holds no "::" in "x:", yet its first one starts at index 1, so its level's folder is "x::".
    const inLevel =
      prefix.startsWith(pattern) && prefix.indexOf(separator, pattern.length) === prefix.length - separator.length;
    if (!inLevel) {
      throw new ObjectRouteError(
        `${type} answered a folder outside the level it was asked for: ${JSON.stringify(prefix)}`,
        500,
      );
    }
    if (seen.has(prefix)) {
      throw new ObjectRouteError(`${type} answered the folder ${JSON.stringify(prefix)} twice on one level page`, 500);
    }
    seen.add(prefix);
  }
  const seenKeys = new Set<string>();
  for (const key of page.keys) {
    if (!key.startsWith(pattern) || key.slice(pattern.length).includes(separator)) {
      throw new ObjectRouteError(
        `${type} answered a key outside the level it was asked for: ${JSON.stringify(key)}`,
        500,
      );
    }
    if (seenKeys.has(key)) {
      throw new ObjectRouteError(`${type} answered the key ${JSON.stringify(key)} twice on one level page`, 500);
    }
    seenKeys.add(key);
  }
  const entries = page.keys.length + prefixes.length;
  if (entries > options.count) {
    throw new ObjectRouteError(`${type} answered ${entries} entries to a level page of at most ${options.count}`, 500);
  }
}
