/**
 * A recording management API for the RabbitMQ provider: what the provider takes as its management transport factory
 * in place of the shared `createNodeTransport`, so a test sees every request the provider would have sent and answers
 * it from memory, with no socket and no `mock.module()`.
 *
 * A request is keyed "GET <path>?<query>": the path as sent, the Path prefix included and its percent-encoding kept,
 * and the query's pairs decoded and sorted, joined by "&", so a key reads as the route it names. A key with no answer
 * fails the request with a stub error the test can see in `unanswered`, never with an answer the provider could read
 * as the broker's.
 */
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";

export interface StubAnswer {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

export interface RecordedRequest {
  readonly method: string;
  /** As sent, prefix included, percent-encoding kept. */
  readonly path: string;
  /** Pairs decoded and sorted, joined by "&"; "" when the request has no query. */
  readonly query: string;
}

export interface ManagementStub {
  readonly factory: ManagementTransportFactory;
  readonly requests: readonly RecordedRequest[];
  /** Every transport the provider built, in order. */
  readonly built: readonly NodeTransportOptions[];
  /** The keys asked for that had no answer. */
  readonly unanswered: readonly string[];
  /** How many times a built transport was closed. */
  closed(): number;
  /** The request keys in the order they were sent. */
  keys(): string[];
  /** Key "GET <path>?<sorted query>", or "GET <path>" without a query; a function answer may wait on its signal. */
  answer(key: string, answer: StubAnswer | ((request: NodeRequest) => Promise<StubAnswer>)): void;
}

/** A 200 JSON answer. */
export function jsonOk(body: unknown, status = 200): StubAnswer {
  return { status, body: JSON.stringify(body), contentType: "application/json" };
}

/** The key of one request: method, path as sent and the decoded, sorted query. */
export function requestKey(request: Pick<NodeRequest, "method" | "url">): string {
  const url = new URL(request.url);
  const pairs = [...url.searchParams].map(([k, v]) => `${k}=${v}`).sort();
  return pairs.length === 0
    ? `${request.method} ${url.pathname}`
    : `${request.method} ${url.pathname}?${pairs.join("&")}`;
}

/**
 * An answer that never comes: it waits for the request's signal, then fails as the shared transport does, "timeout"
 * for an AbortSignal.timeout() reason and "aborted" for any other, so a test drives a deadline or a cancel.
 */
export function hangUntilAbort(
  onStart?: (request: NodeRequest) => void,
): (request: NodeRequest) => Promise<StubAnswer> {
  return (request) =>
    new Promise<StubAnswer>((_resolve, reject) => {
      onStart?.(request);
      const fail = () => {
        const reason: unknown = request.signal.reason;
        const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
        reject(new TransportError(timedOut ? "timeout" : "aborted", "The request was stopped"));
      };
      if (request.signal.aborted) fail();
      else request.signal.addEventListener("abort", fail, { once: true });
    });
}

export function createManagementStub(answers: Readonly<Record<string, StubAnswer>> = {}): ManagementStub {
  const table = new Map<string, StubAnswer | ((request: NodeRequest) => Promise<StubAnswer>)>(Object.entries(answers));
  const requests: RecordedRequest[] = [];
  const built: NodeTransportOptions[] = [];
  const unanswered: string[] = [];
  let closed = 0;

  const factory: ManagementTransportFactory = (options): NodeTransport => {
    built.push(options);
    return {
      async request(request): Promise<NodeResponse> {
        const key = requestKey(request);
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          query: key.includes("?") ? key.slice(key.indexOf("?") + 1) : "",
        });
        const entry = table.get(key);
        if (entry === undefined) {
          unanswered.push(key);
          throw new Error(`management stub: no answer for ${key}`);
        }
        const answer = typeof entry === "function" ? await entry(request) : entry;
        // The shared transport stops reading past the cap and fails the request; the stub does the same.
        if (Buffer.byteLength(answer.body) > request.maxResponseBytes)
          throw new TransportError("too-large", "The response exceeded the limit for one response");
        return {
          status: answer.status,
          contentType: answer.contentType ?? "application/json",
          retryAfter: null,
          text: answer.body,
        };
      },
      close() {
        closed += 1;
      },
    };
  };

  return {
    factory,
    requests,
    built,
    unanswered,
    closed: () => closed,
    keys: () => requests.map((r) => (r.query === "" ? `${r.method} ${r.path}` : `${r.method} ${r.path}?${r.query}`)),
    answer(key, answer) {
      table.set(key, answer);
    },
  };
}

/** Deadline signals a test fires by hand, each aborting with the reason AbortSignal.timeout() gives. */
export interface ManualDeadlines {
  readonly factory: (ms: number) => AbortSignal;
  /** The milliseconds each signal was asked for, in order. */
  readonly asked: readonly number[];
  /** Fires the deadline at `index`, or every one not yet fired. */
  fire(index?: number): void;
}

export function manualDeadlines(): ManualDeadlines {
  const asked: number[] = [];
  const controllers: AbortController[] = [];
  const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
  return {
    factory(ms) {
      asked.push(ms);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
    asked,
    fire(index) {
      if (index !== undefined) controllers[index].abort(timeout());
      else for (const controller of controllers) if (!controller.signal.aborted) controller.abort(timeout());
    },
  };
}

/** A node name the samples carry, so a test can assert it never reaches a machine surface. */
export const SAMPLE_NODE = "rabbit@node-marker-1";

/** One answer per JSON route, shaped as RabbitMQ 4.3.6 answers it (node names replaced). */
export const SAMPLE_BODIES = {
  whoami: { name: "studio-reader", tags: ["management"], is_internal_user: true },
  "overview-version": { product_name: "RabbitMQ", rabbitmq_version: "4.3.6" },
  "overview-full": { management_version: "4.3.6", product_name: "RabbitMQ", rabbitmq_version: "4.3.6" },
  vhosts: [
    {
      name: "/",
      description: "Default virtual host",
      tags: [],
      cluster_state: { [SAMPLE_NODE]: "running" },
      messages: 3,
    },
    { name: "billing", description: "", tags: [], cluster_state: { [SAMPLE_NODE]: "running" } },
  ],
  "queues-page": {
    filtered_count: 3,
    item_count: 3,
    page: 1,
    page_count: 1,
    page_size: 500,
    total_count: 3,
    items: [
      { name: "orders", type: "classic", state: "running", messages: 3, messages_ready: 3, messages_unacknowledged: 0 },
      {
        name: "payments",
        type: "quorum",
        state: "running",
        messages: 2,
        messages_ready: 2,
        messages_unacknowledged: 0,
      },
      { name: "st-orders", type: "stream", state: "running" },
    ],
  },
  "streams-page": {
    filtered_count: 3,
    item_count: 3,
    page: 1,
    page_count: 1,
    page_size: 500,
    total_count: 3,
    items: [
      { name: "st-orders", type: "stream", state: "running" },
      { name: "payments", type: "quorum", state: "running" },
      { name: "orders", type: "classic", state: "running" },
    ],
  },
  "exchanges-page": {
    filtered_count: 2,
    item_count: 2,
    page: 1,
    page_count: 1,
    page_size: 500,
    total_count: 2,
    items: [
      { name: "", type: "direct", durable: true, auto_delete: false, internal: false },
      { name: "ex-topic", type: "topic", durable: true, auto_delete: false, internal: false },
    ],
  },
  queue: {
    arguments: { "x-queue-type": "quorum", "x-dead-letter-exchange": "dlx" },
    auto_delete: false,
    consumer_details: [
      {
        ack_required: true,
        active: true,
        activity_status: "up",
        channel_details: {
          connection_name: "10.0.0.9:51234 -> 10.0.0.1:5672",
          peer_host: "10.0.0.9",
          user: "other-user",
        },
        consumer_tag: "ctag-marker",
        consumer_timeout: 1800000,
        exclusive: false,
        prefetch_count: 10,
        arguments: { "x-marker": "consumer-argument-marker" },
      },
    ],
    consumers: 1,
    deliveries: [{ stats: 1 }],
    delivery_limit: 20,
    durable: true,
    effective_policy_definition: { "max-length": 10000 },
    exclusive: false,
    exclusive_consumer_tag: null,
    incoming: [{ stats: 1 }],
    leader: SAMPLE_NODE,
    members: [SAMPLE_NODE],
    messages: 3,
    messages_ready: 3,
    messages_unacknowledged: 0,
    name: "payments",
    node: SAMPLE_NODE,
    online: [SAMPLE_NODE],
    open_files: { [SAMPLE_NODE]: 0 },
    operator_policy: null,
    owner_pid_details: { name: "owner-marker" },
    policy: "pol-maxlen",
    single_active_consumer_tag: null,
    state: "running",
    type: "quorum",
    user_who_performed_action: "admin-marker",
    vhost: "/",
  },
  "stream-type": { members: [SAMPLE_NODE], online: [SAMPLE_NODE], type: "stream" },
  exchange: {
    arguments: { "alternate-exchange": "ex-fanout" },
    auto_delete: false,
    durable: true,
    incoming: [],
    internal: false,
    name: "ex-topic",
    outgoing: [],
    policy: null,
    type: "topic",
    user_who_performed_action: "admin-marker",
    vhost: "/",
  },
  "queue-bindings": [
    {
      source: "",
      vhost: "/",
      destination: "orders",
      destination_type: "queue",
      routing_key: "orders",
      arguments: {},
      properties_key: "orders",
    },
    {
      source: "ex-direct",
      vhost: "/",
      destination: "orders",
      destination_type: "queue",
      routing_key: "o",
      arguments: {},
      properties_key: "o",
    },
  ],
  "exchange-bindings-source": [
    {
      source: "st-invoices",
      vhost: "/",
      destination: "st-invoices-1",
      destination_type: "queue",
      routing_key: "1",
      arguments: { "x-stream-partition-order": 1 },
      properties_key: "1~x",
    },
    {
      source: "st-invoices",
      vhost: "/",
      destination: "st-invoices-0",
      destination_type: "queue",
      routing_key: "0",
      arguments: { "x-stream-partition-order": 0 },
      properties_key: "0~x",
    },
  ],
  "exchange-bindings-destination": [
    {
      source: "ex-topic",
      vhost: "/",
      destination: "ex-fanout",
      destination_type: "exchange",
      routing_key: "#",
      arguments: {},
      properties_key: "%23",
    },
  ],
  policies: [
    {
      vhost: "/",
      name: "pol-maxlen",
      pattern: "^q-",
      "apply-to": "queues",
      definition: { "max-length": 10000 },
      priority: 1,
    },
  ],
  "operator-policies": [],
  alarms: { status: "ok" },
  extensions: [{ javascript: "dispatcher.js" }, [], { javascript: ["stream_management-ejs.js", "stream.js"] }],
} as const;

/** One virtual host's objects as the listing pages show them. */
export interface StubVhost {
  readonly streams?: readonly string[];
  /** Name and type, classic or quorum. */
  readonly queues?: readonly (readonly [string, "classic" | "quorum"])[];
  readonly exchanges?: readonly string[];
}

export interface StubBroker {
  readonly version?: string;
  readonly vhosts: Readonly<Record<string, StubVhost>>;
  /** The plugin list names stream.js; true when absent. */
  readonly streamManagement?: boolean;
}

/** The path segment the client sends for a name: RFC 3986 unreserved characters kept, everything else %XX. */
export function segment(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Answers every route a browse makes on a broker of these virtual hosts: whoami, the version, the overview, the
 * alarms, the plugin list, the virtual host listing and each virtual host's three pages. Streams page rows come in
 * the broker's order for sort=type reversed: streams by descending name, then quorum, then classic.
 */
export function answerBroker(stub: ManagementStub, broker: StubBroker, prefix = ""): void {
  const version = broker.version ?? "4.3.6";
  stub.answer(`GET ${prefix}/api/whoami`, jsonOk(SAMPLE_BODIES.whoami));
  stub.answer(
    `GET ${prefix}/api/overview?columns=rabbitmq_version,product_name`,
    jsonOk({ rabbitmq_version: version }),
  );
  stub.answer(
    `GET ${prefix}/api/overview?columns=rabbitmq_version,product_name,management_version`,
    jsonOk({ rabbitmq_version: version, management_version: version }),
  );
  stub.answer(`GET ${prefix}/api/health/checks/alarms`, jsonOk({ status: "ok" }));
  stub.answer(
    `GET ${prefix}/api/extensions`,
    jsonOk(broker.streamManagement === false ? [{ javascript: "dispatcher.js" }] : SAMPLE_BODIES.extensions),
  );
  stub.answer(
    `GET ${prefix}/api/vhosts`,
    jsonOk(Object.keys(broker.vhosts).map((name) => ({ name, cluster_state: { [SAMPLE_NODE]: "running" } }))),
  );
  const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const [vhost, objects] of Object.entries(broker.vhosts)) {
    const v = segment(vhost);
    const streams = [...(objects.streams ?? [])].sort(byteOrder);
    const queues = [...(objects.queues ?? [])].sort((a, b) => byteOrder(a[0], b[0]));
    const all = [
      ...streams.map((name) => ({ name, type: "stream", state: "running" })),
      ...queues.map(([name, type]) => ({ name, type, state: "running" })),
    ];
    const byName = [...all].sort((a, b) => byteOrder(a.name, b.name));
    const typeRank = (type: string) => (type === "stream" ? 0 : type === "quorum" ? 1 : 2);
    const byTypeReversed = [...all].sort((a, b) => typeRank(a.type) - typeRank(b.type) || byteOrder(b.name, a.name));
    stub.answer(
      `GET ${prefix}/api/queues/${v}?columns=name,type,state,messages,messages_ready,messages_unacknowledged&disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name`,
      jsonOk({ filtered_count: all.length, items: byName.slice(0, 500) }),
    );
    stub.answer(
      `GET ${prefix}/api/queues/${v}?columns=name,type,state&disable_stats=true&page=1&page_size=500&sort=type&sort_reverse=true`,
      jsonOk({ filtered_count: all.length, items: byTypeReversed.slice(0, 500) }),
    );
    // Not readable by default: a test that wants the Access caution answers 503 for its queue.
    for (const [name] of queues)
      stub.answer(`GET ${prefix}/api/stream/${v}/${segment(name)}/tracking`, { status: 401, body: "{}" });
    const exchanges = ["", ...(objects.exchanges ?? [])].sort(byteOrder);
    stub.answer(
      `GET ${prefix}/api/exchanges/${v}?columns=name,type,durable,auto_delete,internal&page=1&page_size=500&sort=name`,
      jsonOk({
        filtered_count: exchanges.length,
        items: exchanges
          .slice(0, 500)
          .map((name) => ({ name, type: "direct", durable: true, auto_delete: false, internal: false })),
      }),
    );
  }
}
