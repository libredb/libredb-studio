import { describe, expect, test } from "bun:test";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { defineOverlay } from "@/lib/agent/languages/overlay";
import type {
  AgentEngineClientOverlay,
  AgentEngineServerOverlay,
  AgentEngineServerOverlays,
  AgentFamilyDialect,
  AgentFamilyDialectRows,
  AgentLanguageServerAdapter,
  ClientDialectOf,
  MemberOverride,
} from "@/lib/agent/languages/pack";
import type { DUCKDB_SERVER_OVERLAY } from "@/lib/agent/languages/sql/engines/duckdb";
import type { POSTGRES_SERVER_OVERLAY } from "@/lib/agent/languages/sql/engines/postgres";
import { SQL_SERVER_PACK } from "@/lib/agent/languages/sql/server";

/**
 * The engine overlay types (#1821), held by the compiler: `bun run typecheck` reads this file, and each
 * `@ts-expect-error` below fails it the day its line compiles, so every case is proven both ways. The runtime
 * assertions only keep the fixtures from being unused.
 */

describe("the engine overlay types", () => {
  test("refuse an overlay that leaves a member out, widens one, or reaches past its dialect", () => {
    const fixtures: readonly unknown[] = [
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `profileComposition` included.
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `planEstimate` included.
        dialect: {
          catalogRead: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `catalogRead` included.
        dialect: {
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `statistics` included.
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          // @ts-expect-error: `undefined` is neither a composition nor "unsupported".
          profileComposition: undefined,
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          // @ts-expect-error: a session mode is the estimating plan's own, never a prefix's.
          planEstimate: { kind: "prefix", mode: "estimate-plan" },
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          // @ts-expect-error: a catalog read composes all four kinds, `statistics` included.
          catalogRead: { compose: { columns: () => "", relations: () => "", indexes: () => "" } },
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          // @ts-expect-error: a statistics reading builds its estimates, whether or not it probes first.
          statistics: { probe: null },
          catalogCapture: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `catalogCapture` included.
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          // @ts-expect-error: a catalog capture maps the engine's kind words, even onto none.
          catalogCapture: { kinds: ["columns"], build: () => new Map() },
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      // @ts-expect-error: a family with no dialect-bound member takes no `dialect`.
      { dialect: { profileComposition: "unsupported" } } as const satisfies AgentEngineServerOverlay<"mongo">,
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
        // @ts-expect-error: a member outside ENGINE_OVERRIDABLE_SERVER_MEMBERS is not overridable (ruling 2).
        toolOverrides: {},
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: the adapter is read by family, so an engine cannot derive its own.
        adapter: (base) => base,
      } as const satisfies AgentEngineServerOverlay<"mongo">,
      {
        // @ts-expect-error: base definitions are merged across families by name, so an engine cannot give its own.
        baseDefinitions: {},
      } as const satisfies AgentEngineServerOverlay<"kubectl">,
    ];
    expect(fixtures).toHaveLength(14);
  });

  test("accept an override of a member ENGINE_OVERRIDABLE_SERVER_MEMBERS names, beside a dialect or without one", () => {
    const fixtures: readonly unknown[] = [
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          profileComposition: "unsupported",
          statistics: "unsupported",
          catalogCapture: "unsupported",
        },
        grounding: (base) => base,
      } as const satisfies AgentEngineServerOverlay<"sql">,
      { grounding: (base) => base } as const satisfies AgentEngineServerOverlay<"mongo">,
      {
        workflowToolRules: (base) => base,
        answerNotADataRead: "That is not a read of data.",
      } as const satisfies AgentEngineServerOverlay<"kubectl">,
    ];
    expect(fixtures).toHaveLength(3);
  });

  test("hold a client overlay to what its engine's server overlay supplies", () => {
    type PostgresClient = { readonly dialect: ClientDialectOf<(typeof POSTGRES_SERVER_OVERLAY)["dialect"]> };
    type DuckdbClient = { readonly dialect: ClientDialectOf<(typeof DUCKDB_SERVER_OVERLAY)["dialect"]> };
    const fixtures: readonly unknown[] = [
      {
        dialect: {
          // @ts-expect-error: PostgreSQL's server overlay reads its catalog, so its client cannot say it does not.
          catalogRead: "unsupported",
          planEstimate: "supported",
          catalogCapture: "supported",
        },
      } as const satisfies PostgresClient,
      {
        dialect: {
          catalogRead: "supported",
          planEstimate: "supported",
          // @ts-expect-error: DuckDB's server overlay captures no catalog, so its client cannot claim one.
          catalogCapture: "supported",
        },
      } as const satisfies DuckdbClient,
      {
        dialect: {
          catalogRead: "supported",
          planEstimate: "supported",
          catalogCapture: "supported",
          // @ts-expect-error: a client holds only the members a browser asks about, never a server-only one.
          statistics: "supported",
        },
      } as const satisfies PostgresClient,
      {
        // @ts-expect-error: a SQL client overlay must say every client member, `catalogCapture` included.
        dialect: { catalogRead: "supported", planEstimate: "supported" },
      } as const satisfies AgentEngineClientOverlay<"sql">,
      // @ts-expect-error: a family with no client dialect takes no `dialect`.
      { dialect: { catalogRead: "supported" } } as const satisfies AgentEngineClientOverlay<"kubectl">,
      {
        dialect: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      } as const satisfies DuckdbClient & AgentEngineClientOverlay<"sql">,
    ];
    expect(fixtures).toHaveLength(6);
  });

  test("refuse a registry that misses an engine", () => {
    const sql = {
      dialect: {
        catalogRead: "unsupported",
        planEstimate: "unsupported",
        profileComposition: "unsupported",
        statistics: "unsupported",
        catalogCapture: "unsupported",
      },
    } as const;
    // @ts-expect-error: the registry is total over the engines that speak a statement language, mysql included.
    const missing: AgentEngineServerOverlays = {
      postgres: sql,
      sqlite: sql,
      duckdb: sql,
      mssql: sql,
      mongodb: {},
      kubernetes: {},
    };
    expect(Object.keys(missing)).not.toContain("mysql");
  });

  test("refuse a bare function where a function-valued member can only be derived", () => {
    // @ts-expect-error: a function in an overlay is a derivation from the base, so a bare canonicalize does not type.
    const bare: MemberOverride<AgentLanguageServerAdapter["canonicalize"]> = (raw: unknown) => String(raw);
    const derived: MemberOverride<AgentLanguageServerAdapter["canonicalize"]> = (base) => (raw) => base(raw);
    expect([typeof bare, typeof derived]).toEqual(["function", "function"]);
  });

  test("have one row per family and no default branch", () => {
    type Widened = AgentStatementLanguageId | "gremlin";
    // @ts-expect-error: a fourth language has no row until one is written for it, and a default branch would give it one.
    type Fourth = AgentFamilyDialectRows["gremlin" & Widened];
    const rows: readonly (keyof AgentFamilyDialect)[] = ["sql", "mongo", "kubectl"];
    const fourth: Fourth | undefined = undefined;
    expect([rows.length, fourth]).toEqual([3, undefined]);
  });

  test("accept 'unsupported' for every member, and a dialect laid over a family facet", () => {
    const unsupported = {
      dialect: {
        catalogRead: "unsupported",
        planEstimate: "unsupported",
        profileComposition: "unsupported",
        statistics: "unsupported",
        catalogCapture: "unsupported",
      },
    } as const satisfies AgentEngineServerOverlay<"sql">;
    const overlaid = defineOverlay(SQL_SERVER_PACK, { dialect: unsupported.dialect });
    expect(overlaid.dialect).toBe(unsupported.dialect);
    expect(overlaid.adapter).toBe(SQL_SERVER_PACK.adapter);
  });
});
