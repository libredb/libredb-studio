/**
 * The defensive readers the calls share (docs/providers/CONTRACT.md, clauses C-1, C-10 and C-15).
 *
 * A provider module record, a refinement `open` answers and a batch a result source answers are values a package
 * built, read by the host's copy of the SDK. Each is read here by its own property descriptors: a key a reader needs is read only when it is an own data property, and an accessor is reported
 * as one, its getter never called. So a value the host checked is the value it then uses, and no package code runs
 * while the host reads a package's value.
 */

/** A value read as a record of fields. */
export type Fields = Readonly<Record<string, unknown>>;

/** `value` as a record of fields, when it is an object that is not an array; otherwise undefined. */
export function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** Whether `value` is a plain object: one whose prototype is `Object.prototype` or none. */
export function isPlainRecord(value: unknown): value is Fields {
  if (fieldsOf(value) === undefined) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `key` as one reference token of a JSON Pointer. */
export function token(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** `key` appended to the JSON Pointer `pointer` as one reference token. */
export function pointerTo(pointer: string, key: string | number): string {
  return `${pointer}/${typeof key === "number" ? key : token(key)}`;
}

/** One own property, read by its descriptor: absent, an accessor whose getter was not called, or a data value. */
export type OwnRead =
  | { readonly kind: "absent" }
  | { readonly kind: "accessor" }
  | { readonly kind: "data"; readonly value: unknown };

/**
 * The own property `key` of `target`, read by its descriptor, so a getter is never called and an inherited property is
 * never read. A `target` that is not an object has no property.
 */
export function readOwn(target: unknown, key: string): OwnRead {
  if (typeof target !== "object" || target === null) return { kind: "absent" };
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { kind: "absent" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "data", value: descriptor.value };
}

/** The value a read found, or undefined when the property is absent or an accessor. */
export function valueOf(read: OwnRead): unknown {
  return read.kind === "data" ? read.value : undefined;
}
