/**
 * The Keys panel's page over an MQTT broker (`docs/providers/mqtt.md` sections 5 and 6).
 *
 * ONE READ RETURNS WHAT THE READ SAW, AND THERE IS NO PAGE TWO. The cursor is always `"0"`, which `types.ts:779`
 * defines as "this walk reached the end". That is a CHOICE and its cost is real: the panel's "Scan more" is
 * disabled, so a reader cannot ask for the rest.
 *
 * The alternative was worse. A live cursor would make each "Scan more" open a second connection and merge its
 * answer into the first tree, and two half-reads merged produce a tree that never existed on the server at any
 * instant: in our measurement read one held A, B, C; between the reads A was deleted and D was added; read two
 * held B, C, D; the merge showed A, B, C, D, a tree with four topics where the server never had more than three.
 * A disabled button is a cost. A fabricated tree is a wrong answer.
 */
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { DatabaseConfigError } from "@/lib/db/errors";
import { MQTT_KEY_SCAN_DEFAULT_COUNT, MQTT_KEY_SCAN_MAX_COUNT, MQTT_TOPIC_SEPARATOR, MQTT_TYPE } from "./constants";
import type { MqttTopicRow } from "./session";

/**
 * `/` as the separator, a prefix pattern, no count and no resumable cursor.
 *
 * `levels` IS DELIBERATELY NOT DECLARED. A level page would be a second request against a tree the first read
 * already holds in full, and the broker has nothing to answer it with: there is no command that lists one level
 * of a topic tree. Leaving it undeclared also removes the merge of two reads structurally rather than by rule,
 * because the panel then builds the whole tree from the one page it was given.
 */
export const MQTT_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  defaultCount: MQTT_KEY_SCAN_DEFAULT_COUNT,
  maxCount: MQTT_KEY_SCAN_MAX_COUNT,
  separator: MQTT_TOPIC_SEPARATOR,
  cursor: "decimal",
  pattern: "prefix",
  // No broker publishes a count of its topics, and no cursor can be divided into one.
  totalScope: "none",
});

/** The options a page reads, each refused before any socket is opened. */
export function readMqttKeyScanOptions(options: KeyScanOptions): { readonly prefix?: string; readonly count: number } {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MQTT_KEY_SCAN_MAX_COUNT)
    throw new DatabaseConfigError(
      `A page holds 1 to ${MQTT_KEY_SCAN_MAX_COUNT.toLocaleString("en-US")} topics.`,
      MQTT_TYPE,
    );
  if (options.database !== undefined)
    throw new DatabaseConfigError("An MQTT connection reads one broker, so a page names no database.", MQTT_TYPE);
  if (options.level === true)
    throw new DatabaseConfigError(
      "This provider does not answer a level page: MQTT has no command that lists one level of a topic tree.",
      MQTT_TYPE,
    );
  const prefix = options.pattern === undefined || options.pattern === "" ? undefined : options.pattern;
  return { ...(prefix === undefined ? {} : { prefix }), count: options.count };
}

/**
 * What the row's type cell carries for one topic (`docs/providers/mqtt.md` section 6.3).
 *
 * The number is the server's own Message Expiry Interval and nothing is computed from it. A topic whose message
 * carried none is labelled retained, which is what it is, rather than given a time it never had. Age is never
 * shown under any circumstance: the wire does not carry it.
 */
export function topicCell(row: MqttTopicRow): string {
  if (row.lifetimeSeconds !== undefined) return `${row.lifetimeSeconds.toLocaleString("en-US")}s left`;
  return row.retained ? "retained" : "live";
}

/**
 * Why the read stopped, in words a reader can act on.
 *
 * Every branch names the cause and, where there is one, what the reader can do about it. A sentence that
 * said only "the read ended" would be true and useless.
 */
/**
 * Why a broker refused a subscription, and what to do about THAT refusal (Table 3-8).
 *
 * Only the codes a broker sends in answer to a `#`-shaped discovery subscription are named; the rest travel
 * as themselves. Each remedy is one the reader can actually perform, and where there is none, the sentence
 * says so rather than offering one that cannot work.
 */
function subackRefusalSentence(code: number | undefined): string {
  const tail = code === undefined ? "" : ` (reason code ${code}, 0x${code.toString(16)})`;
  const named: Readonly<Record<number, string>> = {
    // Not authorized, and the one EMQX answers for `#` out of the box, where a branch is granted.
    0x87:
      "the broker refused the subscription, so nothing could be read under this filter. Brokers commonly " +
      "refuse the widest filters and grant narrower ones: try a branch, such as sensors/# instead of #",
    // Implementation specific error: no remedy is known, so none is offered.
    0x83: "the broker refused the subscription with an error of its own that it does not describe further",
    // Topic Filter invalid: the filter is malformed, so narrowing it is not the answer.
    0x8f:
      "the broker read the topic filter as invalid. A filter is levels separated by /, with + for one level " +
      "and # only as the last level: check the filter rather than narrowing it",
    // Quota exceeded: a subscription limit, not a filter width.
    0x97:
      "the broker's subscription quota is full, so it accepted no new subscription. This is a limit on the " +
      "broker rather than anything about the filter",
    // Shared Subscriptions not supported. We refuse `$share/` before sending, so this means the filter
    // reached the broker some other way; the sentence still has to be true.
    0x9e: "the broker does not support shared subscriptions",
    // Wildcard Subscriptions not supported: a narrower wildcard is still a wildcard.
    0xa2:
      "the broker does not support wildcard subscriptions at all, so no filter carrying + or # can be used " +
      "on it, however narrow. Typing one exact topic name reads that topic",
  };
  const sentence = named[code ?? -1];
  return sentence === undefined
    ? `the broker refused the subscription, so nothing could be read under this filter${tail}.`
    : `${sentence}${tail}.`;
}

export function endReasonSentence(reason: string, code?: number): string {
  switch (reason) {
    case "budget-time":
      return "the read reached its time budget. Reading again, or narrowing the topic filter, sees more.";
    case "budget-messages":
      return "the read reached its message budget. A narrower topic filter sees more of what matters.";
    case "budget-bytes":
      return "the read reached its byte budget. A narrower topic filter sees more of what matters.";
    case "server-disconnect":
      return "the broker closed the connection before the budget ran out, so the list is short of what the filter matched.";
    case "subscription-refused":
      // THE ONE BRANCH WHERE A REMEDY IS KNOWN, so it is the one branch that must not stop at the diagnosis.
      // A stock EMQX refuses `#`, `+/#` and `$SYS/#` out of the box and grants a narrower filter in the same
      // breath: measured on 5.8.9, `#` answers SUBACK 0x87 and `sensors/#` answers 0. A reader told only that
      // the subscription was refused concludes the tool cannot read the broker, when one field would have.
      //
      // BUT THE REMEDY IS THE CODE'S, NOT THE BRANCH'S. This sentence was fixed text, so "try a branch, such
      // as sensors/# instead of #" was advised for every refusal in Table 3-8 - including 0xA2, Wildcard
      // Subscriptions not supported, where `sensors/#` is also a wildcard and the advice cannot work, and
      // 0x8F, Topic Filter invalid, where narrowing a malformed filter changes nothing. The byte that says
      // which it was is in hand, so `subackRefusalSentence` reads it.
      return subackRefusalSentence(code);
    case "transport-closed":
      return "the connection closed before the budget ran out, so the list is short of what the filter matched.";
    default:
      return reason;
  }
}

/**
 * One page, built from a read the session already performed.
 *
 * The page is a sample and the cursor says the walk ended, which are both true at once: this is everything the
 * read saw, and there is no way to ask the broker for what it did not send.
 */
export function mqttKeyScanPage(
  topics: ReadonlyMap<string, MqttTopicRow>,
  options: KeyScanOptions,
  outcome?: {
    readonly scope: "incomplete" | "unknown";
    readonly endReason: string;
    readonly provenLoss: readonly string[];
    /** The broker's own reason code, where the end had one, so the sentence can name the right remedy. */
    readonly endCode?: number;
  },
): KeyScanPage {
  const read = readMqttKeyScanOptions(options);
  const matched = [...topics.keys()]
    .filter((topic) => read.prefix === undefined || topic.startsWith(read.prefix))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const names = matched.slice(0, read.count);
  /**
   * WHAT THE PAGE COULD NOT CARRY, COUNTED AND NAMED.
   *
   * The cursor is `"0"`, so there is no second page to ask for: a topic left off this page is a topic the
   * reader will not see. An earlier version sliced silently, and against the lab's own broker that meant
   * reading 10,004 topics, drawing 1,000, disabling "Scan more" and telling the screen that whether this was
   * everything could not be established. It could be established exactly: we were holding the number we
   * discarded. That is the failure this whole document was written to eliminate, so the remainder is reported
   * as a loss rather than dropped.
   */
  const left = matched.length - names.length;
  const types: Record<string, string> = {};
  for (const name of names) {
    const row = topics.get(name);
    if (row !== undefined) types[name] = topicCell(row);
  }
  return {
    keys: names,
    cursor: "0",
    types,
    total: 0,
    ...(left === 0
      ? {}
      : {
          skipped: {
            count: left,
            reason:
              `the page holds ${read.count.toLocaleString("en-US")} topics and this read saw ` +
              `${matched.length.toLocaleString("en-US")}. MQTT has no cursor to resume from, so these are not ` +
              "on a later page: narrow the topic filter to bring the branch you need inside the page.",
          },
        }),
    ...(outcome === undefined
      ? {}
      : {
          readOutcome: {
            // A page that left topics off is provably short, whatever the read itself could establish.
            scope: left === 0 ? outcome.scope : "incomplete",
            endReason: endReasonSentence(outcome.endReason, outcome.endCode),
            ...(outcome.provenLoss.length === 0 ? {} : { provenLoss: outcome.provenLoss }),
          },
        }),
  };
}
