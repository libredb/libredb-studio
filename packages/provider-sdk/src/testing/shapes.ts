/**
 * The closed shape of every part of every frame the memory test transport carries (docs/providers/CONTRACT.md, clause
 * C-20).
 *
 * Each part of a call's frame is read as the call type it carries: a record names every member of its type, required
 * or optional as the type has it, and refuses any other key; a value is read by type, and a vocabulary the types state
 * only as a union is read against a `Record<Union, true>` literal, so a member added to a call type, or to one of its
 * unions, fails typecheck here until its reader names it. Each record reader is declared as `ShapeOf` its type, a
 * mapped type that requires one entry per member, marked `required` or `optional` as the member is: a member is
 * optional exactly when the type admits a value without it.
 *
 * A reader reads a value `decodeValue` produced, so every record is a plain object and every list dense and no longer
 * than the frame text. It still reads every key by its own descriptor, never calling a getter, and stops a list at its
 * first hole, so a value no frame produced is refused by name rather than walked to its length.
 */
import { isPlainRecord, pointerTo, readOwn } from "../calls/records";
import type {
  AdmittedHostPaths,
  BatchLimit,
  CallContext,
  CancelAnswer,
  CancelRequest,
  Column,
  ConnectionFieldValues,
  EgressDecision,
  EndScopeAnswer,
  EndScopeRequest,
  ExecuteAnswer,
  ExecuteRequest,
  OpenAnswer,
  OpenContext,
  OpenPolicy,
  PageBound,
  PoolSettings,
  RowBatch,
  TlsSettings,
  TrustMaterial,
  TunnelFarEnd,
  VectorColumnShape,
  Warning,
} from "../calls/types";
import type { FramePart, FrameRefusal, ServedCall } from "./frames";

/** One refusal a reader finds, before the call and the part are named. */
interface Found {
  readonly rule: "frame-key-unknown" | "frame-key-missing" | "frame-value-unreadable";
  readonly pointer: string;
  readonly name?: string;
}

/** Reads `value`, at `pointer` into its part, adding every refusal to `found`. */
type Reader = (value: unknown, pointer: string, found: Found[]) => void;

interface Required {
  readonly required: Reader;
}

interface Optional {
  readonly optional: Reader;
}

/** One entry per member of `T`, `required` or `optional` as the member is. */
export type ShapeOf<T> = { readonly [K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? Optional : Required };

/** The data a context carries in a frame: everything but its host services, `signal` and `env`. */
export type ContextData<C extends CallContext> = Omit<C, "signal" | "env">;

/** A result source as its descriptor crosses in an execute answer: its id, its columns and the provider's row count. */
export interface ResultDescriptor {
  readonly result: string;
  readonly columns: readonly Column[];
  readonly rowCount?: number;
}

/** An open answer in its frame: the handle stays with the provider's side. */
export type OpenAnswerFrame = Omit<OpenAnswer<unknown>, "handle">;

/** An execute answer in its frame: each result source crosses as its descriptor. */
export type ExecuteAnswerFrame = Omit<ExecuteAnswer, "results"> & { readonly results: readonly ResultDescriptor[] };

/** The type of each part of each call's frame; a call with no such part has no key for it. */
export interface FrameShapes {
  readonly open: { readonly context: ContextData<OpenContext>; readonly answer: OpenAnswerFrame };
  readonly close: { readonly context: ContextData<CallContext> };
  readonly "console.execute": {
    readonly context: ContextData<CallContext>;
    readonly request: ExecuteRequest;
    readonly answer: ExecuteAnswerFrame;
  };
  readonly "console.cancel": {
    readonly context: ContextData<CallContext>;
    readonly request: CancelRequest;
    readonly answer: CancelAnswer;
  };
  readonly "console.endScope": {
    readonly context: ContextData<CallContext>;
    readonly request: EndScopeRequest;
    readonly answer: EndScopeAnswer;
  };
  readonly "result.next": { readonly request: BatchLimit; readonly answer: RowBatch };
  readonly "result.close": Readonly<Record<never, never>>;
}

/** The parts of `Call`'s frame. */
export type FramePartOf<Call extends ServedCall> = keyof FrameShapes[Call] & FramePart;

const unreadable = (pointer: string, found: Found[]): void => {
  found.push({ rule: "frame-value-unreadable", pointer });
};

/** A reader of the values `admits` answers true for. */
function value(admits: (value: unknown) => boolean): Reader {
  return (item, pointer, found) => {
    if (!admits(item)) unreadable(pointer, found);
  };
}

const text = value((item) => typeof item === "string");
const number = value((item) => typeof item === "number");
const boolean = value((item) => typeof item === "boolean");
const textOrNumber = value((item) => typeof item === "string" || typeof item === "number");
const exactlyTrue = value((item) => item === true);
/** Any value in the codec's domain: the decoder admitted it. */
const anyValue: Reader = () => {};

/** A reader of the strings `vocabulary` has as keys. */
function vocabulary<Union extends string>(words: Readonly<Record<Union, true>>): Reader {
  return value((item) => typeof item === "string" && Object.hasOwn(words, item));
}

function nullable(reader: Reader): Reader {
  return (item, pointer, found) => {
    if (item !== null) reader(item, pointer, found);
  };
}

/**
 * A reader of a list whose items `reader` reads. Items are read by index and by their own descriptors; the first hole
 * or accessor is refused and ends the list, so no loop runs to the length of a list no frame produced.
 */
function listOf(reader: Reader): Reader {
  return (item, pointer, found) => {
    if (!Array.isArray(item)) return unreadable(pointer, found);
    for (let index = 0; index < item.length; index += 1) {
      const at = pointerTo(pointer, index);
      const read = readOwn(item, String(index));
      if (read.kind !== "data") return unreadable(at, found);
      reader(read.value, at, found);
    }
  };
}

/**
 * A reader of a closed record of `shape`: every own key, enumerable or not, is one the shape defines, each required
 * key is present, and each member is a data property its reader admits. A getter is never called.
 */
function record<T>(shape: ShapeOf<T>): Reader {
  const entries: Readonly<Record<string, Required | Optional>> = shape;
  return (item, pointer, found) => {
    if (!isPlainRecord(item)) return unreadable(pointer, found);
    const keys = Object.getOwnPropertyNames(item);
    for (const key of keys) {
      const at = pointerTo(pointer, key);
      const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
      if (entry === undefined) {
        found.push({ rule: "frame-key-unknown", pointer: at, name: key });
        continue;
      }
      const read = readOwn(item, key);
      if (read.kind !== "data") unreadable(at, found);
      else ("required" in entry ? entry.required : entry.optional)(read.value, at, found);
    }
    for (const [key, entry] of Object.entries(entries)) {
      if ("required" in entry && !keys.includes(key)) {
        found.push({ rule: "frame-key-missing", pointer: pointerTo(pointer, key), name: key });
      }
    }
  };
}

/**
 * A reader of a record that is exactly one of two closed shapes, told apart by its keys: a record with a key of one
 * shape and none of the other is read as that shape, and any other value is refused at its pointer.
 */
function eitherRecord<A, B>(first: ShapeOf<A>, second: ShapeOf<B>): Reader {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  const readFirst = record(first);
  const readSecond = record(second);
  return (item, pointer, found) => {
    const keys = isPlainRecord(item) ? Object.getOwnPropertyNames(item) : [];
    const isFirst = keys.some((key) => firstKeys.includes(key));
    const isSecond = keys.some((key) => secondKeys.includes(key));
    if (isFirst === isSecond) return unreadable(pointer, found);
    (isFirst ? readFirst : readSecond)(item, pointer, found);
  };
}

const required = (reader: Reader): Required => ({ required: reader });
const optional = (reader: Reader): Optional => ({ optional: reader });

const TLS_MODES = Object.freeze<Record<TlsSettings["mode"], true>>({
  disable: true,
  require: true,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
});

const EGRESS_SOURCES = Object.freeze<Record<EgressDecision["source"], true>>({ default: true, set: true });

const VECTOR_KINDS = Object.freeze<Record<VectorColumnShape["kind"], true>>({
  dense: true,
  sparse: true,
  multi: true,
});

const VECTOR_DTYPES = Object.freeze<Record<VectorColumnShape["dtype"], true>>({
  float32: true,
  float64: true,
  float16: true,
  bfloat16: true,
  int8: true,
  uint8: true,
  binary: true,
});

const SPARSE_ENCODINGS = Object.freeze<Record<NonNullable<VectorColumnShape["sparseEncoding"]>, true>>({
  "index-map": true,
  "indices-values": true,
});

const OPEN_TRANSACTIONS = Object.freeze<Record<EndScopeAnswer["openTransaction"], true>>({
  none: true,
  "rolled-back": true,
});

/** One value of a connection field: a string, a number, a boolean or a list of strings. */
const connectionValue: Reader = (item, pointer, found) => {
  if (Array.isArray(item)) listOf(text)(item, pointer, found);
  else if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
    unreadable(pointer, found);
  }
};

const field = optional(connectionValue);

/** The connection's values, keyed by the contract's field names, every one optional. */
const CONNECTION = Object.freeze<ShapeOf<ConnectionFieldValues>>({
  host: field,
  port: field,
  connectionString: field,
  allowInsecureAuth: field,
  user: field,
  password: field,
  saslMechanism: field,
  authMethod: field,
  privateKey: field,
  privateKeyPassphrase: field,
  hostKeyFingerprint: field,
  database: field,
  dataServers: field,
  warehouse: field,
  location: field,
  region: field,
  namespaces: field,
  amqpPort: field,
  apiPath: field,
  tlsServerName: field,
  registerMap: field,
  securityMode: field,
  serverCertificateThumbprint: field,
  schema: field,
  role: field,
  authSource: field,
  apiKeyId: field,
  apiKeySecret: field,
  localDataCenter: field,
  serviceName: field,
  instanceName: field,
  securityPolicyUri: field,
  clientCertificatePath: field,
  clientPrivateKeyPath: field,
  agentReadRoots: field,
});

const callContext = record<ContextData<CallContext>>({ deadline: required(number) });

const openContext = record<ContextData<OpenContext>>({
  deadline: required(number),
  engine: required(text),
  connectionId: required(text),
  seedId: optional(text),
  connection: required(record<ConnectionFieldValues>(CONNECTION)),
  tunnelFarEnd: optional(record<TunnelFarEnd>({ host: required(text), port: required(number) })),
  tunnelRoute: optional(text),
  admittedFile: optional(text),
  admittedHostPaths: optional(
    record<AdmittedHostPaths>({ clientCertificatePath: optional(text), clientPrivateKeyPath: optional(text) }),
  ),
  tls: optional(
    record<TlsSettings>({
      mode: required(vocabulary(TLS_MODES)),
      caCert: optional(text),
      clientCert: optional(text),
      clientKey: optional(text),
      rejectUnauthorized: optional(boolean),
    }),
  ),
  egress: required(
    record<EgressDecision>({ blocksPrivateHosts: required(boolean), source: required(vocabulary(EGRESS_SOURCES)) }),
  ),
  trust: required(record<TrustMaterial>({ certificates: required(listOf(text)) })),
  policy: required(
    record<OpenPolicy>({
      readOnly: required(boolean),
      sendsStatements: required(boolean),
      allowExternalFileAccess: required(boolean),
      refuseWrites: required(boolean),
      managed: required(boolean),
      literalSeedFile: required(boolean),
    }),
  ),
  pool: optional(
    record<PoolSettings>({
      min: required(number),
      max: required(number),
      idleTimeout: required(number),
      acquireTimeout: required(number),
    }),
  ),
  timezone: optional(text),
});

const openAnswer = record<OpenAnswerFrame>({ serverVersion: optional(text), refine: optional(anyValue) });

const executeRequest = record<ExecuteRequest>({
  statement: required(text),
  runId: optional(text),
  params: optional(listOf(anyValue)),
  page: required(
    eitherRecord<Extract<PageBound, { limit: number }>, Extract<PageBound, { unlimited: true }>>(
      { limit: required(number), offset: required(number) },
      { unlimited: required(exactlyTrue) },
    ),
  ),
  scope: optional(text),
});

const column = record<Column>({
  name: required(text),
  type: optional(text),
  vector: optional(
    record<VectorColumnShape>({
      kind: required(vocabulary(VECTOR_KINDS)),
      dtype: required(vocabulary(VECTOR_DTYPES)),
      dimension: required(nullable(number)),
      sparseEncoding: optional(vocabulary(SPARSE_ENCODINGS)),
    }),
  ),
});

const executeAnswer = record<ExecuteAnswerFrame>({
  results: required(
    listOf(
      record<ResultDescriptor>({
        result: required(text),
        columns: required(listOf(column)),
        rowCount: optional(number),
      }),
    ),
  ),
  warnings: required(
    listOf(record<Warning>({ message: required(text), code: optional(textOrNumber), severity: optional(text) })),
  ),
  executionTimeMs: required(number),
  pageApplied: required(boolean),
  boundApplied: optional(exactlyTrue),
  explainPlan: optional(anyValue),
});

/** The reader of each part of each call's frame, typed so every part `FrameShapes` names has one. */
const READERS = Object.freeze<{
  readonly [Call in ServedCall]: { readonly [Part in keyof FrameShapes[Call]]: Reader };
}>({
  open: { context: openContext, answer: openAnswer },
  close: { context: callContext },
  "console.execute": { context: callContext, request: executeRequest, answer: executeAnswer },
  "console.cancel": {
    context: callContext,
    request: record<CancelRequest>({ runId: required(text) }),
    answer: record<CancelAnswer>({ cancelled: required(boolean) }),
  },
  "console.endScope": {
    context: callContext,
    request: record<EndScopeRequest>({ scope: required(text) }),
    answer: record<EndScopeAnswer>({ openTransaction: required(vocabulary(OPEN_TRANSACTIONS)) }),
  },
  "result.next": {
    request: record<BatchLimit>({ maxRows: required(number), maxBytes: required(number) }),
    answer: record<RowBatch>({ rows: required(listOf(listOf(anyValue))), done: required(boolean) }),
  },
  "result.close": {},
});

/**
 * Every way `value`, a decoded part of `call`'s frame, is not the closed shape of its type, each a refusal naming the
 * rule, the call, the part and a JSON Pointer into the part, in the order the value is read. A getter is never called,
 * and no refusal carries a value of the frame.
 */
export function readFrame<Call extends ServedCall>(
  call: Call,
  part: FramePartOf<Call>,
  value: unknown,
): readonly FrameRefusal[] {
  const readers: Readonly<Record<string, Reader>> = READERS[call];
  const found: Found[] = [];
  readers[part](value, "", found);
  return found.map(({ rule, pointer, name }) =>
    name === undefined ? { rule, call, part, pointer } : { rule, call, part, pointer, name },
  );
}
