/**
 * The host's reading of what a console execute, an object tree call and an object source call answered
 * (docs/providers/CONTRACT.md, clauses C-48, C-62, C-112 and C-115).
 *
 * The host passes an execute answer's result list, its first result's columns and row count, its execution time and
 * its warnings on to the caller, so it reads each of them once, here, before it pumps a row: a member that is missing
 * where the SDK requires it, behind an accessor, or not of the SDK's type there is refused by name as
 * `execute-answer-unreadable`, never read as any value. The answer's other members are not read here: the pump reads
 * the first result's rows, a statement sent inside a transaction has its session state read by
 * `checkTransactionStatement`, and every other result is closed unread.
 *
 * The host passes a tree answer on to the caller whole, by reference, so `checkTreeAnswer` reads all of it once, here,
 * against the form its request's action answers: every record and every list closed over the members the SDK's object
 * tree types state, a key outside them refused by name, and a value of another type, more details than the request's
 * limit or `needsConfiguration` where clause C-61 does not allow it refused at its pointer as `tree-answer-unreadable`.
 * Each record's form is declared against its SDK type, one entry per member, so a member added to a tree type fails
 * typecheck here until its form names it, as the frame reader's shapes do.
 *
 * The host passes a source answer on whole too, so `checkSourceAnswer` reads it once, here, against the SDK's closed
 * source document: the request's own path and kind, one to `SOURCE_PART_LIMIT` parts, each one of its three forms, told
 * apart by an own `unavailable`, every text and sentence filled, every sentence at most `SOURCE_CHARACTER_LIMIT` long,
 * and no part id twice, each refused at its pointer as `source-answer-unreadable`. A text past the character bound is
 * not refused: the host cuts it (`boundSourceAnswer`).
 *
 * The checks read every member once, with one set of readers. Each list's length is read once, from its own data
 * descriptor, and a length that is no count, or a list longer than its bound, `ANSWER_LIST_MAX` for its member or a
 * `describeMany` request's `limit`, is refused at the list before any item is read; a list's first hole is refused at
 * its index and ends the list's reading, so a sparse list of any length is read in as many steps as it holds items
 * before its first hole. A reading that throws, a revoked Proxy or a trap that throws, is refused at the pointer being
 * read, so neither check ever throws.
 *
 * Each check answers an `AnswerCheck`: the answer itself, by reference, typed as the form it was read as, where it
 * refuses nothing, and its refusals alone otherwise, so a caller past the check reads the answer typed with no cast of
 * its own.
 *
 * Each reader reads the answer by its own property descriptors: a getter is never called but refused, an inherited
 * property is never read, and no refusal carries a value of the answer. An optional member present as an own data
 * property whose value is `undefined` reads as absent, in every answer, since the SDK's optional types admit it, and
 * so does a member of another arm of a union in a tree or a source answer; a required member present so is missing.
 */
import { isPlainRecord, type OwnRead, pointerTo, readOwn } from "./records";
import type { CallRefusal } from "./refusals";
import { SOURCE_CHARACTER_LIMIT, SOURCE_PART_LIMIT } from "./source";
import type {
  ColumnSchema,
  Container,
  ExecuteAnswer,
  DatabaseObject,
  ExclusionConstraintSchema,
  ForeignKeySchema,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectPartEdit,
  ObjectReadRange,
  ObjectSourceDocument,
  ObjectSourcePart,
  SourceRequest,
  TreeContainersAnswer,
  TreeCountAnswer,
  TreeDescribeAnswer,
  TreeListAnswer,
  TreeAnswerOf,
  TreeRequest,
} from "./types";

/**
 * What a check answers of an answer: the answer itself, by reference, typed as the form the check read it as, where it
 * refuses nothing, and only its refusals, never the answer, where it refuses any.
 */
export type AnswerCheck<Answer> =
  | { readonly kind: "read"; readonly answer: Answer }
  | { readonly kind: "refused"; readonly refusals: readonly CallRefusal[] };

/**
 * The check of `answer` that found `refusals`: refused where there are any, and otherwise the answer read as `Answer`,
 * the form the refusals' reader held it to, which is what makes the type true; no other function in the SDK types an
 * answer by its check.
 */
function checked<Answer>(answer: unknown, refusals: readonly CallRefusal[]): AnswerCheck<Answer> {
  if (refusals.length > 0) return { kind: "refused", refusals };
  // The reader that found no refusal read every member `Answer` states that the host reads, as its type.
  return { kind: "read", answer: answer as Answer };
}

/**
 * The most items each list of an answer may hold, by the member that holds it (clauses C-62 and C-112): a list longer
 * than its bound is refused at the list before any of its items is read. A list of a database's containers, objects or
 * details may hold 2^20 items, and every other list, one within an answer, an object or a path, 2^16. A `describeMany`
 * request that sends a `limit` bounds its `details` by that limit instead. An index's `columns` takes the bound of
 * `columns`.
 */
export const ANSWER_LIST_MAX = Object.freeze({
  results: 65_536,
  warnings: 65_536,
  columns: 65_536,
  containers: 1_048_576,
  path: 65_536,
  kinds: 65_536,
  objects: 1_048_576,
  readRanges: 65_536,
  indexes: 65_536,
  foreignKeys: 65_536,
  exclusionConstraints: 65_536,
  details: 1_048_576,
});

/** The members a warning can have: its message, and its optional code and severity. */
const WARNING_MEMBERS: readonly string[] = Object.freeze(["message", "code", "severity"]);

/** Where a reading of an answer puts what it refuses: the rule its check names, and the refusals found so far. */
interface Refusals {
  readonly rule: "execute-answer-unreadable" | "tree-answer-unreadable" | "source-answer-unreadable";
  readonly list: CallRefusal[];
}

/** Refuses the member at `pointer`, or, where `name` is given, the key `name` there, a key its form cannot have. */
function refuse(out: Refusals, pointer: string, name?: string): void {
  out.list.push(name === undefined ? { rule: out.rule, pointer } : { rule: out.rule, pointer, name });
}

/** How one value of an answer is read: each way it is not its form refused into `out`, pointed at `pointer`. */
type Form = (value: unknown, pointer: string, out: Refusals) => void;

/**
 * `form`, with a throw while it reads its value, a revoked Proxy or a trap that throws, refused at the value's pointer,
 * so no reading of an answer throws past its check. Every form that reads more than the value's type is guarded.
 */
function guarded(form: Form): Form {
  return (value, pointer, out) => {
    try {
      form(value, pointer, out);
    } catch {
      refuse(out, pointer);
    }
  };
}

/** The own property `key` of `target` (`readOwn`), or undefined, its pointer `at` refused, when reading it throws. */
function readAt(target: unknown, key: string, at: string, out: Refusals): OwnRead | undefined {
  try {
    return readOwn(target, key);
  } catch {
    refuse(out, at);
    return undefined;
  }
}

/** Whether `value` is a count: a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The length of the list at `pointer`, read once from its own data descriptor, so no `get` is run and no conversion
 * of it is made: a length that is not a count (`isCount`), or whose reading throws (`readAt`), is refused at the list,
 * and undefined is answered for either. Every later use of the length reads the number this answers.
 */
function lengthOf(list: readonly unknown[], pointer: string, out: Refusals): number | undefined {
  const read = readAt(list, "length", pointer, out);
  if (read === undefined) return undefined;
  if (read.kind === "data" && isCount(read.value)) return read.value;
  refuse(out, pointer);
  return undefined;
}

/** Whether `key` is an index of a list of `length` items: a canonical array index below the length. */
function isIndexOf(key: string, length: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length;
}

/**
 * A list of `item` at most `bound` long: an own data array, refused at the list otherwise, whose length is read once
 * (`lengthOf`) and refused at the list where it is no count or past `bound`, before any item is read. Each index is
 * then read in order as an own data element of `item`, an accessor refused at its index, and the first hole is
 * refused at its index and ends the reading of the list. Where `closed`, an own key that is neither an index nor
 * `length` is refused by name, as a record's key outside its form is. `counted`, where given, is told the length of a
 * list within its bound.
 */
function listForm(item: Form, bound: number, closed: boolean, counted?: (length: number) => void): Form {
  return guarded((value, pointer, out) => {
    if (!Array.isArray(value)) {
      refuse(out, pointer);
      return;
    }
    const items: readonly unknown[] = value;
    const length = lengthOf(items, pointer, out);
    if (length === undefined) return;
    if (length > bound) {
      refuse(out, pointer);
      return;
    }
    counted?.(length);
    for (let index = 0; index < length; index++) {
      const at = pointerTo(pointer, index);
      const read = readAt(items, String(index), at, out);
      if (read === undefined) continue;
      if (read.kind === "absent") {
        refuse(out, at);
        return;
      }
      if (read.kind === "data") item(read.value, at, out);
      else refuse(out, at);
    }
    if (!closed) return;
    for (const key of Object.getOwnPropertyNames(items)) {
      if (key !== "length" && !isIndexOf(key, length)) refuse(out, pointerTo(pointer, key), key);
    }
  });
}

/**
 * The warning at `pointer`, the SDK's `Warning`: no plain record, refused once at its pointer; any own key but its
 * message, code and severity, named; a message that is missing, an accessor or not text; a code that is an accessor or
 * neither text nor a number; a severity that is an accessor or not text.
 */
const warningForm: Form = guarded((warning, pointer, out) => {
  if (!isPlainRecord(warning)) {
    refuse(out, pointer);
    return;
  }
  for (const key of Object.getOwnPropertyNames(warning)) {
    if (!WARNING_MEMBERS.includes(key)) refuse(out, pointerTo(pointer, key), key);
  }
  const messageAt = pointerTo(pointer, "message");
  const message = readAt(warning, "message", messageAt, out);
  if (message !== undefined && (message.kind !== "data" || typeof message.value !== "string")) {
    refuse(out, messageAt);
  }
  const codeAt = pointerTo(pointer, "code");
  const code = readAt(warning, "code", codeAt, out);
  if (
    code !== undefined &&
    (code.kind === "accessor" ||
      (code.kind === "data" &&
        code.value !== undefined &&
        typeof code.value !== "string" &&
        typeof code.value !== "number"))
  ) {
    refuse(out, codeAt);
  }
  const severityAt = pointerTo(pointer, "severity");
  const severity = readAt(warning, "severity", severityAt, out);
  if (
    severity !== undefined &&
    (severity.kind === "accessor" ||
      (severity.kind === "data" && severity.value !== undefined && typeof severity.value !== "string"))
  ) {
    refuse(out, severityAt);
  }
});

/**
 * The first result's columns, a list that can key a row (`listForm`, bounded by `ANSWER_LIST_MAX.columns`): a column
 * that is no object, or whose name is missing, an accessor, not text or empty, refused at the name's pointer, and a
 * name an earlier column of the result already has, refused at the later column's name. A fresh form for each answer,
 * since it holds the names it has read.
 */
function columnListForm(): Form {
  const seen = new Set<string>();
  const column: Form = (value, pointer, out) => {
    const at = pointerTo(pointer, "name");
    const name = readAt(value, "name", at, out);
    if (name === undefined) return;
    if (name.kind !== "data" || typeof name.value !== "string" || name.value === "" || seen.has(name.value)) {
      refuse(out, at);
      return;
    }
    seen.add(name.value);
  };
  return listForm(column, ANSWER_LIST_MAX.columns, false);
}

/**
 * The result list at `pointer`: an own data array, refused at the list otherwise, whose length is read once
 * (`lengthOf`) and refused at the list where it is no count or past `ANSWER_LIST_MAX.results`. Only its first result
 * is read, as an own data element: its columns (`columnListForm`), and an own row count that is an accessor or not a
 * count. A row count it does not have is not refused: a provider gives one only where its engine answered it. A first
 * result that is no object, a hole or an accessor, has no columns. No later result is read.
 */
const resultsForm: Form = guarded((value, pointer, out) => {
  if (!Array.isArray(value)) {
    refuse(out, pointer);
    return;
  }
  const results: readonly unknown[] = value;
  const length = lengthOf(results, pointer, out);
  if (length === undefined) return;
  if (length > ANSWER_LIST_MAX.results) {
    refuse(out, pointer);
    return;
  }
  if (length === 0) return;
  const first = readAt(results, "0", pointerTo(pointer, 0), out);
  if (first === undefined) return;
  const source = first.kind === "data" ? first.value : undefined;
  const columnsAt = pointerTo(pointerTo(pointer, 0), "columns");
  const columns = readAt(source, "columns", columnsAt, out);
  if (columns !== undefined) {
    if (columns.kind === "data") columnListForm()(columns.value, columnsAt, out);
    else refuse(out, columnsAt);
  }
  const rowCountAt = pointerTo(pointerTo(pointer, 0), "rowCount");
  const rowCount = readAt(source, "rowCount", rowCountAt, out);
  if (
    rowCount !== undefined &&
    (rowCount.kind === "accessor" ||
      (rowCount.kind === "data" && rowCount.value !== undefined && !isCount(rowCount.value)))
  ) {
    refuse(out, rowCountAt);
  }
});

/** The warning list: each warning (`warningForm`), bounded by `ANSWER_LIST_MAX.warnings` (`listForm`). */
const warningListForm = listForm(warningForm, ANSWER_LIST_MAX.warnings, false);

/**
 * Every way `answer`, what a console execute answered, is not readable where the host reads it, in this order: the
 * result list at `/results` (`resultsForm`); the execution time at `/executionTimeMs`, a finite non-negative number;
 * the warning list at `/warnings` (`warningListForm`). A member that is missing, an accessor or not of its type is
 * refused at its pointer, a key a warning cannot have is named, and no refusal carries a value. An answer that is no
 * object has none of its members. A reading that throws, a revoked Proxy or a trap that throws, is refused at the
 * pointer being read, so this never throws.
 */
function executeAnswerRefusals(answer: unknown): readonly CallRefusal[] {
  const out: Refusals = { rule: "execute-answer-unreadable", list: [] };
  const results = readAt(answer, "results", "/results", out);
  if (results !== undefined) {
    if (results.kind === "data") resultsForm(results.value, "/results", out);
    else refuse(out, "/results");
  }
  const executionTimeMs = readAt(answer, "executionTimeMs", "/executionTimeMs", out);
  if (
    executionTimeMs !== undefined &&
    (executionTimeMs.kind !== "data" ||
      typeof executionTimeMs.value !== "number" ||
      !Number.isFinite(executionTimeMs.value) ||
      executionTimeMs.value < 0)
  ) {
    refuse(out, "/executionTimeMs");
  }
  const warnings = readAt(answer, "warnings", "/warnings", out);
  if (warnings !== undefined) {
    if (warnings.kind === "data") warningListForm(warnings.value, "/warnings", out);
    else refuse(out, "/warnings");
  }
  return out.list;
}

/**
 * `answer`, what a console execute answered, read where the host reads it (`executeAnswerRefusals`): the answer itself,
 * typed as the SDK's `ExecuteAnswer`, where no member the host reads here is refused, and the refusals otherwise. The
 * members it does not read are read where the module's docblock says. Never throws.
 */
export function checkExecuteAnswer(answer: unknown): AnswerCheck<ExecuteAnswer> {
  return checked(answer, executeAnswerRefusals(answer));
}

/** Text. */
const textForm: Form = (value, pointer, out) => {
  if (typeof value !== "string") refuse(out, pointer);
};

/** A boolean. */
const flagForm: Form = (value, pointer, out) => {
  if (typeof value !== "boolean") refuse(out, pointer);
};

/** A count: a non-negative safe integer, as an execute answer's row count is read. */
const countForm: Form = (value, pointer, out) => {
  if (!isCount(value)) refuse(out, pointer);
};

/** A column's provenance: the one word the SDK states, `"sampled"`. */
const provenanceForm: Form = (value, pointer, out) => {
  if (value !== "sampled") refuse(out, pointer);
};

/** A tree answer's list of `item`, closed over its indexes and `length`, at most `bound` long (`listForm`). */
function treeListForm(item: Form, bound: number, counted?: (length: number) => void): Form {
  return listForm(item, bound, true, counted);
}

/** A member a record form reads where the SDK type requires it. */
interface RequiredMember {
  readonly required: Form;
}

/** A member a record form reads where the SDK type admits a value without it. */
interface OptionalMember {
  readonly optional: Form;
}

/**
 * One entry per member of the SDK type `T`, `required` or `optional` as the member is: a member is optional exactly
 * when `T` admits a value without it, the rule of the frame reader's `ShapeOf`. So a member added to a tree type, or a
 * member's optionality changed, fails typecheck here until its form names it as the type has it.
 */
type TreeShape<T> = {
  readonly [K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? OptionalMember : RequiredMember;
};

/** The members of a record form, by key, whatever SDK type they were declared against. */
type Members = Readonly<Record<string, RequiredMember | OptionalMember>>;

const required = (form: Form): RequiredMember => ({ required: form });
const optional = (form: Form): OptionalMember => ({ optional: form });

/** `shape`, declared against the SDK type `T`, as the members of one arm of a union (`chosenForm`). */
function armOf<T>(shape: TreeShape<T>): Members {
  return shape;
}

/**
 * A closed record of `members`, read in the answer's order: a plain record, refused once at its pointer otherwise.
 * Each own key is read in the answer's order: a key `members` does not name is refused by name, except a key of
 * `absentKeys` whose value is `undefined`, which reads as absent; an accessor is refused at its pointer, and a data
 * member is read as its form, except an optional member whose value is `undefined`, which reads as absent. A required
 * member the record does not have is then refused at its pointer, in the members' order.
 */
function closedForm(members: Members, absentKeys: readonly string[]): Form {
  return guarded((value, pointer, out) => {
    if (!isPlainRecord(value)) {
      refuse(out, pointer);
      return;
    }
    const keys = Object.getOwnPropertyNames(value);
    for (const key of keys) {
      const at = pointerTo(pointer, key);
      const member = Object.hasOwn(members, key) ? members[key] : undefined;
      const read = readAt(value, key, at, out);
      if (read === undefined) continue;
      if (member === undefined) {
        if (!(absentKeys.includes(key) && read.kind === "data" && read.value === undefined)) refuse(out, at, key);
      } else if (read.kind !== "data") refuse(out, at);
      else if ("required" in member) member.required(read.value, at, out);
      else if (read.value !== undefined) member.optional(read.value, at, out);
    }
    for (const [key, member] of Object.entries(members)) {
      if ("required" in member && !keys.includes(key)) refuse(out, pointerTo(pointer, key));
    }
  });
}

/** A closed record of the SDK type `T`, read as `shape` names its members (`closedForm`). */
function recordForm<T>(shape: TreeShape<T>): Form {
  return closedForm(shape, []);
}

/**
 * A record of one of the closed forms of a union's arms, chosen by the first of `arms` whose key the record has as its
 * own accessor or as its own data property with a value, `otherwise` when it has none of them. A member of another
 * arm present with the value `undefined` reads as absent in the arm chosen, as an optional member does, so no
 * undefined member chooses an arm or is refused in one; one with a value is refused by name, as any key the arm cannot
 * have.
 */
function chosenForm(arms: readonly (readonly [string, Members])[], otherwise: Members): Form {
  const all = [...arms.map(([, members]) => members), otherwise];
  const keysOf = (members: Members): readonly string[] => [
    ...new Set(all.flatMap((other) => Object.keys(other)).filter((key) => !Object.hasOwn(members, key))),
  ];
  const forms = arms.map(([key, members]) => [key, closedForm(members, keysOf(members))] as const);
  const fallback = closedForm(otherwise, keysOf(otherwise));
  return guarded((value, pointer, out) => {
    const chosen = forms.find(([key]) => {
      const read = readOwn(value, key);
      return read.kind === "accessor" || (read.kind === "data" && read.value !== undefined);
    });
    (chosen === undefined ? fallback : chosen[1])(value, pointer, out);
  });
}

/** A path: its segments, each text. */
const pathForm = treeListForm(textForm, ANSWER_LIST_MAX.path);

/** The SDK's `Container`. */
const containerForm = recordForm<Container>({
  path: required(pathForm),
  name: required(textForm),
  level: required(countForm),
  isSessionDefault: optional(flagForm),
  kinds: optional(treeListForm(textForm, ANSWER_LIST_MAX.kinds)),
});

/** A kind count read from a bounded sample, the form that says what bounded it. */
type SampledCount = Extract<KindCount, { readonly sampledFrom: string }>;

/** A counted kind: a count, and the sentence for what bounded it where it was read from a bounded sample. */
type CountedKind = Omit<SampledCount, "sampledFrom"> & Partial<Pick<SampledCount, "sampledFrom">>;

/** The SDK's `KindCount`: the engine's sentence when it has an own `unavailable` with a value, a count otherwise. */
const kindCountForm = chosenForm(
  [["unavailable", armOf<Extract<KindCount, { readonly unavailable: string }>>({ unavailable: required(textForm) })]],
  armOf<CountedKind>({ count: required(countForm), sampledFrom: optional(textForm) }),
);

/** A count answer's counts: a plain record whose every own key is a kind, any text, and every value a `KindCount`. */
const countsForm: Form = guarded((value, pointer, out) => {
  if (!isPlainRecord(value)) {
    refuse(out, pointer);
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const at = pointerTo(pointer, key);
    const read = readAt(value, key, at, out);
    if (read === undefined) continue;
    if (read.kind === "data") kindCountForm(read.value, at, out);
    else refuse(out, at);
  }
});

/** The SDK's `ObjectReadRange`: one key, every key under a prefix, or a range, told apart by their own keys. */
const readRangeForm = chosenForm(
  [
    ["key", armOf<Extract<ObjectReadRange, { readonly key: string }>>({ key: required(textForm) })],
    ["prefix", armOf<Extract<ObjectReadRange, { readonly prefix: string }>>({ prefix: required(textForm) })],
  ],
  armOf<Extract<ObjectReadRange, { readonly start: string }>>({
    start: required(textForm),
    end: required(textForm),
  }),
);

/** The SDK's `DatabaseObject`. */
const objectForm = recordForm<DatabaseObject>({
  path: required(pathForm),
  name: required(textForm),
  kind: required(textForm),
  status: optional(textForm),
  rowCount: optional(countForm),
  sizeBytes: optional(countForm),
  readRanges: optional(treeListForm(readRangeForm, ANSWER_LIST_MAX.readRanges)),
});

/** The SDK's `ColumnSchema`. */
const columnForm = recordForm<ColumnSchema>({
  name: required(textForm),
  type: required(textForm),
  baseType: optional(textForm),
  declaredType: optional(textForm),
  nullable: required(flagForm),
  isPrimary: required(flagForm),
  defaultValue: optional(textForm),
  defaultExpression: optional(textForm),
  provenance: optional(provenanceForm),
  projectable: optional(flagForm),
});

const indexListForm = treeListForm(
  recordForm<IndexSchema>({
    name: required(textForm),
    columns: required(treeListForm(textForm, ANSWER_LIST_MAX.columns)),
    unique: required(flagForm),
  }),
  ANSWER_LIST_MAX.indexes,
);
const indexesUnavailableForm = recordForm<Extract<ObjectDetail["indexes"], { readonly unavailable: string }>>({
  unavailable: required(textForm),
});

/** An object's indexes: a list of the SDK's `IndexSchema`, or the engine's sentence where the read was refused. */
const indexesForm: Form = guarded((value, pointer, out) => {
  (Array.isArray(value) ? indexListForm : indexesUnavailableForm)(value, pointer, out);
});

/** The SDK's `ObjectDetail`. */
const detailForm = recordForm<ObjectDetail>({
  path: required(pathForm),
  columns: required(treeListForm(columnForm, ANSWER_LIST_MAX.columns)),
  indexes: required(indexesForm),
  foreignKeys: required(
    treeListForm(
      recordForm<ForeignKeySchema>({
        columnName: required(textForm),
        referencedTable: required(textForm),
        referencedColumn: required(textForm),
      }),
      ANSWER_LIST_MAX.foreignKeys,
    ),
  ),
  exclusionConstraints: optional(
    treeListForm(
      recordForm<ExclusionConstraintSchema>({ name: required(textForm), definition: required(textForm) }),
      ANSWER_LIST_MAX.exclusionConstraints,
    ),
  ),
});

const countAnswerForm = recordForm<TreeCountAnswer>({ counts: required(countsForm) });
const listAnswerForm = recordForm<TreeListAnswer>({
  objects: required(treeListForm(objectForm, ANSWER_LIST_MAX.objects)),
});
const describeAnswerForm = recordForm<TreeDescribeAnswer>({ detail: required(detailForm) });
const truncatedForm = recordForm<NonNullable<ObjectDetailBatch["truncated"]>>({
  limit: required(countForm),
  reason: required(textForm),
});

/**
 * Every way `answer`, what an `objects.tree` call answered `request`, is not its action's form (clause C-62), as
 * `tree-answer-unreadable` at a pointer into the answer: a `containers` request answers `TreeContainersAnswer`, a
 * `count` request `TreeCountAnswer`, a `list` request `TreeListAnswer`, a `describe` request `TreeDescribeAnswer` and a
 * `describeMany` request `ObjectDetailBatch`, each record and each list closed over the members the SDK's object tree
 * types state, every count a non-negative safe integer, and every list at most its bound long: a `describeMany`
 * request's `limit` for its details where it sends one, and its member's `ANSWER_LIST_MAX` otherwise. It also refuses
 * `needsConfiguration` sent with a `parent` or beside a container (clause C-61), from the sentence and the container
 * list's length its forms read, so every member is read once. An optional member present as an own `undefined` reads
 * as absent, as does a member of another arm of a union; a getter is refused, never called, an inherited property is
 * never read, and no refusal carries a value. A reading that throws, a revoked Proxy or a trap that throws, is refused
 * at the pointer being read, so this never throws. An action no form exists for is not this check's, and answers no
 * refusal.
 */
function treeAnswerRefusals(request: TreeRequest, answer: unknown): readonly CallRefusal[] {
  const out: Refusals = { rule: "tree-answer-unreadable", list: [] };
  switch (request.action) {
    case "containers": {
      const read = { listed: 0, sentence: false };
      recordForm<TreeContainersAnswer>({
        containers: required(
          treeListForm(containerForm, ANSWER_LIST_MAX.containers, (length) => {
            read.listed = length;
          }),
        ),
        needsConfiguration: optional((value, pointer, into) => {
          textForm(value, pointer, into);
          read.sentence = typeof value === "string";
        }),
      })(answer, "", out);
      if (read.sentence && (request.parent !== undefined || read.listed > 0)) refuse(out, "/needsConfiguration");
      break;
    }
    case "count":
      countAnswerForm(answer, "", out);
      break;
    case "list":
      listAnswerForm(answer, "", out);
      break;
    case "describe":
      describeAnswerForm(answer, "", out);
      break;
    case "describeMany":
      recordForm<ObjectDetailBatch>({
        details: required(treeListForm(detailForm, request.limit ?? ANSWER_LIST_MAX.details)),
        truncated: optional(truncatedForm),
      })(answer, "", out);
      break;
  }
  return out.list;
}

/**
 * `answer`, what an `objects.tree` call answered `request`, read against its action's form (`treeAnswerRefusals`):
 * the answer itself, typed as that form (`TreeAnswerOf`), where nothing is refused, and the refusals otherwise. Never
 * throws.
 */
export function checkTreeAnswer<R extends TreeRequest>(
  request: R,
  answer: unknown,
): AnswerCheck<TreeAnswerOf<R["action"]>> {
  return checked(answer, treeAnswerRefusals(request, answer));
}

/** Filled text: text that is not empty and not whitespace only. */
const filledForm: Form = (value, pointer, out) => {
  if (typeof value !== "string" || value.trim() === "") refuse(out, pointer);
};

/** Whether `value` is a sentence of a source document: filled text at most `SOURCE_CHARACTER_LIMIT` long. */
function isSentence(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= SOURCE_CHARACTER_LIMIT;
}

/** A sentence of a source document (`isSentence`). */
const sentenceForm: Form = (value, pointer, out) => {
  if (!isSentence(value)) refuse(out, pointer);
};

/** One of the words `words` has as its own keys: a vocabulary the SDK's types state only as a union. */
function wordForm(words: Readonly<Record<string, true>>): Form {
  return (value, pointer, out) => {
    if (typeof value !== "string" || !Object.hasOwn(words, value)) refuse(out, pointer);
  };
}

/** Exactly the value `expected`. */
function exactlyForm(expected: unknown): Form {
  return (value, pointer, out) => {
    if (value !== expected) refuse(out, pointer);
  };
}

/** A readable part. */
type ReadablePart = Extract<ObjectSourcePart, { readonly text: string }>;

/** A readable part's forms, a key per word of the SDK's union, so a word added to it fails typecheck here. */
const SOURCE_FORMS = Object.freeze<Record<ReadablePart["form"], true>>({ complete: true, partial: true });

/** A readable part's origins, a key per word of the SDK's union, so a word added to it fails typecheck here. */
const SOURCE_ORIGINS = Object.freeze<Record<ReadablePart["origin"], true>>({
  stored: true,
  regenerated: true,
  rendered: true,
});

/** A part the engine answers its sentence for: a refusal, or a statement where it is marked so. */
type SentencePart = Omit<Extract<ObjectSourcePart, { readonly statement: true }>, "statement"> &
  Partial<Pick<Extract<ObjectSourcePart, { readonly statement: true }>, "statement">>;

/** The SDK's `ObjectPartEdit`: refused with the engine's sentence where it has an own `reason`, offered otherwise. */
const editForm = chosenForm(
  [
    [
      "reason",
      armOf<Extract<ObjectPartEdit, { readonly offered: false }>>({
        offered: required(exactlyForm(false)),
        reason: required(sentenceForm),
      }),
    ],
  ],
  armOf<Extract<ObjectPartEdit, { readonly offered: true }>>({ offered: required(exactlyForm(true)) }),
);

/**
 * The parts of one source answer: a list of one to `SOURCE_PART_LIMIT` parts, each a readable part or, where it has an
 * own `unavailable`, the engine's sentence, with `statement` only `true`; each id a sentence no earlier part's id is.
 * A fresh form for each answer, since it holds the ids it has read.
 */
function partListForm(): Form {
  const ids = new Set<string>();
  const idForm: Form = (value, pointer, out) => {
    if (!isSentence(value) || ids.has(value)) {
      refuse(out, pointer);
      return;
    }
    ids.add(value);
  };
  const partForm = chosenForm(
    [
      [
        "unavailable",
        armOf<SentencePart>({
          id: required(idForm),
          label: required(sentenceForm),
          unavailable: required(sentenceForm),
          statement: optional(exactlyForm(true)),
        }),
      ],
    ],
    armOf<ReadablePart>({
      id: required(idForm),
      label: required(sentenceForm),
      text: required(filledForm),
      language: required(sentenceForm),
      form: required(wordForm(SOURCE_FORMS)),
      origin: required(wordForm(SOURCE_ORIGINS)),
      truncated: optional(
        recordForm<NonNullable<ReadablePart["truncated"]>>({
          limit: required(countForm),
          reason: required(sentenceForm),
        }),
      ),
      edit: optional(editForm),
    }),
  );
  return guarded((value, pointer, out) => {
    let empty = false;
    listForm(partForm, SOURCE_PART_LIMIT, true, (length) => {
      empty = length === 0;
    })(value, pointer, out);
    if (empty) refuse(out, pointer);
  });
}

/**
 * The path a source answer names: a list of text exactly the request's `expected` path, its length refused at the list
 * before any segment is read, and a segment other than the request's refused at its index.
 */
function echoedPathForm(expected: readonly string[]): Form {
  return guarded((value, pointer, out) => {
    const segments = new Map(expected.map((segment, index) => [pointerTo(pointer, index), segment]));
    let echoed = true;
    const segmentForm: Form = (segment, at, into) => {
      if (echoed && segment !== segments.get(at)) refuse(into, at);
    };
    treeListForm(segmentForm, ANSWER_LIST_MAX.path, (length) => {
      if (length === expected.length) return;
      echoed = false;
      refuse(out, pointer);
    })(value, pointer, out);
  });
}

/**
 * Every way `answer`, what an `objects.source` call answered `request`, is not the SDK's closed source document
 * (clause C-115), as `source-answer-unreadable` at a pointer into the answer: a plain record of exactly `path`, the
 * request's path segment by segment (`echoedPathForm`), `kind`, the request's kind, and `parts` (`partListForm`). An
 * optional member present as an own `undefined` reads as absent, as does a member of another form of a part; a getter
 * is refused, never called, an inherited property is never read, and no refusal carries a value. A reading that
 * throws, a revoked Proxy or a trap that throws, is refused at the pointer being read, so this never throws.
 */
function sourceAnswerRefusals(request: SourceRequest, answer: unknown): readonly CallRefusal[] {
  const out: Refusals = { rule: "source-answer-unreadable", list: [] };
  recordForm<ObjectSourceDocument>({
    path: required(echoedPathForm(request.path)),
    kind: required(exactlyForm(request.kind)),
    parts: required(partListForm()),
  })(answer, "", out);
  return out.list;
}

/**
 * `answer`, what an `objects.source` call answered `request`, read against the SDK's closed source document
 * (`sourceAnswerRefusals`): the answer itself, typed as `ObjectSourceDocument`, where nothing is refused, and the
 * refusals otherwise. A text past `SOURCE_CHARACTER_LIMIT` is read, not refused: `boundSourceAnswer` cuts it. Never
 * throws.
 */
export function checkSourceAnswer(request: SourceRequest, answer: unknown): AnswerCheck<ObjectSourceDocument> {
  return checked(answer, sourceAnswerRefusals(request, answer));
}
