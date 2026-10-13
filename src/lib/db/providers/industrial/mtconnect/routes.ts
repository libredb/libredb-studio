/**
 * The closed route table (MT-S1).
 *
 * The authoritative list is the agent's own. MEASURED on `mtconnect/agent:2.8.0.3` with `AllowPut`
 * unset: `GET /swagger` answered 200 with 15 routes and 15 operations, every one a GET. This table
 * is NINE of those fifteen, and the six it leaves out are left out for stated reasons rather than
 * by oversight (decision K-65). The table of omissions below holds seven entries: the sixth of the
 * fifteen plus `/swagger` itself, which the agent answers and which is not one of the fifteen.
 *
 * The count was ten in an earlier draft of this file, and the tenth route, `/{device}/asset/{assetIds}`,
 * DOES NOT EXIST: it was completed by symmetry rather than read, and the Swagger document names no such
 * route. A test that pinned the count is what sent this back to the document (decision K-65, corrected).
 *
 * The parameter sets below were read from that Swagger document route by route, not copied from the
 * issue. The difference matters twice:
 *
 * - `/assets` also accepts a `device` QUERY parameter, which is the one MEASURED on the demo as
 *   untrustworthy: `/assets?device=<unknown>` answered 200 with every asset in the buffer. The
 *   agent publishes it, so refusing it is a decision and not an omission.
 * - `/asset/{assetIds}` accepts the ids and NOTHING else: no `type`, no `count`, no `removed`.
 *   Grouping it with `/assets` under one parameter list, as the issue does, would have the provider
 *   offering filters on a route that takes none.
 *
 * The device is always a path segment. A `device` query parameter is never sent, for the reason
 * above.
 *
 * TWO VIEWS OF ONE TABLE, AND ONE OF THEM IS DERIVED. `MTC_ROUTES` below is what the guard runs: its
 * query kinds are this provider's own, because MT-S2 makes the provider check `from` against the
 * Header's window and `count` against the buffer size in any case, and the console cannot see either.
 * `MTC_CONSOLE_ROUTES` is the same table as the shared console's `RouteSpec`, for the editor to draw
 * and complete, and it is COMPUTED from `MTC_ROUTES` rather than written a second time: a route the
 * guard would refuse cannot be a route the editor offers, which is what a hand copy drifts into.
 *
 * The `"text"` member the mapping leans on is the one change the shared console took for this provider
 * (decision K-102, `src/lib/db/console/dialect.ts`): `path` is an XPath, `count` may be negative and a
 * sequence number runs past the safe integer, so none of the three older kinds can carry them.
 *
 * Browser-safe: no Node built-in, no server module.
 */

import type { ConsoleDialectSpec, QueryKeySpec, RouteSpec } from "@/lib/db/console/dialect";

/** What a path parameter holds. */
export type MtcParamKind = "device" | "asset-ids";

/**
 * What a query key takes. `text` is the kind the shared console does not have yet; the numeric
 * kinds are checked here rather than by the console because MT-S2 requires the provider to validate
 * against the Header's window and the buffer size in any case, which the console cannot see.
 */
export type MtcQueryKind = "text" | "uint64" | "nonzero-int" | "word" | "boolean";

export interface MtcQueryKey {
  readonly kind: MtcQueryKind;
  /** For `word`: the words accepted, where the set is closed. Absent where the set is open. */
  readonly words?: readonly string[];
}

export type MtcOp = "probe" | "current" | "sample" | "assets" | "asset";

export interface MtcRoute {
  /** Always GET. The table is of routes, not of methods, because a GET route can act. */
  readonly method: "GET";
  /** After the prefix, with each path parameter written as `{name}`. */
  readonly template: string;
  readonly op: MtcOp;
  readonly params: Readonly<Record<string, MtcParamKind>>;
  readonly query: Readonly<Record<string, MtcQueryKey>>;
  /** Every route reads. Nothing in this table writes, which is the point of MT-S1. */
  readonly reads: true;
}

const DEVICE_TYPE: MtcQueryKey = Object.freeze({ kind: "word" });
const PATH: MtcQueryKey = Object.freeze({ kind: "text" });
const SEQUENCE: MtcQueryKey = Object.freeze({ kind: "uint64" });
const COUNT: MtcQueryKey = Object.freeze({ kind: "nonzero-int" });
const ASSET_TYPE: MtcQueryKey = Object.freeze({ kind: "word" });
const REMOVED: MtcQueryKey = Object.freeze({ kind: "boolean" });

/*
 * `deviceType` appeared at schema 2.3, and NOTHING IN THIS PROVIDER GATES ON THAT. An exported
 * `DEVICE_TYPE_SINCE = "2.3"` stood here and was read by no code at all: changing it to "9.9" broke
 * no test, because there was nothing to break. A version gate would need the agent's own
 * `mtconnectVersion`, which this version does not read, so the honest record is the fact and its
 * consequence: on an agent older than 2.3 the key is sent and the agent answers its own
 * `INVALID_PARAMETER_VALUE`, which the provider reports as the agent's sentence.
 */

export const MTC_ROUTES: readonly MtcRoute[] = Object.freeze([
  Object.freeze({
    method: "GET",
    template: "probe",
    op: "probe",
    reads: true,
    params: Object.freeze({}),
    query: Object.freeze({ deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "{device}/probe",
    op: "probe",
    reads: true,
    params: Object.freeze({ device: "device" }),
    query: Object.freeze({ deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "current",
    op: "current",
    reads: true,
    params: Object.freeze({}),
    query: Object.freeze({ path: PATH, at: SEQUENCE, deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "{device}/current",
    op: "current",
    reads: true,
    params: Object.freeze({ device: "device" }),
    query: Object.freeze({ path: PATH, at: SEQUENCE, deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "sample",
    op: "sample",
    reads: true,
    params: Object.freeze({}),
    query: Object.freeze({ path: PATH, from: SEQUENCE, to: SEQUENCE, count: COUNT, deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "{device}/sample",
    op: "sample",
    reads: true,
    params: Object.freeze({ device: "device" }),
    query: Object.freeze({ path: PATH, from: SEQUENCE, to: SEQUENCE, count: COUNT, deviceType: DEVICE_TYPE }),
  }),
  Object.freeze({
    method: "GET",
    template: "assets",
    op: "assets",
    reads: true,
    params: Object.freeze({}),
    query: Object.freeze({ type: ASSET_TYPE, count: COUNT, removed: REMOVED }),
  }),
  Object.freeze({
    method: "GET",
    template: "{device}/assets",
    op: "assets",
    reads: true,
    params: Object.freeze({ device: "device" }),
    query: Object.freeze({ type: ASSET_TYPE, count: COUNT, removed: REMOVED }),
  }),
  // MEASURED from Swagger: this route takes the ids and nothing else.
  Object.freeze({
    method: "GET",
    template: "asset/{assetIds}",
    op: "asset",
    reads: true,
    params: Object.freeze({ assetIds: "asset-ids" }),
    query: Object.freeze({}),
  }),
]);

/**
 * The five routes the agent publishes and this table leaves out, with the reason, so that a reader
 * of the table can tell a decision from an oversight.
 */
export const MTC_ROUTES_LEFT_OUT: readonly { readonly route: string; readonly why: string }[] = Object.freeze([
  Object.freeze({
    route: "/",
    why: "An alias of /probe. MEASURED on the demo: both answered MTConnectDevices in 46,413 bytes.",
  }),
  Object.freeze({
    route: "/{device}",
    why: "An alias of /{device}/probe. MEASURED on the demo: /Mazak answered that device's model in 21,247 bytes.",
  }),
  Object.freeze({
    route: "/asset",
    why: "An alias of /assets when no ids are given. MEASURED on the demo: both answered MTConnectAssets in 57,900 bytes.",
  }),
  Object.freeze({
    route: "/cancel/id={string}",
    why: "The one GET in the published list that acts rather than reads: it cancels a stream.",
  }),
  Object.freeze({
    route: "/{device}/asset",
    why: "An alias of /{device}/assets: Swagger gives both the same filter set of count, device, removed and type.",
  }),
  Object.freeze({
    route: "/assets/{assetIds}",
    why: "A second spelling of /asset/{assetIds}: Swagger gives both the ids and nothing else.",
  }),
  Object.freeze({
    route: "/swagger",
    why: "Agent administration, and not one of the fifteen. MEASURED on the pinned agent: it answers 200, and it is still out of scope.",
  }),
]);

/** The parameters the provider refuses by name on every route, each with the reason. */
export const MTC_REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  interval: "streaming is out of scope for v1: an answer never ends, and the shared transport cannot carry it",
  heartbeat: "streaming is out of scope for v1",
  frequency: "the deprecated spelling of interval",
  format:
    "not in the standard, and its effect depends on the agent version. MEASURED: with Accept: application/xml set, format=json returned JSON on 2.8.0.3 and had no effect on 2.2.0.17",
  pretty: "not in the standard, and it changes only the whitespace of an answer the provider parses",
  device:
    "the device belongs in the path. MEASURED on the demo: /assets?device=<unknown> answered 200 with every asset in the buffer",
});

/**
 * The dialect the console editor declares. `shortForm` is false: a request line names a route from
 * the prefix, so there is one spelling of each route and no second one to parse.
 *
 * `maxTextBytes` is not the path's own ceiling. MEASURED on the pinned agent with a raw socket: the
 * agent accepted a request whose whole header block was 8,153 bytes and answered nothing at all,
 * closing the connection with zero bytes written, at 8,216. The limit is on the header block, so a
 * path's ceiling is what remains of an 8 KiB budget after the route, the device name, the other
 * parameters and the headers (decision K-61). This number is the console's own text bound, which
 * sits below that budget.
 */
export const MTC_CONSOLE_DIALECT: ConsoleDialectSpec = Object.freeze({
  id: "mtconnect",
  methods: Object.freeze(["GET"]),
  pathPrefix: "/",
  shortForm: false,
  commentMarkers: Object.freeze(["#"]),
  bodyComments: false,
  maxTextBytes: 4096,
  // THE FOUR BODY BOUNDS BOUND A SENTENCE, NOT A REQUEST, AND THEY ARE THE TWO EXISTING DIALECTS'
  // OWN NUMBERS. No route here takes a body: every one declares `body: "none"`, and a body on such
  // a route is refused. MEASURED, and this is why they are not zero: `parseConsole` reads the body
  // BEFORE it checks the route's body rule, so with zeros `GET /current` followed by `{"a":1}` was
  // refused as `too-many-nodes`, a sentence about a bound, instead of being told the route takes no
  // body. Qdrant's and Milvus's numbers are carried over rather than invented, so the only thing
  // these four decide is how large a mistyped body gets the right sentence.
  maxDepth: 32,
  maxNodes: 4_096,
  maxNumericLeaves: 262_144,
  maxScalarLeaves: 32_768,
});

/**
 * The same table as the shared console reads it, computed rather than written again.
 *
 * Two mappings, and each one loses something on purpose:
 *
 * - EVERY QUERY KEY BECOMES `"text"`. The shared kinds cannot express "an integer that may be
 *   negative", "an integer up to 2^64-1" or "one of a set the standard grows each version", so a
 *   mapping onto them would either refuse a value the agent answers or accept a shape the provider
 *   then refuses with a sentence from somewhere else. `"text"` draws the value and says nothing
 *   about it; the sentence a reader gets comes from the guard, which is where MT-S2 puts it anyway.
 * - EVERY PATH PARAMETER BECOMES `"name"`, the shared kind that asks only for a non-empty segment.
 *   `asset-ids` is a comma-separated list and `device` is a name the agent knows; neither shape is
 *   the console's to enforce, and `guard.ts` enforces both.
 *
 * What the derivation does guarantee is the part a hand copy gets wrong: the route words, their
 * order, their path parameters and their query keys are the guard's own, so the editor cannot offer
 * a route or a key that the guard refuses.
 */
export const MTC_CONSOLE_ROUTES: readonly RouteSpec<MtcOp>[] = Object.freeze(
  MTC_ROUTES.map((route) =>
    Object.freeze({
      method: route.method,
      template: route.template,
      op: route.op,
      class: "read" as const,
      params: Object.freeze(Object.fromEntries(Object.keys(route.params).map((name) => [name, "name" as const]))),
      query: Object.freeze(
        Object.fromEntries(
          Object.keys(route.query).map((key) => [key, Object.freeze({ kind: "text" }) as QueryKeySpec]),
        ),
      ),
      body: "none" as const,
    }),
  ),
);

/**
 * The ceiling on the whole request header block, for the budget the path is cut from.
 *
 * THE NUMBER IS THE ROUND ONE BETWEEN TWO MEASUREMENTS, not a measurement itself: with a raw socket
 * the pinned agent answered a request whose whole header block was 8,153 bytes and answered NOTHING
 * at all at 8,216, writing zero bytes and closing the connection. 8192 is 8 KiB, which sits between
 * them, so a request this provider sends is inside the answered case and a request it refuses is one
 * the agent might have dropped in silence.
 */
export const MTC_REQUEST_HEADER_BUDGET_BYTES = 8192;
