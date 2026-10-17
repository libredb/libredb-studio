/**
 * Opt-in live check for the SNMP provider (#1721): against the pinned fixture, does it read what
 * it says it reads, refuse what it says it refuses, and write nothing?
 *
 * WHY THIS CANNOT BE A UNIT OR INTEGRATION TEST. The integration layer answers from recordings, so
 * it can only ever say what the agent said ON THE DAY THE RECORDING WAS TAKEN. It cannot see the
 * agent change: a new Net-SNMP release, a platform that frames differently, a value that only
 * appears when the agent has been up for a while. This check is the only layer that asks the
 * living agent, and it is the layer that found the defect of 14 October 2026, where every `walk`
 * returned nothing while `snmpwalk` read sixteen objects from the same subtree.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name.
 *
 * RUN IT UNDER BOTH RUNTIMES, with the fixture up:
 *
 *   docker compose -f database-compose.yml --profile snmp up -d snmp
 *   bun tests/live/snmp-live-check.ts
 *   bun build tests/live/snmp-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs"
 *
 * The Node run goes through `bun build --target=node` because that is how this repository already
 * runs its live checks under two runtimes (tests/live/oxia-live-check.ts). A resolver hook was
 * written first and worked, and it was dropped: it needed `--experimental-transform-types` to get
 * past the parameter properties in `src/lib/db/errors.ts`, and a second way of running the same
 * file is a second thing that can disagree with the first.
 *
 * THE PROVIDER IS CONSTRUCTED DIRECTLY, never through `createDatabaseProvider`. The factory
 * imports every engine, and that import graph does not bundle for the Node run; the factory's own
 * job is held by `tests/isolated/factory.test.ts`. Measured by another session on the same night
 * against a different engine, and written down in oxia-live-check.ts before that.
 *
 * The address and the community can be given: `LIBREDB_SNMP_LIVE=127.0.0.1:1161` and
 * `LIBREDB_SNMP_COMMUNITY=libredb-live`.
 *
 * It exits non-zero when any check fails, prints each check with its verbatim error, and prints
 * what it measured so a reader can compare two runs without reading the code.
 */
import { readFileSync } from "node:fs";

import { SnmpProvider } from "../../src/lib/db/providers/network/snmp/index";
import type { DatabaseConnection } from "../../src/lib/types";
import { FIXTURE_COMMUNITY } from "../fixtures/snmp/identity";

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const RUNTIME = IS_BUN
  ? `bun ${(globalThis as { Bun: { version: string } }).Bun.version}`
  : `node ${process.versions.node}`;
const [HOST, PORT] = (process.env.LIBREDB_SNMP_LIVE ?? "127.0.0.1:1161").split(":");
const COMMUNITY = process.env.LIBREDB_SNMP_COMMUNITY ?? FIXTURE_COMMUNITY;
const PLAYPEN = "1.3.6.1.4.1.8072.9999.9999";

/*
 * How many checks this file is supposed to run.
 *
 * The summary used to be "ALL CHECKS PASSED", which says nothing about how many ran: delete a
 * check, or lose one to an early `return`, and the last line of a green run reads exactly the
 * same. The number below is declared rather than counted from what ran, because a count taken
 * from what ran can only ever agree with itself. Adding or removing a check means changing it,
 * and that is the point of it.
 */
const EXPECTED_CHECKS = 9;

let failures = 0;
let ran = 0;

async function check(name: string, run: () => Promise<void>): Promise<void> {
  ran += 1;
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function measure(what: string, value: unknown): void {
  console.log(`MEASURE ${JSON.stringify({ what, value })}`);
}

function expect(condition: boolean, said: string): void {
  if (!condition) throw new Error(said);
}

function connection(over: Partial<Record<string, unknown>> = {}): DatabaseConnection {
  return {
    id: "snmp-live",
    name: "snmp live",
    type: "snmp",
    host: HOST,
    port: Number(PORT),
    password: COMMUNITY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as unknown as DatabaseConnection;
}

async function withProvider<T>(
  over: Partial<Record<string, unknown>>,
  run: (p: SnmpProvider) => Promise<T>,
): Promise<T> {
  const provider = new SnmpProvider(connection(over), {});
  await provider.connect();
  try {
    return await run(provider);
  } finally {
    await provider.disconnect();
  }
}

/*
 * WHICH FIXTURE THIS RUN BELIEVES IT IS TALKING TO - recorded, not verified.
 *
 * An SNMP agent does not report the image it was built from, so no check here can confirm the
 * base. What a reader needs months later is simpler: which fixture a given run was about. The
 * digest is read from the Dockerfile the CI step builds from, and the CI step refuses to build
 * when that file does not carry the digest it names, so the two ends are held elsewhere.
 *
 * It never fails the run. When the file cannot be read it says so IN the value, because a
 * recording that quietly prints nothing is worse than one that says it measured nothing.
 */
const DOCKERFILE = "docker/snmp/Dockerfile";

function declaredBaseDigest(): string {
  try {
    const found = /FROM \S+@(sha256:[0-9a-f]{64})/.exec(readFileSync(DOCKERFILE, "utf8"));
    return found?.[1] ?? `not measured: ${DOCKERFILE} names no digest`;
  } catch {
    return `not measured: ${DOCKERFILE} was not readable from ${process.cwd()}`;
  }
}

console.log(`SNMP live check against ${HOST}:${PORT} under ${RUNTIME}`);
measure("fixture base digest, as the Dockerfile declares it", declaredBaseDigest());

// The values this fixture publishes are chosen to be recognisable, so a value read here cannot
// have come from anywhere else. docker/snmp/README.md lists them.
await check("the agent answers its own name", async () => {
  const rows = await withProvider({}, async (p) => (await p.query("get 1.3.6.1.2.1.1.5.0")).rows);
  expect(rows[0]?.value === "live-test-agent", `sysName read as ${JSON.stringify(rows[0]?.value)}`);
});

await check("a written name reads the same object as its identifier", async () => {
  const [byName, byOid] = await withProvider({}, async (p) => [
    (await p.query("get sysName.0")).rows[0]?.value,
    (await p.query("get 1.3.6.1.2.1.1.5.0")).rows[0]?.value,
  ]);
  expect(byName === byOid, `by name ${JSON.stringify(byName)}, by identifier ${JSON.stringify(byOid)}`);
});

await check("a walk reads every object of its subtree", async () => {
  const result = await withProvider({}, async (p) => p.query(`walk ${PLAYPEN}`));
  measure("playpen walk rows", result.rowCount);
  // Sixteen is what the fixture publishes and what `snmpwalk` reads from it.
  expect(result.rowCount === 16, `walk returned ${result.rowCount} rows, expected 16`);
  expect(
    result.rows.every((row) => String(row.object).startsWith(`${PLAYPEN}.`)),
    "a walk returned an object from outside its subtree",
  );
});

await check("a walk of a named group reads that group", async () => {
  const result = await withProvider({}, async (p) => p.query("walk system"));
  measure("system walk rows", result.rowCount);
  expect(result.rowCount === 38, `walk system returned ${result.rowCount} rows, expected 38`);
});

await check("a table shapes its rows by index", async () => {
  const result = await withProvider({}, async (p) => p.query(`table ${PLAYPEN}.10.1`));
  measure("table rows", result.rowCount);
  expect(result.rowCount === 3, `table returned ${result.rowCount} rows, expected 3`);
  const names = result.rows.map((row) => row.column2).join(",");
  expect(names === "sensor-one,sensor-two,sensor-three", `column 2 read as ${names}`);
});

await check("an object the agent does not have is no row, not an error", async () => {
  const result = await withProvider({}, async (p) => p.query(`get ${PLAYPEN}.404.0`));
  expect(result.rowCount === 0, `expected no rows, got ${result.rowCount}`);
});

await check("a wrong community is silence, not a wrong value", async () => {
  // The fixture enforces its community. An agent that answers every community would let a
  // provider send the wrong secret and still look healthy, which is why this is checked here and
  // not only in the fixture's README.
  let message = "";
  try {
    await withProvider({ password: "definitely-not-the-community" }, async (p) => p.query("get 1.3.6.1.2.1.1.5.0"));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  measure("wrong community answer", message.slice(0, 80));
  expect(message !== "", "a wrong community was accepted");
});

await check("the agent is left as it was found", async () => {
  // This provider writes nothing by construction: the egress valve parses every outgoing datagram
  // and refuses any PDU that is not a Get, GetNext or GetBulk. The check is still here because
  // "cannot write" is a claim about behaviour, and behaviour is what a live run can look at.
  const before = await withProvider({}, async (p) =>
    (await p.query(`walk ${PLAYPEN}`)).rows.map((r) => r.value).join("|"),
  );
  await withProvider({}, async (p) => p.query("walk system"));
  const after = await withProvider({}, async (p) =>
    (await p.query(`walk ${PLAYPEN}`)).rows.map((r) => r.value).join("|"),
  );
  expect(before === after, "the playpen values changed across a read-only run");
});

await check("the uptime the overview reports is read again, not remembered", async () => {
  // THE CLASS THIS CHECK IS FOR. A provider that reads a changing number once and keeps it will
  // pass every recorded test, because a recording is one frozen moment: the integration layer
  // cannot see a stale value at all. `sysUpTime` is the one value this fixture changes on its own,
  // so it is the one that can say whether a second read is a read.
  // BOTH READS ON ONE CONNECTION, which is the only shape that can catch this. Two connections
  // would each read fresh and a value cached at connect time would slip through unseen.
  const [first, second] = await withProvider({}, async (p) => {
    const before = (await p.getOverview()).uptime;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return [before, (await p.getOverview()).uptime];
  });
  measure("uptime, first read", first);
  measure("uptime, second read", second);
  expect(Number(second) > Number(first), `uptime did not move: ${first} then ${second}`);
});

console.log(`${ran - failures} of ${ran} checks passed`);
if (ran !== EXPECTED_CHECKS) {
  // A run that is short of checks is not a passing run. It is the same fact as an empty answer
  // read as a finished walk: nothing failed, because less was asked.
  console.log(`FAIL the run is short: ${ran} checks ran, ${EXPECTED_CHECKS} are declared in this file.`);
}
process.exit(failures === 0 && ran === EXPECTED_CHECKS ? 0 : 1);
