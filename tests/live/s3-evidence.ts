/**
 * Records the S3 captures: every scenario of tests/live/s3-evidence-plan.ts a target records,
 * run through a real S3Provider over the production byte transport, against the fixtures of docker/s3/README.md.
 *
 * The recorder has two parts, because the signer runs inside the transport at send time: the provider's signer is
 * wrapped by recordingSigner, which records each SigningInput and the headers the signer returned, and the transport
 * factory is wrapped to pair that record with the request's method, target and answer, in order. Every capture passes
 * tests/helpers/s3-evidence-scrub.ts before it is written. A step whose summary is not what S3_ACCEPTANCE expects stops
 * the run, and nothing is written; so does a change of the buckets' fingerprint between the first scenario and the last.
 *
 *   bun tests/live/s3-evidence.ts --target <minio|minio-region|silo|garage|rustfs> [--garage-keys <dir>] [--only <a,b>]
 *
 * It writes tests/fixtures/s3/captures/<target>-<UTC date>-<version>/<scenario>.json and manifest.json, refuses a set
 * directory that already holds a file this run does not write, and rewrites tests/fixtures/s3/captures/README.md with
 * the sets and the digest of every file. It is NOT in `bun run test`: the runner excludes tests/live/ by name. An
 * argument it does not accept exits 2 before any socket opens. It sends only what the provider sends: GET and HEAD.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createNodeByteTransport } from "@/lib/db/http/node-transport";
import { assertObjectSurface } from "../helpers/object-surface-conformance";
import { scrubCapture } from "../helpers/s3-evidence-scrub";
import {
  captureFilesOnDisk,
  captureSets,
  loadManifest,
  parseSetName,
  readDigestTable,
  renderCapturesReadme,
  S3_CAPTURE_TARGETS,
  S3_CAPTURES_ROOT,
  type S3CaptureTarget,
  type S3Manifest,
} from "../helpers/s3-fixtures";
import type { S3Capture, S3TransportFactory } from "../helpers/s3-wire";
import { runS3Scenario, S3_SCENARIOS, scenariosFor } from "./s3-evidence-plan";
import {
  checkS3Step,
  fixtureSecrets,
  readS3Principals,
  ROOT,
  S3_ACCEPTANCE,
  S3_CONFORMANCE,
  type S3RunContext,
  s3Fingerprint,
  s3Recorder,
} from "./s3-live-support";

const VERSIONS: Readonly<
  Record<S3CaptureTarget, { readonly version: string; readonly container: string; readonly built: boolean }>
> = {
  minio: { version: "RELEASE.2025-10-15T17-29-55Z", container: "libredb-minio", built: true },
  "minio-region": { version: "RELEASE.2025-10-15T17-29-55Z", container: "libredb-minio-region", built: true },
  silo: { version: "RELEASE.2026-09-16T00-00-00Z", container: "libredb-silo", built: false },
  garage: { version: "v2.4.1", container: "libredb-garage", built: false },
  rustfs: { version: "1.0.1", container: "libredb-rustfs", built: false },
};
const HARNESS_FILES = [
  "database-compose.yml",
  "docker/s3",
  "docker/minio",
  "tests/live",
  "tests/helpers/s3-wire.ts",
  "tests/helpers/s3-evidence-scrub.ts",
  "tests/helpers/s3-fixtures.ts",
];

function usage(message: string): never {
  console.error(`s3-evidence.ts: ${message}`);
  console.error(
    "usage: bun tests/live/s3-evidence.ts --target <minio|minio-region|silo|garage|rustfs> [--garage-keys <dir>] [--only <a,b>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let at = 0; at < args.length; at += 2) {
  if (!["--target", "--garage-keys", "--only"].includes(args[at]) || args[at + 1] === undefined)
    usage(`${args[at]} is not an option, or has no value`);
  options[args[at].slice(2)] = args[at + 1];
}
const target = options.target as S3CaptureTarget | undefined;
if (target === undefined || !S3_CAPTURE_TARGETS.includes(target))
  usage(`--target must be one of ${S3_CAPTURE_TARGETS.join(", ")}`);
if (target === "garage" && options["garage-keys"] === undefined)
  usage("--garage-keys <copy of the s3-garage-keys volume> is required for garage");
const planned = scenariosFor(target);
const only = options.only?.split(",");
for (const name of only ?? [])
  if (!planned.some(({ scenario }) => scenario.name === name)) usage(`${target} does not record the scenario ${name}`);
const selected = only === undefined ? planned : planned.filter(({ scenario }) => only.includes(scenario.name));

const principals = readS3Principals(target, options["garage-keys"]);
const secrets = fixtureSecrets(target, principals);
const redact = (text: string) => secrets.reduce((out, { value }) => out.split(value).join("<secret>"), text);

function image(): string {
  const { container, built } = VERSIONS[target as S3CaptureTarget];
  const id = execFileSync("docker", ["inspect", "-f", "{{.Image}}", container], { encoding: "utf8" }).trim();
  if (!built)
    return execFileSync("docker", ["image", "inspect", "-f", "{{index .RepoDigests 0}}", id], {
      encoding: "utf8",
    }).trim();
  const buildinfo = execFileSync(
    "docker",
    ["run", "--rm", "--entrypoint", "head", id, "-n", "3", "/usr/bin/minio.buildinfo"],
    { encoding: "utf8" },
  );
  return `${id} ${buildinfo.trim().split("\n").join(" ")}`;
}

function uncommitted(): string[] {
  const status = execFileSync("git", ["status", "--porcelain", "--", ...HARNESS_FILES], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
}

const date = new Date().toISOString().slice(0, 10);
const set = `${target}-${date}-${VERSIONS[target].version}`;
const directory = path.join(S3_CAPTURES_ROOT, set);
const production: S3TransportFactory = (transportOptions) => createNodeByteTransport(transportOptions);

try {
  if (parseSetName(set) === undefined) throw new Error(`${set} is not a set name`);
  const writes = new Map<string, string>();
  const scenarios: S3Manifest["scenarios"][number][] = [];
  const before = await s3Fingerprint(target, principals, production);
  for (const { scenario, steps } of selected) {
    const recording = s3Recorder(production, scenario.name);
    const run: S3RunContext = {
      target,
      principals,
      createTransport: recording.createTransport,
      clockFor: (offsetMs) => () => new Date(Date.now() + offsetMs),
      signerWrapper: recording.signerWrapper,
      setStep: recording.setStep,
      sockets: () => 0,
      recorded: () => recording.exchanges.map((exchange) => exchange.request),
    };
    const started = performance.now();
    const runs = await runS3Scenario(scenario, run, steps, {
      assertSurface: (provider) => assertObjectSurface(provider, S3_CONFORMANCE),
    });
    const ms = Math.round(performance.now() - started);
    const row = S3_ACCEPTANCE.find((candidate) => candidate.id === scenario.row);
    for (const stepRun of runs) {
      const outcome = row?.expect[target].find(({ step }) => step === stepRun.summary.step)?.outcome;
      if (row !== undefined && outcome === undefined)
        throw new Error(`${scenario.name} ran a step ${stepRun.summary.step} its cell does not hold`);
      const failure =
        outcome === undefined
          ? stepRun.summary.refused === undefined
            ? undefined
            : `refused: ${stepRun.summary.refused}`
          : checkS3Step(outcome, stepRun.summary, stepRun.context, 0);
      if (failure !== undefined)
        throw new Error(`${scenario.name} step ${stepRun.summary.step} is not what the plan expects: ${failure}`);
    }
    const file = `${set}/${scenario.name}.json`;
    const capture: S3Capture = {
      file,
      scenario: scenario.name,
      target,
      clockOffsetMs: scenario.clockOffsetMs,
      exchanges: recording.exchanges,
      result: runs.map((stepRun) => stepRun.summary),
    };
    writes.set(file, scrubCapture(capture, secrets));
    scenarios.push({
      name: scenario.name,
      ms,
      exchanges: recording.exchanges.length,
      clockOffsetMs: scenario.clockOffsetMs,
    });
    console.log(`recorded ${scenario.name} (${recording.exchanges.length} exchanges, ${ms} ms)`);
  }
  const after = await s3Fingerprint(target, principals, production);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("the buckets' fingerprint changed during the run; nothing was written");
  const manifest: S3Manifest = {
    target,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    uncommitted: uncommitted(),
    image: image(),
    version: VERSIONS[target].version,
    date,
    scenarios,
  };
  writes.set(`${set}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  if (existsSync(directory))
    for (const existing of readdirSync(directory))
      if (!writes.has(`${set}/${existing}`))
        throw new Error(
          `${set}/${existing} exists and this run does not write it: move the set aside or capture every scenario`,
        );
  mkdirSync(directory, { recursive: true });
  for (const [file, text] of writes) writeFileSync(path.join(S3_CAPTURES_ROOT, file), text);
  const digests = captureFilesOnDisk().map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(S3_CAPTURES_ROOT, file)))
      .digest("hex"),
  }));
  const sets = captureSets().map((captureSet) => ({ set: captureSet, manifest: loadManifest(captureSet.name) }));
  writeFileSync(
    path.join(S3_CAPTURES_ROOT, "README.md"),
    renderCapturesReadme(
      sets,
      digests,
      S3_SCENARIOS.map((scenario) => ({ name: scenario.name, shows: scenario.shows })),
    ),
  );
  if (readDigestTable(readFileSync(path.join(S3_CAPTURES_ROOT, "README.md"), "utf8")).length !== digests.length)
    throw new Error("the README's digest table did not read back");
  console.log(`wrote ${writes.size} files to tests/fixtures/s3/captures/${set}`);
} catch (error) {
  console.error(redact(`s3-evidence.ts: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
}
