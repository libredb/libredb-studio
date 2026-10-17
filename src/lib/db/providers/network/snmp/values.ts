/**
 * Wire values into result cells (SN-S7).
 *
 * TWO MEASUREMENTS SHAPE THIS, both taken on 13 October 2026 under Node 24.14.0 and Bun 1.4.2,
 * which agreed, and both confirmed on the wire against Net-SNMP snmpd 5.9.4.
 *
 * ONE: a Counter64 does not fit a JavaScript number and cannot be serialised as a BigInt.
 * 2^53+1 arrives as seven bytes and reads back as 9007199254740993 through BigInt and as
 * 9007199254740992, one less, through Number; `JSON.stringify` throws on a BigInt in both
 * runtimes, with a different message in each, which is why nothing here asserts on that text.
 * So a 64-bit counter becomes a decimal string before it reaches a result, and never travels
 * as either numeric type.
 *
 * TWO: "the bytes decode" is not enough to call something text, and on its own it is actively
 * misleading. A MAC address `001a2b3c4d5e` and an ANSI escape sequence
 * `1b5b33316d5245441b5b306d` both round trip through UTF-8 unchanged, because every byte is
 * below 0x80, and both carry control bytes; one is an address and the other paints a terminal.
 * Net-SNMP's own tools print the escape sequence as a hex string rather than as text. So text
 * is produced only where the MIB says the object is text AND the bytes decode AND they carry
 * nothing a terminal or a renderer would act on. The raw bytes are kept beside every rendering,
 * because the rendering is a reading and the bytes are the fact.
 */

/** What the MIB says this object is, which is the first of the two conditions. */
export type ValueSyntax =
  | { readonly kind: "integer" }
  | { readonly kind: "counter32" }
  | { readonly kind: "gauge32" }
  | { readonly kind: "timeticks" }
  | { readonly kind: "counter64" }
  | { readonly kind: "ipAddress" }
  | { readonly kind: "objectIdentifier" }
  /** DisplayString or SnmpAdminString: the MIB says text. */
  | { readonly kind: "text" }
  /** OCTET STRING with no textual convention saying it is text. */
  | { readonly kind: "octets" }
  /** A textual convention with a display hint this layer knows. */
  | { readonly kind: "dateAndTime" }
  | { readonly kind: "macAddress" }
  | { readonly kind: "opaque" };

export interface RenderedValue {
  /** What a cell shows. Always a string, never markup, never a BigInt. */
  readonly display: string;
  /** How it was read, so a reader can tell a rendering from a fact. */
  readonly as: "number" | "decimalString" | "text" | "hex" | "dotted" | "timestamp";
  /** The bytes as they arrived, always, whatever the rendering. */
  readonly raw: Uint8Array;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Unsigned big-endian, any width up to eight bytes, exact.
 *
 * Written with `BigInt(...)` calls rather than literals because the repository targets ES2017,
 * where a `0n` literal does not compile. That is not a style choice: the house does the same in
 * `src/lib/db/graph/bolt/record-values.ts` and `src/lib/db/providers/document/firestore/console/parser.ts`,
 * for the same reason. Tests pass either way, which is why this was found by the type checker
 * and not by the suite.
 */
const ZERO = BigInt(0);
const ONE = BigInt(1);
const EIGHT = BigInt(8);

export function readUnsigned(bytes: Uint8Array): bigint {
  let n = ZERO;
  for (const b of bytes) n = (n << EIGHT) | BigInt(b);
  return n;
}

/**
 * True when the bytes are safe to show as text: they decode, they round trip, and they carry
 * no C0 or C1 control, no DEL, and no byte order mark. Both halves matter; see the header.
 */
export function isShowableText(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!bytesEqual(new TextEncoder().encode(text), bytes)) return false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (code >= 0x80 && code <= 0x9f) return false;
    if (code === 0xfeff) return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * DateAndTime, RFC 2579 section 3.1, with the errata this provider accepts: 416 and 417, both
 * Verified, admit month 0 and day 0 and years 0 to 65535, so an all-zero value is a reading
 * rather than a defect and is shown as what it is.
 */
function renderDateAndTime(bytes: Uint8Array): RenderedValue {
  if (bytes.length !== 8 && bytes.length !== 11) {
    return { display: hex(bytes), as: "hex", raw: bytes };
  }
  const year = (bytes[0] << 8) | bytes[1];
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${pad(year, 4)}-${pad(bytes[2])}-${pad(bytes[3])} ${pad(bytes[4])}:${pad(bytes[5])}:${pad(bytes[6])}.${bytes[7]}`;
  if (bytes.length === 8) return { display: base, as: "timestamp", raw: bytes };
  const sign = String.fromCharCode(bytes[8]);
  if (sign !== "+" && sign !== "-") return { display: hex(bytes), as: "hex", raw: bytes };
  return { display: `${base} ${sign}${pad(bytes[9])}:${pad(bytes[10])}`, as: "timestamp", raw: bytes };
}

/** One wire value, rendered by what the MIB says it is and never by what its bytes look like. */
export function renderValue(syntax: ValueSyntax, bytes: Uint8Array): RenderedValue {
  switch (syntax.kind) {
    case "counter64":
      // A decimal string. Not a Number, which loses the value above 2^53, and not a BigInt,
      // which cannot be serialised.
      return { display: readUnsigned(bytes).toString(10), as: "decimalString", raw: bytes };
    case "counter32":
    case "gauge32":
    case "timeticks":
      return { display: readUnsigned(bytes).toString(10), as: "number", raw: bytes };
    case "integer": {
      let n = readUnsigned(bytes);
      const width = BigInt(bytes.length) * EIGHT;
      if (bytes.length > 0 && (bytes[0] & 0x80) !== 0) n -= ONE << width;
      return { display: n.toString(10), as: "number", raw: bytes };
    }
    case "ipAddress":
      return bytes.length === 4
        ? { display: [...bytes].join("."), as: "dotted", raw: bytes }
        : { display: hex(bytes), as: "hex", raw: bytes };
    case "objectIdentifier":
      return { display: hex(bytes), as: "hex", raw: bytes };
    case "dateAndTime":
      return renderDateAndTime(bytes);
    case "macAddress":
      // A MAC decodes as text and is not text. It is shown in its own notation.
      return bytes.length === 6
        ? { display: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(":"), as: "hex", raw: bytes }
        : { display: hex(bytes), as: "hex", raw: bytes };
    case "text":
      // Both conditions: the MIB said text, and the bytes have to be showable as well.
      return isShowableText(bytes)
        ? { display: new TextDecoder().decode(bytes), as: "text", raw: bytes }
        : { display: hex(bytes), as: "hex", raw: bytes };
    case "octets":
    case "opaque":
      // The MIB did not say text, so the bytes are not text however they decode.
      return { display: hex(bytes), as: "hex", raw: bytes };
  }
}
