/**
 * While the provider is incomplete, every member that would reach the broker refuses with one sentence before any
 * I/O, and disconnect() always succeeds. Later work replaces these members one by one and deletes their cases here.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryCancelledError } from "@/lib/db/errors";
import { PROVIDER_CLOSED, TUNNEL_REFUSED } from "@/lib/db/providers/stream/rabbitmq/errors";
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

  test("connect() runs the connection rules first: a record they refuse never reaches the interim refusal", async () => {
    const tunnelled = new RabbitMQProvider(
      rabbitmqConnection({
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
      }),
    );
    await expect(tunnelled.connect()).rejects.toThrow(TUNNEL_REFUSED);
  });

  test("disconnect() succeeds on a provider that never connected, and aborts its lifetime with the closed sentence", async () => {
    const instance = provider();
    await instance.disconnect();
    await instance.disconnect();
    expect(instance.isConnected()).toBe(false);
    const signal = (Reflect.get(instance, "lifetime") as AbortController).signal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(QueryCancelledError);
    expect((signal.reason as Error).message).toBe(PROVIDER_CLOSED);
  });
});
