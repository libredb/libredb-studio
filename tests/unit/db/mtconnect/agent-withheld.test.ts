/**
 * What an agent-mode handle withholds, decided from the agent's own model and stream rather than from a name list, and
 * how an asset document is rendered as text. Over the Institute's demo capture (`tests/fixtures/mtconnect/2.8.0.3/`),
 * whose Agent device reads two adapters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderXmlElement } from "@/lib/db/providers/industrial/mtconnect/agent-read";
import {
  itemWithheld,
  observationWithheld,
  withheldWarning,
} from "@/lib/db/providers/industrial/mtconnect/agent-withheld";
import { indexMtconnectModel, type MtcModel } from "@/lib/db/providers/industrial/mtconnect/model";
import { readMtconnectXml, type MtcElement, type MtcObservation } from "@/lib/db/providers/industrial/mtconnect/xml";

const DEMO = path.resolve(import.meta.dir, "..", "..", "..", "fixtures", "mtconnect", "2.8.0.3");

function demoModel(): MtcModel {
  const read = readMtconnectXml(new Uint8Array(readFileSync(path.join(DEMO, "probe.xml"))));
  if (!read.ok) throw new Error(read.reason);
  const model = indexMtconnectModel(read.root);
  if (model === undefined) throw new Error("not a model");
  return model;
}

const observation = (componentType: string | undefined): MtcObservation => ({
  element: "AdapterURI",
  attributes: { dataItemId: "unknown_to_the_model" },
  text: "shdr://plant-adapter:7878",
  componentType,
  children: [],
});

describe("the adapter connections, read from the agent's own model", () => {
  test("every item inside an Adapter component is withheld, and only those", () => {
    const items = [...demoModel().items.values()];
    const withheld = items.filter(itemWithheld);
    // MEASURED on the demo: two adapters, okuma:7878 and mazak:7878, each with its own items.
    expect(withheld.length).toBeGreaterThan(0);
    for (const item of withheld) {
      expect(item.deviceName).toBe("Agent");
      expect(item.componentType).toBe("Adapter");
      expect(item.dataItemId).toMatch(/^_(okuma|mazak)_7878_/);
    }
    const kept = items.filter((item) => !itemWithheld(item));
    for (const item of kept) expect(item.dataItemId).not.toMatch(/_7878/);
    expect(kept.some((item) => item.deviceName === "Agent")).toBe(true);
  });

  test("an observation is withheld by its own component stream, even one the model does not know", () => {
    expect(observationWithheld(observation("Adapter"), undefined)).toBe(true);
    expect(observationWithheld(observation("Adapters"), undefined)).toBe(true);
    expect(observationWithheld(observation("Linear"), undefined)).toBe(false);
    expect(observationWithheld(observation(undefined), undefined)).toBe(false);
    const adapterItem = [...demoModel().items.values()].find(itemWithheld);
    expect(observationWithheld(observation("Linear"), adapterItem)).toBe(true);
  });

  test("the warning counts what was withheld, in the singular and the plural", () => {
    expect(withheldWarning(1, "observation")).toStartWith(
      "1 observation of the agent's adapter connections was withheld from this answer.",
    );
    expect(withheldWarning(4, "data item")).toStartWith(
      "4 data items of the agent's adapter connections were withheld from this answer.",
    );
  });
});

describe("an asset's document rendered as text", () => {
  const element = (name: string, attributes: Record<string, string>, text: string, children: MtcElement[] = []) => ({
    name,
    attributes,
    text,
    children,
  });

  test("an empty element closes itself, and attribute values are escaped", () => {
    expect(renderXmlElement(element("Tool", { note: 'a "b" & <c>' }, ""))).toBe(
      '<Tool note="a &quot;b&quot; &amp; &lt;c&gt;"/>',
    );
  });

  test("text before children, both escaped, a prefixed name kept as written", () => {
    expect(renderXmlElement(element("x:Life", {}, "1 < 2", [element("Status", {}, "NEW & used")]))).toBe(
      "<x:Life>1 &lt; 2<Status>NEW &amp; used</Status></x:Life>",
    );
  });
});
