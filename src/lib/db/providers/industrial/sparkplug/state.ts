/**
 * What one read saw: births as the schema, aliases resolved only against a birth, and liveness
 * kept strictly apart from the existence of a definition.
 *
 * THE RULE THIS MODULE IS SHAPED BY, and it is a measured one rather than a reading of the text.
 * MEASURED by this session on 2026-10-13 against Eclipse Mosquitto 2.1.2 with its bundled
 * Sparkplug Aware plugin (image digest `sha256:38c0da4f...ea408`, loopback only) and again against
 * HiveMQ CE 2026.5 with the HiveMQ Sparkplug Aware Extension 4.33.12 (image digest
 * `sha256:bac6d4d1...e67b`), each with a simulator on MQTT.js 5.14.1 and Tahu `sparkplug-payload`
 * 1.0.3:
 *
 * - A rebirth REPLACES the stored birth. On both brokers the retained payload's SHA-256 changed
 *   and its values changed with it (`f/temp` 20.5 became 77.25).
 * - NDEATH and DDEATH DO NOT REMOVE the stored birth. On both brokers the retained payload's
 *   SHA-256, byte length and timestamp were identical before and after the death.
 *
 * Those two together are why liveness and definition are separate fields below: a stored birth is
 * THE LAST DEFINITION SEEN, and says nothing about whether the node is up. A node can both have a
 * stored birth and have been seen to die in the same read, and the panel has to be able to say so.
 * 10.1.4 is silent on removal, so this was an inference in the proposal; it is now measured on two
 * brokers rather than argued from silence.
 *
 * AND WHY A DEATH'S TIME IS NEVER READ FROM ITS PAYLOAD. MEASURED the same day, with a Will whose
 * payload timestamp was deliberately set to 1000: Mosquitto delivered it unchanged as 1000, and
 * HiveMQ CE rewrote it to its own receipt time (1791853294338). Both are legal, because 10.1.4
 * PERMITS a server to rewrite it and does not require it. So the payload timestamp of an NDEATH
 * means different things on different brokers, and 5.5's "receipt time as offline time" is the
 * only reading that holds everywhere.
 *
 * Pure. Fed decoded payloads and receipt times, answers what the read saw. No I/O, no clock of
 * its own: the caller passes the receipt time, so a test can drive it.
 */
import { SEQ_MODULUS } from "./constants";
import type { NodeTopic } from "./topics";

/** Where a definition came from, which the panel shows beside every metric. */
export type DefinitionOrigin =
  /** The copy an aware server had stored at subscribe time. Its values are birth-time (10.1.4). */
  | "stored"
  /** A birth published during this read, because the edge node connected. */
  | "live"
  /** A birth published during this read in answer to someone else's rebirth request (5.17). */
  | "rebirth";

/** One metric as a birth defined it. The datatype here is the only authority for a value (6.4.6). */
export interface MetricDefinition {
  readonly name: string;
  readonly alias?: string;
  readonly datatype: number;
  /**
   * The value the birth itself published, as the value layer rendered it under the declared
   * datatype. Absent when the birth carried no value field for this metric.
   *
   * KEPT RATHER THAN DROPPED, and a live read is what showed why. 4.1.1 requires a birth to carry
   * every metric WITH ITS CURRENT VALUE, so a reader that keeps only the name, alias and datatype
   * throws away a reading the broker delivered: measured against a real mosquitto, an edge node
   * publishing `Temperature` 99.9 in its NBIRTH and no data message at all rendered as a row with
   * a name, a datatype and an empty value.
   */
  readonly text?: string;
  /** The metric's own timestamp in the birth, as decimal text (6.4.5). */
  readonly timestamp?: string;
  /** True when the birth declared the metric null rather than carrying a value. */
  readonly isNull?: boolean;
  /** Set when the birth's value could not be read under its declared datatype. */
  readonly problem?: string;
}

/** A birth in hand, with everything needed to decide whether a later one replaces it. */
export interface BirthRecord {
  readonly origin: DefinitionOrigin;
  /** The birth's own `bdSeq` metric, as decimal text; absent when the birth carried none. */
  readonly bdSeq?: string;
  /** The birth's payload timestamp, as decimal text. Shown, never used for liveness. */
  readonly payloadTimestamp?: string;
  /** When this reader received it, which is the only time that means the same on every broker. */
  readonly receivedAt: number;
  readonly metrics: readonly MetricDefinition[];
}

/**
 * What the read saw about one edge node's liveness, which is deliberately NOT a boolean.
 *
 * "online" is not knowable from a read: a node that published nothing during the window and has a
 * stored birth is indistinguishable from one that is up and quiet. The three states below are what
 * can actually be told apart, and `deathSeenAt` is a receipt time for the reason the header gives.
 */
export type Liveness =
  /** Nothing from this node during the read; it may be up and quiet, or gone. */
  | { readonly kind: "not-seen-in-this-read" }
  /** A birth or data arrived during the read. */
  | { readonly kind: "published-during-read"; readonly lastHeardAt: number }
  /** A death arrived during the read, matched to the birth in hand by bdSeq (6.4.25). */
  | { readonly kind: "death-seen-in-this-read"; readonly deathSeenAt: number; readonly bdSeq?: string };

/** A metric value the read carried, named only if a birth could name it (SP-S7). */
export interface ObservedValue {
  readonly alias?: string;
  /** Absent when no birth in hand defines this alias; the panel then shows it unresolved. */
  readonly name?: string;
  /** Absent for the same reason. A value is never shown under a datatype that was not declared. */
  readonly datatype?: number;
  readonly unresolved: boolean;
  /** True when the value came from a stored birth, so it is a birth-time value (10.1.4). */
  readonly birthTime: boolean;
}

/**
 * The last value a read carried for one metric, which is what the issue asks a metric row to show.
 *
 * LAST AND NOT EVERY, because a read is a window and a grid row is one line: 6.4.5 lets a data
 * message carry the same metric many times in one window, and a row that showed the first would show
 * the oldest. The timestamp is the METRIC'S OWN (6.4.5), not the receive time, because that is the
 * one a plant reasons about; `receivedAt` is kept beside it for the cases where a publisher sends
 * none.
 */
export interface ObservedMetric {
  /** Absent when no certificate in hand could name this alias. */
  readonly name?: string;
  readonly alias?: string;
  readonly datatype?: number;
  /** The value as the value layer rendered it under its declared datatype. */
  readonly text: string;
  /** Set when the value could not be read as its datatype asks (6.4.5 wire-field mismatches). */
  readonly problem?: string;
  /** The metric's own timestamp, as decimal text. */
  readonly timestamp?: string;
  readonly isHistorical: boolean;
  readonly isTransient: boolean;
  readonly isNull: boolean;
  /**
   * The metric's Quality property, as the number the publisher sent (6.4.9).
   *
   * THE NUMBER AND NOT ONLY A WORD, because 0 BAD, 192 GOOD and 500 STALE are the codes the
   * specification names and a publisher may send another: a reader that mapped everything it did not
   * recognise onto one of the three would be inventing a quality nobody claimed.
   */
  readonly quality?: number;
  readonly receivedAt: number;
}

export interface SeqGap {
  readonly expected: number;
  readonly saw: number;
}

/** One edge node's state, plus its devices. */
export interface EdgeNodeState {
  readonly groupId: string;
  readonly edgeNodeId: string;
  birth?: BirthRecord;
  /** Device births, keyed by device id. Aliases are unique across the NBIRTH and all DBIRTHs (6.4.6). */
  readonly devices: Map<string, BirthRecord>;
  liveness: Liveness;
  /** `seq` gaps seen during the read, which are flagged and never filled in (SP-S7). */
  readonly seqGaps: SeqGap[];
  lastSeq?: number;
}

function emptyNode(groupId: string, edgeNodeId: string): EdgeNodeState {
  return {
    groupId,
    edgeNodeId,
    devices: new Map(),
    liveness: { kind: "not-seen-in-this-read" },
    seqGaps: [],
  };
}

const nodeKey = (groupId: string, edgeNodeId: string) => `${groupId}\u0000${edgeNodeId}`;

/**
 * Whether a birth with `incoming` bdSeq replaces one with `held` bdSeq.
 *
 * bdSeq is a 64-bit unsigned value (6.4.25), so it is compared as text-to-BigInt rather than as a
 * number. A birth with no bdSeq replaces nothing and is replaced by anything: 4.2.1 requires the
 * metric, so its absence is a producer that does not follow the text, and guessing an order for it
 * would be the kind of invention SP-S7 forbids.
 */
export function birthReplaces(held: string | undefined, incoming: string | undefined): boolean {
  if (incoming === undefined) return false;
  if (held === undefined) return true;
  try {
    return BigInt(incoming) >= BigInt(held);
  } catch {
    return false;
  }
}

/**
 * The read's accumulated view. One instance per read, thrown away with it: nothing is kept past
 * one request (the proposal's non-goals).
 */
function valueKey(groupId: string, edgeNodeId: string, deviceId: string | undefined, metric: string): string {
  return `${groupId}\u0000${edgeNodeId}\u0000${deviceId ?? ""}\u0000${metric}`;
}

export class ReadState {
  private readonly nodes = new Map<string, EdgeNodeState>();
  /** Host states, keyed by host id, each shown read-only (6.4.27). */
  readonly hostStates = new Map<string, { readonly online?: boolean; readonly timestamp?: string }>();

  /**
   * The last value seen per metric, keyed by device and metric identity.
   *
   * A NUL joins the two halves because a device id and a metric name are both free UTF-8 (4.1.5,
   * 6.4.6) and any printable separator could appear inside either, which would give two different
   * metrics one key.
   */
  private readonly lastValues = new Map<string, ObservedMetric>();

  node(groupId: string, edgeNodeId: string): EdgeNodeState {
    const key = nodeKey(groupId, edgeNodeId);
    let held = this.nodes.get(key);
    if (held === undefined) {
      held = emptyNode(groupId, edgeNodeId);
      this.nodes.set(key, held);
    }
    return held;
  }

  all(): readonly EdgeNodeState[] {
    return [...this.nodes.values()];
  }

  /**
   * Take a birth.
   *
   * A birth from a LIVE message always wins over a stored one, whatever the bdSeq says: the stored
   * copy is by definition older, and 10.1.4 warns its values "can not be expected to be the
   * current values". Between two births of the same origin class, bdSeq decides.
   */
  takeBirth(topic: NodeTopic, record: BirthRecord): void {
    const node = this.node(topic.groupId, topic.edgeNodeId);
    const target = topic.deviceId === undefined ? node.birth : node.devices.get(topic.deviceId);
    const storedLosesToLive = target?.origin === "stored" && record.origin !== "stored";
    if (target !== undefined && !storedLosesToLive && !birthReplaces(target.bdSeq, record.bdSeq)) return;
    if (topic.deviceId === undefined) node.birth = record;
    else node.devices.set(topic.deviceId, record);
    if (record.origin !== "stored") {
      node.liveness = { kind: "published-during-read", lastHeardAt: record.receivedAt };
    }
  }

  /**
   * Take a death.
   *
   * `receivedAt` is the caller's receipt time and the payload's timestamp is NOT consulted, for
   * the measured reason in the header. A death whose bdSeq does not match the birth in hand is
   * IGNORED (6.4.25): "timing with Will Messages may result in NDEATH messages arriving after a
   * new/next NBIRTH message" (5.4), so an unmatched death is a previous session's, not this one's.
   */
  takeDeath(topic: NodeTopic, bdSeq: string | undefined, receivedAt: number): "applied" | "ignored-stale" {
    const node = this.node(topic.groupId, topic.edgeNodeId);
    const held = topic.deviceId === undefined ? node.birth : node.devices.get(topic.deviceId);
    if (held?.bdSeq !== undefined && bdSeq !== undefined && held.bdSeq !== bdSeq) return "ignored-stale";
    node.liveness = { kind: "death-seen-in-this-read", deathSeenAt: receivedAt, bdSeq };
    return "applied";
  }

  /**
   * Take a data message's `seq` and flag a gap.
   *
   * 4.2.1 says an NBIRTH's `seq` "MUST have a value of 0" while 5.4 and 6.4.5 allow 0 to 255, so
   * a birth's own seq is accepted anywhere in that range; the gap check applies between successive
   * data messages, where the wrap at 255 is a continuation and not a gap.
   */
  takeSeq(topic: NodeTopic, seq: number): void {
    const node = this.node(topic.groupId, topic.edgeNodeId);
    if (node.lastSeq !== undefined) {
      const expected = (node.lastSeq + 1) % SEQ_MODULUS;
      if (seq !== expected) node.seqGaps.push({ expected, saw: seq });
    }
    node.lastSeq = seq;
    if (node.liveness.kind !== "death-seen-in-this-read") {
      node.liveness = { kind: "published-during-read", lastHeardAt: Date.now() };
    }
  }

  /**
   * Resolve one alias against the birth in hand, and never against anything else.
   *
   * An alias is unique across an edge node's NBIRTH and all its DBIRTHs (6.4.6), so a device's
   * values resolve against the union of its own birth and its node's. With no birth in hand the
   * value is returned unresolved with its alias, which is what the panel shows: 6.4.6 forbids a
   * data message from carrying the name, so there is nothing else to show and inventing a name
   * would put a value under a label it does not have (SP-S7).
   */
  resolve(topic: NodeTopic, alias: string | undefined): ObservedValue {
    const node = this.nodes.get(nodeKey(topic.groupId, topic.edgeNodeId));
    if (node === undefined || alias === undefined) {
      return { alias, unresolved: true, birthTime: false };
    }
    const sources: (BirthRecord | undefined)[] =
      topic.deviceId === undefined ? [node.birth] : [node.devices.get(topic.deviceId), node.birth];
    for (const source of sources) {
      const found = source?.metrics.find((metric) => metric.alias === alias);
      if (found === undefined) continue;
      return {
        alias,
        name: found.name,
        datatype: found.datatype,
        unresolved: false,
        birthTime: source?.origin === "stored",
      };
    }
    return { alias, unresolved: true, birthTime: false };
  }

  /**
   * What the health panel reports, which is a count of what was SEEN and says so in its names.
   *
   * There is no "online" count here on purpose: see `Liveness`.
   */
  /**
   * How many values arrived under an alias no certificate in hand could name.
   *
   * HELD RATHER THAN DERIVED, because the state cannot derive it: a value this read could not name
   * leaves nothing behind in the state to count later. Without it the read's own sentence had no way
   * to mention a loss it had seen, and a read that saw a thousand unnameable values reported the
   * same sentence as one that saw none.
   */
  private unresolvedValues = 0;

  /** Record values a fold could not name. Additive, so two folds into one state do not lose either. */
  noteUnresolved(count: number): void {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError(`an unresolved count is a whole number, not ${count}`);
    this.unresolvedValues += count;
  }

  /** Record the last value seen for one metric. Later values replace earlier ones. */
  takeValue(topic: NodeTopic, observed: ObservedMetric): void {
    this.node(topic.groupId, topic.edgeNodeId);
    this.lastValues.set(
      valueKey(topic.groupId, topic.edgeNodeId, topic.deviceId, observed.name ?? `alias:${observed.alias ?? ""}`),
      observed,
    );
  }

  /**
   * The last value for one metric, or nothing when the read carried none.
   *
   * Taken by the three identity parts rather than a `NodeTopic`, because a caller building rows from
   * a birth certificate has the group, the node and the device but no message type to put in one.
   */
  valueOf(
    groupId: string,
    edgeNodeId: string,
    deviceId: string | undefined,
    metricName: string,
  ): ObservedMetric | undefined {
    return this.lastValues.get(valueKey(groupId, edgeNodeId, deviceId, metricName));
  }

  summary(): {
    readonly edgeNodes: number;
    readonly devices: number;
    readonly birthsStored: number;
    readonly birthsLive: number;
    readonly nodesWithNoBirth: number;
    readonly deathsSeen: number;
    readonly seqGaps: number;
    readonly unresolvedValues: number;
  } {
    let devices = 0;
    let birthsStored = 0;
    let birthsLive = 0;
    let nodesWithNoBirth = 0;
    let deathsSeen = 0;
    let seqGaps = 0;
    for (const node of this.nodes.values()) {
      devices += node.devices.size;
      const births = [node.birth, ...node.devices.values()];
      for (const birth of births) {
        if (birth === undefined) continue;
        if (birth.origin === "stored") birthsStored++;
        else birthsLive++;
      }
      if (node.birth === undefined) nodesWithNoBirth++;
      if (node.liveness.kind === "death-seen-in-this-read") deathsSeen++;
      seqGaps += node.seqGaps.length;
    }
    return {
      edgeNodes: this.nodes.size,
      devices,
      birthsStored,
      birthsLive,
      nodesWithNoBirth,
      deathsSeen,
      seqGaps,
      unresolvedValues: this.unresolvedValues,
    };
  }
}
