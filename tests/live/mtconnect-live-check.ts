/**
 * Opt-in live check for the MTConnect provider (#1722): against a running agent, does it read what
 * it says it reads, refuse what it says it refuses, and keep reading as the buffer moves?
 *
 * WHY THIS CANNOT BE A UNIT TEST, AND NOT THE INTEGRATION TEST EITHER. The integration test answers
 * from captures, so every answer it sees is of one frozen moment. An agent's buffer does not stand
 * still: sequence numbers advance while a session is open, and a window read at connect is a fact
 * with an expiry date. Only a live agent can say whether a provider still reads correctly a minute
 * after it connected, and that is the one question this file exists for.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. It runs under Bun and
 * CI runs it in the `MTConnect provider check` step of the `functional-smoke` job of
 * .github/workflows/ci.yml. That sentence was not here until 19 October 2026, and its absence
 * was the defect: the step existed as a file waiting to be pasted, nothing pasted it, and a
 * reader of this header could not tell a check CI asks for from one only a hand ever ran.
 * under Node, since the provider's transport is the repository's own and both runtimes drive it:
 *
 * Run it from the repository root, on Bun and on Node 24:
 *
 *   docker compose -f database-compose.yml up -d mtconnect mtconnect-adapter
 *   bun tests/live/mtconnect-live-check.ts
 *   bun build tests/live/mtconnect-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs"
 *   MTCONNECT_LIVE_ORIGIN=http://agent.example.net:5000 bun tests/live/mtconnect-live-check.ts
 *
 * The Node run goes through `bun build --target=node` rather than through Node's own TypeScript
 * support, which is how `tests/live/oxia-live-check.ts` does it: the `@/` alias is resolved while
 * bundling, so Node runs a plain `.mjs` and needs no resolver. Running the source directly under
 * `node --experimental-strip-types` answers ERR_MODULE_NOT_FOUND, measured.
 *
 * The provider is constructed directly rather than through `createDatabaseProvider`, for the reason
 * `oxia-live-check.ts` records: the factory imports every engine, and that graph does not bundle.
 *
 * It exits non-zero when any check fails, prints each check with its verbatim error, and prints each
 * measurement as one `MEASURE {json}` line.
 */
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import type { DatabaseConnection } from "@/lib/types";

const ORIGIN = new URL(process.env.MTCONNECT_LIVE_ORIGIN ?? "http://127.0.0.1:17322");
/** The adapter sends a position every ten seconds, so this is one step of the buffer plus slack. */
const STEP_MS = Number(process.env.MTCONNECT_LIVE_STEP_MS ?? 12_000);

let passed = 0;
let failures = 0;
let skipped = 0;
let total = 0;

/** Whether the agent answers at all, read once: a check that cannot run is not a check that passed. */
const agentAnswers = async (): Promise<boolean> => {
  try {
    const answer = await fetch(new URL("/probe", ORIGIN), { signal: AbortSignal.timeout(3_000) });
    return answer.ok;
  } catch {
    return false;
  }
};

const reachable = await agentAnswers();

/**
 * Where the fixture is MANDATORY, a skip is a failure.
 *
 * Locally an absent agent is an ordinary reason to skip. In CI it is not: the step starts the
 * fixture itself, so nothing answering means the step is measuring nothing. MEASURED while writing
 * `docker/mtconnect/ci-step.yml`: with the published port changed to a wrong one, every check
 * skipped, the integration test still answered from its captures, and the step exited 0. A run that
 * reaches no agent must not look like a run where everything passed.
 */
const required = process.env.MTCONNECT_LIVE_REQUIRED === "1";
if (required && !reachable) {
  console.log(`FAIL no agent is answering on ${ORIGIN.origin}, and MTCONNECT_LIVE_REQUIRED is set`);
  console.log("\n0 of 0 checks passed, 1 failed, 0 skipped");
  process.exit(1);
}

const check = async (name: string, run: () => Promise<void>): Promise<void> => {
  total += 1;
  if (!reachable) {
    skipped += 1;
    console.log(`SKIP ${name}`);
    console.log(`     no agent is answering on ${ORIGIN.origin}`);
    return;
  }
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
};

const measure = (what: string, value: unknown): void => {
  console.log(`MEASURE ${JSON.stringify({ what, value })}`);
};

const expect = (actual: unknown, wanted: unknown, what: string): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(wanted);
  if (left !== right) throw new Error(`${what}: read ${left}, wanted ${right}`);
};

const header = async (request: string, key: string): Promise<number> => {
  const answer = await fetch(new URL(request, ORIGIN));
  const body = await answer.text();
  const found = new RegExp(`${key}="(\\d+)"`).exec(body);
  if (found === null) throw new Error(`GET ${request} answered no ${key}`);
  return Number(found[1]);
};

const connect = async (): Promise<MTConnectProvider> => {
  const connection = {
    id: "mtconnect-live",
    name: "mtconnect live check",
    type: "mtconnect",
    host: ORIGIN.hostname,
    port: Number(ORIGIN.port === "" ? "80" : ORIGIN.port),
  } as DatabaseConnection;
  const provider = new MTConnectProvider(connection, {});
  await provider.connect();
  return provider;
};

const rowValues = (result: { rows: readonly unknown[] }, column: string): string[] =>
  result.rows.map((row) => String((row as Record<string, unknown>)[column]));

// The window rule, against a buffer that is moving rather than a captured one.
await check("the buffer's own next sequence is one past its last", async () => {
  const last = await header("/current", "lastSequence");
  const next = await header("/current", "nextSequence");
  measure("current.lastSequence", last);
  expect(next, last + 1, "/current nextSequence");
});

await check("a positive count narrows the Header it answers with", async () => {
  const narrowed = await header("/sample?count=1", "nextSequence");
  const buffer = await header("/current", "nextSequence");
  measure("sample?count=1 nextSequence", narrowed);
  if (narrowed >= buffer) throw new Error(`a count=1 answer reported ${narrowed}, which is not narrowed`);
  expect(narrowed, 2, "sample?count=1 nextSequence");
});

await check("the device sends the values this fixture declares", async () => {
  const provider = await connect();
  try {
    const current = await provider.query("GET /current");
    const values = rowValues(current, "value");
    measure("current rowCount", current.rowCount);
    for (const wanted of ["3600", "ACTIVE", "LIBREDB-TEST.NC"]) {
      if (!values.includes(wanted)) throw new Error(`current carries no ${wanted}`);
    }
    const position = values.find((value) => value.startsWith("172"));
    measure("X position", position ?? null);
    if (position === undefined) throw new Error("current carries no X position");
  } finally {
    await provider.disconnect();
  }
});

await check("an asset and a condition are read as themselves", async () => {
  const provider = await connect();
  try {
    const assets = await provider.query("GET /assets");
    expect(assets.rowCount, 1, "assets rowCount");
    expect(rowValues(assets, "assetId"), ["TOOL-1722"], "assets assetId");
    const condition = await provider.query(`GET /current?path=${'//DataItem[@category="CONDITION"]'}`);
    expect(condition.rowCount, 1, "condition rowCount");
    expect(rowValues(condition, "nativeCode"), ["SYS-1722"], "condition nativeCode");
  } finally {
    await provider.disconnect();
  }
});

await check("a sequence inside the buffer is read rather than refused", async () => {
  const provider = await connect();
  try {
    const last = await header("/current", "lastSequence");
    const result = await provider.query(`GET /current?at=${last - 5}`);
    if (result.rowCount === 0) throw new Error(`at=${last - 5} answered no rows`);
    measure("at rowCount", result.rowCount);
  } finally {
    await provider.disconnect();
  }
});

// The question only a live agent answers: the window is read once, at connect. The buffer then
// moves. Does a session still read what the agent is willing to serve?
await check("a sequence the buffer reached AFTER connect is still read", async () => {
  const provider = await connect();
  try {
    const atConnect = await header("/current", "nextSequence");
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    const now = await header("/current", "lastSequence");
    measure("buffer advanced by", now - (atConnect - 1));
    if (now < atConnect) throw new Error("the buffer did not advance, so this check measured nothing");
    const result = await provider.query(`GET /current?at=${now}`);
    if (result.rowCount === 0) throw new Error(`at=${now} answered no rows`);
  } finally {
    await provider.disconnect();
  }
});

// The summary carries the numbers rather than a word: a check that was deleted, or one that could
// not run, must not leave the same line behind as a run where every check passed. A skip is its own
// column for the same reason.
console.log(`\n${passed} of ${total} checks passed, ${failures} failed, ${skipped} skipped`);
process.exit(failures === 0 ? 0 : 1);
