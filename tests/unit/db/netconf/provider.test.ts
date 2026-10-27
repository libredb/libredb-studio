/**
 * The provider class. The device layer is injected, so every rule here is the class's own: which
 * surface answers, which refuses with a sentence, and which is empty because the engine truly has
 * none.
 *
 * These ran against a stand-in class with local type aliases until the real one landed. A mutation
 * run showed what that cost: two rules of the real class had no test at all, because the tests were
 * pointed at the stand-in. The stand-in is gone and these point at the class the repository loads.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectMatch, expectRejects, expectTruthy } from "./helpers";
import { NetconfProvider, parseReadRequest, type DeviceReader } from "@/lib/db/providers/network/netconf/index";
import type { DatabaseConnection, KeyScanPage } from "@/lib/db/types";
import { QueryError, TimeoutError } from "@/lib/db/errors";
import { NETCONF_KEY_SCAN, NETCONF_OBJECT_KINDS } from "@/lib/db/providers/network/netconf/objectkinds";
import { NETCONF_LABELS } from "@/lib/db/providers/network/netconf/labels";
import { ALLOWED_OPERATIONS } from "@/lib/db/providers/network/netconf/requests";
import { encodeSegment } from "@/lib/db/providers/network/netconf/keypath";
import { buildRpc } from "@/lib/db/providers/network/netconf/requests";

const facts = {
  datastores: ["running", "candidate", "startup", "operational"],
  modules: ["ietf-interfaces", "ietf-system"],
  nmda: true,
  capabilities: [
    "urn:ietf:params:netconf:capability:xpath:1.0",
    "urn:ietf:params:netconf:capability:candidate:1.0",
    "urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring",
    // A module URI, which a real hello carries 14 of. Without one here the assertion that no panel
    // repeats the module list could not fail, whatever the filter did.
    "urn:ietf:params:xml:ns:yang:ietf-interfaces?module=ietf-interfaces&revision=2018-02-20",
  ],
  sessionId: "7",
};

function reader(over: Partial<DeviceReader> = {}): DeviceReader {
  return {
    facts,
    topLevelNodes: async () => [{ module: "ietf-interfaces", name: "interfaces" }],
    /*
     * DECODED, which is what `LevelEntry.name` declares ("the decoded name of a child"). This fake
     * used to answer `ge-0%2F0%2F2`, already escaped, and the provider concatenated it raw: the two
     * wrongs cancelled and the keys came out looking right. A fake that pre-escapes hides whether
     * the provider escapes at all, so it answers the contract's own spelling here.
     */
    children: async () => [
      { name: "ge-0/0/2", kind: "key" as const },
      { name: "ge-0/0/1", kind: "key" as const },
      { name: "ge-0/0/1", kind: "key" as const },
    ],
    rows: async () => ({ columns: ["name"], rows: [{ name: "ge-0/0/0" }], rowCount: 1 }) as never,
    moduleText: async () => "module ietf-interfaces { }",
    sourceXml: async () => "<interface><name>ge-0/0/1</name><description>port 1</description></interface>",
    close: async () => {},
    ...over,
  };
}

const connection = { type: "netconf", name: "n", host: "h" } as unknown as DatabaseConnection;

async function open(device: DeviceReader = reader()): Promise<NetconfProvider> {
  const provider = new NetconfProvider(connection, {}, async () => device);
  await provider.connect();
  return provider;
}

test("the engine declares its own query dialect, so it does not inherit MongoDB's tab", () => {
  const capabilities = new NetconfProvider(connection).getCapabilities();
  // Not merely "a dialect is declared": the one measured consequence of leaving it out was that
  // `resolveTabType` handed this JSON-language engine MongoDB's tab type, with column profiling
  // and a count query offered on a read-only device that has neither.
  expectBe(capabilities.queryDialect, "netconf");
  expectBe(capabilities.queryLanguage, "json");
  expectBe(capabilities.enforcesReadOnly, true);
  expectBe(capabilities.supportsMaintenance, false);
});

test("the container levels are declared as the datastore and then the module", () => {
  const capabilities = new NetconfProvider(connection).getCapabilities();
  expectEqual(
    capabilities.containerLevels?.map((level) => level.label),
    ["Datastore", "Module"],
  );
});

test("the container levels are answered as the datastore and then the module, and a third is refused", async () => {
  const provider = await open();
  expectEqual(
    (await provider.listContainers()).map((c) => c.name),
    facts.datastores,
  );
  expectEqual(
    (await provider.listContainers(["running"])).map((c) => c.name),
    facts.modules,
  );
  await expectRejects(provider.listContainers(["running", "ietf-interfaces", "extra"]), /datastore and then a module/);
});

test("a container carries its path and its level, which the tree addresses it by", async () => {
  const provider = await open();
  const modules = await provider.listContainers(["running"]);
  expectEqual(modules[0]?.path, ["running", "ietf-interfaces"]);
  expectBe(modules[0]?.level, 1);
});

test("the key kind is not counted and not listed here, because the Keys panel enumerates it", async () => {
  const provider = await open();
  expectEqual(Object.keys(await provider.countObjects(["running", "ietf-interfaces"])), ["node"]);
  await expectRejects(provider.listObjects(["running", "ietf-interfaces"], "key"), /Browse Keys/);
});

/**
 * What answers `{ unavailable }` and what rises is decided by scope, which is the rule at
 * `providers/platform/kubernetes/objects.ts:348`: a refusal of this one read belongs to this kind,
 * and anything that spoils the whole connection has to rise, or every module would be drawn
 * "unavailable" while the connection still looked healthy.
 *
 * The three cases below are the boundary's whole contract. The third is the one that matters most:
 * an earlier version of this provider caught everything and turned it into a sentence, so a
 * TypeError of its own would have been drawn in the tree as the module's count, and an audit would
 * have read it as a fact about the device.
 */
test("a refused count is a sentence, not a zero", async () => {
  const provider = await open(
    reader({
      topLevelNodes: async () => {
        throw new QueryError("access-denied on this module");
      },
    }),
  );
  expectEqual(await provider.countObjects(["running", "ietf-interfaces"]), {
    node: { unavailable: "access-denied on this module" },
  });
});

test("a deadline on the count is the same answer: the kind alone, with the wait as its sentence", async () => {
  const provider = await open(
    reader({
      topLevelNodes: async () => {
        throw new TimeoutError("the device did not answer within 5 seconds");
      },
    }),
  );
  expectEqual(await provider.countObjects(["running", "ietf-interfaces"]), {
    node: { unavailable: "the device did not answer within 5 seconds" },
  });
});

test("an unrelated failure rises unchanged, so this provider's own defect is never drawn as a count", async () => {
  const planted = new RangeError("a defect in this provider, not a fact about the device");
  const provider = await open(
    reader({
      topLevelNodes: async () => {
        throw planted;
      },
    }),
  );
  let caught: unknown;
  try {
    await provider.countObjects(["running", "ietf-interfaces"]);
  } catch (error) {
    caught = error;
  }
  // The same object, not a copy and not a conversion: nothing read it and rewrote it on the way out.
  expectBe(caught, planted);
  expectTruthy(caught instanceof RangeError);
});

test("a write typed into the console is answered with what this provider is", async () => {
  const provider = await open();
  await expectRejects(provider.query("edit-config running"), /reads a device and does not write/);
  await expectRejects(provider.query("lock"), /reads a device and does not write/);
});

/**
 * The write check reads words, so it has to stand down for a request that is plainly a read. A
 * device's own data holds words like "delete" and "update", and refusing a valid read because a
 * note mentions one would be worse than the thing it guards against.
 */
test("a valid read request is not refused merely because it carries a word like delete", async () => {
  const provider = await open();
  const result = await provider.query('{"datastore":"running","path":"x","note":"please delete it"}');
  expectBe(result.rowCount, 1);
});

test("a read request is parsed after the write check, so a valid read still runs", async () => {
  const provider = await open();
  const result = await provider.query('{"datastore":"running","path":"ietf-interfaces:interfaces"}');
  expectBe(result.rowCount, 1);
});

test("the surfaces this engine cannot answer refuse with a sentence rather than an empty list", async () => {
  const provider = await open();
  await expectRejects(provider.getPerformanceMetrics(), /no query statistics/);
  await expectRejects(provider.getSlowQueries(), /no query statistics/);
  await expectRejects(provider.getActiveSessions(), /other operators' addresses/);
  await expectRejects(provider.getTableStats(), /no tables and no indexes/);
  await expectRejects(provider.getIndexStats(), /no tables and no indexes/);
  await expectRejects(provider.getStorageStats(), /no storage figures/);
  /*
   * THE NUMBER IS A FACT, NOT A PHRASE, and this line used to pin the phrase.
   *
   * It read `/five read operations/`, so when the sentence said five the test PROTECTED the
   * error: the number was wrong in three user-visible sentences and every run stayed green.
   * MEASURED in `requests.ts:5-12`, with the fixture's read-only account: `get`, `get-config`,
   * `get-data` and `get-schema` returned data and `close-session` answered `<ok/>`. So it is
   * four reads AND a close, and calling the close a read also made the sentence's "and nothing
   * else" untrue of the operation it had miscounted.
   *
   * Derived from `ALLOWED_OPERATIONS` rather than written again here: add a read to that set and
   * this expectation asks for "five", the sentence still says "four", and the test goes red at
   * the sentence that has to change.
   */
  const reads = ALLOWED_OPERATIONS.filter((operation) => operation !== "close-session");
  expectBe(reads.length, 4);
  const counted = ["zero", "one", "two", "three", "four", "five", "six"][reads.length];
  await expectRejects(provider.runMaintenance(), new RegExp(`${counted} read operations and a close`));
  // The same number reaches the user from two more places, which carry no test of their own.
  expectMatch(NETCONF_LABELS.analyzeGlobalDesc, new RegExp(`${counted} read operations and a close`));
  expectMatch(NETCONF_LABELS.vacuumGlobalDesc, new RegExp(`${counted} read operations and a close`));
});

test("the overview says what the engine is, and counts no tables because it has none", async () => {
  const provider = await open();
  const overview = await provider.getOverview();
  expectBe(overview.tableCount, 0);
  expectBe(overview.indexCount, 0);
  expectTruthy(overview.version?.includes("NMDA"));
});

test("health omits what it cannot measure instead of sending a fabricated zero", async () => {
  const provider = await open();
  const health = await provider.getHealth();
  expectBe(health.cacheHitRatio, "unknown");
  expectBe(health.activeConnections, undefined);
  // The module list is sensitive (RFC 8525 section 6), so no panel repeats it.
  expectBe(JSON.stringify(health).includes("ietf-interfaces"), false);
});

test("a key page removes repeats, sorts, and carries a start-after cursor", async () => {
  const provider = await open();
  // The shared contract: one options object, the prefix carrying the datastore, `"0"` meaning start.
  const page = await provider.scanKeysPage({
    cursor: "0",
    // ENDING IN THE SEPARATOR, which is the spelling that names a level. Written without it, this
    // call listed the level BELOW and the route answered 500; the walk is held to that below.
    pattern: "running/ietf-interfaces:interfaces/",
    count: 10,
    level: true,
  });
  expectEqual(page.keys, [
    "running/ietf-interfaces:interfaces/ge-0%2F0%2F1",
    "running/ietf-interfaces:interfaces/ge-0%2F0%2F2",
  ]);
  // The cursor is in the same space as the names it is compared against (`keypath.ts:166`), which
  // is the decoded one, and it is opaque to everything outside this provider.
  expectBe(page.cursor, "ge-0/0/2");
  // `total` is not read under `totalScope: "none"`, and an unread field still has to be honest.
  expectBe(page.total, 0);
  expectEqual(page.types, {});
});

test("a description carries no leaf value, because a read only account still reads secrets", async () => {
  const provider = await open();
  const detail = await provider.describeObject(["running", "ietf-system", "authentication"], "node");
  expectEqual(detail.columns, []);
  expectEqual(detail.path, ["running", "ietf-system", "authentication"]);
});

test("describeObjects answers a batch and says when it cut the listing", async () => {
  const provider = await open();
  const all = await provider.describeObjects(["running", "ietf-interfaces"], "node");
  expectBe(all.details.length, 1);
  expectBe(all.truncated, undefined);
  const cut = await provider.describeObjects(["running", "ietf-interfaces"], "node", 0);
  expectBe(cut.details.length, 0);
  expectTruthy(cut.truncated !== undefined);
});

test("a read request with no datastore or no path is refused, never defaulted", () => {
  expectRejectsSync(() => parseReadRequest("not json"), /is JSON/);
  expectRejectsSync(() => parseReadRequest("[]"), /is JSON/);
  expectRejectsSync(() => parseReadRequest('{"path":"a"}'), /names no datastore/);
  expectRejectsSync(() => parseReadRequest('{"datastore":"running"}'), /names no path/);
  expectRejectsSync(() => parseReadRequest('{"datastore":"running","path":"a","limit":0}'), /whole number/);
  const request = parseReadRequest(
    '{"datastore":"operational","path":"ietf-interfaces:interfaces/interface=ge-0%2F0%2F0"}',
  );
  expectBe(request.datastore, "operational");
  expectBe(request.limit, 1000);
  expectEqual(request.path[1], { name: "interface", keys: ["ge-0/0/0"] });
});

function expectRejectsSync(fn: () => unknown, pattern: RegExp): void {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expectTruthy(pattern.test(message));
}

test("nothing answers before connect", async () => {
  const provider = new NetconfProvider(connection, {}, async () => reader());
  await expectRejects(provider.listContainers(), /not open/);
});

/**
 * Every refusal a user can reach is a `QueryError`, and this test asserts the TYPE rather than the
 * message, because a message can be reworded and a type cannot.
 *
 * MEASURED on `origin/main`: the surfaces that turn a failure into a stated refusal check
 * `error instanceof QueryError` (`providers/platform/kubernetes/objects.ts:348`,
 * `isQueryError` in `src/lib/db/errors.ts`). A refusal thrown as a plain `Error` is not
 * converted: it passes as an unexpected failure and the sentence it carries never reaches the
 * user. The first version of this provider had three such refusals, in `keypath.ts`,
 * `yangkeys.ts` and `requests.ts`.
 */
test("every refusal a user can reach is a QueryError, measured by type and not by message", async () => {
  const provider = await open();
  const reached: unknown[] = [];
  const collect = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      reached.push(error);
    }
  };
  await collect(() => provider.query("edit-config running"));
  await collect(() => provider.query("not json"));
  await collect(() => provider.query('{"datastore":"running"}'));
  await collect(() => provider.listContainers(["a", "b", "c"]));
  await collect(() => provider.listObjects(["running", "ietf-interfaces"], "key"));
  await collect(() => provider.getPerformanceMetrics());
  await collect(() => provider.getActiveSessions());
  await collect(() => provider.runMaintenance());
  expectBe(reached.length, 8);
  for (const error of reached) expectTruthy(error instanceof QueryError);
});

/**
 * The unknown-module refusal lives in the request builder rather than in the class, and a mutation
 * showed it had no test at all: turning it into a plain Error failed nothing. It is reachable
 * whenever a filter names a module the device's YANG library did not, which is the case the
 * sentence exists for, so a wrong namespace is not sent and answered with an empty document.
 */
test("a filter naming a module the library does not know is refused as a QueryError", () => {
  let caught: unknown;
  try {
    buildRpc({ operation: "get", filter: { nodes: [{ module: "no-such-module", name: "x" }] } }, 1);
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof QueryError);
});

test("a key value that cannot be spelled as a path is refused as a QueryError too", () => {
  let caught: unknown;
  try {
    encodeSegment("\uD800");
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof QueryError);
});

/**
 * The key scan declaration has to REACH the capabilities the application reads. The declaration's
 * own fields are held in `netconf.test.ts`; what is held here is that the provider publishes that
 * record and not another one, because a provider that built a second record inline would satisfy
 * every assertion about the declaration while the application read something else.
 */
test("the capabilities carry the declared key scan and object kinds themselves", () => {
  const capabilities = new NetconfProvider(connection).getCapabilities();
  expectBe(capabilities.keyScan, NETCONF_KEY_SCAN);
  expectBe(capabilities.objectKinds, NETCONF_OBJECT_KINDS);
});

/**
 * The Source tab the declaration promises.
 *
 * MEASURED in `src/lib/api/object-route.ts:549`: a provider that declares a kind with `hasSource`
 * and omits `readObjectSource` is answered 400, `declares no readable source for kind`, because the
 * method is optional on the interface. So the tree drew the tab and the tab refused, which is what
 * these cases are here to stop happening again.
 */
test("a node's source is the module's YANG text, and it says the text is the device's own", async () => {
  const provider = await open();
  const document = await provider.readObjectSource(["running", "ietf-interfaces", "interfaces"], "node");
  expectBe(document.kind, "node");
  expectEqual(document.path, ["running", "ietf-interfaces", "interfaces"]);
  expectBe(document.parts.length, 1);
  // The part type is a union whose other arm is a refusal carrying no text, so it is narrowed
  // rather than cast: a cast here would assert exactly what the union exists to make the caller
  // check, and the refusal arm reaching an editor buffer is the failure it was built against.
  const part = document.parts[0];
  expectTruthy(part !== undefined && "text" in part);
  // `plaintext` rather than `yang`: the editor registers no YANG language, the fleet's gate refuses
  // an unregistered id, and mis-declaring it as a near relative would colour the text wrongly.
  expectBe(part.language, "plaintext");
  expectBe(part.origin, "stored");
  expectBe(part.form, "complete");
  expectMatch(part.text, /module ietf-interfaces/);
});

test("a key's source is the entry's own XML, sliced from the reply rather than reprinted", async () => {
  const provider = await open();
  const document = await provider.readObjectSource(
    ["running/ietf-interfaces:interfaces/interface=ge-0%2F0%2F1"],
    "key",
  );
  const part = document.parts[0];
  expectTruthy(part !== undefined && "text" in part);
  expectBe(part.language, "xml");
  expectBe(part.origin, "stored");
  expectMatch(part.text, /<description>port 1<\/description>/);
});

test("a bound is applied and declared, so a cut text never reads as the whole text", async () => {
  const provider = await open();
  const document = await provider.readObjectSource(["running", "ietf-interfaces", "interfaces"], "node", 6);
  const part = document.parts[0];
  expectTruthy(part !== undefined && "text" in part);
  expectBe(part.text, "module");
  expectBe(part.form, "partial");
  expectBe(part.truncated?.limit, 6);
  expectMatch(part.truncated?.reason ?? "", /longer than the 6 characters/);
});

test("a path of the wrong shape is refused with what was expected, not read wrongly", async () => {
  const provider = await open();
  await expectRejects(provider.readObjectSource(["running"], "node"), /three names/);
  await expectRejects(provider.readObjectSource(["running", "a"], "key"), /one name/);
  await expectRejects(provider.readObjectSource(["running", "x", "y"], "folder"), /no source text for the kind folder/);
});

/**
 * The labels are user-visible text and nothing asserted them, nor that the provider publishes the
 * declared record rather than building one inline, which is the same seam the capabilities needed.
 *
 * What is held is what this engine IS: a device has nodes and not tables, a read is a read and not
 * a query, and the three actions this provider cannot perform say so in the words the panel will
 * print. An engine that answered "Table" here would be describing a different product.
 */
test("the provider publishes the declared labels, and they name what this engine actually has", () => {
  const labels = new NetconfProvider(connection).getLabels();
  // Equal, not identical: this provider answers `{ ...NETCONF_LABELS }`, a copy, which is what
  // three of the four neighbours measured do (etcd, MQTT and RabbitMQ copy; OPC UA returns the
  // record itself). The first version of this test asserted identity and failed, and the code was
  // right: the claim was wrong. What matters is that the published text is the declared text, so
  // that a second set written inline could not drift away from the one every other reader sees.
  expectEqual(labels, NETCONF_LABELS);
  expectBe(labels.entityName, "Node");
  expectBe(labels.selectAction, "Read");
  for (const unavailable of [labels.generateAction, labels.analyzeAction, labels.vacuumAction]) {
    expectBe(unavailable, "Not available", "an action this provider cannot perform says so");
  }
});

/**
 * The keys route's own check on a level page, which the route keeps private
 * (`src/app/api/db/keys/scan/route.ts:215-219`): keys and prefixes together fit in count, every
 * prefix ends at the first separator after the pattern, every key sits directly under the pattern
 * and is not empty, and nothing is listed twice.
 *
 * Mirrored here rather than imported because the route does not export it; `tests/live/s3-live-support.ts`
 * keeps its own copy for the same reason. Both spellings below are run through it, because the
 * defect it catches was reachable from one of them while the other answered nothing at all, and a
 * test that exercised either one alone stayed green.
 */
function levelPageDefect(pattern: string, count: number, page: KeyScanPage): string | undefined {
  const prefixes = page.prefixes ?? [];
  const entries = prefixes.length + page.keys.length;
  if (entries > count) return `${entries} entries, more than the count of ${count}`;
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const first = prefix.indexOf("/", pattern.length);
    if (!prefix.startsWith(pattern) || first === -1 || first !== prefix.length - 1) {
      return `the folder ${JSON.stringify(prefix)} is outside the level of ${JSON.stringify(pattern)}`;
    }
    if (seen.has(prefix)) return `${JSON.stringify(prefix)} twice`;
    seen.add(prefix);
  }
  for (const key of page.keys) {
    if (key === "" || !key.startsWith(pattern) || key.slice(pattern.length).includes("/")) {
      return `the key ${JSON.stringify(key)} is outside the level of ${JSON.stringify(pattern)}`;
    }
    if (seen.has(key)) return `${JSON.stringify(key)} twice`;
    seen.add(key);
  }
  return undefined;
}

/** A device whose tree has a folder under a container, and a leaf and a folder under that. */
function treeReader(): DeviceReader {
  return reader({
    children: async (_datastore: string, path: readonly { readonly name: string }[]) => {
      const at = path.map((node) => node.name).join("/");
      if (at === "interfaces") return [{ name: "interface", kind: "folder" as const }];
      if (at === "interfaces/interface") {
        return [
          { name: "ge-0/0/1", kind: "folder" as const },
          { name: "name", kind: "key" as const },
        ];
      }
      return [];
    },
  } as never);
}

test("a folder's own prefix lists its level, and every row sits inside it", async () => {
  // The spelling the panel sends when a reader OPENS a folder, and the one its placeholder teaches
  // (`Prefix, e.g. app/config/`, KeyBrowser.tsx:676).
  const provider = new NetconfProvider(connection, {}, async () => treeReader());
  await provider.connect();
  const pattern = "running/ietf-interfaces:interfaces/";
  const page = await provider.scanKeysPage({ cursor: "0", pattern, count: 10, level: true });

  expectEqual(page.prefixes, ["running/ietf-interfaces:interfaces/interface/"]);
  expectEqual(page.keys, []);
  expectBe(levelPageDefect(pattern, 10, page), undefined);
});

test("a folder is answered as a folder and a leaf as a key, and a name holding the separator is escaped", async () => {
  // Both were answered as keys, so the panel offered nothing to open on an engine whose key space
  // is a tree. `LevelEntry.kind` had said which all along.
  const provider = new NetconfProvider(connection, {}, async () => treeReader());
  await provider.connect();
  const pattern = "running/ietf-interfaces:interfaces/interface/";
  const page = await provider.scanKeysPage({ cursor: "0", pattern, count: 10, level: true });

  expectEqual(page.keys, ["running/ietf-interfaces:interfaces/interface/name"]);
  expectEqual(page.prefixes, ["running/ietf-interfaces:interfaces/interface/ge-0%2F0%2F1/"]);
  expectBe(levelPageDefect(pattern, 10, page), undefined);
});

test("the filter box's text is kept as a filter on the level above it", async () => {
  // The panel sends the FILTER BOX verbatim, so a half-typed name arrives with no trailing
  // separator. It names the level above and filters that level, which is why `inter` keeps
  // `interface` and `xyz` keeps nothing.
  const provider = new NetconfProvider(connection, {}, async () => treeReader());
  await provider.connect();
  const kept = await provider.scanKeysPage({
    cursor: "0",
    pattern: "running/ietf-interfaces:interfaces/inter",
    count: 10,
    level: true,
  });
  expectEqual(kept.prefixes, ["running/ietf-interfaces:interfaces/interface/"]);
  expectBe(levelPageDefect("running/ietf-interfaces:interfaces/inter", 10, kept), undefined);

  const none = await provider.scanKeysPage({
    cursor: "0",
    pattern: "running/ietf-interfaces:interfaces/xyz",
    count: 10,
    level: true,
  });
  expectEqual(none.keys, []);
  expectEqual(none.prefixes, []);
});

test("a prefix naming only a datastore and a node is refused by name, not answered with nothing", async () => {
  // This is the spelling the provider's own sentence used to teach. It names the datastore's top
  // level, which `reader.children` refuses because an unfiltered read of a datastore is the one
  // read this provider does not send. MEASURED before this was handled: the level BELOW was listed
  // and the route answered 500 blaming the provider. The refusal names the separator instead.
  const provider = new NetconfProvider(connection, {}, async () => treeReader());
  await provider.connect();
  await expectRejects(
    provider.scanKeysPage({
      cursor: "0",
      pattern: "running/ietf-interfaces:interfaces",
      count: 10,
      level: true,
    }),
    /ends with the separator/,
  );
  // And the sentence shows the spelling that works, so a reader is not left to guess it.
  await expectRejects(
    provider.scanKeysPage({ cursor: "0", pattern: "running/ietf-interfaces:interfaces", count: 10, level: true }),
    /running\/ietf-interfaces:interfaces\//,
  );
});
