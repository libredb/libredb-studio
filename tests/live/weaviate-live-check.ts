/**
 * The Weaviate provider's live check (#1566 spec 7.4). It runs every scenario of tests/live/weaviate-scenarios.ts
 * against the live servers of docker/weaviate/README.md and holds each run to its capture under
 * tests/fixtures/weaviate/: the same requests, and the same outcomes. A difference means the server or the provider
 * changed since the capture was written, and is printed by scenario and step.
 *
 * Weaviate's own order is not stable between two identical reads (the classes of `/v1/schema`, the shards of
 * `/v1/nodes`, the groups of an aggregate), and the console shows a server's answer in the server's order, so both
 * sides are compared in a canonical form: object keys sorted and every array sorted. The order a surface call
 * imposes is held exactly by the replay in tests/integration/db/weaviate-provider.test.ts instead.
 *
 * It also snapshots, on every plaintext anonymous server, the schema, the aliases and every tenant's activity status
 * before the run and after it, and fails on any change: the provider only reads, and no read may wake a COLD tenant.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/weaviate-live-check.ts --keys <dir> [--only <service,...>]
 * <dir> is a copy of the keys volume (`docker cp libredb-weaviate-auth:/keys <dir>`), outside the repository.
 * Exit 0 when every scenario matches and nothing changed, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createNodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import {
  recordingTransport,
  runScenario,
  scenarioConnection,
  scenarioProvider,
  type WeaviateExchange,
  type WeaviateOutcome,
  type WeaviateSecrets,
} from "../helpers/weaviate-scenario";
import { scenarioFile, WEAVIATE_SCENARIOS, WEAVIATE_SERVICES, type WeaviateService } from "./weaviate-scenarios";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "weaviate");
const SNAPSHOT_SERVICES: readonly WeaviateService[] = [
  "weaviate",
  "weaviate-1-38",
  "weaviate-1-37",
  "weaviate-nographql",
];

/** Object keys sorted and every array sorted by its members' canonical text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(canonical(a), canonical(b));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function get(port: number, route: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: route, agent: false }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
}

/** The schema, the aliases and every multi-tenant collection's tenants with their statuses. */
async function snapshot(service: WeaviateService): Promise<unknown> {
  const { port } = WEAVIATE_SERVICES[service];
  const schema = JSON.parse(await get(port, "/v1/schema")) as {
    classes?: { class: string; multiTenancyConfig?: { enabled?: boolean } }[];
  };
  const tenants: Record<string, unknown> = {};
  for (const entry of schema.classes ?? []) {
    if (entry.multiTenancyConfig?.enabled === true) {
      tenants[entry.class] = JSON.parse(await get(port, `/v1/schema/${encodeURIComponent(entry.class)}/tenants`));
    }
  }
  return { schema, aliases: JSON.parse(await get(port, "/v1/aliases")), tenants };
}

const keys = argument("--keys");
if (keys === undefined) throw new Error("--keys <dir> is required: a copy of the weaviate-keys volume");
const read = (file: string) => readFileSync(path.join(keys, file), "utf8");
const secrets: WeaviateSecrets = {
  root: read("root.key").trim(),
  reader: read("auth/reader.key").trim(),
  wrong: "weaviate-evidence-not-a-key",
  ca: read("ca.pem"),
};
const tlsReader = read("tls/reader.key").trim();
const only = argument("--only")?.split(",");
const selected = WEAVIATE_SCENARIOS.filter((scenario) => only === undefined || only.includes(scenario.service));
const snapshotted = SNAPSHOT_SERVICES.filter((service) => selected.some((scenario) => scenario.service === service));

const before = new Map<WeaviateService, unknown>();
for (const service of snapshotted) before.set(service, await snapshot(service));

const line = (exchange: WeaviateExchange) => `${exchange.method} ${exchange.path} ${exchange.body ?? ""}`;
let failures = 0;
for (const scenario of selected) {
  const capture = JSON.parse(readFileSync(path.join(FIXTURES, scenarioFile(scenario)), "utf8")) as {
    readonly exchanges: readonly WeaviateExchange[];
    readonly outcomes: readonly WeaviateOutcome[];
  };
  const exchanges: WeaviateExchange[] = [];
  const built: NodeTransportOptions[] = [];
  const scenarioSecrets = scenario.service === "weaviate-tls" ? { ...secrets, reader: tlsReader } : secrets;
  const provider = scenarioProvider(
    scenarioConnection(scenario, scenarioSecrets),
    recordingTransport(createNodeTransport, exchanges, built),
  );
  const outcomes = JSON.parse(JSON.stringify(await runScenario(provider, scenario.steps))) as WeaviateOutcome[];
  const problems: string[] = [];
  const sent = exchanges.map(line).sort();
  const recorded = capture.exchanges.map(line).sort();
  if (!same(sent, recorded)) problems.push("the requests differ from the capture's");
  outcomes.forEach((outcome, index) => {
    if (!same(outcome, capture.outcomes[index])) problems.push(`step ${index}: ${outcome.step}`);
  });
  if (outcomes.length !== capture.outcomes.length) problems.push("the number of outcomes differs");
  failures += problems.length;
  console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${scenarioFile(scenario)}`);
  for (const problem of problems) console.log(`  ${problem}`);
}

for (const service of snapshotted) {
  const unchanged = same(before.get(service), await snapshot(service));
  if (!unchanged) failures += 1;
  console.log(`${unchanged ? "PASS" : "FAIL"} ${service}: schema, aliases and tenant statuses unchanged by the run`);
}

console.log(failures === 0 ? "live check passed" : `live check failed: ${failures} differences`);
process.exit(failures === 0 ? 0 : 1);
