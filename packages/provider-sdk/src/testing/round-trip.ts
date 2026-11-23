/**
 * The round trip comparison (docs/providers/CONTRACT.md, clause C-21): what one side handed, compared deep-equal with
 * what the other side decoded, rather than copied with `structuredClone`, so whatever the value codec's JSON round trip
 * changes or drops is refused by name instead of reaching the other side silently.
 *
 * The sent value is walked by its own property descriptors, never calling a getter. Refused as `round-trip-changed`,
 * at the first pointer of each difference: a symbol-keyed property, at the pointer of the object that holds it, since
 * a JSON Pointer cannot name a symbol; a non-enumerable own property and an accessor, at their pointers; an array's
 * own property that is not an index, at the array; a key the other side lacks or has extra, at the key; a length that
 * differs, at the list; and a leaf that differs. Compared equal, as the codec defines them: `-0` and `0`; NaN and NaN;
 * a `Uint8Array`, or any subclass such as a Buffer, and a plain `Uint8Array` of the same bytes; a valid `Date`, or a
 * subclass, and a `Date` of the same time; an object with no prototype and one with `Object.prototype`, of the same
 * members. A `Uint8Array` and a `Date` are compared by their bytes and their time alone.
 *
 * It runs only on a value the codec encoded, so it meets no array hole and nothing outside the codec's domain.
 */
import { pointerTo } from "../calls/records";
import type { FramePart, FrameRefusal, ServedCall } from "./frames";

/** Where a compared value stands: its call, its part, and the top-level members the transport does not frame. */
export interface RoundTripAt {
  readonly call: ServedCall;
  readonly part: FramePart;
  /** Top-level keys of the sent value that do not cross in this part, compared nowhere here. */
  readonly skip?: readonly string[];
}

const INDEX = /^(?:0|[1-9][0-9]*)$/;

/** Whether `value` is an object with `Object.prototype` or no prototype, and not an array. */
function isDataObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameBytes(sent: Uint8Array, received: unknown): boolean {
  if (!(received instanceof Uint8Array) || received.length !== sent.length) return false;
  for (let index = 0; index < sent.length; index += 1) if (sent[index] !== received[index]) return false;
  return true;
}

/** Whether two leaves are equal as the codec carries them: `===`, with NaN equal to NaN. */
function sameLeaf(sent: unknown, received: unknown): boolean {
  return sent === received || (Number.isNaN(sent) && Number.isNaN(received));
}

/**
 * The members of `sent`, an array or a data object, at `pointer`, compared with `received`'s. Its own keys are read by
 * descriptor: a symbol key, a non-enumerable property, an accessor, and an array's non-index key are each refused; the
 * data members that cross are answered for the caller to compare.
 */
function crossingMembers(
  sent: object,
  pointer: string,
  skip: readonly string[],
  changed: string[],
): readonly (readonly [string, unknown])[] {
  const array = Array.isArray(sent);
  const members: (readonly [string, unknown])[] = [];
  let holderRefused = false;
  for (const key of Reflect.ownKeys(sent)) {
    if (typeof key === "symbol" || (array && key !== "length" && !INDEX.test(key))) {
      if (!holderRefused) changed.push(pointer);
      holderRefused = true;
      continue;
    }
    if ((array && key === "length") || skip.includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(sent, key) as PropertyDescriptor;
    if (!("value" in descriptor) || descriptor.enumerable !== true) changed.push(pointerTo(pointer, key));
    else members.push([key, descriptor.value]);
  }
  return members;
}

/** Every pointer at which `received` differs from `sent`, into `changed`. */
function compare(sent: unknown, received: unknown, pointer: string, skip: readonly string[], changed: string[]): void {
  if (sent instanceof Uint8Array) {
    if (!sameBytes(sent, received)) changed.push(pointer);
    return;
  }
  if (sent instanceof Date) {
    if (!(received instanceof Date) || received.getTime() !== sent.getTime()) changed.push(pointer);
    return;
  }
  if (Array.isArray(sent)) {
    if (!Array.isArray(received) || received.length !== sent.length) {
      changed.push(pointer);
      return;
    }
    for (const [key, item] of crossingMembers(sent, pointer, skip, changed)) {
      compare(item, received[Number(key)], pointerTo(pointer, key), [], changed);
    }
    return;
  }
  if (isDataObject(sent)) {
    if (!isDataObject(received)) {
      changed.push(pointer);
      return;
    }
    const fields = received as Readonly<Record<string, unknown>>;
    for (const [key, item] of crossingMembers(sent, pointer, skip, changed)) {
      if (Object.hasOwn(received, key)) compare(item, fields[key], pointerTo(pointer, key), [], changed);
      else changed.push(pointerTo(pointer, key));
    }
    // A key the sent value holds is reported above, refused or compared; one it does not hold is extra.
    for (const key of Object.keys(received)) {
      if (!Object.hasOwn(sent, key) && !skip.includes(key)) changed.push(pointerTo(pointer, key));
    }
    return;
  }
  if (!sameLeaf(sent, received)) changed.push(pointer);
}

/**
 * Every way `received`, what one side decoded, differs from `sent`, what the other side handed, each refused as
 * `round-trip-changed` at its pointer into the part `at` names, in the order `sent` is walked. Top-level keys `at.skip`
 * names are compared nowhere here. A getter of `sent` is never called.
 */
export function roundTripRefusals(sent: unknown, received: unknown, at: RoundTripAt): readonly FrameRefusal[] {
  const changed: string[] = [];
  compare(sent, received, "", at.skip ?? [], changed);
  return changed.map((pointer) => ({ rule: "round-trip-changed", call: at.call, part: at.part, pointer }));
}
