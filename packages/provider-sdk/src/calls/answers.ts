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
 * against the form its request's action answers: every record closed over the members the SDK's object tree types
 * state, a key outside them refused by name, and a value of another type, more details than the request's limit or
 * `needsConfiguration` where clause C-61 does not allow it refused at its pointer as `tree-answer-unreadable`.
 *
 * Each reader reads the answer by its own property descriptors: a getter is never called but refused, an inherited
 * property is never read, and no refusal carries a value of the answer. An optional member present as an own data
 * property whose value is `undefined` reads as absent, in both answers, since the SDK's optional types admit it; a
 * required member present so is missing.
 */
import { isPlainRecord, pointerTo, readOwn } from "./records";
import type { CallRefusal } from "./refusals";
import type { TreeRequest } from "./types";

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
 * Never throws: an answer that is no object has none of its members.
 */
export function checkExecuteAnswer(answer: unknown): readonly CallRefusal[] {
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

/** The refusal of the tree answer member at `pointer`, or of its key `name`, a key the form cannot have. */
function treeUnreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "tree-answer-unreadable", pointer }
    : { rule: "tree-answer-unreadable", pointer, name };
}

/** How one value of a tree answer is read: each way it is not its form, appended to `out`, pointed at `pointer`. */
type TreeForm = (value: unknown, pointer: string, out: CallRefusal[]) => void;

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

/**
 * A list of `item`: an own data array, each index an own data element read as `item`; a hole or an accessor is refused
 * at its index.
 */
function listForm(item: TreeForm): TreeForm {
  return (value, pointer, out) => {
    if (!Array.isArray(value)) {
      out.push(treeUnreadable(pointer));
      return;
    }
    const items: readonly unknown[] = value;
    for (let index = 0; index < items.length; index++) {
      const read = readOwn(items, String(index));
      const at = pointerTo(pointer, index);
      if (read.kind === "data") item(read.value, at, out);
      else out.push(treeUnreadable(at));
    }
  };
}

/**
 * A closed record of `required` and `optional` members: a plain record, refused once at its pointer otherwise. Each own
 * key is read in the answer's order: a key neither names is refused by name, an accessor at its pointer, and a data
 * member as its form, except an optional member whose value is `undefined`, which reads as absent. A required member
 * the record does not have is then refused at its pointer, in the form's order.
 */
function recordForm(
  required: Readonly<Record<string, TreeForm>>,
  optional: Readonly<Record<string, TreeForm>> = {},
): TreeForm {
  return (value, pointer, out) => {
    if (!isPlainRecord(value)) {
      out.push(treeUnreadable(pointer));
      return;
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const at = pointerTo(pointer, key);
      const isRequired = Object.hasOwn(required, key);
      const form = isRequired ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
      const read = readOwn(value, key);
      if (form === undefined) out.push(treeUnreadable(at, key));
      else if (read.kind !== "data") out.push(treeUnreadable(at));
      else if (isRequired || read.value !== undefined) form(read.value, at, out);
    }
    for (const key of Object.keys(required)) {
      if (!Object.hasOwn(value, key)) out.push(treeUnreadable(pointerTo(pointer, key)));
    }
  };
}

/**
 * A record of one of several closed forms, chosen by the first of `forms` whose key the record has as its own,
 * `otherwise` when it has none of them.
 */
function chosenForm(forms: readonly (readonly [string, TreeForm])[], otherwise: TreeForm): TreeForm {
  return (value, pointer, out) => {
    const chosen = forms.find(([key]) => readOwn(value, key).kind !== "absent");
    (chosen === undefined ? otherwise : chosen[1])(value, pointer, out);
  };
}

const textListForm = listForm(textForm);

/** The SDK's `Container`. */
const containerForm = recordForm(
  { path: textListForm, name: textForm, level: countForm },
  { isSessionDefault: flagForm, kinds: textListForm },
);

/** The SDK's `KindCount`: the engine's sentence when it has an own `unavailable`, a count otherwise. */
const kindCountForm = chosenForm(
  [["unavailable", recordForm({ unavailable: textForm })]],
  recordForm({ count: countForm }, { sampledFrom: textForm }),
);

/** A count answer's counts: a plain record whose every own key is a kind, any text, and every value a `KindCount`. */
const countsForm: TreeForm = (value, pointer, out) => {
  if (!isPlainRecord(value)) {
    out.push(treeUnreadable(pointer));
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const read = readOwn(value, key);
    const at = pointerTo(pointer, key);
    if (read.kind === "data") kindCountForm(read.value, at, out);
    else out.push(treeUnreadable(at));
  }
};

/** The SDK's `ObjectReadRange`: one key, every key under a prefix, or a range, told apart by their own keys. */
const readRangeForm = chosenForm(
  [
    ["key", recordForm({ key: textForm })],
    ["prefix", recordForm({ prefix: textForm })],
  ],
  recordForm({ start: textForm, end: textForm }),
);

/** The SDK's `DatabaseObject`. */
const objectForm = recordForm(
  { path: textListForm, name: textForm, kind: textForm },
  { status: textForm, rowCount: countForm, sizeBytes: countForm, readRanges: listForm(readRangeForm) },
);

/** The SDK's `ColumnSchema`. */
const columnForm = recordForm(
  { name: textForm, type: textForm, nullable: flagForm, isPrimary: flagForm },
  {
    baseType: textForm,
    declaredType: textForm,
    defaultValue: textForm,
    defaultExpression: textForm,
    provenance: provenanceForm,
    projectable: flagForm,
  },
);

const indexListForm = listForm(recordForm({ name: textForm, columns: textListForm, unique: flagForm }));
const indexesUnavailableForm = recordForm({ unavailable: textForm });

/** An object's indexes: a list of the SDK's `IndexSchema`, or the engine's sentence where the read was refused. */
const indexesForm: TreeForm = (value, pointer, out) => {
  (Array.isArray(value) ? indexListForm : indexesUnavailableForm)(value, pointer, out);
};

/** The SDK's `ObjectDetail`. */
const detailForm = recordForm(
  {
    path: textListForm,
    columns: listForm(columnForm),
    indexes: indexesForm,
    foreignKeys: listForm(recordForm({ columnName: textForm, referencedTable: textForm, referencedColumn: textForm })),
  },
  { exclusionConstraints: listForm(recordForm({ name: textForm, definition: textForm })) },
);

const containersAnswerForm = recordForm({ containers: listForm(containerForm) }, { needsConfiguration: textForm });
const countAnswerForm = recordForm({ counts: countsForm });
const listAnswerForm = recordForm({ objects: listForm(objectForm) });
const describeAnswerForm = recordForm({ detail: detailForm });
const batchForm = recordForm(
  { details: listForm(detailForm) },
  { truncated: recordForm({ limit: countForm, reason: textForm }) },
);

/** The length of `answer`'s own data array `key`, or undefined when it holds none there. */
function ownLength(answer: unknown, key: string): number | undefined {
  const value = readOwnData(answer, key);
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * Every way `answer`, what an `objects.tree` call answered `request`, is not its action's form (clause C-62), as
 * `tree-answer-unreadable` at a pointer into the answer: a `containers` request answers `TreeContainersAnswer`, a
 * `count` request `TreeCountAnswer`, a `list` request `TreeListAnswer`, a `describe` request `TreeDescribeAnswer` and a
 * `describeMany` request `ObjectDetailBatch`, each record closed over the members the SDK's object tree types state, every
 * count a non-negative safe integer. Past the form it refuses `needsConfiguration` sent with a `parent` or beside a
 * container (clause C-61), and more details than a `describeMany` request's `limit`. An optional member present as an
 * own `undefined` reads as absent; a getter is refused, never called, an inherited property is never read, and no
 * refusal carries a value. Never throws; an action no form exists for is not this check's, and answers no refusal.
 */
export function checkTreeAnswer(request: TreeRequest, answer: unknown): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  switch (request.action) {
    case "containers": {
      containersAnswerForm(answer, "", refusals);
      const needsConfiguration = readOwnData(answer, "needsConfiguration");
      const listed = ownLength(answer, "containers") ?? 0;
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
      const described = ownLength(answer, "details");
      if (request.limit !== undefined && described !== undefined && described > request.limit) {
        refusals.push(treeUnreadable("/details"));
      }
      break;
    }
  }
  return refusals;
}
