/**
 * The layer that turns what a read RECEIVED into what a read KNOWS.
 *
 * WHY THIS MODULE EXISTS, and it is a measurement rather than a design preference. Before it,
 * `session.ts` returned a sequence of messages and `ReadState` held everything the panels answer
 * from, and nothing joined the two: `new ReadState()` appeared in thirty-four places, every one of
 * them a test, and `takeBirth`, `takeDeath`, `takeSeq` and `resolve` each had ZERO production
 * callers. So the state layer was driven only by its own tests, and `connect()` refused before any
 * of it ran. Thirty tests and a hundred mutations described a layer the product never reached.
 *
 * DECODING HAPPENS HERE AND NOT ON THE RECEIVE PATH. The session keeps payloads as raw bytes under
 * a cap precisely so a slow decode cannot make the reader a slow consumer whose messages a broker
 * starts dropping. This module runs after the read has ended and the socket is closed.
 *
 * A PAYLOAD THIS MODULE CANNOT READ DOES NOT END THE FOLD. One refused payload is one message
 * missing from the state, and the count of them travels out so a panel can say the read is thinner
 * than the broker's traffic was. A refusal that stopped the fold would throw away every message
 * after it, which is a larger loss reported as a smaller one.
 */
import { decodePayload, type DecodedMessage, type DecodedValue } from "./decode";
import type { ReceivedMessage } from "./session";
import { type BirthRecord, type DefinitionOrigin, type MetricDefinition, ReadState } from "./state";
import { type NodeTopic, parseTopic } from "./topics";
import { type MetricWireValue, readMetricValue } from "./values";

/** A value the read carried under an alias that no certificate in hand defines. */
export interface UnresolvedValue {
  readonly groupId: string;
  readonly edgeNodeId: string;
  readonly deviceId?: string;
  readonly alias?: string;
  readonly receivedAt: number;
}

export interface FoldOutcome {
  readonly state: ReadState;
  /**
   * Every value that arrived under an alias no certificate could name.
   *
   * KEPT AS A LIST AND NOT ONLY A COUNT, because the rows a panel shows for them need the node they
   * came from: an unresolved value is evidence that this read began after a birth, and which node it
   * began after is the actionable part.
   */
  readonly unresolved: readonly UnresolvedValue[];
  /** Payloads the decoder refused, by reason, so a panel can say what kind of loss this was. */
  readonly refusals: Readonly<Record<string, number>>;
  /** Topics the parser refused, by reason. A refused topic is not a missing node. */
  readonly rejectedTopics: Readonly<Record<string, number>>;
  /**
   * Payloads carrying MORE THAN ONE metric named `bdSeq`.
   *
   * THE PROTOCOL'S OWN WORD IS NOT RESERVED, which is the whole reason this is counted. 5.3 says an
   * NBIRTH carries its birth-death sequence as a metric NAMED `bdSeq`, and there is no field number
   * for it, so finding it means matching a name. Nothing in the specification stops an edge node
   * from publishing a metric of its own under the same name. When two carry it, this module takes
   * NEITHER rather than the first: a wrong `bdSeq` makes a death match the wrong birth, and a death
   * matched to the wrong birth is reported as a node that died when it did not.
   */
  readonly ambiguousBdSeq: number;
}

function asMessages(value: DecodedValue | undefined): readonly DecodedMessage[] {
  if (value === undefined) return [];
  const many = Array.isArray(value) ? value : [value];
  return many.filter((one): one is DecodedMessage => typeof one === "object" && one !== null && !Array.isArray(one));
}

function text(value: DecodedValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A metric's declared datatype, which is the only authority for reading its value (6.4.6). */
function datatypeOf(metric: DecodedMessage): number | undefined {
  const raw = text(metric.datatype);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // UNREACHABLE FROM A WIRE PAYLOAD, AND SAID SO RATHER THAN LEFT TO LOOK LOAD-BEARING. A threshold
  // sweep shifted this to `>= -1` and no test moved, which is the shape of an untested boundary; the
  // measurement behind it is that the decoder reads `datatype` as `uint32-text`, so it yields decimal
  // digits and nothing else. Neither a negative number nor a non-numeric string can arrive here
  // through `decodePayload`. It stays because `DecodedMessage` is an index signature and a future
  // caller could hand this function a value the decoder never produced.
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The metric's Quality property, when it declared one (6.4.9).
 *
 * A PropertySet is TWO PARALLEL ARRAYS, keys and values, and nothing in the wire format ties an
 * entry of one to an entry of the other except its position. So a payload whose arrays are different
 * lengths has no answer rather than a guessed one: taking the value at an index the keys do not
 * reach would report a quality the publisher never set against the name it never set it on.
 */
function qualityOf(metric: DecodedMessage): number | undefined {
  const sets = asMessages(metric.properties);
  for (const set of sets) {
    const keys = (Array.isArray(set.keys) ? set.keys : [set.keys]).filter((k) => typeof k === "string");
    const values = asMessages(set.values);
    if (keys.length !== values.length) continue;
    const at = keys.indexOf("Quality");
    if (at < 0) continue;
    const raw = text(values[at]?.intValue) ?? text(values[at]?.longValue);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

/** The one `value` field a Metric set, handed to the value layer as it arrived (6.4.5). */
function wireValueOf(metric: DecodedMessage): MetricWireValue {
  const bytes = metric.bytesValue;
  return {
    ...(text(metric.intValue) === undefined ? {} : { intValue: text(metric.intValue) }),
    ...(text(metric.longValue) === undefined ? {} : { longValue: text(metric.longValue) }),
    ...(typeof metric.floatValue === "number" ? { floatValue: metric.floatValue } : {}),
    ...(typeof metric.doubleValue === "number" ? { doubleValue: metric.doubleValue } : {}),
    ...(typeof metric.booleanValue === "boolean" ? { booleanValue: metric.booleanValue } : {}),
    ...(text(metric.stringValue) === undefined ? {} : { stringValue: text(metric.stringValue) }),
    ...(bytes instanceof Uint8Array ? { bytesValue: bytes } : {}),
    ...(metric.isNull === true ? { isNull: true } : {}),
  };
}

function definitionsOf(payload: DecodedMessage): readonly MetricDefinition[] {
  const out: MetricDefinition[] = [];
  for (const metric of asMessages(payload.metrics)) {
    const name = text(metric.name);
    const datatype = datatypeOf(metric);
    // A definition with no name or no datatype defines nothing: a value read under a datatype that
    // was not declared is a value read under a guess, which SP-S7 refuses.
    if (name === undefined || datatype === undefined) continue;
    const alias = text(metric.alias);
    // THE VALUE THE BIRTH CARRIED IS KEPT, which is the fix a live read asked for: 4.1.1 says a
    // birth carries every metric with its current value, so dropping it loses a reading that
    // arrived. A metric that carried no value field at all keeps none - `readMetricValue` on an
    // empty wire would answer a mismatch, and a mismatch invented here would read as the
    // publisher's fault.
    const wire = wireValueOf(metric);
    const carried = Object.keys(wire).length > 0;
    const view = carried ? readMetricValue(datatype, wire) : undefined;
    const ts = text(metric.timestamp);
    out.push({
      name,
      ...(alias === undefined ? {} : { alias }),
      datatype,
      ...(view === undefined ? {} : { text: view.text }),
      ...(view?.problem === undefined ? {} : { problem: view.problem }),
      ...(ts === undefined ? {} : { timestamp: ts }),
      ...(metric.isNull === true ? { isNull: true } : {}),
    });
  }
  return out;
}

/** The birth-death sequence a payload declares, or nothing when it declares it twice. */
function bdSeqOf(payload: DecodedMessage): { value?: string; ambiguous: boolean } {
  const carrying = asMessages(payload.metrics).filter((metric) => text(metric.name) === "bdSeq");
  if (carrying.length > 1) return { ambiguous: true };
  const metric = carrying[0];
  if (metric === undefined) return { ambiguous: false };
  // The value sits in whichever typed field the edge node used. 5.3 makes it an Int64/UInt64, and
  // both decode to text here, so the long field is read first and the int field accepted after it.
  const value = text(metric.longValue) ?? text(metric.intValue);
  return value === undefined ? { ambiguous: false } : { value, ambiguous: false };
}

function originOf(topic: NodeTopic): DefinitionOrigin {
  // A stored certificate is the copy the server had at subscribe time, so its values are birth-time
  // values (10.1.4). A birth that arrived during the read is live. `rebirth` is not inferred here:
  // this provider never asks for one, so it cannot tell a rebirth from an ordinary reconnect, and
  // naming it would be a guess about why the node published.
  return topic.stored ? "stored" : "live";
}

/** Fold one read's messages into the state the panels answer from. */
export function foldMessages(messages: readonly ReceivedMessage[]): FoldOutcome {
  const state = new ReadState();
  const unresolved: UnresolvedValue[] = [];
  const refusals: Record<string, number> = {};
  const rejectedTopics: Record<string, number> = {};
  let ambiguousBdSeq = 0;

  for (const message of messages) {
    const topic = parseTopic(message.topic);
    if (topic.kind === "rejected") {
      rejectedTopics[topic.reason] = (rejectedTopics[topic.reason] ?? 0) + 1;
      continue;
    }

    // A message kept without its payload is one the byte cap stopped: its topic still proves the
    // node exists, so the node is created and nothing is claimed about its contents.
    if (message.payload === undefined) {
      if (topic.kind === "node") state.node(topic.groupId, topic.edgeNodeId);
      continue;
    }

    // STATE IS READ BEFORE ANYTHING IS DECODED, and getting that order wrong is the defect this
    // comment replaced. A STATE message's body is JSON (6.4.27, Sparkplug 3.0), not a protobuf
    // payload, so feeding it to the protobuf reader refused every STATE message there was. The
    // comment beside the old code said "STATE carries a JSON body" while the code one line above
    // had already handed it to the protobuf decoder: the claim was right and the order was wrong.
    if (topic.kind === "host-state") {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(message.payload));
      } catch {
        // NAMED FOR WHAT THIS READER DID, NOT FOR WHAT THE PUBLISHER GOT WRONG. 3.0 makes a STATE
        // body JSON, but a label that says "not JSON" is a verdict on somebody else's system, and an
        // operator reading it would take it to their vendor. Sparkplug 2.2 carried host state as the
        // plain strings `ONLINE` and `OFFLINE` (2.2 section 7.5), so a body this reader cannot parse
        // is not automatically a malformed one.
        const reason = "a STATE body this reader could not read as JSON";
        refusals[reason] = (refusals[reason] ?? 0) + 1;
        continue;
      }
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      // A host's own state is held as the read saw it, and is NEVER turned into liveness for an edge
      // node: a host application going offline is not a node going quiet, and 5.10 makes the two
      // related only in that nodes react to it.
      state.hostStates.set(topic.hostId, {
        ...(typeof record.online === "boolean" ? { online: record.online } : {}),
        ...(record.timestamp === undefined ? {} : { timestamp: String(record.timestamp) }),
      });
      continue;
    }

    let payload: DecodedMessage;
    try {
      payload = decodePayload(message.payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unreadable";
      refusals[reason] = (refusals[reason] ?? 0) + 1;
      continue;
    }

    switch (topic.messageType) {
      case "NBIRTH":
      case "DBIRTH": {
        const { value, ambiguous } = bdSeqOf(payload);
        if (ambiguous) ambiguousBdSeq++;
        const record: BirthRecord = {
          origin: originOf(topic),
          ...(value === undefined ? {} : { bdSeq: value }),
          ...(text(payload.timestamp) === undefined ? {} : { payloadTimestamp: text(payload.timestamp) }),
          receivedAt: message.receivedAt,
          metrics: definitionsOf(payload),
        };
        state.takeBirth(topic, record);
        break;
      }

      case "NDEATH":
      case "DDEATH": {
        const { value, ambiguous } = bdSeqOf(payload);
        if (ambiguous) ambiguousBdSeq++;
        state.takeDeath(topic, value, message.receivedAt);
        break;
      }

      case "NDATA":
      case "DDATA": {
        const seq = Number(text(payload.seq) ?? "");
        if (Number.isInteger(seq)) state.takeSeq(topic, seq);
        for (const metric of asMessages(payload.metrics)) {
          // 6.4.6 lets a data message carry either a name or an alias. A metric that carries its own
          // name needs no certificate to be named; one that carries an alias needs the birth.
          // AN EMPTY NAME IS NOT A NAME, and an end-to-end read against a real socket is what showed
          // it. A publisher may set the name field to the empty string instead of leaving it out, and
          // reading that as "this metric names itself" stores the value under "" and leaves the
          // metric the certificate DID name with no value at all. Every unit test built its payloads
          // by omitting the field, so none of them could reach this.
          const named = text(metric.name);
          const carried = named === undefined || named === "" ? undefined : named;
          const observed = carried === undefined ? state.resolve(topic, text(metric.alias)) : undefined;
          if (observed?.unresolved === true) {
            unresolved.push({
              groupId: topic.groupId,
              edgeNodeId: topic.edgeNodeId,
              ...(topic.deviceId === undefined ? {} : { deviceId: topic.deviceId }),
              ...(observed.alias === undefined ? {} : { alias: observed.alias }),
              receivedAt: message.receivedAt,
            });
          }

          // THE VALUE IS READ UNDER ITS DECLARED DATATYPE AND NEVER UNDER THE FIELD THAT CARRIED IT.
          // 6.4.6 says a data message cannot name or type its own values, so the datatype comes from
          // the certificate wherever one named this metric; a metric carrying its own name may also
          // carry its own datatype, and that is the only case where the message is the authority.
          const datatype = observed?.datatype ?? datatypeOf(metric);
          const name = carried ?? observed?.name;
          if (datatype === undefined) continue;
          const view = readMetricValue(datatype, wireValueOf(metric));
          state.takeValue(topic, {
            ...(name === undefined ? {} : { name }),
            ...(text(metric.alias) === undefined ? {} : { alias: text(metric.alias) }),
            datatype,
            text: view.text,
            ...(view.problem === undefined ? {} : { problem: view.problem }),
            ...(text(metric.timestamp) === undefined ? {} : { timestamp: text(metric.timestamp) }),
            isHistorical: metric.isHistorical === true,
            isTransient: metric.isTransient === true,
            isNull: metric.isNull === true,
            ...(qualityOf(metric) === undefined ? {} : { quality: qualityOf(metric) }),
            receivedAt: message.receivedAt,
          });
        }
        break;
      }

      default:
        // NCMD, DCMD and STATE in the message-type position. A command is something another client
        // sent, and this provider reports that it saw one rather than acting on it: counting it as
        // traffic from the node would make a write by someone else look like the node publishing.
        break;
    }
  }

  state.noteUnresolved(unresolved.length);
  return { state, unresolved, refusals, rejectedTopics, ambiguousBdSeq };
}
