/**
 * A session's calls and the requests the host sends it (docs/providers/CONTRACT.md, clauses C-9, C-10, C-17 and C-57).
 *
 * The manifest's `calls` declares what a package answers; `open` may answer a refinement that narrows it for one
 * session, which `checkRefinement` reads and `sessionCalls` applies. The host keeps the session's calls with the
 * session, with no cache and no invalidation event, and holds every request to them with `checkExecuteRequest` before
 * the call, so a package is never sent a field it does not honour, and every console facet call to it with
 * `checkConsoleFacet` and every object facet call with `checkObjectsFacet`, so a package is never called on a facet the
 * session does not offer.
 */
import type { Calls, ExecuteRequestField, FacetOffer } from "../manifest/manifest-types.generated";
import { isPlainRecord, pointerTo, readOwn } from "./records";
import { type CallRefusal, CallRefusalError } from "./refusals";
import {
  CONSOLE_FACETS,
  type ConsoleFacet,
  EXECUTE_REQUEST_FIELDS,
  type ExecuteRequest,
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

/**
 * The reader of each segment a refinement's `calls` may have, one per segment of the manifest's calls, in schema order.
 * It satisfies a type over every segment, so a segment the calls gain fails typecheck here until it has a reader of
 * its own, and is never read by another segment's, and a reader for a segment the calls do not have fails it too.
 */
const SEGMENT_READERS = Object.freeze({ console: readConsole, objects: readObjects } satisfies {
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

/**
 * Every way `refine`, what `open` answered beside its handle, is not a refinement of `declared`, the manifest's calls,
 * in the refinement's own key order: a key a refinement cannot have (`refinement-key-unknown`), a value of the wrong
 * type, an accessor or a repeated field (`refinement-unreadable`), and a value that offers or honours more than
 * `declared` (`refinement-widens`). `undefined` is no refinement. Every pointer is rooted at the refinement, and no
 * refusal carries a value of it; a getter is never called.
 */
export function checkRefinement(declared: Calls, refine: unknown): readonly CallRefusal[] {
  if (refine === undefined) return [];
  const refusals: CallRefusal[] = [];
  readClosed(refine, ["calls"], "", refusals, (_key, calls, at) =>
    readClosed(calls, CALLS_KEYS, at, refusals, (segment, segmentValue, segmentAt) =>
      SEGMENT_READERS[segment](segmentValue, declared, segmentAt, refusals),
    ),
  );
  return refusals;
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
  });
}
