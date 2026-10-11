/**
 * The MQTT provider's object kinds (`docs/providers/mqtt.md` section 6).
 *
 * ONE KIND, `topic`, ENUMERATED BY THE KEY BROWSER. Declaring it is what lets a topic's row open its payload in
 * a Source tab instead of a generated read, and it is also what keeps the kind out of the Objects tree, out of
 * inventory and search, and out of the agent's grounding walk, all of which are directions we want.
 *
 * Counts are the exception and they are ours to get right: `POST /api/db/objects/counts` returns the provider's
 * own answer verbatim, so this module simply does not count a kind that does not apply to a broker.
 */
import { QueryError } from "@/lib/db/errors";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
} from "@/lib/db/types";
import { MQTT_TYPE } from "./constants";
import { MQTT_TOPICS_LISTED_ELSEWHERE } from "./labels";
import type { MqttTopicRow } from "./session";

/**
 * The one kind this provider declares.
 *
 * `hasSource` with a `sourceLanguage` of `json`: a payload is bytes, and most of what a broker carries is JSON,
 * so the editor renders it as JSON and leaves anything else as the text it is. `acceptsSourceEdits` is absent,
 * which is what keeps the Source tab read-only.
 */
export const MQTT_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "topic",
    role: "config",
    label: "Topic",
    labelPlural: "Topics",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
  },
] as const);

function requireKind(kind: string): void {
  if (!MQTT_OBJECT_KINDS.some((spec) => spec.id === kind))
    throw new QueryError(`MQTT declares no object kind "${kind}"`, MQTT_TYPE);
}

/**
 * No kind is counted.
 *
 * A broker publishes no count of its topics, and a number produced from what one read happened to see would be
 * a total with nothing behind it. The Keys panel shows what arrived; this record stays empty rather than
 * inventing a denominator for it.
 */
export function countMqttObjects(): Record<string, KindCount> {
  return {};
}

/** The Objects tree lists nothing: the Keys panel is the only surface that enumerates topics. */
export function listMqttObjects(kind: string): DatabaseObject[] {
  requireKind(kind);
  throw new QueryError(MQTT_TOPICS_LISTED_ELSEWHERE, MQTT_TYPE);
}

/**
 * One topic's shape for the Objects surface.
 *
 * A topic has no columns, no indexes and no foreign keys, and saying so with empty lists is the honest answer:
 * what is known about a topic is its last message, which the Keys panel's row and the Source tab carry.
 */
export function describeMqttObject(path: readonly string[], kind: string): ObjectDetail {
  requireKind(kind);
  return { path, columns: [], indexes: [], foreignKeys: [] };
}

/** The batch form, which answers for the one kind and lists nothing under it. */
export function describeMqttObjects(kind: string): ObjectDetailBatch {
  requireKind(kind);
  return { details: [] };
}

/**
 * A topic's payload as the Source tab shows it, or the broker's own reason there is none.
 *
 * `form` is always `partial` and `origin` is `stored`: this is the last message the broker sent on that topic,
 * which is not the topic's history and not a guarantee that another is not already on its way.
 */
export function mqttSourceDocument(
  path: readonly string[],
  kind: string,
  row: MqttTopicRow | undefined,
): ObjectSourceDocument {
  requireKind(kind);
  const topic = path[path.length - 1] ?? "";
  if (row === undefined)
    return {
      path,
      kind,
      parts: [
        {
          id: "payload",
          label: "Payload",
          unavailable:
            `The broker sent nothing on "${topic}" during this read. A topic the broker did not send is not a ` +
            "topic that is absent: MQTT delivers a retained message at subscribe time and a live one when it is " +
            "published, and neither is a listing.",
        },
      ],
    };
  const body = row.payload;
  const text = body === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(body);
  /**
   * RENDERED AS REAL JSON, because the caption says it is.
   *
   * The Source tab captions a `rendered` part "A structured definition, rendered here as JSON" for every
   * language it does not name, which is a deliberate repository decision deferred to backlog D223. An earlier
   * version of this part was three plain-text lines under that caption, so the screen named a format the body
   * plainly was not. Rather than bend the shared caption for one provider, the part is what the caption says.
   */
  const facts = JSON.stringify(
    {
      retained: row.retained,
      payloadBytes: row.payloadBytes,
      lifetimeSeconds: row.lifetimeSeconds ?? null,
      lifetimeNote:
        row.lifetimeSeconds === undefined
          ? "The message carried no Message Expiry Interval, so the broker named no lifetime."
          : "The server's own answer. Two of the five brokers measured do not reduce this while a message waits, so nothing is computed from it.",
    },
    null,
    2,
  );
  return {
    path,
    kind,
    parts: [
      {
        id: "payload",
        label: "Payload",
        text: body === undefined || row.payloadBytes === 0 ? "" : text,
        language: "json",
        form: "partial",
        origin: "stored",
      },
      {
        id: "metadata",
        label: "Metadata",
        text: facts,
        language: "json",
        form: "complete",
        origin: "rendered",
      },
    ],
  };
}
