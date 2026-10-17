/**
 * The console's read request: one JSON object, parsed and refused before anything is dialled.
 *
 * The shape follows the Kafka console's: `queryLanguage` is `"json"` and the request names what to
 * read rather than how. Every refusal here costs nothing, because none of it touches a broker.
 *
 * TWO KEYS ARE REFUSED RATHER THAN IGNORED, and that is the whole reason this module is separate
 * from the parser that reads the rest.
 *
 * `rebirth` asks this reader to publish a `Node Control/Rebirth` command. That is how a host
 * application learns the certificates it missed, and it is also a command to somebody else's
 * equipment: the edge node stops its data while it republishes every certificate. This version
 * sends no command at all, so the key is refused with that sentence in it.
 *
 * `hostId` asks this connection to be a Sparkplug Host Application. A host application MUST
 * publish state messages, and an offline state message makes every edge node waiting for that host
 * disconnect and start over. So there is no host id field, and a request that names one is refused
 * rather than quietly dropped: a dropped key would let a user believe the reader took the role.
 *
 * Pure. Takes text, returns a request or throws with the reason.
 */
import { QueryError } from "@/lib/db/errors";

import { DEFAULT_WINDOW_SECONDS, MAX_ROWS, MAX_WINDOW_SECONDS } from "./constants";

/** A parsed, validated read request. Every field is either present and sound, or absent. */
export interface SparkplugReadQuery {
  readonly group?: string;
  readonly edgeNode?: string;
  readonly device?: string;
  readonly seconds: number;
  readonly limit: number;
  /** True when the request asked for births to be included as rows, which is the default. */
  readonly includeBirths: boolean;
}

/** The keys this version understands, so a typo is named rather than ignored. */
const KNOWN_KEYS = Object.freeze(["group", "edgeNode", "device", "seconds", "limit", "includeBirths"] as const);

/** The keys this version refuses on purpose, each with the sentence that says why. */
const REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  rebirth:
    "This version sends no rebirth request. A rebirth is a command to somebody else's equipment: the " +
    "edge node stops publishing data while it republishes every birth certificate. Certificates reach " +
    "this reader from the copies an aware broker stores, from reconnecting edge nodes, and from " +
    "rebirths another host requested.",
  hostId:
    "This connection has no host id and cannot have one. A Sparkplug Host Application must publish " +
    "state messages, and an offline state message makes every edge node waiting for that host " +
    "disconnect. This provider publishes nothing.",
  command:
    "This version sends no command. On a Sparkplug system a command writes a device output, which is " +
    "an actuation and not a read.",
  publish: "This provider has no code that can publish to a broker.",
});

function wholeNumber(value: unknown, key: string, low: number, high: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < low || number > high)
    throw new QueryError(`"${key}" is a whole number between ${low} and ${high.toLocaleString("en-US")}.`);
  return number;
}

function nonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string" || value === "")
    throw new QueryError(`"${key}" is a non-empty string when it is given.`);
  return value;
}

/**
 * Parse one request.
 *
 * An empty string and `{}` both mean "every group, the default window": the console opens with an
 * empty editor and running it should read rather than complain.
 */
export function parseReadQuery(text: string): SparkplugReadQuery {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed === "" ? "{}" : trimmed);
  } catch {
    throw new QueryError(
      'A Sparkplug read is a JSON object, for example { "group": "G1", "edgeNode": "E1", "seconds": 10 }.',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new QueryError("A Sparkplug read is a JSON object, not an array or a bare value.");

  const object = parsed as Record<string, unknown>;

  // The refused keys come first, so their own sentence is what the user sees rather than
  // "unknown key". A key refused on purpose is not a typo.
  for (const [key, reason] of Object.entries(REFUSED_KEYS)) {
    if (Object.hasOwn(object, key)) throw new QueryError(reason);
  }
  // A key this version does not understand is named, because a silently ignored key reads as a
  // filter that was applied. `"edgenode"` for `"edgeNode"` is the case that costs a user an hour.
  for (const key of Object.keys(object)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key))
      throw new QueryError(`"${key}" is not a field of a Sparkplug read. The fields are: ${KNOWN_KEYS.join(", ")}.`);
  }

  const query: {
    group?: string;
    edgeNode?: string;
    device?: string;
    seconds: number;
    limit: number;
    includeBirths: boolean;
  } = {
    seconds: Object.hasOwn(object, "seconds")
      ? wholeNumber(object.seconds, "seconds", 1, MAX_WINDOW_SECONDS)
      : DEFAULT_WINDOW_SECONDS,
    limit: Object.hasOwn(object, "limit") ? wholeNumber(object.limit, "limit", 1, MAX_ROWS) : MAX_ROWS,
    includeBirths: Object.hasOwn(object, "includeBirths") ? asBoolean(object.includeBirths) : true,
  };

  if (Object.hasOwn(object, "group")) query.group = nonEmptyString(object.group, "group");
  if (Object.hasOwn(object, "edgeNode")) query.edgeNode = nonEmptyString(object.edgeNode, "edgeNode");
  if (Object.hasOwn(object, "device")) query.device = nonEmptyString(object.device, "device");

  // A device is addressed through the node that owns it (4.1.5), and a device name alone would
  // match the same name under every node, which is a different question from the one asked.
  if (query.device !== undefined && query.edgeNode === undefined)
    throw new QueryError('"device" needs its "edgeNode": a device is addressed through the node that owns it.');

  return query;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new QueryError('"includeBirths" is true or false.');
  return value;
}

/**
 * The subscription this request needs, as a sentence for the result's warning line.
 *
 * It names the window and the scope, because a console read is a SAMPLE and the row count alone
 * does not say what it is a sample of.
 */
export function describeScope(query: SparkplugReadQuery): string {
  const scope =
    query.device !== undefined
      ? `device ${query.device} under ${query.group ?? "every group"}/${query.edgeNode}`
      : query.edgeNode !== undefined
        ? `edge node ${query.group ?? "every group"}/${query.edgeNode}`
        : query.group !== undefined
          ? `group ${query.group}`
          : "every group";
  return `${query.seconds} second window over ${scope}, at most ${query.limit.toLocaleString("en-US")} rows`;
}
