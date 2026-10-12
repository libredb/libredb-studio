/**
 * Opt-in live check for the RabbitMQ provider (#1656): does a real `RabbitMQProvider`, run over every surface it has,
 * take no message from any classic or quorum queue, leave no connection behind, and does each surface answer?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The seam guard is syntactic: it proves the provider has no encoder
 * for a take. Only the broker can say that nothing was taken, so this script asks the broker's own counters (the
 * oracle of `tests/helpers/rabbitmq-oracle.ts`), and proves the oracle can see a take with one control take of its own.
 * It is not in `bun run test`: the runner excludes `tests/live/`. CI runs it in the Functional Smoke job against a
 * fresh 4.3.6 broker; a person runs it against the compose services:
 *
 *   RABBITMQ_LIVE_DIGEST=sha256:8dd6... RABBITMQ_LIVE_ADMIN_PASSWORD=... RABBITMQ_LIVE_FIXTURE_PASSWORD=... \
 *     bun tests/live/rabbitmq-read-only.ts [--dedicated] [--plugin=present|absent]
 *
 * `--dedicated` says the broker serves this run alone (CI, or a compose broker just started), which makes the
 * broker-wide take counters meaningful too. `--plugin=absent` runs against a broker without
 * rabbitmq_stream_management, where Test Connection must name no readable queue. 4.2.9 is run by hand against the
 * `rabbitmq-42` profile and recorded in the PR.
 *
 * WHAT IT CHECKS, in order: the oracle's family is present; the canary gets its one message; the baseline; every
 * provider surface as `studio-wide-read`, which may read every queue, so a take by the provider would move a counter:
 * connect, the tree, every listing, every detail and source, the monitoring reads, Test Connection, and a read of every
 * stream in every from form, poison streams included; a cancel after the first delivery; the consume 403 as
 * `studio-reader` on a stream its pattern does not name; Test Connection as `studio-reader`, which must name no queue;
 * then, 1 s after the last connection closed, the comparison, the control take, and the connection listing 6 s after
 * the run with its own positive control. It exits non-zero when any check fails and prints each check with its detail.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq";
import { dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import {
  cancelWarning,
  conversionAfter,
  conversionNoRowKeyword,
  readableQueuesCaution,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { RABBITMQ_PREFETCH_MAX } from "@/lib/db/providers/stream/rabbitmq/limits";
import type { DatabaseConnection } from "@/lib/types";
import { basicGetOnce } from "../helpers/rabbitmq-basic-get";
import { rabbitmqConnection } from "../helpers/rabbitmq-connection";
import { AdminApi, liveTarget, type RabbitMQLiveTarget, segment } from "../helpers/rabbitmq-live";
import {
  type CounterRows,
  controlMoved,
  globalTakeCounters,
  parseDeliveryMetrics,
  rowDifferences,
} from "../helpers/rabbitmq-oracle";
import { FrameSplitter, methodId, TestAmqpConnection, TestPublisher } from "../helpers/rabbitmq-test-amqp091";
import { RABBITMQ_FIXTURE_VHOSTS, RABBITMQ_SEED_TABLE } from "./rabbitmq-seed";

const CANARY = "q-canary";
const STUDIO_CONNECTION_NAME = "LibreDB Studio";
const argv = process.argv.slice(2);
const dedicated = argv.includes("--dedicated");
const plugin = argv.find((arg) => arg.startsWith("--plugin="))?.slice("--plugin=".length) ?? "present";
if (plugin !== "present" && plugin !== "absent") throw new Error("--plugin takes present or absent.");

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

function connectionAs(target: RabbitMQLiveTarget, user: string): DatabaseConnection {
  return rabbitmqConnection({
    host: target.host,
    port: target.managementPort,
    amqpPort: String(target.amqpPort),
    user,
    password: target.fixturePassword,
  });
}

async function scrape(target: RabbitMQLiveTarget): Promise<Record<string, CounterRows>> {
  const out: Record<string, CounterRows> = {};
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    const response = await fetch(
      `http://${target.host}:${target.prometheusPort}/metrics/detailed?family=queue_delivery_metrics&vhost=${segment(vhost)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (response.status !== 200)
      throw new Error(`The oracle is broken: /metrics/detailed answered ${response.status}.`);
    out[vhost] = parseDeliveryMetrics(await response.text(), vhost);
  }
  return out;
}

async function globals(target: RabbitMQLiveTarget): Promise<Readonly<Record<string, number>>> {
  const response = await fetch(`http://${target.host}:${target.prometheusPort}/metrics`, {
    signal: AbortSignal.timeout(30_000),
  });
  return globalTakeCounters(await response.text());
}

/** Runs `run`, and returns its result or the error it threw, so one failing surface does not hide the rest. */
async function settle<T>(run: () => Promise<T>): Promise<{ readonly value?: T; readonly error?: Error }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error as Error };
  }
}

/** Every provider surface as `studio-wide-read`; returns the number of AMQP connections the reads opened. */
async function everySurface(target: RabbitMQLiveTarget): Promise<number> {
  let dials = 0;
  const provider = new RabbitMQProvider(
    connectionAs(target, "studio-wide-read"),
    {},
    {
      dial: async (endpoint, signal) => {
        dials++;
        return dialAmqp(endpoint, signal);
      },
    },
  );
  await provider.connect();
  const containers = await provider.listContainers();
  check(
    "listContainers lists both fixture vhosts",
    RABBITMQ_FIXTURE_VHOSTS.every((v) => containers.some((c) => c.name === v)),
  );
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    const counts = await settle(() => provider.countObjects([vhost]));
    check(`countObjects(${vhost}) answers`, counts.error === undefined, counts.error?.message);
    for (const kind of ["stream", "queue", "exchange"]) {
      const listed = await settle(() => provider.listObjects([vhost], kind));
      check(`listObjects(${vhost}, ${kind}) answers`, listed.error === undefined, listed.error?.message);
      for (const object of listed.value ?? []) {
        const source = await settle(() => provider.readObjectSource?.(object.path, kind) ?? Promise.resolve(undefined));
        check(
          `readObjectSource(${JSON.stringify(object.path)}, ${kind}) answers`,
          source.error === undefined,
          source.error?.message,
        );
        if (kind === "stream") {
          const detail = await settle(() => provider.describeObject(object.path, kind));
          check(
            `describeObject(${JSON.stringify(object.path)}) answers`,
            detail.error === undefined,
            detail.error?.message,
          );
        }
      }
    }
  }
  for (const surface of [
    "getHealth",
    "getOverview",
    "getPerformanceMetrics",
    "getSlowQueries",
    "getActiveSessions",
    "getTableStats",
    "getIndexStats",
    "getStorageStats",
  ] as const) {
    const answer = await settle(() => (provider[surface] as () => Promise<unknown>).call(provider));
    check(`${surface}() answers`, answer.error === undefined, answer.error?.message);
  }
  const warnings = await provider.testConnectionWarnings?.();
  const named = (warnings ?? []).map((warning) => warning.message);
  if (plugin === "present") {
    const expected = readableQueuesCaution(
      "/",
      ["q-canary", "q-classic-dead", "q-classic-empty", "q-classic-orders", "q-quorum-nodlx"],
      1,
      0,
    );
    check(
      "Test Connection as studio-wide-read names the readable classic and quorum queues of /",
      named.includes(expected),
      named.join(" | "),
    );
  } else {
    check(
      "Test Connection without the plugin names no queue",
      named.every((m) => !m.includes("can read classic or quorum")),
      named.join(" | "),
    );
  }
  const EVENTS_FORMS = [
    '"last"',
    '"next"',
    '{"offset": 990}',
    '{"age": "1h"}',
    '{"timestamp": "2000-01-01T00:00:00Z"}',
  ];
  for (const queue of RABBITMQ_SEED_TABLE.filter((q) => q.type === "stream")) {
    for (const from of ['"first"', ...(queue.name === "st-events" ? EVENTS_FORMS : [])]) {
      const request = `{"vhost": ${JSON.stringify(queue.vhost)}, "stream": ${JSON.stringify(queue.name)}, "from": ${from}, "limit": 50}`;
      const read = await settle(() => provider.query(request));
      const poison = queue.messages.some((m) => m.note.startsWith("poison"));
      if (!poison) {
        check(`read ${request} answers`, read.error === undefined, read.error?.message);
        continue;
      }
      // A poison stream read from "first" ends with the broker's 541: after the rows before it, or before any row.
      const rows = read.value?.rows ?? [];
      const last = rows.length > 0 ? BigInt(String(rows[rows.length - 1].offset)) : null;
      const expected =
        last === null
          ? conversionNoRowKeyword('"first"', false, queue.vhost, queue.name)
          : conversionAfter(last, RABBITMQ_PREFETCH_MAX, queue.vhost, queue.name);
      const said = read.error ? [read.error.message] : (read.value?.warnings ?? []).map((w) => w.message);
      check(`read ${request} ends with the conversion sentence`, said.includes(expected), said.join(" | "));
    }
  }
  await provider.disconnect();
  return dials;
}

/**
 * A read of st-events cancelled once a delivery has arrived ends with the cancel warning. The cancel is sent on the
 * next turn after the first `basic.deliver` chunk, so the provider has handled that chunk (consume-ok included) first.
 */
async function cancelAfterConsumeOk(target: RabbitMQLiveTarget): Promise<void> {
  const queryId = "live-cancel-after-consume-ok";
  const holder: { provider?: RabbitMQProvider } = {};
  const provider = new RabbitMQProvider(
    connectionAs(target, "studio-wide-read"),
    {},
    {
      dial: async (endpoint, signal) => {
        const socket = await dialAmqp(endpoint, signal);
        const splitter = new FrameSplitter();
        let cancelled = false;
        socket.on("data", (chunk) => {
          if (cancelled) return;
          const delivered = splitter
            .push(chunk)
            .some(
              (frame) =>
                frame.type === 1 && methodId(frame.payload).classId === 60 && methodId(frame.payload).methodId === 60,
            );
          if (delivered) {
            cancelled = true;
            setImmediate(() => void holder.provider?.cancelQuery(queryId));
          }
        });
        return socket;
      },
    },
  );
  holder.provider = provider;
  await provider.connect();
  const result = await settle(() =>
    provider.query('{"vhost": "/", "stream": "st-events", "from": "first", "limit": 500}', undefined, queryId),
  );
  const rows = result.value?.rows ?? [];
  const last = rows.length > 0 ? BigInt(String(rows[rows.length - 1].offset)) : null;
  const messages = (result.value?.warnings ?? []).map((w) => w.message);
  check(
    "a cancel after the first delivery ends the read with its rows and the cancel warning",
    last !== null && messages.includes(cancelWarning(last)),
    result.error?.message ?? messages.join(" | "),
  );
  await provider.disconnect();
}

async function studioReaderChecks(target: RabbitMQLiveTarget): Promise<void> {
  const provider = new RabbitMQProvider(connectionAs(target, "studio-reader"), {});
  await provider.connect();
  const refused = await settle(() =>
    provider.query('{"vhost": "/", "stream": "st-restricted", "from": "first", "limit": 1}'),
  );
  check(
    "a read of a stream outside studio-reader's pattern is refused by the broker's 403",
    refused.error !== undefined && !refused.error.message.includes(target.fixturePassword),
    refused.error?.message,
  );
  const warnings = (await provider.testConnectionWarnings?.()) ?? [];
  check(
    "Test Connection as studio-reader names no readable queue",
    warnings.length === 0,
    warnings.map((w) => w.message).join(" | "),
  );
  await provider.disconnect();
}

async function studioConnections(admin: AdminApi): Promise<number> {
  const listed = await admin.json<{ client_properties?: { connection_name?: string } }[]>(
    "/api/connections?columns=client_properties",
  );
  return listed.filter((c) => c.client_properties?.connection_name === STUDIO_CONNECTION_NAME).length;
}

async function main(): Promise<void> {
  const target = liveTarget();
  const admin = new AdminApi(target);
  const amqpAdmin = {
    host: target.host,
    port: target.amqpPort,
    vhost: "/",
    username: target.adminUser,
    password: target.adminPassword,
  };
  const wideRead = { ...amqpAdmin, username: "studio-wide-read", password: target.fixturePassword };

  await scrape(target);
  check("the queue_delivery_metrics family is present", true);
  const canary = await admin.json<{ messages?: number }>(`/api/queues/%2F/${CANARY}?columns=messages`);
  if ((canary.messages ?? 0) === 0) {
    const publisher = await TestPublisher.open(amqpAdmin);
    await publisher.publish("", CANARY, new TextEncoder().encode("canary"));
    await publisher.close();
  }
  const guarded: Record<string, string[]> = {};
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    const queues = await admin.json<{ name: string; type: string }[]>(
      `/api/queues/${segment(vhost)}?columns=name,type`,
    );
    guarded[vhost] = queues
      .filter((q) => q.type === "classic" || q.type === "quorum")
      .map((q) => q.name)
      .filter((n) => n !== CANARY);
  }
  const before = await scrape(target);
  const globalBefore = dedicated ? await globals(target) : {};

  const dials = await everySurface(target);
  check("the reads opened AMQP connections, so the comparison saw the read path", dials > 0, `${dials} dials`);
  await cancelAfterConsumeOk(target);
  await studioReaderChecks(target);
  await sleep(1000);

  const after = await scrape(target);
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    const differences = rowDifferences(guarded[vhost], before[vhost], after[vhost]);
    check(
      `no classic or quorum queue in ${vhost} was taken from (${guarded[vhost].length} guarded)`,
      differences.length === 0,
      differences.join("; "),
    );
  }
  if (dedicated) {
    const globalAfter = await globals(target);
    const moved = Object.keys({ ...globalBefore, ...globalAfter }).filter(
      (key) => globalBefore[key] !== globalAfter[key],
    );
    check("the broker-wide classic and quorum take counters did not move", moved.length === 0, moved.join(", "));
  }

  const take = await basicGetOnce(wideRead, CANARY);
  check("the control take got the canary's message", take.kind === "get-ok", take.kind);
  await sleep(1000);
  const control = await scrape(target);
  const verdict = controlMoved(after["/"], control["/"], CANARY);
  check("the control take moved queue_get_total by exactly 1", verdict === null, verdict ?? "");

  await sleep(6000);
  const leftover = await studioConnections(admin);
  const marker = await TestAmqpConnection.open(amqpAdmin, STUDIO_CONNECTION_NAME);
  let seen = 0;
  for (let attempt = 0; attempt < 20 && seen === 0; attempt++) {
    seen = await studioConnections(admin);
    if (seen === 0) await sleep(500);
  }
  await marker.close();
  check("the connection listing sees a connection named LibreDB Studio (the control)", seen === 1, `${seen}`);
  check("6 s after the run, no connection named LibreDB Studio is left", leftover === 0, `${leftover}`);
}

try {
  await main();
} catch (error) {
  check("the live check ran to its end", false, (error as Error).message);
}
const failed = checks.filter((c) => !c.ok);
console.log(`${failed.length === 0 ? "PASSED" : "FAILED"} ${checks.length - failed.length}/${checks.length}`);
process.exit(failed.length === 0 ? 0 : 1);
