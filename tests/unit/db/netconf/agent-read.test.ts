/**
 * One agent read end to end below the provider class: the agent's own client over a scripted device session (the seam),
 * so what is pinned is what reaches the session. The check of the device's modules runs before every read and fails
 * closed; values are answered with every withheld node in its place as [withheld]; refusals and failures are worded by
 * Studio by category; budgets refuse rather than cut, at their edges.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  createNetconfAgentClient,
  NetconfAgentError,
  type NetconfAgentClient,
} from "@/lib/db/providers/network/netconf/agent-client";
import {
  NETCONF_AGENT_FAILURE_SENTENCES as F,
  netconfAgentResult,
  runNetconfAgentReadWithin,
} from "@/lib/db/providers/network/netconf/agent-read";
import { readNetconfAgentStatement, type NetconfAgentPlan } from "@/lib/db/providers/network/netconf/agent-statement";
import { XmlReaderError } from "@/lib/db/providers/network/netconf/reader-port";
import { ALLOWED_OPERATIONS } from "@/lib/db/providers/network/netconf/requests";
import { NetconfSessionError } from "@/lib/db/providers/network/netconf/session";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import { byteBudgetSentence, rowBudgetSentence } from "@/lib/db/providers/sql/read-only-budget";
import {
  FAKE_HASH,
  FAKE_MODULES,
  FAKE_SECRET,
  fakeNetconfDevice,
  interfacesData,
  type FakeDeviceOptions,
} from "../../../helpers/netconf-fake-device";

const BUDGET = { maxResultRows: 10, maxResultBytes: 100_000, statementTimeoutMs: 2_000 };
const MODULE_COUNT = Object.keys(FAKE_MODULES).length;

function planOf(text: string): NetconfAgentPlan {
  const reading = readNetconfAgentStatement(text);
  if (!reading.ok) throw new Error(reading.message);
  return reading.plan;
}

async function run(text: string, options: FakeDeviceOptions = {}, budget = BUDGET) {
  const device = fakeNetconfDevice(options);
  const answer = await runNetconfAgentReadWithin(
    async () => createNetconfAgentClient(device.session, netconfXmlPort),
    planOf(text),
    budget,
  );
  await Bun.sleep(0);
  return { answer, device };
}

async function refused(text: string, options: FakeDeviceOptions = {}, budget = BUDGET) {
  const device = fakeNetconfDevice(options);
  const caught = await runNetconfAgentReadWithin(
    async () => createNetconfAgentClient(device.session, netconfXmlPort),
    planOf(text),
    budget,
  ).catch((error: unknown) => error);
  await Bun.sleep(0);
  expect(caught).toBeInstanceOf(NetconfAgentError);
  return { message: (caught as Error).message, device };
}

/** Every RegExp metacharacter escaped, the backslash included, so a sentence matches as written. */
const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

const READ = '{"datastore": "running", "path": "ex-if:interfaces"}';

describe("a read answers values, with every withheld node in its place and warned", () => {
  test("the rows as the console shapes them, the deny-all and crypt-hash cells [withheld], and no secret anywhere", async () => {
    const { answer, device } = await run(READ, { data: interfacesData(2) });
    expect(answer.fields).toEqual(["name", "description", "secret", "pw"]);
    expect(answer.rows).toEqual([
      { name: "ge-0", description: "port 0", secret: "[withheld]", pw: "[withheld]" },
      { name: "ge-1", description: "port 1", secret: "[withheld]", pw: "[withheld]" },
    ]);
    const result = netconfAgentResult(answer, BUDGET, 5);
    const text = JSON.stringify(result);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_HASH);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${escapeRegExp("ex-if:interfaces/interface/secret (2 nodes) are withheld from agent mode (nacm:default-deny-all):")}`,
        ),
      ),
      expect.stringMatching(
        new RegExp(
          `^${escapeRegExp("ex-if:interfaces/interface/pw (2 nodes) are withheld from agent mode (crypt-hash):")}`,
        ),
      ),
      "ex-if:users/user is withheld from agent mode (keyed by a withheld leaf): the list is keyed by a withheld leaf, so an entry's path would carry it, so its value is not answered.",
      expect.stringMatching(
        new RegExp(`^${escapeRegExp("ietf-keystore:keystore is withheld from agent mode (ietf-keystore):")}`),
      ),
    ]);
    // The seam: the library, one schema per module, the read, and the close; every one a read of the closed table.
    expect(device.sent.map((request) => request.operation)).toEqual([
      "get",
      ...Array(MODULE_COUNT).fill("get-schema"),
      "get-config",
    ]);
    expect(device.sent.every((request) => (ALLOWED_OPERATIONS as readonly string[]).includes(request.operation))).toBe(
      true,
    );
    expect(device.closed.count).toBe(1);
  });

  test("the check runs again on every read: nothing of one read's modules reaches the next", async () => {
    const first = await run(READ, { data: interfacesData(1) });
    const plain =
      "module ex-if { prefix exif; container interfaces { list interface { key name; leaf name { type string; } leaf secret { type string; } leaf pw { type string; } } } }";
    const second = await run(READ, { data: interfacesData(1), texts: { "ex-if": plain } });
    expect(first.answer.rows[0]?.secret).toBe("[withheld]");
    expect(second.answer.rows[0]?.secret).toBe(FAKE_SECRET);
    expect(second.device.sent.filter((request) => request.operation === "get-schema")).toHaveLength(MODULE_COUNT);
  });

  test("operational is read with get-data, and a path that breaks answers no rows and no fields", async () => {
    const { answer, device } = await run(
      '{"datastore": "operational", "path": "ex-if:interfaces/interface=ge-9/missing"}',
      { data: "" },
    );
    expect(answer).toEqual({ fields: [], rows: [], withheld: [] });
    expect(device.sent.at(-1)?.operation).toBe("get-data");
  });

  test("a schema request answers the module text the check already read, with no second request", async () => {
    const { answer, device } = await run('{"schema": "ex-if"}');
    expect(answer).toEqual({
      fields: ["module", "revision", "text"],
      rows: [{ module: "ex-if", revision: "2026-01-01", text: FAKE_MODULES["ex-if"]?.text as string }],
      withheld: [],
    });
    expect(
      device.sent.filter((request) => request.operation === "get-schema" && request.identifier === "ex-if"),
    ).toHaveLength(1);
  });
});

describe("refused after the check and before the read is sent", () => {
  const noRead = (sent: { operation: string }[]) =>
    expect(sent.some((request) => request.operation === "get-config" || request.operation === "get-data")).toBe(false);

  test("a path naming a withheld node, a node inside one, or a key filter on a withheld key", async () => {
    for (const [text, at, kind] of [
      [
        '{"datastore": "running", "path": "ex-if:interfaces/interface=ge-0/secret"}',
        "interfaces/interface/secret",
        "nacm:default-deny-all",
      ],
      [
        '{"datastore": "running", "path": "ex-if:interfaces/interface=ge-0/pw"}',
        "interfaces/interface/pw",
        "crypt-hash",
      ],
      ['{"datastore": "running", "path": "ex-if:users/user=guess"}', "users/user", "keyed by a withheld leaf"],
    ] as const) {
      const { message, device } = await refused(text);
      expect(message).toBe(F.withheldPath(at, kind));
      noRead(device.sent);
    }
  });

  test("a module or schema the library does not name", async () => {
    const read = await refused('{"datastore": "running", "path": "absent:x"}');
    expect(read.message).toBe(F.notInLibrary("absent"));
    noRead(read.device.sent);
    expect((await refused('{"schema": "absent"}')).message).toBe(F.notInLibrary("absent"));
  });

  test("fail closed: a library refused, a module text refused, or a text that breaks the grammar, never answered unchecked", async () => {
    for (const options of [
      { libraryReply: "<rpc-reply><rpc-error><error-tag>access-denied</error-tag></rpc-error></rpc-reply>" },
      { refuseSchema: "iana-crypt-hash" },
      { texts: { "ex-if": "module ex-if {" } },
      { libraryReply: "<not-xml" },
    ]) {
      const { message, device } = await refused(READ, options);
      expect(message).toBe(F.schemaUnread);
      expect(message).not.toContain(FAKE_SECRET);
      noRead(device.sent);
    }
  });
});

describe("budgets refuse rather than cut, at their edges", () => {
  test("rows: exactly the budget is answered, one more is refused", async () => {
    expect((await run(READ, { data: interfacesData(10) })).answer.rows).toHaveLength(10);
    expect((await refused(READ, { data: interfacesData(11) })).message).toBe(F.overRows(10));
  });

  test("the request's own limit: exactly the limit is answered, one more is refused, and a limit past the budget is the budget", async () => {
    const limited = '{"datastore": "running", "path": "ex-if:interfaces", "limit": 3}';
    expect((await run(limited, { data: interfacesData(3) })).answer.rows).toHaveLength(3);
    expect((await refused(limited, { data: interfacesData(4) })).message).toBe(F.overLimit(3));
    const wide = '{"datastore": "running", "path": "ex-if:interfaces", "limit": 50}';
    expect((await refused(wide, { data: interfacesData(11) })).message).toBe(F.overRows(10));
  });

  test("bytes and rows of a result are refused past the budget, warnings absent when nothing is withheld", () => {
    const answer = { fields: ["a"], rows: [{ a: "x".repeat(50) }], withheld: [] };
    expect(netconfAgentResult(answer, BUDGET, 1)).toEqual({
      fields: ["a"],
      rows: [{ a: "x".repeat(50) }],
      rowCount: 1,
      executionTime: 1,
    });
    expect(() => netconfAgentResult(answer, { ...BUDGET, maxResultBytes: 10 }, 1)).toThrow(byteBudgetSentence(60, 10));
    expect(() =>
      netconfAgentResult({ ...answer, rows: [{ a: "1" }, { a: "2" }] }, { ...BUDGET, maxResultRows: 1 }, 1),
    ).toThrow(rowBudgetSentence(2, 1));
  });

  test("time: a read past the budget is refused in Studio's words, and a session still opening is closed once it opens", async () => {
    const device = fakeNetconfDevice();
    let release: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    const caught = await runNetconfAgentReadWithin(
      async () => {
        await opening;
        return createNetconfAgentClient(device.session, netconfXmlPort);
      },
      planOf(READ),
      { ...BUDGET, statementTimeoutMs: 5 },
    ).catch((error: unknown) => error);
    expect((caught as Error).message).toBe(F.time(5));
    expect(device.closed.count).toBe(0);
    release?.();
    await Bun.sleep(1);
    expect(device.closed.count).toBe(1);
    expect(device.sent).toEqual([]);
  });
});

describe("failures by category, never the device's or the credential's own text", () => {
  const failing =
    (error: unknown): (() => Promise<NetconfAgentClient>) =>
    async () => {
      throw error;
    };
  test("open and session failures", async () => {
    const SECRET = "not-a-real-password";
    for (const [error, sentence] of [
      [new AuthenticationError(`refused ${SECRET}`, "netconf"), F.credential],
      [new DatabaseConfigError(`pin ${SECRET}`, "netconf"), F.settings],
      [new ConnectionError(`host ${SECRET}`, "netconf"), F.unreachable],
      [new NetconfSessionError({ reason: "deadline", detail: SECRET }), F.unreachable],
      [new XmlReaderError({ kind: "doctype" }), F.unreadable],
      [new QueryError(SECRET), F.unreadable],
      [new MetadataProjectionError("path", "name"), new MetadataProjectionError("path", "name").message],
    ] as const) {
      const caught = await runNetconfAgentReadWithin(failing(error), planOf(READ), BUDGET).catch(
        (failure: unknown) => failure,
      );
      expect(caught).toBeInstanceOf(NetconfAgentError);
      expect((caught as Error).message).toBe(sentence);
      expect((caught as Error).message).not.toContain(SECRET);
    }
  });

  test("a session that ends during the module check is worded by its category, not as the check's refusal", async () => {
    const device = fakeNetconfDevice();
    const ending = {
      request: async (request: Parameters<typeof device.session.request>[0]) => {
        if (request.operation === "get-schema") throw new NetconfSessionError({ reason: "closed-by-peer" });
        return device.session.request(request);
      },
      close: device.session.close,
    };
    const caught = await runNetconfAgentReadWithin(
      async () => createNetconfAgentClient(ending, netconfXmlPort),
      planOf(READ),
      BUDGET,
    ).catch((failure: unknown) => failure);
    expect((caught as Error).message).toBe(F.unreachable);
  });

  test("a defect of Studio's own rises unchanged", async () => {
    const defect = new TypeError("a defect");
    expect(
      await runNetconfAgentReadWithin(failing(defect), planOf(READ), BUDGET).catch((failure: unknown) => failure),
    ).toBe(defect);
  });
});
