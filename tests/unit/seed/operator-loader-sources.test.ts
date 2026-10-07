import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import type {
  OperatorEntry,
  OperatorLoadContext,
  OperatorSource,
  OperatorSourceName,
  OperatorSourceReport,
  OperatorSourceResult,
} from "@/lib/seed/sources/types";
import type { SeedConnection } from "@/lib/seed/types";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

let sources: OperatorSource[] = [];
/** When set, the next enabledOperatorSources() call throws it, once. */
let registryFailure: Error | null = null;
const resetOperatorSourceCaches = mock(() => {});
mock.module("@/lib/seed/sources/registry", () => ({
  enabledOperatorSources: () => {
    const failure = registryFailure;
    registryFailure = null;
    if (failure !== null) throw failure;
    return sources;
  },
  resetOperatorSourceCaches,
}));

mock.module("@/lib/auth", () => ({
  getSession: mock(() => ({ role: "admin", username: "admin@test.com" })),
  verifyJWT: mock(() => ({ role: "admin", username: "admin@test.com" })),
}));

import { getOperatorSourceStatus, loadOperatorSources, resetCache } from "@/lib/seed/operator-loader";
import { resetLiteralModeNotices, UndefinedSeedVariableError } from "@/lib/seed/credential-resolver";
import { OperatorSourceError } from "@/lib/seed/sources/types";
import { GET } from "@/app/api/connections/managed/route";
import { SEED_CONFIG_UNREADABLE_REASON } from "@/hooks/use-connection-payload";

type LoadFn = (context: OperatorLoadContext) => Promise<OperatorSourceResult>;
type FakeSource = { readonly name: OperatorSourceName; readonly load: Mock<LoadFn> };

const ENV_KEYS = [
  "SEED_CONFIG_PATH",
  "SEED_CACHE_TTL_MS",
  "SEED_LITERAL_VALUES",
  "SEED_DISCOVERY_PATH",
  "OPERATOR_SOURCES_PASSWORD",
] as const;
const SKIPPED = "Seed connection skipped due to credential resolution failure";

function fakeSource(name: OperatorSourceName, run: LoadFn): FakeSource {
  return { name, load: mock(run) };
}

function entry(id: string, origin: string, extra: Partial<SeedConnection> = {}, literal = false): OperatorEntry {
  const connection: SeedConnection = {
    id,
    name: `Name ${id}`,
    type: "postgres",
    host: `${id}.internal`,
    roles: ["admin"],
    ...extra,
  };
  return { connection, literal, origin };
}

function ok(entries: OperatorEntry[], extra: Partial<OperatorSourceResult> = {}): OperatorSourceResult {
  return { entries, skips: [], notes: [], status: { state: "ok" }, ...extra };
}

/** A promise the test opens by hand, so a fill can be held while another starts. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const connectedIds = (reports: readonly OperatorSourceReport[]): string[] =>
  reports.flatMap((report) => report.connected.map((conn) => conn.id));

const refusal = () =>
  new OperatorSourceError(
    "refused",
    "SEED_CONNECTION_X_URL and SEED_CONNECTION_X_URL_FROM are both set: set one of them",
  );

describe("operator-loader with several sources", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    sources = [];
    registryFailure = null;
    resetCache();
    resetLiteralModeNotices();
    for (const logger of [debug, info, warn, error, resetOperatorSourceCaches]) logger.mockClear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    sources = [];
    resetCache();
  });

  it("loads nothing, and reports nothing, when no source is enabled", async () => {
    const load = await loadOperatorSources();

    expect(load.entries).toEqual([]);
    expect(load.skips).toEqual([]);
    expect([...load.declaredIds]).toEqual([]);
    expect(load.reports).toEqual([]);
    expect(await getOperatorSourceStatus()).toEqual([]);
  });

  it("runs the sources one after the other, in order, and reports each", async () => {
    process.env.SEED_CONFIG_PATH = "/seed/a.yaml";
    const held = gate();
    const first = fakeSource("SEED_CONFIG_PATH", async () => {
      await held.opened;
      return ok([entry("a", "/seed/a.yaml"), entry("b", "/seed/a.yaml")]);
    });
    const second = fakeSource("SEED_CONNECTION", async () =>
      ok([entry("c", "SEED_CONNECTION_C_URL", {}, true)], {
        notes: [{ kind: "ignored-variable", name: "SEED_CONNECTION_C_PORT" }],
      }),
    );
    sources = [first, second];

    const pending = loadOperatorSources();
    await Promise.resolve();
    await Promise.resolve();
    expect(second.load).not.toHaveBeenCalled();
    held.open();
    const load = await pending;

    expect(first.load).toHaveBeenCalledWith({ literalValues: false });
    expect(second.load).toHaveBeenCalledWith({ literalValues: false });
    expect(load.entries.map((item) => item.connection.id)).toEqual(["a", "b", "c"]);
    expect([...load.declaredIds]).toEqual(["a", "b", "c"]);
    expect(load.reports).toEqual([
      {
        source: "SEED_CONFIG_PATH",
        location: "/seed/a.yaml",
        state: "ok",
        checkedAt: expect.any(String),
        error: null,
        connected: [
          { id: "a", name: "Name a", type: "postgres" },
          { id: "b", name: "Name b", type: "postgres" },
        ],
        skipped: [],
        notes: [],
      },
      {
        source: "SEED_CONNECTION",
        location: null,
        state: "ok",
        checkedAt: expect.any(String),
        error: null,
        connected: [{ id: "c", name: "Name c", type: "postgres" }],
        skipped: [],
        notes: [{ kind: "ignored-variable", name: "SEED_CONNECTION_C_PORT" }],
      },
    ]);
  });

  it("keeps the earlier ok source and records the failing one, throws, and reads again on the next call", async () => {
    let broken = true;
    const first = fakeSource("SEED_CONFIG_PATH", async () => ok([entry("a", "/seed/a.yaml")]));
    const second = fakeSource("SEED_CONNECTION", async () => {
      if (broken) throw refusal();
      return ok([entry("x", "SEED_CONNECTION_X_URL")]);
    });
    sources = [first, second];
    process.env.SEED_CACHE_TTL_MS = "60000";

    const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);
    expect(failure).toBeInstanceOf(OperatorSourceError);

    const status = await getOperatorSourceStatus();
    expect(status.map((report) => [report.source, report.state, report.error])).toEqual([
      ["SEED_CONFIG_PATH", "ok", null],
      ["SEED_CONNECTION", "error", { code: "refused", message: (failure as Error).message }],
    ]);
    expect(status[1]).toMatchObject({ location: null, connected: [], skipped: [], notes: [] });

    broken = false;
    const load = await loadOperatorSources();
    expect(load.entries.map((item) => item.connection.id)).toEqual(["a", "x"]);
    // Two failed fills and one good one: a failure is never served from the cache.
    expect(first.load).toHaveBeenCalledTimes(3);
    expect((await getOperatorSourceStatus()).map((report) => report.state)).toEqual(["ok", "ok"]);
  });

  it("fails GET /api/connections/managed with the seed-config reason while a later source throws, and lists once it reads", async () => {
    let broken = true;
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => ok([entry("first", "/seed/first.yaml")])),
      fakeSource("SEED_CONNECTION", async () => {
        if (broken) throw refusal();
        return ok([entry("x", "SEED_CONNECTION_X_URL")]);
      }),
    ];

    const failed = await GET();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "Failed to load managed connections",
      reason: SEED_CONFIG_UNREADABLE_REASON,
    });

    broken = false;
    const listed = await GET();
    expect(listed.status).toBe(200);
    expect((await listed.json()).connections.map((c: { seedId: string }) => c.seedId)).toEqual(["first", "x"]);
  });

  it("still reports the sources after a failing one, then throws the first error and caches nothing", async () => {
    process.env.SEED_CACHE_TTL_MS = "60000";
    const first = fakeSource("SEED_CONFIG_PATH", async () => {
      throw refusal();
    });
    const second = fakeSource("SEED_CONNECTION", async () =>
      ok([entry("u", "SEED_CONNECTION_U_URL", { password: "${OPERATOR_SOURCES_UNSET}" })], {
        notes: [{ kind: "ignored-variable", name: "SEED_CONNECTION_U_PORT" }],
      }),
    );
    const third = fakeSource("SEED_CONFIG_INLINE", async () => {
      throw new TypeError("second failure");
    });
    sources = [first, second, third];

    const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);

    // The first error is the one thrown; the later sources ran for their status only.
    expect(failure).toBeInstanceOf(OperatorSourceError);
    expect(second.load).toHaveBeenCalledTimes(1);
    expect(third.load).toHaveBeenCalledTimes(1);
    const status = await getOperatorSourceStatus();
    expect(status.map((report) => [report.source, report.state, report.error?.code ?? null])).toEqual([
      ["SEED_CONFIG_PATH", "error", "refused"],
      ["SEED_CONNECTION", "empty", null],
      ["SEED_CONFIG_INLINE", "error", "unreadable"],
    ]);
    expect(status[1]?.skipped.map((skip) => [skip.id, skip.variable])).toEqual([["u", "OPERATOR_SOURCES_UNSET"]]);
    expect(status[1]?.notes).toEqual([{ kind: "ignored-variable", name: "SEED_CONNECTION_U_PORT" }]);
    // The status read filled again: a failed fill is never served from the cache.
    expect(first.load).toHaveBeenCalledTimes(2);
  });

  it("refuses one id from two sources, naming both origins, on the second source", async () => {
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => ok([entry("shared", "/seed/a.yaml")])),
      fakeSource("SEED_CONNECTION", async () => ok([entry("shared", "SEED_CONNECTION_SHARED_URL")])),
    ];

    const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OperatorSourceError);
    expect((failure as OperatorSourceError).code).toBe("duplicate-id");
    expect((failure as Error).message).toBe(
      'Seed connection id "shared" is declared by both /seed/a.yaml and SEED_CONNECTION_SHARED_URL',
    );
    expect((await getOperatorSourceStatus()).map((report) => [report.source, report.state])).toEqual([
      ["SEED_CONFIG_PATH", "ok"],
      ["SEED_CONNECTION", "error"],
    ]);
  });

  it("refuses one id from two files of one source, naming both files", async () => {
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => ok([entry("dup", "/seed/a.yaml"), entry("dup", "/seed/b.yaml")])),
    ];

    const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);

    expect((failure as Error).message).toBe(
      'Seed connection id "dup" is declared by both /seed/a.yaml and /seed/b.yaml',
    );
    expect((await getOperatorSourceStatus())[0]?.error?.code).toBe("duplicate-id");
  });

  it("lists a source's own skips and notes, keeps the missing state, and calls a source empty when resolution dropped all", async () => {
    process.env.SEED_CONFIG_PATH = "/seed/absent.yaml";
    const sourceSkip = { id: "v", origin: "SEED_CONNECTION", reason: "no URL given" };
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => ({ entries: [], skips: [], notes: [], status: { state: "missing" } })),
      fakeSource("SEED_CONNECTION", async () =>
        ok([entry("u", "SEED_CONNECTION_U_URL", { password: "${OPERATOR_SOURCES_UNSET}" })], {
          skips: [sourceSkip],
          notes: [{ kind: "ignored-parameter", origin: "SEED_CONNECTION_U_URL", name: "application_name" }],
        }),
      ),
    ];

    const load = await loadOperatorSources();

    const resolutionSkip = {
      id: "u",
      origin: "SEED_CONNECTION_U_URL",
      reason: "Environment variable OPERATOR_SOURCES_UNSET is not defined",
      variable: "OPERATOR_SOURCES_UNSET",
      field: "password",
    };
    expect(load.entries).toEqual([]);
    expect(load.skips).toEqual([sourceSkip, resolutionSkip]);
    expect([...load.declaredIds].sort()).toEqual(["u", "v"]);
    expect(load.reports.map((report) => [report.source, report.location, report.state])).toEqual([
      ["SEED_CONFIG_PATH", "/seed/absent.yaml", "missing"],
      ["SEED_CONNECTION", null, "empty"],
    ]);
    expect(load.reports[1]?.skipped).toEqual([sourceSkip, resolutionSkip]);
    expect(load.reports[1]?.notes).toEqual([
      { kind: "ignored-parameter", origin: "SEED_CONNECTION_U_URL", name: "application_name" },
    ]);
    const logged = (error.mock.calls as unknown[][]).filter((call) => call[0] === SKIPPED);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toBeInstanceOf(UndefinedSeedVariableError);
    expect(logged[0]?.[2]).toEqual({ route: "seed/operator-loader", connectionId: "u" });
  });

  it("resolves a non-literal entry and passes a literal one through as written", async () => {
    process.env.OPERATOR_SOURCES_PASSWORD = "resolved";
    sources = [
      fakeSource("SEED_CONNECTION", async () =>
        ok([
          entry("resolved", "SEED_CONNECTION_RESOLVED_URL", { password: "${OPERATOR_SOURCES_PASSWORD}" }),
          entry("literal", "SEED_CONNECTION_LITERAL_URL", { password: "${OPERATOR_SOURCES_PASSWORD}" }, true),
        ]),
      ),
    ];

    const load = await loadOperatorSources();

    expect(load.entries.map((item) => [item.connection.id, item.literal, item.connection.password])).toEqual([
      ["resolved", false, "resolved"],
      ["literal", true, "${OPERATOR_SOURCES_PASSWORD}"],
    ]);
  });

  it("records a raw error as unreadable and a thrown non-Error by its text", async () => {
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => {
        throw new TypeError("raw failure");
      }),
    ];
    await loadOperatorSources().catch(() => undefined);
    expect((await getOperatorSourceStatus())[0]?.error).toEqual({ code: "unreadable", message: "raw failure" });

    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => {
        throw "not an error object";
      }),
    ];
    await loadOperatorSources().catch(() => undefined);
    expect((await getOperatorSourceStatus())[0]?.error).toEqual({ code: "unreadable", message: "not an error object" });
  });

  it("records an error other than an undefined variable during resolution on its source", async () => {
    const connection = { id: "g", name: "Getter", type: "postgres", roles: ["admin"] } as SeedConnection;
    Object.defineProperty(connection, "password", {
      enumerable: true,
      get() {
        throw new TypeError("getter failed");
      },
    });
    sources = [
      fakeSource("SEED_CONNECTION", async () => ok([{ connection, literal: false, origin: "SEED_CONNECTION_G_URL" }])),
    ];

    const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(TypeError);
    expect((await getOperatorSourceStatus())[0]).toMatchObject({
      source: "SEED_CONNECTION",
      state: "error",
      error: { code: "unreadable", message: "getter failed" },
    });
  });

  it("never leaves a fill whose source list threw in flight, so the next call fills again", async () => {
    process.env.SEED_CONFIG_PATH = "/seed/a.yaml";
    sources = [fakeSource("SEED_CONFIG_PATH", async () => ok([entry("a", "/seed/a.yaml")]))];
    const thrown = new Error("the source registry failed");
    registryFailure = thrown;

    await expect(loadOperatorSources()).rejects.toBe(thrown);

    const load = await loadOperatorSources();
    expect(load.entries.map((loaded) => loaded.connection.id)).toEqual(["a"]);
    expect(sources[0]?.load).toHaveBeenCalledTimes(1);
  });

  it("drops the previous load when the source list throws, so a clock that steps back fills again", async () => {
    process.env.SEED_CACHE_TTL_MS = "60000";
    process.env.SEED_CONFIG_PATH = "/seed/a.yaml";
    sources = [fakeSource("SEED_CONFIG_PATH", async () => ok([entry("a", "/seed/a.yaml")]))];
    const T0 = 1_800_000_000_000;
    let clock = T0;
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await loadOperatorSources();

      const thrown = new Error("the source registry failed");
      registryFailure = thrown;
      clock = T0 + 60_000;
      await expect(loadOperatorSources()).rejects.toBe(thrown);

      // Inside the first fill's TTL again: the failed fill must not leave the old load to be served.
      clock = T0 + 30_000;
      await loadOperatorSources();
      expect(sources[0]?.load).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  describe("a fill that something newer superseded (Review Focus A1.1)", () => {
    beforeEach(() => {
      process.env.SEED_CACHE_TTL_MS = "60000";
    });

    it("stores nothing when resetCache() superseded it and it settles after the newer fill", async () => {
      const held = gate();
      let call = 0;
      const source = fakeSource("SEED_CONFIG_PATH", async () => {
        call += 1;
        if (call === 1) {
          await held.opened;
          return ok([entry("old", "/seed/old.yaml")]);
        }
        return ok([entry("new", "/seed/new.yaml")]);
      });
      sources = [source];

      const superseded = loadOperatorSources();
      resetCache();
      const fresh = await loadOperatorSources();
      held.open();
      await superseded;

      expect(await loadOperatorSources()).toBe(fresh);
      expect(connectedIds(await getOperatorSourceStatus())).toEqual(["new"]);
      expect(source.load).toHaveBeenCalledTimes(2);
    });

    it("stores nothing when resetCache() superseded it and it settles before the newer fill", async () => {
      const oldGate = gate();
      const newGate = gate();
      let call = 0;
      const source = fakeSource("SEED_CONFIG_PATH", async () => {
        call += 1;
        if (call === 1) {
          await oldGate.opened;
          return ok([entry("old", "/seed/old.yaml")]);
        }
        await newGate.opened;
        return ok([entry("new", "/seed/new.yaml")]);
      });
      sources = [source];

      const superseded = loadOperatorSources();
      resetCache();
      const newer = loadOperatorSources();
      oldGate.open();
      await superseded;
      // Had the old fill stored its load, this call would be a cache hit on it; it joins the newer fill instead.
      const during = loadOperatorSources();
      newGate.open();

      const fresh = await newer;
      expect(await during).toBe(fresh);
      expect(connectedIds(fresh.reports)).toEqual(["new"]);
      expect(connectedIds(await getOperatorSourceStatus())).toEqual(["new"]);
      expect(source.load).toHaveBeenCalledTimes(2);
    });

    it("keeps the newer status when a superseded fill fails after the newer one succeeded", async () => {
      const held = gate();
      let call = 0;
      sources = [
        fakeSource("SEED_CONFIG_PATH", async () => {
          call += 1;
          if (call === 1) {
            await held.opened;
            throw refusal();
          }
          return ok([entry("new", "/seed/new.yaml")]);
        }),
      ];

      const superseded = loadOperatorSources();
      resetCache();
      await loadOperatorSources();
      held.open();
      await superseded.catch(() => undefined);

      expect((await getOperatorSourceStatus()).map((report) => [report.state, report.error])).toEqual([["ok", null]]);
    });

    it("stores nothing when a literal-mode flip superseded it", async () => {
      const held = gate();
      const source = fakeSource("SEED_CONFIG_PATH", async (context) => {
        if (!context.literalValues) await held.opened;
        return ok([entry(context.literalValues ? "literal" : "resolved", "/seed/a.yaml", {}, context.literalValues)]);
      });
      sources = [source];

      const superseded = loadOperatorSources();
      process.env.SEED_LITERAL_VALUES = "true";
      const literal = await loadOperatorSources();
      held.open();
      await superseded;

      expect(await loadOperatorSources()).toBe(literal);
      expect(connectedIds(await getOperatorSourceStatus())).toEqual(["literal"]);
      expect(source.load.mock.calls.map(([context]) => context.literalValues)).toEqual([false, true]);
    });
  });

  it("clears the status cache and every source-level state on resetCache()", async () => {
    process.env.SEED_CACHE_TTL_MS = "0";
    sources = [fakeSource("SEED_CONFIG_PATH", async () => ok([entry("a", "/seed/a.yaml")]))];
    expect(connectedIds(await getOperatorSourceStatus())).toEqual(["a"]);

    const held = gate();
    sources = [
      fakeSource("SEED_CONFIG_PATH", async () => {
        await held.opened;
        return ok([entry("b", "/seed/b.yaml")]);
      }),
    ];
    const pending = getOperatorSourceStatus();
    resetCache();
    held.open();

    // The superseded fill stored nothing, and the reset dropped the earlier status: nothing is left to show.
    expect(await pending).toEqual([]);
    expect(resetOperatorSourceCaches).toHaveBeenCalledTimes(1);
  });
});
