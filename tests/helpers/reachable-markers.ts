/**
 * A walk over everything reachable from an object, for the FND-2 tests that hold no SSH tunnel credential reaches a
 * provider (docs/SECURITY.md control 3.41): `tests/security/provider-tunnel-secrets.test.ts` and the entry-point cases
 * in `tests/isolated/factory.test.ts`. It lives here so both walk the same way.
 */

/**
 * The property path of every place one of `markers` is reachable from `root`, each path written from `provider`.
 *
 * It walks own data properties, string and symbol keyed, through their descriptors so that no getter runs; the keys and
 * values of a Map and the values of a Set; and the bytes of a typed array or DataView read as latin1. A visited set stops
 * it at a cycle.
 */
export function markersReachableFrom(root: unknown, markers: readonly string[]): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (markers.some((marker) => value.includes(marker))) hits.push(path);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
      if (markers.some((marker) => text.includes(marker))) hits.push(`${path} (bytes)`);
      return;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key, `${path} (map key)`);
        visit(entry, `${path} (map value)`);
      }
    }
    if (value instanceof Set) {
      for (const entry of value) visit(entry, `${path} (set value)`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value, `${path}.${String(key)}`);
    }
  };
  visit(root, "provider");
  return hits;
}
