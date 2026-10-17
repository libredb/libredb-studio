/**
 * A bounded reader for the Sparkplug B payload, written here rather than taken from a package.
 *
 * WHY IT IS OURS. MEASURED by this session on 2026-10-13 under Bun 1.4.2 and Node 24.14.0, on a
 * valid 14-metric NBIRTH built with protobufjs 7.6.6 over Eclipse Tahu's `sparkplug_b.proto`
 * (SHA-256 `4432c5c483b7fb9732d0594c98a2e97dca5e517e39c5374a8b918d837f0b4a19`): of the four
 * published Sparkplug codecs on npm, `sparkplug-payload` 1.0.3 and `@nortech/sparkplug-payload`
 * 1.1.0 refuse the whole payload (`Invalid DataSetValue: {"intValue":1}`),
 * `@jcoreio/sparkplug-payload` 3.1.3 refuses it on the array (`invalid type: 24`), and
 * `@joyautomation/sparkplug-payload` 1.0.7 returns the Int32Array as `null` WITH NO ERROR, which
 * is the worst of the four because nothing tells the caller a value was lost. None of the four
 * contains array-unpacking code at all: every file naming an array datatype in them is a
 * generated descriptor or a type declaration. (The decoder choice is the maintainer's; this module
 * is what the measurements point at, not a decision this session took.)
 *
 * WHY IT IS BOUNDED DURING THE WALK rather than after it. MEASURED the same day: protobufjs 7.6.6
 * decodes 4 MiB of empty metrics in full, in 60 to 61 ms, growing RSS by 115 MB under Bun and
 * 30 MB under Node; asking it for an object as well takes 251 to 368 ms and 497 MB / 109 MB. The
 * specification bounds nothing but MQTT's 256 MB (6.1), metrics are "Repeated forever - no limit
 * in Google Protobufs" (6.4.1), and Template and PropertySet nesting have no stated depth
 * (6.4.9, 6.4.14). A reader that materialises first turns one 8 MiB message into hundreds of
 * megabytes, which is SP-S5's reason for existing.
 *
 * THE CEILING THIS CANNOT EXCEED. MEASURED the same day, and the number is not the one the
 * proposal carries: protobufjs 7.6.6 accepts 49 Sparkplug template levels and refuses 50, under
 * both runtimes. Its documented limit is 100, but that limit counts PROTOBUF MESSAGES and one
 * Sparkplug template level costs two of them (a `Metric` holding a `Template`). Any cap chosen
 * here therefore has to sit below 49 levels to stay inside what the reference reader can also
 * read, and `DEFAULT_LIMITS` is checked against that ceiling by a test.
 *
 * A TRAP WORTH WRITING DOWN, measured while building the test data: protobufjs's own
 * `fromObject` cannot BUILD a deeply nested payload. At 100 levels it overflows the stack under
 * both runtimes (`Template$fromObject` recursing into `Metric$fromObject`). Deep test data is
 * built by hand, byte by byte, which is what `decode.test.ts` does.
 *
 * Pure. Takes bytes, returns a tree of plain values or a refusal that names its bound. No I/O.
 */

import { QueryError } from "@/lib/db/errors";
import {
  MAX_FIELD_BYTES,
  MAX_MESSAGE_DEPTH,
  MAX_MESSAGES_PER_PAYLOAD,
  MAX_METRICS_PER_PAYLOAD,
  MEASURED_PROTOBUFJS_LEVEL_CEILING,
} from "./constants";

/** Protobuf wire types. 3 and 4 are the deprecated group markers, which this reader refuses. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_GROUP_START = 3;
const WIRE_GROUP_END = 4;
const WIRE_FIXED32 = 5;

/** How a field's bytes are read, once its wire type is known to match. */
type FieldKind =
  | "uint64-text"
  | "uint32-text"
  | "bool"
  | "string"
  | "bytes"
  | "float"
  | "double"
  | { message: MessageName };

interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  /** True for a `repeated` field, which collects into an array instead of overwriting. */
  readonly repeated?: boolean;
}

type MessageName =
  | "Payload"
  | "Metric"
  | "MetaData"
  | "PropertySet"
  | "PropertyValue"
  | "PropertySetList"
  | "DataSet"
  | "Row"
  | "DataSetValue"
  | "Template"
  | "Parameter";

/**
 * The schema, by field number, read off Tahu's `sparkplug_b.proto` at the digest above.
 *
 * A table rather than generated code, so that a drift test can hold every row to the vendored
 * `.proto` and fail when upstream moves a field. Field numbers absent here are skipped as unknown,
 * which is what 6.4.1's extension fields and a future minor version both look like on the wire.
 */
// `satisfies` ON THE LITERAL, NOT A TYPE ON THE BINDING, AND THE DIFFERENCE IS MEASURED. Written as
// `const SCHEMA: Readonly<Record<MessageName, ...>> = Object.freeze({...})` the compiler catches a
// MISSING message and says nothing about an EXTRA one: the annotation sits on the binding and
// `Object.freeze`'s return is not a fresh object literal, so excess-property checking never runs.
// Measured both ways on this very record: a bogus `Uydurma: {}` entry compiled with 0 errors, while
// removing `PropertySetList` gave 1. With `satisfies` inside the call the literal is fresh and both
// directions fail.
const SCHEMA = Object.freeze({
  Payload: {
    1: { name: "timestamp", kind: "uint64-text" },
    2: { name: "metrics", kind: { message: "Metric" }, repeated: true },
    3: { name: "seq", kind: "uint64-text" },
    4: { name: "uuid", kind: "string" },
    5: { name: "body", kind: "bytes" },
  },
  Metric: {
    1: { name: "name", kind: "string" },
    2: { name: "alias", kind: "uint64-text" },
    3: { name: "timestamp", kind: "uint64-text" },
    4: { name: "datatype", kind: "uint32-text" },
    5: { name: "isHistorical", kind: "bool" },
    6: { name: "isTransient", kind: "bool" },
    7: { name: "isNull", kind: "bool" },
    8: { name: "metadata", kind: { message: "MetaData" } },
    9: { name: "properties", kind: { message: "PropertySet" } },
    10: { name: "intValue", kind: "uint32-text" },
    11: { name: "longValue", kind: "uint64-text" },
    12: { name: "floatValue", kind: "float" },
    13: { name: "doubleValue", kind: "double" },
    14: { name: "booleanValue", kind: "bool" },
    15: { name: "stringValue", kind: "string" },
    16: { name: "bytesValue", kind: "bytes" },
    17: { name: "datasetValue", kind: { message: "DataSet" } },
    18: { name: "templateValue", kind: { message: "Template" } },
  },
  MetaData: {
    1: { name: "isMultiPart", kind: "bool" },
    2: { name: "contentType", kind: "string" },
    3: { name: "size", kind: "uint64-text" },
    4: { name: "seq", kind: "uint64-text" },
    5: { name: "fileName", kind: "string" },
    6: { name: "fileType", kind: "string" },
    7: { name: "md5", kind: "string" },
    8: { name: "description", kind: "string" },
  },
  PropertySet: {
    1: { name: "keys", kind: "string", repeated: true },
    2: { name: "values", kind: { message: "PropertyValue" }, repeated: true },
  },
  PropertyValue: {
    1: { name: "type", kind: "uint32-text" },
    2: { name: "isNull", kind: "bool" },
    3: { name: "intValue", kind: "uint32-text" },
    4: { name: "longValue", kind: "uint64-text" },
    5: { name: "floatValue", kind: "float" },
    6: { name: "doubleValue", kind: "double" },
    7: { name: "booleanValue", kind: "bool" },
    8: { name: "stringValue", kind: "string" },
    9: { name: "propertysetValue", kind: { message: "PropertySet" } },
    10: { name: "propertysetsValue", kind: { message: "PropertySetList" } },
  },
  PropertySetList: {
    1: { name: "propertyset", kind: { message: "PropertySet" }, repeated: true },
  },
  DataSet: {
    1: { name: "numOfColumns", kind: "uint64-text" },
    2: { name: "columns", kind: "string", repeated: true },
    3: { name: "types", kind: "uint32-text", repeated: true },
    4: { name: "rows", kind: { message: "Row" }, repeated: true },
  },
  Row: {
    1: { name: "elements", kind: { message: "DataSetValue" }, repeated: true },
  },
  DataSetValue: {
    1: { name: "intValue", kind: "uint32-text" },
    2: { name: "longValue", kind: "uint64-text" },
    3: { name: "floatValue", kind: "float" },
    4: { name: "doubleValue", kind: "double" },
    5: { name: "booleanValue", kind: "bool" },
    6: { name: "stringValue", kind: "string" },
  },
  Template: {
    1: { name: "version", kind: "string" },
    2: { name: "metrics", kind: { message: "Metric" }, repeated: true },
    3: { name: "parameters", kind: { message: "Parameter" }, repeated: true },
    4: { name: "templateRef", kind: "string" },
    5: { name: "isDefinition", kind: "bool" },
  },
  Parameter: {
    1: { name: "name", kind: "string" },
    2: { name: "type", kind: "uint32-text" },
    3: { name: "intValue", kind: "uint32-text" },
    4: { name: "longValue", kind: "uint64-text" },
    5: { name: "floatValue", kind: "float" },
    6: { name: "doubleValue", kind: "double" },
    7: { name: "booleanValue", kind: "bool" },
    8: { name: "stringValue", kind: "string" },
  },
} satisfies Record<MessageName, Readonly<Record<number, FieldSpec>>>);

/**
 * The same record under its declared type, for the lookups that index it with a plain `number`.
 *
 * `satisfies` keeps the literal's own narrow type, which is what makes the excess-property check
 * work, and that narrow type cannot be indexed by an arbitrary field number. One alias gives both:
 * the literal above is checked in both directions, and every lookup goes through this view.
 */
const FIELDS: Readonly<Record<MessageName, Readonly<Record<number, FieldSpec>>>> = SCHEMA;

export interface DecodeLimits {
  /**
   * How deep the walk may go, in PROTOBUF MESSAGES, counting the Payload as the first.
   *
   * One Sparkplug template level costs two messages, so this number halves into levels. The value
   * itself is not settled: section 6 item 6 of the proposal measures the deepest real nesting
   * (an Ignition user-defined type inside another) before it is chosen, and until then this is a
   * default rather than an answer. What IS settled is the ceiling: it must leave the reader inside
   * what protobufjs 7.6.6 can also read, which was measured at 49 Sparkplug levels.
   */
  readonly maxMessageDepth: number;
  /** How many messages the whole walk may visit, which bounds breadth rather than depth. */
  readonly maxMessages: number;
  /** How many metrics one payload may carry, counted across nesting. */
  readonly maxMetrics: number;
  /** The largest `bytes` or `string` field this reader will materialise. */
  readonly maxFieldBytes: number;
}

/**
 * The default bounds, each one a default and not a measured answer (section 6 item 6).
 *
 * 32 messages is 16 Sparkplug template levels, which is the depth the proposal's prototype used;
 * it sits far below the measured 49-level ceiling, and `decode.test.ts` holds that relationship so
 * a later widening cannot cross it unnoticed.
 */
export const DEFAULT_LIMITS: DecodeLimits = Object.freeze({
  maxMessageDepth: MAX_MESSAGE_DEPTH,
  maxMessages: MAX_MESSAGES_PER_PAYLOAD,
  maxMetrics: MAX_METRICS_PER_PAYLOAD,
  maxFieldBytes: MAX_FIELD_BYTES,
});

export { MEASURED_PROTOBUFJS_LEVEL_CEILING };

export type RefusalReason =
  | "truncated"
  | "declared-length-past-end"
  | "group-wire-type"
  | "unknown-wire-type"
  | "depth-cap"
  | "message-cap"
  | "metric-cap"
  | "field-too-large"
  | "varint-too-long";

/**
 * A refusal, raised as a `QueryError` so the sentence it carries reaches the user.
 *
 * THE FIRST VERSION OF THIS CLASS EXTENDED `Error`, AND THAT WAS A REAL DEFECT, not a style
 * choice. A sibling session measured the shipped handling: `providers/platform/kubernetes/objects.ts`
 * converts a failure into `{ unavailable: error.message }` only for `QueryError` and
 * `TimeoutError`, and `isQueryError` in `src/lib/db/errors.ts` is an `instanceof QueryError`. A
 * refusal raised as a plain `Error` therefore passes through as an unexpected failure and the
 * sentence naming the bound it hit never reaches anybody. Every bound in this module exists to be
 * read by a user, so raising one in a form nothing translates removes the whole point of refusing
 * instead of returning something empty.
 *
 * `reason` stays, because a caller that wants to branch on the bound should branch on a field and
 * not on a message.
 *
 * THE PROTOTYPE LINE IS LOAD-BEARING. Nine classes in `src/lib/db/errors.ts` end their constructor
 * with `Object.setPrototypeOf(this, <ThatClass>.prototype)`, which sets the prototype of the object
 * BEING CONSTRUCTED to the base's own. A subclass that does not put its prototype back is not an
 * instance of itself: measured by a sibling session, `new Naive("x") instanceof Naive` is false and
 * `constructor.name` reads as the BASE class's name, so a log line does not show the mistake
 * either. The line below is why `payloadRefused instanceof PayloadRefused` is true.
 */
export class PayloadRefused extends QueryError {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    // The provider argument is deliberately not passed: it takes a `DatabaseType`, and
    // "sparkplug" is not a member of that union until the registration lands.
    super(message);
    this.name = "PayloadRefused";
    Object.setPrototypeOf(this, PayloadRefused.prototype);
  }
}

export type DecodedValue = string | boolean | number | Uint8Array | DecodedMessage | DecodedValue[];
export interface DecodedMessage {
  [field: string]: DecodedValue;
}

/** A cursor over the payload. Nothing is copied until a length has been checked against the end. */
class Reader {
  private at = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: DecodeLimits,
    /**
     * The counters, SHARED across every message of one payload.
     *
     * THEY USED TO LIVE ON THIS CLASS, AND THAT WAS A REAL DEFECT. A `Reader` is built per message,
     * so a counter held here restarted at every nested message: the message cap could never trip
     * at all, and the metric cap counted metrics per message rather than per payload. MEASURED on
     * 13 October 2026, before the fix: a payload of 201 messages decoded in full under a cap of 5,
     * and a payload of 100 metrics across ten templates decoded in full under a cap of 10. The
     * comments on both constants said "per payload" while the code did "per message", so the
     * comment was the aspiration and the code was the behaviour.
     *
     * The literal values were pinned by tests the whole time, which is why this survived: lowering
     * the message cap turned exactly one test red, and that test was the one asserting the number.
     * The mechanism had no test at all.
     */
    private readonly budget: { messages: number; metrics: number },
  ) {}

  get left(): number {
    return this.bytes.length - this.at;
  }

  byte(): number {
    if (this.at >= this.bytes.length) throw new PayloadRefused("truncated", "the payload ends inside a field");
    return this.bytes[this.at++];
  }

  /**
   * A base-128 varint as a BigInt.
   *
   * Capped at ten groups because that is the longest a 64-bit value can take; an eleventh group
   * means the bytes are not a varint, and reading on would walk the rest of the payload one bit
   * at a time.
   */
  varint(): bigint {
    let out = BigInt(0);
    let shift = BigInt(0);
    for (let group = 0; group < 10; group++) {
      const b = this.byte();
      out |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return out;
      shift += BigInt(7);
    }
    throw new PayloadRefused("varint-too-long", "a varint ran past ten groups, so it is not one");
  }

  fixed(width: 4 | 8): Uint8Array {
    if (this.left < width) throw new PayloadRefused("truncated", `a fixed${width * 8} field ends past the payload`);
    const out = this.bytes.subarray(this.at, this.at + width);
    this.at += width;
    return out;
  }

  /**
   * Take `length` bytes, having first checked the length against what is LEFT.
   *
   * This is the check that keeps a 16-byte payload declaring a 2-gigabyte field from allocating
   * anything: measured, protobufjs answers that payload with `index out of range`, and this reader
   * answers it by naming the bound instead.
   */
  take(length: bigint): Uint8Array {
    if (length > BigInt(this.limits.maxFieldBytes)) {
      throw new PayloadRefused(
        "field-too-large",
        `a field declares ${length} bytes, past the ${this.limits.maxFieldBytes}-byte field bound`,
      );
    }
    const want = Number(length);
    if (want > this.left) {
      throw new PayloadRefused(
        "declared-length-past-end",
        `a field declares ${want} bytes with ${this.left} left in the payload`,
      );
    }
    const out = this.bytes.subarray(this.at, this.at + want);
    this.at += want;
    return out;
  }

  countMessage(): void {
    this.budget.messages++;
    if (this.budget.messages > this.limits.maxMessages) {
      throw new PayloadRefused("message-cap", `the payload holds more than ${this.limits.maxMessages} messages`);
    }
  }

  countMetric(): void {
    this.budget.metrics++;
    if (this.budget.metrics > this.limits.maxMetrics) {
      throw new PayloadRefused("metric-cap", `the payload holds more than ${this.limits.maxMetrics} metrics`);
    }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

function readField(
  reader: Reader,
  spec: FieldSpec,
  wireType: number,
  limits: DecodeLimits,
  depth: number,
  budget: { messages: number; metrics: number },
): DecodedValue {
  switch (spec.kind) {
    case "uint64-text":
    case "uint32-text": {
      // Decimal text for every integer, 32-bit ones included, so no surface has to decide twice
      // which widths are safe as numbers. The value layer reads the text under its datatype.
      if (wireType !== WIRE_VARINT) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not a varint here`);
      return reader.varint().toString();
    }
    case "bool":
      if (wireType !== WIRE_VARINT) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not a varint here`);
      return reader.varint() !== BigInt(0);
    case "float": {
      if (wireType !== WIRE_FIXED32) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not fixed32 here`);
      const b = reader.fixed(4);
      return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
    }
    case "double": {
      if (wireType !== WIRE_FIXED64) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not fixed64 here`);
      const b = reader.fixed(8);
      return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
    }
    case "string": {
      if (wireType !== WIRE_LENGTH) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not delimited here`);
      // Lenient on purpose at THIS layer: a name or value that is not UTF-8 must reach the value
      // layer as bytes so it can be shown as hex with a notice (SP-S11). Refusing here would lose
      // the whole payload over one bad string.
      return utf8.decode(reader.take(reader.varint()));
    }
    case "bytes":
      if (wireType !== WIRE_LENGTH) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not delimited here`);
      return reader.take(reader.varint()).slice();
    default: {
      if (wireType !== WIRE_LENGTH) throw new PayloadRefused("unknown-wire-type", `${spec.name} is not delimited here`);
      const inner = reader.take(reader.varint());
      return walk(inner, spec.kind.message, limits, depth + 1, budget);
    }
  }
}

function skipField(reader: Reader, wireType: number): void {
  switch (wireType) {
    case WIRE_VARINT:
      reader.varint();
      return;
    case WIRE_FIXED64:
      reader.fixed(8);
      return;
    case WIRE_FIXED32:
      reader.fixed(4);
      return;
    case WIRE_LENGTH:
      reader.take(reader.varint());
      return;
    case WIRE_GROUP_START:
    case WIRE_GROUP_END:
      // Groups were removed from proto3 and the Sparkplug schema is proto2 without them. A group
      // marker is either a corrupt payload or a different schema, and skipping one correctly means
      // matching start to end, which is a second parser. Refused instead (SP-S5).
      throw new PayloadRefused("group-wire-type", "the payload uses protobuf groups, which this reader refuses");
    default:
      throw new PayloadRefused("unknown-wire-type", `wire type ${wireType} is not one of the five`);
  }
}

function walk(
  bytes: Uint8Array,
  message: MessageName,
  limits: DecodeLimits,
  depth: number,
  budget: { messages: number; metrics: number },
): DecodedMessage {
  if (depth > limits.maxMessageDepth) {
    throw new PayloadRefused(
      "depth-cap",
      `nesting deeper than ${limits.maxMessageDepth} messages, which is ${Math.floor(limits.maxMessageDepth / 2)} template levels`,
    );
  }
  const reader = new Reader(bytes, limits, budget);
  reader.countMessage();
  const out: DecodedMessage = {};
  const fields = FIELDS[message];

  while (reader.left > 0) {
    const tag = reader.varint();
    const fieldNumber = Number(tag >> BigInt(3));
    const wireType = Number(tag & BigInt(7));
    // THE WIRE TYPE IS CHECKED BEFORE THE FIELD IS LOOKED UP, and the order matters for the
    // message a user sees. The first draft looked the field up first, so a group marker on a known
    // field was reported as "wire type does not match this field" and the real cause, a payload
    // using protobuf groups, was never named. Its own test caught that.
    if (wireType === WIRE_GROUP_START || wireType === WIRE_GROUP_END) {
      throw new PayloadRefused("group-wire-type", "the payload uses protobuf groups, which this reader refuses");
    }
    if (
      wireType !== WIRE_VARINT &&
      wireType !== WIRE_FIXED64 &&
      wireType !== WIRE_LENGTH &&
      wireType !== WIRE_FIXED32
    ) {
      throw new PayloadRefused("unknown-wire-type", `wire type ${wireType} is not one of the five`);
    }

    const spec = fields[fieldNumber];
    if (spec === undefined) {
      // Unknown and extension fields are skipped rather than refused: 6.4.1 reserves extension
      // fields, and a future minor version looks exactly like this on the wire.
      skipField(reader, wireType);
      continue;
    }
    if (message === "Payload" && spec.name === "metrics") reader.countMetric();
    if (message === "Template" && spec.name === "metrics") reader.countMetric();
    const value = readField(reader, spec, wireType, limits, depth, budget);
    if (spec.repeated === true) {
      const held = out[spec.name];
      if (Array.isArray(held)) held.push(value);
      else out[spec.name] = [value];
      continue;
    }
    out[spec.name] = value;
  }
  return out;
}

/**
 * Read one Sparkplug payload.
 *
 * Throws `PayloadRefused` with the bound it hit, so the read can report the skip with its topic
 * rather than dropping the message silently. Nothing partial is returned: a payload is either
 * read whole or named as refused, because a half-read birth would define metrics that are not
 * there (SP-S7).
 */
export function decodePayload(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): DecodedMessage {
  // One budget per payload, threaded through every nested message. See the note on `Reader`.
  return walk(bytes, "Payload", limits, 1, { messages: 0, metrics: 0 });
}

/** The message names the schema table covers, for the drift test that holds it to the `.proto`. */
export function schemaMessageNames(): readonly MessageName[] {
  return Object.freeze(Object.keys(SCHEMA) as MessageName[]);
}

/** Every field of one message, for the same drift test. */
export function schemaFields(message: MessageName): Readonly<Record<number, FieldSpec>> {
  return FIELDS[message];
}
