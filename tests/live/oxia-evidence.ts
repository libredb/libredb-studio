/**
 * The Oxia evidence harness (SB3-5.4): plays the named read-only runs of tests/live/oxia-live-support.ts against one
 * live compose fixture, through the real provider and adapter over a recording transport, and writes one capture per
 * run under tests/fixtures/oxia/<set>/. Hand-run on Bun, after `docker/oxia/seed.sh` and tests/live/oxia-seed-raw.ts:
 *
 *   bun tests/live/oxia-evidence.ts --target 127.0.0.1:6648 --version 0.16.10
 *   bun tests/live/oxia-evidence.ts --target 127.0.0.1:6668 --version 0.17.1
 *   bun tests/live/oxia-evidence.ts --target 127.0.0.1:6658 --version 0.16.10-natural
 *   bun tests/live/oxia-evidence.ts --target 127.0.0.1:6659 --version 0.16.10-natural-blind
 *   bun tests/live/oxia-evidence.ts --target 127.0.0.1:6678 --version 0.16.10-auth --certs <a copy of the volume>
 *   bun tests/live/oxia-evidence.ts --only <name,...> --target ... --version ...    one or more runs alone
 *   bun tests/live/oxia-evidence.ts --readme                                         render tests/fixtures/oxia/README.md
 *
 * The fixtures README is the provenance store, and the harness keeps no state outside tests/fixtures/oxia: the image,
 * the digest, the date and the command of each set live in the README's set table, which replaced the `--provenance`
 * file once kept under the system's temporary directory. A full-set run writes its set's new row and takes the other
 * sets' rows from the README's own table; an `--only` run keeps every row and renews the file digests; `--readme`
 * renders the README from its own rows and the captures on disk.
 * `--out <directory>` writes the captures under another directory, to compare two runs byte for byte, and leaves the
 * README alone.
 *
 * It never changes a server: the provider's stub holds only reads, the fixture must hold its marker, and the
 * namespace's key count and the marker's version are read before the first run and after the last; a difference
 * writes nothing. Each run is replayed over its own capture before the capture is written, with placeholder material,
 * and must answer the same. No capture, log line or README holds a token, a certificate or a key.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { grpcOxiaWireTransport } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { assertObjectSurface } from "../helpers/object-surface-conformance";
import { recordedOxiaWire, recordingOxiaWire, serializeOxiaCapture } from "../helpers/oxia-wire";
import { oxiaConnection } from "../helpers/oxia-connection";
import { loadTlsFixtures } from "../helpers/tls-fixtures";
import {
  OXIA_CONFORMANCE,
  OXIA_FIXTURES,
  OXIA_RUNS,
  OXIA_TOKEN_FILES,
  type OxiaFixture,
  type OxiaRun,
  type OxiaRunMaterial,
  type OxiaRunSteps,
  oxiaFingerprint,
  playOxiaRun,
  requireOxiaMarker,
} from "./oxia-live-support";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/oxia");
/** The step tests/live/oxia-live-support.ts leaves to a Bun player, so that it loads under Node (ruling R30). */
const STEPS: OxiaRunSteps = { assertSurface: (provider) => assertObjectSurface(provider, OXIA_CONFORMANCE) };
/** The files of tests/fixtures/oxia that are vectors with their own provenance, not captures. */
const VECTORS = ["xxh3-vectors.json", "order-vectors.json"];
const README = path.join(FIXTURES, "README.md");
const SET_TABLE_HEADER = "| Set | Image | Digest | Captured | Command |";
const SET_ROW = /^\| (\S+) \| `([^`]+)` \| `([^`]+)` \| (\d{4}-\d{2}-\d{2}) \| `([^`]+)` \|$/;

/** One set's provenance: what the README states for it. */
interface SetProvenance {
  readonly image: string;
  readonly digest: string;
  readonly date: string;
  readonly command: string;
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function fail(message: string): never {
  console.error(`oxia-evidence: ${message}`);
  process.exit(1);
}

/** The set table of the fixtures README, by set: the provenance store. A row in no known form is refused. */
function readProvenance(): Record<string, SetProvenance> {
  if (!existsSync(README)) return {};
  const lines = readFileSync(README, "utf8").split("\n");
  const header = lines.indexOf(SET_TABLE_HEADER);
  if (header === -1) fail(`tests/fixtures/oxia/README.md holds no set table`);
  const provenance: Record<string, SetProvenance> = {};
  for (const line of lines.slice(header + 2)) {
    if (line === "") break;
    const row = SET_ROW.exec(line);
    if (row === null) fail(`tests/fixtures/oxia/README.md holds a set row in no known form: ${line}`);
    provenance[row[1]] = { image: row[2], digest: row[3], date: row[4], command: row[5] };
  }
  return provenance;
}

/** The fixture's image as the container was created from it, and that image's repository digest. */
function imageOf(container: string): { readonly image: string; readonly digest: string } {
  const inspect = (format: string, name: string): string =>
    execFileSync("docker", ["inspect", "--format", format, name], { encoding: "utf8" }).trim();
  const image = inspect("{{.Config.Image}}", container);
  const digest = inspect("{{index .RepoDigests 0}}", inspect("{{.Image}}", container));
  return { image, digest };
}

/** The auth fixture's material from a copy of its volume; tokens are trimmed of the file's line end only. */
function readMaterial(directory: string): OxiaRunMaterial {
  const read = (file: string): string => readFileSync(path.join(directory, file), "utf8");
  return {
    ca: read("ca.crt"),
    otherCa: read("other-ca.crt"),
    tokens: Object.fromEntries(OXIA_TOKEN_FILES.map((file) => [file, read(file).replace(/\r?\n$/, "")])),
  };
}

/** What a replay is given: the committed throwaway CAs and one placeholder token, because the replay dials nothing. */
function placeholderMaterial(): OxiaRunMaterial {
  const tls = loadTlsFixtures();
  return {
    ca: tls.ca,
    otherCa: tls.otherCa,
    tokens: Object.fromEntries(OXIA_TOKEN_FILES.map((file) => [file, "replayed.token"])),
  };
}

/** The summary the self-check compares: the auth family without `message`, which quotes the token's own expiry. */
function compared(run: OxiaRun, summary: unknown): string {
  return JSON.stringify(summary, (key, value: unknown) =>
    run.name.startsWith("auth-") && key === "message" ? undefined : value,
  );
}

/** A provider over the real transport, for the marker and the fingerprint. */
function liveProvider(fixture: OxiaFixture): OxiaProvider {
  const colon = fixture.target.lastIndexOf(":");
  return new OxiaProvider(
    oxiaConnection({ host: fixture.target.slice(0, colon), port: Number(fixture.target.slice(colon + 1)) }),
    { queryTimeout: 30_000 },
  );
}

async function fingerprint(fixture: OxiaFixture): Promise<string> {
  const provider = liveProvider(fixture);
  await provider.connect();
  try {
    return JSON.stringify(await oxiaFingerprint(provider));
  } finally {
    await provider.disconnect();
  }
}

/** Every capture under the five set directories, as `<set>/<name>.json`, sorted. */
function captureFiles(): string[] {
  return OXIA_FIXTURES.flatMap((fixture) => {
    const directory = path.join(FIXTURES, fixture.set);
    return existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.endsWith(".json"))
          .map((name) => `${fixture.set}/${name}`)
      : [];
  }).sort();
}

function renderReadme(provenance: Record<string, SetProvenance>): void {
  const lines = [
    "# Oxia captures",
    "",
    "Each JSON file under a set directory is one named read-only run of `tests/live/oxia-live-support.ts`, recorded against a live compose fixture by `tests/live/oxia-evidence.ts` through the real provider and adapter.",
    "No file here is written by hand: the harness writes every capture and this README, and `tests/integration/db/oxia-provider.test.ts` replays each capture and holds it by the digest below.",
    "",
    SET_TABLE_HEADER,
    "|---|---|---|---|---|",
  ];
  for (const fixture of OXIA_FIXTURES) {
    const set = provenance[fixture.set];
    if (set === undefined) fail(`tests/fixtures/oxia/README.md holds no row for ${fixture.set}; capture the set first`);
    lines.push(`| ${fixture.set} | \`${set.image}\` | \`${set.digest}\` | ${set.date} | \`${set.command}\` |`);
  }
  lines.push("", "| File | SHA-256 |", "|---|---|");
  for (const file of captureFiles()) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(FIXTURES, file)))
      .digest("hex");
    lines.push(`| ${file} | ${digest} |`);
  }
  lines.push(
    "",
    `${VECTORS.map((name) => `\`${name}\``).join(" and ")} are vectors with their own provenance, not captures.`,
    "",
  );
  writeFileSync(README, lines.join("\n"));
  console.log(`oxia-evidence: wrote tests/fixtures/oxia/README.md over ${captureFiles().length} captures`);
}

async function capture(): Promise<void> {
  const target = argument("--target");
  const version = argument("--version");
  // Refused before a socket opens: the pair must be one row of the fixture table.
  const fixture = OXIA_FIXTURES.find((row) => row.target === target && row.set === version);
  if (fixture === undefined) fail(`--target ${target} --version ${version} is not a row of OXIA_FIXTURES`);
  const only = argument("--only")?.split(",");
  const runs = OXIA_RUNS.filter(
    (run) => run.sets.includes(fixture.set) && (only === undefined || only.includes(run.name)),
  );
  const unknown = (only ?? []).filter((name) => !runs.some((run) => run.name === name));
  if (unknown.length > 0) fail(`no run ${unknown.join(", ")} for ${fixture.set}`);
  const certs = argument("--certs");
  if (fixture.marker === undefined && certs === undefined) fail(`${fixture.set} needs --certs <a copy of the volume>`);
  const material = certs === undefined ? {} : readMaterial(certs);
  const placeholders = placeholderMaterial();
  // Resolved, so that the fixtures directory spelled relative still renders the README.
  const out = path.resolve(argument("--out") ?? FIXTURES);

  let before: string | undefined;
  if (fixture.marker !== undefined) {
    const provider = liveProvider(fixture);
    await provider.connect();
    try {
      await requireOxiaMarker(provider, fixture);
    } finally {
      await provider.disconnect();
    }
    before = await fingerprint(fixture);
    console.log(`oxia-evidence: fingerprint before ${before}`);
  }

  const written: { readonly file: string; readonly text: string }[] = [];
  for (const run of runs) {
    const started = Date.now();
    const recorder = recordingOxiaWire(grpcOxiaWireTransport);
    // oxlint-disable-next-line no-await-in-loop -- one run at a time, so each capture holds its own calls only.
    const summary = await playOxiaRun(run, fixture, material, recorder.transport, STEPS);
    const file = `${fixture.set}/${run.name}.json`;
    const recorded = recorder.capture(file, summary);
    const wire = recordedOxiaWire([recorded]);
    // oxlint-disable-next-line no-await-in-loop -- the self-check replays the capture just made.
    const replayed = await playOxiaRun(run, fixture, placeholders, wire.transport, STEPS);
    if (compared(run, replayed) !== compared(run, summary))
      fail(
        `${file}: the replay answered\n${JSON.stringify(replayed)}\nthe server answered\n${JSON.stringify(summary)}`,
      );
    if (wire.unmatched().length > 0)
      fail(`${file}: the replay made calls nothing matched: ${JSON.stringify(wire.unmatched())}`);
    if (wire.unused().length > 0) fail(`${file}: the replay left ${wire.unused().length} recorded calls unused`);
    const text = serializeOxiaCapture(recorded);
    for (const secret of [...Object.values(material.tokens ?? {}), "-----BEGIN", "Bearer "])
      if (text.includes(secret)) fail(`${file} holds a token, a certificate or a key; nothing was written`);
    written.push({ file, text });
    console.log(
      `oxia-evidence: ${file} ${recorded.calls.length} calls, ${text.length} bytes, ${Date.now() - started} ms`,
    );
  }

  if (before !== undefined) {
    const after = await fingerprint(fixture);
    console.log(`oxia-evidence: fingerprint after  ${after}`);
    if (after !== before) fail(`the fingerprint changed during the run; nothing was written`);
  }

  // Read before any capture is written, so that a README in no known form leaves the tree as it was.
  const provenance = out === FIXTURES ? readProvenance() : undefined;
  if (provenance !== undefined && only === undefined)
    provenance[fixture.set] = {
      ...imageOf(fixture.container),
      date: new Date().toISOString().slice(0, 10),
      command: `bun tests/live/oxia-evidence.ts --target ${fixture.target} --version ${fixture.set}${certs === undefined ? "" : " --certs <a copy of the volume>"}`,
    };
  for (const { file, text } of written) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), text);
  }
  if (provenance !== undefined) renderReadme(provenance);
  console.log(
    `oxia-evidence: wrote ${written.length} captures of ${fixture.set} under ${path.relative(ROOT, out) || out}`,
  );
}

if (process.argv.includes("--readme")) renderReadme(readProvenance());
else await capture();
