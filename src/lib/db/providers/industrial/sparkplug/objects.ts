/**
 * The tree a read produces: Group, then Edge node, with the node's own metrics and its devices
 * under it.
 *
 * The shape follows the specification's own addressing. An Edge Node Descriptor is `group_id` plus
 * `edge_node_id` (1.4.1), so those are the two container levels; a device hangs off its edge node
 * (4.1.5), so it is an object kind rather than a third level. The metrics of a birth certificate
 * are the columns of one object, because a birth declares every metric the node will publish with
 * its datatype (4.2.1).
 *
 * THE TREE LISTS WHAT ONE READ SAW AND SAYS SO. An edge node that published nothing during the
 * window and has no stored certificate is not listed, which is not evidence that it is gone. The
 * same rule the shipped MQTT provider states about its topics.
 *
 * Pure. Takes a `ReadState` and returns rows. No I/O.
 */
import type { Container, ContainerLevels, DatabaseObject, KindCount, ObjectKindSpec } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import { SPARKPLUG_NOT_SEEN } from "./labels";
import type { EdgeNodeState, ReadState } from "./state";
import { datatypeName } from "./values";

/**
 * Group, then Edge node. Both come from the topic, which is the only place they exist (4.1).
 *
 * Typed as a two-element tuple because `ContainerLevels` is spelled as a union of tuples: no engine
 * in the repository declares three levels, and the ceiling is a compile error at the provider that
 * writes a third rather than a number to widen somewhere else.
 */
export const SPARKPLUG_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  Object.freeze({ id: "catalog" as const, label: "Group", labelPlural: "Groups" }),
  Object.freeze({ id: "schema" as const, label: "Edge node", labelPlural: "Edge nodes" }),
]);

/** The node's own metrics, and one object per device under it. */
export const SPARKPLUG_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  Object.freeze({
    id: "node",
    role: "relation" as const,
    label: "Edge node metrics",
    labelPlural: "Edge node metrics",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
  }),
  Object.freeze({
    id: "device",
    role: "relation" as const,
    label: "Device",
    labelPlural: "Devices",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
  }),
]);

/** The kind ids, so a caller cannot misspell one. */
export const SPARKPLUG_KINDS = Object.freeze({ node: "node", device: "device" } as const);

/**
 * The groups one read saw.
 *
 * A group exists only because a topic named it, so a read with nothing in it lists nothing rather
 * than inventing a default group.
 */
export function listGroups(state: ReadState): Container[] {
  const names = [...new Set(state.all().map((node) => node.groupId))];
  // Code points, not the default sort: `Array.prototype.sort` compares UTF-16 code units, which
  // orders a surrogate pair before U+FFFD where UTF-8 byte order puts U+FFFD first. A group id is
  // any UTF-8 string, so the difference is reachable.
  names.sort(compareCodePoints);
  return names.map((name) => ({ path: [name], name, level: 0 }));
}

/** The edge nodes one read saw inside one group. */
export function listEdgeNodes(state: ReadState, groupId: string): Container[] {
  const names = state
    .all()
    .filter((node) => node.groupId === groupId)
    .map((node) => node.edgeNodeId);
  names.sort(compareCodePoints);
  return names.map((name) => ({ path: [groupId, name], name, level: 1 }));
}

/**
 * Compare two names by code point.
 *
 * `firestore/names.ts` carries the same comparison for the same reason, and the coordination note
 * that produced this rule states it: the default sort is a third order again once percent escaping
 * is involved, so a provider sorts decoded values and escapes afterwards.
 */
export function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let at = 0; at < Math.min(a.length, b.length); at++) {
    const one = a[at].codePointAt(0) ?? 0;
    const two = b[at].codePointAt(0) ?? 0;
    if (one !== two) return one - two;
  }
  return a.length - b.length;
}

function nodeOf(state: ReadState, groupId: string, edgeNodeId: string): EdgeNodeState | undefined {
  return state.all().find((node) => node.groupId === groupId && node.edgeNodeId === edgeNodeId);
}

/** What the tree shows as the count of each kind under one edge node. */
export function countObjects(state: ReadState, container: readonly string[]): Record<string, KindCount> {
  const node = nodeOf(state, container[0] ?? "", container[1] ?? "");
  return {
    [SPARKPLUG_KINDS.node]: { count: node?.birth === undefined ? 0 : 1 },
    [SPARKPLUG_KINDS.device]: { count: node?.devices.size ?? 0 },
  };
}

/**
 * The objects of one kind under one edge node.
 *
 * An edge node with no birth certificate in hand produces NO `node` object, deliberately: an
 * object with no columns would read as a node whose metric list is empty, when the truth is that
 * its definitions were not seen. The health summary counts those separately.
 */
export function listObjects(state: ReadState, container: readonly string[], kind: string): DatabaseObject[] {
  const groupId = container[0] ?? "";
  const edgeNodeId = container[1] ?? "";
  const node = nodeOf(state, groupId, edgeNodeId);
  if (node === undefined) return [];

  if (kind === SPARKPLUG_KINDS.node) {
    if (node.birth === undefined) return [];
    return [
      {
        // The node's own metrics are addressed by the node itself: there is no third name.
        path: [groupId, edgeNodeId],
        name: edgeNodeId,
        kind: SPARKPLUG_KINDS.node,
        // SET ONLY FOR THE TWO CASES A READER HAS SOMETHING TO DO ABOUT, which is what `status` is
        // for, and never the word "online": a node that published nothing during the window is
        // indistinguishable from one that is up and quiet, so "not seen in this read" is the whole
        // of what a read can say. A node that published during the read is the ordinary case and
        // carries no status at all. The long form of each is `livenessSentence`.
        ...(node.liveness.kind === "published-during-read" ? {} : { status: livenessStatus(node) }),
      },
    ];
  }
  if (kind !== SPARKPLUG_KINDS.device) return [];
  const names = [...node.devices.keys()];
  names.sort(compareCodePoints);
  return names.map((name) => ({ path: [groupId, edgeNodeId, name], name, kind: SPARKPLUG_KINDS.device }));
}

/**
 * The columns of one object, which are the metrics its birth certificate declared.
 *
 * `nullable` is false for every metric and that is a statement, not a default: `is_null` is a flag
 * on one VALUE in one message (6.4.5), not a property of the definition, so a birth certificate
 * cannot say a metric is nullable. The type name is the datatype's own name (6.4.16), never the
 * wire field that carried the value.
 */
export function objectColumns(state: ReadState, path: readonly string[], kind: string): ColumnSchema[] {
  const groupId = path[0] ?? "";
  const edgeNodeId = path[1] ?? "";
  const node = nodeOf(state, groupId, edgeNodeId);
  if (node === undefined) return [];
  const birth = kind === SPARKPLUG_KINDS.device ? node.devices.get(path[path.length - 1] ?? "") : node.birth;
  if (birth === undefined) return [];
  const metrics = [...birth.metrics];
  metrics.sort((left, right) => compareCodePoints(left.name, right.name));
  return metrics.map((metric) => ({
    name: metric.name,
    type: datatypeName(metric.datatype) ?? `datatype ${metric.datatype}`,
    // Sparkplug has no nullable column: `is_null` is a per-VALUE flag on one message (6.4.5), not a
    // property of the definition, so the schema claim here is false rather than borrowed from it.
    nullable: false,
    // A birth certificate declares no key of any kind.
    isPrimary: false,
  }));
}

/**
 * One line for the tree about an edge node's liveness, which is never the word "online".
 *
 * The three states are what a read can actually tell apart. See `state.ts` for the measurement
 * that forced them apart from the existence of a definition.
 */
function livenessStatus(node: EdgeNodeState): string {
  return node.liveness.kind === "death-seen-in-this-read" ? "death seen in this read" : "not seen in this read";
}

export function livenessSentence(node: EdgeNodeState): string {
  switch (node.liveness.kind) {
    case "not-seen-in-this-read":
      return SPARKPLUG_NOT_SEEN;
    case "published-during-read":
      return "Published during this read.";
    default:
      return node.liveness.bdSeq === undefined
        ? "A death message arrived during this read."
        : `A death message arrived during this read, matching birth bdSeq ${node.liveness.bdSeq}.`;
  }
}
