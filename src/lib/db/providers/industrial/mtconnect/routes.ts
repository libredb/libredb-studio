/**
 * The closed route table (MT-S1).
 *
 * The authoritative list is the agent's own. MEASURED on `mtconnect/agent:2.8.0.3` with `AllowPut`
 * unset: `GET /swagger` answered 200 with 15 routes and 15 operations, every one a GET. This table
 * is ten of those fifteen, and the five it leaves out are left out for stated reasons rather than
 * by oversight (decision K-65).
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
 * These shapes mirror the shared console's `RouteSpec` and `ConsoleDialectSpec` deliberately. They
 * are declared here rather than imported because the console's query value kinds are
 * `positive-int`, `positive-int-or-words` and `word-list`, and MTConnect needs a free text value
 * for `path` and a non zero integer that may be negative for `count`. The agreed change is one
 * union member, `"text"`, in the shared module (decision K-102), and the shared module is a file
 * whose turn this session does not hold. When that member lands these specs map onto it one for
 * one; until then nothing outside this directory is touched.
 *
 * Browser-safe: no Node built-in, no server module.
 */

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

/** `deviceType` appeared at schema 2.3, so it is sent only where the agent's version allows it. */
export const DEVICE_TYPE_SINCE = "2.3";

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
export const MTC_CONSOLE_DIALECT = Object.freeze({
  id: "mtconnect",
  methods: Object.freeze(["GET"]),
  pathPrefix: "/",
  shortForm: false,
  commentMarkers: Object.freeze(["#"]),
  bodyComments: false,
  maxTextBytes: 4096,
  /** No route takes a body. Nothing in MTConnect's REST interface reads one. */
  body: "none",
});

/** The measured ceiling on the whole request header block, for the budget the path is cut from. */
export const MTC_REQUEST_HEADER_BUDGET_BYTES = 8192;
