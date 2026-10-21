import assert from "node:assert/strict";
import { type ConnectionsChange, SettingWriteError } from "../../../src/host/connections/connection-store";
import type { ProfileEntry, ProfileItem } from "../../../src/host/connections/profile";
import {
  type ConnectionRelease,
  describeEntry,
  REMOVE,
  REMOVE_DETAIL,
  type RemoveDeps,
  releaseOnChange,
  removeConnection,
} from "../../../src/host/connections/remove-connection";
import { MONGO, PG } from "../../fakes/profiles";
import {
  answerMessages,
  answerQuickPicks,
  EventEmitter,
  outputChannels,
  shownMessages,
  shownQuickPicks,
  window,
} from "../../fakes/vscode";

const ITEMS: ProfileItem[] = [
  { kind: "valid", entry: PG },
  { kind: "valid", entry: MONGO },
  { kind: "invalid", reason: "R", id: "bad1", name: "bad" },
  { kind: "invalid", reason: "S" },
];

/** Lets every promise the command left running settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Call = [string, string];
type Removal = { removed: boolean; undeletedKeys: readonly string[] };

function setup(more: { removal?: Removal | Error; closing?: Error } = {}) {
  const calls: Call[] = [];
  const store = {
    list: (): readonly ProfileItem[] => ITEMS,
    async remove(id: string): Promise<Removal> {
      calls.push(["remove", id]);
      const removal = more.removal ?? { removed: true, undeletedKeys: [] };
      if (removal instanceof Error) throw removal;
      return removal;
    },
  };
  const client: ConnectionRelease = {
    cancelRuns(id) {
      calls.push(["cancelRuns", id]);
    },
    async closeIfOpen(id) {
      calls.push(["closeIfOpen", id]);
      if (more.closing !== undefined) throw more.closing;
    },
  };
  const log = window.createOutputChannel("LibreDB", { log: true });
  const ran = { openUserSettings: 0 };
  const deps: RemoveDeps = {
    store,
    client,
    window,
    log,
    openUserSettings: async () => {
      ran.openUserSettings += 1;
    },
  };
  return { deps, calls, ran };
}

/** The person chooses the palette item of this label, and answers the question with answer. */
function person(label: string | undefined, answer: string | undefined): void {
  answerQuickPicks((shown) => shown.items.find((item) => item.label === label));
  answerMessages((shown) => (shown.options?.modal === true ? answer : undefined));
}

const question = (name: string) => ({
  level: "warning",
  message: `Remove the connection ${name}?`,
  options: { modal: true, detail: REMOVE_DETAIL },
  items: ["Remove"],
});

describe("describeEntry", () => {
  it("writes user@host:port/database from the fields present", () => {
    assert.equal(describeEntry(PG), "app@localhost:5432/shop");
    assert.equal(describeEntry(MONGO), "/orders");
    const bare = { id: "x", name: "x", type: "postgres", createdAt: PG.createdAt } as ProfileEntry;
    assert.equal(describeEntry({ ...bare, host: "db" }), "db");
    assert.equal(describeEntry({ ...bare, user: "u", host: "h" }), "u@h");
    assert.equal(describeEntry({ ...bare, user: "", host: "h", database: "" }), "h");
    assert.equal(describeEntry(bare), "");
  });
});

describe("removeConnection", () => {
  it("removes the connection the palette names, after the question, in part 2's order (criterion 17)", async () => {
    const { deps, calls } = setup();
    person("shop", REMOVE);
    assert.equal(await removeConnection(deps), true);
    assert.deepEqual(shownQuickPicks, [
      {
        items: [
          { label: "shop", description: "app@localhost:5432/shop" },
          { label: "orders", description: "/orders" },
          { label: "bad", description: "invalid", detail: "R" },
        ],
        options: { placeHolder: "Choose the connection to remove" },
      },
    ]);
    assert.deepEqual(shownMessages, [question("shop")]);
    assert.deepEqual(calls, [
      ["cancelRuns", PG.id],
      ["closeIfOpen", PG.id],
      ["remove", PG.id],
    ]);
    assert.equal(
      REMOVE_DETAIL,
      "Its secrets are deleted from this machine's secret storage. Editors bound to it stay open, unbound.",
    );
  });

  it("does nothing when the question is declined", async () => {
    const { deps, calls } = setup();
    person("shop", undefined);
    assert.equal(await removeConnection(deps), false);
    assert.deepEqual(calls, []);
  });

  it("asks nothing when the palette is dismissed", async () => {
    const { deps, calls } = setup();
    person(undefined, REMOVE);
    assert.equal(await removeConnection(deps), false);
    assert.deepEqual([shownMessages, calls], [[], []]);
  });

  it("takes a connection node's id without the palette", async () => {
    const { deps, calls } = setup();
    person(undefined, REMOVE);
    assert.equal(await removeConnection(deps, { connectionId: PG.id }), true);
    assert.deepEqual(shownQuickPicks, []);
    assert.deepEqual(shownMessages, [question("shop")]);
    assert.deepEqual(calls.at(-1), ["remove", PG.id]);
  });

  it("does nothing for an id that is not listed (criterion 17)", async () => {
    const { deps, calls } = setup();
    assert.equal(await removeConnection(deps, { connectionId: "missing" }), false);
    assert.deepEqual([shownQuickPicks, shownMessages, calls], [[], [], []]);
  });

  it("refuses a target that is not a connection node", async () => {
    const { deps } = setup();
    for (const target of ["x", { connectionId: 5 }, null]) {
      await assert.rejects(removeConnection(deps, target), {
        message: "libredb.removeConnection takes a connection node or nothing.",
      });
    }
  });

  it("removes an invalid entry by its id, the question naming it", async () => {
    const { deps, calls } = setup();
    person("bad", REMOVE);
    assert.equal(await removeConnection(deps), true);
    assert.deepEqual(shownMessages, [question("bad")]);
    assert.deepEqual(calls.at(-1), ["remove", "bad1"]);
  });

  it("names an invalid entry with no name by its id", async () => {
    const { deps } = setup();
    person(undefined, undefined);
    const items: ProfileItem[] = [{ kind: "invalid", reason: "R", id: "bad2" }];
    assert.equal(await removeConnection({ ...deps, store: { ...deps.store, list: () => items } }), false);
    assert.deepEqual(shownQuickPicks[0].items, [{ label: "bad2", description: "invalid", detail: "R" }]);
  });

  it("keeps the secrets and offers the user settings when the setting cannot be written", async () => {
    const { deps, ran } = setup({ removal: new SettingWriteError("W") });
    answerQuickPicks((shown) => shown.items[0]);
    answerMessages((shown) => (shown.options?.modal === true ? REMOVE : "Open User Settings"));
    assert.equal(await removeConnection(deps), false);
    await tick();
    assert.deepEqual(shownMessages.at(-1), { level: "error", message: "W", items: ["Open User Settings"] });
    assert.equal(ran.openUserSettings, 1);
  });

  it("rejects with any other failure of the store", async () => {
    const { deps } = setup({ removal: new Error("boom") });
    person("shop", REMOVE);
    await assert.rejects(removeConnection(deps), { message: "boom" });
  });

  it("answers false when another window removed the id first", async () => {
    const { deps } = setup({ removal: { removed: false, undeletedKeys: [] } });
    person("shop", REMOVE);
    assert.equal(await removeConnection(deps), false);
    assert.deepEqual(shownMessages, [question("shop")]);
  });

  it("logs each secret it could not delete, and says how many in one warning", async () => {
    const key = "connection/1kq2v7x93j0ab/password";
    const { deps } = setup({ removal: { removed: true, undeletedKeys: [key] } });
    person("shop", REMOVE);
    assert.equal(await removeConnection(deps), true);
    assert.deepEqual(outputChannels[0].lines, [
      ["warn", `Could not delete ${key} from VS Code's secret storage: it stays on this machine.`],
    ]);
    assert.deepEqual(shownMessages.at(-1), {
      level: "warning",
      message:
        "LibreDB removed shop, but could not delete 1 of its secrets from VS Code's secret storage. The LibreDB log names them.",
      items: [],
    });
  });

  it("logs a close that failed and removes the connection anyway", async () => {
    const { deps, calls } = setup({ closing: new Error("pipe closed") });
    person("shop", REMOVE);
    assert.equal(await removeConnection(deps), true);
    assert.deepEqual(outputChannels[0].lines, [
      ["warn", "Closing 1kq2v7x93j0ab before its removal failed: pipe closed"],
    ]);
    assert.deepEqual(calls.at(-1), ["remove", PG.id]);
  });
});

describe("releaseOnChange", () => {
  it("cancels the runs of and closes each removed or changed connection (criterion 19, Review Focus 4)", async () => {
    const { deps, calls } = setup();
    const changes = new EventEmitter<ConnectionsChange>();
    const release = releaseOnChange({ onDidChange: changes.event }, deps.client, deps.log);
    changes.fire({ added: ["n1"], removed: ["r1"], changed: ["c1"] });
    assert.deepEqual(calls, [
      ["cancelRuns", "r1"],
      ["closeIfOpen", "r1"],
      ["cancelRuns", "c1"],
      ["closeIfOpen", "c1"],
    ]);
    release.dispose();
    changes.fire({ added: [], removed: ["r2"], changed: [] });
    assert.equal(calls.length, 4);
  });

  it("logs a close that failed with its id and message", async () => {
    const { deps } = setup({ closing: new Error("pipe closed") });
    const changes = new EventEmitter<ConnectionsChange>();
    releaseOnChange({ onDidChange: changes.event }, deps.client, deps.log);
    changes.fire({ added: [], removed: [], changed: ["c1"] });
    await tick();
    assert.deepEqual(outputChannels[0].lines, [
      ["warn", "Closing c1 after libredb.connections changed failed: pipe closed"],
    ]);
  });
});
