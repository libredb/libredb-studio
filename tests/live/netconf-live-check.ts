/**
 * Hand-run live check of the NETCONF provider: does a real `NetconfProvider` read a real device
 * correctly, refuse what it refuses, and leave the device able to answer somebody else?
 *
 * WHY THIS EXISTS, AND WHAT NO OTHER LAYER CAN SAY. `tests/unit/db/netconf/` drives each module
 * against hand-written replies, and `tests/integration/db/netconf-provider.test.ts` replays bytes
 * this device really sent, which reaches everything but the socket. Three claims are left over,
 * and they are the reason this file exists:
 *
 *   1. THE HOST KEY. The replay builds a key of its own and pins its own hash, because a recorded
 *      host key is what a secret looks like to a scanner and the pre-commit scan refuses it. So
 *      the replay proves the comparison and not the pairing. Here the pin is read out of band with
 *      `ssh-keyscan`, the key is the device's, and a wrong pin is refused by a real handshake.
 *   2. THE SSH HANDSHAKE AND THE DEVICE'S OWN AUTHENTICATION. A wrong password is refused by
 *      Netopeer2, not by a fake.
 *   3. THE SECOND SESSION. A device's session table is a shared resource, and nothing below this
 *      layer can say that the one this provider opened was given back.
 *
 * AND ONE CLAIM THIS RUN DID NOT REACH, MEASURED rather than assumed. The transport decodes UTF-8
 * with a `StringDecoder` so that a character split across two reads is held back instead of
 * becoming two replacement characters. Every one of the fixture's 5,000 interface descriptions
 * carries a four-byte character for that case. MEASURED 2026-10-15 by counting ssh2's own buffers
 * on the channel: the big read arrived in 228 chunks, 1,119,615 bytes, the largest 10,240, and
 * NOT ONE of the 228 boundaries fell inside a character.
 *
 * WHAT THAT MEASUREMENT COVERS, exactly: this fixture, this read size, this runtime, one run. It
 * is NOT a claim that a live socket never splits a character - where the boundaries fall is the
 * server's write pattern and the SSH packet size, and neither is controlled here. It is also not
 * measured on another device, at another read size, or under load. So the held-back path is
 * UNMEASURED by this file rather than proven unreachable, and
 * `tests/unit/db/netconf/netconf.test.ts` remains the only place that reaches it. What this file
 * claims instead is the thing it can: all 5,000 four-byte characters arrive intact.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * CI runs it in the `NETCONF live check` step of the `functional-smoke` job of
 * .github/workflows/ci.yml. That sentence was not here until 19 October 2026, and its absence
 * was the defect: the step existed as a file waiting to be pasted, nothing pasted it, and a
 * reader of this header could not tell a check CI asks for from one only a hand ever ran.
 * `tests/runner/discover.ts`).
 *
 * Run it from the repository root against the fixture (`docker/netconf/README.md`), on Bun and on
 * Node, with the pin read out of band because the image generates its host key at BUILD time:
 *
 *   export NETCONF_LIVE_FINGERPRINT="$(ssh-keyscan -T 5 -p 1830 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}')"
 *   export NETCONF_LIVE_PASSWORD=...        # the fixture's read-only account, named in docker/netconf/README.md
 *   bun tests/live/netconf-live-check.ts
 *   bun build tests/live/netconf-live-check.ts --target=node --external cpu-features --outfile "$out/live.mjs"
 *   node "$out/live.mjs"
 *   bun tests/live/netconf-live-check.ts --target 127.0.0.1:1830 --key /tmp/ro-key
 *
 * NO CREDENTIAL IS WRITTEN HERE and none has a default: a password in a committed file is a
 * published credential whatever it unlocks. The password comes from the environment and the
 * fingerprint from `ssh-keyscan`, and without either this exits 2 before anything is dialled.
 *
 * It never writes to the device, and there is no code here that could: the provider sends get,
 * get-config, get-data, get-schema and close-session and nothing else, which is what
 * `enforcesReadOnly` claims. The last checks read the list again and compare it to the first read,
 * so a run that somehow changed the device would say so rather than be believed.
 *
 * `--external cpu-features` IS REQUIRED and is not a precaution. MEASURED 2026-10-15: without it
 * `bun build --target=node` fails with `Could not resolve: "../build/Release/cpufeatures.node"`,
 * because `ssh2` reaches for an optional native module that is not built here. ssh2 loads it in a
 * try/catch, so a Node run without it works: 16 of 17 checks on node 24.22.0 against this fixture.
 *
 * The provider is constructed directly with the real ports rather than through
 * `src/lib/db/factory.ts`, because that module imports every engine and its import graph does not
 * bundle for the Node run - the same reason `tests/live/etcd-live-check.ts` and
 * `tests/live/oxia-live-check.ts` keep it out. Under Bun alone, one further check opens the
 * provider through its OWN default device layer, the dynamic import in `index.ts`, which is the
 * path the application takes and the one no other check here exercises.
 *
 * It prints one line per check, `PASS <name>` or `FAIL <name>: <error>`, a `NOT MEASURED <name>`
 * line for a claim this run could not ask, then `<passed> of <total> checks passed on <target>
 * (<runtime>)`, and exits 1 on any failure; an argument it does not accept exits 2 before any
 * socket opens.
 */
import { readFileSync } from "node:fs";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import { NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { openNetconfReader } from "@/lib/db/providers/network/netconf/open";
import { nodeSocketPort, nodeSshPort } from "@/lib/db/providers/network/netconf/node-ports";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { KindCount, ObjectSourceDocument } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const DEFAULT_TARGET = "127.0.0.1:1830";
const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;

/**
 * The image this check's expected numbers were measured against.
 *
 * The Modbus fixture is pulled and pinned by digest; this one is BUILT from source, so there is no
 * digest to hold and the tag is what names it. `docker/netconf/SHA256SUMS` is what pins what goes
 * into it, and the `NETCONF live check` step of `.github/workflows/ci.yml` builds this tag and
 * exports it here.
 *
 * It is a gate rather than a note, for the reason the Modbus one became one: an exported variable
 * nothing reads records an intention and enforces none. Set to anything else, this check refuses
 * rather than measure a device whose module list it cannot vouch for. Unset is allowed and says so
 * in the summary, because a developer runs this against the fixture with no environment at all.
 */
const PINNED_IMAGE = "libredb-fixture/netconf:2.8.7";
const declaredImage = process.env.NETCONF_LIVE_IMAGE;
if (declaredImage !== undefined && declaredImage !== PINNED_IMAGE) {
  console.error(
    `netconf-live-check: NETCONF_LIVE_IMAGE is ${declaredImage}, and this check's numbers were measured ` +
      `against ${PINNED_IMAGE}; nothing was dialled.`,
  );
  process.exit(2);
}

/**
 * What the fixture holds, MEASURED 2026-10-15 against `libredb-fixture/netconf:2.8.7`.
 *
 * The five datastores are the device's own capabilities rather than a list chosen here: `running`
 * always, `candidate` and `startup` from `:candidate` and `:startup`, and `operational` and
 * `intended` from the NMDA capability. The module count is of modules the YANG library reports as
 * `implement`, which is fewer than the texts `get-schema` will serve.
 *
 * The interface count is the one thing here a reader can change without rebuilding the image, with
 * `LIBREDB_NETCONF_INTERFACES`, so it is read from the environment and the refusal names the
 * variable rather than calling the device wrong.
 */
const DATASTORES = ["running", "candidate", "startup", "operational", "intended"];
const MODULES = 52;
const MODULE = "ietf-interfaces";
const INTERFACES = Number(process.env.NETCONF_LIVE_INTERFACES ?? "5000");
/** The four-byte character every description carries, so the decoder has a case to get wrong. */
const FOUR_BYTE = "\u{1F600}";

interface Options {
  readonly target: string;
  readonly fingerprint: string;
  readonly password: string;
  readonly user: string;
  readonly keyFile: string | undefined;
}

function refuse(reason: string): never {
  console.error(`netconf-live-check: ${reason}; nothing was dialled.`);
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  let target = DEFAULT_TARGET;
  let keyFile: string | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const value = argv[at + 1];
    if (argv[at] === "--target") {
      if (value === undefined) refuse("--target needs <host:port>");
      target = value;
      at += 1;
      continue;
    }
    if (argv[at] === "--key") {
      if (value === undefined) refuse("--key needs the path of a private key file");
      keyFile = value;
      at += 1;
      continue;
    }
    refuse(`unknown argument ${JSON.stringify(argv[at])}`);
  }
  if (!/^[^\s:]+:\d+$/.test(target)) refuse(`--target must be <host:port>, not ${JSON.stringify(target)}`);

  const fingerprint = process.env.NETCONF_LIVE_FINGERPRINT ?? "";
  if (!fingerprint.startsWith("SHA256:")) {
    // Read out of band rather than carried here, and the fixture's own shape is why: the host key
    // is generated when the image is BUILT, so a constant written in this file would be wrong on
    // the next build. It is also how the provider's own refusal tells a user to get one.
    refuse(
      "set NETCONF_LIVE_FINGERPRINT to the device's host key fingerprint; read it with\n" +
        "  ssh-keyscan -p <port> <host> | ssh-keygen -lf -",
    );
  }
  const password = process.env.NETCONF_LIVE_PASSWORD ?? "";
  if (password === "") {
    refuse(
      "set NETCONF_LIVE_PASSWORD to the device's read-only account password (the fixture's is named " +
        "in docker/netconf/README.md)",
    );
  }
  if (!Number.isInteger(INTERFACES) || INTERFACES < 1) {
    refuse(`NETCONF_LIVE_INTERFACES is ${JSON.stringify(process.env.NETCONF_LIVE_INTERFACES)}, which is not a count`);
  }
  return { target, fingerprint, password, user: process.env.NETCONF_LIVE_USER ?? "ro-pass", keyFile };
}

const options = parseOptions(process.argv.slice(2));
const host = options.target.slice(0, options.target.lastIndexOf(":"));
const port = Number(options.target.slice(options.target.lastIndexOf(":") + 1));

const tally = { passed: 0, total: 0, notMeasured: 0 };

async function check(name: string, body: () => Promise<void>): Promise<void> {
  tally.total += 1;
  try {
    await body();
    tally.passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A claim this run could not ask, which is neither a pass nor a failure. */
function notMeasured(name: string, why: string): void {
  tally.notMeasured += 1;
  console.log(`NOT MEASURED ${name}: ${why}`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function connectionWith(over: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "live",
    name: "fixture",
    type: "netconf",
    host,
    port,
    user: options.user,
    password: options.password,
    hostKeyFingerprint: options.fingerprint,
    ...over,
  } as unknown as DatabaseConnection;
}

/**
 * The real device layer, named here rather than left to the provider's default.
 *
 * The default is a dynamic import inside `index.ts`, which exists so that a module reachable from
 * browser code does not pull `ssh2` in statically. Naming the ports here is what makes this file
 * bundle for the Node run; the default path is checked separately, under Bun, so that it is not
 * simply unexercised.
 */
const livePorts = { xml: netconfXmlPort, ssh: nodeSshPort, socket: nodeSocketPort };

function providerWith(connection: DatabaseConnection): NetconfProvider {
  return new NetconfProvider(connection, {}, {}, async (config) => openNetconfReader(config, livePorts));
}

/** One connection, used and then given back however the body ends. */
async function withProvider<T>(connection: DatabaseConnection, body: (provider: NetconfProvider) => Promise<T>) {
  const provider = providerWith(connection);
  await provider.connect();
  try {
    return await body(provider);
  } finally {
    await provider.disconnect();
  }
}

const stringify = (value: unknown): string => JSON.stringify(value);

/**
 * The text of a source document's first part, or a failure saying what came instead.
 *
 * `ObjectSourcePart` is a union and only one arm carries text, so narrowing is required rather
 * than tidy: a part of the other shape would otherwise read as an empty string and an assertion
 * about its content would fail for the wrong reason.
 */
function firstPartText(document: ObjectSourceDocument): string {
  const [part] = document.parts;
  assert(part !== undefined, "this source document has no parts");
  assert("text" in part, `this source part carries no text: ${stringify(Object.keys(part))}`);
  return part.text;
}

/** A kind's count, where a refused read is `{ unavailable }` and never 0. */
function countOf(counts: Record<string, KindCount>, kind: string): number {
  const found = counts[kind];
  assert(found !== undefined, `this container reported no ${kind} count at all`);
  assert("count" in found, `the ${kind} count is unavailable: ${stringify(found)}`);
  return found.count;
}

// ---------------------------------------------------------------------------------------------
// The session, against the device's own identity.
// ---------------------------------------------------------------------------------------------

await check("the hello's datastores and NMDA flag are the device's", async () => {
  const reader = await openNetconfReader(connectionWith(), livePorts);
  try {
    assert(
      stringify(reader.facts.datastores) === stringify(DATASTORES),
      `datastores are ${stringify(reader.facts.datastores)}, wanted ${stringify(DATASTORES)}`,
    );
    assert(reader.facts.nmda, "this device advertises no NMDA capability, and the fixture's does");
    // A string of digits, which is what the hello carries and what the type says: RFC 6241 makes
    // session-id a uint32 on the wire, and nothing here turns it into a number.
    assert(/^\d+$/.test(reader.facts.sessionId), `the hello's session-id reads ${stringify(reader.facts.sessionId)}`);
  } finally {
    await reader.close();
  }
});

await check(`the YANG library reports ${MODULES} implemented modules, ${MODULE} among them`, async () => {
  const reader = await openNetconfReader(connectionWith(), livePorts);
  try {
    assert(
      reader.facts.modules.length === MODULES,
      `this device implements ${reader.facts.modules.length} modules and ${PINNED_IMAGE} implements ${MODULES}; ` +
        "if the fixture was rebuilt, this number is what has to be measured again",
    );
    assert(reader.facts.modules.includes(MODULE), `${MODULE} is not in this device's library`);
  } finally {
    await reader.close();
  }
});

await check("a wrong pin is refused by a real handshake, against the key this device really presents", async () => {
  // The claim the replay cannot make: there, the key is built and its own hash is the pin, so the
  // comparison runs and the PAIRING is untested. Here the key is the device's own.
  const wrong = `SHA256:${"a".repeat(43)}`;
  let refused: Error | null = null;
  try {
    const reader = await openNetconfReader(connectionWith({ hostKeyFingerprint: wrong }), livePorts);
    await reader.close();
  } catch (error) {
    refused = error instanceof Error ? error : new Error(String(error));
  }
  assert(refused !== null, "this device was accepted under a pin that is not its key's");
  assert(/host key|fingerprint/i.test(refused.message), `the refusal does not name the host key: ${refused.message}`);
  // Both fingerprints, which is what tells a rebuild from another host answering.
  assert(refused.message.includes(wrong), "the refusal does not say which pin was expected");
  assert(refused.message.includes(options.fingerprint), "the refusal does not say which key was presented");
});

await check("the pin read out of band is the key this device presents", async () => {
  // The positive control of the check above: a wrong pin failing proves nothing on its own if the
  // right one fails too, and the right one here came from ssh-keyscan rather than from this file.
  const reader = await openNetconfReader(connectionWith(), livePorts);
  await reader.close();
});

await check("a wrong password is refused by the device, and the refusal carries no credential", async () => {
  let refused: Error | null = null;
  try {
    const reader = await openNetconfReader(connectionWith({ password: `${options.password}-not` }), livePorts);
    await reader.close();
  } catch (error) {
    refused = error instanceof Error ? error : new Error(String(error));
  }
  assert(refused !== null, "this device accepted a password that is not the account's");
  /*
   * THE CLASS, and not just that something was thrown. CAUGHT BY A CANARY: against an address
   * with nothing on it this check passed, because `ECONNREFUSED` is also an error whose message
   * holds no password. It was the one check of eighteen that passed against a dead port, which is
   * the definition of a check that measures nothing.
   *
   * The house classes tell the two apart, MEASURED 2026-10-15 against this fixture: a wrong
   * password is an `AuthenticationError` reading "authentication failed", and a dead port is a
   * `ConnectionError` reading "connect ECONNREFUSED ...". So the class is the claim.
   */
  assert(
    refused instanceof AuthenticationError,
    `the refusal is a ${refused.constructor.name}, so this run reached no authentication: ${refused.message}`,
  );
  assert(
    !refused.message.includes(options.password),
    "the refusal repeats the password that was sent, which puts a credential in a log",
  );
});

if (options.keyFile === undefined) {
  notMeasured(
    "the public-key account",
    "no --key was given, so only the password path was dialled; the fixture's key is at " +
      "/fixture/ro-key (docker/netconf/README.md)",
  );
} else {
  await check("the public-key account opens a session, with no password offered", async () => {
    const privateKey = readFileSync(options.keyFile as string, "utf8");
    const reader = await openNetconfReader(
      connectionWith({ user: "ro-key", privateKey, password: undefined }),
      livePorts,
    );
    try {
      assert(reader.facts.modules.length === MODULES, "the key account opened a session that read a different library");
    } finally {
      await reader.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The reads, against data somebody else's server is serving.
// ---------------------------------------------------------------------------------------------

/** The first full read, kept so the last check can say the device did not change under us. */
let firstRead: { count: number; first: string } | null = null;

await check(`the interface list reads ${INTERFACES} rows, and every four-byte character arrives intact`, async () => {
  await withProvider(connectionWith(), async (provider) => {
    const result = await provider.query(
      stringify({ datastore: "running", path: `${MODULE}:interfaces`, limit: INTERFACES * 2 }),
    );
    assert(
      result.rows.length === INTERFACES,
      `this device answered ${result.rows.length} interfaces and NETCONF_LIVE_INTERFACES says ${INTERFACES}; ` +
        "the fixture's count is set by LIBREDB_NETCONF_INTERFACES",
    );
    const intact = result.rows.filter((row) => stringify(row).includes(FOUR_BYTE)).length;
    assert(
      intact === INTERFACES,
      `${INTERFACES - intact} of ${INTERFACES} descriptions lost their four-byte character on the way through ` +
        "the transport's decoder",
    );
    firstRead = { count: result.rows.length, first: stringify(result.rows[0]) };
  });
});

await check("a limit is a limit: five rows asked for, five rows answered", async () => {
  await withProvider(connectionWith(), async (provider) => {
    const result = await provider.query(stringify({ datastore: "running", path: `${MODULE}:interfaces`, limit: 5 }));
    assert(result.rows.length === 5, `asked for 5 rows and this device's answer became ${result.rows.length}`);
  });
});

await check("a key value holding a slash addresses one entry, and not the list", async () => {
  // `ge-0/0/0` is why the key path is percent encoded at all (`keypath.ts`), and a real device is
  // what says the encoding survives the round trip: the read is built from the escaped path and
  // the device answers the one entry whose unescaped key matches.
  await withProvider(connectionWith(), async (provider) => {
    const document = await provider.readObjectSource([`running/${MODULE}:interfaces/interface=ge-0%2F0%2F1`], "key");
    const text = firstPartText(document);
    assert(text.includes("<name>ge-0/0/1</name>"), `the entry's own key is not in its source: ${text.slice(0, 120)}`);
    assert(!text.includes("<name>ge-0/0/2</name>"), "this read answered more than the entry it addressed");
    assert(text.includes(FOUR_BYTE), "the entry's four-byte character is not in the source the device sent");
  });
});

await check("the module's YANG text comes from the device, through get-schema", async () => {
  await withProvider(connectionWith(), async (provider) => {
    const document = await provider.readObjectSource(["running", MODULE, "interfaces"], "node");
    const text = firstPartText(document);
    assert(text.startsWith(`module ${MODULE} {`), `this is not the module's own text: ${text.slice(0, 80)}`);
    assert(text.includes("list interface"), "the text carries no interface list, so it is not this module");
    const [part] = document.parts;
    assert(
      part !== undefined && "origin" in part && part.origin === "stored",
      "the source claims to be regenerated, and it is the device's own text",
    );
  });
});

await check("the tree's two levels and the count of a module's top-level nodes are the device's", async () => {
  await withProvider(connectionWith(), async (provider) => {
    const datastores = await provider.listContainers();
    assert(datastores.length === DATASTORES.length, `the tree drew ${datastores.length} datastores`);
    const modules = await provider.listContainers(["running"]);
    assert(modules.length === MODULES, `the tree drew ${modules.length} modules and the library reports ${MODULES}`);
    const counts = await provider.countObjects(["running", MODULE]);
    assert(countOf(counts, "node") === 1, `${MODULE} drew ${stringify(counts["node"])} top-level nodes, wanted 1`);
  });
});

await check("the overview and health panels are built from what the device said", async () => {
  await withProvider(connectionWith(), async (provider) => {
    const overview = await provider.getOverview();
    assert(overview.version === "NETCONF with NMDA (get-data)", `the version line reads ${overview.version}`);
    assert(
      overview.databaseSize === `${DATASTORES.length} datastores, ${MODULES} modules`,
      `the size line reads ${overview.databaseSize}`,
    );
    const health = await provider.getHealth();
    assert(health.cacheHitRatio === "unknown", "a cache ratio was reported for a device that publishes none");
    assert(health.databaseSize === `${MODULES} modules in the YANG library`, `health reads ${health.databaseSize}`);
  });
});

await check("the key walk folds the list into one entry, and the bare key value is refused", async () => {
  /*
   * THE GAP, recorded by name rather than left to be rediscovered.
   *
   * MEASURED 2026-10-15 against this fixture. The level below `interfaces` holds ONE entry, named
   * `interface`: `levelPage` folds entries that share an element name by `kind:name`, so 5,000
   * interfaces arrive as one. The level below THAT is the FIRST entry's leaf names. No level lists
   * the entries, so the keyed form - which the check above proves the device answers - is reachable
   * only by typing it, and the spelling with the key value as its own segment is refused.
   *
   * It asserts what IS rather than what should be, and that is a deliberate choice between two
   * wrong alternatives. Left asserting the documented walk, this check would be permanently red,
   * and a live check CI cannot run measures nothing - including the three claims this file exists
   * for. Dropped, the gap would be invisible again. Asserted, it is written down, and the day
   * somebody makes the walk enumerate entries THIS CHECK TURNS RED and says that this paragraph
   * and `scanKeysPage` have to be updated with it. That is the canary, and it is the point.
   *
   * `koordinasyon/SONRAKI-PRLAR.md` carries the fix as its own change, in the not-deferred list:
   * paging 5,000 entries is a design question and not a line to slip into this one.
   */
  await withProvider(connectionWith(), async (provider) => {
    // A folder's own prefix ends with the separator, and a folder comes back in `prefixes`: the
    // spelling and the shape `scanKeysPage` has answered since #1802.
    const level = await provider.scanKeysPage({
      pattern: `running/${MODULE}:interfaces/`,
      cursor: "0",
      count: 100,
    } as never);
    assert(
      stringify(level.prefixes) === stringify([`running/${MODULE}:interfaces/interface/`]) &&
        stringify(level.keys) === stringify([]),
      `the level below interfaces now holds ${stringify(level.prefixes)} and ${stringify(level.keys)}; if it lists ` +
        "entries, the walk was fixed and this check, its docblock and scanKeysPage's all have to be rewritten",
    );

    // And the documented spelling, measured: the bare key value would become an XML element name,
    // which is no YANG identifier, so the key path is refused before any read with a sentence that
    // names the segment. Before the identifier rule the read was built as `<ge-0%2F0%2F1>` and the
    // user saw the XML parser's sentence instead; the walk itself is still the gap above.
    let refused: Error | null = null;
    try {
      await provider.readObjectSource([`running/${MODULE}:interfaces/ge-0%2F0%2F1`], "key");
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
    assert(refused !== null, "the bare key value was accepted, so the documented walk now works");
    assert(refused instanceof QueryError, `it failed as a ${refused.constructor.name}, which reaches no user`);
    assert(
      /the path segment "ge-0%2F0%2F1" is not a YANG identifier/.test(refused.message),
      `the refusal no longer names the segment as no YANG identifier: ${refused.message}`,
    );
  });
});

await check("the entry the panel does offer costs a megabyte to open", async () => {
  /*
   * The same gap's other half, MEASURED so that the number is a fact and not an impression: the
   * one entry the walk offers is the UNKEYED list node, and its Source read is the whole list.
   * 1,047,857 characters against the 281 the keyed read answers - one click, one megabyte.
   *
   * Asserted as a range rather than as that exact number, because the figure moves with
   * `LIBREDB_NETCONF_INTERFACES`: what is being held is the SHAPE, a read three orders of
   * magnitude larger than the entry beside it. Red here means the Source read changed, which is
   * the other thing SONRAKI-PRLAR.md's entry would change.
   */
  await withProvider(connectionWith(), async (provider) => {
    const whole = firstPartText(await provider.readObjectSource([`running/${MODULE}:interfaces/interface`], "key"));
    const one = firstPartText(
      await provider.readObjectSource([`running/${MODULE}:interfaces/interface=ge-0%2F0%2F1`], "key"),
    );
    assert(
      whole.length > one.length * 100,
      `the unkeyed read is ${whole.length} characters against the keyed read's ${one.length}, which is no longer ` +
        "the gap this check records",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The refusals, with a real device on the other end.
// ---------------------------------------------------------------------------------------------

await check("a write is refused by this provider, and the device still answers afterwards", async () => {
  await withProvider(connectionWith(), async (provider) => {
    let refused: Error | null = null;
    try {
      await provider.query("<edit-config><target><running/></target></edit-config>");
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
    assert(refused !== null, "a write statement was not refused");
    assert(refused instanceof QueryError, `the refusal is a ${refused.constructor.name}, so it reaches no user`);
    assert(
      /reads a device and does not write to it/.test(refused.message),
      `the refusal says something else: ${refused.message}`,
    );
    // The session is still the same session: a provider that refused by tearing the connection
    // down would pass the line above and cost the user their connection.
    const after = await provider.query(stringify({ datastore: "running", path: `${MODULE}:interfaces`, limit: 1 }));
    assert(after.rows.length === 1, "the session that refused a write could not answer a read afterwards");
  });
});

await check("an SQL statement is refused by the same sentence", async () => {
  await withProvider(connectionWith(), async (provider) => {
    let refused: Error | null = null;
    try {
      await provider.query("UPDATE interfaces SET enabled = false");
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
    assert(refused !== null, "an SQL statement was not refused");
    assert(
      /reads a device and does not write to it/.test(refused.message),
      `the refusal says something else: ${refused.message}`,
    );
  });
});

await check("the panels a device cannot fill refuse by name, with the device connected", async () => {
  await withProvider(connectionWith(), async (provider) => {
    const refusals: { name: string; run: () => Promise<unknown>; says: RegExp }[] = [
      { name: "getPerformanceMetrics", run: () => provider.getPerformanceMetrics(), says: /no query statistics/ },
      { name: "getActiveSessions", run: () => provider.getActiveSessions(), says: /other operators' addresses/ },
      { name: "getTableStats", run: () => provider.getTableStats(), says: /no tables and no indexes/ },
      { name: "getStorageStats", run: () => provider.getStorageStats(), says: /no storage figures/ },
      { name: "runMaintenance", run: () => provider.runMaintenance(), says: /no operation here to run/ },
    ];
    for (const refusal of refusals) {
      let error: Error | null = null;
      try {
        await refusal.run();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
      assert(error !== null, `${refusal.name} answered instead of refusing`);
      assert(error instanceof QueryError, `${refusal.name} refused with a ${error.constructor.name}`);
      assert(refusal.says.test(error.message), `${refusal.name} refused with: ${error.message}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// What the device looks like after all of it.
// ---------------------------------------------------------------------------------------------

await check("the device gave the session back, and a new one opens", async () => {
  // A device's session table is a shared resource and nothing below this layer can say it was
  // given back. Netopeer2 refuses a new session when its table is full, so a session that opens
  // after every check above is the claim, measured the only way it can be.
  const reader = await openNetconfReader(connectionWith(), livePorts);
  try {
    assert(
      /^\d+$/.test(reader.facts.sessionId),
      `the new session's session-id reads ${stringify(reader.facts.sessionId)}`,
    );
  } finally {
    await reader.close();
  }
});

await check("the list reads the same as it did before any of this ran", async () => {
  assert(firstRead !== null, "the first read never happened, so there is nothing to compare");
  const before = firstRead as { count: number; first: string };
  await withProvider(connectionWith(), async (provider) => {
    const result = await provider.query(
      stringify({ datastore: "running", path: `${MODULE}:interfaces`, limit: INTERFACES * 2 }),
    );
    assert(
      result.rows.length === before.count,
      `the list held ${before.count} rows and now holds ${result.rows.length}`,
    );
    assert(stringify(result.rows[0]) === before.first, "the list's first row is not the row it was");
  });
});

if (typeof Bun === "undefined") {
  notMeasured(
    "the provider's own default device layer",
    "it reaches ssh2 through a dynamic import, which this Node bundle does not carry; the Bun run asks it",
  );
} else {
  await check("the provider's own default device layer opens a session", async () => {
    // Every check above names the ports, which is what lets this file bundle for Node. The
    // application does not: it takes `index.ts`'s dynamic import. Without this check that path is
    // exercised by nothing here.
    const provider = new NetconfProvider(connectionWith());
    await provider.connect();
    try {
      const overview = await provider.getOverview();
      assert(overview.version === "NETCONF with NMDA (get-data)", `the default layer read ${overview.version}`);
    } finally {
      await provider.disconnect();
    }
  });
}

const pin = declaredImage === undefined ? "image not declared" : `image ${PINNED_IMAGE}`;
const skipped = tally.notMeasured === 0 ? "" : `, ${tally.notMeasured} not measured`;
console.log(`${tally.passed} of ${tally.total} checks passed on ${options.target} (${RUNTIME}, ${pin}${skipped})`);
process.exit(tally.passed === tally.total ? 0 : 1);
