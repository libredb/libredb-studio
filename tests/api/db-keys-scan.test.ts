/**
 * `POST /api/db/keys/scan`
 *
 * The walk a caller drives, and the refusals that stand between a caller and a provider that has
 * no key space to walk. The suite below is deliberately heavier on REFUSALS than on the happy
 * path, because a route whose only job is to forward four fields has exactly one interesting
 * question per field: what it does when the field is absent, malformed, or out of range.
 *
 * The mocks are inline rather than in a shared helper, and the request is built by
 * `createMockRequest` with the session supplied by a mocked `@/lib/auth`. That is the one pattern
 * every file under `tests/api/` already uses — bun's `mock.module()` is scoped per test FILE, so
 * hoisting these into a helper breaks re-application (`tests/api/db/schema-list.test.ts`).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { DatabaseProvider, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  TimeoutError,
  QueryError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";

let activeProvider: DatabaseProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => activeProvider);

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }) as unknown);
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection ?? { id: "seed-1", name: "Seeded", type: "postgres" };
    }),
    SeedConnectionError,
  };
});

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

const scanRoute = await import("@/app/api/db/keys/scan/route");

const CONNECTION = { id: "conn-1", name: "Local Redis", type: "redis", host: "127.0.0.1", port: 6380 };

/** The batch sizes a Redis-shaped provider declares, so a bound exists to be exceeded. */
const DECLARED = { defaultCount: 500, maxCount: 1000 };

const PAGE: KeyScanPage = {
  keys: ["app:env", "app:cache:ttl"],
  cursor: "2",
  total: 31,
  types: { "app:env": "string", "app:cache:ttl": "string" },
};

/**
 * A provider that declares the walk, with the walk itself supplied per test.
 *
 * `walk` is undefined for the tests that check the DECLARATION WITHOUT THE METHOD — the state an
 * external implementer of the published interface can genuinely be in, and the one the route
 * names rather than letting a TypeError stand in for it.
 */
function declaringProvider(walk?: (options: KeyScanOptions) => Promise<KeyScanPage>): DatabaseProvider {
  // Redis's own container level beside its walk (`redis.ts`'s `REDIS_CONTAINER_LEVELS`): the route takes
  // `database` only from an engine that declares a level to name (spec 3.4).
  const provider = createMockProvider({
    type: "redis",
    capabilities: {
      keyScan: DECLARED,
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
    },
  });
  if (walk !== undefined) provider.scanKeysPage = mock(walk);
  return provider;
}

/**
 * Post a body and read the answer back.
 *
 * `T` is the caller's, and it is the reason this is generic: `parseResponseJSON<T>()` types its
 * result as `T`, and `toEqual` will not compare a `T` against a bare `Record<string, unknown>`. The
 * success case names `KeyScanPage`; every refusal case keeps the default, because a refusal body is
 * read field by field.
 */
async function post<T = Record<string, unknown>>(body: Record<string, unknown>) {
  const response = await scanRoute.POST(
    createMockRequest("/api/db/keys/scan", { method: "POST", body: { connection: CONNECTION, ...body } }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<T>(response) };
}

beforeEach(() => {
  clearRateLimitState();
  mockGetSession.mockClear();
  mockGetOrCreateProvider.mockClear();
  activeProvider = createMockProvider();
});

describe("POST /api/db/keys/scan", () => {
  test("refuses an engine with no key space to walk, in this route's own words", async () => {
    activeProvider = createMockProvider({ type: "postgres" });

    const { status, body } = await post({});

    expect(status).toBe(400);
    expect(body.error).toContain("postgres declares no key-space walk");
    // The refusal names WHY, because "unsupported" on its own reads as a missing feature rather
    // than as the fact that a catalog-backed engine has nothing here to page.
    expect(body.error).toContain("enumerated from a catalog");
  });

  test("refuses a declaration with no method behind it, rather than crashing on it", async () => {
    // The state a third-party implementer is really in the moment they declare the capability:
    // without this branch the route would call `undefined` and answer a 500 from a TypeError,
    // which reads like a crash instead of like the named defect it is.
    activeProvider = declaringProvider();

    const { status, body } = await post({});

    expect(status).toBe(500);
    expect(body.error).toBe("redis declares keyScan but implements no scanKeysPage");
  });

  test("answers the page the walk returned", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    const { status, body } = await post<KeyScanPage>({});

    expect(status).toBe(200);
    expect(body).toEqual(PAGE);
  });

  test("starts a walk when no cursor is given, and forwards the one it is given", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    await post({});
    // ABSENT MEANS START. A caller with no cursor has one thing to mean by that, and requiring
    // them to spell "0" would make the first press of a Scan button an error to be fixed.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: undefined });

    await post({ cursor: "17" });
    // The cursor is OPAQUE and passes through untouched: this provider never parses one, and a
    // route that parsed or re-derived it would break the moment Redis changed its spelling.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "17", pattern: undefined, count: 500, database: undefined });
  });

  test("refuses a cursor that is not a decimal one", async () => {
    activeProvider = declaringProvider(async () => PAGE);

    const { status, body } = await post({ cursor: "not-a-cursor" });

    expect(status).toBe(400);
    expect(body.error).toContain('"cursor" must be a decimal cursor');
  });

  test("forwards a pattern, trimmed", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    await post({ pattern: "  app:*  " });

    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: "app:*", count: 500, database: undefined });
  });

  test("refuses an empty pattern rather than forwarding a match-nothing", async () => {
    activeProvider = declaringProvider(async () => PAGE);

    const { status, body } = await post({ pattern: "   " });

    expect(status).toBe(400);
    expect(body.error).toContain('"pattern" must be a non-empty string');
  });

  test("defaults the batch size from the declaration and forwards one the caller names", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    await post({});
    // The default is the DECLARATION's, not a number written into this route: two defaults for
    // one engine is how a panel and its provider come to disagree about what a batch is.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: undefined });

    await post({ count: 50 });
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 50, database: undefined });
  });

  test("refuses a batch size that is not a positive integer", async () => {
    activeProvider = declaringProvider(async () => PAGE);

    for (const count of [0, -1, 1.5, "10", null, true]) {
      const { status, body } = await post({ count });
      expect({ count, status }).toEqual({ count, status: 400 });
      expect(body.error).toContain('"count" must be a positive integer');
    }
  });

  test("refuses a batch size above the declared maximum instead of clamping it", async () => {
    activeProvider = declaringProvider(async () => PAGE);

    const { status, body } = await post({ count: 1001 });

    expect(status).toBe(400);
    // Clamping would answer 1001 with a batch of 1000 and say nothing, which is a wrong answer
    // about what a batch is. The refusal names the bound so the caller can pick a legal one.
    expect(body.error).toContain('"count" must be at most 1000');
  });

  test("accepts the declared maximum itself, which is a bound and not a wall", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    const { status, body } = await post<KeyScanPage>({ count: 1000 });

    expect(status).toBe(200);
    expect(body).toEqual(PAGE);
    // Forwarded as the caller's own number and not clamped down to the DEFAULT, so the bound
    // above is the only thing a legal batch can hit: a route that capped at `maxCount - 1` would
    // answer a 1000-key page with half of it and the refusal above would never be reached.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 1000, database: undefined });
  });

  test("forwards the database the caller names and leaves it absent otherwise", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    await post({ database: 3 });
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: 3 });

    await post({});
    // Absent rather than 0: which database the session is in is the CONNECTION's state, and this
    // route does not hold it. Answering 0 here would silently walk database 0 for a session
    // sitting in another one.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: undefined });
  });

  test("forwards database 0 as a database, and does not read it back as absent", async () => {
    const walk = mock(async () => PAGE);
    activeProvider = declaringProvider(walk);

    const { status, body } = await post<KeyScanPage>({ database: 0 });

    expect(status).toBe(200);
    expect(body).toEqual(PAGE);
    // 0 is a REAL Redis database, and the test above is what makes this non-vacuous: absent
    // forwards `undefined`, so a truthiness check anywhere along this line - `database ||
    // undefined`, an `if (database)` - would walk the session's database instead of database 0
    // and answer about keys the caller did not ask for. Every other value the route refuses is
    // refused for the opposite reason (a negative index or a non-integer), so 0 is the one legal
    // number a coercion loses while the refusal list stays green.
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: 0 });
  });

  test("refuses a database index that is not a non-negative integer", async () => {
    activeProvider = declaringProvider(async () => PAGE);

    for (const database of [-1, 1.5, "3", null, true]) {
      const { status, body } = await post({ database });
      expect({ database, status }).toEqual({ database, status: 400 });
      expect(body.error).toContain('"database" must be a non-negative integer');
    }
  });
});

/**
 * The route in a declared shape (spec 3.4, 4.6): an etcd-shaped provider walks a byte-ordered key
 * space with an opaque cursor and a literal prefix, and names no database in it.
 */
describe("POST /api/db/keys/scan in a declared shape", () => {
  const ETCD_SCAN = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "walk",
  } as const;
  const ETCD_PAGE: KeyScanPage = {
    keys: ["/app/a"],
    cursor: "k:L2FwcC9i:12:9",
    total: 9,
    types: {},
    skipped: { count: 1, reason: "a key that is not UTF-8 text has no name a row could carry." },
  };

  /** An etcd-shaped provider: the walk declared in its shape, and no container level (spec 4.1). */
  function prefixProvider(walk: (options: KeyScanOptions) => Promise<KeyScanPage>): DatabaseProvider {
    const provider = createMockProvider({ type: "etcd", capabilities: { keyScan: ETCD_SCAN, containerLevels: [] } });
    provider.scanKeysPage = mock(walk);
    return provider;
  }

  test("forwards an opaque cursor exactly as the previous page wrote it", async () => {
    const walk = mock(async () => ETCD_PAGE);
    activeProvider = prefixProvider(walk);

    const { status, body } = await post<KeyScanPage>({ cursor: "k:L2FwcC9i:12:9" });

    expect(status).toBe(200);
    // The page travels as the provider answered it, `skipped` included.
    expect(body).toEqual(ETCD_PAGE);
    expect(walk).toHaveBeenLastCalledWith({
      cursor: "k:L2FwcC9i:12:9",
      pattern: undefined,
      count: 500,
      database: undefined,
    });

    // Nothing is trimmed or read: a cursor only its provider can read is handed over as it came, spaces
    // included, and that provider refuses one it did not write.
    for (const cursor of [" k:L2FwcC9i:12:9 ", "  "]) {
      await post({ cursor });
      expect(walk).toHaveBeenLastCalledWith({ cursor, pattern: undefined, count: 500, database: undefined });
    }
  });

  test('passes a page through with total 0 for a declaration whose totalScope is "none"', async () => {
    const uncountedScan = { ...ETCD_SCAN, totalScope: "none" } as const;
    const uncountedPage: KeyScanPage = { keys: ["/app/a", "/app/b"], cursor: "k:L2FwcC9i:h", total: 0, types: {} };
    const walk = mock(async () => uncountedPage);
    const provider = createMockProvider({
      type: "etcd",
      capabilities: { keyScan: uncountedScan, containerLevels: [] },
    });
    provider.scanKeysPage = mock(walk);
    activeProvider = provider;

    const { status, body } = await post<KeyScanPage>({});

    expect(status).toBe(200);
    // The route neither reads nor replaces the total: 0 travels as the provider answered it.
    expect(body).toEqual(uncountedPage);
    expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern: undefined, count: 500, database: undefined });
  });

  test("refuses an opaque cursor that is not a non-empty string", async () => {
    activeProvider = prefixProvider(async () => ETCD_PAGE);

    for (const cursor of ["", 17, null, true]) {
      const { status, body } = await post({ cursor });
      expect({ cursor, status }).toEqual({ cursor, status: 400 });
      expect(body.error).toBe('"cursor" must be the cursor the previous page answered with');
    }
  });

  test("forwards a prefix as typed, untrimmed and unescaped", async () => {
    const walk = mock(async () => ETCD_PAGE);
    activeProvider = prefixProvider(walk);

    // Review Focus 1: a space at either end, both quotes, a newline, `#`, `$`, a glob metacharacter and
    // a leading `-` are bytes of the prefix, and a trimmed one would walk a different range.
    for (const pattern of [" a/", "/-a b'\"\n#$[x]/", "  "]) {
      await post({ pattern });
      expect(walk).toHaveBeenLastCalledWith({ cursor: "0", pattern, count: 500, database: undefined });
    }
  });

  test("refuses an empty prefix or one that is not a string", async () => {
    activeProvider = prefixProvider(async () => ETCD_PAGE);

    for (const pattern of ["", 5, null]) {
      const { status, body } = await post({ pattern });
      expect({ pattern, status }).toEqual({ pattern, status: 400 });
      expect(body.error).toBe('"pattern" must be a non-empty string');
    }
  });

  test("refuses a database on an engine that walks one key space, in this route's own words", async () => {
    const walk = mock(async () => ETCD_PAGE);
    activeProvider = prefixProvider(walk);

    for (const database of [0, 3]) {
      const { status, body } = await post({ database });
      expect({ database, status }).toEqual({ database, status: 400 });
      expect(body.error).toBe(
        'etcd walks one key space and declares no database level: "database" names the numbered database to walk, and this engine has none to name',
      );
    }
    // Refused before the walk: no page is read for a question the engine cannot answer.
    expect(walk).not.toHaveBeenCalled();
  });

  test("refuses a database on a one-key-space engine in the database's words even beside a bad level", async () => {
    const walk = mock(async () => ETCD_PAGE);
    activeProvider = prefixProvider(walk);

    // The answer this request had before "level" existed: a level field must not reorder the refusals.
    const { status, body } = await post({ database: 0, level: false });
    expect(status).toBe(400);
    expect(body.error).toBe(
      'etcd walks one key space and declares no database level: "database" names the numbered database to walk, and this engine has none to name',
    );
    expect(walk).not.toHaveBeenCalled();
  });
});

/**
 * The route for an engine that lists its key space one level at a time (Keys panel levels, spec 3.3).
 *
 * The double declares `levels` in the only shape the route accepts, an uncounted prefix walk, and its
 * type id is only the word the sentences carry: no provider in the fleet declares `levels` here.
 */
describe("POST /api/db/keys/scan for one level", () => {
  const LEVEL_SCAN = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "none",
    levels: { rootKind: "bucket" },
  } as const;
  const ETCD_LIKE = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "walk",
  } as const;
  const OXIA_LIKE = { ...ETCD_LIKE, totalScope: "none" } as const;
  const EMPTY_LEVEL: KeyScanPage = { keys: [], prefixes: [], cursor: "0", total: 0, types: {} };

  /** A provider with the given walk declaration and no container level, its walk supplied per test. */
  function levelProvider(
    walk: (options: KeyScanOptions) => Promise<KeyScanPage>,
    keyScan: Record<string, unknown> = LEVEL_SCAN,
    type: "oxia" | "etcd" = "oxia",
  ): DatabaseProvider {
    const provider = createMockProvider({
      type,
      capabilities: { keyScan: keyScan as never, containerLevels: [] },
    });
    provider.scanKeysPage = mock(walk);
    return provider;
  }

  /** The options object the walk was last handed, read whole so a key added with `undefined` shows. */
  function lastOptions(walk: { mock: { calls: unknown[][] } }): Record<string, unknown> {
    const call = walk.mock.calls.at(-1);
    if (call === undefined) throw new Error("the walk was never called");
    return call[0] as Record<string, unknown>;
  }

  test("forwards exactly today's four keys, with no level key, to a Redis, an etcd and an Oxia walk", async () => {
    const shapes = [
      {
        type: "redis",
        keyScan: { defaultCount: 500, maxCount: 1000 },
        containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      },
      { type: "etcd", keyScan: ETCD_LIKE, containerLevels: [] },
      { type: "oxia", keyScan: OXIA_LIKE, containerLevels: [] },
    ] as const;
    for (const shape of shapes) {
      const walk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => PAGE);
      const provider = createMockProvider({
        type: shape.type,
        capabilities: { keyScan: shape.keyScan, containerLevels: shape.containerLevels },
      });
      provider.scanKeysPage = mock(walk);
      activeProvider = provider;

      const { status } = await post({});

      expect({ type: shape.type, status }).toEqual({ type: shape.type, status: 200 });
      // `toEqual` ignores a property whose value is `undefined`, so the keys are read by name and the
      // object compared strictly: a `level: undefined` key would pass the existing cases and fail here.
      expect(Object.keys(lastOptions(walk)).sort()).toEqual(["count", "cursor", "database", "pattern"]);
      expect(lastOptions(walk)).toStrictEqual({ cursor: "0", pattern: undefined, count: 500, database: undefined });
    }
  });

  test("forwards level: true with the prefix untrimmed", async () => {
    const walk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => EMPTY_LEVEL);
    activeProvider = levelProvider(walk);

    const { status } = await post({ level: true, pattern: " sales/" });

    expect(status).toBe(200);
    expect(lastOptions(walk)).toStrictEqual({
      cursor: "0",
      pattern: " sales/",
      count: 500,
      database: undefined,
      level: true,
    });
  });

  test("refuses a level that is present and not true", async () => {
    const walk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => EMPTY_LEVEL);
    activeProvider = levelProvider(walk);

    for (const level of [false, "true", 1, null]) {
      const { status, body } = await post({ level });
      expect({ level, status }).toEqual({ level, status: 400 });
      expect(body.error).toBe('"level" must be true, or absent for a walk of keys only');
    }
    expect(walk).not.toHaveBeenCalled();
  });

  test("refuses level: true on an engine that declares no folder listing", async () => {
    const redisWalk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => PAGE);
    activeProvider = declaringProvider(redisWalk);
    const redis = await post({ level: true });
    expect(redis.status).toBe(400);
    expect(redis.body.error).toBe(
      'redis declares no folder listing: its walk pages keys only, so "level" has nothing to ask for',
    );

    const etcdWalk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => PAGE);
    activeProvider = levelProvider(etcdWalk, ETCD_LIKE, "etcd");
    const etcd = await post({ level: true });
    expect(etcd.status).toBe(400);
    expect(etcd.body.error).toBe(
      'etcd declares no folder listing: its walk pages keys only, so "level" has nothing to ask for',
    );

    expect(redisWalk).not.toHaveBeenCalled();
    expect(etcdWalk).not.toHaveBeenCalled();
  });

  test("answers 500 for levels declared on a walk that is not an uncounted prefix walk, on every request", async () => {
    const sentence =
      'oxia declares levels on a walk that is not an uncounted prefix walk: levels need pattern "prefix" and totalScope "none"';
    for (const keyScan of [
      { ...LEVEL_SCAN, pattern: "glob" },
      { ...LEVEL_SCAN, totalScope: "walk" },
    ]) {
      const walk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => EMPTY_LEVEL);
      activeProvider = levelProvider(walk, keyScan);
      for (const body of [{ level: true }, {}]) {
        const answer = await post(body);
        expect({ keyScan, body, status: answer.status }).toEqual({ keyScan, body, status: 500 });
        expect(answer.body.error).toBe(sentence);
      }
      expect(walk).not.toHaveBeenCalled();
    }
  });

  test("forwards exactly four keys and answers a key page on a level double asked without level", async () => {
    const keysOnly: KeyScanPage = { keys: ["sales/2026/orders.csv"], cursor: "0", total: 0, types: {} };
    const walk = mock<(options: KeyScanOptions) => Promise<KeyScanPage>>(async () => keysOnly);
    activeProvider = levelProvider(walk);

    const { status, body } = await post<KeyScanPage>({ pattern: "sales/" });

    expect(status).toBe(200);
    expect(body).toStrictEqual(keysOnly);
    expect(Object.keys(lastOptions(walk)).sort()).toEqual(["count", "cursor", "database", "pattern"]);
    expect(lastOptions(walk)).toStrictEqual({ cursor: "0", pattern: "sales/", count: 500, database: undefined });
  });

  test("answers a Redis page larger than its count unchanged, because a key walk is never counted", async () => {
    const big: KeyScanPage = {
      keys: Array.from({ length: 1200 }, (_, index) => `k:${index}`),
      cursor: "5",
      total: 1200,
      types: {},
    };
    activeProvider = declaringProvider(async () => big);

    const { status, body } = await post<KeyScanPage>({ count: 1000 });

    expect(status).toBe(200);
    expect(body).toStrictEqual(big);
    expect("prefixes" in body).toBe(false);
  });

  test("answers 500 for folder prefixes on a walk that asked for keys only", async () => {
    const stray: KeyScanPage = { keys: ["a/x"], prefixes: ["a/b/"], cursor: "0", total: 0, types: {} };

    activeProvider = levelProvider(async () => stray);
    const level = await post({});
    expect(level.status).toBe(500);
    expect(level.body.error).toBe("oxia answered folder prefixes to a walk that asked for keys only");

    activeProvider = declaringProvider(async () => stray);
    const redis = await post({});
    expect(redis.status).toBe(500);
    expect(redis.body.error).toBe("redis answered folder prefixes to a walk that asked for keys only");
  });

  test("answers 500, in its own sentence, for each level answer outside the level it was asked for", async () => {
    const cases: Array<{ page: Partial<KeyScanPage>; error: string }> = [
      { page: { prefixes: ["b/x/"] }, error: 'oxia answered a folder outside the level it was asked for: "b/x/"' },
      { page: { prefixes: ["a/x"] }, error: 'oxia answered a folder outside the level it was asked for: "a/x"' },
      { page: { prefixes: ["a/"] }, error: 'oxia answered a folder outside the level it was asked for: "a/"' },
      { page: { prefixes: ["a/x/y/"] }, error: 'oxia answered a folder outside the level it was asked for: "a/x/y/"' },
      { page: { prefixes: ["a/x/", "a/x/"] }, error: 'oxia answered the folder "a/x/" twice on one level page' },
      { page: { keys: ["a/x/y"] }, error: 'oxia answered a key outside the level it was asked for: "a/x/y"' },
      { page: { keys: ["b"] }, error: 'oxia answered a key outside the level it was asked for: "b"' },
      {
        page: { keys: Array.from({ length: 1000 }, (_, index) => `a/k${index}`), prefixes: ["a/x/"] },
        error: "oxia answered 1001 entries to a level page of at most 1000",
      },
    ];
    for (const { page, error } of cases) {
      activeProvider = levelProvider(async () => ({ ...EMPTY_LEVEL, ...page }));
      const answer = await post({ level: true, pattern: "a/", count: 1000 });
      expect({ error, status: answer.status }).toEqual({ error, status: 500 });
      expect(answer.body.error).toBe(error);
    }
  });

  test("ends a folder at the first separator after the pattern, even where two occurrences overlap", async () => {
    const twoCharacters = { ...LEVEL_SCAN, separator: "::" };
    // "x:::" holds its first "::" at index 1: the level's folder is "x::", and "x:::" is one level deeper.
    const outside = [
      { request: { level: true }, prefix: "x:::" },
      { request: { level: true, pattern: "a::" }, prefix: "a::x:::" },
    ];
    for (const { request, prefix } of outside) {
      activeProvider = levelProvider(async () => ({ ...EMPTY_LEVEL, prefixes: [prefix] }), twoCharacters);
      const answer = await post(request);
      expect({ prefix, status: answer.status }).toEqual({ prefix, status: 500 });
      expect(answer.body.error).toBe(
        `oxia answered a folder outside the level it was asked for: ${JSON.stringify(prefix)}`,
      );
    }
    const inside = [
      { request: { level: true }, prefix: "x::" },
      { request: { level: true, pattern: "a::" }, prefix: "a::x::" },
    ];
    for (const { request, prefix } of inside) {
      activeProvider = levelProvider(async () => ({ ...EMPTY_LEVEL, prefixes: [prefix] }), twoCharacters);
      const answer = await post(request);
      expect({ prefix, status: answer.status }).toEqual({ prefix, status: 200 });
    }
  });

  test("answers 500 for the same key twice on one level page", async () => {
    activeProvider = levelProvider(async () => ({ ...EMPTY_LEVEL, keys: ["a/x", "a/y", "a/x"] }));
    const answer = await post({ level: true, pattern: "a/" });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe('oxia answered the key "a/x" twice on one level page');
  });

  test("answers 500 for an empty key on the top level, where no folder marker can be empty", async () => {
    activeProvider = levelProvider(async () => ({ ...EMPTY_LEVEL, keys: [""] }));
    const answer = await post({ level: true });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe('oxia answered a key outside the level it was asked for: ""');
  });

  test("answers level pages that keep to their level unchanged", async () => {
    const cases: Array<{ request: Record<string, unknown>; page: KeyScanPage }> = [
      // The top level, with no pattern.
      {
        request: { level: true },
        page: { keys: ["readme"], prefixes: ["sales/", "/"], cursor: "0", total: 0, types: {} },
      },
      // A key equal to the pattern: an object store's folder marker.
      { request: { level: true, pattern: "a/" }, page: { ...EMPTY_LEVEL, keys: ["a/"] } },
      // An empty segment is a folder of its own.
      { request: { level: true, pattern: "a/" }, page: { ...EMPTY_LEVEL, prefixes: ["a//"] } },
      // A pattern that ends mid-segment.
      {
        request: { level: true, pattern: "sales/2026/ord" },
        page: {
          keys: ["sales/2026/orders.csv"],
          prefixes: ["sales/2026/ord-archive/"],
          cursor: "c1",
          total: 0,
          types: {},
        },
      },
      // A level page with no prefixes field at all.
      { request: { level: true, pattern: "a/" }, page: { keys: ["a/x"], cursor: "0", total: 0, types: {} } },
    ];
    for (const { request, page } of cases) {
      activeProvider = levelProvider(async () => page);
      const answer = await post<KeyScanPage>(request);
      expect({ request, status: answer.status }).toEqual({ request, status: 200 });
      expect(answer.body).toStrictEqual(page);
    }
  });
});
