/**
 * The host's reading of what a console execute and an object tree call answered (docs/providers/CONTRACT.md, clauses
 * C-48, C-62 and C-112).
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
 * typecheck here until its form names it, as the frame reader's shapes do. A reading of the tree answer that throws, a
 * revoked Proxy or a trap that throws, is refused at the pointer being read, so the tree check never throws.
 *
 * Each check answers an `AnswerCheck`: the answer itself, by reference, typed as the form it was read as, where it
 * refuses nothing, and its refusals alone otherwise, so a caller past the check reads the answer typed with no cast of
 * its own.
 *
 * Each reader reads the answer by its own property descriptors: a getter is never called but refused, an inherited
 * property is never read, and no refusal carries a value of the answer. An optional member present as an own data
 * property whose value is `undefined` reads as absent, in both answers, since the SDK's optional types admit it, and
 * so does a member of another arm of a union in a tree answer; a required member present so is missing.
 */
import { isPlainRecord, type OwnRead, pointerTo, readOwn } from "./records";
import type { CallRefusal } from "./refusals";
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
  ObjectReadRange,
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

/** The members a warning can have: its message, and its optional code and severity. */
const WARNING_MEMBERS: readonly string[] = Object.freeze(["message", "code", "severity"]);

/** The refusal of the member at `pointer`. */
function unreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "execute-answer-unreadable", pointer }
    : { rule: "execute-answer-unreadable", pointer, name };
}

/** Whether `value` is a count: a non-negative safe integer. */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Every way the warning at `pointer` is not the SDK's `Warning`: no plain record, refused once at its pointer; any own
 * key but its message, code and severity, named; a message that is missing, an accessor or not text; a code that is an
 * accessor or neither text nor a number; a severity that is an accessor or not text.
 */
function warningRefusals(warning: unknown, pointer: string): readonly CallRefusal[] {
  if (!isPlainRecord(warning)) return [unreadable(pointer)];
  const refusals: CallRefusal[] = [];
  for (const key of Object.getOwnPropertyNames(warning)) {
    if (!WARNING_MEMBERS.includes(key)) refusals.push(unreadable(pointerTo(pointer, key), key));
  }
  const message = readOwn(warning, "message");
  if (message.kind !== "data" || typeof message.value !== "string") {
    refusals.push(unreadable(pointerTo(pointer, "message")));
  }
  const code = readOwn(warning, "code");
  if (
    code.kind === "accessor" ||
    (code.kind === "data" &&
      code.value !== undefined &&
      typeof code.value !== "string" &&
      typeof code.value !== "number")
  ) {
    refusals.push(unreadable(pointerTo(pointer, "code")));
  }
  const severity = readOwn(warning, "severity");
  if (
    severity.kind === "accessor" ||
    (severity.kind === "data" && severity.value !== undefined && typeof severity.value !== "string")
  ) {
    refusals.push(unreadable(pointerTo(pointer, "severity")));
  }
  return refusals;
}

/**
 * Every way the first result's columns at `pointer` cannot key a row: no own data array, refused once at its pointer;
 * a column that is no object, or whose name is missing, an accessor, not text or empty, refused at the name's pointer;
 * and a name an earlier column of the result already has, refused at the later column's name.
 */
function columnRefusals(columns: unknown, pointer: string): readonly CallRefusal[] {
  if (!Array.isArray(columns)) return [unreadable(pointer)];
  const refusals: CallRefusal[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < columns.length; index++) {
    const name = readOwn(readOwnData(columns, String(index)), "name");
    const at = pointerTo(pointerTo(pointer, index), "name");
    if (name.kind !== "data" || typeof name.value !== "string" || name.value === "" || seen.has(name.value)) {
      refusals.push(unreadable(at));
      continue;
    }
    seen.add(name.value);
  }
  return refusals;
}

/**
 * Every way the first result of `results`, an own data array, cannot be read: its columns (`columnRefusals`), and an
 * own row count that is an accessor or not a count. A row count it does not have is not refused: a provider gives one
 * only where its engine answered it. A first result that is no object has no columns.
 */
function firstResultRefusals(results: readonly unknown[]): readonly CallRefusal[] {
  if (results.length === 0) return [];
  const source = readOwnData(results, "0");
  const refusals: CallRefusal[] = [...columnRefusals(readOwnData(source, "columns"), "/results/0/columns")];
  const rowCount = readOwn(source, "rowCount");
  if (
    rowCount.kind === "accessor" ||
    (rowCount.kind === "data" && rowCount.value !== undefined && !isCount(rowCount.value))
  ) {
    refusals.push(unreadable("/results/0/rowCount"));
  }
  return refusals;
}

/** The own data property `key` of `target`, or undefined when it is absent or an accessor. */
function readOwnData(target: unknown, key: string): unknown {
  const read = readOwn(target, key);
  return read.kind === "data" ? read.value : undefined;
}

/**
 * Every way `answer`, what a console execute answered, is not readable where the host reads it, in this order: the
 * result list at `/results`, an own data array; its first result's columns and row count (`firstResultRefusals`), no
 * later result read; the execution time at `/executionTimeMs`, a finite non-negative number; the warning list at
 * `/warnings`, an own data array, and each warning in it (`warningRefusals`). A member that is missing, an accessor or
 * not of its type is refused at its pointer, a key a warning cannot have is named, and no refusal carries a value.
 * An answer that is no object has none of its members.
 */
function executeAnswerRefusals(answer: unknown): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  const results = readOwn(answer, "results");
  if (results.kind === "data" && Array.isArray(results.value)) {
    refusals.push(...firstResultRefusals(results.value));
  } else {
    refusals.push(unreadable("/results"));
  }
  const executionTimeMs = readOwn(answer, "executionTimeMs");
  if (
    executionTimeMs.kind !== "data" ||
    typeof executionTimeMs.value !== "number" ||
    !Number.isFinite(executionTimeMs.value) ||
    executionTimeMs.value < 0
  ) {
    refusals.push(unreadable("/executionTimeMs"));
  }
  const warnings = readOwn(answer, "warnings");
  if (warnings.kind !== "data" || !Array.isArray(warnings.value)) {
    refusals.push(unreadable("/warnings"));
    return refusals;
  }
  const list: readonly unknown[] = warnings.value;
  for (let index = 0; index < list.length; index++) {
    refusals.push(...warningRefusals(readOwnData(list, String(index)), pointerTo("/warnings", index)));
  }
  return refusals;
}

/**
 * `answer`, what a console execute answered, read where the host reads it (`executeAnswerRefusals`): the answer itself,
 * typed as the SDK's `ExecuteAnswer`, where no member the host reads here is refused, and the refusals otherwise. The
 * members it does not read are read where the module's docblock says. A reading that throws, a Proxy's trap, passes to
 * the caller.
 */
export function checkExecuteAnswer(answer: unknown): AnswerCheck<ExecuteAnswer> {
  return checked(answer, executeAnswerRefusals(answer));
}

/** The refusal of the tree answer member at `pointer`, or of its key `name`, a key the form cannot have. */
function treeUnreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "tree-answer-unreadable", pointer }
    : { rule: "tree-answer-unreadable", pointer, name };
}

/** How one value of a tree answer is read: each way it is not its form, appended to `out`, pointed at `pointer`. */
type TreeForm = (value: unknown, pointer: string, out: CallRefusal[]) => void;

/**
 * `form`, with a throw while it reads its value, a revoked Proxy or a trap that throws, refused at the value's pointer,
 * so no reading of an answer throws past the check. Every form that reads more than the value's type is guarded.
 */
function guarded(form: TreeForm): TreeForm {
  return (value, pointer, out) => {
    try {
      form(value, pointer, out);
    } catch {
      out.push(treeUnreadable(pointer));
    }
  };
}

/** The own property `key` of `target` (`readOwn`), or undefined, its pointer `at` refused, when reading it throws. */
function readAt(target: unknown, key: string, at: string, out: CallRefusal[]): OwnRead | undefined {
  try {
    return readOwn(target, key);
  } catch {
    out.push(treeUnreadable(at));
    return undefined;
  }
}

/** Text. */
const textForm: TreeForm = (value, pointer, out) => {
  if (typeof value !== "string") out.push(treeUnreadable(pointer));
};

/** A boolean. */
const flagForm: TreeForm = (value, pointer, out) => {
  if (typeof value !== "boolean") out.push(treeUnreadable(pointer));
};

/** A count: a non-negative safe integer, as an execute answer's row count is read. */
const countForm: TreeForm = (value, pointer, out) => {
  if (!isCount(value)) out.push(treeUnreadable(pointer));
};

/** A column's provenance: the one word the SDK states, `"sampled"`. */
const provenanceForm: TreeForm = (value, pointer, out) => {
  if (value !== "sampled") out.push(treeUnreadable(pointer));
};

/** Whether `key` is an index of a list of `length` items: a canonical array index below the length. */
function isIndexOf(key: string, length: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length;
}

/**
 * A list of `item`: an own data array, each index an own data element read as `item`; a hole or an accessor is refused
 * at its index, and an own key that is neither an index nor `length` is refused by name, as a record's key outside its
 * form is.
 */
function listForm(item: TreeForm): TreeForm {
  return guarded((value, pointer, out) => {
    if (!Array.isArray(value)) {
      out.push(treeUnreadable(pointer));
      return;
    }
    const items: readonly unknown[] = value;
    const length = items.length;
    for (let index = 0; index < length; index++) {
      const at = pointerTo(pointer, index);
      const read = readAt(items, String(index), at, out);
      if (read === undefined) continue;
      if (read.kind === "data") item(read.value, at, out);
      else out.push(treeUnreadable(at));
    }
    for (const key of Object.getOwnPropertyNames(items)) {
      if (key !== "length" && !isIndexOf(key, length)) out.push(treeUnreadable(pointerTo(pointer, key), key));
    }
  });
}

/** A member a record form reads where the SDK type requires it. */
interface RequiredMember {
  readonly required: TreeForm;
}

/** A member a record form reads where the SDK type admits a value without it. */
interface OptionalMember {
  readonly optional: TreeForm;
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

const required = (form: TreeForm): RequiredMember => ({ required: form });
const optional = (form: TreeForm): OptionalMember => ({ optional: form });

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
function closedForm(members: Members, absentKeys: readonly string[]): TreeForm {
  return guarded((value, pointer, out) => {
    if (!isPlainRecord(value)) {
      out.push(treeUnreadable(pointer));
      return;
    }
    const keys = Object.getOwnPropertyNames(value);
    for (const key of keys) {
      const at = pointerTo(pointer, key);
      const member = Object.hasOwn(members, key) ? members[key] : undefined;
      const read = readAt(value, key, at, out);
      if (read === undefined) continue;
      if (member === undefined) {
        if (!(absentKeys.includes(key) && read.kind === "data" && read.value === undefined)) {
          out.push(treeUnreadable(at, key));
        }
      } else if (read.kind !== "data") out.push(treeUnreadable(at));
      else if ("required" in member) member.required(read.value, at, out);
      else if (read.value !== undefined) member.optional(read.value, at, out);
    }
    for (const [key, member] of Object.entries(members)) {
      if ("required" in member && !keys.includes(key)) out.push(treeUnreadable(pointerTo(pointer, key)));
    }
  });
}

/** A closed record of the SDK type `T`, read as `shape` names its members (`closedForm`). */
function recordForm<T>(shape: TreeShape<T>): TreeForm {
  return closedForm(shape, []);
}

/**
 * A record of one of the closed forms of a union's arms, chosen by the first of `arms` whose key the record has as its
 * own accessor or as its own data property with a value, `otherwise` when it has none of them. A member of another
 * arm present with the value `undefined` reads as absent in the arm chosen, as an optional member does, so no
 * undefined member chooses an arm or is refused in one; one with a value is refused by name, as any key the arm cannot
 * have.
 */
function chosenForm(arms: readonly (readonly [string, Members])[], otherwise: Members): TreeForm {
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

const textListForm = listForm(textForm);

/** The SDK's `Container`. */
const containerForm = recordForm<Container>({
  path: required(textListForm),
  name: required(textForm),
  level: required(countForm),
  isSessionDefault: optional(flagForm),
  kinds: optional(textListForm),
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
const countsForm: TreeForm = guarded((value, pointer, out) => {
  if (!isPlainRecord(value)) {
    out.push(treeUnreadable(pointer));
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const at = pointerTo(pointer, key);
    const read = readAt(value, key, at, out);
    if (read === undefined) continue;
    if (read.kind === "data") kindCountForm(read.value, at, out);
    else out.push(treeUnreadable(at));
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
  path: required(textListForm),
  name: required(textForm),
  kind: required(textForm),
  status: optional(textForm),
  rowCount: optional(countForm),
  sizeBytes: optional(countForm),
  readRanges: optional(listForm(readRangeForm)),
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

const indexListForm = listForm(
  recordForm<IndexSchema>({ name: required(textForm), columns: required(textListForm), unique: required(flagForm) }),
);
const indexesUnavailableForm = recordForm<Extract<ObjectDetail["indexes"], { readonly unavailable: string }>>({
  unavailable: required(textForm),
});

/** An object's indexes: a list of the SDK's `IndexSchema`, or the engine's sentence where the read was refused. */
const indexesForm: TreeForm = guarded((value, pointer, out) => {
  (Array.isArray(value) ? indexListForm : indexesUnavailableForm)(value, pointer, out);
});

/** The SDK's `ObjectDetail`. */
const detailForm = recordForm<ObjectDetail>({
  path: required(textListForm),
  columns: required(listForm(columnForm)),
  indexes: required(indexesForm),
  foreignKeys: required(
    listForm(
      recordForm<ForeignKeySchema>({
        columnName: required(textForm),
        referencedTable: required(textForm),
        referencedColumn: required(textForm),
      }),
    ),
  ),
  exclusionConstraints: optional(
    listForm(recordForm<ExclusionConstraintSchema>({ name: required(textForm), definition: required(textForm) })),
  ),
});

const containersAnswerForm = recordForm<TreeContainersAnswer>({
  containers: required(listForm(containerForm)),
  needsConfiguration: optional(textForm),
});
const countAnswerForm = recordForm<TreeCountAnswer>({ counts: required(countsForm) });
const listAnswerForm = recordForm<TreeListAnswer>({ objects: required(listForm(objectForm)) });
const describeAnswerForm = recordForm<TreeDescribeAnswer>({ detail: required(detailForm) });
const batchForm = recordForm<ObjectDetailBatch>({
  details: required(listForm(detailForm)),
  truncated: optional(
    recordForm<NonNullable<ObjectDetailBatch["truncated"]>>({ limit: required(countForm), reason: required(textForm) }),
  ),
});

/**
 * The own data property `key` of `answer`, a record its form already read, read again past the form; undefined, its
 * pointer refused, when this reading throws.
 */
function readAgain(answer: unknown, key: string, out: CallRefusal[]): unknown {
  const read = readAt(answer, key, pointerTo("", key), out);
  return read?.kind === "data" ? read.value : undefined;
}

/**
 * The length of `answer`'s own data array `key`, read again past the form, or undefined when it holds none there or,
 * its pointer refused, when reading the length throws.
 */
function lengthAgain(answer: unknown, key: string, out: CallRefusal[]): number | undefined {
  const value = readAgain(answer, key, out);
  if (!Array.isArray(value)) return undefined;
  try {
    return value.length;
  } catch {
    out.push(treeUnreadable(pointerTo("", key)));
    return undefined;
  }
}

/**
 * Every way `answer`, what an `objects.tree` call answered `request`, is not its action's form (clause C-62), as
 * `tree-answer-unreadable` at a pointer into the answer: a `containers` request answers `TreeContainersAnswer`, a
 * `count` request `TreeCountAnswer`, a `list` request `TreeListAnswer`, a `describe` request `TreeDescribeAnswer` and a
 * `describeMany` request `ObjectDetailBatch`, each record and each list closed over the members the SDK's object tree
 * types state, every count a non-negative safe integer. Past the form it refuses `needsConfiguration` sent with a
 * `parent` or beside a container (clause C-61), and more details than a `describeMany` request's `limit`, reading
 * neither of an answer that is no record nor a list the form refused, so no pointer is refused twice. An optional member present as an own `undefined` reads as absent, as does a
 * member of another arm of a union; a getter is refused, never called, an inherited property is never read, and no
 * refusal carries a value. A reading that throws, a revoked Proxy or a trap that throws, is refused at the pointer
 * being read, so this never throws. An action no form exists for is not this check's, and answers no refusal.
 */
function treeAnswerRefusals(request: TreeRequest, answer: unknown): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  const refusedAt = (pointer: string): boolean => refusals.some((refusal) => refusal.pointer === pointer);
  switch (request.action) {
    case "containers": {
      containersAnswerForm(answer, "", refusals);
      if (refusedAt("")) break;
      const needsConfiguration = readAgain(answer, "needsConfiguration", refusals);
      const listed = refusedAt("/containers") ? 0 : (lengthAgain(answer, "containers", refusals) ?? 0);
      if (typeof needsConfiguration === "string" && (request.parent !== undefined || listed > 0)) {
        refusals.push(treeUnreadable("/needsConfiguration"));
      }
      break;
    }
    case "count":
      countAnswerForm(answer, "", refusals);
      break;
    case "list":
      listAnswerForm(answer, "", refusals);
      break;
    case "describe":
      describeAnswerForm(answer, "", refusals);
      break;
    case "describeMany": {
      batchForm(answer, "", refusals);
      if (refusedAt("") || refusedAt("/details")) break;
      const described = lengthAgain(answer, "details", refusals);
      if (request.limit !== undefined && described !== undefined && described > request.limit) {
        refusals.push(treeUnreadable("/details"));
      }
      break;
    }
  }
  return refusals;
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
