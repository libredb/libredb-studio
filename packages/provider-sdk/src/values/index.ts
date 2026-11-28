/**
 * The value codec: the one form a value takes when it crosses a JSON boundary (docs/providers/CONTRACT.md, Values).
 * `ValueTag` is the schema's `$defs/valueTag`, the type generated from it, so the tag list is stated once.
 *
 * Beside the codec, three readers of a value's text: `quoteUnsafeIntegers` and `carriesLossyNumber` find the 64-bit
 * integers and other number literals in a JSON text that `JSON.parse` would round, `repeatsAKey` finds a key written
 * twice in one JSON object's text, and `formatBytes` writes a byte count as display text.
 */
export type { ValueTag } from "../manifest/manifest-types.generated";
export { formatBytes } from "./byte-count";
export { decodeValue, encodeValue, MAX_VALUE_DEPTH, ValueCodecError, type WireValue } from "./codec";
export { carriesLossyNumber, quoteUnsafeIntegers } from "./json-integers";
export { repeatsAKey } from "./json-repeated-key";
