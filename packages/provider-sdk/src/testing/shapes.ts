/**
 * The closed shape of every part of every frame the memory test transport carries (docs/providers/CONTRACT.md, clause
 * C-20).
 *
 * Each part of a call's frame is read as the call type it carries: a record names every member of its type, required
 * or optional as the type has it, and refuses any other key; a value is read by type, and a vocabulary the types state
 * only as a union is read against a `Record<Union, true>` literal, so a member added to a call type, or to one of its
 * unions, fails typecheck here until its reader names it. Each record reader is declared as `ShapeOf` its type, a
 * mapped type that requires one entry per member, marked `required` or `optional` as the member is: a member is
 * optional exactly when the type admits a value without it. A union of records is read as the one form its keys name,
 * a request that names its action or its panel as that action's or that panel's shape, a source part as the form its
 * `unavailable` and `statement` keys name, and a map with free keys, the tree's counts, key by key. A timestamp member is read as a valid `Date`, the value the codec decodes its timestamp to.
 *
 * A reader reads a value `decodeValue` produced, so every record is a plain object and every list dense and no longer
 * than the frame text. It still reads every key by its own descriptor, never calling a getter, and stops a list at its
 * first hole, so a value no frame produced is refused by name rather than walked to its length.
 */
import { isPlainRecord, pointerTo, readOwn } from "../calls/records";
import type { SessionState } from "../errors";
import type {
  AdmittedHostPaths,
  BatchLimit,
  CallContext,
  CancelAnswer,
  CancelRequest,
  Column,
  ActiveSession,
  ActiveSessionDetails,
  ColumnSchema,
  ConnectionFieldValues,
  Container,
  DatabaseObject,
  DatabaseOverview,
  EgressDecision,
  EndScopeAnswer,
  EndScopeRequest,
  ExclusionConstraintSchema,
  ExecuteAnswer,
  ExecuteRequest,
  ForeignKeySchema,
  HealthInfo,
  IndexSchema,
  IndexStats,
  KindCount,
  MaintenanceFact,
  MaintenancePreview,
  MaintenancePreviewRequest,
  MaintenanceRunAnswer,
  MaintenanceRunRequest,
  MonitoringActiveSessionsRequest,
  MonitoringIndexesRequest,
  MonitoringOverviewRequest,
  MonitoringPanel,
  MonitoringPanelAnswer,
  MonitoringPanelRequest,
  MonitoringPerformanceRequest,
  MonitoringSlowQueriesRequest,
  MonitoringStorageRequest,
  MonitoringTablesRequest,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectPartEdit,
  ObjectReadRange,
  ObjectSourceDocument,
  ObjectSourcePart,
  OpenAnswer,
  OpenContext,
  OpenPolicy,
  PageBound,
  PerformanceMetrics,
  PoolSettings,
  PoolStats,
  ReadBudget,
  ReadOnlyExecute,
  ReadOnlyMode,
  RowBatch,
  SessionActivity,
  SlowQuery,
  SlowQueryStats,
  SourceRequest,
  StorageStats,
  TableStats,
  TlsSettings,
  TransactionAnswer,
  TransactionRequest,
  TreeAction,
  TreeAnswer,
  TreeContainersAnswer,
  TreeContainersRequest,
  TreeCountAnswer,
  TreeCountRequest,
  TreeDescribeAnswer,
  TreeDescribeManyRequest,
  TreeDescribeRequest,
  TreeListAnswer,
  TreeListRequest,
  TreeRequest,
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

/** The data a pull's limit carries in a frame: its numbers, without the host's measure. */
export type BatchLimitData = Omit<BatchLimit, "measure">;

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
  readonly health: { readonly context: ContextData<CallContext>; readonly answer: HealthInfo };
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
  readonly "console.transaction": {
    readonly context: ContextData<CallContext>;
    readonly request: TransactionRequest;
    readonly answer: TransactionAnswer;
  };
  readonly "objects.tree": {
    readonly context: ContextData<CallContext>;
    readonly request: TreeRequest;
    readonly answer: TreeAnswer;
  };
  readonly "objects.source": {
    readonly context: ContextData<CallContext>;
    readonly request: SourceRequest;
    readonly answer: ObjectSourceDocument;
  };
  readonly "maintenance.run": {
    readonly context: ContextData<CallContext>;
    readonly request: MaintenanceRunRequest;
    readonly answer: MaintenanceRunAnswer;
  };
  readonly "maintenance.preview": {
    readonly context: ContextData<CallContext>;
    readonly request: MaintenancePreviewRequest;
    readonly answer: MaintenancePreview;
  };
  readonly "monitoring.panel": {
    readonly context: ContextData<CallContext>;
    readonly request: MonitoringPanelRequest;
    readonly answer: MonitoringPanelAnswer;
  };
  readonly "monitoring.poolStats": { readonly context: ContextData<CallContext>; readonly answer: PoolStats };
  readonly "result.next": { readonly request: BatchLimitData; readonly answer: RowBatch };
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
const exactlyFalse = value((item) => item === false);
/** A valid `Date`, a subclass included: what the value codec decodes a timestamp to. */
const timestamp = value((item) => item instanceof Date && !Number.isNaN(item.getTime()));
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
 * A reader of a record whose every own key, enumerable or not, is free, each a data property whose value `reader`
 * reads; a getter is never called, and any other value is refused at its pointer.
 */
function mapOf(reader: Reader): Reader {
  return (item, pointer, found) => {
    if (!isPlainRecord(item)) return unreadable(pointer, found);
    for (const key of Object.getOwnPropertyNames(item)) {
      const at = pointerTo(pointer, key);
      const read = readOwn(item, key);
      if (read.kind !== "data") unreadable(at, found);
      else reader(read.value, at, found);
    }
  };
}

/** One closed shape of a union of records: the keys its shape defines, and its reader. */
interface RecordForm {
  readonly keys: readonly string[];
  readonly read: Reader;
}

/** The form of the closed shape `shape`. */
function form<T>(shape: ShapeOf<T>): RecordForm {
  return { keys: Object.keys(shape), read: record(shape) };
}

/**
 * A reader of a record that is exactly one of `forms`, closed shapes whose keys are pairwise distinct, told apart by
 * its keys: a record with a key of exactly one form is read as that form, and any other value, a record with keys of
 * two forms or of none among them, is refused at its pointer.
 */
function oneOfRecords(forms: readonly RecordForm[]): Reader {
  return (item, pointer, found) => {
    const keys = isPlainRecord(item) ? Object.getOwnPropertyNames(item) : [];
    const [only, ...others] = forms.filter((candidate) => keys.some((key) => candidate.keys.includes(key)));
    if (only === undefined || others.length > 0) return unreadable(pointer, found);
    only.read(item, pointer, found);
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

/** The modes of a read-only execute, `READ_ONLY_MODES`, typed so every mode has a word. */
const READ_ONLY_MODE_WORDS = Object.freeze<Record<ReadOnlyMode, true>>({ execute: true, "estimate-plan": true });

const SESSION_STATE_WORDS = Object.freeze<Record<SessionState, true>>({
  "in-transaction": true,
  "not-in-transaction": true,
  unknown: true,
});

/** A transaction request that opens a transaction: the one action that may carry `requireReportedState`. */
type BeginRequest = Extract<TransactionRequest, { action: "begin" }>;

/** A transaction request of any other action, which carries nothing beside it. */
type OtherTransactionRequest = Exclude<TransactionRequest, BeginRequest>;

const readBegin = record<BeginRequest>({
  action: required(vocabulary<BeginRequest["action"]>(Object.freeze({ begin: true }))),
  requireReportedState: optional(exactlyTrue),
});

const readOtherAction = record<OtherTransactionRequest>({
  action: required(
    vocabulary<OtherTransactionRequest["action"]>(Object.freeze({ commit: true, rollback: true, state: true })),
  ),
});

/**
 * A transaction request, read as the closed shape of the action it names: a record whose `action` is the data value
 * `begin` is read as a begin, which may carry `requireReportedState`, and any other value as one of the other actions,
 * which refuses `requireReportedState` as a key it does not define and an `action` that is missing, an accessor or no
 * action. The `action` is read by its own descriptor, so a getter is never called.
 */
const transactionRequest: Reader = (item, pointer, found) => {
  const action = readOwn(item, "action");
  const isBegin = isPlainRecord(item) && action.kind === "data" && action.value === "begin";
  (isBegin ? readBegin : readOtherAction)(item, pointer, found);
};

const path = listOf(text);

/** The closed shape of each tree request, by the action it names. */
const TREE_REQUESTS = Object.freeze<{ readonly [Action in TreeAction]: Reader }>({
  containers: record<TreeContainersRequest>({
    action: required(vocabulary<TreeContainersRequest["action"]>(Object.freeze({ containers: true }))),
    parent: optional(path),
  }),
  count: record<TreeCountRequest>({
    action: required(vocabulary<TreeCountRequest["action"]>(Object.freeze({ count: true }))),
    container: required(path),
  }),
  list: record<TreeListRequest>({
    action: required(vocabulary<TreeListRequest["action"]>(Object.freeze({ list: true }))),
    container: required(path),
    kind: required(text),
  }),
  describe: record<TreeDescribeRequest>({
    action: required(vocabulary<TreeDescribeRequest["action"]>(Object.freeze({ describe: true }))),
    path: required(path),
    kind: required(text),
  }),
  describeMany: record<TreeDescribeManyRequest>({
    action: required(vocabulary<TreeDescribeManyRequest["action"]>(Object.freeze({ describeMany: true }))),
    container: required(path),
    kind: required(text),
    limit: optional(number),
    defaultSql: optional(exactlyTrue),
  }),
});

/**
 * A tree request, read as the closed shape of the action it names: a record whose `action` is the data value of one
 * of `TREE_ACTIONS` is read as that action's request, which refuses a member of another action as a key it does not
 * define. A record without `action` is refused as `frame-key-missing` there, and one whose `action` is an accessor or
 * no action as `frame-value-unreadable` there; any other value is refused at its pointer. The `action` is read by its
 * own descriptor, so a getter is never called.
 */
const treeRequest: Reader = (item, pointer, found) => {
  if (!isPlainRecord(item)) return unreadable(pointer, found);
  const read = readOwn(item, "action");
  const at = pointerTo(pointer, "action");
  if (read.kind === "absent") {
    found.push({ rule: "frame-key-missing", pointer: at, name: "action" });
    return;
  }
  const word = read.kind === "data" ? read.value : undefined;
  if (typeof word !== "string" || !Object.hasOwn(TREE_REQUESTS, word)) return unreadable(at, found);
  TREE_REQUESTS[word as TreeAction](item, pointer, found);
};

/** The form of a kind count read from a bounded sample, the one that says what bounded it. */
type SampledCount = Extract<KindCount, { readonly sampledFrom: string }>;

/** A counted kind: a count, and the sentence for what bounded it where it was read from a bounded sample. */
type CountedKind = Omit<SampledCount, "sampledFrom"> & Partial<Pick<SampledCount, "sampledFrom">>;

/** A kind count: the sentence of a refused read, or a count, with what bounded it where a sample did. */
const kindCount = eitherRecord<Extract<KindCount, { readonly unavailable: string }>, CountedKind>(
  { unavailable: required(text) },
  { count: required(number), sampledFrom: optional(text) },
);

const readRange = oneOfRecords([
  form<Extract<ObjectReadRange, { readonly key: string }>>({ key: required(text) }),
  form<Extract<ObjectReadRange, { readonly prefix: string }>>({ prefix: required(text) }),
  form<Extract<ObjectReadRange, { readonly start: string }>>({ start: required(text), end: required(text) }),
]);

const PROVENANCES = Object.freeze<Record<NonNullable<ColumnSchema["provenance"]>, true>>({ sampled: true });

const columnSchema = record<ColumnSchema>({
  name: required(text),
  type: required(text),
  baseType: optional(text),
  declaredType: optional(text),
  nullable: required(boolean),
  isPrimary: required(boolean),
  defaultValue: optional(text),
  defaultExpression: optional(text),
  provenance: optional(vocabulary(PROVENANCES)),
  projectable: optional(boolean),
});

const indexSchema = record<IndexSchema>({
  name: required(text),
  columns: required(listOf(text)),
  unique: required(boolean),
});

const unavailableIndexes = record<Extract<ObjectDetail["indexes"], { readonly unavailable: string }>>({
  unavailable: required(text),
});

/** An object's indexes: a list of indexes, or the engine's sentence for a read that was refused. */
const indexes: Reader = (item, pointer, found) => {
  if (Array.isArray(item)) listOf(indexSchema)(item, pointer, found);
  else unavailableIndexes(item, pointer, found);
};

const objectDetail = record<ObjectDetail>({
  path: required(path),
  columns: required(listOf(columnSchema)),
  indexes: required(indexes),
  foreignKeys: required(
    listOf(
      record<ForeignKeySchema>({
        columnName: required(text),
        referencedTable: required(text),
        referencedColumn: required(text),
      }),
    ),
  ),
  exclusionConstraints: optional(
    listOf(record<ExclusionConstraintSchema>({ name: required(text), definition: required(text) })),
  ),
});

/**
 * A tree answer, exactly one of its five forms, told apart by its keys. The frame reader reads shapes only: which form
 * answers which action is the host's answer reader's.
 */
const treeAnswer = oneOfRecords([
  form<TreeContainersAnswer>({
    containers: required(
      listOf(
        record<Container>({
          path: required(path),
          name: required(text),
          level: required(number),
          isSessionDefault: optional(boolean),
          kinds: optional(listOf(text)),
        }),
      ),
    ),
    needsConfiguration: optional(text),
  }),
  form<TreeCountAnswer>({ counts: required(mapOf(kindCount)) }),
  form<TreeListAnswer>({
    objects: required(
      listOf(
        record<DatabaseObject>({
          path: required(path),
          name: required(text),
          kind: required(text),
          status: optional(text),
          rowCount: optional(number),
          sizeBytes: optional(number),
          readRanges: optional(listOf(readRange)),
        }),
      ),
    ),
  }),
  form<TreeDescribeAnswer>({ detail: required(objectDetail) }),
  form<ObjectDetailBatch>({
    details: required(listOf(objectDetail)),
    truncated: optional(
      record<NonNullable<ObjectDetailBatch["truncated"]>>({ limit: required(number), reason: required(text) }),
    ),
  }),
]);

/** A readable source part. */
type ReadablePart = Extract<ObjectSourcePart, { readonly text: string }>;

const SOURCE_FORMS = Object.freeze<Record<ReadablePart["form"], true>>({ complete: true, partial: true });
const SOURCE_ORIGINS = Object.freeze<Record<ReadablePart["origin"], true>>({
  stored: true,
  regenerated: true,
  rendered: true,
});

const readOfferedEdit = record<Extract<ObjectPartEdit, { readonly offered: true }>>({ offered: required(exactlyTrue) });
const readRefusedEdit = record<Extract<ObjectPartEdit, { readonly offered: false }>>({
  offered: required(exactlyFalse),
  reason: required(text),
});

/** A part's edit: refused with its sentence where it has a `reason` key, offered otherwise. */
const partEdit: Reader = (item, pointer, found) => {
  (isPlainRecord(item) && Object.hasOwn(item, "reason") ? readRefusedEdit : readOfferedEdit)(item, pointer, found);
};

const readReadablePart = record<ReadablePart>({
  id: required(text),
  label: required(text),
  text: required(text),
  language: required(text),
  form: required(vocabulary(SOURCE_FORMS)),
  origin: required(vocabulary(SOURCE_ORIGINS)),
  truncated: optional(
    record<NonNullable<ReadablePart["truncated"]>>({ limit: required(number), reason: required(text) }),
  ),
  edit: optional(partEdit),
});
const readRefusedPart = record<
  Exclude<Extract<ObjectSourcePart, { readonly unavailable: string }>, { readonly statement: true }>
>({
  id: required(text),
  label: required(text),
  unavailable: required(text),
});
const readStatementPart = record<Extract<ObjectSourcePart, { readonly statement: true }>>({
  id: required(text),
  label: required(text),
  unavailable: required(text),
  statement: required(exactlyTrue),
});

/**
 * A source part, read as the form its keys name: the engine's statement where it has `unavailable` and `statement`
 * keys, the engine's sentence for a part it cannot read where it has `unavailable` alone, and a readable part
 * otherwise. So a text beside `unavailable` is a key the sentence's form cannot have. The frame reader reads shapes only:
 * an empty text, a sentence past its bound and a repeated id are the host's answer check's.
 */
const sourcePart: Reader = (item, pointer, found) => {
  const keys = isPlainRecord(item) ? Object.getOwnPropertyNames(item) : [];
  const reader = !keys.includes("unavailable")
    ? readReadablePart
    : keys.includes("statement")
      ? readStatementPart
      : readRefusedPart;
  reader(item, pointer, found);
};

const sourceRequest = record<SourceRequest>({ path: required(path), kind: required(text) });

/** A source document: its path, its kind and its parts, each read as its form (`sourcePart`). */
const sourceAnswer = record<ObjectSourceDocument>({
  path: required(path),
  kind: required(text),
  parts: required(listOf(sourcePart)),
});

const MAINTENANCE_OPERATION_WORDS = Object.freeze<Record<MaintenanceRunRequest["operation"], true>>({
  vacuum: true,
  analyze: true,
  reindex: true,
  kill: true,
  optimize: true,
  check: true,
  compact: true,
  defragment: true,
  disarm: true,
  load: true,
  release: true,
});

const maintenanceOperation = vocabulary(MAINTENANCE_OPERATION_WORDS);

const maintenanceRunRequest = record<MaintenanceRunRequest>({
  operation: required(maintenanceOperation),
  target: optional(text),
  container: optional(text),
});

const readMaintenanceRunAnswer = record<MaintenanceRunAnswer>({
  success: required(boolean),
  executionTime: required(number),
  message: required(text),
  rows: optional(listOf(mapOf(anyValue))),
  fields: optional(listOf(text)),
});

/**
 * A maintenance run's answer: its rows each a record of codec values, keyed by its fields, which it carries whenever
 * it carries rows, so an answer with `rows` and no `fields` is refused as `frame-key-missing` at `fields`.
 */
const maintenanceRunAnswer: Reader = (item, pointer, found) => {
  readMaintenanceRunAnswer(item, pointer, found);
  if (isPlainRecord(item) && Object.hasOwn(item, "rows") && !Object.hasOwn(item, "fields")) {
    found.push({ rule: "frame-key-missing", pointer: pointerTo(pointer, "fields"), name: "fields" });
  }
};

/**
 * The path of the object a maintenance preview reads, container levels first and the object last, so an empty path,
 * which names no object, is refused at its pointer.
 */
const objectPath: Reader = (item, pointer, found) => {
  if (Array.isArray(item) && item.length === 0) return unreadable(pointer, found);
  path(item, pointer, found);
};

const maintenancePreviewRequest = record<MaintenancePreviewRequest>({
  operation: required(maintenanceOperation),
  path: required(objectPath),
});

const maintenancePreview = record<MaintenancePreview>({
  summary: required(text),
  facts: required(listOf(record<MaintenanceFact>({ label: required(text), value: required(text) }))),
  refusal: optional(text),
  note: optional(text),
});

/** The closed shape of each monitoring panel request, by the panel it names. */
const PANEL_REQUESTS = Object.freeze<{ readonly [Panel in MonitoringPanel]: Reader }>({
  overview: record<MonitoringOverviewRequest>({
    panel: required(vocabulary<MonitoringOverviewRequest["panel"]>(Object.freeze({ overview: true }))),
  }),
  performance: record<MonitoringPerformanceRequest>({
    panel: required(vocabulary<MonitoringPerformanceRequest["panel"]>(Object.freeze({ performance: true }))),
  }),
  slowQueries: record<MonitoringSlowQueriesRequest>({
    panel: required(vocabulary<MonitoringSlowQueriesRequest["panel"]>(Object.freeze({ slowQueries: true }))),
    limit: required(number),
  }),
  activeSessions: record<MonitoringActiveSessionsRequest>({
    panel: required(vocabulary<MonitoringActiveSessionsRequest["panel"]>(Object.freeze({ activeSessions: true }))),
    limit: required(number),
  }),
  tables: record<MonitoringTablesRequest>({
    panel: required(vocabulary<MonitoringTablesRequest["panel"]>(Object.freeze({ tables: true }))),
    schema: optional(text),
  }),
  indexes: record<MonitoringIndexesRequest>({
    panel: required(vocabulary<MonitoringIndexesRequest["panel"]>(Object.freeze({ indexes: true }))),
    schema: optional(text),
  }),
  storage: record<MonitoringStorageRequest>({
    panel: required(vocabulary<MonitoringStorageRequest["panel"]>(Object.freeze({ storage: true }))),
  }),
});

/**
 * A monitoring panel request, read as the closed shape of the panel it names: a record whose `panel` is the data value
 * of one of the panels is read as that panel's request, which refuses a member of another panel as a key it does not
 * define. A record without `panel` is refused as `frame-key-missing` there, and one whose `panel` is an accessor or no
 * panel as `frame-value-unreadable` there; any other value is refused at its pointer. The `panel` is read by its own
 * descriptor, so a getter is never called.
 */
const panelRequest: Reader = (item, pointer, found) => {
  if (!isPlainRecord(item)) return unreadable(pointer, found);
  const read = readOwn(item, "panel");
  const at = pointerTo(pointer, "panel");
  if (read.kind === "absent") {
    found.push({ rule: "frame-key-missing", pointer: at, name: "panel" });
    return;
  }
  const word = read.kind === "data" ? read.value : undefined;
  if (typeof word !== "string" || !Object.hasOwn(PANEL_REQUESTS, word)) return unreadable(at, found);
  PANEL_REQUESTS[word as MonitoringPanel](item, pointer, found);
};

const SESSION_ACTIVITIES = Object.freeze<Record<SessionActivity, true>>({
  active: true,
  idle: true,
  "idle-in-transaction": true,
  waiting: true,
  other: true,
});

/** The form of the panel answer whose one key is `Panel`. */
type PanelAnswerOf<Panel extends MonitoringPanel> = Extract<MonitoringPanelAnswer, Readonly<Record<Panel, unknown>>>;

/**
 * A monitoring panel answer, exactly one of its seven forms, each with one key, the panel's own, told apart by it. The
 * frame reader reads shapes only: which form answers which panel is the host's answer reader's.
 */
const panelAnswer = oneOfRecords([
  form<PanelAnswerOf<"overview">>({
    overview: required(
      record<DatabaseOverview>({
        version: required(text),
        uptime: required(text),
        startTime: optional(timestamp),
        activeConnections: optional(number),
        maxConnections: required(number),
        databaseSize: required(text),
        databaseSizeBytes: optional(number),
        tableCount: required(number),
        tableCountSampledFrom: optional(text),
        indexCount: required(number),
      }),
    ),
  }),
  form<PanelAnswerOf<"performance">>({
    performance: required(
      record<PerformanceMetrics>({
        cacheHitRatio: optional(number),
        cacheHitAdvice: optional(text),
        transactionsPerSecond: optional(number),
        queriesPerSecond: optional(number),
        bufferPoolUsage: optional(number),
        deadlocks: optional(number),
        checkpointWriteTime: optional(text),
      }),
    ),
  }),
  form<PanelAnswerOf<"slowQueries">>({
    slowQueries: required(
      listOf(
        record<SlowQueryStats>({
          queryId: optional(text),
          query: required(text),
          calls: required(number),
          totalTime: required(number),
          avgTime: required(number),
          minTime: optional(number),
          maxTime: optional(number),
          rows: required(number),
          sharedBlksHit: optional(number),
          sharedBlksRead: optional(number),
        }),
      ),
    ),
  }),
  form<PanelAnswerOf<"activeSessions">>({
    activeSessions: required(
      listOf(
        record<ActiveSessionDetails>({
          pid: required(textOrNumber),
          user: required(text),
          database: required(text),
          applicationName: optional(text),
          clientAddr: optional(text),
          state: required(text),
          activity: optional(vocabulary(SESSION_ACTIVITIES)),
          query: required(text),
          queryStart: optional(timestamp),
          duration: required(text),
          durationMs: required(number),
          waitEventType: optional(text),
          waitEvent: optional(text),
          blocked: optional(boolean),
          terminable: optional(boolean),
        }),
      ),
    ),
  }),
  form<PanelAnswerOf<"tables">>({
    tables: required(
      listOf(
        record<TableStats>({
          schemaName: required(text),
          tableName: required(text),
          rowCount: optional(number),
          liveRowCount: optional(number),
          deadRowCount: optional(number),
          tableSize: optional(text),
          tableSizeBytes: optional(number),
          indexSize: optional(text),
          indexSizeBytes: optional(number),
          totalSize: required(text),
          totalSizeBytes: required(number),
          lastVacuum: optional(timestamp),
          lastAnalyze: optional(timestamp),
          bloatRatio: optional(number),
        }),
      ),
    ),
  }),
  form<PanelAnswerOf<"indexes">>({
    indexes: required(
      listOf(
        record<IndexStats>({
          schemaName: required(text),
          tableName: required(text),
          indexName: required(text),
          indexType: optional(text),
          columns: required(listOf(text)),
          isUnique: required(boolean),
          isPrimary: required(boolean),
          indexSize: required(text),
          indexSizeBytes: optional(number),
          scans: required(number),
          usageRatio: optional(number),
        }),
      ),
    ),
  }),
  form<PanelAnswerOf<"storage">>({
    storage: required(
      listOf(
        record<StorageStats>({
          name: required(text),
          location: optional(text),
          size: required(text),
          sizeBytes: required(number),
          usagePercent: optional(number),
          walSize: optional(text),
          walSizeBytes: optional(number),
        }),
      ),
    ),
  }),
]);

const poolStats = record<PoolStats>({
  total: required(number),
  idle: required(number),
  active: required(number),
  waiting: required(number),
  max: optional(number),
});

const health = record<HealthInfo>({
  activeConnections: optional(number),
  databaseSize: required(text),
  cacheHitRatio: required(text),
  slowQueries: required(
    listOf(record<SlowQuery>({ query: required(text), calls: required(number), avgTime: required(text) })),
  ),
  activeSessions: required(
    listOf(
      record<ActiveSession>({
        pid: required(textOrNumber),
        user: required(text),
        database: required(text),
        state: required(text),
        query: required(text),
        duration: required(text),
      }),
    ),
  ),
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

const openAnswer = record<OpenAnswerFrame>({
  serverVersion: optional(text),
  refine: optional(anyValue),
  engineUser: optional(text),
});

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
  transaction: optional(exactlyTrue),
  readOnly: optional(
    record<ReadOnlyExecute>({
      budget: required(record<ReadBudget>({ maxRows: required(number), maxBytes: required(number) })),
      mode: optional(vocabulary(READ_ONLY_MODE_WORDS)),
    }),
  ),
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
  sessionState: optional(vocabulary(SESSION_STATE_WORDS)),
});

/** The reader of each part of each call's frame, typed so every part `FrameShapes` names has one. */
const READERS = Object.freeze<{
  readonly [Call in ServedCall]: { readonly [Part in keyof FrameShapes[Call]]: Reader };
}>({
  open: { context: openContext, answer: openAnswer },
  close: { context: callContext },
  health: { context: callContext, answer: health },
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
  "console.transaction": {
    context: callContext,
    request: transactionRequest,
    answer: record<TransactionAnswer>({
      sessionState: required(vocabulary(SESSION_STATE_WORDS)),
      stateReported: optional(boolean),
    }),
  },
  "objects.tree": { context: callContext, request: treeRequest, answer: treeAnswer },
  "objects.source": { context: callContext, request: sourceRequest, answer: sourceAnswer },
  "maintenance.run": { context: callContext, request: maintenanceRunRequest, answer: maintenanceRunAnswer },
  "maintenance.preview": { context: callContext, request: maintenancePreviewRequest, answer: maintenancePreview },
  "monitoring.panel": { context: callContext, request: panelRequest, answer: panelAnswer },
  "monitoring.poolStats": { context: callContext, answer: poolStats },
  "result.next": {
    request: record<BatchLimitData>({ maxRows: required(number), maxBytes: required(number) }),
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
