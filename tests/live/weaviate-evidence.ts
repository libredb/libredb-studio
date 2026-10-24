/**
 * The Weaviate provider's evidence harness (#1566 spec 7.3). It drives every scenario of
 * tests/live/weaviate-scenarios.ts through the provider against the live servers of docker/weaviate/README.md, over
 * the real `node:http(s)` transport, and writes tests/fixtures/weaviate/<service>/<scenario>.json: the image and its
 * digest, the server version, the date and the runtime, every request the provider sent with the answer it got, and
 * the outcome of every call. The integration test replays these files (tests/integration/db/weaviate-provider.test.ts).
 *
 * It only reads: every scenario's requests are the provider's own, and the provider has no write route. It never
 * sends `/v1/schema/{collection}/shards?tenant=` for a COLD tenant, which hangs the 1.37 line
 * (docker/weaviate/README.md, "Reading a cold tenant wakes it"), because the provider's tenant guard refuses it.
 *
 * No key is written: the credential header is recorded as `Bearer <key>`, and every file is checked for every key
 * this run holds before anything is written; one that holds a key stops the run with nothing written.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/weaviate-evidence.ts --keys <dir> [--only <service,...>]
 * <dir> is a copy of the keys volume (`docker cp libredb-weaviate-auth:/keys <dir>`), outside the repository.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createNodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import {
  recordingTransport,
  runScenario,
  scenarioConnection,
  scenarioProvider,
  type WeaviateExchange,
  type WeaviateSecrets,
} from "../helpers/weaviate-scenario";
import { scenarioFile, WEAVIATE_SCENARIOS, WEAVIATE_SERVICES, type WeaviateService } from "./weaviate-scenarios";

const ROOT = path.join(import.meta.dir, "..", "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "weaviate");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** The image a service runs, by tag and digest, as the compose file pins it. */
function imageOf(service: WeaviateService): string {
  const compose = readFileSync(path.join(ROOT, "database-compose.yml"), "utf8");
  const block = compose.split(`\n  ${service}:\n`)[1];
  const image = block?.match(/^\s+image: (\S+)$/m)?.[1];
  if (image === undefined) throw new Error(`database-compose.yml pins no image for ${service}`);
  return image;
}

function secretsFrom(dir: string): WeaviateSecrets {
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8").trim();
  return {
    root: read("root.key"),
    reader: read("auth/reader.key"),
    wrong: "weaviate-evidence-not-a-key",
    ca: readFileSync(path.join(dir, "ca.pem"), "utf8"),
  };
}

/** The transport options as written down: the credential header's value never, only that it was set. */
function transportRecord(built: readonly NodeTransportOptions[]): unknown {
  return built.map((options) => ({
    origin: `${options.origin.scheme}://${options.origin.host}:${options.origin.port}`,
    tls:
      options.tls === null
        ? null
        : { rejectUnauthorized: options.tls.rejectUnauthorized, ca: options.tls.ca !== undefined },
    maxSockets: options.maxSockets,
    headers: Object.fromEntries(
      Object.entries(options.headers).map(([name, value]) => [name, name === "authorization" ? "Bearer <key>" : value]),
    ),
  }));
}

const keys = argument("--keys");
if (keys === undefined) throw new Error("--keys <dir> is required: a copy of the weaviate-keys volume");
const secrets = secretsFrom(keys);
const tlsReader = readFileSync(path.join(keys, "tls/reader.key"), "utf8").trim();
const only = argument("--only")?.split(",");
const held = [secrets.root, secrets.reader, tlsReader];

const files: { file: string; text: string }[] = [];
for (const scenario of WEAVIATE_SCENARIOS) {
  if (only !== undefined && !only.includes(scenario.service)) continue;
  // The TLS server's reader is its own user, so its key is that server's.
  const scenarioSecrets = scenario.service === "weaviate-tls" ? { ...secrets, reader: tlsReader } : secrets;
  const exchanges: WeaviateExchange[] = [];
  const built: NodeTransportOptions[] = [];
  const provider = scenarioProvider(
    scenarioConnection(scenario, scenarioSecrets),
    recordingTransport(createNodeTransport, exchanges, built),
  );
  const outcomes = await runScenario(provider, scenario.steps);
  const service = WEAVIATE_SERVICES[scenario.service];
  const [image, digest] = imageOf(scenario.service).split("@");
  const record = {
    $captured: {
      engine: "weaviate",
      service: scenario.service,
      scenario: scenario.name,
      image,
      digest,
      version: service.version,
      date: new Date().toISOString(),
      runtime: `bun ${Bun.version}`,
      credential: scenario.credential,
    },
    transport: transportRecord(built),
    exchanges,
    outcomes,
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  for (const secret of held) {
    if (text.includes(secret)) throw new Error(`${scenarioFile(scenario)} would hold a key; nothing was written`);
  }
  files.push({ file: scenarioFile(scenario), text });
  const failed = outcomes.filter((outcome) => "error" in outcome).length;
  console.log(
    `${scenarioFile(scenario)}: ${exchanges.length} requests, ${outcomes.length} outcomes, ${failed} refused or failed`,
  );
}

for (const { file, text } of files) {
  mkdirSync(path.dirname(path.join(FIXTURES, file)), { recursive: true });
  writeFileSync(path.join(FIXTURES, file), text);
}
console.log(`wrote ${files.length} captures under tests/fixtures/weaviate/`);
