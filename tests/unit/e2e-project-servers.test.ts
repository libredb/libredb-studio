import { describe, expect, test } from "bun:test";
import config from "../../playwright.config";

// Every spec signs in as the same shared account, and the server keeps one "query" rate-limit
// bucket per account per process (src/lib/api/rate-limit.ts, 120 requests a minute), so a spec
// that reaches a db route late in file order can meet a budget the specs before it spent. On CI
// run 36263561882, e2e/kafka-provider.spec.ts got "Too many requests. Try again in 38 seconds."
// on all three attempts of its Test Connection check. Such a spec runs against the second server
// process instead, whose counters only it and offline-editor.spec.ts touch; this pins that choice.

const SECOND_SERVER = `http://localhost:${Number(process.env.E2E_OFFLINE_PORT ?? 3010)}`;
const SECOND_SERVER_SPECS = ["offline-editor.spec.ts", "kafka-provider.spec.ts"];

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
