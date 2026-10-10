/**
 * Hand-run live check of the s3 provider: every row of S3_ACCEPTANCE a target runs, through a
 * real S3Provider over the production byte transport, against the fixtures of docker/s3/README.md.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The unit tests drive the provider over scripted answers and the
 * integration test replays captures; only the servers can say that a listing, a refusal, a preview or a signature is
 * what the captures claim on the build that answers it, on every runtime Studio ships on.
 *
 * It is NOT in `bun run test`: the runner excludes tests/live/ by name (tests/runner/discover.ts). Run it from the
 * repository root with the fixtures up and seeded (docker/s3/README.md), under Bun, Node 24 and Node 26.10.0:
 *
 *   bun tests/live/s3-live-check.ts --target minio            # 127.0.0.1:9000, profile s3-minio
 *   bun tests/live/s3-live-check.ts --target minio-region     # 127.0.0.1:9030, profile s3-region
 *   bun tests/live/s3-live-check.ts --target silo             # 127.0.0.1:9010
 *   bun tests/live/s3-live-check.ts --target silo-tls --ca <copy of the s3-certs volume>/ca.pem
 *   bun tests/live/s3-live-check.ts --target garage --garage-keys <copy of the s3-garage-keys volume>
 *   bun tests/live/s3-live-check.ts --target rustfs           # 127.0.0.1:9020
 *   bun build tests/live/s3-live-check.ts --target=node --outfile "$OUT/s3-live.mjs" && node "$OUT/s3-live.mjs" --target silo
 *   "$NODE26" "$OUT/s3-live.mjs" --target silo                # the same bundle on Node 26.10.0; NODE26 holds that binary's path
 *
 * Targets are a closed table of loopback endpoints. The provider is constructed directly with its default transport
 * factory, so the Node bundle avoids the factory's every-engine import graph; under Bun only, one more check builds the
 * same connection through the factory. Every check counts the sockets it opens with a node:net connect spy, so a
 * "refused before request" cell asserts zero exchanges and zero sockets. Row A8 builds the provider with its clock 20
 * minutes ahead and, on Garage, 25 hours behind. Before the first check and after the last it fingerprints every
 * fixture bucket, and any difference fails the run. Row A63 runs only in tests/live/s3-tunnel-check.ts.
 *
 * Every line it prints has each fixture secret replaced by <secret>; masking is never the check: row A65 searches
 * every message, cell and notice of every row, before masking, for every fixture secret in every encoding of the
 * scrub, and names the row and the encoding, never the value.
 *
 * It prints one line per step, then `<passed> of <total> checks passed on <target> (<version>, <runtime>)`, and
 * exits 1 on any failure; SKIP appears only for a cell S3_ACCEPTANCE marks not applicable on the target.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { createNodeByteTransport } from "@/lib/db/http/node-transport";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { secretHits } from "../helpers/s3-evidence-scrub";
import type { S3RecordedRequest, S3TransportFactory } from "../helpers/s3-wire";
import {
  applicableSteps,
  checkS3Step,
  fixtureSecrets,
  readS3Principals,
  runS3Row,
  S3_ACCEPTANCE,
  S3_TARGET_NAMES,
  S3_TARGETS,
  type S3RunContext,
  type S3StepRun,
  type S3Target,
  s3LiveConnection,
  s3Fingerprint,
  s3Recorder,
  s3SecretMaterial,
} from "./s3-live-support";

const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
const VERSIONS: Readonly<Record<S3Target, string>> = {
  minio: "RELEASE.2025-10-15T17-29-55Z",
  "minio-region": "RELEASE.2025-10-15T17-29-55Z",
  silo: "RELEASE.2026-09-16T00-00-00Z",
  "silo-tls": "RELEASE.2026-09-16T00-00-00Z",
  garage: "v2.4.1",
  rustfs: "1.0.1",
};
/** Rows run elsewhere or last: A63 in the tunnel check; the wire rows and A65 after every other row. */
const TUNNEL_ROWS = new Set(["A63"]);
const LAST_ROWS = ["A26", "A27", "A33", "A45", "A52", "A53", "A54", "A65"];

function usage(message: string): never {
  console.error(`s3-live-check.ts: ${message}`);
  console.error(
    "usage: bun tests/live/s3-live-check.ts --target <minio|minio-region|silo|silo-tls|garage|rustfs> [--ca <file>] [--garage-keys <dir>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let at = 0; at < args.length; at += 2) {
  if (!["--target", "--ca", "--garage-keys"].includes(args[at]) || args[at + 1] === undefined)
    usage(`${args[at] ?? "--target"} is not an option, or has no value`);
  options[args[at].slice(2)] = args[at + 1];
}
const target = options.target as S3Target | undefined;
if (target === undefined || !S3_TARGET_NAMES.includes(target))
  usage(`--target must be one of ${S3_TARGET_NAMES.join(", ")}`);
if (target === "silo-tls" && options.ca === undefined)
  usage("--ca <copy of the s3-certs volume>/ca.pem is required for silo-tls");
if (target === "garage" && options["garage-keys"] === undefined)
  usage("--garage-keys <copy of the s3-garage-keys volume> is required for garage");

const ca = options.ca === undefined ? undefined : readFileSync(options.ca, "utf8");
const principals = readS3Principals(target, options["garage-keys"]);
const secrets = fixtureSecrets(target, principals);
const mask = (text: string) => secrets.reduce((out, { value }) => out.split(value).join("<secret>"), text);

// Every socket a check opens, counted where node:net opens it.
let sockets = 0;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...rest: unknown[]) {
  sockets++;
  return (connect as (...a: unknown[]) => net.Socket).apply(this, rest);
} as typeof net.Socket.prototype.connect;

// Row A9's canary: the loopback listener the container and instance metadata variables name, which must see nothing.
let canary = 0;
const canaryServer = net.createServer((socket) => {
  canary++;
  socket.destroy();
});
await new Promise<void>((resolve) => canaryServer.listen(0, "127.0.0.1", resolve));
const canaryUrl = `http://127.0.0.1:${(canaryServer.address() as net.AddressInfo).port}`;

function setAmbientCredentials(): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "s3-ambient-"));
  const root = principals.root;
  writeFileSync(
    path.join(dir, "credentials"),
    `[fx]\naws_access_key_id = ${root.accessKeyId}\naws_secret_access_key = ${root.secretAccessKey}\n`,
  );
  writeFileSync(path.join(dir, "config"), `[profile fx]\nregion = ${S3_TARGETS[target as S3Target].region}\n`);
  writeFileSync(path.join(dir, "token"), "ambient-web-identity-token");
  const values: Record<string, string> = {
    AWS_ACCESS_KEY_ID: root.accessKeyId,
    AWS_SECRET_ACCESS_KEY: root.secretAccessKey,
    AWS_SESSION_TOKEN: root.secretAccessKey,
    AWS_PROFILE: "fx",
    AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"),
    AWS_CONFIG_FILE: path.join(dir, "config"),
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `${canaryUrl}/credentials`,
    AWS_EC2_METADATA_SERVICE_ENDPOINT: `${canaryUrl}/`,
    AWS_WEB_IDENTITY_TOKEN_FILE: path.join(dir, "token"),
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

const nonLoopbackIPv4 =
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address !== undefined && address.family === "IPv4" && !address.internal)?.address ?? "";

// Row A65's material: every message and cause chain, cell and notice every row produced, searched before any masking.
const seen: string[] = [];
function remember(stepRun: S3StepRun): void {
  seen.push(...s3SecretMaterial(stepRun));
}

const production: S3TransportFactory = (transportOptions) => createNodeByteTransport(transportOptions);
const recorded: S3RecordedRequest[] = [];
let passed = 0;
let total = 0;
let failed = false;

function line(verdict: "PASS" | "FAIL" | "SKIP", text: string): void {
  console.log(mask(`${verdict} ${text}`));
  if (verdict !== "SKIP") total++;
  if (verdict === "PASS") passed++;
  if (verdict === "FAIL") failed = true;
}

async function runRow(id: string): Promise<void> {
  const row = S3_ACCEPTANCE.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  for (const { step, outcome } of row.expect[target as S3Target])
    if (outcome.kind === "not-applicable") line("SKIP", `${id} ${step}: ${outcome.why}`);
  const steps = applicableSteps(row, target as S3Target);
  if (steps.length === 0) return;
  const recording = s3Recorder(production, id);
  const run: S3RunContext = {
    target: target as S3Target,
    principals,
    ...(ca === undefined ? {} : { ca }),
    createTransport: recording.createTransport,
    clockFor: (offsetMs) => () => new Date(Date.now() + offsetMs),
    signerWrapper: recording.signerWrapper,
    setStep: recording.setStep,
    sockets: () => sockets,
    recorded: () => [...recorded, ...recording.exchanges.map((exchange) => exchange.request)],
    live: {
      nonLoopbackIPv4,
      setAmbientCredentials,
      canaryConnections: () => canary,
      secretHits: () => secretHits(seen.join("\n"), secrets).length,
    },
  };
  const started = performance.now();
  let runs: readonly S3StepRun[];
  try {
    runs = await runS3Row(id, run, steps);
  } catch (error) {
    line("FAIL", `${id}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  recorded.push(...recording.exchanges.map((exchange) => exchange.request));
  const ms = Math.round(performance.now() - started);
  for (const stepRun of runs) {
    remember(stepRun);
    const outcome = row.expect[target as S3Target].find(({ step }) => step === stepRun.summary.step)?.outcome;
    const failure =
      outcome === undefined
        ? `no cell step ${stepRun.summary.step}`
        : checkS3Step(outcome, stepRun.summary, stepRun.context, stepRun.sockets);
    line(
      failure === undefined ? "PASS" : "FAIL",
      failure === undefined ? `${id} ${stepRun.summary.step} (${ms} ms)` : `${id} ${stepRun.summary.step}: ${failure}`,
    );
  }
  if (id === "A65") {
    const hits = secretHits(seen.join("\n"), secrets);
    if (hits.length > 0)
      line(
        "FAIL",
        `A65 names ${hits.map((hit) => hit.split(" ").slice(-1)[0]).join(", ")} encodings of a fixture secret in a row's output`,
      );
  }
}

try {
  const before = await s3Fingerprint(target, principals, production, () => new Date(), ca);
  for (const row of S3_ACCEPTANCE) if (!TUNNEL_ROWS.has(row.id) && !LAST_ROWS.includes(row.id)) await runRow(row.id);
  if (typeof Bun !== "undefined") {
    const started = performance.now();
    try {
      // A specifier the bundler does not follow, so the factory's every-engine graph stays out of the Node bundle.
      const factoryModule = "@/lib/db/factory";
      const { createDatabaseProvider } = (await import(factoryModule)) as typeof import("@/lib/db/factory");
      const built = await createDatabaseProvider(s3LiveConnection(target, principals, { role: "root" }, ca));
      if (!(built instanceof S3Provider)) throw new Error("the factory did not build an S3Provider");
      await built.connect();
      await built.getHealth();
      await built.disconnect();
      line("PASS", `factory (${Math.round(performance.now() - started)} ms)`);
    } catch (error) {
      line("FAIL", `factory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const id of LAST_ROWS) await runRow(id);
  const after = await s3Fingerprint(target, principals, production, () => new Date(), ca);
  if (JSON.stringify(before) === JSON.stringify(after)) line("PASS", "fingerprint unchanged");
  else
    line(
      "FAIL",
      `fingerprint: the buckets changed during the run: ${JSON.stringify(Object.keys(after).filter((bucket) => before[bucket] !== after[bucket]))}`,
    );
} catch (error) {
  line("FAIL", `run: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  canaryServer.close();
}
console.log(mask(`${passed} of ${total} checks passed on ${target} (${VERSIONS[target as S3Target]}, ${RUNTIME})`));
process.exit(failed ? 1 : 0);
