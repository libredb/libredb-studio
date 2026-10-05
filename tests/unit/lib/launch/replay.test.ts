import { beforeEach, describe, expect, test } from "bun:test";
import { claimLaunchJti, clearLaunchReplayState, MAX_REMEMBERED_LAUNCHES } from "@/lib/launch/replay";

const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearLaunchReplayState();
});

describe("claimLaunchJti", () => {
  test("accepts a jti once and refuses it again while it is remembered", () => {
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW)).toBe("claimed");
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW + 1_000)).toBe("replayed");
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW + 64_999)).toBe("replayed");
  });

  test("forgets a jti once its expiry has passed, so the map does not grow forever", () => {
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW)).toBe("claimed");
    expect(claimLaunchJti("jti-a", NOW + 130_000, NOW + 65_000)).toBe("claimed");
  });

  test("keeps distinct jtis apart", () => {
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW)).toBe("claimed");
    expect(claimLaunchJti("jti-b", NOW + 65_000, NOW)).toBe("claimed");
    expect(claimLaunchJti("jti-b", NOW + 65_000, NOW)).toBe("replayed");
  });

  test("a full map refuses a new jti and keeps refusing every remembered one, so none is dropped to make room", () => {
    for (let index = 0; index < MAX_REMEMBERED_LAUNCHES; index += 1) {
      expect(claimLaunchJti(`jti-${index}`, NOW + 65_000, NOW)).toBe("claimed");
    }
    expect(claimLaunchJti("jti-new", NOW + 65_000, NOW)).toBe("full");
    expect(claimLaunchJti("jti-0", NOW + 65_000, NOW + 64_999)).toBe("replayed");
    expect(claimLaunchJti(`jti-${MAX_REMEMBERED_LAUNCHES - 1}`, NOW + 65_000, NOW + 64_999)).toBe("replayed");
    // Refused for room, not spent: once the remembered tokens can no longer verify, the same jti is claimed.
    expect(claimLaunchJti("jti-new", NOW + 130_000, NOW + 65_000)).toBe("claimed");
  });

  test("clearLaunchReplayState forgets everything", () => {
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW)).toBe("claimed");
    clearLaunchReplayState();
    expect(claimLaunchJti("jti-a", NOW + 65_000, NOW)).toBe("claimed");
  });
});
