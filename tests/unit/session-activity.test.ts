import { describe, expect, test } from "bun:test";
import { sessionActivityFigure } from "@/lib/session-activity";
import type { SessionActivity } from "@/lib/db/types";

const row = (activity?: SessionActivity) => ({ activity });

describe("sessionActivityFigure", () => {
  test("a refused read is N/A", () => {
    expect(sessionActivityFigure([], "active", true)).toBe("N/A");
  });

  test("an empty classified list is 0", () => {
    expect(sessionActivityFigure([], "idle", false)).toBe("0");
  });

  test("one unclassified row makes every card N/A", () => {
    const sessions = [row("active"), row()];
    expect(sessionActivityFigure(sessions, "active", false)).toBe("N/A");
    expect(sessionActivityFigure(sessions, "waiting", false)).toBe("N/A");
  });

  test("counts only the requested card", () => {
    const sessions = [row("active"), row("idle"), row("idle-in-transaction"), row("waiting"), row("other")];
    expect(sessionActivityFigure(sessions, "active", false)).toBe("1");
    expect(sessionActivityFigure(sessions, "idle", false)).toBe("1");
    expect(sessionActivityFigure(sessions, "idle-in-transaction", false)).toBe("1");
    expect(sessionActivityFigure(sessions, "waiting", false)).toBe("1");
    expect(sessionActivityFigure(sessions, "other", false)).toBe("1");
  });
});
