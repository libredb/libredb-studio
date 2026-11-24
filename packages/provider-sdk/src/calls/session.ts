/**
 * A session's calls and the requests the host sends it (docs/providers/CONTRACT.md, clauses C-9, C-10, C-17, C-57,
 * C-67 and C-68).
 *
 * The manifest's `calls` declares what a package answers; `open` may answer a refinement that narrows it for one
 * session, which `checkRefinement` reads and `sessionCalls` applies. The refinement may also narrow the session's
 * maintenance to the placements its server accepts, which `sessionMaintenance` applies to the engine's declaration.
 * The host keeps the session's calls with the session, with no cache and no invalidation event, and holds every request
 * to them with `checkExecuteRequest` before the call, so a package is never sent a field it does not honour, and every
 * console facet call to it with `checkConsoleFacet`, every object facet call with `checkObjectsFacet` and every
 * maintenance facet call with `checkMaintenanceFacet`, so a package is never called on a facet the session does not
 * offer. It holds every maintenance run and preview request to the session's maintenance with
 * `checkMaintenanceRunRequest` and `checkMaintenancePreviewRequest`, so a package is never sent an operation or a
 * placement its session's maintenance does not offer.
 */
import type {
  Calls,
  ExecuteRequestField,
  FacetOffer,
  MaintenanceOperation,
  MaintenanceSpec,
} from "../manifest/manifest-types.generated";
import { isPlainRecord, pointerTo, readOwn } from "./records";
import { type CallRefusal, CallRefusalError } from "./refusals";
import {
  CONSOLE_FACETS,
  type ConsoleFacet,
  type EngineMaintenance,
  EXECUTE_REQUEST_FIELDS,
  type ExecuteRequest,
  MAINTENANCE_FACETS,
  MAINTENANCE_OPERATIONS,
  type MaintenanceAccepted,
  type MaintenanceFacet,
  type MaintenancePreviewRequest,
  type MaintenanceRunRequest,
  OBJECTS_FACETS,
  type ObjectsFacet,
  type Refinement,
} from "./types";

/**
 * Every way `request` sends what `calls` does not take, in request order: a `params` key, of any length, to a session
 * that does not honour `params`; a non-zero offset to one that does not honour `offset`; a `scope` key to one that does
 * not offer `console.endScope`, and one on a statement sent inside a transaction, which runs on the transaction's own
 * session and never in a scope; a `transaction` key to one that does not offer `console.transaction`. A refusal names
 * the field and a pointer into the request, never a value of it.
 */
export function checkExecuteRequest(calls: Calls, request: ExecuteRequest): readonly CallRefusal[] {
  const honours: readonly ExecuteRequestField[] = calls.console.execute.honours;
  const refusals: CallRefusal[] = [];
  if (Object.hasOwn(request, "params") && !honours.includes("params")) {
    refusals.push({ rule: "request-field-not-honoured", pointer: "/params", name: "params" });
  }
  if ("offset" in request.page && request.page.offset !== 0 && !honours.includes("offset")) {
    refusals.push({ rule: "request-field-not-honoured", pointer: "/page/offset", name: "offset" });
  }
  if (Object.hasOwn(request, "scope") && calls.console.endScope !== "offered") {
    refusals.push({ rule: "request-scope-not-offered", pointer: "/scope" });
  }
  const inTransaction = Object.hasOwn(request, "transaction");
  if (inTransaction && Object.hasOwn(request, "scope")) {
    refusals.push({ rule: "request-scope-in-transaction", pointer: "/scope" });
  }
  if (inTransaction && calls.console.transaction !== "offered") {
    refusals.push({ rule: "request-transaction-not-offered", pointer: "/transaction" });
  }
  return refusals;
}

/**
 * The refusal of a call to the console facet `facet` when `calls`, the session's calls, do not offer it, a refinement's
 * narrowing included: one `facet-not-offered` at the facet's pointer into the calls, named by its call name; none when
 * the session offers it.
 */
export function checkConsoleFacet(calls: Calls, facet: ConsoleFacet): readonly CallRefusal[] {
  if (calls.console[facet] === "offered") return [];
  return [{ rule: "facet-not-offered", pointer: pointerTo("/console", facet), name: `console.${facet}` }];
}

/**
 * The refusal of a call to the object facet `facet` when `calls`, the session's calls, do not offer it, a refinement's
 * narrowing included: one `facet-not-offered` at the facet's pointer into the calls, named by its call name; none when
 * the session offers it. The request is the host's own typed object and is not read here.
 */
export function checkObjectsFacet(calls: Calls, facet: ObjectsFacet): readonly CallRefusal[] {
  if (calls.objects[facet] === "offered") return [];
  return [{ rule: "facet-not-offered", pointer: pointerTo("/objects", facet), name: `objects.${facet}` }];
}

/**
 * The refusal of a call to the maintenance facet `facet` when `calls`, the session's calls, do not offer it, a
 * refinement's narrowing included: one `facet-not-offered` at the facet's pointer into the calls, named by its call
 * name; none when the session offers it. The request is the host's own typed object and is not read here.
 */
export function checkMaintenanceFacet(calls: Calls, facet: MaintenanceFacet): readonly CallRefusal[] {
  if (calls.maintenance[facet] === "offered") return [];
  return [{ rule: "facet-not-offered", pointer: pointerTo("/maintenance", facet), name: `maintenance.${facet}` }];
}

/**
 * The spec of `operation` in `maintenance`, or `undefined` with a `request-operation-not-offered` refusal when the
 * maintenance does not list the operation; `undefined` alone for a listed operation with no spec.
 */
function listedSpec(
  maintenance: EngineMaintenance,
  operation: MaintenanceOperation,
  refusals: CallRefusal[],
): { readonly listed: boolean; readonly spec?: MaintenanceSpec } {
  if (!(maintenance.maintenance as readonly unknown[]).includes(operation)) {
    refusals.push({ rule: "request-operation-not-offered", pointer: "/operation" });
    return { listed: false };
  }
  return { listed: true, spec: maintenance.maintenanceSpecs.find((spec) => spec.operation === operation) };
}

/**
 * Every way `request` asks `maintenance`, the session's maintenance, for a run it does not offer, in request order: an
 * operation it does not list; an empty `target`, which names nothing; a placement the operation's spec does not offer,
 * a target where it offers no row or no target where it offers no whole database; an empty `container`. An operation
 * its spec places nowhere, `kill`, takes its target from somewhere neither placement describes and passes, as does an
 * operation listed with no spec. A refusal names a pointer into the request, and the field for an empty one, never a
 * value of it.
 */
export function checkMaintenanceRunRequest(
  maintenance: EngineMaintenance,
  request: MaintenanceRunRequest,
): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  const { spec } = listedSpec(maintenance, request.operation, refusals);
  if (request.target === "") {
    refusals.push({ rule: "request-field-empty", pointer: "/target", name: "target" });
  } else if (spec !== undefined && (spec.perEntity || spec.global)) {
    const placed = request.target === undefined ? spec.global : spec.perEntity;
    if (!placed) refusals.push({ rule: "request-placement-not-offered", pointer: "/target" });
  }
  if (request.container === "") {
    refusals.push({ rule: "request-field-empty", pointer: "/container", name: "container" });
  }
  return refusals;
}

/**
 * Every way `request` asks `maintenance`, the session's maintenance, for a preview it does not offer, in request order:
 * an operation it does not list, or one whose spec does not declare a preview on a row, since a preview belongs to a
 * per-row control; an empty `path`, and each name in it that is empty text. A `path` that is not a list is not read
 * here: it is not a request of this shape, and reading the request's frame refuses it by name. A refusal names a
 * pointer into the request, and the field for an empty one, never a value of it.
 */
export function checkMaintenancePreviewRequest(
  maintenance: EngineMaintenance,
  request: MaintenancePreviewRequest,
): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  const { listed, spec } = listedSpec(maintenance, request.operation, refusals);
  if (listed && !(spec !== undefined && spec.perEntity && spec.preview)) {
    refusals.push({ rule: "request-preview-not-offered", pointer: "/operation" });
  }
  const path: unknown = request.path;
  if (!Array.isArray(path)) return refusals;
  if (path.length === 0) refusals.push({ rule: "request-field-empty", pointer: "/path", name: "path" });
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === "") {
      refusals.push({ rule: "request-field-empty", pointer: pointerTo("/path", index), name: "path" });
    }
  }
  return refusals;
}

const OFFERS: readonly unknown[] = Object.freeze(["offered", "not-offered"] satisfies FacetOffer[]);
const REQUEST_FIELDS: readonly unknown[] = EXECUTE_REQUEST_FIELDS;
/** The keys a refinement's `calls.console` may have: execute, then every console facet, in schema order. */
const CONSOLE_KEYS: readonly string[] = Object.freeze(["execute", ...CONSOLE_FACETS]);

/** Whether `key` names a console facet. */
function isConsoleFacet(key: string): key is ConsoleFacet {
  return (CONSOLE_FACETS as readonly string[]).includes(key);
}

/**
 * The own string keys of `value`, a plain record, enumerable or not, so the object is read as closed; `null` with a
 * `refinement-unreadable` refusal at `pointer` when `value` is no plain record.
 */
function closedRecord(value: unknown, pointer: string, refusals: CallRefusal[]): readonly string[] | null {
  if (isPlainRecord(value)) return Object.getOwnPropertyNames(value);
  refusals.push({ rule: "refinement-unreadable", pointer });
  return null;
}

/**
 * The value at `key` of `record`, or `undefined` with a `refinement-unreadable` refusal at `pointer` when it is an
 * accessor, whose getter is never called.
 */
function dataAt(
  record: unknown,
  key: string,
  pointer: string,
  refusals: CallRefusal[],
): { readonly value: unknown } | undefined {
  const read = readOwn(record, key);
  if (read.kind === "data") return { value: read.value };
  refusals.push({ rule: "refinement-unreadable", pointer });
  return undefined;
}

/** The refusals of a refinement's facet offer against the declared one. */
function readOffer(value: unknown, declared: FacetOffer, pointer: string, refusals: CallRefusal[]): void {
  if (!OFFERS.includes(value)) refusals.push({ rule: "refinement-unreadable", pointer });
  else if (value === "offered" && declared !== "offered") refusals.push({ rule: "refinement-widens", pointer });
}

/**
 * The refusals of a refinement's `honours` list against the declared one. A list longer than the declared one cannot be
 * a subset of it, so it is refused as `refinement-widens` at the list, by its length, before any item is read: a sparse
 * array's length bounds no loop over it.
 */
function readHonours(
  value: unknown,
  declared: readonly ExecuteRequestField[],
  pointer: string,
  refusals: CallRefusal[],
): void {
  if (!Array.isArray(value)) {
    refusals.push({ rule: "refinement-unreadable", pointer });
    return;
  }
  if (value.length > declared.length) {
    refusals.push({ rule: "refinement-widens", pointer });
    return;
  }
  const seen: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const at = pointerTo(pointer, index);
    const item = dataAt(value, String(index), at, refusals);
    if (item === undefined) continue;
    if (!REQUEST_FIELDS.includes(item.value) || seen.includes(item.value)) {
      refusals.push({ rule: "refinement-unreadable", pointer: at });
    } else if (!(declared as readonly unknown[]).includes(item.value)) {
      refusals.push({ rule: "refinement-widens", pointer: at });
    }
    seen.push(item.value);
  }
}

/** The refusals of a refinement's `calls.console.execute`. */
function readExecute(value: unknown, declared: Calls, pointer: string, refusals: CallRefusal[]): void {
  const keys = closedRecord(value, pointer, refusals);
  if (keys === null) return;
  if (!keys.includes("honours"))
    refusals.push({ rule: "refinement-unreadable", pointer: pointerTo(pointer, "honours") });
  for (const key of keys) {
    const at = pointerTo(pointer, key);
    if (key !== "honours") {
      refusals.push({ rule: "refinement-key-unknown", pointer: at, name: key });
      continue;
    }
    const honours = dataAt(value, key, at, refusals);
    if (honours !== undefined) readHonours(honours.value, declared.console.execute.honours, at, refusals);
  }
}

/** The refusals of a refinement's `calls.console`. */
function readConsole(value: unknown, declared: Calls, pointer: string, refusals: CallRefusal[]): void {
  const keys = closedRecord(value, pointer, refusals);
  if (keys === null) return;
  for (const key of keys) {
    const at = pointerTo(pointer, key);
    if (!CONSOLE_KEYS.includes(key)) {
      refusals.push({ rule: "refinement-key-unknown", pointer: at, name: key });
      continue;
    }
    const read = dataAt(value, key, at, refusals);
    if (read === undefined) continue;
    if (isConsoleFacet(key)) readOffer(read.value, declared.console[key], at, refusals);
    else readExecute(read.value, declared, at, refusals);
  }
}

/** The refusals of a refinement's `calls.objects`. */
function readObjects(value: unknown, declared: Calls, pointer: string, refusals: CallRefusal[]): void {
  readClosed(value, OBJECTS_FACETS, pointer, refusals, (facet, offer, at) =>
    readOffer(offer, declared.objects[facet], at, refusals),
  );
}

/** The refusals of a refinement's `calls.maintenance`. */
function readMaintenance(value: unknown, declared: Calls, pointer: string, refusals: CallRefusal[]): void {
  readClosed(value, MAINTENANCE_FACETS, pointer, refusals, (facet, offer, at) =>
    readOffer(offer, declared.maintenance[facet], at, refusals),
  );
}

/**
 * The reader of each segment a refinement's `calls` may have, one per segment of the manifest's calls, in schema order.
 * It satisfies a type over every segment, so a segment the calls gain fails typecheck here until it has a reader of
 * its own, and is never read by another segment's, and a reader for a segment the calls do not have fails it too.
 */
const SEGMENT_READERS = Object.freeze({
  console: readConsole,
  objects: readObjects,
  maintenance: readMaintenance,
} satisfies {
  readonly [S in keyof Calls]: (value: unknown, declared: Calls, pointer: string, refusals: CallRefusal[]) => void;
});

/**
 * The keys a refinement's `calls` may have: the segments `SEGMENT_READERS` reads. Any other key is refused by name as
 * `refinement-key-unknown` before any reader runs.
 */
const CALLS_KEYS = Object.freeze(Object.keys(SEGMENT_READERS) as (keyof Calls)[]);

/** Whether `key` is one of `keys`. */
function isOneOf<Key extends string>(keys: readonly Key[], key: string): key is Key {
  return (keys as readonly string[]).includes(key);
}

/**
 * The refusals of a closed record whose keys may be only `keys`, each optional, in the record's own key order, each
 * value read by `read` with its key; a key not in `keys` is refused by name as `refinement-key-unknown` and not read.
 */
function readClosed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  pointer: string,
  refusals: CallRefusal[],
  read: (key: Key, value: unknown, at: string) => void,
): void {
  const own = closedRecord(value, pointer, refusals);
  if (own === null) return;
  for (const key of own) {
    const at = pointerTo(pointer, key);
    if (!isOneOf(keys, key)) {
      refusals.push({ rule: "refinement-key-unknown", pointer: at, name: key });
      continue;
    }
    const data = dataAt(value, key, at, refusals);
    if (data !== undefined) read(key, data.value, at);
  }
}

/** The members of a maintenance narrowing's item, each required. */
const ACCEPTED_KEYS = Object.freeze([
  "operation",
  "perEntity",
  "global",
] as const) satisfies readonly (keyof MaintenanceAccepted)[];
const OPERATIONS: readonly unknown[] = MAINTENANCE_OPERATIONS;

/**
 * The refusals of one item of a maintenance narrowing at `pointer`: a closed record of exactly its operation, one of
 * the vocabulary and none an earlier item named, which `seen` holds, and its two placements, each a boolean. A member
 * it lacks is refused as `refinement-unreadable` at the member's pointer.
 */
function readAccepted(item: unknown, pointer: string, seen: unknown[], refusals: CallRefusal[]): void {
  readClosed(item, ACCEPTED_KEYS, pointer, refusals, (key, value, at) => {
    if (key !== "operation") {
      if (typeof value !== "boolean") refusals.push({ rule: "refinement-unreadable", pointer: at });
      return;
    }
    if (!OPERATIONS.includes(value) || seen.includes(value))
      refusals.push({ rule: "refinement-unreadable", pointer: at });
    seen.push(value);
  });
  if (!isPlainRecord(item)) return;
  for (const key of ACCEPTED_KEYS) {
    if (!Object.hasOwn(item, key)) refusals.push({ rule: "refinement-unreadable", pointer: pointerTo(pointer, key) });
  }
}

/**
 * The refusals of a refinement's `maintenance`, at `pointer`: a list of the placements the session's server accepts,
 * each item read by `readAccepted`. A list longer than the operation vocabulary cannot name each operation once, so it
 * is refused as `refinement-unreadable` at the list, by its length, before any item is read: a sparse array's length
 * bounds no loop over it.
 */
function readNarrowing(value: unknown, pointer: string, refusals: CallRefusal[]): void {
  if (!Array.isArray(value) || value.length > OPERATIONS.length) {
    refusals.push({ rule: "refinement-unreadable", pointer });
    return;
  }
  const seen: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const at = pointerTo(pointer, index);
    const item = dataAt(value, String(index), at, refusals);
    if (item !== undefined) readAccepted(item.value, at, seen, refusals);
  }
}

/** The keys a refinement may have: the narrowing of its calls and the narrowing of its maintenance. */
const REFINEMENT_KEYS = Object.freeze(["calls", "maintenance"] as const) satisfies readonly (keyof Refinement)[];

/**
 * Every way `refine`, what `open` answered beside its handle, is not a refinement of `declared`, the manifest's calls,
 * in the refinement's own key order: a key a refinement cannot have (`refinement-key-unknown`), a value of the wrong
 * type, an accessor or a repeated field (`refinement-unreadable`), and a value that offers or honours more than
 * `declared` (`refinement-widens`). Its `maintenance` is read for its shape alone, since whether each operation is the
 * engine's is `sessionMaintenance`'s to read. `undefined` is no refinement. Every pointer is rooted at the refinement,
 * and no refusal carries a value of it; a getter is never called.
 */
export function checkRefinement(declared: Calls, refine: unknown): readonly CallRefusal[] {
  if (refine === undefined) return [];
  const refusals: CallRefusal[] = [];
  readClosed(refine, REFINEMENT_KEYS, "", refusals, (key, value, at) => {
    if (key === "maintenance") {
      readNarrowing(value, at, refusals);
      return;
    }
    readClosed(value, CALLS_KEYS, at, refusals, (segment, segmentValue, segmentAt) =>
      SEGMENT_READERS[segment](segmentValue, declared, segmentAt, refusals),
    );
  });
  return refusals;
}

/**
 * The refusals of the maintenance narrowing in `refine`, against `declared`, the session's engine's maintenance: the
 * shape `checkRefinement` reads, a refinement that is no plain record refused at its top level, and then each item
 * naming an operation `declared` does not list, refused as `refinement-widens` at its operation.
 */
function narrowingRefusals(declared: EngineMaintenance, refine: unknown): readonly CallRefusal[] {
  if (!isPlainRecord(refine)) return [{ rule: "refinement-unreadable", pointer: "" }];
  const read = readOwn(refine, "maintenance");
  if (read.kind === "absent") return [];
  if (read.kind === "accessor") return [{ rule: "refinement-unreadable", pointer: "/maintenance" }];
  const refusals: CallRefusal[] = [];
  readNarrowing(read.value, "/maintenance", refusals);
  if (refusals.length > 0) return refusals;
  const items = read.value as readonly MaintenanceAccepted[];
  const listed: readonly unknown[] = declared.maintenance;
  for (let index = 0; index < items.length; index += 1) {
    if (!listed.includes(items[index]?.operation)) {
      refusals.push({ rule: "refinement-widens", pointer: `/maintenance/${index}/operation` });
    }
  }
  return refusals;
}

/** `spec` copied with every list it holds, frozen. */
function frozenSpec(spec: MaintenanceSpec, perEntity: boolean, global: boolean): MaintenanceSpec {
  const kinds = spec.kinds === null ? null : Object.freeze([...spec.kinds]);
  return Object.freeze({ ...spec, perEntity, global, kinds });
}

/**
 * The session's maintenance: `declared`, the maintenance of the engine the session was opened as, narrowed by the
 * placements `refine` says its server accepts, frozen at every depth; `declared` is left as it is.
 *
 * An operation the narrowing names keeps a placement only where both its spec and the narrowing say true, and one left
 * with none leaves both lists, `kill` among them; every other member of a spec, and every operation the narrowing does
 * not name, stays as declared. So the narrowing only withdraws, as Studio's `narrowMaintenance` reads a connected
 * provider's measurement. A refinement without `maintenance`, or no refinement, answers the declaration.
 *
 * @throws {CallRefusalError} With every refusal of the narrowing: its shape, as `checkRefinement` reads it, and each
 * operation the engine does not list, as `refinement-widens`.
 */
export function sessionMaintenance(declared: EngineMaintenance, refine: Refinement | undefined): EngineMaintenance {
  const refusals = refine === undefined ? [] : narrowingRefusals(declared, refine);
  if (refusals.length > 0) throw new CallRefusalError(refusals);
  const accepted = new Map<unknown, MaintenanceAccepted>();
  const items = refine?.maintenance ?? [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as MaintenanceAccepted;
    accepted.set(item.operation, item);
  }
  const withdrawn = new Set<unknown>();
  const specs: MaintenanceSpec[] = [];
  for (const spec of declared.maintenanceSpecs) {
    const placements = accepted.get(spec.operation);
    const perEntity = spec.perEntity && (placements?.perEntity ?? true);
    const global = spec.global && (placements?.global ?? true);
    if (placements !== undefined && !perEntity && !global) withdrawn.add(spec.operation);
    else specs.push(frozenSpec(spec, perEntity, global));
  }
  return Object.freeze({
    maintenance: Object.freeze(declared.maintenance.filter((operation) => !withdrawn.has(operation))),
    maintenanceSpecs: Object.freeze(specs),
  });
}

/**
 * The items of `honours` read by index, `0` to `length - 1`, into a new frozen array, the way `checkRefinement` read
 * them: the list is never spread or iterated, so an iterator a package planted on it, or on its prototype, is never
 * called and cannot change which fields the session honours.
 */
function indexedHonours(honours: readonly ExecuteRequestField[]): readonly ExecuteRequestField[] {
  const items: ExecuteRequestField[] = [];
  for (let index = 0; index < honours.length; index += 1) items.push(honours[index]);
  return Object.freeze(items);
}

/**
 * The session's calls: `declared`, the manifest's calls, narrowed by `refine`, frozen at every depth. `declared` is
 * left as it is. A key the refinement leaves out keeps the declared value.
 *
 * @throws {CallRefusalError} With every refusal `checkRefinement` answers, for a refinement it does not admit.
 */
export function sessionCalls(declared: Calls, refine: Refinement | undefined): Calls {
  const refusals = checkRefinement(declared, refine);
  if (refusals.length > 0) throw new CallRefusalError(refusals);
  const narrowed = refine?.calls?.console;
  const narrowedObjects = refine?.calls?.objects;
  const narrowedMaintenance = refine?.calls?.maintenance;
  const honours = narrowed?.execute?.honours ?? declared.console.execute.honours;
  return Object.freeze({
    console: Object.freeze({
      execute: Object.freeze({ honours: indexedHonours(honours) }),
      cancel: narrowed?.cancel ?? declared.console.cancel,
      endScope: narrowed?.endScope ?? declared.console.endScope,
      transaction: narrowed?.transaction ?? declared.console.transaction,
    }),
    objects: Object.freeze({
      tree: narrowedObjects?.tree ?? declared.objects.tree,
    }),
    maintenance: Object.freeze({
      run: narrowedMaintenance?.run ?? declared.maintenance.run,
      preview: narrowedMaintenance?.preview ?? declared.maintenance.preview,
    }),
  });
}
