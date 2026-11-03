/**
 * What `run_mqtt_read` answered on the pinned brokers, held to the capture `tests/live/mqtt-mcp-boundary.ts` wrote
 * (tests/fixtures/mqtt/mosquitto-2.1.2/mcp-boundary/boundary.json), so the data-scope claims of
 * `docs/providers/mqtt.md` section 15 stay tied to a measurement: a call opens two broker sessions with ids of their
 * own; the projection names no topic and carries no credential; behind Mosquitto's ACL a narrow login's window counts
 * its own topics alone and a topic outside the ACL answers alike whether it holds a message or does not exist; every
 * refused form sends nothing past the handshake; the reads change no retained message; and a stock EMQX refuses the
 * window's # with 135.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";

const capture = JSON.parse(
  readFileSync(new URL("../../../fixtures/mqtt/mosquitto-2.1.2/mcp-boundary/boundary.json", import.meta.url), "utf8"),
);

describe("the run_mqtt_read capture", () => {
  test("a call opened two broker sessions, each with a client id of its own", () => {
    expect(capture.sessions).toEqual({ perCall: 2, distinctIds: 2 });
    expect(capture.collision).toEqual({ liveClientStillConnected: true });
  });

  test("every answer named no seeded topic, carried no credential, and closed its notes with the completeness sentence", () => {
    const answers = [
      capture.reads.window,
      capture.reads.topic,
      capture.scope.narrowWindow,
      capture.scope.narrowAllowed,
      capture.scope.narrowDeniedPresent,
      capture.emqx.window,
      capture.emqx.topic,
    ];
    for (const answer of answers) {
      expect(answer).toMatchObject({ isError: false, carriesWithheld: false, carriesCredential: false });
      expect(answer.notes.at(-1)).toBe(MQTT_COMPLETENESS);
      expect(answer.rows).toHaveLength(1);
    }
  });

  test("the broker's ACL held the narrow login to its own topics, and a topic outside it answered as a missing one", () => {
    expect(capture.reads.window.rows[0].topics_seen).toBe(3);
    expect(capture.scope.narrowWindow.rows[0]).toMatchObject({ stop_reason: "budget-time", topics_seen: 1 });
    expect(capture.scope.narrowAllowed.rows[0]).toMatchObject({ seen: true });
    expect(capture.scope.narrowDeniedPresent.rows[0]).toMatchObject({ seen: false, broker_reason_code: null });
    expect(capture.scope.narrowDeniedPresentVsMissingAlike).toBe(true);
    expect(capture.scope.broadIdleVsMissingAlike).toBe(true);
  });

  test("every refused form sent nothing past the handshake, and no read changed a retained message", () => {
    expect(capture.refused.map((form: { request: string }) => form.request)).toEqual([
      "a publish",
      "a will",
      "a wildcard below the root",
      "a multi-level wildcard below the root",
      "a shared subscription",
      "a $SYS topic",
      "a filter of the model's",
    ]);
    for (const form of capture.refused) expect(form.sessionsUnfenced).toBe(1);
    expect(capture.writes).toEqual({ retainedBefore: 3, afterRawPublish: 4, afterUnfencedRequest: 4 });
  });

  test("the least timeout answered, one below it was refused, and a cancel answered while the read ran its window", () => {
    expect(capture.limits.leastTimeoutAnsweredMs).toBeLessThan(5000);
    expect(capture.limits.belowLeast).toContain("timeout_ms must be at least 5000 for run_mqtt_read");
    expect(capture.limits.cancelAnsweredMs).toBeLessThan(1500);
    expect(capture.limits.cancelReadEndedMs).toBeGreaterThanOrEqual(3000);
  });

  test("a stock EMQX refused the window's # with 135 and answered a topic read", () => {
    expect(capture.emqx.window.rows[0]).toMatchObject({ stop_reason: "subscription-refused", broker_reason_code: 135 });
    expect(capture.emqx.topic.rows[0]).toMatchObject({ stop_reason: "budget-time", seen: false });
  });
});
