/**
 * The Firestore evidence harness: it starts the pinned cloud-firestore-emulator 1.22.0 jar on loopback under the
 * demo- project of tests/live/firestore-evidence-plan.ts, and for each Native-mode scenario flushes the emulator
 * through its documented flush endpoint, writes the seed (docker/firestore/seed.json) unless the scenario is
 * unseeded, and runs its steps; a scenario in another mode gets a fresh emulator started in that mode. It runs steps through the real provider in
 * emulator mode, recording every transport the provider creates at its `createTransport` seam. It writes
 * tests/fixtures/firestore/1.22.0/<scenario>.json and a manifest.json naming the emulator version, the jar's SHA-256,
 * the Java version, the Studio commit, the harness files that differ from it and the date.
 *
 * The `surface` scenario runs the shared conformance helper under recording, so the capture holds exactly the
 * helper's requests. Every capture passes tests/helpers/firestore-evidence-scrub.ts; a step whose answer does not show
 * what the plan expects stops the run, and nothing is written; nothing is written either when the files total 1 MB.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/firestore-evidence.ts --jar /absolute/path/cloud-firestore-emulator-v1.22.0.jar
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { probePastPage } from "@/lib/api/page-probe";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { encodeLevelCursor } from "@/lib/db/providers/document/firestore/cursor";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import type { DatabaseProvider } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { FirestoreEvidenceLeakError, FirestoreEvidenceScrubber } from "../helpers/firestore-evidence-scrub";
import { type CaptureSink, recordingTransport } from "../helpers/firestore-replay";
import { assertObjectSurface } from "../helpers/object-surface-conformance";
import {
  type EvidenceScenario,
  type EvidenceStep,
  FIRESTORE_CONFORMANCE,
  FIRESTORE_EMULATOR,
  FIRESTORE_SCENARIOS,
  FIRESTORE_SEED,
  gridShows,
} from "./firestore-evidence-plan";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/firestore", FIRESTORE_EMULATOR.version);
const QUERY_TIMEOUT_MS = 30_000;
/** Pages a `follow` scan reads at most. */
const FOLLOW_PAGES = 20;
export const FIXTURE_BUDGET_BYTES = 1_000_000;

/** What a capture depends on besides the emulator. */
const HARNESS_PATHS = [
  "docker/firestore/seed.json",
  "tests/helpers/firestore-evidence-scrub.ts",
  "tests/helpers/firestore-replay.ts",
  "tests/live/firestore-evidence-plan.ts",
  "tests/live/firestore-evidence.ts",
];

/** Whether `dir` is `root` or below it, by `paths`' rules. */
export function insideDirectory(root: string, dir: string, paths: typeof path.posix = path): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(dir));
  return (
    relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

export function runArguments(argv: readonly string[]): { readonly jar: string } {
  const at = argv.indexOf("--jar");
  const jar = at === -1 ? undefined : argv[at + 1];
  if (jar === undefined || !path.isAbsolute(jar)) {
    throw new Error("--jar takes the absolute path of the cloud-firestore-emulator 1.22.0 jar");
  }
  if (insideDirectory(ROOT, jar)) {
    throw new Error("--jar must be outside the repository: it is a 131 MB binary that is never committed");
  }
  return { jar };
}

export function javaMajor(versionText: string): number {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(versionText);
  if (match === null) throw new Error(`java -version printed no version: ${versionText.trim()}`);
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

export function fixtureBudget(files: Readonly<Record<string, string>>): number {
  const total = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  if (total >= FIXTURE_BUDGET_BYTES) {
    throw new Error(
      `the captures total ${total} bytes, at or over the ${FIXTURE_BUDGET_BYTES}-byte budget of spec 9: nothing was written`,
    );
  }
  return total;
}

/**
 * One statement as `POST /api/db/query` runs it from the editor: prepared with the grid's default page, then run with
 * the route's probe row, so a replay answers exactly the requests the browser's run sends.
 */
export async function runAsTheQueryRoute(provider: FirestoreProvider, text: string): Promise<QueryResult> {
  const options = { limit: DEFAULT_QUERY_LIMIT, offset: 0, unlimited: false };
  // The route holds a DatabaseProvider, whose prepareQuery takes the options this override ignores.
  const route: Pick<DatabaseProvider, "prepareQuery"> = provider;
  const prepared = route.prepareQuery(text, options);
  return provider.query(probePastPage(route, text, options, prepared).query);
}

const same = (a: readonly string[] | undefined, b: readonly string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

/** Runs `body`; when the step expects a refusal, the refusal must come and must hold the step's fragment. */
async function refusable(refused: string | undefined, fail: (what: string) => never, body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    if (refused === undefined) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(refused)) fail(`it was refused with "${message}", not with "${refused}"`);
    return;
  }
  if (refused !== undefined) fail("it was not refused");
}

/** One step against the provider; a step whose answer is not what the plan expects throws a sentence naming it. */
export async function runStep(provider: FirestoreProvider, step: EvidenceStep): Promise<void> {
  const fail = (what: string): never => {
    throw new Error(`step ${JSON.stringify(step)}: ${what}`);
  };
  switch (step.op) {
    case "connect":
      return refusable(step.refused, fail, async () => {
        await provider.connect();
        const warnings = provider
          .connectWarnings()
          .map((warning) => warning.message)
          .join("\n");
        for (const words of step.warns ?? []) if (!warnings.includes(words)) fail(`no warning holds "${words}"`);
      });
    case "collections": {
      const ids = (await provider.listObjects([], "collection")).map((object) => object.path.at(-1) ?? "");
      if (!same(ids, step.ids)) fail(`the tree lists ${JSON.stringify(ids)}`);
      return;
    }
    case "count": {
      const counts = await provider.countObjects([]);
      if (JSON.stringify(counts.collection) !== JSON.stringify({ count: step.collections })) {
        fail(`the count is ${JSON.stringify(counts.collection)}`);
      }
      return;
    }
    case "describe": {
      const detail = await provider.describeObject([step.collection], "collection");
      const names = detail.columns.map((column) => column.name);
      for (const name of step.columns) if (!names.includes(name)) fail(`no column ${name} in ${JSON.stringify(names)}`);
      for (const [name, type] of Object.entries(step.types ?? {})) {
        const found = detail.columns.find((column) => column.name === name)?.type;
        if (found !== type) fail(`column ${name} is typed ${String(found)}, not ${type}`);
      }
      return;
    }
    case "describeAll": {
      const batch = await provider.describeObjects([], "collection", step.limit);
      if ((batch.truncated !== undefined) !== step.truncated) fail(`truncated is ${JSON.stringify(batch.truncated)}`);
      return;
    }
    case "scan":
      return refusable(step.refused, fail, async () => {
        let cursor = step.cursor === undefined ? "0" : encodeLevelCursor({ v: 1, p: step.pattern, t: step.cursor.t });
        const keys: string[] = [];
        const prefixes: string[] = [];
        let outcome: string | undefined;
        for (let page = 0; page < (step.follow === true ? FOLLOW_PAGES : 1); page += 1) {
          // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the page before it.
          const answer = await provider.scanKeysPage({ cursor, pattern: step.pattern, count: step.count, level: true });
          keys.push(...answer.keys);
          prefixes.push(...(answer.prefixes ?? []));
          outcome = answer.readOutcome?.scope ?? outcome;
          cursor = answer.cursor;
          if (cursor === "0") break;
        }
        if (step.follow === true && cursor !== "0") fail(`the level did not end within ${FOLLOW_PAGES} pages`);
        if (step.keys !== undefined && !same(keys, step.keys)) fail(`the keys are ${JSON.stringify(keys)}`);
        if (step.prefixes !== undefined && !same(prefixes, step.prefixes)) {
          fail(`the folders are ${JSON.stringify(prefixes)}`);
        }
        if (outcome !== step.outcome) fail(`the read outcome is ${String(outcome)}`);
      });
    case "source":
      return refusable(step.refused, fail, async () => {
        const text = JSON.stringify(await provider.readObjectSource([step.path], "document"));
        for (const words of step.holds ?? []) if (!text.includes(words)) fail(`the source holds no "${words}"`);
      });
    case "statement":
      return refusable(step.refused, fail, async () => {
        const result = await runAsTheQueryRoute(provider, step.text);
        if (step.shows !== undefined && !gridShows(result.rows, step.shows)) {
          fail(`the grid shows no ${JSON.stringify(step.shows)}`);
        }
        const warnings = (result.warnings ?? []).map((warning) => warning.message).join("\n");
        if (step.warns !== undefined && !warnings.includes(step.warns)) fail(`no warning holds "${step.warns}"`);
      });
    case "surface":
      await assertObjectSurface(provider, FIRESTORE_CONFORMANCE);
      return;
  }
}

function connection(): DatabaseConnection {
  return {
    id: "firestore-evidence",
    name: "Firestore evidence",
    type: "firestore",
    database: FIRESTORE_EMULATOR.project,
    createdAt: new Date(0),
  };
}

const emulatorUrl = (suffix: string) => `http://${FIRESTORE_EMULATOR.host}:${FIRESTORE_EMULATOR.port}${suffix}`;
const DOCUMENTS = `projects/${FIRESTORE_EMULATOR.project}/databases/(default)/documents`;

async function startEmulator(jar: string, scenario: Pick<EvidenceScenario, "databaseMode">): Promise<ChildProcess> {
  const extra = scenario.databaseMode === undefined ? [] : ["--database-mode", scenario.databaseMode];
  const child = spawn(
    "java",
    [
      "-jar",
      jar,
      "--host",
      FIRESTORE_EMULATOR.host,
      "--port",
      String(FIRESTORE_EMULATOR.port),
      "--websocket_port",
      String(FIRESTORE_EMULATOR.port + 1),
      "--project_id",
      FIRESTORE_EMULATOR.project,
      "--single_project_mode",
      "true",
      ...extra,
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a poll until the emulator listens.
      if ((await fetch(emulatorUrl("/"))).ok) return child;
    } catch {
      // Not listening yet.
    }
    // oxlint-disable-next-line no-await-in-loop -- a poll until the emulator listens.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error(`the emulator did not answer on ${FIRESTORE_EMULATOR.host}:${FIRESTORE_EMULATOR.port} within 60 s`);
}

async function stopEmulator(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

/** The documented flush, then the seed in one commit, as docker/firestore/seed.py writes it. */
async function prepare(scenario: EvidenceScenario): Promise<void> {
  const flushed = await fetch(emulatorUrl(`/emulator/v1/${DOCUMENTS}`), { method: "DELETE" });
  if (!flushed.ok) throw new Error(`the flush answered ${flushed.status}`);
  if (!scenario.seeded) return;
  const writes = FIRESTORE_SEED.map((document) => ({
    update: { name: `${DOCUMENTS}/${document.path}`, fields: document.fields },
  }));
  const seeded = await fetch(emulatorUrl(`/v1/${DOCUMENTS}:commit`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ writes }),
  });
  if (!seeded.ok) throw new Error(`the seed answered ${seeded.status}: ${await seeded.text()}`);
}

async function runScenario(scenario: EvidenceScenario): Promise<CaptureSink> {
  const sink: CaptureSink = { lanes: [], exchanges: [] };
  const provider = new FirestoreProvider(
    connection(),
    { queryTimeout: QUERY_TIMEOUT_MS },
    {
      createTransport: recordingTransport(createNodeTransport, sink),
      env: { FIRESTORE_EMULATOR_HOST: `${FIRESTORE_EMULATOR.host}:${FIRESTORE_EMULATOR.port}` },
    },
  );
  try {
    // oxlint-disable-next-line no-await-in-loop -- steps run in order against one provider.
    for (const step of scenario.steps) await runStep(provider, step);
  } finally {
    await provider.disconnect();
  }
  return sink;
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

async function main(argv: readonly string[]): Promise<void> {
  const { jar } = runArguments(argv);
  const sha256 = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (sha256 !== FIRESTORE_EMULATOR.jarSha256) throw new Error(`the jar's SHA-256 is ${sha256}, not the pinned one`);
  // java -version prints to stderr.
  const javaText = execFileSync("sh", ["-c", "java -version 2>&1"], { encoding: "utf8" });
  const major = javaMajor(javaText);
  if (major < FIRESTORE_EMULATOR.javaMajorFloor) throw new Error(`Java ${major} is below the floor of 21`);
  const emulatorVersion = execFileSync("java", ["-jar", jar, "--version"], { encoding: "utf8" }).trim();
  if (!emulatorVersion.includes(FIRESTORE_EMULATOR.version)) throw new Error(`the jar reports ${emulatorVersion}`);

  const scrubber = new FirestoreEvidenceScrubber({
    projectIds: [FIRESTORE_EMULATOR.project],
    databaseIds: ["(default)"],
    principals: [],
    secrets: [],
    privateKeys: [],
  });
  const files: Record<string, unknown> = {};
  const scenarios: { name: string; steps: number; exchanges: number }[] = [];
  // One Native-mode emulator for every Native scenario, flushed between them; a fresh one per other mode.
  let running: { readonly mode: string; readonly child: ChildProcess } | undefined;
  try {
    for (const scenario of FIRESTORE_SCENARIOS) {
      const mode = scenario.databaseMode ?? "native";
      if (running?.mode !== mode) {
        // oxlint-disable-next-line no-await-in-loop -- one emulator at a time on one port.
        if (running !== undefined) await stopEmulator(running.child);
        // oxlint-disable-next-line no-await-in-loop -- one emulator at a time on one port.
        running = { mode, child: await startEmulator(jar, scenario) };
      }
      // oxlint-disable-next-line no-await-in-loop -- scenarios share the emulator, so each is flushed and run in turn.
      if (mode === "native") await prepare(scenario);
      // oxlint-disable-next-line no-await-in-loop -- scenarios share the emulator, so each is flushed and run in turn.
      const sink = await runScenario(scenario);
      files[`${scenario.name}.json`] = scrubber.capture({ scenario: scenario.name, ...sink });
      scenarios.push({ name: scenario.name, steps: scenario.steps.length, exchanges: sink.exchanges.length });
    }
  } finally {
    if (running !== undefined) await stopEmulator(running.child);
  }
  files["manifest.json"] = {
    emulator: emulatorVersion,
    jarSha256: sha256,
    java:
      javaText
        .split("\n")
        .find((line) => line.includes("version"))
        ?.trim() ?? "",
    studioCommit: git("rev-parse", "HEAD").trim(),
    uncommitted: git("status", "--porcelain", "--untracked-files=all", "--", ...HARNESS_PATHS)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(3))
      .sort(),
    date: new Date().toISOString().slice(0, 10),
    scenarios,
  };
  const rendered = scrubber.render(files);
  fixtureBudget(rendered);
  if (existsSync(OUT)) {
    const stray = readdirSync(OUT).filter((name) => !Object.hasOwn(rendered, name));
    if (stray.length > 0) throw new Error(`${OUT} holds files this run does not write: ${stray.join(", ")}`);
  }
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(rendered)) writeFileSync(path.join(OUT, name), text);
  console.log(`wrote ${Object.keys(rendered).length} files to ${path.relative(ROOT, OUT)}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof FirestoreEvidenceLeakError) console.error(`${error.message}\n${error.findings.join("\n")}`);
    // Bun's stack starts at the first frame, so the message is printed first.
    else console.error(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    process.exit(1);
  }
}
