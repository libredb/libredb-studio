/**
 * The read-permission probe: the plugin list read once per provider instance, and one tracking GET per queue whose
 * status alone says whether this account could take the queue's messages.
 */
import { describe, expect, test } from "bun:test";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import { createTrackingProbe, type QueueAccess } from "@/lib/db/providers/stream/rabbitmq/tracking-probe";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import { createManagementStub, jsonOk, manualDeadlines } from "../../../helpers/rabbitmq-management-stub";

function probe() {
  const stub = createManagementStub();
  const client = createManagementClient({
    endpoint: readConnectionOptions(rabbitmqConnection()).management,
    transport: stub.factory,
    deadlineSignal: manualDeadlines().factory,
    queryTimeoutMs: 60_000,
    lifetime: new AbortController().signal,
    limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
  });
  return { stub, probe: createTrackingProbe(client) };
}

const TRACKING = "GET /api/stream/billing/q%201/tracking";

describe("streamManagementListed", () => {
  test("reads /api/extensions once and holds the answer", async () => {
    const { stub, probe: tracking } = probe();
    stub.answer("GET /api/extensions", jsonOk([{ javascript: ["stream_management-ejs.js", "stream.js"] }]));
    expect(await tracking.streamManagementListed()).toBe(true);
    expect(await tracking.streamManagementListed()).toBe(true);
    expect(stub.keys()).toEqual(["GET /api/extensions"]);
  });

  test("a broker without the plugin answers false, also held", async () => {
    const { stub, probe: tracking } = probe();
    stub.answer("GET /api/extensions", jsonOk([{ javascript: "dispatcher.js" }]));
    expect(await tracking.streamManagementListed()).toBe(false);
    expect(await tracking.streamManagementListed()).toBe(false);
    expect(stub.requests).toHaveLength(1);
  });

  test("callers that ask together share one GET", async () => {
    const { stub, probe: tracking } = probe();
    stub.answer("GET /api/extensions", jsonOk([{ javascript: "stream.js" }]));
    expect(await Promise.all([tracking.streamManagementListed(), tracking.streamManagementListed()])).toEqual([
      true,
      true,
    ]);
    expect(stub.keys()).toEqual(["GET /api/extensions"]);
  });

  test("a failed read is not held: the next caller asks again", async () => {
    const { stub, probe: tracking } = probe();
    stub.answer("GET /api/extensions", { status: 500, body: "{}" });
    await expect(tracking.streamManagementListed()).rejects.toThrow();
    stub.answer("GET /api/extensions", jsonOk([{ javascript: "stream.js" }]));
    expect(await tracking.streamManagementListed()).toBe(true);
    expect(stub.keys()).toEqual(["GET /api/extensions", "GET /api/extensions"]);
  });
});

describe("queueReadableByAccount", () => {
  test("503 and 400 are readable, 401 is not, anything else is unchecked; every call asks again", async () => {
    const { stub, probe: tracking } = probe();
    const cases: [number, QueueAccess][] = [
      [503, "readable"],
      [400, "readable"],
      [401, "not-readable"],
      [200, "unchecked"],
      [404, "unchecked"],
      [500, "unchecked"],
    ];
    for (const [status, access] of cases) {
      stub.answer(TRACKING, { status, body: JSON.stringify({ error: "PEER-SENTINEL" }) });
      expect(await tracking.queueReadableByAccount("billing", "q 1")).toBe(access);
    }
    expect(stub.keys()).toEqual(cases.map(() => TRACKING));
  });
});
