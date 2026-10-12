/**
 * While the provider is incomplete, every member that would reach the broker refuses with one sentence before any
 * I/O, and disconnect() always succeeds. Later work replaces these members one by one and deletes their cases here.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { RABBITMQ_PROVIDER_PENDING, RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import type { DatabaseProvider } from "@/lib/db/types";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const provider = (): RabbitMQProvider => new RabbitMQProvider(rabbitmqConnection());

/** Called through the provider contract, as the routes call it: the interim members take no arguments of their own. */
const PENDING_MEMBERS: ReadonlyArray<readonly [string, (p: DatabaseProvider) => Promise<unknown>]> = [
  ["connect", (p) => p.connect()],
  ["query", (p) => p.query('{"vhost": "/", "stream": "orders"}')],
  ["listContainers", (p) => p.listContainers()],
  ["countObjects", (p) => p.countObjects(["/"])],
  ["listObjects", (p) => p.listObjects(["/"], "stream")],
  ["describeObject", (p) => p.describeObject(["/", "orders"], "stream")],
  ["describeObjects", (p) => p.describeObjects(["/"], "stream")],
  ["readObjectSource", (p) => p.readObjectSource!(["/", "orders"], "stream")],
  ["getHealth", (p) => p.getHealth()],
  ["getOverview", (p) => p.getOverview()],
  ["getPerformanceMetrics", (p) => p.getPerformanceMetrics()],
  ["getSlowQueries", (p) => p.getSlowQueries()],
  ["getActiveSessions", (p) => p.getActiveSessions()],
  ["getTableStats", (p) => p.getTableStats()],
  ["getIndexStats", (p) => p.getIndexStats()],
  ["getStorageStats", (p) => p.getStorageStats()],
  ["runMaintenance", (p) => p.runMaintenance("analyze")],
];

describe("the interim refusal", () => {
  test("names the build as incomplete and is a configuration error", () => {
    expect(RABBITMQ_PROVIDER_PENDING).toBe("The RabbitMQ provider is not complete in this build.");
  });

  test.each(PENDING_MEMBERS)("%s refuses with it before any I/O", async (_name, call) => {
    const instance = provider();
    const failure = await call(instance).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as DatabaseConfigError).message).toBe(RABBITMQ_PROVIDER_PENDING);
    expect((failure as DatabaseConfigError).provider).toBe("rabbitmq");
    expect(instance.isConnected()).toBe(false);
  });

  test("disconnect() succeeds on a provider that never connected, and aborts its lifetime", async () => {
    const instance = provider();
    await instance.disconnect();
    await instance.disconnect();
    expect(instance.isConnected()).toBe(false);
    expect((Reflect.get(instance, "lifetime") as AbortController).signal.aborted).toBe(true);
  });
});
