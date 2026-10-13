/**
 * The bounds the MTConnect reader works inside, each sized from a measurement rather than a guess
 * (issue #1722 section 6 item 6, MT-S5).
 *
 * The measurements behind them, all taken on 2026-10-13 against the Institute's public demo agent
 * (2.8.0.3) and against the pinned `mtconnect/agent:2.8.0.3` image on generated models:
 *
 * - Deepest real document: 12 elements (the demo's `probe`), and 15 on a model with five nested
 *   components, which the agent served without complaint. There is no agent-side ceiling, so the
 *   bound is set well above the deepest measurement and far below the level where a recursive
 *   parser would risk the stack.
 * - Largest real document: 1,063 elements (the demo's `assets`); a generated 500-device model
 *   answered `probe` with about 60,000 elements and `current` with 26,514 observations.
 * - Most attributes on one element: 9 (an observation). Most distinct attribute names in one
 *   document family: 63.
 * - Longest name: 25 characters. Longest attribute value: 100. Longest text node: 1,121
 *   characters in `current`, and 65,536 for a value an adapter published as a 64 KB MESSAGE.
 *
 * A document that passes these bounds still has to pass the transport's own byte cap, which is the
 * first line of defence; these are the reader's.
 */
export interface MtcXmlBounds {
  /** Deepest element nesting. Measured worst: 15. */
  readonly maxDepth: number;
  /** Elements in one document. Measured worst: about 60,000 on a 500-device probe. */
  readonly maxElements: number;
  /** Attributes on one element. Measured worst: 9. */
  readonly maxAttributes: number;
  /** Characters in one element or attribute name. Measured worst: 25. */
  readonly maxNameLength: number;
  /** Characters of character data in one element. Measured worst: 65,536 (a 64 KB MESSAGE). */
  readonly maxTextLength: number;
  /** Characters in one attribute value. Measured worst: 100. */
  readonly maxAttributeLength: number;
}

export const MTC_XML_BOUNDS: MtcXmlBounds = Object.freeze({
  maxDepth: 64,
  maxElements: 500_000,
  maxAttributes: 64,
  maxNameLength: 256,
  maxTextLength: 4 * 1024 * 1024,
  maxAttributeLength: 64 * 1024,
});
