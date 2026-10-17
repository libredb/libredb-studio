import { describe, expect, test } from "bun:test";

import {
  MAX_ENGINE_BOOTS,
  TIME_WINDOW_SECONDS,
  advanced,
  estimatedTime,
  outsideWindow,
  startClock,
  windowVerdict,
} from "@/lib/db/providers/network/snmp/time-window";
import { UsmError } from "@/lib/db/providers/network/snmp/usm";

const AT = 1_000_000;
const clock = startClock(4, 1000, AT);

describe("the two numbers the RFC fixes", () => {
  /**
   * Written out rather than compared with themselves. Both are the RFC's, not ours, so there is
   * nothing to derive them from and the only thing that holds them is saying what they are.
   */
  test("the window is a hundred and fifty seconds, and the boot ceiling is the signed maximum", () => {
    expect(TIME_WINDOW_SECONDS).toBe(150);
    expect(MAX_ENGINE_BOOTS).toBe(2147483647);
  });
});

describe("what the engine's clock is believed to say", () => {
  test("it counts forward with the local clock", () => {
    expect(estimatedTime(clock, AT)).toBe(1000);
    expect(estimatedTime(clock, AT + 1000)).toBe(1001);
    expect(estimatedTime(clock, AT + 60_000)).toBe(1060);
  });

  /**
   * Floored, not rounded. A second behind costs nothing inside a window of a hundred and fifty;
   * a second ahead sends an engine a time it has not reached.
   */
  test("a part second is not counted, so the estimate never runs ahead", () => {
    expect(estimatedTime(clock, AT + 999)).toBe(1000);
    expect(estimatedTime(clock, AT + 1999)).toBe(1001);
  });

  test("a local clock that went backwards does not drag the estimate back", () => {
    expect(estimatedTime(clock, AT - 50_000)).toBe(1000);
  });
});

describe("the window is tested at its own edge", () => {
  /**
   * The cases sit at 150 and 151, not at 10 and 1000, so moving the limit by one
   * turns one of them red. A test that sampled either side from a distance would let the window
   * be widened to any value at all.
   */
  test("exactly a hundred and fifty seconds away is still inside, in both directions", () => {
    expect(windowVerdict(clock, { boots: 4, time: 1000 + 150 }, AT)).toBe("inside");
    expect(windowVerdict(clock, { boots: 4, time: 1000 - 150 }, AT)).toBe("inside");
  });

  test("one second further is outside, in both directions", () => {
    expect(windowVerdict(clock, { boots: 4, time: 1000 + 151 }, AT)).toBe("tooFar");
    expect(windowVerdict(clock, { boots: 4, time: 1000 - 151 }, AT)).toBe("tooFar");
  });

  test("the edge moves with the estimate, not with the value discovery found", () => {
    expect(windowVerdict(clock, { boots: 4, time: 1250 }, AT)).toBe("tooFar");
    expect(windowVerdict(clock, { boots: 4, time: 1250 }, AT + 100_000)).toBe("inside");
  });

  test("a different boot count is its own verdict, not a distance", () => {
    expect(windowVerdict(clock, { boots: 5, time: 1000 }, AT)).toBe("bootsDiffer");
    expect(windowVerdict(clock, { boots: 3, time: 1000 }, AT)).toBe("bootsDiffer");
  });

  test("the ceiling is reached at the value itself, from either side", () => {
    expect(windowVerdict(startClock(MAX_ENGINE_BOOTS, 1000, AT), { boots: MAX_ENGINE_BOOTS, time: 1000 }, AT)).toBe(
      "bootsCeiling",
    );
    expect(windowVerdict(clock, { boots: MAX_ENGINE_BOOTS, time: 1000 }, AT)).toBe("bootsCeiling");
    expect(
      windowVerdict(startClock(MAX_ENGINE_BOOTS - 1, 1000, AT), { boots: MAX_ENGINE_BOOTS - 1, time: 1000 }, AT),
    ).toBe("inside");
  });
});

describe("the clock moves forward and never back", () => {
  test("a later time from the same boot moves it", () => {
    expect(advanced(clock, { boots: 4, time: 2000 }, AT).time).toBe(2000);
  });

  /**
   * An answer reporting an earlier time is either old or replayed. Letting it move the clock
   * back would widen the window a replay has to land in, which is the thing the window narrows.
   */
  test("an earlier time from the same boot is ignored", () => {
    expect(advanced(clock, { boots: 4, time: 500 }, AT)).toEqual(clock);
    expect(advanced(clock, { boots: 4, time: 999 }, AT)).toEqual(clock);
  });

  test("a restart resynchronises even though its time is lower", () => {
    const after = advanced(clock, { boots: 5, time: 3 }, AT);
    expect(after.boots).toBe(5);
    expect(after.time).toBe(3);
  });

  test("a lower boot count is ignored, because an engine does not un-restart", () => {
    expect(advanced(clock, { boots: 3, time: 9999 }, AT)).toEqual(clock);
  });

  test("a time that only matches the estimate does not restart the local reckoning", () => {
    const later = advanced(clock, { boots: 4, time: 1060 }, AT + 60_000);
    expect(later).toEqual(clock);
  });
});

describe("the refusal says which of the three happened", () => {
  test("each verdict has its own sentence and all are QueryError", () => {
    const sentences = (["bootsDiffer", "tooFar", "bootsCeiling"] as const).map((v) => outsideWindow(v));
    for (const error of sentences) expect(error).toBeInstanceOf(UsmError);
    expect(new Set(sentences.map((e) => e.message)).size).toBe(3);
  });

  test("a restart points at discovery and drift points at the window", () => {
    expect(outsideWindow("bootsDiffer").message).toContain("discover it again");
    expect(outsideWindow("tooFar").message).toContain(String(TIME_WINDOW_SECONDS));
    expect(outsideWindow("bootsCeiling").message).toContain(String(MAX_ENGINE_BOOTS));
  });
});
