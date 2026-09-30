/**
 * A command's outcome as a QueryResult (spec 5.2): one shape per command, E9's classifier on every
 * value-bearing field, the warnings of 5.3 and 5.4, and at least one row for every write.
 *
 * Pure. execute.ts and watch.ts produce the outcomes this file declares, which is why they are
 * declared here, and nothing here reads a client. A revision, a version, a count or a TTL stays the
 * decimal string etcd answered and an id a hex string, never a JavaScript number (spec 5.2). A key
 * column's `_encoding` column is added only when the result holds a key that is not UTF-8 text.
 */
import type { QueryResult, QueryWarning } from "@/lib/types";
import type {
  EtcdAlarm,
  EtcdAuthStatus,
  EtcdBytes,
  EtcdDeleteRangeResponse,
  EtcdInt64,
  EtcdKeyValue,
  EtcdLeaseGrantResponse,
  EtcdLeaseKeepAliveResponse,
  EtcdLeaseTimeToLiveResponse,
  EtcdMember,
  EtcdPermission,
  EtcdPutResponse,
  EtcdResponseHeader,
  EtcdStatus,
  EtcdTxnRequest,
  EtcdTxnResponse,
  EtcdWatchEvent,
} from "./client";
import { compareBytes, leaseHexId, memberHexId, prefixRangeEnd, typedKey } from "./keys";
import { ROOT_ROLE, ROOT_ROLE_HOLDS_EVERY_KEY } from "./permissions";
import { viewKey, viewValue } from "./values";

/** Where a paged read stopped before the end of its range, and on which bound (spec 5.4). */
export interface ReadStop {
  readonly by: "rows" | "bytes";
  readonly beforeKey: EtcdBytes;
}

export interface WatchOutcome {
  readonly events: readonly EtcdWatchEvent[];
  /** A compaction, a server cancellation and a cancelQuery are raised as errors, never outcomes (spec 5.3). */
  readonly endedBy: "window" | "rows" | "bytes";
  /** The range as the warning names it: "/apisix/routes/ (prefix)". */
  readonly rangeLabel: string;
  readonly windowMs: number;
  /** Set when the default window was capped by the query timeout less the margin (spec 5.3). */
  readonly capped?: { readonly queryTimeoutMs: number };
}

export type CommandOutcome =
  | {
      readonly kind: "get";
      readonly kvs: readonly EtcdKeyValue[];
      readonly count?: EtcdInt64;
      readonly keysOnly: boolean;
      readonly countOnly: boolean;
      readonly more: boolean;
      readonly stopped?: ReadStop;
      readonly header: EtcdResponseHeader;
    }
  | { readonly kind: "put"; readonly key: EtcdBytes; readonly response: EtcdPutResponse }
  | { readonly kind: "del"; readonly response: EtcdDeleteRangeResponse }
  | { readonly kind: "txn"; readonly request: EtcdTxnRequest; readonly response: EtcdTxnResponse }
  | { readonly kind: "watch"; readonly outcome: WatchOutcome }
  | { readonly kind: "lease-grant"; readonly response: EtcdLeaseGrantResponse }
  | { readonly kind: "lease-revoke"; readonly id: EtcdInt64 }
  | { readonly kind: "lease-timetolive"; readonly response: EtcdLeaseTimeToLiveResponse; readonly keys: boolean }
  | { readonly kind: "lease-list"; readonly ids: readonly EtcdInt64[] }
  | { readonly kind: "lease-keep-alive-once"; readonly response: EtcdLeaseKeepAliveResponse }
  | { readonly kind: "member-list"; readonly members: readonly EtcdMember[] }
  | { readonly kind: "endpoint-status"; readonly endpoint: string; readonly status: EtcdStatus }
  | {
      readonly kind: "endpoint-health";
      readonly endpoint: string;
      readonly healthy: boolean;
      readonly tookMs: number;
      readonly error?: string;
    }
  | { readonly kind: "alarm-list"; readonly alarms: readonly EtcdAlarm[] }
  | { readonly kind: "auth-status"; readonly status: EtcdAuthStatus }
  | { readonly kind: "user-list"; readonly names: readonly string[] }
  | {
      readonly kind: "user-get";
      readonly name: string;
      readonly roles: readonly string[];
      readonly permissions?: ReadonlyArray<{ readonly role: string; readonly permission: EtcdPermission }>;
    }
  | { readonly kind: "role-list"; readonly names: readonly string[] }
  | { readonly kind: "role-get"; readonly name: string; readonly permissions: readonly EtcdPermission[] };

type Row = Record<string, unknown>;

interface Shape {
  readonly fields: readonly string[];
  readonly rows: readonly Row[];
  readonly warnings?: readonly QueryWarning[];
  /** A bound Studio applied stopped the result (spec 5.4). */
  readonly wasLimited?: boolean;
}

/** What shaping one result counts as it goes: the value cells cut at the cell bound. */
interface Shaping {
  readonly cellLimit: number;
  cut: number;
}

/** A digit string grouped by thousands, "1,204", without passing through a number. */
const grouped = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (count: number, noun: string): string => `${grouped(String(count))} ${noun}${count === 1 ? "" : "s"}`;
const duration = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

function keyCells(key: EtcdBytes, column = "key"): Row {
  const view = viewKey(key);
  return { [column]: view.text, [`${column}_encoding`]: view.encoding };
}

/** A value by E9's table, counted when the cell bound cut it, its encoding then written with ", cut" (spec 5.2). */
function valueCells(key: EtcdBytes, value: EtcdBytes, shaping: Shaping, column = "value"): Row {
  const view = viewValue(key, value, shaping.cellLimit);
  if (view.cut) shaping.cut += 1;
  return { [column]: view.text, [`${column}_encoding`]: view.cut ? `${view.encoding}, cut` : view.encoding };
}

const leaseCell = (lease: EtcdInt64): string | null => (lease === "0" ? null : leaseHexId(lease));

/** A row's own cells followed by a pair's, a key's or a permission's. */
const joined = (head: Row, cells: Row): Row => ({ ...head, ...cells });

const PAIR_FIELDS = [
  "key",
  "key_encoding",
  "value",
  "value_encoding",
  "create_revision",
  "mod_revision",
  "version",
  "lease",
];

/** One key's `get` fields; `--keys-only` leaves the value and its encoding empty (spec 5.2). */
function pairCells(kv: EtcdKeyValue, shaping: Shaping, keysOnly: boolean): Row {
  return {
    ...keyCells(kv.key),
    ...(keysOnly ? { value: "", value_encoding: "" } : valueCells(kv.key, kv.value, shaping)),
    create_revision: kv.createRevision,
    mod_revision: kv.modRevision,
    version: kv.version,
    lease: leaseCell(kv.lease),
  };
}

function stopWarning(stop: ReadStop, rows: number): string {
  const before = `before the key ${typedKey(stop.beforeKey, "command-line")}`;
  return stop.by === "rows"
    ? `The read stopped at ${plural(rows, "row")}, the most a result holds, ${before}: narrow the range, or read on from that key.`
    : `The read stopped at its byte budget after ${plural(rows, "row")}, ${before}: narrow the range, read it with --keys-only, or read on from that key.`;
}

function getShape(outcome: Extract<CommandOutcome, { readonly kind: "get" }>, shaping: Shaping): Shape {
  if (outcome.countOnly) {
    if (outcome.count === undefined) throw new TypeError("A --count-only outcome carries the count etcd answered");
    return { fields: ["count"], rows: [{ count: outcome.count }] };
  }
  const rows = outcome.kvs.map((kv) => pairCells(kv, shaping, outcome.keysOnly));
  if (outcome.stopped !== undefined) {
    return {
      fields: PAIR_FIELDS,
      rows,
      warnings: [{ message: stopWarning(outcome.stopped, rows.length) }],
      wasLimited: true,
    };
  }
  if (!outcome.more) return { fields: PAIR_FIELDS, rows };
  const held =
    outcome.count === undefined
      ? `etcd holds more keys in this range than the read's --limit let it return (${plural(rows.length, "key")})`
      : `etcd holds ${grouped(outcome.count)} keys in this range, and the read's --limit stopped it at ${plural(rows.length, "key")}`;
  return { fields: PAIR_FIELDS, rows, warnings: [{ message: `${held}.` }] };
}

function putShape(outcome: Extract<CommandOutcome, { readonly kind: "put" }>, shaping: Shaping): Shape {
  const row = { ...keyCells(outcome.key), revision: outcome.response.header.revision };
  const previous = outcome.response.prevKv;
  if (previous === undefined) return { fields: ["key", "key_encoding", "revision"], rows: [row] };
  return {
    fields: ["key", "key_encoding", "revision", "prev_value", "prev_value_encoding", "prev_mod_revision"],
    rows: [
      {
        ...row,
        ...valueCells(outcome.key, previous.value, shaping, "prev_value"),
        prev_mod_revision: previous.modRevision,
      },
    ],
  };
}

function delShape(outcome: Extract<CommandOutcome, { readonly kind: "del" }>, shaping: Shaping): Shape {
  const { deleted, prevKvs } = outcome.response;
  const revision = outcome.response.header.revision;
  if (prevKvs.length === 0) return { fields: ["deleted", "revision"], rows: [{ deleted, revision }] };
  return {
    fields: ["deleted", "revision", ...PAIR_FIELDS],
    rows: prevKvs.map((kv) => joined({ deleted, revision }, pairCells(kv, shaping, false))),
  };
}

const TXN_FIELDS = [
  "succeeded",
  "revision",
  "index",
  "branch",
  "op",
  ...PAIR_FIELDS,
  "count",
  "deleted",
  "prev_value",
  "prev_value_encoding",
  "prev_mod_revision",
];

const OP_WORDS = { range: "get", put: "put", delete: "del" } as const;

/**
 * A first row carrying `succeeded` and the revision, then per executed request its 1-based index,
 * branch and op: one row per key a get or a single-key `del --prev-kv` answered, one row for a get
 * that answered none, and one per other request (spec 5.2); a get answered with `more` carries 5.4's
 * warning naming its index and limit (spec 5.1.4).
 */
function txnShape(outcome: Extract<CommandOutcome, { readonly kind: "txn" }>, shaping: Shaping): Shape {
  const { request, response } = outcome;
  const branch = response.succeeded ? "success" : "failure";
  const executed = response.succeeded ? request.success : request.failure;
  if (executed.length !== response.responses.length) {
    throw new TypeError("A txn's answer holds one response per request of the branch that ran");
  }
  const rows: Row[] = [{ succeeded: response.succeeded, revision: response.header.revision }];
  const warnings: QueryWarning[] = [];
  response.responses.forEach((answer, position) => {
    const sent = executed[position];
    if (sent.op !== answer.op) throw new TypeError("A txn's answer holds its responses in the order of the requests");
    const index = position + 1;
    const op = OP_WORDS[answer.op];
    if (answer.op === "range" && sent.op === "range") {
      const { kvs, count, more } = answer.response;
      const keysOnly = sent.request.keysOnly === true;
      if (sent.request.countOnly || kvs.length === 0) rows.push({ index, branch, op, count });
      else rows.push(...kvs.map((kv) => joined({ index, branch, op }, pairCells(kv, shaping, keysOnly))));
      if (more) {
        warnings.push({
          message: `Request ${index} of the ${branch} list is a get sent with a limit of ${plural(sent.request.limit, "key")}, and etcd holds more keys in its range: narrow the range, or read it with get on its own, which reads page by page.`,
        });
      }
    } else if (answer.op === "delete") {
      const { deleted, prevKvs } = answer.response;
      if (prevKvs.length === 0) rows.push({ index, branch, op, deleted });
      else rows.push(...prevKvs.map((kv) => joined({ index, branch, op, deleted }, pairCells(kv, shaping, false))));
    } else if (answer.op === "put" && sent.op === "put") {
      const previous = answer.response.prevKv;
      const key = sent.request.key;
      rows.push({
        index,
        branch,
        op,
        ...keyCells(key),
        ...(previous === undefined
          ? {}
          : { ...valueCells(key, previous.value, shaping, "prev_value"), prev_mod_revision: previous.modRevision }),
      });
    }
  });
  return { fields: TXN_FIELDS, rows, warnings };
}

const WATCH_FIELDS = ["revision", "type", ...PAIR_FIELDS];
const WATCH_PREVIOUS_FIELDS = ["prev_value", "prev_value_encoding"];

/** The end reason, always one warning naming the range, the window and the cause (spec 5.3). */
function watchWarning(outcome: WatchOutcome): string {
  const count = outcome.events.length;
  const window = duration(outcome.windowMs);
  const ended =
    outcome.endedBy === "window"
      ? `Watched ${outcome.rangeLabel} for ${window}: ${count === 0 ? "no event" : plural(count, "event")}.`
      : outcome.endedBy === "rows"
        ? `Watched ${outcome.rangeLabel}: stopped at ${plural(count, "event")}.`
        : `Watched ${outcome.rangeLabel}: stopped at its byte budget after ${plural(count, "event")}.`;
  if (outcome.capped === undefined) return ended;
  return `${ended} The window was capped at ${window} by this connection's query timeout (${duration(outcome.capped.queryTimeoutMs)}); raise Query Timeout in the connection to watch longer.`;
}

function watchShape(outcome: WatchOutcome, shaping: Shaping): Shape {
  const previous = outcome.events.some((event) => event.prevKv !== undefined);
  const rows = outcome.events.map((event) =>
    joined(
      {
        revision: event.kv.modRevision,
        type: event.type === "put" ? "PUT" : "DELETE",
        // A DELETE event's pair holds no value, only its key and the revision that deleted it.
        ...(event.type === "delete"
          ? joined(pairCells(event.kv, shaping, true), { value: null, value_encoding: null })
          : pairCells(event.kv, shaping, false)),
      },
      event.prevKv === undefined ? {} : valueCells(event.prevKv.key, event.prevKv.value, shaping, "prev_value"),
    ),
  );
  return {
    fields: previous ? [...WATCH_FIELDS, ...WATCH_PREVIOUS_FIELDS] : WATCH_FIELDS,
    rows,
    warnings: [{ message: watchWarning(outcome) }],
    wasLimited: outcome.endedBy !== "window",
  };
}

/** The warning a result carries when it shows the root role's permissions: the rows stay etcd's. */
const ROOT_ROLE_WARNINGS: readonly QueryWarning[] = [
  { message: `${ROOT_ROLE_HOLDS_EVERY_KEY.charAt(0).toUpperCase()}${ROOT_ROLE_HOLDS_EVERY_KEY.slice(1)}.` },
];

const PERMISSION_FIELDS = ["type", "key", "key_encoding", "range_end", "range_end_encoding", "prefix"];

/**
 * A permission's fields: etcd's type name, the key and range end as bytes are shown, and whether the
 * range is exactly a prefix.
 */
function permissionCells(permission: EtcdPermission): Row {
  const end = permission.rangeEnd;
  const ranged = end !== undefined && end.length > 0;
  return {
    type: permission.type.toUpperCase(),
    ...keyCells(permission.key),
    ...(ranged ? keyCells(end, "range_end") : { range_end: null, range_end_encoding: null }),
    prefix: ranged && permission.key.length > 0 && compareBytes(end, prefixRangeEnd(permission.key)) === 0,
  };
}

function memberRow(member: EtcdMember): Row {
  return {
    id: memberHexId(member.id),
    name: member.name,
    // etcdctl's words: a member that has not started has no name yet (printer.go makeMemberListTable).
    status: member.name === "" ? "unstarted" : "started",
    peer_urls: member.peerUrls.join(","),
    client_urls: member.clientUrls.join(","),
    is_learner: member.isLearner,
  };
}

function statusRow(endpoint: string, status: EtcdStatus): Row {
  return {
    endpoint,
    id: memberHexId(status.header.memberId),
    version: status.version,
    storage_version: status.storageVersion,
    db_size: status.dbSize,
    db_size_in_use: status.dbSizeInUse,
    db_size_quota: status.dbSizeQuota,
    is_leader: status.leader === status.header.memberId,
    is_learner: status.isLearner,
    raft_term: status.raftTerm,
    raft_index: status.raftIndex,
    raft_applied_index: status.raftAppliedIndex,
    errors: status.errors.join(", "),
  };
}

function shapeOf(outcome: CommandOutcome, shaping: Shaping): Shape {
  switch (outcome.kind) {
    case "get":
      return getShape(outcome, shaping);
    case "put":
      return putShape(outcome, shaping);
    case "del":
      return delShape(outcome, shaping);
    case "txn":
      return txnShape(outcome, shaping);
    case "watch":
      return watchShape(outcome.outcome, shaping);
    case "lease-grant":
      return {
        fields: ["lease", "ttl"],
        rows: [{ lease: leaseHexId(outcome.response.id), ttl: outcome.response.ttl }],
      };
    case "lease-revoke":
      return { fields: ["lease", "revoked"], rows: [{ lease: leaseHexId(outcome.id), revoked: true }] };
    case "lease-timetolive": {
      const { ttl, grantedTtl, keys } = outcome.response;
      const lease = leaseHexId(outcome.response.id);
      if (!outcome.keys)
        return { fields: ["lease", "ttl", "granted_ttl"], rows: [{ lease, ttl, granted_ttl: grantedTtl }] };
      const rows =
        keys.length === 0
          ? [{ lease, ttl, granted_ttl: grantedTtl }]
          : keys.map((key) => joined({ lease, ttl, granted_ttl: grantedTtl }, keyCells(key)));
      return { fields: ["lease", "ttl", "granted_ttl", "key", "key_encoding"], rows };
    }
    case "lease-list":
      return { fields: ["lease"], rows: outcome.ids.map((id) => ({ lease: leaseHexId(id) })) };
    case "lease-keep-alive-once":
      return {
        fields: ["lease", "ttl"],
        rows: [{ lease: leaseHexId(outcome.response.id), ttl: outcome.response.ttl }],
      };
    case "member-list":
      return {
        fields: ["id", "name", "status", "peer_urls", "client_urls", "is_learner"],
        rows: outcome.members.map(memberRow),
      };
    case "endpoint-status":
      return {
        fields: [
          "endpoint",
          "id",
          "version",
          "storage_version",
          "db_size",
          "db_size_in_use",
          "db_size_quota",
          "is_leader",
          "is_learner",
          "raft_term",
          "raft_index",
          "raft_applied_index",
          "errors",
        ],
        rows: [statusRow(outcome.endpoint, outcome.status)],
      };
    case "endpoint-health":
      return {
        fields: ["endpoint", "health", "took", "error"],
        rows: [
          {
            endpoint: outcome.endpoint,
            health: outcome.healthy,
            took: `${outcome.tookMs} ms`,
            error: outcome.error ?? null,
          },
        ],
      };
    case "alarm-list":
      return {
        fields: ["member_id", "alarm"],
        rows: outcome.alarms.map((alarm) => ({
          member_id: memberHexId(alarm.memberId),
          alarm: alarm.alarm.toUpperCase(),
        })),
      };
    case "auth-status":
      return {
        fields: ["enabled", "auth_revision"],
        rows: [{ enabled: outcome.status.enabled, auth_revision: outcome.status.authRevision }],
      };
    case "user-list":
    case "role-list":
      return { fields: ["name"], rows: outcome.names.map((name) => ({ name })) };
    case "user-get": {
      const user = { name: outcome.name, roles: outcome.roles.join(", ") };
      if (outcome.permissions === undefined) return { fields: ["name", "roles"], rows: [user] };
      const rows =
        outcome.permissions.length === 0
          ? [user]
          : outcome.permissions.map(({ role, permission }) => joined({ ...user, role }, permissionCells(permission)));
      return {
        fields: ["name", "roles", "role", ...PERMISSION_FIELDS],
        rows,
        ...(outcome.roles.includes(ROOT_ROLE) ? { warnings: ROOT_ROLE_WARNINGS } : {}),
      };
    }
    case "role-get": {
      const rows =
        outcome.permissions.length === 0
          ? [{ role: outcome.name }]
          : outcome.permissions.map((permission) => joined({ role: outcome.name }, permissionCells(permission)));
      return {
        fields: ["role", ...PERMISSION_FIELDS],
        rows,
        ...(outcome.name === ROOT_ROLE ? { warnings: ROOT_ROLE_WARNINGS } : {}),
      };
    }
  }
}

/** The `_encoding` columns a result adds only when one of its rows holds a key that is not UTF-8 (spec 5.2). */
const KEY_ENCODING_COLUMNS: ReadonlySet<string> = new Set(["key_encoding", "range_end_encoding"]);

/**
 * Spec 5.2's shapes, E9 on every value-bearing field, the warnings of 5.3 and 5.4, and at least one
 * row for every write.
 */
export function commandResult(
  outcome: CommandOutcome,
  context: { readonly executionTime: number; readonly cellLimit: number },
): QueryResult {
  const shaping: Shaping = { cellLimit: context.cellLimit, cut: 0 };
  const shape = shapeOf(outcome, shaping);
  const fields = shape.fields.filter(
    (field) => !KEY_ENCODING_COLUMNS.has(field) || shape.rows.some((row) => row[field] === "base64"),
  );
  // Every row carries every field, a missing one as null, so the grid and the export read one column set.
  const rows = shape.rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
  const warnings = [...(shape.warnings ?? [])];
  if (shaping.cut > 0) {
    warnings.push({
      message: `${plural(shaping.cut, "value")} passed the cell bound of ${plural(context.cellLimit, "character")} and ${shaping.cut === 1 ? "is" : "are"} shown cut: the encoding says ", cut".`,
    });
  }
  return {
    rows,
    fields,
    rowCount: rows.length,
    executionTime: context.executionTime,
    ...(shape.wasLimited === true
      ? { pagination: { limit: rows.length, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: true } }
      : {}),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
