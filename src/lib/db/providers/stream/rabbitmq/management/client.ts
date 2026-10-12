/**
 * The GET-only management API client on the shared node transport: one transport per provider instance, every
 * request built by `routes.ts`, one permit of the route's limiter per GET, a deadline on every GET, the route's byte
 * cap, then the JSON parse, the depth check and the route's typed decoder. Every failure leaves as an error built by
 * `errors.ts`; nothing the broker wrote is quoted.
 *
 * The deadline: with a caller's `signal` (a stream read's run signal) the client uses that signal alone and an abort
 * rejects with its reason as given, for the read to classify; without one it builds the per-GET deadline,
 * `min(queryTimeout, 15 s)`, from the injected factory, joined with the provider's lifetime and with `within` when
 * Test Connection's check passes one. The deadline covers the wait for a permit, so one slow broker cannot hold the
 * process's permits past it.
 *
 * The decoders keep only the fields Studio shows and refuse an answer whose fields have the wrong type, whose counts
 * are not non-negative whole numbers, or whose names are longer than 255 UTF-8 bytes. A bindings answer keeps at most
 * 1,000 rows and 1 MiB of projected rows and counts the rest, so a held detail never carries the whole answer.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import {
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
} from "@/lib/db/utils/bounded-limiter";
import type { ManagementEndpoint } from "../connection-options";
import {
  cancelledError,
  type ErrorSite,
  isOwnError,
  MANAGEMENT_SLOTS_FULL,
  type ManagementFailureContext,
  managementNotJson,
  managementStatusError,
  managementTimeout,
  managementTooDeep,
  managementTooLarge,
  managementTransportError,
  managementWrongShape,
  PROVIDER_CLOSED,
  queryError,
  rabbitmqBoundary,
  tlsClientCertificateRefused,
  transportCode,
} from "../errors";
import {
  type DeadlineSignalFactory,
  RABBITMQ_BINDINGS_KEPT_BYTES,
  RABBITMQ_BINDINGS_LIMITER_KEY,
  RABBITMQ_BINDINGS_LIMITS,
  RABBITMQ_BINDINGS_MAX_ROWS,
  RABBITMQ_MANAGEMENT_LIMITER_KEY,
  RABBITMQ_MANAGEMENT_LIMITS,
  RABBITMQ_MGMT_REQUEST_DEADLINE_MS,
  RABBITMQ_NAME_MAX_BYTES,
} from "../limits";
import { nestsTooDeep } from "./depth";
import {
  MANAGEMENT_ROUTES,
  type ManagementRoute,
  type ManagementRouteId,
  type RouteParts,
  routeTarget,
} from "./routes";

/** How the client gets its transport; a test hands in a recording one. */
export type ManagementTransportFactory = (options: NodeTransportOptions) => NodeTransport;

export const rabbitmqManagementLimiter: () => ProviderLimiter = engineLimiter(
  RABBITMQ_MANAGEMENT_LIMITER_KEY,
  RABBITMQ_MANAGEMENT_LIMITS,
);
export const rabbitmqBindingsLimiter: () => ProviderLimiter = engineLimiter(
  RABBITMQ_BINDINGS_LIMITER_KEY,
  RABBITMQ_BINDINGS_LIMITS,
);

export interface GetOptions {
  /** Used alone when present (a read's run signal): no per-GET deadline is built. */
  readonly signal?: AbortSignal;
  /** Joined with the per-GET deadline (Test Connection's check deadline). */
  readonly within?: AbortSignal;
  /** Which surface asked, for the failure sentences; "browse" when absent. */
  readonly site?: ErrorSite;
}

// ============================================================================
// Decoded answers
// ============================================================================

export interface VersionAnswer {
  /** As the broker sent it; connect() checks its shape before it is compared or shown. */
  readonly version: string;
}
export interface OverviewAnswer extends VersionAnswer {
  readonly managementVersion: string | null;
}
export interface VhostRow {
  readonly name: string;
}
export interface QueuePageRow {
  readonly name: string;
  readonly type: string;
  readonly state: string | null;
  readonly messages: number | null;
  readonly messagesReady: number | null;
  readonly messagesUnacknowledged: number | null;
}
export interface StreamPageRow {
  readonly name: string;
  readonly type: string;
  readonly state: string | null;
}
export interface ExchangePageRow {
  readonly name: string;
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly internal: boolean;
}
export interface PageAnswer<Row> {
  /** Every row the virtual host holds of what the route lists, not only this page's. */
  readonly filteredCount: number;
  readonly items: readonly Row[];
}
export interface ConsumerRow {
  readonly exclusive: boolean | null;
  readonly ackRequired: boolean | null;
  readonly prefetchCount: number | null;
  readonly active: boolean | null;
  readonly activityStatus: string | null;
  readonly consumerTimeout: number | null;
}
export interface QueueDetail {
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly exclusive: boolean;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly policy: string | null;
  readonly operatorPolicy: string | null;
  readonly effectivePolicyDefinition: Readonly<Record<string, unknown>>;
  readonly deliveryLimit: number | null;
  readonly state: string | null;
  readonly messages: number | null;
  readonly messagesReady: number | null;
  readonly messagesUnacknowledged: number | null;
  readonly consumers: number | null;
  readonly consumerDetails: readonly ConsumerRow[];
  /** Node names: shown in the detail part only, never to a model. */
  readonly node: string | null;
  readonly leader: string | null;
  readonly members: readonly string[];
  readonly online: readonly string[];
}
export interface StreamTypeAnswer {
  readonly type: string;
  readonly online: readonly string[];
  readonly members: readonly string[];
}
export interface ExchangeDetail {
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly internal: boolean;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly policy: string | null;
}
export interface BindingRow {
  readonly source: string;
  readonly destination: string;
  readonly destinationType: string;
  readonly routingKey: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface BindingsAnswer {
  readonly rows: readonly BindingRow[];
  /** Every row the broker answered, kept or not. */
  readonly total: number;
}
export interface PolicyRow {
  readonly name: string;
  readonly pattern: string;
  readonly applyTo: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly priority: number;
}
export interface AlarmsAnswer {
  readonly active: boolean;
}
export interface ExtensionsAnswer {
  /** Whether the broker's UI extensions list stream.js, which the rabbitmq_stream_management plugin adds. */
  readonly streamManagement: boolean;
}

/** Decoded answer per JSON route. */
export interface RouteAnswers {
  whoami: Record<string, never>;
  "overview-version": VersionAnswer;
  "overview-full": OverviewAnswer;
  vhosts: readonly VhostRow[];
  "queues-page": PageAnswer<QueuePageRow>;
  "streams-page": PageAnswer<StreamPageRow>;
  "exchanges-page": PageAnswer<ExchangePageRow>;
  queue: QueueDetail;
  "stream-type": StreamTypeAnswer;
  exchange: ExchangeDetail;
  "queue-bindings": BindingsAnswer;
  "exchange-bindings-source": BindingsAnswer;
  "exchange-bindings-destination": BindingsAnswer;
  policies: readonly PolicyRow[];
  "operator-policies": readonly PolicyRow[];
  alarms: AlarmsAnswer;
  extensions: ExtensionsAnswer;
}

type JsonRouteId = Exclude<ManagementRouteId, "stream-tracking">;

// ============================================================================
// Field readers: each throws WrongShape, which the client turns into the shape sentence
// ============================================================================

class WrongShape extends Error {}
const wrong = (): never => {
  throw new WrongShape();
};

type Json = Readonly<Record<string, unknown>>;

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : wrong();
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : wrong();
}
function text(value: unknown): string {
  return typeof value === "string" && Buffer.byteLength(value) <= RABBITMQ_NAME_MAX_BYTES ? value : wrong();
}
function optionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value);
}
function flag(value: unknown): boolean {
  return typeof value === "boolean" ? value : wrong();
}
function optionalFlag(value: unknown): boolean | null {
  return value === undefined || value === null ? null : flag(value);
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : wrong();
}
function optionalCount(value: unknown): number | null {
  return value === undefined ? null : count(value);
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : wrong();
}
function optionalObject(value: unknown): Json {
  return value === undefined || value === null ? {} : object(value);
}
function names(value: unknown): readonly string[] {
  return value === undefined ? [] : array(value).map(text);
}
/** A long string the broker may send, such as a version: bounded by the route's byte cap, not by the name rule. */
function longText(value: unknown): string {
  return typeof value === "string" ? value : wrong();
}

function page<Row>(value: unknown, row: (item: Json) => Row): PageAnswer<Row> {
  const body = object(value);
  return { filteredCount: count(body.filtered_count), items: array(body.items).map((item) => row(object(item))) };
}

function bindings(value: unknown): BindingsAnswer {
  const all = array(value);
  const rows: BindingRow[] = [];
  let kept = 0;
  for (const item of all) {
    if (rows.length >= RABBITMQ_BINDINGS_MAX_ROWS) break;
    const raw = object(item);
    const row: BindingRow = {
      source: text(raw.source),
      destination: text(raw.destination),
      destinationType: text(raw.destination_type),
      routingKey: text(raw.routing_key),
      arguments: optionalObject(raw.arguments),
    };
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (kept + bytes > RABBITMQ_BINDINGS_KEPT_BYTES) break;
    kept += bytes;
    rows.push(row);
  }
  return { rows, total: all.length };
}

function policies(value: unknown): readonly PolicyRow[] {
  return array(value).map((item) => {
    const raw = object(item);
    return {
      name: text(raw.name),
      pattern: longText(raw.pattern),
      applyTo: text(raw["apply-to"]),
      definition: object(raw.definition),
      priority: integer(raw.priority),
    };
  });
}

const DECODERS: { readonly [R in JsonRouteId]: (value: unknown) => RouteAnswers[R] } = {
  // The user's name is shape-checked and dropped: Studio never lists or quotes it, so no 255-byte rule applies.
  whoami: (value) => {
    longText(object(value).name);
    return {};
  },
  "overview-version": (value) => ({ version: longText(object(value).rabbitmq_version) }),
  "overview-full": (value) => {
    const body = object(value);
    const management = body.management_version;
    return {
      version: longText(body.rabbitmq_version),
      managementVersion: management === undefined ? null : longText(management),
    };
  },
  // The answer carries cluster_state, keyed by node name, whatever columns asks: only the name is kept.
  vhosts: (value) => array(value).map((item) => ({ name: text(object(item).name) })),
  "queues-page": (value) =>
    page(value, (item) => ({
      name: text(item.name),
      type: text(item.type),
      state: optionalText(item.state),
      messages: optionalCount(item.messages),
      messagesReady: optionalCount(item.messages_ready),
      messagesUnacknowledged: optionalCount(item.messages_unacknowledged),
    })),
  "streams-page": (value) =>
    page(value, (item) => ({ name: text(item.name), type: text(item.type), state: optionalText(item.state) })),
  "exchanges-page": (value) =>
    page(value, (item) => ({
      name: text(item.name),
      type: text(item.type),
      durable: flag(item.durable),
      autoDelete: flag(item.auto_delete),
      internal: flag(item.internal),
    })),
  queue: (value) => {
    const body = object(value);
    const deliveryLimit = body.delivery_limit;
    return {
      type: text(body.type),
      durable: flag(body.durable),
      autoDelete: flag(body.auto_delete),
      exclusive: flag(body.exclusive),
      arguments: optionalObject(body.arguments),
      policy: optionalText(body.policy),
      operatorPolicy: optionalText(body.operator_policy),
      effectivePolicyDefinition: optionalObject(body.effective_policy_definition),
      deliveryLimit: deliveryLimit === undefined || deliveryLimit === null ? null : integer(deliveryLimit),
      state: optionalText(body.state),
      messages: optionalCount(body.messages),
      messagesReady: optionalCount(body.messages_ready),
      messagesUnacknowledged: optionalCount(body.messages_unacknowledged),
      consumers: optionalCount(body.consumers),
      // Only these six of each consumer: its channel, tag, arguments and peer stay with the broker.
      consumerDetails: (body.consumer_details === undefined ? [] : array(body.consumer_details)).map((item) => {
        const raw = object(item);
        const timeout = raw.consumer_timeout;
        return {
          exclusive: optionalFlag(raw.exclusive),
          ackRequired: optionalFlag(raw.ack_required),
          prefetchCount: optionalCount(raw.prefetch_count),
          active: optionalFlag(raw.active),
          activityStatus: optionalText(raw.activity_status),
          consumerTimeout: timeout === undefined || timeout === null ? null : integer(timeout),
        };
      }),
      node: optionalText(body.node),
      leader: optionalText(body.leader),
      members: names(body.members),
      online: names(body.online),
    };
  },
  "stream-type": (value) => {
    const body = object(value);
    return { type: text(body.type), online: names(body.online), members: names(body.members) };
  },
  exchange: (value) => {
    const body = object(value);
    return {
      type: text(body.type),
      durable: flag(body.durable),
      autoDelete: flag(body.auto_delete),
      internal: flag(body.internal),
      arguments: optionalObject(body.arguments),
      policy: optionalText(body.policy),
    };
  },
  "queue-bindings": bindings,
  "exchange-bindings-source": bindings,
  "exchange-bindings-destination": bindings,
  policies,
  "operator-policies": policies,
  // 200 {"status":"ok"} or 503 {"status":"failed", "alarms": [...]}; the alarms name nodes and are not kept.
  alarms: (value) => {
    const status = text(object(value).status);
    return status === "ok" ? { active: false } : status === "failed" ? { active: true } : wrong();
  },
  extensions: (value) => {
    let streamManagement = false;
    for (const entry of array(value)) {
      if (Array.isArray(entry)) continue;
      const script = object(entry).javascript;
      const scripts = script === undefined ? [] : typeof script === "string" ? [script] : array(script).map(text);
      if (scripts.includes("stream.js")) streamManagement = true;
    }
    return { streamManagement };
  },
};

/** The table's own entry for an id; an id outside it, a prototype key included, is refused before any request. */
function routeOf(id: ManagementRouteId): ManagementRoute {
  if (!Object.hasOwn(MANAGEMENT_ROUTES, id)) throw new Error(`No management route ${JSON.stringify(id)}`);
  return MANAGEMENT_ROUTES[id];
}

/** The statuses whose body is the answer; any other is mapped by its status. */
const ANSWER_STATUSES: Partial<Record<JsonRouteId, readonly number[]>> = { alarms: [200, 503] };

// ============================================================================
// The client
// ============================================================================

export interface ManagementClient {
  get<R extends JsonRouteId>(id: R, parts: RouteParts, options?: GetOptions): Promise<RouteAnswers[R]>;
  /** Status only, body discarded under the route's cap; refuses every route but "stream-tracking". */
  status(id: "stream-tracking", parts: RouteParts, options?: GetOptions): Promise<number>;
  close(): void;
}

export interface ManagementClientOptions {
  readonly endpoint: ManagementEndpoint;
  readonly transport: ManagementTransportFactory;
  readonly deadlineSignal: DeadlineSignalFactory;
  readonly queryTimeoutMs: number;
  readonly lifetime: AbortSignal;
  readonly limiters: { readonly management: ProviderLimiter; readonly bindings: ProviderLimiter };
}

/**
 * A reset before any answer to whoami, the first GET of a connection, over TLS: how Bun reports a broker refusing
 * Studio's client certificate after a TLS 1.3 handshake, and Node one from another CA (measured on
 * Bun 1.4.2, Node 24.14.0 and Node 26.10.0). A TLS failure the transport names by its code is mapped by
 * `managementTransportError`. A GET to RabbitMQ's AMQPS listener answers HPE_INVALID_CONSTANT, not a reset (measured
 * on 4.3.6 and 4.2.9), so a wrong port keeps its own sentence.
 */
function resetBeforeWhoamiAnswer(error: TransportError, context: ManagementFailureContext): boolean {
  return (
    context.scope === "whoami" && error.kind === "network" && !error.truncated && transportCode(error) === "ECONNRESET"
  );
}

export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  const { endpoint, lifetime, limiters } = options;
  const credential = Buffer.from(`${endpoint.username}:${endpoint.password}`, "utf8").toString("base64");
  const transport = options.transport({
    origin: endpoint.origin,
    tls: endpoint.tls,
    maxSockets: RABBITMQ_MANAGEMENT_LIMITS.perProvider + RABBITMQ_BINDINGS_LIMITS.perProvider,
    headers: { authorization: `Basic ${credential}` },
    requestHeaderNames: ["accept"],
    refusesLinkLocal: true,
    refusesUpgrade: true,
    reportsUnreachable: true,
  });
  const deadlineMs = Math.min(options.queryTimeoutMs, RABBITMQ_MGMT_REQUEST_DEADLINE_MS);
  let closed = false;

  const contextOf = (id: ManagementRouteId, parts: RouteParts, call: GetOptions): ManagementFailureContext => ({
    endpoint: endpoint.display,
    route: routeOf(id).label,
    scope: routeOf(id).scope,
    site: call.site ?? "browse",
    ...(parts.vhost === undefined ? {} : { vhost: parts.vhost }),
    ...(parts.name === undefined ? {} : { name: parts.name }),
  });

  const closedError = () =>
    isOwnError(lifetime.reason) ? (lifetime.reason as Error) : cancelledError(PROVIDER_CLOSED);

  /** One GET through the route table, its permit and its deadline: the response, or an error from errors.ts. */
  async function send(id: ManagementRouteId, parts: RouteParts, call: GetOptions = {}): Promise<NodeResponse> {
    const route = routeOf(id);
    const context = contextOf(id, parts, call);
    if (closed || lifetime.aborted) throw closedError();
    // Refused before any permit or socket: a dot segment, an empty name.
    const target = routeTarget(id, parts, endpoint.pathPrefix);
    let deadline: AbortSignal | undefined;
    let signal: AbortSignal;
    if (call.signal === undefined) {
      deadline = options.deadlineSignal(deadlineMs);
      signal = AbortSignal.any([deadline, lifetime, ...(call.within === undefined ? [] : [call.within])]);
    } else {
      signal = call.signal;
    }

    const failure = (error: unknown): Error => {
      if (lifetime.aborted) return closedError();
      if (call.signal?.aborted === true) return call.signal.reason as Error;
      if (deadline?.aborted === true || call.within?.aborted === true)
        return managementTimeout(context, deadlineMs / 1000);
      if (error instanceof LimiterFullError) return queryError(MANAGEMENT_SLOTS_FULL);
      if (error instanceof TransportError) {
        if (error.kind === "too-large") return managementTooLarge(context, route.maxResponseBytes);
        if (endpoint.tls !== null && resetBeforeWhoamiAnswer(error, context)) {
          return tlsClientCertificateRefused(endpoint.display);
        }
        return managementTransportError(error, context);
      }
      // The egress guard's refusal from the transport, already worded and naming no address, passes as it is.
      if (error instanceof DatabaseConfigError) return error;
      return rabbitmqBoundary(error, { site: context.site, endpoint: context.endpoint, route: context.route });
    };

    let ticket: LimiterTicket;
    try {
      ticket = await (route.limiter === "bindings" ? limiters.bindings : limiters.management).acquire(signal);
    } catch (error) {
      throw failure(error);
    }
    try {
      return await transport.request({
        method: "GET",
        url: endpointUrl(endpoint.origin, target.pathname, target.params),
        headers: { accept: "application/json" },
        signal,
        maxResponseBytes: route.maxResponseBytes,
      });
    } catch (error) {
      throw failure(error);
    } finally {
      ticket.release();
    }
  }

  return {
    async get<R extends JsonRouteId>(id: R, parts: RouteParts, call: GetOptions = {}): Promise<RouteAnswers[R]> {
      if (routeOf(id).statusOnly) throw new Error(`The management route ${id} is read for its status only`);
      const response = await send(id, parts, call);
      const context = contextOf(id, parts, call);
      if (!(ANSWER_STATUSES[id] ?? [200]).includes(response.status))
        throw managementStatusError(response.status, response.text, context);
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        throw managementNotJson(context);
      }
      if (nestsTooDeep(body)) throw managementTooDeep(context);
      try {
        return (DECODERS[id] as (value: unknown) => RouteAnswers[R])(body);
      } catch (error) {
        if (error instanceof WrongShape) throw managementWrongShape(context);
        throw error;
      }
    },
    async status(id, parts, call = {}) {
      if (!routeOf(id).statusOnly) throw new Error(`The management route ${id} is not read for its status`);
      return (await send(id, parts, call)).status;
    },
    close() {
      closed = true;
      transport.close();
    },
  };
}
