/**
 * The closed table of management API routes Studio calls: every request the provider sends is one of these, built
 * here from typed parts, so a path outside the table, an administrator endpoint among them, cannot be addressed.
 *
 * Every route is a GET. Each carries a fixed label for the error sentences (never a URL or a name), the scope its
 * failure sentences read, a byte cap, the one limiter it takes, and whether it is read for its status alone.
 *
 * Names are percent-encoded once per segment with the RFC 3986 unreserved alphabet, so `/` is `%2F` and a literal
 * `%` is `%25`. A segment equal to `.` or `..` is refused, because URL resolution removes dot segments and encoding
 * leaves `.` as it is; an empty name is refused, except the default exchange `""`, which the management API
 * addresses as `amq.default` in the exchange detail and its two bindings routes.
 *
 * Each listing route fixes its `sort`: with `enable_queue_totals=true` the broker answers HTTP 500 for any sort but
 * `name` on a virtual host holding a quorum queue, so only the Queues page asks for the totals and it sorts by name.
 * No listing asks for `arguments`, which a queue's declarer controls and which can reach megabytes per queue.
 */
import { rfc3986Encode } from "@/lib/db/http/endpoint";
import { dotSegmentRefusal, emptyNameRefusal, type ManagementFailureContext } from "../errors";
import {
  RABBITMQ_ANSWER_BYTES,
  RABBITMQ_BINDINGS_ANSWER_BYTES,
  RABBITMQ_LISTING_PAGE_SIZE,
  RABBITMQ_SMALL_ANSWER_BYTES,
} from "../limits";

export type ManagementRouteId =
  | "whoami"
  | "overview-version"
  | "overview-full"
  | "vhosts"
  | "queues-page"
  | "streams-page"
  | "exchanges-page"
  | "queue"
  | "stream-type"
  | "exchange"
  | "queue-bindings"
  | "exchange-bindings-source"
  | "exchange-bindings-destination"
  | "policies"
  | "operator-policies"
  | "alarms"
  | "extensions"
  | "stream-tracking";

export interface RouteParts {
  readonly vhost?: string;
  readonly name?: string;
}

export interface ManagementRoute {
  readonly id: ManagementRouteId;
  /** The route's name in an error sentence, such as "the queue listing"; never a URL or a name. */
  readonly label: string;
  readonly scope: ManagementFailureContext["scope"];
  readonly maxResponseBytes: number;
  readonly limiter: "management" | "bindings";
  /** True for "stream-tracking" alone: its status is the answer, and its body is discarded. */
  readonly statusOnly: boolean;
}

/** A path segment: fixed text, the virtual host, or the object's name (an exchange name maps "" to amq.default). */
type Segment = string | { readonly part: "vhost" } | { readonly part: "name"; readonly exchange?: true };

interface RouteTemplate extends ManagementRoute {
  readonly segments: readonly Segment[];
  readonly query: readonly (readonly [key: string, value: string])[];
}

const VHOST = { part: "vhost" } as const;
const NAME = { part: "name" } as const;
const EXCHANGE_NAME = { part: "name", exchange: true } as const;
const PAGE = String(RABBITMQ_LISTING_PAGE_SIZE);

function route(
  id: ManagementRouteId,
  label: string,
  scope: ManagementRoute["scope"],
  maxResponseBytes: number,
  segments: readonly Segment[],
  query: RouteTemplate["query"] = [],
  extra: Partial<Pick<ManagementRoute, "limiter" | "statusOnly">> = {},
): RouteTemplate {
  return Object.freeze({
    id,
    label,
    scope,
    maxResponseBytes,
    limiter: extra.limiter ?? "management",
    statusOnly: extra.statusOnly ?? false,
    segments,
    query,
  });
}

const TEMPLATES: Readonly<Record<ManagementRouteId, RouteTemplate>> = Object.freeze({
  whoami: route("whoami", "the user check", "whoami", RABBITMQ_SMALL_ANSWER_BYTES, ["whoami"]),
  "overview-version": route(
    "overview-version",
    "the version check",
    "server",
    RABBITMQ_SMALL_ANSWER_BYTES,
    ["overview"],
    [["columns", "rabbitmq_version,product_name"]],
  ),
  // management_version, never cluster_name, which names the cluster to a reader of the overview.
  "overview-full": route(
    "overview-full",
    "the overview",
    "server",
    RABBITMQ_SMALL_ANSWER_BYTES,
    ["overview"],
    [["columns", "rabbitmq_version,product_name,management_version"]],
  ),
  vhosts: route("vhosts", "the virtual host listing", "server", RABBITMQ_ANSWER_BYTES, ["vhosts"]),
  "queues-page": route(
    "queues-page",
    "the queue listing",
    "vhost",
    RABBITMQ_ANSWER_BYTES,
    ["queues", VHOST],
    [
      ["disable_stats", "true"],
      ["enable_queue_totals", "true"],
      ["page", "1"],
      ["page_size", PAGE],
      ["sort", "name"],
      ["columns", "name,type,state,messages,messages_ready,messages_unacknowledged"],
    ],
  ),
  // Sorted by type, reversed: streams sort after classic and quorum, so they come first, in descending name order.
  "streams-page": route(
    "streams-page",
    "the stream listing",
    "vhost",
    RABBITMQ_ANSWER_BYTES,
    ["queues", VHOST],
    [
      ["disable_stats", "true"],
      ["page", "1"],
      ["page_size", PAGE],
      ["sort", "type"],
      ["sort_reverse", "true"],
      ["columns", "name,type,state"],
    ],
  ),
  "exchanges-page": route(
    "exchanges-page",
    "the exchange listing",
    "vhost",
    RABBITMQ_ANSWER_BYTES,
    ["exchanges", VHOST],
    [
      ["page", "1"],
      ["page_size", PAGE],
      ["sort", "name"],
      ["columns", "name,type,durable,auto_delete,internal"],
    ],
  ),
  queue: route("queue", "the queue details", "object", RABBITMQ_ANSWER_BYTES, ["queues", VHOST, NAME]),
  // Projected: a stream's arguments are its declarer's and can reach megabytes. Measured on 4.3.6 and 4.2.9, the
  // single-queue route applies columns with and without disable_stats, and still answers online and members.
  "stream-type": route(
    "stream-type",
    "the stream type check",
    "object",
    RABBITMQ_SMALL_ANSWER_BYTES,
    ["queues", VHOST, NAME],
    [
      ["columns", "type,online,members"],
      ["disable_stats", "true"],
    ],
  ),
  exchange: route("exchange", "the exchange details", "object", RABBITMQ_ANSWER_BYTES, [
    "exchanges",
    VHOST,
    EXCHANGE_NAME,
  ]),
  "queue-bindings": route(
    "queue-bindings",
    "the queue bindings",
    "object",
    RABBITMQ_BINDINGS_ANSWER_BYTES,
    ["queues", VHOST, NAME, "bindings"],
    [],
    { limiter: "bindings" },
  ),
  "exchange-bindings-source": route(
    "exchange-bindings-source",
    "the exchange bindings as source",
    "object",
    RABBITMQ_BINDINGS_ANSWER_BYTES,
    ["exchanges", VHOST, EXCHANGE_NAME, "bindings", "source"],
    [],
    { limiter: "bindings" },
  ),
  "exchange-bindings-destination": route(
    "exchange-bindings-destination",
    "the exchange bindings as destination",
    "object",
    RABBITMQ_BINDINGS_ANSWER_BYTES,
    ["exchanges", VHOST, EXCHANGE_NAME, "bindings", "destination"],
    [],
    { limiter: "bindings" },
  ),
  policies: route("policies", "the policies", "vhost", RABBITMQ_ANSWER_BYTES, ["policies", VHOST]),
  "operator-policies": route("operator-policies", "the operator policies", "vhost", RABBITMQ_ANSWER_BYTES, [
    "operator-policies",
    VHOST,
  ]),
  alarms: route("alarms", "the alarm check", "server", RABBITMQ_SMALL_ANSWER_BYTES, ["health", "checks", "alarms"]),
  extensions: route("extensions", "the plugin list", "server", RABBITMQ_SMALL_ANSWER_BYTES, ["extensions"]),
  "stream-tracking": route(
    "stream-tracking",
    "the stream tracking check",
    "object",
    RABBITMQ_SMALL_ANSWER_BYTES,
    ["stream", VHOST, NAME, "tracking"],
    [],
    { statusOnly: true },
  ),
});

/** The table as callers read it: no template, so no caller can build a path but through routeTarget. */
export const MANAGEMENT_ROUTES: Readonly<Record<ManagementRouteId, ManagementRoute>> = Object.freeze(
  Object.fromEntries(
    Object.values(TEMPLATES).map((template) => [
      template.id,
      Object.freeze({
        id: template.id,
        label: template.label,
        scope: template.scope,
        maxResponseBytes: template.maxResponseBytes,
        limiter: template.limiter,
        statusOnly: template.statusOnly,
      }),
    ]),
  ) as Record<ManagementRouteId, ManagementRoute>,
);

function nameSegment(value: string | undefined, exchange: boolean): string {
  if (value === undefined || value === "") {
    // The default exchange is the one object with an empty name; the management API calls it amq.default here.
    if (exchange && value === "") return "amq.default";
    throw emptyNameRefusal();
  }
  if (value === "." || value === "..") throw dotSegmentRefusal();
  return rfc3986Encode(value);
}

/**
 * The pathname and query of one route: the Path prefix, `/api`, then each segment encoded on its own. Throws before
 * any request for an unknown route id, a dot segment or an empty name.
 */
export function routeTarget(
  id: ManagementRouteId,
  parts: RouteParts,
  pathPrefix: string,
): { readonly pathname: string; readonly params: URLSearchParams | undefined } {
  const template = Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined;
  if (template === undefined) throw new Error(`No management route ${JSON.stringify(id)}`);
  const segments = template.segments.map((segment) => {
    if (typeof segment === "string") return segment;
    if (segment.part === "vhost") return nameSegment(parts.vhost, false);
    return nameSegment(parts.name, segment.exchange === true);
  });
  return {
    pathname: `${pathPrefix}/api/${segments.join("/")}`,
    params: template.query.length === 0 ? undefined : new URLSearchParams(template.query.map(([k, v]) => [k, v])),
  };
}
