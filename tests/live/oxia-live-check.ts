/**
 * Hand-run live check of the Oxia provider (SB3-5.7): does a real `OxiaProvider` read every seeded fixture
 * correctly, refuse what it refuses before any call, and change nothing?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The unit tests drive the provider over a fake client and the
 * integration test replays captures; only the servers can say that the reads are right and that nothing changed.
 * So this script reads the key count and the versions of `/versions/counter` and the marker before the first check
 * and after the last, and fails on any difference.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 * Run it from the repository root, after the compose seed and `tests/live/oxia-seed-raw.ts` (docker/oxia/README.md),
 * on Bun and on Node 24, on both server lines, the auth fixture and the cluster:
 *
 *   bun tests/live/oxia-live-check.ts --target 127.0.0.1:6648            # 0.16.10
 *   bun tests/live/oxia-live-check.ts --target 127.0.0.1:6668            # 0.17.1, profile oxia-017
 *   bun tests/live/oxia-live-check.ts --target 127.0.0.1:6658            # natural, profile oxia-natural
 *   bun tests/live/oxia-live-check.ts --target 127.0.0.1:6659            # natural blind spot, profile oxia-natural
 *   bun build tests/live/oxia-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs" --target 127.0.0.1:6648
 *   node "$OUT/live.mjs" --target 127.0.0.1:6668
 *   bun tests/live/oxia-live-check.ts --auth 127.0.0.1:6678 --ca <volume>/ca.crt --token <volume>/token.jwt
 *   bun tests/live/oxia-live-check.ts --cluster 127.0.0.1:6671
 *
 * It never writes: every read goes through the provider, whose parser refuses every write verb, and the one file of
 * tests/live that writes to an Oxia server is tests/live/oxia-seed-raw.ts. No token or key is written here: the auth
 * run reads the CA and the token from the file paths it is given, and prints `<token>` wherever a token would be.
 *
 * The provider is constructed directly with its default client factory, because the factory's every-engine import
 * graph does not bundle for the Node run (tests/live/etcd-live-check.ts keeps it out of its Node bundle for the same
 * reason); under Bun only, one more check builds the same connection through the factory.
 *
 * It prints one line per check, `PASS <name>` or `FAIL <name>: <error>`, then `<passed> of <total> checks passed on
 * <target> (<runtime>)`, and exits 1 on any failure; an argument it does not accept exits 2 before any socket opens.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryCancelledError } from "@/lib/db/errors";
import {
  parseOxiaCommand,
  OXIA_INTERNAL_KEY_SENTENCE,
  OXIA_REFUSED_COMMANDS,
} from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  admitLeaders,
  buildOxiaConnectionOptions,
  type OxiaConnectionOptions,
  oxiaEndpointText,
  oxiaErrorConnection,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import { OxiaError, receiveCapNotice, runBudgetNotice, toProviderError } from "@/lib/db/providers/keyvalue/oxia/errors";
import { createGrpcOxiaClient } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { OXIA_KEY_SCAN } from "@/lib/db/providers/keyvalue/oxia/key-scan";
import { keyOrderWords } from "@/lib/db/providers/keyvalue/oxia/labels";
import { keyComparator, type KeyOrder } from "@/lib/db/providers/keyvalue/oxia/order";
import { WITHHELD_VALUE_TEXT } from "@/lib/db/providers/keyvalue/oxia/values";
import { childrenPage, detectKeyOrder } from "@/lib/db/providers/keyvalue/oxia/walks";
import type { KeyScanPage, ObjectSourceDocument } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { oxiaConnection } from "../helpers/oxia-connection";
import { OXIA_FIXTURES, type OxiaFixture, oxiaFingerprint, requireOxiaMarker } from "./oxia-live-support";

// ============================================================================
// Arguments
// ============================================================================

const AUTH_TARGET = "127.0.0.1:6678";
const CLUSTER_TARGET = "127.0.0.1:6671";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const QUERY_TIMEOUT_MS = 30_000;
/** No fixture's walk takes this many pages; a walk that does is a defect, not a slow server. */
const MAX_PAGES = 10_000;
const README = path.join(process.cwd(), "docker/oxia/README.md");

const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;

type Mode =
  | { readonly kind: "target"; readonly fixture: OxiaFixture }
  | { readonly kind: "auth"; readonly ca: string; readonly token: string }
  | { readonly kind: "cluster" };

/** Refuses every argument this file does not accept, before any socket opens. */
function parseArguments(argv: readonly string[]): Mode {
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const target = option("--target");
  const auth = option("--auth");
  const cluster = option("--cluster");
  const given = [target, auth, cluster].filter((value) => value !== undefined);
  if (given.length !== 1) refuse("give exactly one of --target, --auth and --cluster");
  if (target !== undefined) {
    const fixture = OXIA_FIXTURES.find((row) => row.target === target && row.marker !== undefined);
    if (fixture === undefined) refuse(`--target must be a seeded fixture of OXIA_FIXTURES, not ${target}`);
    return { kind: "target", fixture };
  }
  if (auth !== undefined) {
    if (auth !== AUTH_TARGET) refuse(`--auth must be ${AUTH_TARGET}`);
    const ca = option("--ca");
    const token = option("--token");
    if (ca === undefined || token === undefined) refuse("--auth needs --ca <ca.crt> and --token <token.jwt>");
    return { kind: "auth", ca, token };
  }
  if (cluster !== CLUSTER_TARGET) refuse(`--cluster must be ${CLUSTER_TARGET}`);
  return { kind: "cluster" };
}

function refuse(reason: string): never {
  console.error(`oxia-live-check: ${reason}; nothing was dialled.`);
  process.exit(2);
}

// ============================================================================
// The checks
// ============================================================================

interface Tally {
  passed: number;
  total: number;
}

const tally: Tally = { passed: 0, total: 0 };
/** Every token the run holds, replaced by `<token>` in any line it prints. */
const secrets: string[] = [];

function redact(text: string): string {
  return secrets.reduce((line, secret) => line.split(secret).join("<token>"), text);
}

async function check(name: string, body: () => Promise<void>): Promise<void> {
  tally.total += 1;
  try {
    await body();
    tally.passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(redact(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}: expected ${e}, got ${a}`);
}

/** The message a rejected promise carries, or a failure when it answers. */
async function refusalOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a value that is not an Error: ${String(error)}`, { cause: error });
  }
  throw new Error("answered where a refusal was expected");
}

function warningsOf(result: QueryResult): string[] {
  return (result.warnings ?? []).map((warning) => warning.message);
}

/** The members of a shard's Source tab this check reads. */
interface ShardFacts {
  readonly key_order?: string;
  readonly key_order_learned?: string;
}

/** A shard's Source tab is one rendered JSON part. */
function shardFacts(document: ObjectSourceDocument): ShardFacts {
  const [part] = document.parts;
  if (part === undefined || !("text" in part)) throw new Error("the shard's Source tab holds no JSON part");
  return JSON.parse(part.text) as ShardFacts;
}

function endpointOf(target: string): { readonly host: string; readonly port: number } {
  const colon = target.lastIndexOf(":");
  return { host: target.slice(0, colon), port: Number(target.slice(colon + 1)) };
}

function provide(connection: DatabaseConnection): OxiaProvider {
  return new OxiaProvider(connection, { queryTimeout: QUERY_TIMEOUT_MS });
}

function optionsOf(connection: DatabaseConnection): OxiaConnectionOptions {
  return buildOxiaConnectionOptions(connection, { executionReadOnly: false, queryTimeout: QUERY_TIMEOUT_MS });
}

/** Every page of the Keys panel from the start until the cursor is "0". */
async function keyPages(provider: OxiaProvider, count: number, pattern?: string): Promise<KeyScanPage[]> {
  const pages: KeyScanPage[] = [];
  let cursor = "0";
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor.
    const page = await provider.scanKeysPage({ cursor, count, ...(pattern === undefined ? {} : { pattern }) });
    pages.push(page);
    cursor = page.cursor;
    assert(pages.length < MAX_PAGES, `the walk did not end within ${MAX_PAGES} pages`);
  } while (cursor !== "0");
  return pages;
}

/**
 * The walk's own keys: a first page with no pattern leads with the folders discovery found, each sorting after the
 * walk's part of that page, so they end where the encoder order first descends; every later key is the walk's.
 */
function walkPart(pages: readonly KeyScanPage[], order: KeyOrder): string[] {
  const compare = keyComparator(order);
  const [first, ...rest] = pages;
  const descent = first.keys.findIndex((key, i) => i > 0 && compare(first.keys[i - 1], key) > 0);
  return [...(descent === -1 ? first.keys : first.keys.slice(descent)), ...rest.flatMap((page) => page.keys)];
}

// ============================================================================
// docker/oxia/README.md, the expected key sets
// ============================================================================

interface SeededSet {
  readonly total: number;
  readonly fromSeedScript: number;
}

function readme(): string {
  return readFileSync(README, "utf8");
}

function seededSet(text: string, set: "full" | "small" | "blind"): SeededSet {
  const match = new RegExp(`^\`${set}\` holds ([\\d,]+) keys: ([\\d,]+) from \`seed\\.sh\``, "m").exec(text);
  if (match === null) throw new Error(`docker/oxia/README.md states no key count for ${set}`);
  const number = (digits: string) => Number(digits.replaceAll(",", ""));
  return { total: number(match[1]), fromSeedScript: number(match[2]) };
}

/** The `/admin/` keys of the `full` table. */
function adminKeys(text: string): string[] {
  const full = text.slice(text.indexOf("### full"), text.indexOf("### small"));
  return [...full.matchAll(/^\| `(\/admin\/[^`]*)` \|/gm)].map((match) => match[1]);
}

/** The key count a fixture holds: 0.17.1 has the seed script's keys only (SB3-5.7). */
function expectedKeyCount(fixture: OxiaFixture, text: string): number {
  const set = seededSet(text, fixture.marker as "full" | "small" | "blind");
  return fixture.set === "0.17.1" ? set.fromSeedScript : set.total;
}

/** Every console example of docs/providers/oxia.md: the text of each ```oxia fence. */
function docExamples(): string[] {
  const doc = readFileSync(path.join(process.cwd(), "docs/providers/oxia.md"), "utf8");
  return [...doc.matchAll(/^```oxia\n([\s\S]*?)\n```$/gm)].map((match) => match[1]);
}

// ============================================================================
// --target
// ============================================================================

async function targetRun(fixture: OxiaFixture): Promise<void> {
  const connection = oxiaConnection(endpointOf(fixture.target));
  const options = optionsOf(connection);
  const provider = provide(connection);
  const text = readme();
  const full = fixture.marker === "full";
  const context = { endpoint: oxiaEndpointText(options), namespace: options.namespace, readOnly: false };
  try {
    await provider.connect();
    await requireOxiaMarker(provider, fixture);
  } catch (error) {
    console.log(`FAIL marker: ${error instanceof Error ? error.message : String(error)}`);
    tally.total += 1;
    await provider.disconnect();
    return;
  }
  const before = await oxiaFingerprint(provider);
  const unchanged = async (what: string) => same(await oxiaFingerprint(provider), before, `the fingerprint ${what}`);

  await check("1 connect and Test Connection's path answer", async () => {
    await provider.disconnect();
    await provider.connect();
    await provider.getHealth();
  });

  if (typeof Bun !== "undefined") {
    await check("1b the factory builds an OxiaProvider for the same connection", async () => {
      // A specifier the bundler does not follow, so the factory's every-engine graph stays out of the Node bundle.
      const factoryModule = "@/lib/db/factory";
      const { createDatabaseProvider } = (await import(factoryModule)) as typeof import("@/lib/db/factory");
      const built = await createDatabaseProvider(connection, { queryTimeout: QUERY_TIMEOUT_MS });
      assert(built instanceof OxiaProvider, "the factory did not build an OxiaProvider");
    });
  }

  await check("2 the order verdict", async () => {
    const shard = shardFacts(await provider.readObjectSource(["0"], "shard"));
    same(
      shard.key_order_learned,
      keyOrderWords({ order: fixture.order, learnedBy: "ceiling-probe" }),
      "key_order_learned",
    );
    same(shard.key_order, fixture.order, "key_order");
    if (fixture.marker === "blind") {
      // The shard document words every detected path alike, so the path is read from the probe itself (ruling 17).
      // The children read is the walks' own, of the node -a: no console range spells a natural folder's children.
      const client = createGrpcOxiaClient(options);
      try {
        const call = { signal: new AbortController().signal, deadline: Date.now() + QUERY_TIMEOUT_MS };
        const snapshot = await client.getSnapshot(call);
        const verdict = await detectKeyOrder(client, snapshot, call);
        same(verdict.learnedBy, "decisive-list", "the probe's learnedBy");
        const children = await childrenPage(
          client,
          snapshot,
          verdict.order,
          { parent: "-a", count: OXIA_KEY_SCAN.defaultCount },
          call,
        );
        assert(children.keys.length > 0, "the children read of -a/ is empty");
      } finally {
        client.close();
      }
      const prefixed = await provider.scanKeysPage({ cursor: "0", count: OXIA_KEY_SCAN.defaultCount, pattern: "-a/" });
      assert(prefixed.keys.length > 0, "the prefix walk of -a/ is empty");
    }
  });

  await check("3 every console example of docs/providers/oxia.md answers a result", async () => {
    const examples = docExamples();
    assert(examples.length > 0, "docs/providers/oxia.md holds no oxia fence");
    for (const example of examples) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one example at a time, in the doc's order.
        await provider.query(example);
      } catch (error) {
        throw new Error(`${example}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  });

  await check("4 every refused command is refused with its message, and nothing moved", async () => {
    for (const entry of OXIA_REFUSED_COMMANDS) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is read on its own.
      const refusal = await refusalOf(() => provider.query(entry.verb));
      same(refusal.message, entry.message, entry.verb);
    }
    await unchanged("after the refused commands");
  });

  await check("5 a key under __oxia/ is refused", async () => {
    const refusal = await refusalOf(() => provider.query("get __oxia/x"));
    same(refusal.message, OXIA_INTERNAL_KEY_SENTENCE, "the refusal");
  });

  await check("6 the Keys panel walk holds every seeded key once, in encoder order", async () => {
    const pages = await keyPages(provider, OXIA_KEY_SCAN.defaultCount);
    const held = new Set(pages.flatMap((page) => page.keys));
    same(held.size, expectedKeyCount(fixture, text), "the keys held");
    const walked = walkPart(pages, fixture.order);
    same(walked.length, held.size, "the walk's part, each key once");
    const compare = keyComparator(fixture.order);
    const at = walked.findIndex((key, i) => i > 0 && compare(walked[i - 1], key) >= 0);
    assert(at === -1, `the walk is out of encoder order at position ${at}`);
  });

  if (full) {
    await check("7 the prefix walk over /admin/ answers the seeded /admin/ keys", async () => {
      const pages = await keyPages(provider, OXIA_KEY_SCAN.defaultCount, "/admin/");
      const compare = keyComparator(fixture.order);
      same(pages.flatMap((page) => page.keys).sort(compare), adminKeys(text).sort(compare), "the /admin/ keys");
    });

    await check("8 a value past the receive cap is withheld", async () => {
      const result = await provider.query("get /values/over-cap");
      same(result.rowCount, 1, "rows");
      same(result.rows[0]?.value, WITHHELD_VALUE_TEXT, "the value cell");
    });

    await check("9 the run budget and the receive cap stop with rows and a notice", async () => {
      const budget = await provider.query("range-scan -s /values/p -e /values/q");
      assert(budget.rowCount > 0, "the budget stop holds no rows");
      assert(
        warningsOf(budget).includes(runBudgetNotice("range-scan", budget.rowCount)),
        `the budget notice is missing: ${JSON.stringify(warningsOf(budget))}`,
      );
      // The range holds /values/over-cap alone, so the stop is a result whose rows are the records before it: none.
      const cap = await provider.query("range-scan -s /values/o -e /values/p");
      same(cap.rowCount, cap.rows.length, "the receive-cap stop's rows");
      assert(
        warningsOf(cap).includes(receiveCapNotice(cap.rowCount)),
        `the receive-cap notice is missing: ${JSON.stringify(warningsOf(cap))}`,
      );
    });
  }

  await check("10 --index with an empty -e and a word holding U+0000 are refused before any call", async () => {
    for (const command of ["list -s a -e '' --index by-email", "get /nul/a\u0000b"]) {
      const parsed = parseOxiaCommand(command, context);
      assert(!parsed.ok, `the parser accepted ${JSON.stringify(command)}`);
      // oxlint-disable-next-line no-await-in-loop -- each refusal is read on its own.
      const refusal = await refusalOf(() => provider.query(command));
      same(refusal.message, parsed.refusal.message, JSON.stringify(command));
    }
    await unchanged("after the refused parses");
  });

  // The cancel is issued once query() has registered the run, which it does before its first await, so it lands
  // before the run can answer on every fixture (ruling R31: a 20 ms timer raced fast scans). That every stream open
  // at a cancel is cancelled is held by the recorded-wire and fake tests (walks.test.ts, cluster-policy.test.ts).
  await check("11 a cancel while the run is in flight ends it, and the next read answers", async () => {
    const running = refusalOf(() => provider.query("range-scan -s '' -e ''", [], "live-cancel"));
    await Promise.resolve();
    await provider.cancelQuery("live-cancel");
    const refusal = await running;
    assert(refusal instanceof QueryCancelledError, `rejected with ${refusal.name}: ${refusal.message}`);
    await provider.query("get /libredb-fixture/seeded");
  });

  await check("12 health answers", async () => {
    await provider.getHealth();
  });

  await check("13 the final fingerprint equals the first", async () => {
    await unchanged("at the end");
  });

  await provider.disconnect();
}

// ============================================================================
// --auth
// ============================================================================

async function authRun(caPath: string, tokenPath: string): Promise<void> {
  const ca = readFileSync(caPath, "utf8");
  const token = readFileSync(tokenPath, "utf8").trim();
  secrets.push(token);
  const secured = (password?: string) =>
    oxiaConnection({
      host: "localhost",
      port: endpointOf(AUTH_TARGET).port,
      ssl: { mode: "verify-full", caCert: ca },
      ...(password === undefined ? {} : { password }),
    });
  const provider = provide(secured(token));
  const unauthenticated = (connection: DatabaseConnection, cause: "bad-signature" | "empty-token"): string =>
    toProviderError(new OxiaError("unauthenticated", { rpc: "GetShardAssignments", authCause: cause }), {
      operation: "connection test",
      connection: oxiaErrorConnection(optionsOf(connection)),
    }).message;
  let before: Awaited<ReturnType<typeof oxiaFingerprint>> | undefined;

  await check("connect and health answer over TLS with the token", async () => {
    await provider.connect();
    await provider.getHealth();
    before = await oxiaFingerprint(provider);
    same(before.keys, 0, "the keys of the auth fixture's namespace");
  });

  await check("the order verdict of the empty namespace", async () => {
    const shard = shardFacts(await provider.readObjectSource(["0"], "shard"));
    same(shard.key_order_learned, keyOrderWords({ order: "hierarchical", learnedBy: "empty" }), "key_order_learned");
  });

  await check("a token with a changed signature is refused with the bad-signature sentence", async () => {
    // The last character's top bit is always a signature bit; its low bits may be padding the server ignores, so a
    // change there alone (A to B on an RS256 token) is the same signature and is accepted.
    const at = BASE64URL.indexOf(token.at(-1) ?? "");
    assert(at !== -1, "the token does not end in a base64url character");
    const forged = `${token.slice(0, -1)}${BASE64URL[at ^ 32]}`;
    secrets.push(forged);
    const connection = secured(forged);
    const refusal = await refusalOf(() => provide(connection).connect());
    same(refusal.message, unauthenticated(connection, "bad-signature"), "the refusal");
  });

  await check("no token is refused with the empty-token sentence", async () => {
    const connection = secured();
    const refusal = await refusalOf(() => provide(connection).connect());
    same(refusal.message, unauthenticated(connection, "empty-token"), "the refusal");
  });

  await check("the namespace is unchanged", async () => {
    same(await oxiaFingerprint(provider), before, "the fingerprint");
  });

  await provider.disconnect();
}

// ============================================================================
// --cluster
// ============================================================================

async function clusterRun(): Promise<void> {
  const bootstrap = oxiaConnection(endpointOf(CLUSTER_TARGET));
  let dataServers: string | undefined;

  await check("the bootstrap alone is refused with the paste-ready Data servers value", async () => {
    const refusal = await refusalOf(() => provide(bootstrap).connect()).catch((error: unknown) => {
      throw new Error(
        `the cluster placed every leader on the bootstrap server, so the dial policy was not exercised (${String(error)})`,
      );
    });
    const value = refusal.message.slice(refusal.message.lastIndexOf(": ") + 2);
    const expected = admitLeaders(optionsOf(bootstrap), value.split(", ")).refusal;
    same(refusal.message, expected, "the refusal");
    dataServers = value;
  });

  await check("with that value under Data servers every shard and every key is read, and nothing moves", async () => {
    assert(dataServers !== undefined, "the refusal gave no Data servers value");
    const provider = provide({ ...bootstrap, dataServers });
    try {
      await provider.connect();
      const before = await oxiaFingerprint(provider);
      const shards = await provider.listObjects([], "shard");
      assert(shards.length > 0, "the cluster lists no shard");
      for (const shard of shards) {
        // oxlint-disable-next-line no-await-in-loop -- one Source tab at a time.
        await provider.readObjectSource(shard.path, "shard");
      }
      await keyPages(provider, OXIA_KEY_SCAN.defaultCount);
      same(await oxiaFingerprint(provider), before, "the fingerprint");
    } finally {
      await provider.disconnect();
    }
  });
}

// ============================================================================
// Main
// ============================================================================

const mode = parseArguments(process.argv.slice(2));
let target: string;
if (mode.kind === "target") {
  target = mode.fixture.target;
  await targetRun(mode.fixture);
} else if (mode.kind === "auth") {
  target = AUTH_TARGET;
  await authRun(mode.ca, mode.token);
} else {
  target = CLUSTER_TARGET;
  await clusterRun();
}
console.log(`${tally.passed} of ${tally.total} checks passed on ${target} (${RUNTIME})`);
process.exit(tally.passed === tally.total ? 0 : 1);
