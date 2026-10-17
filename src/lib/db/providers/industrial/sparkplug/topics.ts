/**
 * The Sparkplug B topic namespace, parsed and never guessed (spec 4.1).
 *
 * A topic is `namespace/group_id/message_type/edge_node_id/[device_id]` (4.1), and an aware
 * server stores births under a second root, `$sparkplug/certificates/<that same topic>` (10.1.4).
 * This module is the only place either shape is read, because every trap below was measured and
 * each one silently mislabels a group, a node or a host if the parse is done by splitting on `/`
 * and trusting the positions.
 *
 * Pure. No I/O, no decode: a payload is bytes to this module.
 */

import { SPARKPLUG_NAMESPACE, STORED_BIRTH_ROOT } from "./constants";

/** The level separator, which is MQTT's own (MQTT 5.0 4.7.1). */
const TOPIC_SEPARATOR = "/";

/**
 * The nine message types of 4.1.3, and which of them carry a device level (4.1.5).
 *
 * `device` is the ONLY authority on whether a fifth level belongs: a DBIRTH without one and an
 * NBIRTH with one both break 4.1.5, and the measured decision is to mark the topic malformed
 * rather than to guess which level the publisher meant (section 4.8 of the proposal).
 */
export const MESSAGE_TYPES = Object.freeze({
  NBIRTH: { device: false },
  NDEATH: { device: false },
  NDATA: { device: false },
  NCMD: { device: false },
  DBIRTH: { device: true },
  DDEATH: { device: true },
  DDATA: { device: true },
  DCMD: { device: true },
  /**
   * STATE is the odd one: its topic is `spBv1.0/STATE/<sparkplug_host_id>` (6.4.27), so `STATE`
   * stands in the GROUP position and what follows is a host id rather than a message type. It is
   * listed here for completeness and handled before the group is read.
   */
  STATE: { device: false },
});

export type MessageType = keyof typeof MESSAGE_TYPES;

function isMessageType(token: string): token is MessageType {
  return Object.hasOwn(MESSAGE_TYPES, token);
}

/** A host state topic: `spBv1.0/STATE/<host_id>`, where the id may itself contain `/`. */
export interface HostStateTopic {
  readonly kind: "host-state";
  /**
   * Every level after `STATE`, joined back with `/`.
   *
   * 6.4.27 lets a host id "be any UTF-8 string", `/` included, so the id cannot be read as one
   * level: `spBv1.0/STATE/NBIRTH/e1` is the STATE of the host named `NBIRTH/e1`, not an NBIRTH
   * of a group named STATE. Measured with the prototype parser (section 4.8).
   */
  readonly hostId: string;
}

/** An edge node or device topic, live or stored. */
export interface NodeTopic {
  readonly kind: "node";
  readonly groupId: string;
  readonly messageType: MessageType;
  readonly edgeNodeId: string;
  /** Present exactly when `MESSAGE_TYPES[messageType].device` is true. */
  readonly deviceId?: string;
  /** True when the topic came from `$sparkplug/certificates/...`, i.e. a birth the server stored. */
  readonly stored: boolean;
}

/**
 * Why a topic was not read. The reason is kept because the tree shows it: a user whose node is
 * missing needs to know the broker sent a topic this provider refused, not that the node is gone.
 */
export type RejectedReason =
  | "not-sparkplug-b"
  | "too-few-levels"
  | "unknown-message-type"
  | "device-level-missing"
  | "device-level-unexpected"
  | "empty-level";

export interface RejectedTopic {
  readonly kind: "rejected";
  readonly reason: RejectedReason;
  /** The topic as the broker sent it, for the notice. Never re-interpreted. */
  readonly topic: string;
}

export type ParsedTopic = HostStateTopic | NodeTopic | RejectedTopic;

function reject(reason: RejectedReason, topic: string): RejectedTopic {
  return { kind: "rejected", reason, topic };
}

/**
 * Parse one topic name as the broker sent it.
 *
 * The order of the checks is the parse: the stored-birth prefix comes off first (it wraps a
 * whole ordinary topic), then the namespace, then STATE, and only then are the positions of
 * 4.1 read. Each rejection names itself so the tree can say what it refused.
 */
export function parseTopic(topic: string): ParsedTopic {
  let rest = topic;
  let stored = false;

  if (rest.startsWith(`${STORED_BIRTH_ROOT}${TOPIC_SEPARATOR}`)) {
    stored = true;
    rest = rest.slice(STORED_BIRTH_ROOT.length + 1);
  }

  const levels = rest.split(TOPIC_SEPARATOR);
  if (levels[0] !== SPARKPLUG_NAMESPACE) {
    // `spAv1.0` (Sparkplug A) and the 4.0 draft's namespaces are not this specification (4.1.1),
    // and a `$SYS/...` topic reaches here on a broker that answers `#` with its own tree.
    return reject("not-sparkplug-b", topic);
  }
  if (levels.length < 3) return reject("too-few-levels", topic);

  // STATE stands in the group position, and the host id is every level after it (6.4.27).
  //
  // A GROUP LITERALLY NAMED `STATE` IS READ AS HOST STATE AND THERE IS NO WAY AROUND IT. 4.1.2
  // does not forbid such a group, and its topics are byte for byte what a host state topic looks
  // like, so no parser can tell them apart; the proposal's section 4.8 reaches the same conclusion
  // ("such a group could not be told apart and would not be read"). An earlier draft of this
  // function carried a `group-named-state` rejection below, which was DEAD CODE: this branch
  // returns first for every topic it could have matched. Saying so here is the honest form,
  // because a reader who adds that rejection back will find its tests pass and its branch never run.
  if (levels[1] === "STATE") {
    const hostId = levels.slice(2).join(TOPIC_SEPARATOR);
    if (hostId === "") return reject("empty-level", topic);
    return { kind: "host-state", hostId };
  }

  const [, groupId, messageType, edgeNodeId, ...tail] = levels;
  if (groupId === "") return reject("empty-level", topic);
  if (!isMessageType(messageType)) return reject("unknown-message-type", topic);
  if (messageType === "STATE") return reject("unknown-message-type", topic);
  if (edgeNodeId === undefined || edgeNodeId === "") return reject("empty-level", topic);

  const wantsDevice = MESSAGE_TYPES[messageType].device;
  if (wantsDevice) {
    if (tail.length !== 1 || tail[0] === "") return reject("device-level-missing", topic);
    return { kind: "node", groupId, messageType, edgeNodeId, deviceId: tail[0], stored };
  }
  if (tail.length !== 0) return reject("device-level-unexpected", topic);
  return { kind: "node", groupId, messageType, edgeNodeId, stored };
}

/**
 * Refuse a group name that cannot be put in a subscription filter before any socket is opened.
 *
 * The Database field names one group, and a group holding `+`, `/` or `#` would either widen the
 * filter past that group or make it invalid, so it is refused with a sentence rather than escaped
 * (4.1.2 sets no character rule, so this is the provider's own bound).
 */
export function groupIdIsFilterSafe(groupId: string): boolean {
  return groupId !== "" && !groupId.includes("+") && !groupId.includes("#") && !groupId.includes(TOPIC_SEPARATOR);
}

/**
 * The subscription filters for one read, which deliberately do not overlap.
 *
 * Two filters are needed because MQTT 5.0 4.7.2 [MQTT-4.7.2-1] says a server must not match a
 * filter starting with a wildcard against a topic beginning with `$`, so the stored births need
 * a filter of their own. MEASURED on 2026-10-13: on Mosquitto 2.1.2 the filter `#` returned zero
 * stored births and `$sparkplug/#` returned both, and the two filters below returned the two
 * topics once each, with no duplicate; MQTT 5.0 3.3.4 lets a server send "further copies of the
 * message, one for each additional matching subscription", which is why they must not overlap.
 *
 * MEASURED the same day, and the reason this function does not rely on `#` doing the right thing:
 * HiveMQ CE 2026.5 with the Sparkplug Aware Extension 4.33.12 DOES match `#` against
 * `$sparkplug/...`, against [MQTT-4.7.2-1]. The filters below are unaffected, because neither
 * begins with a wildcard.
 */
export function readFilters(groupId?: string): readonly string[] {
  const everyGroup = groupId === undefined || groupId === "";
  const group = everyGroup ? "#" : `${groupId}/#`;
  const filters = [`${SPARKPLUG_NAMESPACE}/${group}`, `${STORED_BIRTH_ROOT}/${SPARKPLUG_NAMESPACE}/${group}`];

  // Host state is retained, so a late reader always sees the last one (6.4.27). It needs a filter
  // of its own ONLY when a group was named, because `spBv1.0/<group>/#` cannot match
  // `spBv1.0/STATE/<host>`. Adding it when no group was named would overlap `spBv1.0/#`, which
  // already matches every STATE topic, and an overlap is what MQTT 5.0 3.3.4 answers with a second
  // copy of every message. `tests/.../topics.test.ts` holds the no-overlap property for both shapes.
  if (!everyGroup) filters.push(`${SPARKPLUG_NAMESPACE}/STATE/#`);

  return Object.freeze(filters);
}
