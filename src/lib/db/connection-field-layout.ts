/**
 * The body of the connection dialog for one engine, worked out from its form entry and the field descriptors rather
 * than by the dialog: which rows it draws, in which order, and which fields go behind the Advanced accordion.
 *
 * The order is the engine's own `connectionFields` order, or its `dialogOrder` where it declares one, with three rows placed by rule: the address row where the
 * engine lists its host, the login row where it lists its first credential (first of all where it takes no address,
 * and right after the address row, empty, where it takes no credential), and the API-key pair as one row. A field the
 * engine shows only under a condition (`fieldShownWhen`) leaves its row and is drawn at its own place while the
 * condition holds.
 *
 * UI-free, like the two tables it reads, so it is tested without a render.
 */
import { connectionFieldPlacement, connectionFieldShown, type ConnectionFormSpec } from "@/lib/db/connection-form";
import {
  type BodyConnectionField,
  bodyFieldDescriptor,
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELD_GROUPS,
  type ConnectionField,
  type ConnectionFieldGroupName,
  isBodyConnectionField,
  PLACEABLE_FIELDS,
  type PlaceableField,
} from "@/lib/db/connection-fields";

/** One row of the dialog's body. */
export type ConnectionFormSlot =
  /** The Host box, with the Port box beside it where the engine takes one. */
  | { readonly kind: "address" }
  /** Fields drawn side by side, under the group's note; may be empty for a group that is always drawn. */
  | {
      readonly kind: "group";
      readonly group: ConnectionFieldGroupName;
      readonly fields: readonly BodyConnectionField[];
    }
  | { readonly kind: "field"; readonly field: BodyConnectionField };

export interface ConnectionFormLayout {
  /** Whether the address row has a Port box: an engine whose whole address is one URL takes none. */
  readonly takesPort: boolean;
  /** Whether the SSL / TLS panel offers the consent to send a password without TLS. */
  readonly takesInsecureAuthConsent: boolean;
  readonly body: readonly ConnectionFormSlot[];
  /** The fields the engine places behind the Advanced accordion, in its order. */
  readonly advanced: readonly BodyConnectionField[];
}

const PLACEABLE: ReadonlySet<string> = new Set(PLACEABLE_FIELDS);

/** The row a field is drawn in, or undefined where it stands alone: no group, or shown only under a condition. */
function groupOf(config: ConnectionFormSpec, field: BodyConnectionField): ConnectionFieldGroupName | undefined {
  return config.fieldShownWhen?.[field] === undefined ? bodyFieldDescriptor(field).group : undefined;
}

/**
 * The dialog's body for one engine, given the form's current values, which decide the fields `fieldShownWhen` draws.
 */
export function connectionFormLayout(
  config: ConnectionFormSpec,
  values: Partial<Record<ConnectionField, unknown>>,
): ConnectionFormLayout {
  const fields = drawnOrder(config);
  const body: ConnectionFormSlot[] = [];
  const advanced: BodyConnectionField[] = [];
  const drawnGroups = new Set<ConnectionFieldGroupName>();
  for (const field of fields) {
    if (!isBodyConnectionField(field)) {
      if (CONNECTION_FIELD_DESCRIPTORS[field].slot === "address" && !body.some((slot) => slot.kind === "address")) {
        body.push({ kind: "address" });
      }
      continue;
    }
    if (PLACEABLE.has(field) && connectionFieldPlacement(config, field as PlaceableField) === "advanced") {
      advanced.push(field);
      continue;
    }
    if (!connectionFieldShown(config, field, values)) continue;
    const group = groupOf(config, field);
    if (group === undefined) {
      body.push({ kind: "field", field });
      continue;
    }
    if (drawnGroups.has(group)) continue;
    drawnGroups.add(group);
    const members = fields.filter((member): member is BodyConnectionField => {
      return isBodyConnectionField(member) && groupOf(config, member) === group;
    });
    body.push({ kind: "group", group, fields: members });
  }
  for (const group of Object.keys(CONNECTION_FIELD_GROUPS) as ConnectionFieldGroupName[]) {
    if (CONNECTION_FIELD_GROUPS[group].alwaysDrawn) placeAlwaysDrawn(body, group);
  }
  return {
    takesPort: config.connectionFields.includes("port"),
    takesInsecureAuthConsent: config.connectionFields.includes("allowInsecureAuth"),
    body,
    advanced,
  };
}

/** The engine's fields in the order the dialog draws them: its `dialogOrder`, then any field that leaves out. */
function drawnOrder(config: ConnectionFormSpec): readonly ConnectionField[] {
  const order = config.dialogOrder;
  if (order === undefined) return config.connectionFields;
  const named = order.filter((field) => config.connectionFields.includes(field));
  return [...named, ...config.connectionFields.filter((field) => !named.includes(field))];
}

/** Moves an always-drawn group to its place: first where there is no address row, else its own place or after it. */
function placeAlwaysDrawn(body: ConnectionFormSlot[], group: ConnectionFieldGroupName): void {
  const at = body.findIndex((slot) => slot.kind === "group" && slot.group === group);
  const slot: ConnectionFormSlot =
    at === -1 ? { kind: "group", group, fields: [] } : (body.splice(at, 1)[0] as ConnectionFormSlot);
  const address = body.findIndex((entry) => entry.kind === "address");
  if (address === -1) body.unshift(slot);
  else body.splice(at === -1 ? address + 1 : at, 0, slot);
}
