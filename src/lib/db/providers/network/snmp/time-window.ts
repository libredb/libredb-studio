/**
 * The v3 time window: what an engine's clock is believed to say, and when a message is too far
 * from it to be accepted.
 *
 * WHY THIS IS NOT JUST TWO NUMBERS. Discovery learns the engine's boots and time once. The
 * numbers are a CLOCK, not a constant: the engine's time counts seconds, so a connection that
 * kept sending the discovered value would drift out of the window and be refused by the agent
 * after a couple of minutes of use. The first version of the v3 arm did exactly that, which is
 * why this file exists and why the estimate below is taken from the local clock rather than
 * from the last value seen.
 *
 * WHY A WINDOW AT ALL. RFC 3414 section 1.4.1: the window is what stops a captured message from
 * being replayed later. Accepting anything would make every authenticated exchange replayable
 * for as long as the key lives, so a message outside the window is refused even though its
 * digest verifies.
 */
import { UsmError } from "./usm";

/** RFC 3414 section 2.2.3: a message is in the window within this many seconds of the engine. */
export const TIME_WINDOW_SECONDS = 150;

/**
 * RFC 3414 section 2.2.2. At this value the boots counter has stopped counting, so it can no
 * longer be compared and the engine must be reconfigured. It is a ceiling, not a wrap.
 */
export const MAX_ENGINE_BOOTS = 2147483647;

export interface EngineClock {
  readonly boots: number;
  /** The engine's time as the last verified message reported it. */
  readonly time: number;
  /** The local clock when that message was read, in milliseconds. */
  readonly learnedAtMs: number;
}

export function startClock(boots: number, time: number, nowMs: number): EngineClock {
  return { boots, time, learnedAtMs: nowMs };
}

/**
 * What the engine's clock is believed to say now.
 *
 * The elapsed seconds are floored rather than rounded, so the estimate never runs ahead of the
 * engine. Being a second behind costs nothing inside a 150 second window; being a second ahead
 * on an engine that has only just booted would send a time it has not reached.
 */
export function estimatedTime(clock: EngineClock, nowMs: number): number {
  const elapsed = Math.max(0, Math.floor((nowMs - clock.learnedAtMs) / 1000));
  return clock.time + elapsed;
}

export type WindowVerdict = "inside" | "bootsDiffer" | "tooFar" | "bootsCeiling";

/**
 * Whether a message reporting these counters is inside the window of the clock we hold.
 *
 * The three refusals are kept apart because they are three different situations for whoever
 * reads the message. Different boots means the agent restarted and the connection has to
 * resynchronise. Too far means clocks drifted, or the message is old. The ceiling means the
 * agent needs attention from a person and no amount of retrying will help.
 */
export function windowVerdict(
  clock: EngineClock,
  message: { readonly boots: number; readonly time: number },
  nowMs: number,
): WindowVerdict {
  if (clock.boots >= MAX_ENGINE_BOOTS || message.boots >= MAX_ENGINE_BOOTS) return "bootsCeiling";
  if (message.boots !== clock.boots) return "bootsDiffer";
  return Math.abs(message.time - estimatedTime(clock, nowMs)) <= TIME_WINDOW_SECONDS ? "inside" : "tooFar";
}

/**
 * The clock after a verified message, following RFC 3414 section 2.2.3: a non-authoritative
 * engine moves its notion forward and never backward.
 *
 * Never backward is the whole of it. A message reporting an EARLIER time than one already
 * accepted is either old or replayed, and letting it move the clock back would widen the window
 * that a replay has to land in, which is the thing the window exists to narrow.
 */
export function advanced(
  clock: EngineClock,
  message: { readonly boots: number; readonly time: number },
  nowMs: number,
): EngineClock {
  if (message.boots > clock.boots) return startClock(message.boots, message.time, nowMs);
  if (message.boots < clock.boots) return clock;
  return message.time > estimatedTime(clock, nowMs) ? startClock(message.boots, message.time, nowMs) : clock;
}

/** The refusal a caller raises when a verdict is not `inside`, worded for whoever reads it. */
export function outsideWindow(verdict: Exclude<WindowVerdict, "inside">): UsmError {
  if (verdict === "bootsCeiling") {
    return new UsmError(
      `the engine's boot counter has reached its ceiling of ${MAX_ENGINE_BOOTS}, so its messages can no longer be placed in time and the agent has to be reconfigured`,
      "bootsCeiling",
    );
  }
  if (verdict === "bootsDiffer") {
    return new UsmError(
      "the engine reports a different boot count, which means it restarted and this connection has to discover it again",
      "engineRestarted",
    );
  }
  return new UsmError(
    `the answer's clock is more than ${TIME_WINDOW_SECONDS} seconds from this engine's, so it is outside the window that keeps an old message from being replayed`,
    "outsideWindow",
  );
}
