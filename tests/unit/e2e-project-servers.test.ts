import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { typeIdRefusal } from "@/lib/db/type-id";
import { SAMPLES } from "@/lib/seed/samples";
import basePathConfig from "../../playwright.base-path.config";
import config from "../../playwright.config";

// Every spec signs in as the same shared account, and the server keeps one "query" rate-limit
// bucket per account per process (src/lib/api/rate-limit.ts, 120 requests a minute by default), so a
// spec that reaches a db route late in file order can meet a budget the specs before it spent. On CI
// run 36263561882, e2e/kafka-provider.spec.ts got "Too many requests. Try again in 38 seconds."
// on all three attempts of its Test Connection check. Such a spec runs against the second server
// process instead, whose counters only it and the other specs listed below touch;
// this pins that choice. Since then playwright.config.ts raises the bucket to 10000 on the main
// server too (pinned further down), so the budget alone no longer sends a new spec here.

const SECOND_SERVER = `http://localhost:${Number(process.env.E2E_OFFLINE_PORT ?? 3010)}`;
const SECOND_SERVER_SPECS = [
  "mtconnect-provider.spec.ts",
  "modbus-provider.spec.ts",
  "offline-editor.spec.ts",
  "kafka-provider.spec.ts",
  "etcd-provider.spec.ts",
  "neo4j-provider.spec.ts",
  "milvus-provider.spec.ts",
  "qdrant-provider.spec.ts",
  "weaviate-provider.spec.ts",
  "influxdb-providers.spec.ts",
  "oxia-provider.spec.ts",
  "databend-provider.spec.ts",
  "snowflake-provider.spec.ts",
  "spark-provider.spec.ts",
  "s3-provider.spec.ts",
  "kubernetes-provider.spec.ts",
  "firestore-connection.spec.ts",
  "rabbitmq-provider.spec.ts",
  "mqtt-provider.spec.ts",
  "unknown-provider-connection.spec.ts",
];

type Project = NonNullable<typeof config.projects>[number];

const patterns = (value: Project["testMatch"] | Project["testIgnore"]): RegExp[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((pattern) => {
    if (!(pattern instanceof RegExp)) throw new Error(`expected a RegExp, got ${String(pattern)}`);
    return pattern;
  });

const matches = (value: Project["testMatch"] | Project["testIgnore"], file: string): boolean =>
  patterns(value).some((pattern) => pattern.test(`e2e/${file}`));

describe("specs that need rate-limit counters of their own run against the second server", () => {
  const projects = config.projects ?? [];
  const shared = projects.find((project) => project.name === "chromium");

  test("the shared chromium project exists, so the checks below cannot pass empty", () => {
    expect(shared).toBeDefined();
  });

  test.each(SECOND_SERVER_SPECS)("%s is left out of the shared chromium project", (file) => {
    expect(matches(shared?.testIgnore, file)).toBe(true);
  });

  test.each(SECOND_SERVER_SPECS)("%s runs in a project whose baseURL is the second server", (file) => {
    const owners = projects.filter((project) => matches(project.testMatch, file));
    expect(owners.map((project) => project.use?.baseURL)).toEqual([SECOND_SERVER]);
  });
});

// Moving specs between accounts on the second server only moved the problem (#1293): measured on
// 2026-10-04, one `beforeEach` that signs in and opens the editor spends 7 requests of the "query"
// bucket (health, three provider-meta, two inventory reads and one count) before the test does
// anything, so eighteen admin tests and their retries run past 120 inside one window. The second
// server therefore raises the bucket for the account its specs share, and no spec that runs there
// may assert the limiter's refusal, because that server no longer produces it.
describe("the second server raises the query bucket its specs share", () => {
  const servers = Array.isArray(config.webServer) ? config.webServer : [];
  const second = servers.find((server) => server.url === SECOND_SERVER);

  test("the second server is one of the configured web servers", () => {
    expect(second).toBeDefined();
  });

  test("its RATE_LIMIT_QUERY_MAX is far above the 120 a production server defaults to", () => {
    expect(Number(second?.env?.RATE_LIMIT_QUERY_MAX)).toBeGreaterThanOrEqual(10_000);
  });

  test.each(SECOND_SERVER_SPECS)("%s asserts no rate-limit refusal", (file) => {
    const source = readFileSync(path.join(import.meta.dir, "../../e2e", file), "utf8");
    const assertions = source.split("\n").filter((line) => /\bexpect\b/.test(line) && /Too many requests/.test(line));
    expect(assertions).toEqual([]);
  });
});

// e2e/firestore-provider.spec.ts needs a server whose every Firestore connection goes to a stub: FIRESTORE_EMULATOR_HOST
// is read from the server environment only and applies to every connection on that server (spec 4.3), so no other
// spec may share it, and no other server may set the variable.
describe("the Firestore browse spec runs against a server of its own that sends Firestore to the stub", () => {
  const FIRESTORE_SERVER = `http://localhost:${Number(process.env.E2E_FIRESTORE_PORT ?? 3013)}`;
  const STUB = `127.0.0.1:${Number(process.env.E2E_FIRESTORE_STUB_PORT ?? 3014)}`;
  const projects = config.projects ?? [];
  const servers = Array.isArray(config.webServer) ? config.webServer : [];

  test("it is left out of the shared chromium project and runs only on the Firestore server", () => {
    const shared = projects.find((project) => project.name === "chromium");
    expect(matches(shared?.testIgnore, "firestore-provider.spec.ts")).toBe(true);
    const owners = projects.filter((project) => matches(project.testMatch, "firestore-provider.spec.ts"));
    expect(owners.map((project) => [project.name, project.use?.baseURL])).toEqual([
      ["chromium-firestore", FIRESTORE_SERVER],
    ]);
  });

  test("no other spec runs on the Firestore server", () => {
    const others = projects.filter(
      (project) => project.use?.baseURL === FIRESTORE_SERVER && project.name !== "chromium-firestore",
    );
    expect(others).toEqual([]);
  });

  test("that server alone sets FIRESTORE_EMULATOR_HOST, to the stub's loopback port", () => {
    const setting = servers
      .filter((server) => server.env?.FIRESTORE_EMULATOR_HOST !== undefined)
      .map((server) => [server.url, server.env?.FIRESTORE_EMULATOR_HOST]);
    expect(setting).toEqual([[FIRESTORE_SERVER, STUB]]);
  });

  test("it raises the query bucket and keeps its own data dir, and the spec asserts no rate-limit refusal", () => {
    const server = servers.find((candidate) => candidate.url === FIRESTORE_SERVER);
    expect(Number(server?.env?.RATE_LIMIT_QUERY_MAX)).toBeGreaterThanOrEqual(10_000);
    expect(server?.env?.STORAGE_SQLITE_PATH).toBe("./data-e2e-firestore/libredb-storage.db");
    const source = readFileSync(path.join(import.meta.dir, "../../e2e", "firestore-provider.spec.ts"), "utf8");
    expect(source.split("\n").filter((line) => /\bexpect\b/.test(line) && /Too many requests/.test(line))).toEqual([]);
  });
});

// e2e/unknown-provider-seed.spec.ts reads a seed file that holds an entry whose type names no provider (FND-1). The
// seed file is the server's own, so a spec on the same server would list its entries and could pick one as its default.
describe("the unknown-provider seed spec runs against a server of its own with its own seed file", () => {
  const SEED_SERVER = `http://localhost:${Number(process.env.E2E_UNKNOWN_SEED_PORT ?? 3015)}`;
  const FIXTURE = "./e2e/fixtures/unknown-provider-seed-connections.json";
  const projects = config.projects ?? [];
  const servers = Array.isArray(config.webServer) ? config.webServer : [];

  test("it is left out of the shared chromium project and runs only on its server", () => {
    const shared = projects.find((project) => project.name === "chromium");
    expect(matches(shared?.testIgnore, "unknown-provider-seed.spec.ts")).toBe(true);
    const owners = projects.filter((project) => matches(project.testMatch, "unknown-provider-seed.spec.ts"));
    expect(owners.map((project) => [project.name, project.use?.baseURL])).toEqual([
      ["chromium-unknown-provider-seed", SEED_SERVER],
    ]);
  });

  test("no other spec runs on that server", () => {
    const others = projects.filter(
      (project) => project.use?.baseURL === SEED_SERVER && project.name !== "chromium-unknown-provider-seed",
    );
    expect(others).toEqual([]);
  });

  test("its SEED_CONFIG_PATH names the fixture, which holds one entry the type check refuses and one it does not", () => {
    const server = servers.find((candidate) => candidate.url === SEED_SERVER);
    expect(server?.env?.SEED_CONFIG_PATH).toBe(FIXTURE);
    expect(server?.env?.STORAGE_SQLITE_PATH).toBe("./data-e2e-unknown-seed/libredb-storage.db");
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../..", FIXTURE), "utf8")) as {
      connections: { type: unknown }[];
    };
    expect(fixture.connections.map((entry) => typeIdRefusal(entry.type)?.reason ?? null)).toEqual(["unknown", null]);
  });
});

// The main server takes every spec the projects above do not, and nearly all of them sign in as user@libredb.org, so
// they share one "query" bucket there too. With the production 120 a minute, a local run of
// `e2e/security-headers.spec.ts e2e/object-edit.spec.ts --repeat-each=5 --retries=0` in CI mode failed 2 of its 40
// runs on 2026-11-21 (and 10 more did not run), the object tree reading "Too many requests". So the main server raises
// the bucket as the second server does, and no spec that runs there may assert the limiter's refusal.
describe("the main server raises the query bucket its specs share", () => {
  const MAIN_SERVER = `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`;
  const projects = config.projects ?? [];
  const servers = Array.isArray(config.webServer) ? config.webServer : [];
  const main = servers.find((server) => server.url === MAIN_SERVER);
  const onMain = projects.filter((project) => (project.use?.baseURL ?? config.use?.baseURL) === MAIN_SERVER);
  const specs = readdirSync(path.join(import.meta.dir, "../../e2e"))
    .filter((file) => file.endsWith(".spec.ts"))
    .filter((file) =>
      onMain.some(
        (project) =>
          (project.testMatch === undefined || matches(project.testMatch, file)) && !matches(project.testIgnore, file),
      ),
    );

  test("the main server is one of the configured web servers, and specs run against it", () => {
    expect(main).toBeDefined();
    expect(specs).toContain("security-headers.spec.ts");
    expect(specs).toContain("object-edit.spec.ts");
    expect(specs).not.toContain("kafka-provider.spec.ts");
  });

  test("its RATE_LIMIT_QUERY_MAX is far above the 120 a production server defaults to", () => {
    expect(Number(main?.env?.RATE_LIMIT_QUERY_MAX)).toBeGreaterThanOrEqual(10_000);
  });

  test("no spec that runs against it asserts a rate-limit refusal", () => {
    const assertions = specs.flatMap((file) =>
      readFileSync(path.join(import.meta.dir, "../../e2e", file), "utf8")
        .split("\n")
        .filter((line) => /\bexpect\b/.test(line) && /Too many requests/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(assertions).toEqual([]);
  });
});

describe("every server waits for the one cold build with a budget sized for a CI runner", () => {
  // The first server runs `next build` before `next start`, and every other server waits for its .next/BUILD_ID,
  // so each timeout has to cover a cold production build. Measured 2026-10-12 on GitHub runners: that build's
  // first output came 65 to 114 s after the command started in ten runs of main, and two runs (main 68a7d19e4,
  // #1695 cd04e6e03) were stopped at the 120 s timeout before the build finished.
  const servers = Array.isArray(config.webServer) ? config.webServer : [];

  test("every server builds or waits for the build, so the budget below applies to each", () => {
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      expect({ command: server.command, waits: /bun run build|\.next\/BUILD_ID/.test(server.command ?? "") }).toEqual({
        command: server.command,
        waits: true,
      });
    }
  });

  test("each allows five minutes, past twice the slowest build measured", () => {
    for (const server of servers) {
      expect({ command: server.command, timeout: server.timeout }).toEqual({
        command: server.command,
        timeout: 300_000,
      });
    }
  });
});

// The built-in samples' assets are read from SEED_ASSETS_DIR (docs/DISTRIBUTION.md, "Built-in sample
// assets"), so every Studio server an e2e suite starts names this checkout's own directory, and a value a
// developer exported never changes what a suite checks (Playwright puts a webServer's env over the caller's).
describe("every Studio server the e2e suites start names this checkout's seed assets directory", () => {
  const checkoutSeedAssets = path.resolve(import.meta.dir, "../../seed-assets");
  const studioServers = (suite: typeof config, name: string) =>
    (Array.isArray(suite.webServer) ? suite.webServer : suite.webServer ? [suite.webServer] : [])
      .filter((server) => /\bbun start\b/.test(server.command ?? ""))
      .map((server) => ({ label: `${name} ${server.url}`, server }));
  const servers = [...studioServers(config, "main"), ...studioServers(basePathConfig, "base-path")];

  test("the main and base-path suites each start at least one Studio server", () => {
    expect(studioServers(config, "main").length).toBeGreaterThan(0);
    expect(studioServers(basePathConfig, "base-path").length).toBeGreaterThan(0);
  });

  test.each(servers.map(({ label, server }) => [label, server] as const))(
    "%s sets SEED_ASSETS_DIR to the checkout's seed-assets",
    (_label, server) => {
      expect(server.env?.SEED_ASSETS_DIR).toBe(checkoutSeedAssets);
    },
  );

  test("that directory holds every asset the sample table pins", () => {
    expect(SAMPLES.size).toBeGreaterThan(0);
    for (const spec of SAMPLES.values()) {
      expect(existsSync(path.join(checkoutSeedAssets, spec.asset))).toBe(true);
    }
  });
});
