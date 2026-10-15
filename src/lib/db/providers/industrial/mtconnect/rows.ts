/**
 * One observation becomes one row.
 *
 * Four of the columns the grid shows are not on the observation. MEASURED by counting the attribute
 * union over four captured Streams answers, 478 observations: `dataItemId`, `sequence` and
 * `timestamp` on all 478, `subType` on 216, `name` on 191, `type` on 62, and then `assetType`,
 * `count`, `compositionId`, `duration`, `statistic` and `hash` on a handful. Neither `component`
 * nor `componentId` appears on any of the 478. They are on the enclosing `<ComponentStream>`, and
 * the device's identity on `<DeviceStream>`:
 *
 *     <ComponentStream component="Linear" name="X" componentId="dv1-x">
 *       <Samples>
 *         <Load dataItemId="dv1-x-load" name="load" sequence="17" timestamp="..."/>
 *
 * The streaming reader keeps those wrappers on a stack and hands each observation the inherited
 * fields, so this module never looks upward. What it does instead is join on
 * `dataItemId` against the held model, because category, type, units and the component path live
 * only in `probe`.
 *
 * `compositionId` is the one component-side identifier the observation itself carries, MEASURED on
 * 6 of the 478. It names a composition inside the component and is not a substitute for
 * `componentId`, so it travels in its own column.
 *
 * A value is the text the agent printed, never converted. MEASURED under Node 24.14.0 and Bun
 * 1.4.2 over the values the agents really send: ordinary floats round trip (`49.8754483333333`
 * survives `Number()` and back), but `1.79769313486232e+308` becomes Infinity, `inf` and `nan`
 * become NaN, `-0` becomes `0`, `9223372036854775807` and `18446744073709551615` lose digits,
 * `007` becomes `7`, and `UNAVAILABLE`, which shared the same column 48 times in one `current`
 * read, becomes NaN. So no column of SAMPLE values is typed as a number.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import type { MtcDataItem, MtcModel } from "./model";
import { displayName } from "./model";
import type { MtcElement, MtcObservation } from "./xml";

/** The condition states the standard names, which are element names rather than attribute values. */
const CONDITION_STATES = new Set(["Normal", "Warning", "Fault", "Unavailable"]);

export interface MtcRow {
  readonly device: string;
  readonly component?: string;
  readonly componentId?: string;
  /** A composition inside the component, from the observation itself. MEASURED on 6 of 478. */
  readonly compositionId?: string;
  /** The row key. The only identifier XML guarantees unique. */
  readonly dataItemId: string;
  /** For display. Absent from 287 of 478 observations, so it falls back to the component path and id. */
  readonly name: string;
  readonly category: "SAMPLE" | "EVENT" | "CONDITION" | "UNKNOWN";
  /** The data item's type from the model, or the observation's element name where the model has no row. */
  readonly type: string;
  readonly subType?: string;
  /** Normal, Warning, Fault or Unavailable, for a condition only. */
  readonly state?: string;
  /** The text the agent printed. UNAVAILABLE is a state the grid shows, never an empty cell. */
  readonly value: string;
  readonly units?: string;
  readonly timestamp: string;
  readonly sequence: string;
  /** `nativeCode`, `nativeSeverity`, `qualifier`, `conditionId` for a condition. */
  readonly nativeCode?: string;
  readonly nativeSeverity?: string;
  readonly qualifier?: string;
  readonly conditionId?: string;
  /** `sampleCount` and `sampleRate` for a TIME_SERIES, `count` for a DATA_SET or TABLE. */
  readonly sampleCount?: string;
  readonly sampleRate?: string;
  readonly entryCount?: string;
  /** `quality`, present only where the agent runs with `Validation = true`. */
  readonly quality?: string;
  /** True where the model held no row for this `dataItemId`. */
  readonly unknownToModel: boolean;
}

/**
 * A DATA_SET or TABLE value as JSON text, which is a specification decision rather than a
 * measurement: the shapes are nested and the grid shows one cell.
 *
 * MEASURED on the demo and on the pinned agent: a DATA_SET arrives as
 * `<VariableDataSet count="4"><Entry key="s">a b</Entry>...`, a TABLE as
 * `<WorkOffsetTable><Entry key="G54"><Cell key="X">1</Cell>...`. An `Entry` with no text and
 * `removed="true"` is a removed key, which the agent writes when an adapter sends a bare key.
 */
function entriesAsJson(children: readonly MtcElement[]): string {
  const entries: Record<string, unknown> = {};
  for (const entry of children) {
    if (entry.name !== "Entry") continue;
    const key = entry.attributes.key;
    if (key === undefined) continue;
    if (entry.attributes.removed === "true") {
      entries[key] = null;
      continue;
    }
    const cells = entry.children.filter((child) => child.name === "Cell");
    if (cells.length === 0) {
      entries[key] = entry.text;
      continue;
    }
    const row: Record<string, string> = {};
    for (const cell of cells) {
      const cellKey = cell.attributes.key;
      if (cellKey !== undefined) row[cellKey] = cell.text;
    }
    entries[key] = row;
  }
  return JSON.stringify(entries);
}

/**
 * The value of one observation.
 *
 * A condition's value is its message, which is the element's text, and its state is the element
 * NAME. MEASURED on the pinned agent: an adapter's two activations arrived as
 * `<Fault conditionId="FX1" nativeCode="FX1" nativeSeverity="1" qualifier="LOW">ilk aktivasyon` and
 * `<Warning conditionId="FX2" ...>`, and an unavailable condition as `<Unavailable/>` with no text.
 */
function valueOf(observation: MtcObservation): string {
  if (observation.children.length > 0) return entriesAsJson(observation.children);
  return observation.text;
}

/**
 * Build a row. The model supplies category, type, subType and units; the observation and its
 * wrappers supply everything else.
 *
 * An observation whose `dataItemId` is not in the model is kept rather than dropped, with
 * `unknownToModel` set. The model can be older than the stream by one `deviceModelChangeTime`, and
 * dropping the row would hide an observation the agent really sent.
 */
export function buildRow(observation: MtcObservation, model: MtcModel): MtcRow | undefined {
  const dataItemId = observation.attributes.dataItemId;
  const timestamp = observation.attributes.timestamp;
  const sequence = observation.attributes.sequence;
  if (dataItemId === undefined || timestamp === undefined || sequence === undefined) return undefined;

  const item: MtcDataItem | undefined = model.items.get(dataItemId);
  const isCondition = CONDITION_STATES.has(observation.element);

  return {
    device: observation.deviceName ?? item?.deviceName ?? "",
    component: observation.componentName ?? item?.componentPath,
    componentId: observation.componentId ?? item?.componentId,
    compositionId: observation.attributes.compositionId,
    dataItemId,
    name: item === undefined ? (observation.attributes.name ?? dataItemId) : displayName(item),
    category: item?.category ?? (isCondition ? "CONDITION" : "UNKNOWN"),
    type: item?.type ?? observation.attributes.type ?? observation.element,
    subType: item?.subType ?? observation.attributes.subType,
    state: isCondition ? observation.element : undefined,
    value: valueOf(observation),
    units: item?.units,
    timestamp,
    sequence,
    nativeCode: observation.attributes.nativeCode,
    nativeSeverity: observation.attributes.nativeSeverity,
    qualifier: observation.attributes.qualifier,
    conditionId: observation.attributes.conditionId,
    sampleCount: observation.attributes.sampleCount,
    sampleRate: observation.attributes.sampleRate,
    entryCount: observation.children.length > 0 ? observation.attributes.count : undefined,
    quality: observation.attributes.quality,
    unknownToModel: item === undefined,
  };
}

/**
 * Rows in the order the grid shows them: by timestamp, then by sequence.
 *
 * The agent does not answer in sequence order. MEASURED on the pinned agent: a 12 observation page
 * came back 11, 10, 12, 9, 8, 5, 7, 6, 1, 2, 4, 3, grouped by component, and every page of a 25,000
 * observation walk was out of sequence order. So the provider sorts, and sorts on the pair, because
 * an old build writes the Header's `creationTime` only to the second while observation timestamps
 * keep microseconds, and two observations can share a timestamp.
 */
export function sortRows(rows: readonly MtcRow[]): readonly MtcRow[] {
  return [...rows].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
    const a = left.sequence;
    const b = right.sequence;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * A row of the device model, which is what `probe` answers.
 *
 * These are the columns `probe` really carries, MEASURED by counting the attribute union over the
 * demo's 749 elements and 1,658 attributes: `id` and `category` on every data item, `type` on every
 * one, and then `name`, `subType`, `units`, `nativeUnits`, `representation` and `statistic` on some.
 * Nothing is invented for a column an agent does not publish.
 */
export interface MtcModelRow {
  readonly device: string;
  readonly deviceUuid: string;
  readonly component: string;
  readonly componentId?: string;
  readonly dataItemId: string;
  readonly name: string;
  readonly category: "SAMPLE" | "EVENT" | "CONDITION";
  readonly type: string;
  readonly subType?: string;
  readonly units?: string;
  readonly nativeUnits?: string;
  readonly representation?: string;
  readonly statistic?: string;
}

/** The held model as rows, for one device or for every device. */
export function rowsFromModel(model: MtcModel, device?: string): readonly MtcModelRow[] {
  const rows: MtcModelRow[] = [];
  for (const item of model.items.values()) {
    if (device !== undefined && item.deviceName !== device && item.deviceUuid !== device) continue;
    rows.push({
      device: item.deviceName,
      deviceUuid: item.deviceUuid,
      component: item.componentPath,
      componentId: item.componentId,
      dataItemId: item.dataItemId,
      name: displayName(item),
      category: item.category,
      type: item.type,
      subType: item.subType,
      units: item.units,
      nativeUnits: item.nativeUnits,
      representation: item.representation,
      statistic: item.statistic,
    });
  }
  return rows;
}

/**
 * One asset becomes one row, and its document is the row's value.
 *
 * The asset's TYPE is its element name rather than an attribute, MEASURED on the demo: 66 assets,
 * every one an element named `CuttingTool`, carrying `assetId`, `deviceUuid`, `timestamp`, `hash`
 * and the type's own attributes `toolId` and `serialNumber`. `removed` appears only on a removed
 * asset, which is why it is read as a flag rather than expected.
 *
 * The document is kept as received, extension elements included (MT-S9). The reader preserves
 * prefixes and attributes, so what is handed on is what the agent sent; an adapter's `x:Color`
 * arrives unprefixed with `xmlns:x` still declared, and nothing here classifies it.
 */
export interface MtcAssetRow {
  readonly assetId: string;
  readonly type: string;
  readonly deviceUuid?: string;
  readonly timestamp?: string;
  readonly removed: boolean;
  readonly hash?: string;
  /** Every other attribute the asset's own type declares, such as `toolId` and `serialNumber`. */
  readonly attributes: Readonly<Record<string, string>>;
  /** The asset element, for the Source tab. */
  readonly document: MtcElement;
}

const ASSET_OWN_ATTRIBUTES = new Set(["assetId", "deviceUuid", "timestamp", "removed", "hash"]);

/** The assets of an `MTConnectAssets` answer, in the order the agent sent them. */
export function rowsFromAssets(root: MtcElement): readonly MtcAssetRow[] {
  const wrapper = root.children.find((child) => child.name === "Assets");
  const assets = wrapper?.children ?? [];
  const rows: MtcAssetRow[] = [];
  for (const asset of assets) {
    const assetId = asset.attributes.assetId;
    if (assetId === undefined) continue;
    const own: Record<string, string> = {};
    for (const [key, value] of Object.entries(asset.attributes)) {
      if (!ASSET_OWN_ATTRIBUTES.has(key)) own[key] = value;
    }
    rows.push({
      assetId,
      // The element name is the type. An attribute named `type` would be the type's own.
      type: asset.name,
      deviceUuid: asset.attributes.deviceUuid,
      timestamp: asset.attributes.timestamp,
      removed: asset.attributes.removed === "true",
      hash: asset.attributes.hash,
      attributes: own,
      document: asset,
    });
  }
  return rows;
}
