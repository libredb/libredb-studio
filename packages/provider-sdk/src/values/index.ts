/**
 * The value codec: the one form a value takes when it crosses a JSON boundary (docs/providers/CONTRACT.md, Values).
 * `ValueTag` is the schema's `$defs/valueTag`, the type generated from it, so the tag list is stated once.
 */
export type { ValueTag } from "../manifest/manifest-types.generated";
export { decodeValue, encodeValue, MAX_VALUE_DEPTH, ValueCodecError, type WireValue } from "./codec";
