/**
 * A value as every surface shows it (spec 5.2, E9): one ordered table of recognisers, the first
 * matching row deciding, then the cell bound of spec 5.4.
 *
 * Pure. results.ts, the Source tab, the edit's conflict text, export and write-policy.ts read a
 * value only through here, so a Kubernetes protobuf or encrypted value, or a secret, is withheld on
 * every surface by one rule (R12 SEC-4, R13 B). Nothing here decodes a Kubernetes object: the
 * envelope's TypeMeta is read as a label, a header read and never a decode (spec E9).
 */
import type { EtcdBytes } from "./client";
import { decodeUtf8, hasBytePrefix, isSecretKey, isUnderProtectedPrefix } from "./keys";

export type ValueEncoding = "json" | "text" | "base64" | "withheld" | "kubernetes-json" | "kubernetes-cbor";
export type WithheldKind = "kubernetes-secret" | "kubernetes-encrypted" | "kubernetes-protobuf";

export interface ValueView {
  /** What a cell shows: the text, the base64, or the withheld label. */
  readonly text: string;
  readonly encoding: ValueEncoding;
  readonly withheld?: WithheldKind;
  readonly byteLength: number;
  /** True when `text` was cut at the cell bound; the grid then writes the encoding with ", cut" (spec 5.2). */
  readonly cut: boolean;
}

/**
 * kube-apiserver's encryption-at-rest prefix, which every provider's prefix begins with (SRC
 * landscape/k8s-v1.37.1__staging_src_k8s.io_apiserver_pkg_server_options_encryptionconfig_config.go,
 * aesCBCTransformerPrefixV1 and the four constants beside it).
 */
const ENCRYPTED_PREFIX = new TextEncoder().encode("k8s:enc:");
/**
 * The protobuf serializer's magic number, "k8s" and a 0x00 byte (SRC
 * landscape/k8s-v1.37.1__staging_src_k8s.io_apimachinery_pkg_runtime_serializer_protobuf_protobuf.go,
 * protoEncodingPrefix).
 */
const ENVELOPE_PREFIX = Uint8Array.of(0x6b, 0x38, 0x73, 0x00);
/**
 * CBOR's self-described tag 55799, which kube-apiserver writes before every CBOR object (SRC
 * landscape/k8s-v1.37.1__staging_src_k8s.io_apimachinery_pkg_runtime_serializer_cbor_cbor.go,
 * selfDescribedCBOR).
 */
const SELF_DESCRIBED_CBOR = Uint8Array.of(0xd9, 0xd9, 0xf7);

/** E9 row 2: a value that begins with `k8s:enc:`. */
export function isKubernetesEncrypted(value: EtcdBytes): boolean {
  return hasBytePrefix(value, ENCRYPTED_PREFIX);
}

/** E9 row 3: a value that begins with the envelope `k8s\x00`. */
export function isKubernetesEnvelope(value: EtcdBytes): boolean {
  return hasBytePrefix(value, ENVELOPE_PREFIX);
}

/** The longest name a label repeats from a value's header: an apiVersion, a kind, a provider or a key name. */
const LABEL_NAME_LIMIT = 128;

/** A header's name as a label may repeat it: UTF-8, bounded, with no control character; else undefined. */
function labelName(bytes: EtcdBytes): string | undefined {
  if (bytes.length === 0 || bytes.length > LABEL_NAME_LIMIT) return undefined;
  const text = decodeUtf8(bytes);
  if (text === undefined) return undefined;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return undefined;
  }
  return text;
}

const COLON = 0x3a;

/**
 * The provider and key name of `k8s:enc:<provider>:<version>:<key name>:`, the prefix kube-apiserver
 * writes before the ciphertext (the encryptionconfig file above, each transformer's Prefix built from
 * its key's Name and ":"); undefined when the value does not carry three such fields.
 */
function encryptionNames(value: EtcdBytes): { readonly provider: string; readonly keyName: string } | undefined {
  const fields: string[] = [];
  let start = ENCRYPTED_PREFIX.length;
  while (fields.length < 3) {
    const window = value.subarray(start, start + LABEL_NAME_LIMIT + 1);
    const colon = window.indexOf(COLON);
    const name = colon < 0 ? undefined : labelName(window.subarray(0, colon));
    if (name === undefined) return undefined;
    fields.push(name);
    start += colon + 1;
  }
  return { provider: fields[0], keyName: fields[2] };
}

/**
 * A protobuf varint from `at`, bounded to 5 bytes, which covers every length a value can have;
 * undefined past `end`.
 */
function varint(
  bytes: EtcdBytes,
  at: number,
  end: number,
): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  for (let index = at, shift = 0; index < end && shift < 35; index++, shift += 7) {
    value += (bytes[index] & 0x7f) * 2 ** shift;
    if (bytes[index] < 0x80) return { value, next: index + 1 };
  }
  return undefined;
}

/**
 * The length-delimited fields of one protobuf message between `start` and `end`, in order, up to the
 * first that is not.
 */
function lengthDelimitedFields(
  bytes: EtcdBytes,
  start: number,
  end: number,
): Array<{ readonly field: number; readonly start: number; readonly end: number }> {
  const fields: Array<{ readonly field: number; readonly start: number; readonly end: number }> = [];
  let at = start;
  while (at < end) {
    const tag = varint(bytes, at, end);
    if (tag === undefined || tag.value % 8 !== 2) break;
    const length = varint(bytes, tag.next, end);
    if (length === undefined || length.next + length.value > end) break;
    fields.push({ field: Math.floor(tag.value / 8), start: length.next, end: length.next + length.value });
    at = length.next + length.value;
  }
  return fields;
}

/**
 * The envelope's `runtime.Unknown` TypeMeta, its field 1, holding apiVersion 1 and kind 2 (SRC
 * landscape/k8s-v1.37.1__staging_src_k8s.io_apimachinery_pkg_runtime_generated.proto, messages
 * TypeMeta and Unknown): a header read and not a decode, since no field of the object itself is
 * read. `{}` when the header cannot be read; undefined when the value is not an envelope.
 */
export function envelopeTypeMeta(
  value: EtcdBytes,
): { readonly apiVersion?: string; readonly kind?: string } | undefined {
  if (!isKubernetesEnvelope(value)) return undefined;
  const typeMeta = lengthDelimitedFields(value, ENVELOPE_PREFIX.length, value.length).find(
    (field) => field.field === 1,
  );
  if (typeMeta === undefined) return {};
  let apiVersion: string | undefined;
  let kind: string | undefined;
  for (const field of lengthDelimitedFields(value, typeMeta.start, typeMeta.end)) {
    const name = labelName(value.subarray(field.start, field.end));
    if (field.field === 1 && name !== undefined) apiVersion = name;
    if (field.field === 2 && name !== undefined) kind = name;
  }
  return { ...(apiVersion === undefined ? {} : { apiVersion }), ...(kind === undefined ? {} : { kind }) };
}

/** "1,204 bytes", "1 byte". */
function bytesPhrase(count: number): string {
  return `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${count === 1 ? "byte" : "bytes"}`;
}

/** E9's rows 1 to 3, in order: the first that matches withholds the value. */
function withheldOf(
  key: EtcdBytes,
  value: EtcdBytes,
): { readonly kind: WithheldKind; readonly label: string } | undefined {
  const size = bytesPhrase(value.length);
  if (isSecretKey(key)) return { kind: "kubernetes-secret", label: `Kubernetes secret, ${size}` };
  if (isKubernetesEncrypted(value)) {
    const names = encryptionNames(value);
    const detail = names === undefined ? "" : ` (${names.provider}, ${names.keyName})`;
    return { kind: "kubernetes-encrypted", label: `Kubernetes encrypted${detail}, ${size}` };
  }
  const typeMeta = envelopeTypeMeta(value);
  if (typeMeta === undefined) return undefined;
  const names = [typeMeta.apiVersion, typeMeta.kind].filter((name) => name !== undefined);
  const detail = names.length === 0 ? "" : ` (${names.join(", ")})`;
  return { kind: "kubernetes-protobuf", label: `Kubernetes protobuf${detail}, ${size}` };
}

/**
 * A withheld value's label, "Kubernetes protobuf (v1, Pod), 1,204 bytes", or undefined when the value
 * is shown (E8, 4.4, 4.5).
 */
export function withheldLabel(key: EtcdBytes, value: EtcdBytes): string | undefined {
  return withheldOf(key, value)?.label;
}

function base64(bytes: EtcdBytes): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The first `limit` UTF-16 units, one fewer when the last kept would be a surrogate pair's first half. */
function cutText(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function textView(text: string, encoding: ValueEncoding, byteLength: number, cellLimit: number): ValueView {
  if (text.length <= cellLimit) return { text, encoding, byteLength, cut: false };
  return { text: cutText(text, cellLimit), encoding, byteLength, cut: true };
}

/** Base64 of the whole value, or of as many whole 3-byte groups as the cell holds, so a cut cell still decodes. */
function base64View(value: EtcdBytes, encoding: ValueEncoding, cellLimit: number): ValueView {
  const whole = Math.ceil(value.length / 3) * 4;
  if (whole <= cellLimit) return { text: base64(value), encoding, byteLength: value.length, cut: false };
  const shown = value.subarray(0, Math.floor(cellLimit / 4) * 3);
  return { text: base64(shown), encoding, byteLength: value.length, cut: true };
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec E9's ordered table, the first matching row deciding, then the cell bound of 5.4 at a character
 * boundary (a surrogate pair is never split): (1) a key under a secrets root is withheld whatever its
 * bytes; (2) a `k8s:enc:` value and (3) a `k8s\x00` envelope are withheld behind their labels; (4) a
 * CBOR value under a protected prefix is base64 as `kubernetes-cbor`; (5) a JSON value under a
 * protected prefix is `kubernetes-json`; (6) any other JSON is `json`, UTF-8 is `text`, and the rest
 * is `base64`. A label is never cut. `cellLimit` counts UTF-16 units, as the grid's text does, and
 * `Number.POSITIVE_INFINITY` is no bound, for a caller that reads the encoding of the whole value.
 */
export function viewValue(key: EtcdBytes, value: EtcdBytes, cellLimit: number): ValueView {
  if (cellLimit !== Number.POSITIVE_INFINITY && !(Number.isInteger(cellLimit) && cellLimit >= 1)) {
    throw new RangeError("The cell bound is a whole number of characters, 1 or more, or Infinity for none");
  }
  const withheld = withheldOf(key, value);
  if (withheld !== undefined) {
    return {
      text: withheld.label,
      encoding: "withheld",
      withheld: withheld.kind,
      byteLength: value.length,
      cut: false,
    };
  }
  const kubernetes = isUnderProtectedPrefix(key);
  if (kubernetes && hasBytePrefix(value, SELF_DESCRIBED_CBOR)) return base64View(value, "kubernetes-cbor", cellLimit);
  const text = decodeUtf8(value);
  if (text === undefined) return base64View(value, "base64", cellLimit);
  const json = parsesAsJson(text);
  const encoding: ValueEncoding = json ? (kubernetes ? "kubernetes-json" : "json") : "text";
  return textView(text, encoding, value.length, cellLimit);
}

/**
 * A key by the same rule: text, or base64 when it is not UTF-8 (5.2's key_encoding). A key is never
 * cut or withheld.
 */
export function viewKey(key: EtcdBytes): { readonly text: string; readonly encoding: "text" | "base64" } {
  const text = decodeUtf8(key);
  return text === undefined ? { text: base64(key), encoding: "base64" } : { text, encoding: "text" };
}
