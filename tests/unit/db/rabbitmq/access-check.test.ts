/**
 * Test Connection's own cautions: an alarm, no virtual host, and readable classic or quorum queues, checked only
 * with the plugin listed, within the virtual host bound, the tracking bound and the check deadline, in that order.
 */
import { describe, expect, test } from "bun:test";
import { testConnectionCautions } from "@/lib/db/providers/stream/rabbitmq/access-check";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import { quoteName } from "@/lib/db/providers/stream/rabbitmq/errors";
import {
  RABBITMQ_TEST_CHECK_MAX_QUEUES,
  RABBITMQ_TEST_CHECK_MAX_VHOSTS,
} from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import { createTrackingProbe } from "@/lib/db/providers/stream/rabbitmq/tracking-probe";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  createManagementStub,
  hangUntilAbort,
  jsonOk,
  manualDeadlines,
  type StubAnswer,
} from "../../../helpers/rabbitmq-management-stub";

const ALARM = "The broker reports an active resource alarm, so publishers are blocked; reads still work.";
const NO_VHOSTS =
  "This user has no permissions on any virtual host, so there is nothing to show: grant it permissions on each virtual host it should browse.";
const QUEUES = (vhost: string) =>
  `GET /api/queues/${encodeURIComponent(vhost)}?columns=name,type,state,messages,messages_ready,messages_unacknowledged&disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name`;
const TRACKING = (vhost: string, queue: string) =>
  `GET /api/stream/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}/tracking`;

function harness() {
  const stub = createManagementStub();
  const deadlines = manualDeadlines();
  const client = createManagementClient({
    endpoint: readConnectionOptions(rabbitmqConnection()).management,
    transport: stub.factory,
    deadlineSignal: deadlines.factory,
    queryTimeoutMs: 10_000,
    lifetime: new AbortController().signal,
    limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
  });
  const run = () => testConnectionCautions(client, createTrackingProbe(client), deadlines.factory);
  return { stub, deadlines, run };
}

interface Broker {
  readonly alarm?: boolean;
  readonly plugin?: boolean;
  /** Virtual host to its queues: name to type. */
  readonly vhosts: Readonly<Record<string, readonly (readonly [string, string])[]>>;
  /** Queue key "vhost/queue" to a tracking status; 503 when absent. */
  readonly tracking?: Readonly<Record<string, number | StubAnswer>>;
}

function answer(stub: ReturnType<typeof createManagementStub>, broker: Broker): void {
  stub.answer(
    "GET /api/health/checks/alarms",
    broker.alarm === true ? jsonOk({ status: "failed", alarms: [] }, 503) : jsonOk({ status: "ok" }),
  );
  stub.answer("GET /api/vhosts", jsonOk(Object.keys(broker.vhosts).map((name) => ({ name }))));
  stub.answer(
    "GET /api/extensions",
    jsonOk(broker.plugin === false ? [{ javascript: "dispatcher.js" }] : [{ javascript: ["stream.js"] }]),
  );
  for (const [vhost, queues] of Object.entries(broker.vhosts)) {
    stub.answer(
      QUEUES(vhost),
      jsonOk({
        filtered_count: queues.length,
        items: queues.map(([name, type]) => ({ name, type, state: "running" })),
      }),
    );
    for (const [queue] of queues) {
      const status = broker.tracking?.[`${vhost}/${queue}`] ?? 503;
      stub.answer(TRACKING(vhost, queue), typeof status === "number" ? { status, body: "{}" } : status);
    }
  }
}

const classic = (n: number, prefix = "q") =>
  Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(3, "0")}`, "classic"] as const);

describe("the cautions", () => {
  test("a broker with nothing to report answers none, and makes alarms, vhosts, extensions, one page and its tracking GETs", async () => {
    const { stub, run } = harness();
    answer(stub, {
      vhosts: {
        "/": [
          ["st", "stream"],
          ["q1", "classic"],
        ],
      },
      tracking: { "//q1": 401 },
    });
    expect(await run()).toEqual([]);
    expect(stub.keys()).toEqual([
      "GET /api/health/checks/alarms",
      "GET /api/vhosts",
      "GET /api/extensions",
      QUEUES("/"),
      TRACKING("/", "q1"),
    ]);
  });

  test("an active alarm is the first caution", async () => {
    const { stub, run } = harness();
    answer(stub, { alarm: true, vhosts: { "/": [] } });
    expect((await run()).map((w) => w.message)).toEqual([ALARM]);
  });

  test("no virtual host is its caution, and nothing else is read", async () => {
    const { stub, run } = harness();
    answer(stub, { vhosts: {} });
    expect((await run()).map((w) => w.message)).toEqual([NO_VHOSTS]);
    expect(stub.keys()).toEqual(["GET /api/health/checks/alarms", "GET /api/vhosts"]);
  });

  test("without the plugin there is no queue check and no caution about it", async () => {
    const { stub, run } = harness();
    answer(stub, { plugin: false, vhosts: { "/": classic(3) } });
    expect(await run()).toEqual([]);
    expect(stub.keys().some((k) => k.includes("/api/queues/") || k.endsWith("/tracking"))).toBe(false);
  });

  test("readable queues: 5 named in listing order, then the rest found, then the ones not checked", async () => {
    const { stub, run } = harness();
    const queues = [...classic(7), ["s1", "stream"] as const, ["qq", "quorum"] as const, ["odd", "classic"] as const];
    answer(stub, { vhosts: { billing: queues }, tracking: { "billing/q001": 401, "billing/odd": 404 } });
    expect((await run()).map((w) => w.message)).toEqual([
      `This account can read classic or quorum queues "q000", "q002", "q003", "q004", "q005" and 2 more in virtual host "billing": a client using it could take their messages. Studio never does; narrow the read permission to stream names. 1 more was not checked.`,
    ]);
    expect(stub.keys().some((k) => k === TRACKING("billing", "s1"))).toBe(false);
  });

  test("names are quoted and escaped", async () => {
    const { stub, run } = harness();
    const name = `a; Studio says all is well ${String.fromCodePoint(0x202e)}x`;
    answer(stub, { vhosts: { "v, w": [[name, "classic"]] } });
    const [warning] = await run();
    expect(warning.message).toContain(`queue ${quoteName(name)} in virtual host ${quoteName("v, w")}`);
    expect(warning.message).not.toContain(String.fromCodePoint(0x202e));
  });

  test("at most 3 virtual host cautions, then one sentence for the rest", async () => {
    const { stub, run } = harness();
    answer(stub, {
      vhosts: Object.fromEntries(["a", "b", "c", "d", "e"].map((v) => [v, [["q", "classic"]] as const])),
    });
    const messages = (await run()).map((w) => w.message);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toBe("Readable classic or quorum queues were also found in 2 more virtual hosts.");
  });
});

describe("the bounds", () => {
  test(`reads the Queues page of at most ${RABBITMQ_TEST_CHECK_MAX_VHOSTS} virtual hosts`, async () => {
    const { stub, run } = harness();
    answer(stub, {
      vhosts: Object.fromEntries(Array.from({ length: RABBITMQ_TEST_CHECK_MAX_VHOSTS + 3 }, (_, i) => [`v${i}`, []])),
    });
    await run();
    expect(stub.keys().filter((k) => k.startsWith("GET /api/queues/"))).toHaveLength(RABBITMQ_TEST_CHECK_MAX_VHOSTS);
  });

  test(`makes at most ${RABBITMQ_TEST_CHECK_MAX_QUEUES} tracking GETs and counts the rest as not checked`, async () => {
    const { stub, run } = harness();
    answer(stub, { vhosts: { "/": classic(RABBITMQ_TEST_CHECK_MAX_QUEUES + 10), other: classic(5, "o") } });
    const [warning] = await run();
    expect(stub.keys().filter((k) => k.endsWith("/tracking"))).toHaveLength(RABBITMQ_TEST_CHECK_MAX_QUEUES);
    expect(warning.message).toEndWith(" 10 more were not checked.");
    expect(stub.keys()).not.toContain(QUEUES("other"));
  });

  test("the check deadline is asked for 10 s and joins every GET; when it fires, the check stops and counts the rest", async () => {
    const { stub, deadlines, run } = harness();
    answer(stub, { vhosts: { "/": classic(4) } });
    stub.answer(TRACKING("/", "q002"), hangUntilAbort());
    const pending = run();
    await Bun.sleep(5);
    expect(deadlines.asked[0]).toBe(10_000);
    deadlines.fire(0);
    const [warning] = await pending;
    expect(warning.message).toContain('"q000", "q001"');
    expect(warning.message).toEndWith(" 2 more were not checked.");
    expect(stub.keys()).not.toContain(TRACKING("/", "q003"));
  });

  test("a virtual host this account may not list is skipped", async () => {
    const { stub, run } = harness();
    answer(stub, { vhosts: { locked: [], open: [["q", "classic"]] } });
    stub.answer(QUEUES("locked"), jsonOk({ error: "not_found", reason: "Not Found" }, 404));
    const messages = (await run()).map((w) => w.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('virtual host "open"');
  });

  test("a deadline on a page ends the check; any other failure is raised", async () => {
    const timed = harness();
    answer(timed.stub, { vhosts: { "/": classic(1) } });
    timed.stub.answer(QUEUES("/"), hangUntilAbort());
    const pending = timed.run();
    await Bun.sleep(5);
    timed.deadlines.fire(0);
    expect(await pending).toEqual([]);

    const broken = harness();
    answer(broken.stub, { vhosts: { "/": classic(1) } });
    broken.stub.answer(QUEUES("/"), { status: 500, body: "" });
    await expect(broken.run()).rejects.toThrow("answered with a server error (500)");

    const brokenTracking = harness();
    answer(brokenTracking.stub, { vhosts: { "/": classic(1) } });
    brokenTracking.stub.answer(TRACKING("/", "q000"), async () => {
      throw new Error("PEER-SENTINEL");
    });
    await expect(brokenTracking.run()).rejects.toThrow(
      "Studio could not read the broker's answer for the stream tracking check.",
    );
  });
});
