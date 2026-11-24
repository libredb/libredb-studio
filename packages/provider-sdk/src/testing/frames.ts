/**
 * The calls the memory test transport serves, the parts of their frames, and what it refuses of a frame
 * (docs/providers/CONTRACT.md, clauses C-20 to C-22).
 *
 * Every refusal names its rule, the call, the part of the call's frame it is about and a JSON Pointer rooted at that
 * part. No refusal and no sentence carries a value of the frame: a sentence names the rule, the call, the part, the
 * quoted pointer and, for a key, the quoted key.
 */

/** Every call the transport serves, by its contract name; a result source's two calls are `result.next` and `result.close`. */
export const SERVED_CALLS = Object.freeze([
  "open",
  "close",
  "console.execute",
  "console.cancel",
  "console.endScope",
  "console.transaction",
  "objects.tree",
  "maintenance.run",
  "maintenance.preview",
  "result.next",
  "result.close",
] as const);

export type ServedCall = (typeof SERVED_CALLS)[number];

/**
 * The parts of a call a refusal can be about: the context the host passes, the request, the answer, and the session
 * handle or result source the call is made on, which never crosses.
 */
export const FRAME_PARTS = Object.freeze(["context", "request", "answer", "handle"] as const);

export type FramePart = (typeof FRAME_PARTS)[number];

/** Every rule a frame refusal can name. */
export const FRAME_REFUSAL_RULES = Object.freeze([
  /** A key the part's shape does not define; `name` is the key. */
  "frame-key-unknown",
  /** A key the part's shape requires and the part lacks; `name` is the key. */
  "frame-key-missing",
  /** A value of the wrong type or outside its vocabulary, an accessor, or a list with a hole. */
  "frame-value-unreadable",
  /** What one side handed that the value codec's JSON round trip changes or drops. */
  "round-trip-changed",
  /** A session handle the served instance does not hold open: closed, or not one it handed out. */
  "session-not-open",
  /** A result source the served instance does not hold open: closed, or not one it handed out. */
  "result-not-open",
] as const);

export type FrameRefusalRule = (typeof FRAME_REFUSAL_RULES)[number];

/** One way a call's frame, or the handle it is made on, is refused. */
export interface FrameRefusal {
  readonly rule: FrameRefusalRule;
  readonly call: ServedCall;
  readonly part: FramePart;
  /** A JSON Pointer into the part; the empty string is the part itself. */
  readonly pointer: string;
  /** The key, for a key the shape does not define or requires. */
  readonly name?: string;
}

/** Thrown with every refusal of one frame, its message their sentences. */
export class FrameRefusalError extends Error {
  readonly refusals: readonly FrameRefusal[];

  constructor(refusals: readonly FrameRefusal[]) {
    super(refusals.map(frameRefusalSentence).join(" "));
    this.name = "FrameRefusalError";
    this.refusals = Object.freeze([...refusals]);
  }
}

/**
 * A refusal in one sentence for people, naming the call, the part, where it is and, for a key, which, the pointer and
 * the key quoted as JSON strings so the sentence stays one line; never a value of the frame.
 */
export function frameRefusalSentence(refusal: FrameRefusal): string {
  const at = refusal.pointer === "" ? "the top level" : JSON.stringify(refusal.pointer);
  const name = JSON.stringify(refusal.name ?? "");
  const where = `the ${refusal.part} of the ${refusal.call} frame`;
  switch (refusal.rule) {
    case "frame-key-unknown":
      return `The key ${name} at ${at} of ${where} is one its shape does not define.`;
    case "frame-key-missing":
      return `The key ${name} at ${at} of ${where} is missing, and its shape requires it.`;
    case "frame-value-unreadable":
      return `The value at ${at} of ${where} is an accessor, a list with a hole, or not of the type its shape defines there.`;
    case "round-trip-changed":
      return `The value at ${at} of ${where} does not cross unchanged, since the value codec's JSON round trip changes or drops it.`;
    case "session-not-open":
      return `The session handle at ${at} of the ${refusal.call} call is not one the served instance holds open, so no frame was sent.`;
    case "result-not-open":
      return `The result source at ${at} of the ${refusal.call} call is not one the served instance holds open, so no frame was sent.`;
  }
}
