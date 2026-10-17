/**
 * The console's rows: one row per metric a read could account for, and every row says where its
 * name and its datatype came from.
 *
 * WHY THE PROVENANCE COLUMNS ARE NOT OPTIONAL. A Sparkplug data message carries an alias and not a
 * name, and the specification forbids it from carrying the datatype, so a row's name and type are
 * only ever as good as the birth certificate they were resolved against. Three measured facts make
 * that provenance load-bearing rather than decorative, all taken on 2026-10-13 against Eclipse
 * Mosquitto 2.1.2 and HiveMQ CE 2026.5 with their Sparkplug Aware plugins:
 *
 * - A stored certificate's values are birth-time values, and the specification says so outright.
 * - A rebirth REPLACES the stored certificate, so the definition a row was named by can change
 *   during a read.
 * - A death does NOT remove the stored certificate, so a row can be named by a certificate whose
 *   node was seen to die in the same read.
 *
 * A grid that showed only name and value would present all three cases identically.
 *
 * Pure. Takes a `ReadState` and a validated request, returns rows. No I/O.
 */
import type { UnresolvedValue } from "./fold";
import { SPARKPLUG_BIRTH_TIME_VALUE, SPARKPLUG_LIVE_BIRTH_VALUE, SPARKPLUG_UNRESOLVED_ALIAS } from "./labels";
import { compareCodePoints } from "./objects";
import type { SparkplugReadQuery } from "./request";
import type {
  BirthRecord,
  DefinitionOrigin,
  EdgeNodeState,
  MetricDefinition,
  ObservedMetric,
  ReadState,
} from "./state";
import { datatypeName } from "./values";

/**
 * The columns, in order.
 *
 * `liveness` is last on purpose: it is a property of the NODE and not of the row, and putting it
 * beside the value would read as the value's own freshness.
 */
export const RESULT_FIELDS: readonly string[] = Object.freeze([
  "group",
  "edgeNode",
  "device",
  "metric",
  "alias",
  "datatype",
  "definedBy",
  "birthTime",
  "bdSeq",
  /*
   * THE VALUE COLUMNS, and the issue asks for them outright: a metric shows "the last value the read
   * carried with its timestamp", `is_historical`, `is_transient` and `is_null`. They were missing
   * while the entire value layer - 321 lines and every datatype 0 to 34 - had no production caller
   * at all, so the provider read the SCHEMA and threw the DATA away.
   *
   * The timestamp is the metric's OWN (6.4.5) and not the receive time, because that is the one a
   * plant reasons about. A metric a read carried no value for leaves these null rather than empty:
   * "no value in this window" and "a value of nothing" are different answers.
   */
  "value",
  "valueTime",
  "isHistorical",
  "isTransient",
  /*
   * Quality is the last item of the row the issue describes, and it is TWO columns on purpose: the
   * number the publisher sent, and the name the specification gives it where it names one. 6.4.9
   * names 0 BAD, 192 GOOD and 500 STALE and leaves the rest open, so a reader that showed only a
   * name would have to invent one for a code it did not recognise.
   */
  "quality",
  "qualityName",
  "liveness",
  /**
   * Why this row says what it says, in the provider's own words.
   *
   * ADDED BECAUSE THREE WRITTEN SENTENCES REACHED NOBODY. `SPARKPLUG_UNRESOLVED_ALIAS` and
   * `SPARKPLUG_BIRTH_TIME_VALUE` were written, tested as constants, and read by no caller, so the
   * product carried the facts (a `birthTime` flag, an unnameable value) without ever carrying their
   * explanation. A flag a reader cannot interpret is a fact withheld.
   */
  "note",
]);

export interface ResultRow {
  readonly group: string;
  readonly edgeNode: string;
  /** Null for a metric the edge node declared itself, rather than an empty string. */
  readonly device: string | null;
  /**
   * Null for a value no certificate in hand could name.
   *
   * NULL RATHER THAN A PLACEHOLDER. A row that printed the alias here, or "unknown", would be a row
   * claiming a name the read does not have, and the whole point of carrying provenance is that a
   * name is only ever shown when a certificate declared it (SP-S7).
   */
  readonly metric: string | null;
  /** Null when the certificate declared no alias, which 5.17 requires of `Node Control/Rebirth`. */
  readonly alias: string | null;
  /** The datatype's own name (6.4.16), never the wire field that carried a value. Null when unnamed. */
  readonly datatype: string | null;
  /** Which certificate named this metric, or null when none did. */
  readonly definedBy: BirthRecord["origin"] | null;
  /** True when the value this row would carry is a birth-time value (10.1.4). */
  readonly birthTime: boolean;
  readonly bdSeq: string | null;
  /** The last value this read carried for the metric, rendered under its declared datatype. */
  readonly value: string | null;
  /** That value's own timestamp (6.4.5), as decimal text. */
  readonly valueTime: string | null;
  readonly isHistorical: boolean | null;
  readonly isTransient: boolean | null;
  readonly isNull: boolean | null;
  /** The Quality code as the publisher sent it (6.4.9), or null where the metric declared none. */
  readonly quality: number | null;
  /** The specification's name for that code, or null for a code it does not name. */
  readonly qualityName: string | null;
  readonly liveness: EdgeNodeState["liveness"]["kind"];
  /** The sentence that explains this row's provenance, or empty when there is nothing to explain. */
  readonly note: string;
}

/** Whether one node is inside the request's scope. */
function inScope(node: EdgeNodeState, query: SparkplugReadQuery): boolean {
  if (query.group !== undefined && node.groupId !== query.group) return false;
  if (query.edgeNode !== undefined && node.edgeNodeId !== query.edgeNode) return false;
  return true;
}

/**
 * Build the rows.
 *
 * The order is deterministic and by CODE POINT, not by the default sort: a group id, an edge node
 * id and a metric name are each "any UTF-8 string", and `Array.prototype.sort` compares UTF-16 code
 * units, which puts a surrogate pair before U+FFFD where code point order and UTF-8 byte order both
 * put U+FFFD first. A grid whose order changes between two reads of the same broker is worse than
 * one with an order a user has to learn.
 */
/** The three Quality codes 6.4.9 names. Anything else is shown as its number with no name. */
const QUALITY_NAMES: Readonly<Record<number, string>> = Object.freeze({ 0: "BAD", 192: "GOOD", 500: "STALE" });

/** The value this read saw for one metric of one birth, or nothing when the window carried none. */
function observedOf(
  state: ReadState,
  node: { readonly groupId: string; readonly edgeNodeId: string },
  device: string | null,
  metric: MetricDefinition,
): ObservedMetric | undefined {
  return state.valueOf(node.groupId, node.edgeNodeId, device ?? undefined, metric.name);
}

/** The sentence a row carries about where its value came from, or none where it needs none. */
function birthNote(fromBirth: boolean, metric: MetricDefinition, origin: DefinitionOrigin): string {
  if (!fromBirth || metric.text === undefined) return "";
  return origin === "stored" ? SPARKPLUG_BIRTH_TIME_VALUE : SPARKPLUG_LIVE_BIRTH_VALUE;
}

/**
 * The value columns, or nulls where this read carried no value for the metric.
 *
 * TWO SOURCES, IN THIS ORDER. A data message from the window wins, because it is the newer reading.
 * Where the window carried none, the birth certificate's own value stands: 4.1.1 requires a birth to
 * publish every metric with its current value, and an edge node that published a birth and then went
 * quiet has told the reader what its metrics read. Dropping that was measured against a real broker:
 * an NBIRTH carrying `Temperature` 99.9 rendered as a row with a datatype and an empty value.
 *
 * The three message flags stay null for a birth value rather than being invented as false: a birth
 * metric carries no `is_historical` or `is_transient` of a data message's kind, and `null` says the
 * read has no answer where `false` would claim one.
 */
function valueColumns(
  observed: ObservedMetric | undefined,
  definition?: MetricDefinition,
): Pick<ResultRow, "value" | "valueTime" | "isHistorical" | "isTransient" | "isNull" | "quality" | "qualityName"> {
  if (observed === undefined) {
    if (definition?.text !== undefined) {
      return {
        value: definition.text,
        valueTime: definition.timestamp ?? null,
        isHistorical: null,
        isTransient: null,
        isNull: definition.isNull === true,
        quality: null,
        qualityName: null,
      };
    }
    return {
      value: null,
      valueTime: null,
      isHistorical: null,
      isTransient: null,
      isNull: null,
      quality: null,
      qualityName: null,
    };
  }
  return {
    value: observed.text,
    valueTime: observed.timestamp ?? null,
    isHistorical: observed.isHistorical,
    isTransient: observed.isTransient,
    isNull: observed.isNull,
    quality: observed.quality ?? null,
    qualityName: observed.quality === undefined ? null : (QUALITY_NAMES[observed.quality] ?? null),
  };
}

export function buildRows(
  state: ReadState,
  query: SparkplugReadQuery,
  /**
   * Values the read carried under an alias nothing could name.
   *
   * THEY ARE ROWS, NOT A FOOTNOTE, and the reason is a measurement: before this, rows were built
   * from certificates alone, so a read that saw a thousand unnameable values produced exactly what a
   * read that saw none produced. The provider's own rule is that a read reports what it saw, why it
   * stopped and what it can prove it lost, and this was the losing half of it.
   */
  unresolved: readonly UnresolvedValue[] = [],
): ResultRow[] {
  const rows: ResultRow[] = [];
  const nodes = state.all().filter((node) => inScope(node, query));
  nodes.sort(
    (left, right) =>
      compareCodePoints(left.groupId, right.groupId) || compareCodePoints(left.edgeNodeId, right.edgeNodeId),
  );

  for (const node of nodes) {
    // The node's own certificate first, then its devices by name. A device read also carries the
    // node's own metrics, because aliases are unique across the NBIRTH and all its DBIRTHs (6.4.6)
    // and a reader that dropped them could not resolve a template instance.
    const sources: [string | null, BirthRecord | undefined][] = [[null, node.birth]];
    const deviceNames = [...node.devices.keys()].sort(compareCodePoints);
    for (const name of deviceNames) sources.push([name, node.devices.get(name)]);

    for (const [device, birth] of sources) {
      if (birth === undefined) continue;
      if (query.device !== undefined && device !== query.device) continue;
      if (!query.includeBirths && birth.origin === "stored") continue;

      const metrics = [...birth.metrics].sort((left, right) => compareCodePoints(left.name, right.name));
      for (const metric of metrics) {
        if (rows.length >= query.limit) return rows;
        rows.push({
          group: node.groupId,
          edgeNode: node.edgeNodeId,
          device,
          metric: metric.name,
          alias: metric.alias ?? null,
          datatype: datatypeName(metric.datatype) ?? `datatype ${metric.datatype}`,
          definedBy: birth.origin,
          // `birthTime` is about THIS ROW'S VALUE, not about where the definition came from, which
          // `definedBy` already carries. It used to answer `origin === "stored"`, which made two
          // claims that a live read showed were wrong: a stored certificate's row said "birth-time
          // value" beside an EMPTY value, and a stored certificate whose metric a data message did
          // update said it too, although that value was the window's.
          birthTime: observedOf(state, node, device, metric) === undefined && metric.text !== undefined,
          bdSeq: birth.bdSeq ?? null,
          ...valueColumns(observedOf(state, node, device, metric), metric),
          liveness: node.liveness.kind,
          // The explanation belongs to the row that needs it, and only to that row: a stored
          // certificate's values cannot be expected to be current (10.1.4), a live birth's are the
          // node's own current ones (4.1.1), and a value from a data message needs no explanation.
          note: birthNote(observedOf(state, node, device, metric) === undefined, metric, birth.origin),
        });
      }
    }
  }

  // The unnameable values come last, after everything a certificate could name, because they are
  // what the read could NOT answer and a reader scanning from the top should meet the answers first.
  for (const value of unresolved) {
    if (rows.length >= query.limit) return rows;
    if (query.group !== undefined && value.groupId !== query.group) continue;
    if (query.edgeNode !== undefined && value.edgeNodeId !== query.edgeNode) continue;
    if (query.device !== undefined && value.deviceId !== query.device) continue;
    rows.push({
      group: value.groupId,
      edgeNode: value.edgeNodeId,
      device: value.deviceId ?? null,
      metric: null,
      alias: value.alias ?? null,
      datatype: null,
      definedBy: null,
      birthTime: false,
      bdSeq: null,
      // A value arrived, and this read cannot say what it was: without a certificate there is no
      // datatype, and 6.4.6 forbids reading a value under a datatype nobody declared.
      ...valueColumns(undefined),
      liveness: "published-during-read",
      note: SPARKPLUG_UNRESOLVED_ALIAS,
    });
  }
  return rows;
}

/**
 * The sentence that travels with the result.
 *
 * It says what the read was and what it could not answer, because a console read is a sample and a
 * row count alone reads as a total. The counts come from the read's own summary, so they cannot
 * drift from the rows.
 */
export function describeResult(state: ReadState, rows: readonly ResultRow[], endReason: string): string {
  const summary = state.summary();
  const parts = [
    `${rows.length.toLocaleString("en-US")} rows from ${summary.edgeNodes} edge nodes and ${summary.devices} devices`,
    `${summary.birthsStored} stored and ${summary.birthsLive} live birth certificates`,
  ];
  if (summary.nodesWithNoBirth > 0) {
    parts.push(
      `${summary.nodesWithNoBirth} edge nodes published without a birth certificate in hand, so their ` +
        "metrics have no name and no datatype yet",
    );
  }
  if (summary.deathsSeen > 0) parts.push(`${summary.deathsSeen} death messages arrived during the read`);
  if (summary.seqGaps > 0) {
    parts.push(`${summary.seqGaps} sequence gaps, so this read did not see every message the nodes sent`);
  }
  if (summary.unresolvedValues > 0) {
    // THE SENTENCE THAT WAS MISSING. Values arriving under an alias nothing could name used to leave
    // no row and no count, so a read that saw a thousand of them read exactly like a read that saw
    // none. A read that cannot name what it saw has to say so.
    parts.push(
      `${summary.unresolvedValues} values arrived under an alias no certificate in hand defines, so ` +
        "this read began after their birth rather than at it",
    );
  }
  parts.push(endReason);
  return `${parts.join(". ")}.`;
}
