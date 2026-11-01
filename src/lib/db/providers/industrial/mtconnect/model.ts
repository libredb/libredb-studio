/**
 * The device model, indexed once per connection.
 *
 * A Streams document says almost nothing about what an observation IS. MEASURED over four captured
 * Streams answers, 478 observations: every one carries `dataItemId`, `sequence` and `timestamp`, 216
 * carry `subType`, and **only 191 carry `name`**. Category, units, native units and the component
 * path appear nowhere in a Streams document at all: they are in the `probe` answer.
 *
 * So a row is built by joining an observation to this index on `dataItemId`, which is the only
 * identifier XML guarantees to be unique (issue #1722 section 6 item 4). `name` is
 * not a key: MEASURED on the pinned agent, a model that gives three data items in one device the
 * name `load` is ACCEPTED, with the agent logging "Duplicate name 'load' found" and
 * "Name 'load' may not resolve correctly on incoming streams". A model like that can arrive from
 * the field, and the agent itself does not trust the name.
 *
 * The index is held per connection and read again only when the Header's `instanceId` or
 * `deviceModelChangeTime` changes. That is not an optimisation. MEASURED on the pinned agent,
 * re-reading `probe` costs 244,195 bytes and 28 ms on a 42 device model, 1,164,119 bytes and 61 ms
 * on a 200 device model, and 2,918,819 bytes with a 70 ms median on a 500 device model, so a panel
 * that re-read the model for every page would fetch 2.9 MB a click.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import type { MtcElement } from "./xml";

/** What `probe` says about one data item, flattened for the join. */
export interface MtcDataItem {
  readonly dataItemId: string;
  /** Absent on 143 of the demo's 244 data items, and equal to the id on 3 more, so 146 are labelled by id. */
  readonly name?: string;
  readonly category: "SAMPLE" | "EVENT" | "CONDITION";
  readonly type: string;
  readonly subType?: string;
  readonly units?: string;
  readonly nativeUnits?: string;
  readonly representation?: string;
  readonly statistic?: string;
  /** The device this item belongs to, by `name` when it has one and by `uuid` otherwise. */
  readonly deviceName: string;
  readonly deviceUuid: string;
  /** `Axes:Axes/Linear:X`, empty at the device root. Built from component type and name. */
  readonly componentPath: string;
  /** The `id` of the component that holds the item, absent at the device root. */
  readonly componentId?: string;
  /** The component's element name, `Linear` or `Path`, absent at the device root. */
  readonly componentType?: string;
  /** How deep the holding component sits. 0 at the device root. */
  readonly componentDepth: number;
  /**
   * Whether the item sits inside an `Adapters` or `Adapter` component, which the agent synthesises for each adapter it
   * reads from: such a component's name, its id and its items' ids and `ADAPTER_URI` values carry the adapter's host
   * and port. Agent-mode handles withhold these items (`agent-withheld.ts`).
   */
  readonly withinAdapter: boolean;
}

export interface MtcModel {
  /** `instanceId` of the Header the model was read under. A cursor is only valid under this. */
  readonly instanceId: string;
  readonly deviceModelChangeTime?: string;
  /** Every data item by `dataItemId`. */
  readonly items: ReadonlyMap<string, MtcDataItem>;
  /** Device names in document order, for the one container level the tree draws. */
  readonly devices: readonly { readonly name: string; readonly uuid: string; readonly itemCount: number }[];
}

const CATEGORIES = new Set(["SAMPLE", "EVENT", "CONDITION"]);

/** The components the agent writes for the adapters it reads from, under its own Agent device. */
export const MTC_ADAPTER_COMPONENTS: ReadonlySet<string> = new Set(["Adapters", "Adapter"]);

/** `Linear:X`, or `Linear` where the component has no name. */
function segment(element: MtcElement): string {
  const name = element.attributes.name;
  return name === undefined || name === "" ? element.name : `${element.name}:${name}`;
}

function child(element: MtcElement, name: string): MtcElement | undefined {
  return element.children.find((candidate) => candidate.name === name);
}

/**
 * Index a parsed `probe` answer.
 *
 * Returns undefined where the document is not a device model, which is how a non MTConnect answer
 * is told apart from a bad one: a reverse proxy can answer any request with HTML, MEASURED on a
 * proxied agent where a 401 came back as `text/html` rather than as an `MTConnectError`.
 */
export function indexMtconnectModel(root: MtcElement): MtcModel | undefined {
  if (root.name !== "MTConnectDevices") return undefined;
  const header = child(root, "Header");
  const instanceId = header?.attributes.instanceId;
  if (instanceId === undefined) return undefined;
  const devicesElement = child(root, "Devices");
  if (devicesElement === undefined) return undefined;

  const items = new Map<string, MtcDataItem>();
  const devices: { name: string; uuid: string; itemCount: number }[] = [];

  for (const device of devicesElement.children) {
    // The Agent device is a device like any other, and it stays in scope: it carries the agent's own
    // health items. What its ids contain is a documented fact rather than a reason to drop it.
    // MEASURED on a hand written model holding no host name: the agent added an Agent device whose
    // fourteen items all lack `name`, whose ids read `_localhost_7878_connection_status` and so on,
    // and whose component is named `Adapter:shdr://localhost:7878`. The adapter's host and port are
    // synthesised by the agent, so they reach the model on every connection (MT-S10).
    const deviceUuid = device.attributes.uuid ?? "";
    const deviceName = device.attributes.name ?? deviceUuid;
    let itemCount = 0;

    const walk = (
      element: MtcElement,
      path: readonly string[],
      holder: MtcElement | undefined,
      withinAdapter: boolean,
    ): void => {
      const dataItems = child(element, "DataItems");
      if (dataItems !== undefined) {
        for (const item of dataItems.children) {
          if (item.name !== "DataItem") continue;
          const dataItemId = item.attributes.id;
          const category = item.attributes.category;
          if (dataItemId === undefined || !CATEGORIES.has(category)) continue;
          // A repeated id would be malformed XML; the reader refuses a repeated attribute on one
          // element but cannot see two elements sharing an id, so the first wins and the duplicate
          // is dropped rather than overwriting a row the grid already shows.
          if (items.has(dataItemId)) continue;
          items.set(dataItemId, {
            dataItemId,
            name: item.attributes.name,
            category: category as MtcDataItem["category"],
            type: item.attributes.type ?? "",
            subType: item.attributes.subType,
            units: item.attributes.units,
            nativeUnits: item.attributes.nativeUnits,
            representation: item.attributes.representation,
            statistic: item.attributes.statistic,
            deviceName,
            deviceUuid,
            componentPath: path.join("/"),
            componentId: holder?.attributes.id,
            componentType: holder === undefined ? undefined : holder.name,
            componentDepth: path.length,
            withinAdapter,
          });
          itemCount++;
        }
      }
      const components = child(element, "Components");
      if (components === undefined) return;
      for (const component of components.children) {
        const adapter = withinAdapter || MTC_ADAPTER_COMPONENTS.has(component.name);
        walk(component, [...path, segment(component)], component, adapter);
      }
    };

    walk(device, [], undefined, false);
    devices.push({ name: deviceName, uuid: deviceUuid, itemCount });
  }

  return {
    instanceId,
    deviceModelChangeTime: header?.attributes.deviceModelChangeTime,
    items,
    devices,
  };
}

/**
 * Whether a held model is still the one the agent is serving.
 *
 * MEASURED three times, on the demo agent and on two local ones: `instanceId` is the agent's start
 * time in Unix seconds, matching the container's own log line to the second. So a changed
 * `instanceId` means the agent restarted, every sequence number began again, and the model has to
 * be read afresh. A changed `deviceModelChangeTime` means the model itself moved under the same
 * agent instance.
 */
export function modelIsCurrent(model: MtcModel, header: Readonly<Record<string, string>>): boolean {
  if (header.instanceId !== model.instanceId) return false;
  const changed = header.deviceModelChangeTime;
  return changed === undefined || changed === model.deviceModelChangeTime;
}

/**
 * The display name of a data item: its component path and then its `name`, or its `id` where it has
 * no name.
 *
 * COUNTED on the demo: 143 of 244 data items carry no `name` and 3 more carry one equal to their id, so
 * 146 of 244 are labelled by their id either way. The id path is the common case rather than the exception. Lengths measured on three models: average 32 characters, longest 78 on
 * the demo, 67 on a five level model, 79 on an Agent device.
 *
 * This is a label, never a key. The qualified form produced no collision on any measured model, but
 * a collision was never shown to be impossible, so nothing keys on it.
 */
export function displayName(item: MtcDataItem): string {
  const leaf = item.name ?? item.dataItemId;
  return item.componentPath === "" ? leaf : `${item.componentPath}/${leaf}`;
}
