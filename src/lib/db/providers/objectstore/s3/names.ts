/**
 * The virtual key space the Keys panel walks: one key space whose keys are `<bucket>/<key>`
 * and whose separator is `/`; which buckets and objects Studio addresses; the Source tab's sentence for each
 * refusal; how a name is shown inside a sentence; and how a listed name is decoded from `encoding-type=url`.
 *
 * The two checks return a verdict, a fixed word that carries no character of the name, and each surface words its
 * own sentence: the Source tab and `objectPath` through `sourceAddressSentence`, the Keys panel
 * through key-scan.ts, the console through its own sentences. The pinned-bucket check needs the connection, so it is
 * not here. Browser-safe: no Node built-in, no server module and no `Buffer`.
 */
import { S3_BUCKET_PATTERN, S3_SHOWN_NAME_CHARS } from "./constants";

/** Why Studio does not address a bucket or object; a fixed word that carries no character of the name. */
export type S3AddressVerdict = "bucket-pattern" | "key-leading-slash" | "key-empty";

const PERCENT_HEX = /^[0-9A-Fa-f]{2}$/;
const utf8 = new TextEncoder();

/** "sales/2026/a.csv" to { bucket: "sales", key: "2026/a.csv" }; "sales" or "sales/" to { bucket: "sales", key: "" }. */
export function splitVirtualKey(name: string): { readonly bucket: string; readonly key: string } {
  const slash = name.indexOf("/");
  return slash < 0 ? { bucket: name, key: "" } : { bucket: name.slice(0, slash), key: name.slice(slash + 1) };
}

export function joinVirtualKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

/** undefined when Studio addresses the bucket; else the verdict. */
export function bucketAddressRefusal(bucket: string): "bucket-pattern" | undefined {
  return S3_BUCKET_PATTERN.test(bucket) ? undefined : "bucket-pattern";
}

/** undefined when Studio may open the object; else the first failing verdict: the bucket, then the key. */
export function objectAddressRefusal(bucket: string, key: string): S3AddressVerdict | undefined {
  const refusal = bucketAddressRefusal(bucket);
  if (refusal !== undefined) return refusal;
  if (key === "") return "key-empty";
  // Silo reads `root.txt` for `/root.txt`, and Garage and RustFS drop the slash when they store such a key.
  if (key.startsWith("/")) return "key-leading-slash";
  return undefined;
}

/** At most S3_SHOWN_NAME_CHARS characters, cut on a code point, then JSON.stringify. */
export function shownName(name: string): string {
  const points = Array.from(name);
  return JSON.stringify(points.length > S3_SHOWN_NAME_CHARS ? points.slice(0, S3_SHOWN_NAME_CHARS).join("") : name);
}

/**
 * The Source tab's and objectPath's sentence for a verdict, or for a bucket outside the pin; quotes names through
 * shownName. The "outside-pin" case requires the pin, so a caller cannot reach it without one.
 */
export function sourceAddressSentence(
  ...[refusal, names]:
    | [S3AddressVerdict, { readonly bucket: string; readonly key: string }]
    | ["outside-pin", { readonly bucket: string; readonly key: string; readonly pin: string }]
): string {
  switch (refusal) {
    case "key-leading-slash":
      return `Studio does not open ${shownName(names.key)}: it begins with /, and a measured S3 server read a different key for such a name (Silo reads the key without its leading slash).`;
    case "key-empty":
      return "A bucket's own folder has no object to open.";
    case "bucket-pattern":
      return `Studio does not open bucket ${shownName(names.bucket)}: a bucket it addresses is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.`;
    case "outside-pin":
      return `This connection reads only bucket ${shownName(names.pin)}; bucket ${shownName(names.bucket)} is outside it.`;
  }
}

/**
 * `encoding-type=url` name decoding: "+" to space (MinIO writes a space as "+"), then percent-decode to bytes, then
 * fatal UTF-8 with the byte order mark kept; undefined when the name is not text. A name that is not text is counted
 * by its caller, never listed with replacement characters.
 */
export function decodeListedName(encoded: string): string | undefined {
  const text = encoded.replace(/\+/g, " ");
  const bytes: number[] = [];
  for (let at = 0; at < text.length; ) {
    if (text[at] === "%") {
      const hex = text.slice(at + 1, at + 3);
      if (!PERCENT_HEX.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      at += 3;
      continue;
    }
    const width = (text.codePointAt(at) as number) > 0xffff ? 2 : 1;
    for (const byte of utf8.encode(text.slice(at, at + width))) bytes.push(byte);
    at += width;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}
