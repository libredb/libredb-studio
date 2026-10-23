/**
 * Opt-in live check for the OPC UA provider (#1677): against a real server, does it read what it
 * says it reads, refuse what it says it refuses, and leave nothing behind?
 *
 * WHY THIS CANNOT BE A UNIT TEST. The seam guard is syntactic and the integration test answers from
 * captures, so neither can say what the SERVER saw: how many sessions it holds after a run, whether
 * a continuation point was released, whether a pin refuses before CreateSession. Only the server
 * can, and `CurrentSessionCount` is where it says so — on the servers that answer it at all.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name.
 * CI runs it in the `OPC UA read-only check` step of the `functional-smoke` job of
 * .github/workflows/ci.yml. That sentence was not here until 19 October 2026, and its absence
 * was the defect: the step existed as a file waiting to be pasted, nothing pasted it, and a
 * reader of this header could not tell a check CI asks for from one only a hand ever ran.
 *
 * Run it with the fixture of `tests/fixtures/opcua/README.md` up:
 *
 *   bun tests/live/opcua-live-check.ts
 *   LIBREDB_OPCUA_LIVE_URL=opc.tcp://plc.example.net:4840/ bun tests/live/opcua-live-check.ts
 *
 * It exits non-zero when any check fails, prints each check with its verbatim error, and prints each
 * measurement as one `MEASURE {json}` line.
 */
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCUA_CURRENT_SESSION_COUNT, OPCUA_OBJECTS_FOLDER } from "@/lib/db/providers/industrial/opcua/constants";
import { createDatabaseProvider } from "@/lib/db/factory";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import { OPCUA_LIBRARY_BRIDGE } from "@/lib/db/providers/industrial/opcua/library";
import { openReadOnlySession } from "@/lib/db/providers/industrial/opcua/session";
import { readHistory } from "@/lib/db/providers/industrial/opcua/history";
import type { OpcuaConnectionOptions } from "@/lib/db/providers/industrial/opcua/connection";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";

const ENDPOINT = process.env.LIBREDB_OPCUA_LIVE_URL ?? "opc.tcp://127.0.0.1:54840/";
const ROOTS: string[] = [];

let failures = 0;
function check(name: string, run: () => Promise<void>): Promise<void> {
  return run().then(
    () => {
      console.log(`PASS ${name}`);
    },
    (error: unknown) => {
      failures += 1;
      console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

function measure(what: string, value: unknown): void {
  console.log(`MEASURE ${JSON.stringify({ what, value })}`);
}

/** One connection, with a PKI root of its own so a run never reuses another's trust list. */
function options(over: Partial<OpcuaConnectionOptions> = {}): OpcuaConnectionOptions {
  const url = new URL(ENDPOINT);
  const pkiRoot = mkdtempSync(join(tmpdir(), "opcua-live-pki-"));
  ROOTS.push(pkiRoot);
  return {
    endpointUrl: ENDPOINT,
    host: url.hostname,
    port: Number(url.port || "4840"),
    mode: "None",
    identity: "anonymous",
    pkiRoot,
    tunnelled: false,
    ...over,
  };
}

/**
 * The server's own session count, or undefined where it will not say.
 *
 * NOT PORTABLE, and the spec does not promise it: OPC PLC and open62541 answer `i=2277`, asyncua
 * answers Good with an empty Variant, and Milo answers `BadNotReadable` even to an authenticated
 * session. An unreadable count is reported as unavailable, never as zero.
 */
async function sessionCount(client: OpcuaReadOnlyClient): Promise<number | undefined> {
  const [answer] = await client.read([OPCUA_CURRENT_SESSION_COUNT]);
  if (answer === undefined || answer.statusCode !== "Good" || typeof answer.value !== "number") return undefined;
  return answer.value;
}

const probe = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options());
const before = await sessionCount(probe);
measure("sessionCountBefore", before ?? "unavailable");

await check("one session serves a whole run, and the server's count says so", async () => {
  const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options());
  try {
    const during = await sessionCount(client);
    measure("sessionCountDuring", during ?? "unavailable");
    if (before !== undefined && during !== undefined && during !== before + 1) {
      throw new Error(`the run added ${during - before} sessions, not one`);
    }
    const [level] = await client.browse([OPCUA_OBJECTS_FOLDER]);
    if ((level?.references.length ?? 0) === 0) throw new Error("the Objects folder answered no children");
    measure("objectsFolderChildren", level?.references.length ?? 0);
  } finally {
    await client.close();
  }
});

await check("every session a run opened is closed, which the count after it shows", async () => {
  const after = await sessionCount(probe);
  measure("sessionCountAfter", after ?? "unavailable");
  if (before !== undefined && after !== undefined && after !== before) {
    throw new Error(`the server holds ${after} sessions, not the ${before} it held before the run`);
  }
});

await check("a history read pages by continuation point and ends on its own", async () => {
  const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options());
  try {
    const result = await readHistory(client, {
      nodeId: "ns=3;s=HistorianInt32",
      limit: 1_200,
    });
    measure("historyValues", result.values.length);
    measure("historyPages", result.pages);
    measure("historyPaging", result.paging);
    measure("historyEnd", result.end);
    if (result.pages < 2) throw new Error(`the read took ${result.pages} page(s), so paging was not exercised`);
    if (result.values.length === 0) throw new Error("the read answered no values at all");
  } finally {
    await client.close();
  }
});

await check("a wrong certificate pin refuses, and refuses before a session exists", async () => {
  const wrong = "0".repeat(64);
  const countBefore = await sessionCount(probe);
  try {
    const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options({ pinnedThumbprint: wrong }));
    await client.close();
    throw new Error("the pin did not refuse");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pins the server certificate")) {
      throw new Error(`refused for another reason: ${message}`, {
        cause: error,
      });
    }
  }
  const countAfter = await sessionCount(probe);
  if (countBefore !== undefined && countAfter !== undefined && countAfter !== countBefore) {
    throw new Error("the refusal still opened a session");
  }
});

await check("every endpoint is a mode AND a policy, and a pair the server lacks is refused", async () => {
  const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints(options());
  measure("endpointsOffered", endpoints.length);
  const modes = [...new Set(endpoints.map((endpoint) => endpoint.securityMode))].sort();
  measure("securityModes", modes);
  measure("securityPolicies", [...new Set(endpoints.map((endpoint) => endpoint.securityPolicyUri.split("#")[1]))]);
  // The advertised URL is recorded and never dialled: OPC PLC advertises its container hostname.
  measure("advertisedUrl", endpoints[0]?.advertisedUrl ?? "none");

  // THE CHECK THAT USED TO ASSERT NOTHING. A server offering all three modes cannot refuse one, so
  // what is held to a refusal here is the POLICY: `Basic128Rsa15` is obsolete and no current server
  // offers it, and an endpoint is the pair rather than the mode.
  const missing = "http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15";
  if (endpoints.some((endpoint) => endpoint.securityPolicyUri === missing)) {
    throw new Error("this server offers the obsolete policy, so the refusal cannot be measured here");
  }
  let refused = "";
  try {
    const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options({ mode: modes[0], policyUri: missing }));
    await client.close();
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  measure("policyRefusal", refused.slice(0, 80) || "none");
  if (!refused.includes("with the policy")) throw new Error("a policy the server does not offer was not refused");
});

/**
 * THE MODE THE DIALOG'S DEFAULT MEANS. Every secured endpoint is a (mode, policy) pair, so a dial
 * carrying the mode and not the policy reaches none of them: measured, that refused every
 * SignAndEncrypt and Sign connection with "Cannot find an Endpoint matching security mode: 3".
 */
await check("a secured mode reaches the server's own endpoint for it", async () => {
  const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints(options());
  const secured = endpoints.find((endpoint) => endpoint.securityMode === "SignAndEncrypt");
  if (secured === undefined) {
    measure("securedModeOffered", false);
    return;
  }
  measure("securedPolicy", secured.securityPolicyUri.split("#")[1] ?? "");
  try {
    const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options({ mode: "SignAndEncrypt" }));
    try {
      const [level] = await client.browse([OPCUA_OBJECTS_FOLDER]);
      measure("securedBrowseChildren", level?.references.length ?? 0);
    } finally {
      await client.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A STRICT TRUST LIST IS NOT A DEFECT, and this is the one refusal expected here: the server's
    // certificate is unknown to a fresh PKI root until an administrator puts it in the trust list.
    // Anything else is the wiring failing, and the two must not be confused.
    if (!message.includes("BadCertificateUntrusted") && !message.includes("not trusted")) throw error;
    measure("securedModeRefusal", "BadCertificateUntrusted (the trust list, as designed)");
  }
});

/**
 * A CAP IS EXACT, AND A REFUSAL IS NOT AN EMPTY WINDOW. Both were measured wrong before: a capped
 * read answered 800 of 1,475 values and reported the window exhausted, because the page size shrank
 * as the cap came closer and the continuation was then refused.
 *
 * THE CAPS ARE CHOSEN FROM WHAT THE NODE HOLDS, not written here, because the node GROWS: OPC PLC
 * appends a value every 10 s, so a node that held 1,667 values during one measurement held 2,000
 * during the next and holds a few hundred on a server started a minute ago. Caps written as
 * literals made this check pass on a long-running fixture and FAIL on a correct one started from
 * the command `tests/fixtures/opcua/README.md` gives - a check that depends on how long the fixture
 * has been up measures the clock, not the provider.
 */
await check("a capped history read is exact, and says the node holds more", async () => {
  const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options());
  try {
    const whole = await readHistory(client, {
      nodeId: "ns=3;s=HistorianInt32",
      limit: 10_000,
    });
    const held = whole.values.length;
    measure("historyWhole", {
      values: held,
      end: whole.end,
      pages: whole.pages,
    });
    if (held < 4) throw new Error(`the historized node holds ${held} values, too few to cap: let the fixture run`);

    // Every cap strictly below what the node holds must be exact AND say there is more.
    const caps = [...new Set([held - 1, Math.floor(held / 2), Math.max(1, Math.floor(held / 4)), 1])].filter(
      (cap) => cap >= 1 && cap < held,
    );
    for (const limit of caps) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another, so the server's load is fixed.
      const capped = await readHistory(client, {
        nodeId: "ns=3;s=HistorianInt32",
        limit,
      });
      measure(`historyCapped:${limit}`, {
        values: capped.values.length,
        end: capped.end,
        pages: capped.pages,
      });
      if (capped.values.length !== limit) throw new Error(`a cap of ${limit} answered ${capped.values.length} values`);
      if (capped.end !== "value-cap") throw new Error(`a cap of ${limit} ended as ${capped.end}`);
    }

    // And a cap ABOVE what it holds is the other fact: the window is spent, not the cap.
    const over = await readHistory(client, {
      nodeId: "ns=3;s=HistorianInt32",
      limit: held + 1_000,
    });
    measure("historyOverCap", { values: over.values.length, end: over.end });
    if (over.end !== "exhausted") throw new Error(`a cap above the history ended as ${over.end}`);
    if (over.values.length < held) {
      throw new Error(`a cap above the history answered ${over.values.length} of at least ${held}`);
    }
  } finally {
    await client.close();
  }
});

await check("a node that keeps no history is told apart from an empty window", async () => {
  const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options());
  try {
    for (const [nodeId, what] of [
      ["ns=3;s=SlowUInt1", "keeps no history"],
      ["ns=3;s=NoSuchNodeAtAll", "does not exist"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another, so the server's load is fixed.
      const result = await readHistory(client, { nodeId, limit: 100 });
      measure(`historyRefusal:${what}`, {
        end: result.end,
        statusCode: result.statusCode ?? "none",
      });
      if (result.end !== "refused" || result.statusCode === undefined) {
        throw new Error(`a node that ${what} answered end=${result.end} with no status code`);
      }
    }
  } finally {
    await client.close();
  }
});

/**
 * THE PANEL'S OWN REQUEST, which is the shape no test sent until a review drove the real one:
 * `level: true`, `cursor: "0"`, and either no pattern at all for the root or one carrying the
 * separator. The first version of this check sent `cursor: ""` and `pattern: ""`, both of which
 * `POST /api/db/keys/scan` refuses outright, so it was measuring a request the panel cannot make
 * and it agreed with a provider whose levels never ended.
 */
await check("the Keys panel's own request answers folders as prefixes and pages by its last entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "opcua-live-pki-"));
  ROOTS.push(root);
  const was = process.env[OPCUA_PKI_ROOT_ENV];
  process.env[OPCUA_PKI_ROOT_ENV] = root;
  const provider = await createDatabaseProvider({
    id: "live-check",
    name: "live",
    type: "opcua",
    host: ENDPOINT,
    securityMode: "None",
    createdAt: new Date(0),
  } as never);
  try {
    await provider.connect();
    if (provider.scanKeysPage === undefined) throw new Error("the provider declares keyScan with no page");
    const first = await provider.scanKeysPage({
      cursor: "0",
      count: 4,
      level: true,
    });
    measure("levelRootEntries", {
      keys: first.keys.length,
      prefixes: (first.prefixes ?? []).length,
    });
    if ((first.prefixes ?? []).length === 0) throw new Error("the root level answered no folder at all");
    for (const prefix of first.prefixes ?? []) {
      if (!prefix.endsWith("/")) throw new Error(`a folder is not one level deeper: ${prefix}`);
    }
    if (first.keys.length + (first.prefixes ?? []).length > 4) throw new Error("a page exceeded its count");

    const folder = (first.prefixes ?? [])[0] ?? "";
    const deeper = await provider.scanKeysPage({
      cursor: "0",
      count: 50,
      level: true,
      pattern: folder,
    });
    measure("levelDeeper", {
      pattern: folder,
      keys: deeper.keys.length,
      prefixes: (deeper.prefixes ?? []).length,
    });
    for (const entry of [...deeper.keys, ...(deeper.prefixes ?? [])]) {
      if (!entry.startsWith(folder)) throw new Error(`an entry outside the level: ${entry}`);
    }

    const second = await provider.scanKeysPage({
      cursor: first.cursor,
      count: 4,
      level: true,
    });
    const overlap = [...second.keys, ...(second.prefixes ?? [])].filter((entry) =>
      [...first.keys, ...(first.prefixes ?? [])].includes(entry),
    );
    measure("levelPagingOverlap", overlap.length);
    if (overlap.length > 0) throw new Error(`the second page repeated ${overlap.join(", ")}`);

    /*
     * THE LEVEL HAS TO END, AND IT HAS TO END IN `"0"`. `use-key-scan.ts` reads nothing else as the
     * end, and the route refuses the empty string this provider used to answer, so a level that
     * never said `"0"` left List more and every folder's Load more enabled for ever and answered
     * HTTP 400 when pressed. Walked here to its end against the real server, counting pages so a
     * cursor that does not advance fails rather than hangs.
     */
    let cursor = "0";
    let pages = 0;
    const walked: string[] = [];
    do {
      const page = await provider.scanKeysPage({
        cursor,
        count: 2,
        level: true,
      });
      walked.push(...page.keys, ...(page.prefixes ?? []));
      cursor = page.cursor;
      pages += 1;
      if (pages > 60) throw new Error("the root level never reported itself finished");
    } while (cursor !== "0");
    measure("levelPagesToTheEnd", {
      pages,
      entries: walked.length,
      unique: new Set(walked).size,
    });
    if (walked.length !== new Set(walked).size) throw new Error("paging the root level repeated an entry");
    const whole = await provider.scanKeysPage({
      cursor: "0",
      count: 1_000,
      level: true,
    });
    const onePage = [...whole.keys, ...(whole.prefixes ?? [])];
    if (whole.cursor !== "0") throw new Error("a level read in one page did not report itself finished");
    if (onePage.length !== walked.length)
      throw new Error(`the level is ${onePage.length} entries and paging it answered ${walked.length}`);

    // A cursor from another level is refused rather than read as a start, which is what kept a
    // stale press from being served page one as though it were page two.
    let refused = "";
    try {
      await provider.scanKeysPage({
        cursor: `after:${folder}Nope`,
        count: 4,
        level: true,
      });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    measure("levelForeignCursorRefusal", refused);
    if (!refused.includes("Open the folder again")) throw new Error("a foreign cursor was not refused");
  } finally {
    await provider.disconnect();
    if (was === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
    else process.env[OPCUA_PKI_ROOT_ENV] = was;
  }
});

/**
 * A VARIABLE THAT BEARS CHILDREN IS A KEY AND A FOLDER, and `Server/ServerStatus` is one on every
 * OPC UA server: a structured value with eight children under it. Drawn as a folder alone - which
 * is what this provider did - the row is a twisty and nothing else, and the server's own state,
 * start time and build info can be reached only by someone who already knows to type a node id into
 * the console. This is the check that needs a real server: no capture has such a node.
 */
await check("a Variable that bears children is answered as a key AND a folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "opcua-live-pki-"));
  ROOTS.push(root);
  const was = process.env[OPCUA_PKI_ROOT_ENV];
  process.env[OPCUA_PKI_ROOT_ENV] = root;
  const provider = await createDatabaseProvider({
    id: "live-dual",
    name: "live",
    type: "opcua",
    host: ENDPOINT,
    securityMode: "None",
    createdAt: new Date(0),
  } as never);
  try {
    await provider.connect();
    if (provider.scanKeysPage === undefined) throw new Error("the provider declares keyScan with no page");
    const page = await provider.scanKeysPage({
      cursor: "0",
      count: 200,
      pattern: "Server/",
      level: true,
    });
    const key = page.keys.includes("Server/ServerStatus");
    const folder = (page.prefixes ?? []).includes("Server/ServerStatus/");
    measure("dualRow", {
      key,
      folder,
      type: page.types["Server/ServerStatus"],
    });
    if (!key) throw new Error("Server/ServerStatus is not a key, so its value cannot be opened");
    if (!folder) throw new Error("Server/ServerStatus is not a folder, so its children cannot be reached");
    if (page.types["Server/ServerStatus"] !== "variable") throw new Error("the dual row carries no type");
    // And the value really is there to open, which is what makes the key row worth having.
    const document = await provider.readObjectSource?.(["Server", "ServerStatus"], "node");
    // `ObjectSourcePart` is a union: only the READABLE arm carries text, and a refusal arm carries
    // none, so the narrow is what proves the document is a readable one.
    const part = document?.parts[0];
    const text = part !== undefined && "text" in part ? part.text : "";
    measure("dualRowValue", text.slice(0, 120).replaceAll(/\s+/g, " "));
    if (!text.includes('"nodeClass": "Variable"')) throw new Error("the dual row's Source document is not a Variable");

    // An Object that bears children stays a folder only: it has no Value attribute at all.
    if (page.keys.includes("Server/ServerCapabilities")) {
      throw new Error(
        "an Object that bears children was answered as a key, and reading one answers BadAttributeIdInvalid",
      );
    }

    // A provider can be connected again after a disconnect, which it could not: the pool latches
    // closed on purpose, and `connect()` builds a new one.
    await provider.disconnect();
    await provider.connect();
    const again = await provider.query(JSON.stringify({ read: ["i=2258"] }));
    measure("reconnect", {
      connected: provider.isConnected(),
      rows: again.rows.length,
    });
    if (again.rows.length !== 1) throw new Error("a reconnected provider did not read");
  } finally {
    await provider.disconnect();
    if (was === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
    else process.env[OPCUA_PKI_ROOT_ENV] = was;
  }
});

/**
 * THE TWO REFUSALS ON THE WAY TO A SESSION, both of which used to be the library's own words.
 *
 * A closed port is the most ordinary failure on a plant floor and was answered HTTP 500
 * INTERNAL_ERROR with three lines of library prose; a username against a server that offers
 * Anonymous only - this fixture - was answered "Cannot find USERNAME user token policy in end point
 * description", grammar mistake included.
 */
await check("a dead endpoint and a username the server does not take are this provider's own sentences", async () => {
  const root = mkdtempSync(join(tmpdir(), "opcua-live-pki-"));
  ROOTS.push(root);
  const was = process.env[OPCUA_PKI_ROOT_ENV];
  process.env[OPCUA_PKI_ROOT_ENV] = root;
  try {
    const dead = await createDatabaseProvider({
      id: "live-dead",
      name: "live",
      type: "opcua",
      // A port nothing listens on, on this machine: the dial fails before any endpoint is read.
      host: "opc.tcp://127.0.0.1:54999/",
      securityMode: "None",
      createdAt: new Date(0),
    } as never);
    let deadMessage = "";
    try {
      await dead.connect();
    } catch (error) {
      deadMessage = error instanceof Error ? error.message : String(error);
    }
    measure("deadEndpointRefusal", deadMessage);
    if (!deadMessage.includes("could not be opened to opc.tcp://127.0.0.1:54999/")) {
      throw new Error(`a dead endpoint did not answer this provider's own sentence: ${deadMessage}`);
    }
    if (deadMessage.includes("\n")) throw new Error("the refusal carries a newline, which nothing that draws it reads");

    const named = await createDatabaseProvider({
      id: "live-user",
      name: "live",
      type: "opcua",
      host: ENDPOINT,
      securityMode: "None",
      user: "plant-reader",
      password: "s3cret",
      createdAt: new Date(0),
    } as never);
    let userMessage = "";
    try {
      await named.connect();
    } catch (error) {
      userMessage = error instanceof Error ? error.message : String(error);
    }
    measure("noUserNameTokenRefusal", userMessage);
    if (!userMessage.includes("takes no username")) {
      throw new Error(`a username the server does not take did not answer our sentence: ${userMessage}`);
    }
    // O-S8: neither refusal carries the credential.
    for (const message of [deadMessage, userMessage]) {
      if (message.includes("s3cret") || message.includes("plant-reader")) {
        throw new Error("a refusal carried the credential");
      }
    }
  } finally {
    if (was === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
    else process.env[OPCUA_PKI_ROOT_ENV] = was;
  }
});

/*
 * A PKI ROOT THAT CANNOT BE CREATED IS A CONFIGURATION FAULT, AND IT NAMES ITSELF. The directory is
 * written on the first connect of an installation, so this is the failure a read-only data directory
 * produces - a container with a read-only mount, or a host directory owned by another uid - and it
 * used to arrive as the connect's generic sentence about the ENDPOINT, with the server listening and
 * the reader never told that a directory was the matter, nor which one, nor the variable that moves
 * it. Live rather than unit, because only the real certificate manager writes there.
 */
await check("a PKI root that cannot be created names the directory and the variable", async () => {
  const parent = mkdtempSync(join(tmpdir(), "opcua-live-ro-"));
  ROOTS.push(parent);
  const root = join(parent, "pki");
  chmodSync(parent, 0o500);
  try {
    // A process that can write it anyway (root, or a permissive filesystem) cannot measure this, and
    // says so rather than passing on an assertion it never reached.
    try {
      mkdirSync(join(parent, "probe"));
      measure("readOnlyPkiRootReachable", false);
      return;
    } catch {
      measure("readOnlyPkiRootReachable", true);
    }

    const was = process.env[OPCUA_PKI_ROOT_ENV];
    process.env[OPCUA_PKI_ROOT_ENV] = root;
    let message = "";
    try {
      const provider = await createDatabaseProvider({
        id: "live-ro-pki",
        name: "live",
        type: "opcua",
        host: ENDPOINT,
        securityMode: "None",
        createdAt: new Date(0),
      } as never);
      await provider.connect();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      if (was === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
      else process.env[OPCUA_PKI_ROOT_ENV] = was;
    }
    measure("readOnlyPkiRootRefusal", message);
    for (const wanted of [root, OPCUA_PKI_ROOT_ENV, "certificate directory"]) {
      if (!message.includes(wanted)) throw new Error(`the refusal does not name ${wanted}: ${message}`);
    }
    if (message.includes("could not be opened to")) {
      throw new Error(`the refusal blames the endpoint for a directory fault: ${message}`);
    }
  } finally {
    chmodSync(parent, 0o700);
  }
});

await probe.close();
for (const root of ROOTS) rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
