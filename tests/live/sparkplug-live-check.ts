/**
 * Hand-run live check of the Sparkplug B provider against the compose fixture
 * (`docker/sparkplug/compose-service.yml`: a digest-pinned Mosquitto and the independent edge
 * node that publishes onto it). This is the list every later change of the provider runs.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name.
 *
 * Run it from the repository root, with the fixture up, on Bun and on Node 24:
 *
 *   docker compose -f docker/sparkplug/compose-service.yml up -d
 *   bun tests/live/sparkplug-live-check.ts
 *   bun tests/live/sparkplug-live-check.ts --only 7
 *   bun build tests/live/sparkplug-live-check.ts --target=node --outfile /tmp/sparkplug-live.mjs \
 *     && node /tmp/sparkplug-live.mjs
 *
 * It never writes. The provider's encoder has no function that builds a PUBLISH, and the one
 * request that would command somebody else's equipment, a rebirth, is refused by name - item 9
 * is that refusal, asked live rather than argued.
 *
 * Every item prints `PASS <name> (<ms> ms)`, `FAIL <name>: <why>` or `SKIP <name>: <why>`, then
 * `<passed> passed, <failed> failed, <not measured> not measured, of <total> items`. Three
 * numbers and not two: an item that could not run is not a soft pass, and a reader given only
 * "11 of 12" cannot tell a failure from an item that never ran. It exits 1 on any failure and 2
 * on a bad argument, before any socket opens.
 *
 * THE ONE SKIP A HAND RUN SEES IS A DECLARATION, NOT A GAP. Item 11 holds the digest CI started
 * the broker from against the one the committed compose block names, so it needs
 * `SPARKPLUG_LIVE_DIGEST` to be told what was started. Unset means hand run and the item skips
 * by name. Declare it and the item runs:
 *
 *   SPARKPLUG_LIVE_DIGEST="$(grep -oE 'sha256:[0-9a-f]{64}' docker/sparkplug/compose-service.yml | head -1)"
 *
 * MEASURED 15 Oct against the fixture, both runtimes, with it and without:
 *   unset:    11 passed, 0 failed, 1 not measured   (bun and node alike)
 *   declared: 12 passed, 0 failed, 0 not measured   (bun and node alike)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

const HOST = argument("host", "127.0.0.1");
const PORT = Number(argument("port", "1884"));
const ONLY = process.argv.includes("--only") ? Number(argument("only", "0")) : 0;
/**
 * Refuses a run that could not ask every question.
 *
 * A SKIP keeps the exit code at 0, which is right by hand - an item whose variable is unset says
 * so and the rest still runs - and WRONG in CI: if the line that exports the digest were ever
 * dropped, the digest item would skip, the step would stay green, and nothing would have checked
 * which broker the run measured. So CI passes --strict and a skip becomes a failure there.
 */
const STRICT = process.argv.includes("--strict");

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  console.error(`--port takes a port, not ${argument("port", "")}`);
  process.exit(2);
}
if (ONLY !== 0 && (!Number.isInteger(ONLY) || ONLY < 1)) {
  console.error("--only takes an item number");
  process.exit(2);
}

type Row = Record<string, unknown>;

/*
  The repository root, found by walking UP FROM THE WORKING DIRECTORY, and the two obvious
  alternatives are both wrong here.

  `import.meta.dir` is Bun's. Node ESM has `import.meta.dirname` and `import.meta.url` and no
  `.dir`, and the bundler leaves the expression as written, so under Node it was `undefined` and
  `path.join` threw while the module was still loading. MEASURED: zero of the twelve items ran,
  and the run said nothing about the twelve it never reached. The docblock above has described a
  Node run from the start, so the delivery claimed two runtimes and had one.

  `import.meta.url` would not have fixed it. The Node run is a BUNDLE written to a temporary
  directory, so the module's own path is not inside the repository at all, and item 11 would
  have read a compose file that is not there - but only once CI set the digest, which is
  precisely the run where it matters. Nothing would have been red before that.

  The working directory is the one thing both documented runs share: both start at the
  repository root. The walk ends in a refusal that names what it looked for, so an unreachable
  root is reported rather than guessed at.
*/
const repositoryRoot = (): string => {
  const marker = path.join("docker", "sparkplug", "compose-service.yml");
  let at = process.cwd();
  for (;;) {
    if (existsSync(path.join(at, marker))) return at;
    const up = path.dirname(at);
    if (up === at) throw new Error(`no ${marker} above ${process.cwd()}; run this from the repository root`);
    at = up;
  }
};

/** An item that could not run. Thrown rather than returned, so it cannot be mistaken for a pass. */
class SkipItem extends Error {}

/**
 * The provider class directly, not `createDatabaseProvider`.
 *
 * MEASURED, and the reason belongs here: the factory imports every shipped provider, so
 * `bun build --target=node` on this file pulls DuckDB's platform bindings in and fails to
 * resolve the Windows one on a Mac. The factory's own job - picking a class from a type id - is
 * covered by `tests/unit/db/factory.test.ts`; what this file measures is the Sparkplug path,
 * and building it directly is what lets the same file run under both runtimes.
 */
async function open(group = ""): Promise<SparkplugProvider> {
  const provider = new SparkplugProvider({
    id: "sparkplug-live",
    name: "fixture",
    type: "sparkplug",
    host: HOST,
    port: PORT,
    database: group,
  } as DatabaseConnection);
  await provider.connect();
  return provider;
}

/** One read, closed afterwards whatever happened. */
async function read(statement: string, group = ""): Promise<QueryResult> {
  const provider = await open(group);
  try {
    return await provider.query(statement);
  } finally {
    await provider.disconnect();
  }
}

const rowsOf = (result: QueryResult): Row[] => (result.rows ?? []) as Row[];
const valueOf = (rows: Row[], metric: string, device: string | null = null): unknown =>
  rows.find((row) => row.metric === metric && (row.device ?? null) === device)?.value;
const noticesOf = (result: QueryResult): string =>
  (result.warnings ?? []).map((one) => (typeof one === "string" ? one : (one.message ?? ""))).join(" ");

function same(got: unknown, want: unknown, what: string): void {
  if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, read ${JSON.stringify(got)}`);
}

function holds(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** The sentence a refusal carries, or a failure saying nothing was refused. */
async function refusal(statement: string): Promise<string> {
  try {
    await read(statement);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`the request was accepted: ${statement}`);
}

const ITEMS: { readonly name: string; readonly run: () => Promise<void> }[] = [
  {
    name: "1. the broker answers, and the read carries the plant",
    run: async () => {
      const result = await read('{"seconds":4}');
      const rows = rowsOf(result);
      // Rule 5 of the test surface: a zero-row answer is not a clean answer. The fixture always
      // publishes, so zero rows here means the fixture is down, not that the plant is quiet.
      holds(rows.length > 0, "no rows at all, so the fixture is not publishing");
      holds(
        new Set(rows.map((row) => `${row.group}/${row.edgeNode}`)).size >= 5,
        "fewer than five edge nodes, so some of the fixture is missing",
      );
    },
  },
  {
    name: "2. the node's four values are what the publisher wrote",
    run: async () => {
      const rows = rowsOf(await read('{"group":"SekoyaPlant","edgeNode":"Line1","seconds":4}'));
      same(valueOf(rows, "Temperature"), "42.5", "Temperature");
      same(valueOf(rows, "CycleCount"), "1234567890123", "CycleCount");
      same(valueOf(rows, "MotorRunning"), "true", "MotorRunning");
      same(valueOf(rows, "BatchName"), "BATCH-7781", "BatchName");
    },
  },
  {
    name: "3. the device is told apart from its node",
    run: async () => {
      const rows = rowsOf(await read('{"group":"SekoyaPlant","edgeNode":"Line1","device":"Press01","seconds":4}'));
      same(rows.length, 4, "rows under the device");
      same(valueOf(rows, "PressForce", "Press01"), "118.25", "PressForce");
      same(valueOf(rows, "RecipeName", "Press01"), "RCP-ALPHA", "RecipeName");
    },
  },
  {
    name: "4. a birth-only node shows the values its certificate carries",
    run: async () => {
      // The defect found on 14 October: the birth's values were dropped, so this node rendered
      // as two rows with a datatype and an empty value.
      const rows = rowsOf(await read('{"group":"SekoyaPlant","edgeNode":"Line4","seconds":4}'));
      same(valueOf(rows, "Temperature"), "99.9", "Temperature from the birth");
      same(valueOf(rows, "ShiftName"), "NIGHT-SHIFT", "ShiftName from the birth");
    },
  },
  {
    name: "5. a node with no certificate is reported as unnameable",
    run: async () => {
      const result = await read('{"group":"SekoyaPlant","edgeNode":"Line2","seconds":4}');
      const rows = rowsOf(result);
      holds(rows.length > 0, "no rows, so the uncertified values were dropped instead of reported");
      for (const row of rows) {
        holds(row.metric === null, "an unnameable value was given a name");
        same(row.alias, "7", "the alias the value arrived under");
      }
      holds(
        noticesOf(result).includes("no certificate in hand defines"),
        "the result does not say it could not name what it saw",
      );
    },
  },
  {
    name: "6. a stored certificate is read, and says its value may be stale",
    run: async () => {
      const rows = rowsOf(await read('{"group":"SekoyaPlant","edgeNode":"Line3","seconds":4}'));
      same(valueOf(rows, "Humidity"), "61", "Humidity from the stored certificate");
      const row = rows.find((one) => one.metric === "Humidity");
      same(row?.definedBy, "stored", "where the definition came from");
      holds(String(row?.note).includes("cannot be expected to be the current ones"), "the stale sentence is missing");
    },
  },
  {
    name: "7. an empty Group reads every group, a named one does not",
    run: async () => {
      const every = rowsOf(await read('{"seconds":4}'));
      holds(
        new Set(every.map((row) => row.group)).size === 2,
        "an empty Group did not read both groups of the fixture",
      );
      const named = rowsOf(await read('{"seconds":4}', "AnkaraPlant"));
      holds(named.length > 0, "the named group answered nothing");
      holds(new Set(named.map((row) => row.group)).size === 1, "a named Group read more than the group it named");
      same(valueOf(named, "MixerSpeed"), "1450", "MixerSpeed in the second group");
    },
  },
  {
    name: "8. the tree shows the groups and their edge nodes",
    run: async () => {
      const provider = await open();
      try {
        const groups = await provider.listContainers();
        holds(
          groups.some((one) => one.name === "SekoyaPlant") && groups.some((one) => one.name === "AnkaraPlant"),
          "the tree is missing one of the fixture's groups",
        );
        const nodes = await provider.listContainers(["SekoyaPlant"]);
        holds(nodes.length >= 4, `SekoyaPlant shows ${nodes.length} edge nodes, fewer than the fixture publishes`);
      } finally {
        await provider.disconnect();
      }
    },
  },
  {
    name: "9. the four requests this version refuses, refused by name",
    run: async () => {
      holds((await refusal('{"rebirth":true}')).includes("sends no rebirth request"), "rebirth was not refused");
      holds((await refusal('{"hostId":"studio"}')).includes("no host id"), "hostId was not refused");
      holds(
        (await refusal('{"device":"Press01"}')).includes('"device" needs its "edgeNode"'),
        "a device with no edge node was not refused",
      );
      holds(
        (await refusal('{"grup":"x"}')).includes("is not a field of a Sparkplug read"),
        "an unknown key was not refused",
      );
    },
  },
  {
    name: "10. the connection declares itself read-only, and the capabilities agree",
    run: async () => {
      const provider = await open();
      try {
        const capabilities = provider.getCapabilities();
        same(capabilities.enforcesReadOnly, true, "enforcesReadOnly");
        same(capabilities.supportsTransactions, false, "supportsTransactions");
      } finally {
        await provider.disconnect();
      }
    },
  },
  {
    name: "11. the broker this ran against is the one the fixture pins",
    run: async () => {
      // CI exports the digest it started the broker from; this item holds that digest equal to
      // the one the committed compose block names, so a CI run cannot quietly measure a
      // different build from the one the repository claims. Unset means hand-run: SKIPPED by
      // name rather than passed, because a check that passes when it cannot run is not a check.
      const declared = process.env.SPARKPLUG_LIVE_DIGEST;
      if (declared === undefined || declared === "") throw new SkipItem("SPARKPLUG_LIVE_DIGEST is not set");
      const compose = readFileSync(path.join(repositoryRoot(), "docker/sparkplug/compose-service.yml"), "utf8");
      const pinned = /image: eclipse-mosquitto:[\d.]+@(sha256:[0-9a-f]{64})/.exec(compose)?.[1];
      holds(pinned !== undefined, "the compose block names no mosquitto digest");
      same(declared, pinned, "the digest CI started from");
    },
  },
  {
    name: "12. a port with nothing on it is a connection error, not an empty read",
    run: async () => {
      // The other half of rule 5: silence must be told apart from an answer. Port 1 is never a
      // broker, and the provider has to say so rather than return zero rows.
      const provider = new SparkplugProvider({
        id: "sparkplug-live-silent",
        name: "silent",
        type: "sparkplug",
        host: "127.0.0.1",
        port: 1,
        database: "",
      } as DatabaseConnection);
      try {
        await provider.connect();
        throw new Error("a port with nothing on it was accepted as a connection");
      } catch (error) {
        const message = (error as Error).message;
        // The sentence is held to the distinction, not to a word: it has to say that nothing
        // was read AND that this is not an empty broker, which is the confusion the item exists
        // for. Measured against the live refusal rather than guessed.
        holds(
          message.includes("Nothing was read") && message.includes("not an empty broker"),
          `the refusal does not separate silence from an empty broker: ${message}`,
        );
      } finally {
        await provider.disconnect().catch(() => undefined);
      }
    },
  },
];

const chosen = ONLY === 0 ? ITEMS : ITEMS.filter((_, at) => at + 1 === ONLY);
if (chosen.length === 0) {
  console.error(`--only ${ONLY} names no item; there are ${ITEMS.length}`);
  process.exit(2);
}

let passed = 0;
let failed = 0;
let skipped = 0;
for (const item of chosen) {
  const started = Date.now();
  try {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name} (${Date.now() - started} ms)`);
  } catch (error) {
    if (error instanceof SkipItem) {
      skipped += 1;
      console.log(`SKIP ${item.name}: ${error.message}`);
      continue;
    }
    failed += 1;
    console.log(`FAIL ${item.name}: ${(error as Error).message}`);
  }
}
/*
  THREE NUMBERS, NOT TWO. Passed, failed and NOT MEASURED are three different outcomes and the
  summary names all three: a skipped item is not a soft pass, and a reader who sees only
  "11 of 12 passed" cannot tell a failure from an item that never ran.

  AND A RUN THAT MEASURED NOTHING IS NOT A SUCCESS. Today that cannot happen quietly, because a
  module-load fault is fatal and the process dies before this line - which is exactly how the
  Node run was found to be measuring nothing at all. But the fault was silent in the sense that
  mattered: the run said nothing about the twelve items it never reached. If a future bundler
  swallows the same class of fault, this sentence is what is left to say so.
*/
console.log(`${passed} passed, ${failed} failed, ${skipped} not measured, of ${chosen.length} items`);
if (passed + failed + skipped === 0) {
  console.log("NO ITEM RAN. This run measured nothing, which is not the same as everything passing.");
  process.exit(1);
}
if (STRICT && skipped > 0) {
  console.log(`--strict was given and ${skipped} item(s) could not run, so this run measured less than it claims`);
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
