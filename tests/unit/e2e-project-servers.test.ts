import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import config from "../../playwright.config";

// Every spec signs in as the same shared account, and the server keeps one "query" rate-limit
// bucket per account per process (src/lib/api/rate-limit.ts, 120 requests a minute), so a spec
// that reaches a db route late in file order can meet a budget the specs before it spent. On CI
// run 36263561882, e2e/kafka-provider.spec.ts got "Too many requests. Try again in 38 seconds."
// on all three attempts of its Test Connection check. Such a spec runs against the second server
// process instead, whose counters only it and the other specs listed below touch;
// this pins that choice.

const SECOND_SERVER = `http://localhost:${Number(process.env.E2E_OFFLINE_PORT ?? 3010)}`;
const SECOND_SERVER_SPECS = [
  "offline-editor.spec.ts",
  "kafka-provider.spec.ts",
  "etcd-provider.spec.ts",
  "neo4j-provider.spec.ts",
  "milvus-provider.spec.ts",
  "qdrant-provider.spec.ts",
  "influxdb-providers.spec.ts",
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
