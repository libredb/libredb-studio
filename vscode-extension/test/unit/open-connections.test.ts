import assert from "node:assert/strict";
import { isConnected, OpenConnections } from "../../src/host/open-connections";
import type { ProviderDescription } from "../../src/protocol";

const D1 = { capabilities: { supportsQueryCancel: true }, labels: {} } as unknown as ProviderDescription;
const D2 = { capabilities: { supportsQueryCancel: false }, labels: {} } as unknown as ProviderDescription;

/** A fresh OpenConnections and the ids its onDidChange fired, in order. */
function setup() {
  const opened = new OpenConnections();
  const fired: string[] = [];
  opened.onDidChange((id) => fired.push(id));
  return { opened, fired };
}

describe("OpenConnections", () => {
  it("records a connection's description at its generation and fires its id", () => {
    const { opened, fired } = setup();
    opened.record("c1", 1, D1);
    assert.deepEqual(opened.get("c1"), { description: D1, generation: 1 });
    assert.deepEqual(fired, ["c1"]);
  });

  it("replaces the record on every open, a reopen in a new generation included", () => {
    const { opened, fired } = setup();
    opened.record("c1", 1, D1);
    opened.record("c1", 2, D2);
    assert.deepEqual(opened.get("c1"), { description: D2, generation: 2 });
    assert.deepEqual(fired, ["c1", "c1"]);
  });

  it("forgets a recorded id and fires it, and fires nothing for an id it does not hold", () => {
    const { opened, fired } = setup();
    opened.record("c1", 1, D1);
    opened.forget("c1");
    assert.equal(opened.get("c1"), undefined);
    opened.forget("c2");
    assert.deepEqual(fired, ["c1", "c1"]);
  });

  it("fires nothing once disposed", () => {
    const { opened, fired } = setup();
    opened.dispose();
    opened.record("c1", 1, D1);
    opened.forget("c1");
    assert.deepEqual(fired, []);
  });
});

describe("isConnected", () => {
  const opened = { description: D1, generation: 2 };

  it("holds when the last open was answered in the link's current generation and the link is ready", () => {
    assert.equal(isConnected(opened, { generation: 2, state: "ready" }), true);
  });

  it("does not hold in another generation, with the link not ready, or with no open recorded", () => {
    assert.equal(isConnected(opened, { generation: 3, state: "ready" }), false);
    assert.equal(isConnected(opened, { generation: 2, state: "restarting" }), false);
    assert.equal(isConnected(undefined, { generation: 2, state: "ready" }), false);
  });
});
