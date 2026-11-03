/**
 * What `run_sparkplug_read` answered on the pinned fixture broker, held to the capture
 * `tests/live/sparkplug-mcp-boundary.ts` wrote (tests/fixtures/sparkplug/mosquitto-2.0.22/mcp-boundary/boundary.json),
 * so the data-scope claims of `docs/providers/sparkplug.md` section 15 stay tied to a measurement: a call opens two
 * broker sessions with ids of their own; the projection names no id and no metric; behind an ACL that reads one group
 * the window counts that group alone and a group outside it that publishes answers alike with one that does not
 * exist; a connection that names a group refuses another after the handshake; every refused form sends nothing past
 * the handshake; and inspect_schema lists nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SPARKPLUG_COMPLETENESS } from "@/lib/db/providers/industrial/sparkplug/agent-read";

const capture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/sparkplug/mosquitto-2.0.22/mcp-boundary/boundary.json", import.meta.url),
    "utf8",
  ),
);

describe("the run_sparkplug_read capture", () => {
  test("a call opened two broker sessions, each with a client id of its own", () => {
    expect(capture.sessions).toEqual({ perCall: 2, distinctIds: 2 });
  });

  test("every answer named no seeded id or metric and closed its notes with the completeness sentence", () => {
    const answers = [
      capture.reads.window,
      capture.reads.group,
      capture.reads.device,
      capture.scope.aclWindow,
      capture.scope.aclOutsidePublishing,
      capture.scope.openMissingGroup,
    ];
    for (const answer of answers) {
      expect(answer).toMatchObject({ isError: false, carriesSeeded: false });
      expect(answer.notes.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
    }
    expect(capture.reads.window.row).toMatchObject({ groups_seen: 2, scope: "window" });
  });

  test("the broker's ACL held the window to one group, and a group outside it answered as a missing one", () => {
    expect(capture.scope.aclWindow.row).toMatchObject({ groups_seen: 1 });
    expect(capture.scope.aclOutsidePublishing.row).toMatchObject({ seen: false, messages: 0 });
    expect(capture.scope.aclOutsidePublishingVsMissingAlike).toBe(true);
    expect(capture.scope.openMissingGroup.row).toMatchObject({ seen: false });
    expect(capture.scope.scopedOtherGroup).toMatchObject({ isError: true, carriesSeeded: false });
  });

  test("every refused form sent nothing past the handshake, and inspect_schema listed nothing", () => {
    expect(capture.refused).toHaveLength(5);
    for (const form of capture.refused) expect(form.sessionsUnfenced).toBe(1);
    expect(capture.inspect).toEqual({ totalTables: 0, isError: false });
  });

  test("the least timeout answered, one below it was refused, and a cancel answered at once", () => {
    expect(capture.limits.leastTimeoutAnsweredMs).toBeLessThan(5000);
    expect(capture.limits.belowLeast).toContain("timeout_ms must be at least 5000 for run_sparkplug_read");
    expect(capture.limits.cancelAnsweredMs).toBeLessThan(1500);
  });
});
