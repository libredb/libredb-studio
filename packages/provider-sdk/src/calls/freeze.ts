/**
 * The contexts and requests the host passes, deep-frozen (docs/providers/CONTRACT.md, clauses C-11 and C-12).
 *
 * The host passes every context and request through these functions on every call, in every environment, so a
 * provider that writes to what the host passed fails at the line that writes, the same way in a test and in production.
 * Both freeze in place, so the host builds a fresh context and request for each call.
 *
 * What is frozen is data in the value codec's domain: every plain object and array, at every depth, walked by every own
 * key, symbols included. A `Uint8Array` and a valid `Date` are left as they are, since JavaScript cannot freeze a typed
 * array's elements and a date's time is no property. Anything else is a host defect and is refused by its JSON Pointer
 * before anything is frozen: any other object, a function, an invalid `Date` (a NaN time, which `encodeValue` refuses
 * as "an invalid Date"), an accessor property, by its own pointer and without calling its getter, so the object behind
 * it is never left unfrozen, and a symbol-keyed property, by the pointer of the object that holds it, since a JSON
 * Pointer cannot name a symbol. The context's `signal` and `env` are host services, not data, and are left exactly as
 * the host passed them: a frozen AbortSignal can no longer be aborted or listened to on Node.
 */
import { isPlainRecord, pointerTo, readOwn, valueOf } from "./records";
import type { CallContext } from "./types";

/** The context members that are host services, never frozen. */
const SERVICES: readonly string[] = Object.freeze(["signal", "env"] satisfies (keyof CallContext)[]);

/**
 * Every plain object and array `value` holds, at every depth, into `found`, a set local to one call; each object once,
 * so a cycle ends.
 *
 * @throws {TypeError} For an object that is not a plain object, an array, a `Uint8Array` or a valid `Date`, for a
 * function, or for a member `collectMembers` refuses, naming its JSON Pointer.
 */
function collect(value: unknown, pointer: string, found: Set<object>): void {
  if (typeof value === "function") throw outsideDomain(pointer);
  if (typeof value !== "object" || value === null) return;
  if (value instanceof Date) {
    if (Number.isNaN(Date.prototype.getTime.call(value)))
      throw refused(pointer, "is an invalid Date, which encodeValue refuses");
    return;
  }
  if (value instanceof Uint8Array || found.has(value)) return;
  if (!Array.isArray(value) && !isPlainRecord(value)) throw outsideDomain(pointer);
  found.add(value);
  collectMembers(value, pointer, found, []);
}

/**
 * The members of `holder`, at `pointer`, by every own key but those in `skip`, each into `found` as `collect` reads it.
 *
 * @throws {TypeError} For a symbol-keyed property, naming the pointer of `holder`; for an accessor property, naming its
 * own pointer, its getter never called; or for a member `collect` refuses.
 */
function collectMembers(holder: object, pointer: string, found: Set<object>, skip: readonly string[]): void {
  for (const key of Reflect.ownKeys(holder)) {
    if (typeof key === "symbol")
      throw refused(pointer, "holds a symbol-keyed property, which a JSON Pointer cannot name");
    if (skip.includes(key)) continue;
    const read = readOwn(holder, key);
    if (read.kind === "accessor")
      throw refused(pointerTo(pointer, key), "is an accessor property, whose getter the host does not call");
    collect(valueOf(read), pointerTo(pointer, key), found);
  }
}

function refused(pointer: string, what: string): TypeError {
  const at = pointer === "" ? "the top level" : JSON.stringify(pointer);
  return new TypeError(`The value at ${at} ${what}, so the host cannot pass it frozen.`);
}

function outsideDomain(pointer: string): TypeError {
  return refused(
    pointer,
    "is outside the value codec's domain, neither a plain object, an array, a Uint8Array nor a Date",
  );
}

/**
 * `value`, with every plain object and array it holds frozen in place, at every depth; a `Uint8Array` and a valid `Date`
 * are left as they are, and a primitive is returned as it is. Nothing is frozen when anything is refused.
 *
 * @throws {TypeError} For any other object, a function, an invalid `Date`, an accessor property or a symbol-keyed
 * property, naming its JSON Pointer.
 */
export function freezeData<T>(value: T): T {
  const found = new Set<object>();
  collect(value, "", found);
  for (const item of found) Object.freeze(item);
  return value;
}

/**
 * `ctx`, frozen in place: every member but `signal` and `env` as `freezeData` freezes it, then the context record
 * itself. `signal` and `env` are left exactly as they are. Nothing is frozen when anything is refused.
 *
 * @throws {TypeError} For a symbol-keyed property of the context, or a member that is an accessor or holds what
 * `freezeData` refuses, naming its JSON Pointer.
 */
export function freezeContext<C extends CallContext>(ctx: C): C {
  const found = new Set<object>([ctx]);
  collectMembers(ctx, "", found, SERVICES);
  for (const item of found) Object.freeze(item);
  return ctx;
}
