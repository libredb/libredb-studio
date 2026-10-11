/**
 * The MQTT provider's discovery filter and its Keys panel page (`docs/providers/mqtt.md` sections 3.6 and 5).
 *
 * The filter refusals are checked BEFORE a SUBSCRIBE would be sent, because they cannot be detected
 * afterwards: every broker measured answers SUBACK Granted for a shared subscription and then simply delivers
 * less, while a device that needed those messages never receives them.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  endReasonSentence,
  MQTT_KEY_SCAN,
  mqttKeyScanPage,
  readMqttKeyScanOptions,
  topicCell,
} from "@/lib/db/providers/keyvalue/mqtt/key-scan";
import { MQTT_KEY_SCAN_MAX_COUNT } from "@/lib/db/providers/keyvalue/mqtt/constants";
import { readFilter, type MqttTopicRow } from "@/lib/db/providers/keyvalue/mqtt/session";

const row = (over: Partial<MqttTopicRow> = {}): MqttTopicRow => ({ retained: true, payloadBytes: 4, ...over });

describe("the discovery filter", () => {
  test("an empty filter means every topic, which is `#`", () => {
    for (const given of [undefined, ""]) expect(readFilter(given)).toBe("#");
  });

  /**
   * A topic name may begin or end with a space, and the Source tab subscribes to the exact name it was given.
   * The connection's typed field is trimmed where it is read (`sessionOptions()`), not here.
   */
  test("a filter is taken exactly as given, spaces included", () => {
    expect(readFilter("  sensors/+/temperature  ")).toBe("  sensors/+/temperature  ");
    expect(readFilter(" ")).toBe(" ");
  });

  /**
   * Each of the three takes messages away from the devices subscribed beside us. A read-only tool must not be
   * able to do that, and no broker reports it afterwards, so the refusal is the only protection there is.
   */
  test("the three prefixes that take messages from devices are refused", () => {
    const refused = ["$share/group/sensors/#", "$queue/sensors/#", "$exclusive/sensors/#"];
    expect(refused).toHaveLength(3);
    for (const filter of refused) {
      expect(() => readFilter(filter)).toThrow(QueryError);
      expect(() => readFilter(filter)).toThrow(/devices/);
    }
  });

  /**
   * `$SHARE/` in uppercase is an ordinary topic carrying real data. A case-insensitive check would refuse a
   * topic the reader is entitled to see, which is a different fault from the one being prevented.
   */
  test("the comparison is case sensitive, so an uppercase $SHARE is ordinary data", () => {
    expect(readFilter("$SHARE/group/sensors/#")).toBe("$SHARE/group/sensors/#");
    expect(readFilter("$Queue/x")).toBe("$Queue/x");
  });

  test("a topic that merely contains the prefix later is not refused", () => {
    expect(readFilter("plant/$share/line1")).toBe("plant/$share/line1");
  });
});

describe("the Keys panel capability", () => {
  test("it declares `/`, a prefix pattern and no total", () => {
    expect(MQTT_KEY_SCAN.separator).toBe("/");
    expect(MQTT_KEY_SCAN.pattern).toBe("prefix");
    // No broker publishes a count of its topics, so there is no denominator to divide by.
    expect(MQTT_KEY_SCAN.totalScope).toBe("none");
  });

  /**
   * `levels` is deliberately absent. Declaring it would invite a second request per folder against a tree the
   * first read already holds, and MQTT has no command that lists one level of a topic tree to answer it with.
   * Leaving it undeclared is also what makes "two reads are never merged" structural rather than a rule.
   */
  test("it does not declare `levels`", () => {
    expect(MQTT_KEY_SCAN.levels).toBeUndefined();
  });

  test("a count outside the declared range is refused rather than clamped", () => {
    expect(() => readMqttKeyScanOptions({ cursor: "0", count: 0 })).toThrow(DatabaseConfigError);
    expect(() => readMqttKeyScanOptions({ cursor: "0", count: MQTT_KEY_SCAN_MAX_COUNT + 1 })).toThrow(
      DatabaseConfigError,
    );
    expect(() => readMqttKeyScanOptions({ cursor: "0", count: 1.5 })).toThrow(DatabaseConfigError);
    expect(readMqttKeyScanOptions({ cursor: "0", count: 10 })).toEqual({ count: 10 });
  });

  test("a page naming a database is refused: a connection reads one broker", () => {
    expect(() => readMqttKeyScanOptions({ cursor: "0", count: 10, database: 1 })).toThrow(DatabaseConfigError);
  });

  test("a level page is refused by name, with the protocol reason", () => {
    expect(() => readMqttKeyScanOptions({ cursor: "0", count: 10, level: true })).toThrow(/level/);
  });
});

describe("one page of topics", () => {
  const topics = new Map<string, MqttTopicRow>([
    ["plant/line2/state", row()],
    ["plant/line1/state", row({ lifetimeSeconds: 300 })],
    ["office/temp", row({ retained: false })],
  ]);

  test("the page is sorted, and its cursor says the walk ended", () => {
    const page = mqttKeyScanPage(topics, { cursor: "0", count: 100 });
    expect(page.keys).toEqual(["office/temp", "plant/line1/state", "plant/line2/state"]);
    // "0" is `types.ts:779`'s "this walk reached the end". There is no second page to ask for.
    expect(page.cursor).toBe("0");
    // `totalScope: "none"` means the field is not read; a provider answers 0 rather than inventing a number.
    expect(page.total).toBe(0);
  });

  test("a prefix narrows the page without touching the broker", () => {
    const page = mqttKeyScanPage(topics, { cursor: "0", count: 100, pattern: "plant/" });
    expect(page.keys).toEqual(["plant/line1/state", "plant/line2/state"]);
  });

  test("a page never returns more than the count it was asked for", () => {
    const page = mqttKeyScanPage(topics, { cursor: "0", count: 2 });
    expect(page.keys).toHaveLength(2);
  });

  /**
   * The cell carries the server's own answer and nothing derived from it. A topic whose message named no
   * lifetime is labelled for what it is rather than given a time it never had.
   */
  test("the row's cell is the server's lifetime, or what the message actually was", () => {
    expect(topicCell(row({ lifetimeSeconds: 300 }))).toBe("300s left");
    expect(topicCell(row({ retained: true }))).toBe("retained");
    expect(topicCell(row({ retained: false }))).toBe("live");
    // 1,000 renders with its separator, as every other count in the panel does.
    expect(topicCell(row({ lifetimeSeconds: 1000 }))).toBe("1,000s left");
  });

  test("every key on the page has a cell, so no row is drawn with an empty type", () => {
    const page = mqttKeyScanPage(topics, { cursor: "0", count: 100 });
    expect(page.keys).not.toHaveLength(0);
    for (const key of page.keys) expect(page.types[key]).toBeDefined();
  });
});

describe("what the page tells the reader about the read itself (#1635)", () => {
  const topics = new Map<string, MqttTopicRow>([["plant/line1/state", row()]]);

  test("a page with no outcome carries none, so the panel draws no line", () => {
    expect(mqttKeyScanPage(topics, { cursor: "0", count: 10 }).readOutcome).toBeUndefined();
  });

  /**
   * `complete` is not a value the type admits, and this is the test that says so out loud: on MQTT it cannot
   * be established, so there is no code path that could claim it.
   */
  test("the scope is only ever `unknown` or `incomplete`", () => {
    for (const scope of ["unknown", "incomplete"] as const) {
      const page = mqttKeyScanPage(
        topics,
        { cursor: "0", count: 10 },
        {
          scope,
          endReason: "budget-time",
          provenLoss: [],
        },
      );
      expect(page.readOutcome?.scope).toBe(scope);
    }
    // The part that can actually fail: the capability itself must not promise a total, because `complete`
    // is the answer this engine can never give. This read `Object.keys({unknown: 0, incomplete: 0})` and
    // asserted the literal it had just written, which no implementation could have broken.
    expect(MQTT_KEY_SCAN.totalScope).toBe("none");
    expect(MQTT_KEY_SCAN.cursor).toBe("decimal");
  });

  test("every end reason becomes a sentence a reader can act on, and none is empty", () => {
    const reasons = [
      "budget-time",
      "budget-messages",
      "budget-bytes",
      "server-disconnect",
      "subscription-refused",
      "transport-closed",
    ];
    expect(reasons).toHaveLength(6);
    for (const reason of reasons) {
      const sentence = endReasonSentence(reason);
      expect(sentence.length).toBeGreaterThan(20);
      // The raw token is never shown: it is a name in our code, not a sentence for a reader.
      expect(sentence).not.toBe(reason);
    }
  });

  test("a budget sentence offers the two things that actually see more", () => {
    expect(endReasonSentence("budget-time")).toMatch(/again|narrow/i);
  });

  test("a refused subscription says nothing could be read, not that nothing is there", () => {
    expect(endReasonSentence("subscription-refused")).toMatch(/refused/);
    expect(endReasonSentence("subscription-refused")).not.toMatch(/empty|no topics/i);
  });

  /**
   * Measured on a stock EMQX 5.8.9: `#`, `+/#` and `$SYS/#` each answer SUBACK 0x87 while `sensors/#` answers
   * 0. So this is the one refusal whose remedy is known and decisive, and the sentence has to carry it: a
   * reader told only that the subscription was refused concludes the broker cannot be read at all.
   */
  test("a 0x87 refusal names the remedy, because on a stock broker one field fixes it", () => {
    const sentence = endReasonSentence("subscription-refused", 0x87);
    expect(sentence).toMatch(/narrower/);
    expect(sentence).toContain("sensors/#");
    // The number travels too, so a reader searching for it finds the broker's own documentation.
    expect(sentence).toContain("0x87");
  });

  /**
   * THE REMEDY IS THE CODE'S, NOT THE BRANCH'S, and it was the branch's.
   *
   * This sentence was fixed text, so "try a branch, such as sensors/# instead of #" was advised for every
   * refusal in Table 3-8. For 0xA2, Wildcard Subscriptions not supported, `sensors/#` is also a wildcard and
   * the advice cannot work; for 0x8F, Topic Filter invalid, narrowing a malformed filter changes nothing. The
   * byte that says which it was is in hand, so these pin that each refusal gets its own answer and that none
   * of them offers a remedy the broker has already ruled out.
   */
  test("each refusal code gets the remedy that fits it, and none gets one that cannot work", () => {
    const wildcard = endReasonSentence("subscription-refused", 0xa2);
    expect(wildcard).toMatch(/does not support wildcard subscriptions/);
    // The decisive part: it must NOT advise a narrower wildcard, which is still a wildcard.
    expect(wildcard).not.toMatch(/narrower|sensors\/#/);

    const invalid = endReasonSentence("subscription-refused", 0x8f);
    expect(invalid).toMatch(/invalid/);
    expect(invalid).not.toMatch(/narrower/);

    const quota = endReasonSentence("subscription-refused", 0x97);
    expect(quota).toMatch(/quota/);
    expect(quota).not.toMatch(/narrower/);

    expect(endReasonSentence("subscription-refused", 0x9e)).toMatch(/shared subscriptions/);
    expect(endReasonSentence("subscription-refused", 0x83)).toMatch(/error of its own/);
  });

  /** A code outside the named set is reported as itself, with no remedy invented for it. */
  test("an unknown refusal code is reported without a remedy", () => {
    const sentence = endReasonSentence("subscription-refused", 0x91);
    expect(sentence).toMatch(/refused the subscription/);
    expect(sentence).toContain("0x91");
    expect(sentence).not.toMatch(/narrower|try a branch/);
  });

  test("proven loss travels only when something was proved lost", () => {
    const none = mqttKeyScanPage(
      topics,
      { cursor: "0", count: 10 },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    expect(none.readOutcome?.provenLoss).toBeUndefined();

    const some = mqttKeyScanPage(
      topics,
      { cursor: "0", count: 10 },
      {
        scope: "incomplete",
        endReason: "budget-time",
        provenLoss: ["A message of 9,000,000 bytes was over the limit and skipped."],
      },
    );
    expect(some.readOutcome?.provenLoss).toHaveLength(1);
  });
});

describe("the topics a page could not carry are reported, never dropped (#1635)", () => {
  /**
   * THIS IS THE BRANCH'S HEADLINE GUARANTEE AND IT HAD NO ASSERTION. An audit deleted the whole `skipped`
   * block from `mqttKeyScanPage` and 44,872 tests still passed, which is exactly how a guarantee gets
   * refactored away unnoticed. The behaviour it protects is the one the design exists for: against the lab's
   * Mosquitto the provider reads 10,004 topics into a page of 1,000, and an earlier version sliced the
   * remaining 9,004 silently while telling the screen that whether this was everything could not be
   * established. It could be established exactly: we were holding the number we discarded.
   */
  const many = new Map<string, MqttTopicRow>(
    Array.from({ length: 2_500 }, (_, i) => [`plant/line${String(i).padStart(4, "0")}/state`, row()]),
  );

  test("a page smaller than the read reports the remainder, with both numbers", () => {
    const page = mqttKeyScanPage(
      many,
      { cursor: "0", count: 1_000 },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    expect(page.keys).toHaveLength(1_000);
    expect(page.skipped).toBeDefined();
    expect(page.skipped?.count).toBe(1_500);
    // Both numbers travel, because "some were left out" does not tell a reader how much is missing.
    expect(page.skipped?.reason).toContain("1,000");
    expect(page.skipped?.reason).toContain("2,500");
  });

  test("the reason says these are not on a later page, and what to do instead", () => {
    const reason = mqttKeyScanPage(
      many,
      { cursor: "0", count: 10 },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    ).skipped?.reason;
    // The cursor is always "0": there is no second page, so a reader told only "1,000 of 2,500" would press
    // a disabled button and conclude the tool is broken.
    expect(reason).toMatch(/not\s+\n?\s*on a later page|not on a later page/);
    expect(reason).toMatch(/narrow the topic filter/);
  });

  /**
   * A page that left topics off is PROVABLY short, whatever the read itself could establish, so the scope is
   * forced to `incomplete` even when the read ended on an ordinary budget with nothing proved lost.
   */
  test("a truncated page is incomplete even when the read itself said unknown", () => {
    const page = mqttKeyScanPage(
      many,
      { cursor: "0", count: 1_000 },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    expect(page.readOutcome?.scope).toBe("incomplete");
  });

  test("a page that carried everything reports no remainder and keeps the read's own scope", () => {
    const page = mqttKeyScanPage(
      many,
      { cursor: "0", count: 5_000 },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    expect(page.keys).toHaveLength(2_500);
    expect(page.skipped).toBeUndefined();
    expect(page.readOutcome?.scope).toBe("unknown");
  });

  test("a prefix narrows what the page must carry, so a filtered page is not truncated", () => {
    const page = mqttKeyScanPage(
      many,
      { cursor: "0", count: 1_000, pattern: "plant/line000" },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    expect(page.keys).toHaveLength(10);
    expect(page.skipped).toBeUndefined();
  });

  test("the remainder is counted against what the FILTER matched, not the whole read", () => {
    const page = mqttKeyScanPage(
      many,
      { cursor: "0", count: 5, pattern: "plant/line000" },
      {
        scope: "unknown",
        endReason: "budget-time",
        provenLoss: [],
      },
    );
    // Ten topics match the prefix and five fit: the sentence must say five, not 2,495.
    expect(page.skipped?.count).toBe(5);
    expect(page.skipped?.reason).toContain("10");
  });
});
