import assert from "node:assert/strict";
import type { Container } from "@/lib/db/types";
import type { ProfileItem } from "../../../src/host/connections/profile";
import {
  ADD_CONNECTION,
  NO_CONNECTIONS,
  pickCatalog,
  pickConnection,
  UNBIND,
} from "../../../src/host/editor/connection-picker";
import type { ContainersParams } from "../../../src/protocol";
import { CATALOG_SESSIONS } from "../../fakes/descriptions";
import { MONGO, PG } from "../../fakes/profiles";
import { answerMessages, answerQuickPicks, shownMessages, shownQuickPicks, window } from "../../fakes/vscode";

const LABELS: Record<string, string> = { postgres: "PostgreSQL", mongodb: "MongoDB" };
const VALID: ProfileItem[] = [
  { kind: "valid", entry: PG },
  { kind: "invalid", reason: "Entry 2 of libredb.connections is not an object." },
  { kind: "valid", entry: MONGO },
];

/** pickConnection's deps over the fake window, with the label reads and Add Connection runs they caused. */
function setup(items: ProfileItem[] = VALID) {
  const labelled: string[] = [];
  let added = 0;
  const deps = {
    store: { list: () => items },
    icons: {
      label: (type: string) => {
        labelled.push(type);
        return LABELS[type];
      },
    },
    window,
    addConnection: () => {
      added += 1;
      return Promise.resolve();
    },
  };
  return { deps, labelled, added: () => added };
}

/** Lets a message's answer reach its handler. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("pickConnection", () => {
  it("lists each valid profile by name and engine label, and answers the chosen id", async () => {
    const { deps, labelled } = setup();
    answerQuickPicks((shown) => shown.items[1]);
    const chosen = await pickConnection(deps, { placeHolder: "Choose a connection for this editor" });
    assert.equal(chosen, MONGO.id);
    assert.equal(shownQuickPicks.length, 1);
    assert.deepEqual(
      shownQuickPicks[0].items.map(({ label, description }) => ({ label, description })),
      [
        { label: "shop", description: "PostgreSQL" },
        { label: "orders", description: "MongoDB" },
      ],
    );
    assert.equal(shownQuickPicks[0].options?.placeHolder, "Choose a connection for this editor");
    assert.deepEqual(labelled, ["postgres", "mongodb"]);
  });

  it("answers undefined when the pick is dismissed", async () => {
    const { deps } = setup();
    assert.equal(await pickConnection(deps, { placeHolder: "p" }), undefined);
  });

  it("describes the current profile as current", async () => {
    const { deps } = setup();
    await pickConnection(deps, { placeHolder: "p", current: PG.id });
    assert.deepEqual(
      shownQuickPicks[0].items.map(({ description }) => description),
      ["current", "MongoDB"],
    );
  });

  it("offers Unbind this editor last when asked, and answers UNBIND for it", async () => {
    const { deps } = setup();
    answerQuickPicks((shown) => shown.items.at(-1));
    const chosen = await pickConnection(deps, { placeHolder: "p", current: PG.id, offerUnbind: true });
    assert.equal(chosen, UNBIND);
    assert.equal(UNBIND, "Unbind this editor");
    const items = shownQuickPicks[0].items;
    assert.equal(items.length, 3);
    assert.deepEqual({ ...items[2] }, { label: "Unbind this editor" });
  });

  it("offers Add Connection instead of a pick when no profile is valid", async () => {
    const { deps, added } = setup([{ kind: "invalid", reason: "r" }]);
    answerMessages(() => "Add Connection");
    assert.equal(await pickConnection(deps, { placeHolder: "p" }), undefined);
    await settle();
    assert.deepEqual(shownQuickPicks, []);
    assert.deepEqual(shownMessages, [
      { level: "info", message: "Add a LibreDB connection first.", items: ["Add Connection"] },
    ]);
    assert.equal(NO_CONNECTIONS, "Add a LibreDB connection first.");
    assert.equal(ADD_CONNECTION, "Add Connection");
    assert.equal(added(), 1);
  });

  it("does not add a connection when that message is dismissed", async () => {
    const { deps, added } = setup([]);
    assert.equal(await pickConnection(deps, { placeHolder: "p" }), undefined);
    await settle();
    assert.equal(added(), 0);
  });
});

describe("pickCatalog", () => {
  const SHOP: Container = { path: ["shop"], name: "shop", level: 0 };
  const STAGE: Container = { path: ["stage"], name: "stage", level: 0 };

  /** pickCatalog's deps whose listContainers answers `answer`, with the params it was called with. */
  function catalogDeps(answer: () => Promise<Container[]>) {
    const calls: ContainersParams[] = [];
    const deps = {
      client: {
        listContainers: (params: ContainersParams) => {
          calls.push(params);
          return answer();
        },
      },
      window,
    };
    return { deps, calls };
  }

  it("lists the first level's names under its label and answers the chosen name", async () => {
    const { deps, calls } = catalogDeps(() => Promise.resolve([STAGE, SHOP]));
    answerQuickPicks((shown) => shown.items[1]);
    assert.equal(await pickCatalog(deps, "c1", CATALOG_SESSIONS), "shop");
    assert.deepEqual(calls, [{ connectionId: "c1" }]);
    assert.deepEqual(
      shownQuickPicks[0].items.map(({ label }) => label),
      ["stage", "shop"],
    );
    assert.equal(shownQuickPicks[0].options?.title, "Choose a Database");
  });

  it("answers undefined when the pick is dismissed", async () => {
    const { deps } = catalogDeps(() => Promise.resolve([SHOP]));
    assert.equal(await pickCatalog(deps, "c1", CATALOG_SESSIONS), undefined);
  });

  it("rejects with listContainers' error", async () => {
    const error = new Error("listing failed");
    const { deps } = catalogDeps(() => Promise.reject(error));
    await assert.rejects(pickCatalog(deps, "c1", CATALOG_SESSIONS), error);
    assert.deepEqual(shownQuickPicks, []);
  });
});
