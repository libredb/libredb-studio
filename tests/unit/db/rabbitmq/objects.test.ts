/**
 * The object surface over the management API: virtual hosts with "/" as the walk's default, one GET per folder, the
 * count rules of the Queues, Streams and exchange pages (exact, a floor, or why not), the broker's byte order, and
 * the column reads that need no GET.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import {
  countKinds,
  createStreamListingMemo,
  describeKind,
  describeKindBatch,
  listKind,
  listVhosts,
  readStreamPage,
} from "@/lib/db/providers/stream/rabbitmq/objects";
import { RABBITMQ_STREAM_COLUMNS } from "@/lib/db/providers/stream/rabbitmq/results";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  createManagementStub,
  jsonOk,
  manualDeadlines,
  SAMPLE_BODIES,
} from "../../../helpers/rabbitmq-management-stub";

const CAPABILITIES = new RabbitMQProvider(rabbitmqConnection()).getCapabilities();

const QUEUES = (vhost: string) =>
  `GET /api/queues/${vhost}?columns=name,type,state,messages,messages_ready,messages_unacknowledged&disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name`;
const STREAMS = (vhost: string) =>
  `GET /api/queues/${vhost}?columns=name,type,state&disable_stats=true&page=1&page_size=500&sort=type&sort_reverse=true`;
const EXCHANGES = (vhost: string) =>
  `GET /api/exchanges/${vhost}?columns=name,type,durable,auto_delete,internal&page=1&page_size=500&sort=name`;

function surface() {
  const stub = createManagementStub();
  const client = createManagementClient({
    endpoint: readConnectionOptions(rabbitmqConnection()).management,
    transport: stub.factory,
    deadlineSignal: manualDeadlines().factory,
    queryTimeoutMs: 60_000,
    lifetime: new AbortController().signal,
    limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
  });
  return { stub, client, memo: createStreamListingMemo() };
}

const row = (name: string, type: string, state = "running") => ({ name, type, state });
const page = (filtered: number, items: readonly unknown[]) => ({ filtered_count: filtered, items });

describe("listVhosts", () => {
  test("lists every virtual host by name, marking / as the walk's default, keeping no cluster state", async () => {
    const { stub, client } = surface();
    stub.answer("GET /api/vhosts", jsonOk(SAMPLE_BODIES.vhosts));
    const containers = await listVhosts(client);
    expect(containers).toEqual([
      { path: ["/"], name: "/", level: 0, isSessionDefault: true },
      { path: ["billing"], name: "billing", level: 0 },
    ]);
    expect(JSON.stringify(containers)).not.toContain("rabbit@");
  });

  test("without / listed, no container is marked", async () => {
    const { stub, client } = surface();
    stub.answer("GET /api/vhosts", jsonOk([{ name: "a, b" }, { name: "x y" }]));
    expect((await listVhosts(client)).some((c) => c.isSessionDefault === true)).toBe(false);
  });
});

describe("readStreamPage", () => {
  test("skips rows whose type sorts after stream, keeps the streams and reverses them into ascending order", () => {
    const listing = readStreamPage({
      filteredCount: 6,
      items: [
        row("z", "zz_plugin"),
        row("s3", "stream"),
        row("s2", "stream"),
        row("s1", "stream"),
        row("q", "quorum"),
        row("c", "classic"),
      ].map((r) => ({ ...r, state: r.state as string | null })),
    });
    expect(listing.streams.map((s) => s.name)).toEqual(["s1", "s2", "s3"]);
    expect(listing.count).toEqual({ count: 3 });
  });

  test("a non-stream row after the streams makes the count exact even above one page", () => {
    const items = [...Array.from({ length: 10 }, (_, i) => row(`s${i}`, "stream")), row("q", "quorum")];
    expect(readStreamPage({ filteredCount: 20_000, items }).count).toEqual({ count: 10 });
  });

  test("500 streams filling the page are a floor of 500 with the sentence naming the page", () => {
    const items = Array.from({ length: 500 }, (_, i) => row(`s${String(i).padStart(3, "0")}`, "stream"));
    expect(readStreamPage({ filteredCount: 20_404, items }).count).toEqual({
      count: 500,
      sampledFrom:
        "one page of 20,404 queues and streams sorted by type, which holds the 500 streams that sort last by name",
    });
  });

  test("other types sorting into a full page leave fewer streams, and the sentence names how many it held", () => {
    const items = [
      ...Array.from({ length: 188 }, (_, i) => row(`p${i}`, "zz_plugin")),
      ...Array.from({ length: 312 }, (_, i) => row(`s${String(i).padStart(3, "0")}`, "stream")),
    ];
    expect(readStreamPage({ filteredCount: 900, items }).count).toEqual({
      count: 312,
      sampledFrom:
        "one page of 900 queues and streams sorted by type, which holds the 312 streams that sort last by name",
    });
  });

  test("other types filling the page hide the streams: never 0", () => {
    const items = Array.from({ length: 500 }, (_, i) => row(`p${i}`, "zz_plugin"));
    expect(readStreamPage({ filteredCount: 900, items }).count).toEqual({
      unavailable:
        "Other queue types fill this virtual host's listing page, so Studio cannot list its streams; a stream is still readable by a typed read.",
    });
  });

  test("no stream at all on a short page is an exact 0", () => {
    expect(readStreamPage({ filteredCount: 2, items: [row("q", "quorum"), row("c", "classic")] }).count).toEqual({
      count: 0,
    });
  });
});

describe("countKinds", () => {
  test("issues the Queues page, the Streams page and the exchange page, one GET each", async () => {
    const { stub, client } = surface();
    stub.answer(QUEUES("%2F"), jsonOk(SAMPLE_BODIES["queues-page"]));
    stub.answer(STREAMS("%2F"), jsonOk(SAMPLE_BODIES["streams-page"]));
    stub.answer(EXCHANGES("%2F"), jsonOk(SAMPLE_BODIES["exchanges-page"]));
    expect(await countKinds(client, CAPABILITIES, ["/"])).toEqual({
      stream: { count: 1 },
      queue: { count: 2 },
      exchange: { count: 2 },
    });
    expect(stub.keys().sort()).toEqual([EXCHANGES("%2F"), QUEUES("%2F"), STREAMS("%2F")].sort());
  });

  test("above one page: queues K+ with the approximate queue total, exchanges 500+", async () => {
    const { stub, client } = surface();
    const queues = Array.from({ length: 500 }, (_, i) =>
      row(`q${String(i).padStart(3, "0")}`, i % 2 === 0 ? "classic" : "stream"),
    );
    const streams = [...Array.from({ length: 300 }, (_, i) => row(`s${i}`, "stream")), row("q", "quorum")];
    const exchanges = Array.from({ length: 500 }, (_, i) => ({
      name: `x${i}`,
      type: "direct",
      durable: true,
      auto_delete: false,
      internal: false,
    }));
    stub.answer(QUEUES("v"), jsonOk(page(30_300, queues)));
    stub.answer(STREAMS("v"), jsonOk(page(30_300, streams)));
    stub.answer(EXCHANGES("v"), jsonOk(page(1_200, exchanges)));
    expect(await countKinds(client, CAPABILITIES, ["v"])).toEqual({
      stream: { count: 300 },
      queue: {
        count: 250,
        sampledFrom:
          "one 500-name page of 30,300 queues and streams, by name, about 30,000 of them classic or quorum queues",
      },
      exchange: { count: 500, sampledFrom: "one 500-name page of 1,200 exchanges, by name" },
    });
  });

  test("with the Streams folder a floor, the queue sentence states no queue total", async () => {
    const { stub, client } = surface();
    stub.answer(
      QUEUES("v"),
      jsonOk(
        page(
          30_000,
          Array.from({ length: 500 }, (_, i) => row(`q${i}`, "classic")),
        ),
      ),
    );
    stub.answer(
      STREAMS("v"),
      jsonOk(
        page(
          30_000,
          Array.from({ length: 500 }, (_, i) => row(`s${i}`, "stream")),
        ),
      ),
    );
    stub.answer(EXCHANGES("v"), jsonOk(page(0, [])));
    const counts = await countKinds(client, CAPABILITIES, ["v"]);
    expect(counts.queue).toEqual({
      count: 500,
      sampledFrom: "one 500-name page of 30,000 queues and streams, by name",
    });
  });

  test("a folder answering 404 not_found or 401 counts as unavailable with the permissions sentence, never 0", async () => {
    const { stub, client } = surface();
    stub.answer(QUEUES("billing"), jsonOk({ error: "not_found", reason: "Not Found" }, 404));
    stub.answer(STREAMS("billing"), { status: 401, body: JSON.stringify({ error: "not_authorized" }) });
    stub.answer(EXCHANGES("billing"), { status: 401, body: "{}" });
    const sentence =
      'This user has no permissions on virtual host "billing": grant them to show its queues and exchanges.';
    expect(await countKinds(client, CAPABILITIES, ["billing"])).toEqual({
      stream: { unavailable: sentence },
      queue: { unavailable: sentence },
      exchange: { unavailable: sentence },
    });
  });

  test("any other failure fails the count", async () => {
    const { stub, client } = surface();
    stub.answer(QUEUES("v"), { status: 500, body: "" });
    stub.answer(STREAMS("v"), jsonOk(page(0, [])));
    stub.answer(EXCHANGES("v"), jsonOk(page(0, [])));
    await expect(countKinds(client, CAPABILITIES, ["v"])).rejects.toThrow(
      "The management API at 127.0.0.1:15672 answered with a server error (500).",
    );
  });

  test("a container path of another depth is refused before any GET", async () => {
    const { stub, client } = surface();
    for (const container of [[], ["a", "b"]]) {
      await expect(countKinds(client, CAPABILITIES, container)).rejects.toBeInstanceOf(QueryError);
    }
    expect(stub.requests).toHaveLength(0);
  });
});

describe("listKind", () => {
  test("streams in ascending order, a state other than running as status, and the memo filled", async () => {
    const { stub, client, memo } = surface();
    stub.answer(
      STREAMS("%2F"),
      jsonOk(page(4, [row("st-b", "stream"), row("st-a", "stream", "down"), row("q", "quorum"), row("c", "classic")])),
    );
    expect(await listKind(client, CAPABILITIES, memo, ["/"], "stream")).toEqual([
      { path: ["/", "st-a"], name: "st-a", kind: "stream", status: "down" },
      { path: ["/", "st-b"], name: "st-b", kind: "stream" },
    ]);
    expect(memo.take("/")?.streams.map((s) => s.name)).toEqual(["st-a", "st-b"]);
  });

  test("queues keep only classic and quorum rows, in the broker's order", async () => {
    const { stub, client, memo } = surface();
    stub.answer(QUEUES("%2F"), jsonOk(SAMPLE_BODIES["queues-page"]));
    expect((await listKind(client, CAPABILITIES, memo, ["/"], "queue")).map((o) => o.name)).toEqual([
      "orders",
      "payments",
    ]);
  });

  test("the default exchange is labelled (AMQP default) and addressed by its empty name", async () => {
    const { stub, client, memo } = surface();
    stub.answer(EXCHANGES("%2F"), jsonOk(SAMPLE_BODIES["exchanges-page"]));
    expect(await listKind(client, CAPABILITIES, memo, ["/"], "exchange")).toEqual([
      { path: ["/", ""], name: "(AMQP default)", kind: "exchange" },
      { path: ["/", "ex-topic"], name: "ex-topic", kind: "exchange" },
    ]);
  });

  test("an undeclared kind is refused before any GET", async () => {
    const { stub, client, memo } = surface();
    await expect(listKind(client, CAPABILITIES, memo, ["/"], "binding")).rejects.toThrow(
      'RabbitMQ declares no object kind "binding".',
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe("describeKind and describeKindBatch", () => {
  test("a stream's columns are the read result's nine; a queue and an exchange have none; no GET", () => {
    expect(describeKind(CAPABILITIES, ["/", "st"], "stream").columns).toBe(RABBITMQ_STREAM_COLUMNS);
    expect(describeKind(CAPABILITIES, ["/", "q"], "queue").columns).toEqual([]);
    expect(describeKind(CAPABILITIES, ["/", ""], "exchange").columns).toEqual([]);
    expect(() => describeKind(CAPABILITIES, ["st"], "stream")).toThrow(QueryError);
    expect(() => describeKind(CAPABILITIES, ["/", "x"], "binding")).toThrow(
      'RabbitMQ declares no object kind "binding".',
    );
  });

  test("after a stream listing the batch reads no GET; without one it reads the Streams page once", async () => {
    const { stub, client, memo } = surface();
    stub.answer(STREAMS("%2F"), jsonOk(page(2, [row("b", "stream"), row("a", "stream")])));
    await listKind(client, CAPABILITIES, memo, ["/"], "stream");
    const before = stub.requests.length;
    const batch = await describeKindBatch(client, CAPABILITIES, memo, ["/"], "stream", 2);
    expect(stub.requests.length).toBe(before);
    expect(batch).toEqual({
      details: [
        { path: ["/", "a"], columns: RABBITMQ_STREAM_COLUMNS, indexes: [], foreignKeys: [] },
        { path: ["/", "b"], columns: RABBITMQ_STREAM_COLUMNS, indexes: [], foreignKeys: [] },
      ],
    });
    await describeKindBatch(client, CAPABILITIES, memo, ["/"], "stream");
    expect(stub.requests.length).toBe(before + 1);
  });

  test("queues and exchanges answer no detail and no GET", async () => {
    const { stub, client, memo } = surface();
    expect(await describeKindBatch(client, CAPABILITIES, memo, ["/"], "queue")).toEqual({ details: [] });
    expect(await describeKindBatch(client, CAPABILITIES, memo, ["/"], "exchange")).toEqual({ details: [] });
    expect(stub.requests).toHaveLength(0);
  });

  test("the caller's bound and a full Streams folder are both said", async () => {
    const { stub, client, memo } = surface();
    stub.answer(
      STREAMS("v"),
      jsonOk(
        page(
          9_000,
          Array.from({ length: 500 }, (_, i) => row(`s${i}`, "stream")),
        ),
      ),
    );
    const batch = await describeKindBatch(client, CAPABILITIES, memo, ["v"], "stream", 10);
    expect(batch.details).toHaveLength(10);
    expect(batch.truncated).toEqual({
      limit: 10,
      reason: `${callerBoundTruncationReason(10)}, and one page of 9,000 queues and streams sorted by type, which holds the 500 streams that sort last by name`,
    });
  });

  test("the memo serves one virtual host once: another virtual host reads its own page", async () => {
    const memo = createStreamListingMemo();
    memo.put("a", { streams: [], count: { count: 0 }, filteredCount: 0 });
    expect(memo.take("b")).toBeUndefined();
    expect(memo.take("a")).toBeUndefined();
  });
});
