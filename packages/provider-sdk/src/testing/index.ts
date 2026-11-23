/**
 * `@libredb/provider-sdk/testing`: the memory test transport, for tests only (docs/providers/CONTRACT.md, clauses C-18
 * to C-25, C-27 and C-31 to C-33). The package root never re-exports this entry, and Studio's runtime source never
 * imports it.
 *
 * `serve` puts a provider module record behind the transport, so a test, the kit and the host core's tests call a
 * provider as JSON frames through the value codec, its handles and result sources kept in tables the served instance
 * owns. `readFrame` reads each part of each call's frame as the closed shape of its call type, and `roundTripRefusals`
 * compares what one side handed with what the other side decoded; each answers refusals of `FRAME_REFUSAL_RULES`,
 * which `FrameRefusalError` carries and `frameRefusalSentence` words.
 */
export {
  FRAME_PARTS,
  FRAME_REFUSAL_RULES,
  type FramePart,
  type FrameRefusal,
  FrameRefusalError,
  type FrameRefusalRule,
  frameRefusalSentence,
  SERVED_CALLS,
  type ServedCall,
} from "./frames";
export { type RoundTripAt, roundTripRefusals } from "./round-trip";
export { type ServedFrame, type ServedHandle, type ServeOptions, serve } from "./serve";
export {
  type ContextData,
  type ExecuteAnswerFrame,
  type FramePartOf,
  type FrameShapes,
  type OpenAnswerFrame,
  readFrame,
  type ResultDescriptor,
  type ShapeOf,
} from "./shapes";
