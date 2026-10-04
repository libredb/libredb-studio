/**
 * One Oxia command's outcome as the grid shows it (SB2-5.4, SB2-6.1): the columns per verb, every cell, and the
 * notices the run earned.
 *
 * Pure. The walks answer records and keys (contract section 3) and execute.ts pairs them with the command, the
 * namespace and the order verdict the run read (`OxiaOutcome`, decision D11); this module adds no read of its own.
 * The column names are the oxia CLI's own (`OutputVersion`), so an operator reads the fields they already know. A
 * stop (the run budget, the receive cap) is a result with its rows and a notice, never an error (SB1-9.3a).
 */
import type { QueryResult, QueryWarning } from "@/lib/db/types";
import type { OxiaKeysAnswer, OxiaRecordsAnswer, OxiaRecordView } from "./client";
import type { OxiaCommand, OxiaCommandRange, ParsedOxiaCommand } from "./commands";
import { OXIA_MAX_LIMIT, OXIA_RECEIVE_CAP_BYTES } from "./constants";
import { receiveCapNotice, runBudgetNotice } from "./errors";
import type { OrderVerdict } from "./order";
import { isoFromEpochMs, shownKey, viewOxiaValue, WITHHELD_VALUE_TEXT } from "./values";

/** What every outcome carries besides its command and its answer. */
export interface OxiaOutcomeFacts {
  /** The connection's namespace, normalised, for N2 and N13. */
  readonly namespace: string;
  /** The verdict the run merged or compared under; absent for an EQUAL get with no index. */
  readonly verdict?: OrderVerdict;
}

export type OxiaOutcome =
  | ({
      readonly kind: "get";
      readonly command: Extract<OxiaCommand, { kind: "get" }>;
      readonly answer: OxiaRecordView | undefined;
    } & OxiaOutcomeFacts)
  | ({
      readonly kind: "list";
      readonly command: Extract<OxiaCommand, { kind: "list" }>;
      readonly answer: OxiaKeysAnswer;
    } & OxiaOutcomeFacts)
  | ({
      readonly kind: "range-scan";
      readonly command: Extract<OxiaCommand, { kind: "range-scan" }>;
      readonly answer: OxiaRecordsAnswer;
    } & OxiaOutcomeFacts);

/** The record columns of SB2-6.1, in order; `secondary_index_key` follows them for `get --index` only. */
export const OXIA_RECORD_FIELDS: readonly string[] = Object.freeze([
  "key",
  "value",
  "value_encoding",
  "version_id",
  "modifications_count",
  "created_timestamp",
  "modified_timestamp",
  "ephemeral",
  "session_id",
  "client_identity",
]);

const SECONDARY_INDEX_KEY = "secondary_index_key";

/** What the doc and the grid say of the two columns whose type is not plain (SB2-6.1). */
const RECORD_COLUMN_TYPES: Readonly<Record<string, string>> = Object.freeze({
  version_id: "int64, per shard",
  client_identity: "string, client-reported",
});

const RECEIVE_CAP_MIB = OXIA_RECEIVE_CAP_BYTES / (1024 * 1024);

// ============================================================================
// Cells (SB2-6.1)
// ============================================================================

/** One record as a grid row, every cell by SB2-6.1's rule. */
function recordRow(
  record: OxiaRecordView,
  key: string,
  hex: boolean,
  cellLimit: number,
  withIndexKey: boolean,
): Record<string, unknown> {
  let value: string;
  let encoding: string;
  if (record.withheld === true) {
    value = WITHHELD_VALUE_TEXT;
    encoding = "withheld";
  } else {
    if (record.value === undefined)
      throw new Error(
        "An Oxia record reached the grid with no value and no withheld mark: a console read always asks for the value",
      );
    const view = viewOxiaValue(record.value, { hex, cellLimit });
    value = view.text;
    encoding = view.cut ? `${view.encoding}, cut` : view.encoding;
  }
  const { version } = record;
  const row: Record<string, unknown> = {
    key,
    value,
    value_encoding: encoding,
    version_id: version.versionId,
    modifications_count: version.modificationsCount,
    created_timestamp: isoFromEpochMs(version.createdTimestamp),
    modified_timestamp: isoFromEpochMs(version.modifiedTimestamp),
    // The wire's Version has no ephemeral field: a session id is what makes a record ephemeral.
    ephemeral: version.sessionId !== undefined,
    session_id: version.sessionId ?? null,
    client_identity:
      version.clientIdentity === undefined || version.clientIdentity === "" ? null : version.clientIdentity,
  };
  if (withIndexKey) row[SECONDARY_INDEX_KEY] = record.secondaryIndexKey ?? null;
  return row;
}

// ============================================================================
// Notices (SB2-5.4)
// ============================================================================

const COMPARISON_MISS: Readonly<Record<"floor" | "ceiling" | "lower" | "higher", (key: string) => string>> = {
  floor: (key) => `No key is at or below ${key}.`,
  ceiling: (key) => `No key is at or above ${key}.`,
  lower: (key) => `No key is below ${key}.`,
  higher: (key) => `No key is above ${key}.`,
};

/** N1, N2, N3 and N10: what a get found, or did not. */
function getNotices(outcome: Extract<OxiaOutcome, { kind: "get" }>): string[] {
  const { command, answer } = outcome;
  const asked = shownKey(command.key);
  if (answer === undefined) {
    if (command.comparison !== "equal") return [COMPARISON_MISS[command.comparison](asked)];
    if (command.index !== undefined) return [`Index ${shownKey(command.index)} holds no secondary key ${asked}.`];
    return [`Oxia holds no key ${asked} in namespace \`${outcome.namespace}\`.`];
  }
  const notices: string[] = [];
  // An index get asks for a secondary key and answers a primary one, so only a primary-key comparison names both.
  if (command.comparison !== "equal" && command.index === undefined && answer.key !== command.key)
    notices.push(`get -t ${command.comparison} asked for ${asked}; the key found is ${shownKey(answer.key)}.`);
  if (answer.withheld === true)
    notices.push(
      `The value of ${shownKey(rowKey(command, answer))} is larger than ${RECEIVE_CAP_MIB} MiB, the most Studio receives in one message, so it is withheld; its version is shown.`,
    );
  return notices;
}

/** N6 and N7: a `-s P/ -e P//` range that the namespace's order does not read as P's children. */
function idiomNotice(range: OxiaCommandRange, verdict: OrderVerdict | undefined): string | undefined {
  if (range.kind !== "bounds" || verdict === undefined) return undefined;
  const { min, max } = range;
  if (verdict.order === "natural" && min.endsWith("/") && max === `${min}/`) {
    const parent = min.slice(0, -1);
    return `This namespace sorts keys naturally, so \`${shownKey(max)}\` does not bound ${shownKey(parent)}'s children; \`--prefix ${shownKey(min)}\` lists everything under ${shownKey(min)}.`;
  }
  if (verdict.order === "hierarchical" && min.endsWith("//") && max === `${min}/`)
    return `A key ending in / sorts one level up under hierarchical order, so this range does not hold its children; \`--prefix ${shownKey(min)}\` lists everything under it.`;
  return undefined;
}

/** N4 to N9, N13 and N14: how a list or a range-scan ended, and what the order and the shards mean for its rows. */
function rangeNotices(outcome: Extract<OxiaOutcome, { kind: "list" | "range-scan" }>, rows: number): string[] {
  const { command, answer, verdict } = outcome;
  const notices: string[] = [];
  if (answer.stoppedBy === "receive-cap") notices.push(receiveCapNotice(rows));
  else if (answer.stoppedBy === "bytes") notices.push(runBudgetNotice(outcome.kind, rows));
  else if (answer.more)
    notices.push(
      `More keys follow: this result holds the first ${rows}. Raise --limit (at most ${OXIA_MAX_LIMIT}), or narrow the range.`,
    );
  // A range over secondary keys is not the primary-key idiom N6 and N7 are about.
  const idiom = command.index === undefined ? idiomNotice(command.range, verdict) : undefined;
  if (idiom !== undefined) notices.push(idiom);
  // Merged across shards under an assumed order (an index read is not merged; one shard is not merged).
  if (verdict?.learnedBy === "assumed" && answer.indexConcatenated !== true && answer.shardsRead > 1)
    notices.push(
      verdict.exhausted === true
        ? "Keys are merged in hierarchical order, assumed: Studio could not tell the orders apart from the keys read."
        : "Keys are merged in hierarchical order, assumed: no key in this namespace holds /, and without / both orders sort keys the same way.",
    );
  if (answer.indexConcatenated === true)
    notices.push(
      "With --index, each shard's keys are in secondary-key order and the shards follow one another in shard order: Oxia does not return the secondary key with a listed key, so Studio cannot merge them.",
    );
  const nothing = rows === 0 && !answer.more && answer.stoppedBy === undefined;
  const whole =
    command.range.kind === "bounds" &&
    command.range.min === "" &&
    command.range.max === "" &&
    command.partitionKey === undefined;
  if (nothing && command.index !== undefined)
    notices.push(`No key of index ${shownKey(command.index)} lies in this range.`);
  else if (nothing && whole) notices.push(`The namespace \`${outcome.namespace}\` holds no keys.`);
  return notices;
}

/** N11 and N12: a pasted -a or -n that names the connection's own, accepted and changing nothing. */
function matchedNotices(parsed: ParsedOxiaCommand): string[] {
  const notices: string[] = [];
  if (parsed.matched.includes("service-address"))
    notices.push(
      "-a names this connection's own endpoint, so it changes nothing: Host and Port on the connection decide where Studio connects.",
    );
  if (parsed.matched.includes("namespace"))
    notices.push(
      "-n names this connection's own namespace, so it changes nothing: Namespace is set on the connection.",
    );
  return notices;
}

/** The key cell of a get: the asked key for an EQUAL get with no index (the wire omits it, F16), else the server's. */
function rowKey(command: Extract<OxiaCommand, { kind: "get" }>, answer: OxiaRecordView): string {
  return command.comparison === "equal" && command.index === undefined ? command.key : answer.key;
}

// ============================================================================
// The result
// ============================================================================

/**
 * The outcome as a `QueryResult`: its columns, its rows, and its notices, those about the answer in the order of
 * SB2-5.4 (N1 to N10, N13, N14), then N11 and N12, which are about the command.
 */
export function oxiaResult(
  outcome: OxiaOutcome,
  parsed: ParsedOxiaCommand,
  cellLimit: number,
  executionTime: number,
): QueryResult {
  let fields: string[];
  let rows: Record<string, unknown>[];
  let notices: string[];
  if (outcome.kind === "get") {
    const withIndexKey = outcome.command.index !== undefined;
    fields = withIndexKey ? [...OXIA_RECORD_FIELDS, SECONDARY_INDEX_KEY] : [...OXIA_RECORD_FIELDS];
    const { answer } = outcome;
    rows =
      answer === undefined
        ? []
        : [recordRow(answer, rowKey(outcome.command, answer), outcome.command.hex, cellLimit, withIndexKey)];
    notices = getNotices(outcome);
  } else if (outcome.kind === "range-scan") {
    fields = [...OXIA_RECORD_FIELDS];
    rows = outcome.answer.records.map((record) => recordRow(record, record.key, outcome.command.hex, cellLimit, false));
    notices = rangeNotices(outcome, rows.length);
  } else {
    fields = ["key"];
    rows = outcome.answer.keys.map((key) => ({ key }));
    notices = rangeNotices(outcome, rows.length);
  }
  const warnings: QueryWarning[] = [...notices, ...matchedNotices(parsed)].map((message) => ({ message }));
  return {
    rows,
    fields,
    rowCount: rows.length,
    executionTime,
    ...(outcome.kind === "list" ? {} : { columnTypes: { ...RECORD_COLUMN_TYPES } }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
