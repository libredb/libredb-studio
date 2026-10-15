/**
 * The model index and the row builder, against the captured answers.
 *
 * Every number asserted here was measured on the agent before it was written down, and the
 * documents are the real ones rather than fixtures written to suit the code: the
 * `probe` and `current` answers in `tests/fixtures/mtconnect/2.8.0.3/` came from one instance of the
 * Institute's demo agent in the same minute, so a row built from one can be checked against the
 * other.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { MtcElement } from "@/lib/db/providers/industrial/mtconnect/xml";
import { join } from "node:path";
import { indexMtconnectModel, modelIsCurrent, displayName } from "@/lib/db/providers/industrial/mtconnect/model";
import {
  buildRow,
  rowsFromAssets,
  rowsFromModel,
  sortRows,
  type MtcRow,
} from "@/lib/db/providers/industrial/mtconnect/rows";
import { readMtconnectXml, streamMtconnectObservations } from "@/lib/db/providers/industrial/mtconnect/xml";

const DIR = join(import.meta.dir, "../../../fixtures/mtconnect/2.8.0.3");
const bytes = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

function model() {
  const read = readMtconnectXml(bytes("probe.xml"));
  if (!read.ok) throw new Error(read.reason);
  const indexed = indexMtconnectModel(read.root);
  if (indexed === undefined) throw new Error("the probe answer did not index");
  return indexed;
}

function rows(fixture: string): MtcRow[] {
  const held = model();
  const built: MtcRow[] = [];
  const result = streamMtconnectObservations(bytes(fixture), (observation) => {
    const row = buildRow(observation, held);
    if (row !== undefined) built.push(row);
  });
  if (!result.ok) throw new Error(result.reason);
  return built;
}

describe("the model index", () => {
  test("indexes every data item the probe declares", () => {
    const held = model();
    expect(held.items.size).toBe(244);
    expect(held.instanceId).toBe("1791206842");
    expect(held.deviceModelChangeTime).toBe("2026-10-05T13:27:22.833446Z");
  });

  test("names the three devices and counts their items", () => {
    const held = model();
    expect(held.devices.map((device) => device.name)).toEqual(["Agent", "OKUMA", "Mazak"]);
    expect(held.devices.map((device) => device.itemCount)).toEqual([20, 104, 120]);
  });

  test("most data items must be labelled by their id, and the two reasons are counted apart", () => {
    const held = model();
    const items = [...held.items.values()];
    // COUNTED directly on the probe answer. An earlier measurement reported 146 without a name by
    // asking whether the generated label ended in the id, which conflated two different cases.
    const withoutName = items.filter((item) => item.name === undefined);
    const nameEqualsId = items.filter((item) => item.name !== undefined && item.name === item.dataItemId);
    expect(withoutName.length).toBe(143);
    expect(nameEqualsId.map((item) => item.dataItemId).sort()).toEqual([
      "MachineMaintenance",
      "MachineOperator",
      "MachineSetup",
    ]);
    // 146 of 244, 60 percent, end up labelled by their id either way, which is what the tree sees.
    expect(withoutName.length + nameEqualsId.length).toBe(146);
  });

  test("a data item carries the component path its observation does not", () => {
    const held = model();
    const deepest = [...held.items.values()].sort((a, b) => b.componentDepth - a.componentDepth)[0];
    expect(deepest.componentDepth).toBeGreaterThanOrEqual(2);
    expect(deepest.componentPath).toContain("/");
    expect(deepest.componentId).toBeTruthy();
    expect(deepest.componentType).toBeTruthy();
  });

  test("the Agent device's items are nameless and their ids carry the adapter's address", () => {
    // MT-S10. MEASURED: the agent synthesises this device, so the host and port reach the model on
    // every connection, whatever the operator's own model contains.
    const held = model();
    const agentItems = [...held.items.values()].filter((item) => item.deviceName === "Agent");
    expect(agentItems.length).toBe(20);
    expect(agentItems.filter((item) => item.name !== undefined).length).toBe(0);
    const adapterItems = agentItems.filter((item) => item.dataItemId.includes("_okuma_7878"));
    expect(adapterItems.length).toBeGreaterThan(0);
    expect(displayName(adapterItems[0])).toContain("shdr://okuma:7878");
  });

  test("a held model is current only under its own instanceId", () => {
    const held = model();
    expect(
      modelIsCurrent(held, { instanceId: "1791206842", deviceModelChangeTime: held.deviceModelChangeTime ?? "" }),
    ).toBe(true);
    expect(modelIsCurrent(held, { instanceId: "1791206843" })).toBe(false);
    expect(modelIsCurrent(held, { instanceId: "1791206842", deviceModelChangeTime: "2026-10-06T00:00:00Z" })).toBe(
      false,
    );
  });

  test("a document that is not a device model does not index", () => {
    for (const other of ["current.xml", "assets.xml", "error-out-of-range.xml"]) {
      const read = readMtconnectXml(bytes(other));
      if (!read.ok) throw new Error(read.reason);
      expect(indexMtconnectModel(read.root)).toBeUndefined();
    }
  });
});

describe("rows from current", () => {
  test("one row for every data item, each keyed by its own dataItemId", () => {
    const built = rows("current.xml");
    expect(built.length).toBe(244);
    expect(new Set(built.map((row) => row.dataItemId)).size).toBe(244);
  });

  test("every row knows its device and its component, which the observation never carried", () => {
    const built = rows("current.xml");
    expect(built.every((row) => row.device !== "")).toBe(true);
    expect(built.every((row) => row.componentId !== undefined)).toBe(true);
    expect(new Set(built.map((row) => row.device))).toEqual(new Set(["Agent", "OKUMA", "Mazak"]));
  });

  test("the model supplied the category, and every row has one", () => {
    const built = rows("current.xml");
    const categories = new Set(built.map((row) => row.category));
    expect(categories.has("UNKNOWN")).toBe(false);
    expect([...categories].sort()).toEqual(["CONDITION", "EVENT", "SAMPLE"]);
    expect(built.every((row) => row.unknownToModel === false)).toBe(true);
  });

  test("a condition's state is its element name and its message is the value", () => {
    const built = rows("current.xml").filter((row) => row.category === "CONDITION");
    // COUNTED on the fixture: 24 conditions, and the states they carry are not all one value, which
    // is what lets this test tell a working state reader from one that returns a constant.
    // COUNTED through this code on the fixture: 31 condition rows, because a `<Condition>` wrapper
    // can hold more than one activation, and the 24 wrappers hold 31 between them.
    expect(built).toHaveLength(31);
    const states = new Set(built.map((row) => row.state));
    expect(states).toEqual(new Set(["Normal", "Unavailable"]));
    expect([...states].every((state) => ["Normal", "Warning", "Fault", "Unavailable"].includes(state ?? ""))).toBe(
      true,
    );
    // The state comes from the element name, so a reader taking it from an attribute finds nothing:
    // no observation in this document carries a `state` attribute.
    expect(built.every((row) => row.state !== undefined)).toBe(true);
  });

  test("UNAVAILABLE is a value the grid shows, never an empty cell", () => {
    const built = rows("current.xml");
    // An earlier version of this test filtered the rows on the value and then asserted the value,
    // which cannot fail. What the rule actually says is that UNAVAILABLE reaches the row as text
    // rather than being turned into an empty cell, so the assertion is about the rows that are
    // empty: there must be none except the condition activations, which carry no text at all.
    const unavailable = built.filter((row) => row.value === "UNAVAILABLE");
    expect(unavailable).toHaveLength(48);
    // COUNTED: 38 rows carry no text at all, and they are NOT all conditions. Seven are EVENT data
    // items an adapter left empty, among them `ProgramHeader` and three `Personnel` items. So an
    // empty value and UNAVAILABLE are two different states and the grid shows both as they are.
    // An earlier version of this test asserted every empty row was a condition, which the fixture
    // disproved.
    const empty = built.filter((row) => row.value === "");
    expect(empty).toHaveLength(38);
    expect(empty.filter((row) => row.category !== "CONDITION")).toHaveLength(7);
    expect(new Set(empty.map((row) => row.category))).toEqual(new Set(["CONDITION", "EVENT"]));
    // And the fixture discriminates: it holds rows with real values too, so an implementation that
    // wrote UNAVAILABLE into every cell would fail here.
    expect(built.filter((row) => row.value !== "UNAVAILABLE" && row.value !== "").length).toBeGreaterThan(100);
  });

  test("a value is the text the agent printed, with no conversion", () => {
    const built = rows("current.xml");
    const numeric = built.filter((row) => /^[0-9]+\.[0-9]{10,}$/.test(row.value));
    expect(numeric.length).toBeGreaterThan(0);
    for (const row of numeric) {
      // The text is kept as text. Converting and printing back would lose the shapes measured in
      // the specification: Infinity, NaN, -0, clamped 64 bit integers and a leading zero.
      expect(typeof row.value).toBe("string");
      expect(row.value).not.toContain("e+");
    }
  });

  test("a DATA_SET becomes JSON text with its entries", () => {
    const built = rows("current.xml").filter((row) => row.value.startsWith("{"));
    expect(built.length).toBeGreaterThan(0);
    const parsed = JSON.parse(built[0].value) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(built[0].entryCount).toBeTruthy();
  });

  test("units come from the model, since no observation carries them", () => {
    const built = rows("current.xml");
    expect(built.some((row) => row.units !== undefined)).toBe(true);
    const held = model();
    for (const row of built) {
      expect(row.units).toBe(held.items.get(row.dataItemId)?.units);
    }
  });
});

describe("rows from a sample page", () => {
  test("every observation of a page becomes a row, and no wrapper does", () => {
    // COUNTED on each fixture. A walker that emitted the wrappers as observations would read more
    // than these, which is why the numbers are pinned rather than asserted as "more than zero".
    expect(rows("sample-count-200.xml")).toHaveLength(200);
    expect(rows("sample-count-negative.xml")).toHaveLength(3);
    expect(rows("current-path-condition.xml")).toHaveLength(31);
    // And every row is an observation: a wrapper carries no dataItemId, so none could have got in.
    for (const name of ["sample-count-200.xml", "sample-count-negative.xml", "current-path-condition.xml"]) {
      expect(rows(name).every((row) => row.dataItemId !== "")).toBe(true);
    }
  });

  test("sorting is by timestamp and then by sequence, because the agent does not answer in order", () => {
    const built = rows("sample-count-200.xml");
    const sorted = sortRows(built);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous.timestamp === current.timestamp) {
        expect(Number(previous.sequence)).toBeLessThanOrEqual(Number(current.sequence));
      } else {
        expect(previous.timestamp < current.timestamp).toBe(true);
      }
    }
  });

  test("the page really was out of sequence order before sorting", () => {
    // Otherwise the test above proves nothing about the sort.
    const built = rows("sample-count-200.xml");
    const asGiven = built.map((row) => Number(row.sequence));
    const ascending = asGiven.every((value, index) => index === 0 || asGiven[index - 1] <= value);
    expect(ascending).toBe(false);
  });
});

describe("rows from a document: the model and the assets", () => {
  test("the model's rows carry the columns probe really publishes", () => {
    const rows = rowsFromModel(model());
    expect(rows).toHaveLength(244);
    // Every data item has these three; the rest are present on some and absent on others, which is
    // what makes the next test able to tell a right implementation from a wrong one.
    expect(rows.every((row) => row.dataItemId !== "")).toBe(true);
    expect(rows.every((row) => ["SAMPLE", "EVENT", "CONDITION"].includes(row.category))).toBe(true);
    expect(rows.every((row) => row.type !== "")).toBe(true);
  });

  test("the fixture discriminates: these columns vary across the rows", () => {
    // A test that asserts a column exists proves nothing if every row carries the same value. This
    // is the check that the data can tell implementations apart.
    const rows = rowsFromModel(model());
    expect(new Set(rows.map((row) => row.device)).size).toBe(3);
    expect(new Set(rows.map((row) => row.category)).size).toBe(3);
    expect(new Set(rows.map((row) => row.type)).size).toBeGreaterThan(20);
    expect(new Set(rows.map((row) => row.component)).size).toBeGreaterThan(10);
    expect(rows.filter((row) => row.units !== undefined).length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.units === undefined).length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.subType !== undefined).length).toBeGreaterThan(0);
  });

  test("one device's rows are a strict subset, so the device filter is doing something", () => {
    const all = rowsFromModel(model());
    const mazak = rowsFromModel(model(), "Mazak");
    expect(mazak).toHaveLength(120);
    expect(mazak.length).toBeLessThan(all.length);
    expect(mazak.every((row) => row.device === "Mazak")).toBe(true);
    // And by uuid as well as by name, because a request may name either.
    expect(rowsFromModel(model(), "OKUMA.123456")).toHaveLength(104);
  });

  test("an asset row takes its type from the element name, not from an attribute", () => {
    const read = readMtconnectXml(bytes("assets.xml"));
    if (!read.ok) throw new Error(read.reason);
    const rows = rowsFromAssets(read.root);
    expect(rows).toHaveLength(66);
    expect(rows.every((row) => row.type === "CuttingTool")).toBe(true);
    // MEASURED: no asset in this document carries a `type` attribute at all, so an implementation
    // reading one would produce 66 empty cells and this test would not notice. It notices because
    // the next assertion pins where the value comes from.
    const firstAsset = read.root.children.find((child) => child.name === "Assets")?.children[0];
    expect(firstAsset?.name).toBe("CuttingTool");
    expect(firstAsset?.attributes.type).toBeUndefined();
    expect(rows[0].assetId).toBe("123456.2207");
    expect(rows[0].deviceUuid).toBe("OKUMA.123456");
    expect(rows[0].removed).toBe(false);
  });

  test("the asset fixture discriminates: ids, devices and timestamps all vary", () => {
    const read = readMtconnectXml(bytes("assets.xml"));
    if (!read.ok) throw new Error(read.reason);
    const rows = rowsFromAssets(read.root);
    expect(new Set(rows.map((row) => row.assetId)).size).toBe(66);
    expect(new Set(rows.map((row) => row.deviceUuid))).toEqual(new Set(["OKUMA.123456", "Mazak"]));
    expect(new Set(rows.map((row) => row.timestamp)).size).toBe(66);
    // The type's own attributes travel in their own field rather than being flattened away.
    expect(rows[0].attributes.toolId).toBeTruthy();
    expect(rows[0].attributes.serialNumber).toBeTruthy();
    expect(rows[0].attributes.assetId).toBeUndefined();
  });

  test("the document is kept for the Source tab, with its children", () => {
    const read = readMtconnectXml(bytes("assets.xml"));
    if (!read.ok) throw new Error(read.reason);
    const rows = rowsFromAssets(read.root);
    expect(rows[0].document.name).toBe("CuttingTool");
    expect(rows[0].document.children.length).toBeGreaterThan(0);
  });
});

describe("the row builders go red when broken", () => {
  test("reading the asset type from an attribute yields nothing, and the fixture shows it", () => {
    const read = readMtconnectXml(bytes("assets.xml"));
    if (!read.ok) throw new Error(read.reason);
    const assets = read.root.children.find((child) => child.name === "Assets")?.children ?? [];
    const broken = assets.map((asset) => asset.attributes.type ?? "");
    expect(broken.every((type) => type === "")).toBe(true);
    // Against the real implementation, which reads the element name.
    expect(rowsFromAssets(read.root).every((row) => row.type === "CuttingTool")).toBe(true);
  });

  test("dropping the device filter returns every device's rows, which the subset test catches", () => {
    const unfiltered = rowsFromModel(model());
    const filtered = rowsFromModel(model(), "Mazak");
    expect(unfiltered).toHaveLength(244);
    expect(filtered).toHaveLength(120);
    expect(unfiltered).not.toHaveLength(filtered.length);
  });
});

/**
 * The branch the captured page cannot reach, and the measurement that says so.
 *
 * `sortRows` compares two sequence numbers by LENGTH first and only then by text, because a
 * sequence is an unsigned decimal and plain text order puts "100000000" before "99999999". The
 * suite above sorts a real 200 row page, and MEASURED on that page every sequence is eight digits
 * long: the length branch is never taken, so a `sortRows` rewritten to compare the two strings
 * directly would pass every assertion above. The first test here measures that premise rather than
 * asserting it, and the second takes the branch.
 */
describe("sorting across a digit boundary", () => {
  const row = (timestamp: string, sequence: string): MtcRow => ({
    device: "Mazak",
    dataItemId: `item-${sequence}`,
    name: `item-${sequence}`,
    category: "SAMPLE",
    type: "POSITION",
    value: "1",
    timestamp,
    sequence,
    unknownToModel: false,
  });

  test("the captured page cannot catch a length mistake, which is why the next test exists", () => {
    const lengths = new Set(rows("sample-count-200.xml").map((built) => built.sequence.length));
    expect([...lengths]).toEqual([8]);
  });

  test("a sequence of nine digits sorts after one of eight, not before it", () => {
    const stamp = "2026-10-05T13:27:22.835705Z";
    const sorted = sortRows([row(stamp, "100000000"), row(stamp, "99999999")]);
    expect(sorted.map((built) => built.sequence)).toEqual(["99999999", "100000000"]);
    // And the comparison a text sort would have made, shown failing, so the test cannot be read as
    // agreeing with either implementation.
    expect(["100000000", "99999999"].sort()).toEqual(["100000000", "99999999"]);
  });

  test("the same two in the other order, so the sort is not reading the input order", () => {
    const stamp = "2026-10-05T13:27:22.835705Z";
    const sorted = sortRows([row(stamp, "99999999"), row(stamp, "100000000")]);
    expect(sorted.map((built) => built.sequence)).toEqual(["99999999", "100000000"]);
  });

  test("a later timestamp wins over a lower sequence, which is the outer comparison", () => {
    const sorted = sortRows([row("2026-10-05T13:27:23.000000Z", "1"), row("2026-10-05T13:27:22.000000Z", "100000000")]);
    expect(sorted.map((built) => built.timestamp)).toEqual([
      "2026-10-05T13:27:22.000000Z",
      "2026-10-05T13:27:23.000000Z",
    ]);
  });
});

describe("a DataSet entry the captures do not hold", () => {
  /**
   * CONSTRUCTED, and said so: no capture in `tests/fixtures/mtconnect/` holds either shape. The
   * pinned agent's demo publishes DataSets (`VariableDataSet`, `AssetCountDataSet`, whose plain
   * `<Entry key=...>text</Entry>` IS covered by `current.xml`) but it publishes no entry marked
   * removed and no TABLE representation at all: measured, `<Cell` appears in zero of the twenty-two
   * captures. So the input here is an `MtcObservation` built by hand rather than a document claimed
   * to have come off an agent, which is the honest way round: the type is this module's own, and
   * the two shapes are the ones MTConnect Part 3 defines for a removed entry and for a table cell.
   *
   * The alternative is to teach `docker/mtconnect-init/adapter.py` to emit both and re-capture,
   * which would make these real answers. It also re-dates every capture, so it is a change to
   * propose rather than to slip in beside a coverage fix.
   */
  const observation = (children: readonly MtcElement[]) => ({
    element: "VariableDataSet",
    attributes: { dataItemId: "Lp1CommonVariable", timestamp: "2026-10-05T13:27:22.837012Z", sequence: "104" },
    text: "",
    children,
  });
  const entry = (attributes: Record<string, string>, text = "", children: readonly MtcElement[] = []) => ({
    name: "Entry",
    attributes,
    children,
    text,
  });

  test("an entry marked removed reads as null rather than as an empty value", () => {
    const row = buildRow(observation([entry({ key: "100", removed: "true" }), entry({ key: "101" }, "7")]), model());
    // null, not "": the agent is saying the key is gone, which is not the same as holding no text.
    expect(JSON.parse(row?.value ?? "{}")).toEqual({ "100": null, "101": "7" });
  });

  test("an entry holding cells reads as a row of its cells, keyed by cell", () => {
    const cell = (key: string, text: string) => ({ name: "Cell", attributes: { key }, children: [], text });
    const row = buildRow(
      observation([
        {
          name: "Entry",
          attributes: { key: "T1" },
          children: [cell("LENGTH", "120"), cell("DIAMETER", "12")],
          text: "",
        },
        entry({ key: "T2" }, "plain"),
      ]),
      model(),
    );
    // A cell with no key is dropped rather than keyed by position: position is not a name.
    expect(JSON.parse(row?.value ?? "{}")).toEqual({ T1: { LENGTH: "120", DIAMETER: "12" }, T2: "plain" });
  });

  test("a cell with no key of its own is left out", () => {
    const row = buildRow(
      observation([
        {
          name: "Entry",
          attributes: { key: "T1" },
          children: [
            { name: "Cell", attributes: { key: "LENGTH" }, children: [], text: "120" },
            { name: "Cell", attributes: {}, children: [], text: "orphan" },
          ],
          text: "",
        },
      ]),
      model(),
    );
    expect(JSON.parse(row?.value ?? "{}")).toEqual({ T1: { LENGTH: "120" } });
  });
});
