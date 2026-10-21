import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { engineCatalog } from "../../../src/backend/engine-catalog";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { BackendUnavailableError } from "../../../src/host/backend-supervisor";
import { PORT_REFUSAL, UNREADABLE_PASTE } from "../../../src/host/connections/add-connection-flow";
import {
  type AddConnectionDeps,
  addConnection,
  cachedCatalog,
  OPEN_USER_SETTINGS,
  SHOW_LOG,
} from "../../../src/host/connections/add-connection-ui";
import { SecretStoreError, SettingWriteError } from "../../../src/host/connections/connection-store";
import type { ProfileEntry, ProfileItem } from "../../../src/host/connections/profile";
import type {
  ConnectionParams,
  EngineCatalog,
  ParseParams,
  PastedConnection,
  TestConnectionResult,
} from "../../../src/protocol";
import { PG, wirePg } from "../../fakes/profiles";
import type { ScriptedQuickPick } from "../../fakes/quick-input";
import {
  answerMessages,
  QuickInputButtons,
  QuickPickItemKind,
  quickInputs as inputs,
  shownMessages,
  ThemeIcon,
  window,
  workspace,
} from "../../fakes/vscode";
import { TEST_PASSWORD } from "../../fakes/credentials";

const CATALOG: EngineCatalog = engineCatalog(["postgres", "mssql", "mysql", "mongodb"]);
const NOW = new Date("2026-10-20T10:14:03.512Z");
const PASS: TestConnectionResult = { success: true, message: "Connection successful", latency: 12 };
const FAILED = 'password authentication failed for user "app"';
const GEAR = { iconPath: new ThemeIcon("settings-gear"), tooltip: "SSL and optional fields" };

/** Lets every promise the adapter is waiting on settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Calls that wait for the test's answers, in order; an answer given before its call waits for that call. */
class Answers<T extends object> {
  private readonly calls: PromiseWithResolvers<T>[] = [];
  private readonly early: (T | Error)[] = [];

  call(): Promise<T> {
    const call = Promise.withResolvers<T>();
    const early = this.early.shift();
    if (early === undefined) this.calls.push(call);
    else settle(call, early);
    return call.promise;
  }

  give(answer: T | Error): void {
    const call = this.calls.shift();
    if (call === undefined) this.early.push(answer);
    else settle(call, answer);
  }
}

function settle<T>(call: PromiseWithResolvers<T>, answer: T | Error): void {
  if (answer instanceof Error) call.reject(answer);
  else call.resolve(answer);
}

/** The backend's two flow methods: each call records its params and waits until the test answers it. */
class FakeClient implements Pick<AddConnectionDeps["client"], "parsePastedConnection" | "testConnection"> {
  readonly parses: ParseParams[] = [];
  readonly tests: { readonly params: ConnectionParams; readonly token: unknown }[] = [];
  private readonly parseAnswers = new Answers<PastedConnection>();
  private readonly testAnswers = new Answers<TestConnectionResult>();

  parsePastedConnection(params: ParseParams): Promise<PastedConnection> {
    this.parses.push(params);
    return this.parseAnswers.call();
  }

  testConnection(params: ConnectionParams, token?: unknown): Promise<TestConnectionResult> {
    this.tests.push({ params, token });
    return this.testAnswers.call();
  }

  /** Answers the oldest parse, now or once it is asked. */
  parsed(answer: PastedConnection): void {
    this.parseAnswers.give(answer);
  }

  /** Settles the oldest test, now or once it is asked. */
  tested(answer: TestConnectionResult | Error): void {
    this.testAnswers.give(answer);
  }
}

/** The store's list and a recording add, which rejects with failure once set. */
class FakeStore implements Pick<AddConnectionDeps["store"], "list" | "add"> {
  readonly added: [ProfileEntry, Readonly<Record<string, string>>][] = [];
  failure: Error | undefined;

  constructor(private readonly items: ProfileItem[] = []) {}

  list(): readonly ProfileItem[] {
    return this.items;
  }

  async add(entry: ProfileEntry, secrets: Readonly<Record<string, string>>): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.added.push([entry, secrets]);
  }
}

function setup(more: { items?: ProfileItem[]; ids?: string[]; catalog?: () => Promise<EngineCatalog> } = {}) {
  const client = new FakeClient();
  const store = new FakeStore(more.items);
  const ids = [...(more.ids ?? ["1kq2v7x93j0ab"])];
  const ran = { showLog: 0, openUserSettings: 0, revealed: [] as [string, number][] };
  const deps: AddConnectionDeps = {
    client,
    catalog: more.catalog ?? (async () => CATALOG),
    store,
    window,
    workspace,
    showLog: async () => {
      ran.showLog += 1;
    },
    openUserSettings: async () => {
      ran.openUserSettings += 1;
    },
    newId: () => ids.shift() ?? "spare",
    now: () => NOW,
    // Records the id with how many saves the store had finished when the flow revealed it.
    reveal: async (connectionId) => {
      ran.revealed.push([connectionId, store.added.length]);
    },
  };
  return { deps, client, store, ran };
}

/** Walks PostgreSQL by details from the engine pick, once the catalogue is in, to the busy test pick. */
async function toTest(values = ["localhost", "5432", "app", TEST_PASSWORD, "shop"]) {
  await inputs.nextPick();
  await tick();
  inputs.choose("PostgreSQL");
  await inputs.nextPick();
  inputs.choose("Enter connection details");
  for (const value of values) {
    await inputs.nextBox();
    inputs.accept(value);
  }
  return await inputs.nextPick();
}

/** Every item of a pick, by label, separators marked. */
const labels = (pick: ScriptedQuickPick<vscode.QuickPickItem>) =>
  pick.items.map((item) => (item.kind === QuickPickItemKind.Separator ? `--- ${item.label}` : item.label));

describe("addConnection", () => {
  it("walks PostgreSQL through the real flow to a save, rendering each step (criterion 4)", async () => {
    const catalogue = Promise.withResolvers<EngineCatalog>();
    const { deps, client, store } = setup({ catalog: () => catalogue.promise });
    const running = addConnection(deps);
    const engines = await inputs.nextPick();
    assert.deepEqual([engines.title, engines.busy, engines.items.length], ["Add Connection", true, 0]);
    catalogue.resolve(CATALOG);
    await tick();
    assert.deepEqual(labels(engines), ["PostgreSQL", "MySQL", "SQL Server", "MongoDB"]);
    assert.deepEqual([engines.busy, engines.step, engines.totalSteps], [false, 1, undefined]);
    assert.equal(engines.placeholder, "Choose a database engine");
    assert.deepEqual(engines.buttons, []);
    inputs.choose("PostgreSQL");
    const method = await inputs.nextPick();
    assert.deepEqual([method.title, method.step, method.totalSteps], ["Add PostgreSQL Connection", 2, 9]);
    assert.equal(engines.disposed, true);
    inputs.choose("Enter connection details");
    const boxes = [];
    for (const value of ["localhost", "5432", "app", TEST_PASSWORD, "shop"]) {
      const box = await inputs.nextBox();
      boxes.push(box);
      inputs.accept(value);
    }
    assert.deepEqual(
      boxes.map((box) => [box.title, box.step, box.password]),
      [
        ["Add PostgreSQL Connection: Host", 3, false],
        ["Add PostgreSQL Connection: Port", 4, false],
        ["Add PostgreSQL Connection: User", 5, false],
        ["Add PostgreSQL Connection: Password", 6, true],
        ["Add PostgreSQL Connection: Database", 7, false],
      ],
    );
    assert.equal(boxes[0].value, "localhost");
    const test = await inputs.nextPick();
    assert.deepEqual(
      [test.title, test.busy, test.enabled, test.placeholder, test.buttons],
      ["Add PostgreSQL Connection", true, false, "Testing PostgreSQL connection", []],
    );
    assert.deepEqual(client.tests[0].params, { connection: wirePg, posture: { allowExternalFileAccess: true } });
    assert.ok(client.tests[0].token);
    client.tested(PASS);
    const name = await inputs.nextBox();
    assert.deepEqual([name.value, name.prompt], ["shop", "Connected in 12 ms. Name this connection."]);
    inputs.accept("shop");
    assert.equal(await running, "1kq2v7x93j0ab");
    assert.deepEqual(store.added, [[PG, { password: TEST_PASSWORD }]]);
    for (const input of [method, ...boxes, name]) assert.deepEqual(input.buttons, [QuickInputButtons.Back, GEAR]);
    assert.equal(
      inputs.shown.every((input) => input.ignoreFocusOut),
      true,
    );
    assert.equal(
      inputs.shown.every((input) => input.disposed),
      true,
    );
  });

  it("reveals the saved connection once, after the store has saved it (part 2 criterion 14)", async () => {
    const { deps, client, ran } = setup();
    const running = addConnection(deps);
    await toTest();
    client.tested(PASS);
    await inputs.nextBox();
    inputs.accept("shop");
    assert.equal(await running, "1kq2v7x93j0ab");
    assert.deepEqual(ran.revealed, [["1kq2v7x93j0ab", 1]]);
  });

  it("reveals nothing when the flow ends at the engine step", async () => {
    const { deps, ran } = setup();
    const running = addConnection(deps);
    await inputs.nextPick();
    await tick();
    inputs.escape();
    assert.equal(await running, undefined);
    assert.deepEqual(ran.revealed, []);
  });

  it("mints the id again while it equals a listed one", async () => {
    const { deps, client } = setup({
      items: [
        { kind: "valid", entry: { ...PG, id: "taken" } },
        { kind: "invalid", reason: "R", id: "bad1" },
      ],
      ids: ["taken", "bad1", "fresh"],
    });
    const running = addConnection(deps);
    await toTest();
    assert.equal(client.tests[0].params.connection.id, "fresh");
    inputs.escape();
    assert.equal(await running, undefined);
  });

  it("suggests a name unique among the listed names, invalid items' included", async () => {
    const { deps, client } = setup({ items: [{ kind: "invalid", reason: "R", id: "bad1", name: "shop" }] });
    const running = addConnection(deps);
    await toTest();
    client.tested(PASS);
    assert.equal((await inputs.nextBox()).value, "shop (2)");
    inputs.escape();
    assert.equal(await running, undefined);
  });

  describe("Escape", () => {
    it("at the method pick ends the flow with no test and nothing saved", async () => {
      const { deps, client, store } = setup();
      const running = addConnection(deps);
      await inputs.nextPick();
      await tick();
      inputs.choose("PostgreSQL");
      await inputs.nextPick();
      inputs.escape();
      assert.equal(await running, undefined);
      assert.deepEqual([client.tests, store.added], [[], []]);
    });

    it("during the test cancels the token connection/test got, and saves nothing", async () => {
      const { deps, client, store } = setup();
      const running = addConnection(deps);
      const test = await toTest();
      const token = client.tests[0].token as vscode.CancellationToken;
      assert.equal(token.isCancellationRequested, false);
      inputs.escape();
      assert.equal(token.isCancellationRequested, true);
      client.tested(new BackendError(499, "QUERY_CANCELLED", "The request was cancelled."));
      assert.equal(await running, undefined);
      assert.deepEqual([store.added, shownMessages, test.disposed], [[], [], true]);
    });

    it("while the catalogue loads ends the flow at once, with no engine step", async () => {
      const catalogue = Promise.withResolvers<EngineCatalog>();
      const { deps } = setup({ catalog: () => catalogue.promise });
      const running = addConnection(deps);
      const engines = await inputs.nextPick();
      inputs.escape();
      assert.equal(await running, undefined);
      catalogue.resolve(CATALOG);
      await tick();
      assert.deepEqual([engines.items, inputs.shown.length], [[], 1]);
    });

    it("while the child reads a paste ends the flow at once", async () => {
      const { deps, client } = setup();
      const running = addConnection(deps);
      await inputs.nextPick();
      await tick();
      inputs.choose("PostgreSQL");
      await inputs.nextPick();
      inputs.choose("Paste a connection string");
      await inputs.nextBox();
      inputs.accept("postgres://db.example/shop");
      await tick();
      assert.equal(client.parses.length, 1);
      inputs.escape();
      assert.equal(await running, undefined);
      client.parsed({ parsed: { type: "postgres", host: "db.example", database: "shop" }, label: "PostgreSQL" });
      await tick();
      assert.deepEqual([client.tests, inputs.shown.length], [[], 3]);
    });

    it("right after an answer ends the flow before its next step", async () => {
      const { deps, client } = setup();
      const running = addConnection(deps);
      await inputs.nextPick();
      await tick();
      inputs.choose("PostgreSQL");
      await inputs.nextPick();
      inputs.choose("Paste a connection string");
      await inputs.nextBox();
      inputs.accept("postgres://db.example/shop");
      inputs.escape();
      assert.equal(await running, undefined);
      assert.deepEqual(client.parses, []);
    });
  });

  it("checks a value as it is typed, and an accept the check refuses stays on the box", async () => {
    const { deps } = setup();
    const running = addConnection(deps);
    await inputs.nextPick();
    await tick();
    inputs.choose("PostgreSQL");
    await inputs.nextPick();
    inputs.choose("Enter connection details");
    await inputs.nextBox();
    inputs.accept("localhost");
    const port = await inputs.nextBox();
    inputs.type("54x2");
    assert.equal(port.validationMessage, PORT_REFUSAL);
    inputs.accept("54x2");
    await tick();
    assert.equal(inputs.current, port);
    assert.equal(inputs.shown.length, 4);
    inputs.type("5432");
    assert.equal(port.validationMessage, undefined);
    inputs.escape();
    assert.equal(await running, undefined);
  });

  it("goes Back with the Back button, and to Review with the More Options button", async () => {
    const { deps } = setup();
    const running = addConnection(deps);
    await inputs.nextPick();
    await tick();
    inputs.choose("PostgreSQL");
    await inputs.nextPick();
    inputs.choose("Enter connection details");
    await inputs.nextBox();
    inputs.accept("db.internal");
    await inputs.nextBox();
    inputs.back();
    const host = await inputs.nextBox();
    assert.deepEqual([host.title, host.value], ["Add PostgreSQL Connection: Host", "db.internal"]);
    inputs.press(host.buttons[1]);
    const review = await inputs.nextPick();
    assert.equal(review.title, "Add PostgreSQL Connection: Review");
    assert.deepEqual(labels(review).slice(0, 3), ["Test and Continue", "--- ", "Host"]);
    assert.deepEqual(review.buttons, [QuickInputButtons.Back]);
    inputs.escape();
    assert.equal(await running, undefined);
  });

  it("keeps the paste box busy while the child reads it, and shows its refusal on a new box", async () => {
    const { deps, client } = setup();
    const running = addConnection(deps);
    await inputs.nextPick();
    await tick();
    inputs.choose("PostgreSQL");
    await inputs.nextPick();
    inputs.choose("Paste a connection string");
    const paste = await inputs.nextBox();
    assert.deepEqual([paste.password, paste.busy], [true, false]);
    inputs.accept("nonsense");
    await tick();
    assert.equal(paste.busy, true);
    assert.deepEqual(client.parses, [{ text: "nonsense" }]);
    client.parsed({ parsed: null, label: null });
    const again = await inputs.nextBox();
    assert.deepEqual([again.value, again.validationMessage, again.busy], ["nonsense", UNREADABLE_PASTE, false]);
    inputs.accept("postgres://app@db.example/shop");
    client.parsed({
      parsed: { type: "postgres", host: "db.example", user: "app", database: "shop" },
      label: "PostgreSQL",
    });
    const test = await inputs.nextPick();
    assert.equal(test.placeholder, "Testing PostgreSQL connection");
    assert.equal(client.tests[0].params.connection.host, "db.example");
    inputs.escape();
    client.tested(PASS);
    assert.equal(await running, undefined);
  });

  describe("the test dialogs (criteria 11 and 12)", () => {
    it("shows a BackendError in a modal error with its fix statement, and Test Again tests again", async () => {
      const { deps, client } = setup();
      answerMessages(() => "Test Again");
      const running = addConnection(deps);
      await toTest();
      client.tested(new BackendError(401, "AUTH_ERROR", FAILED, { fixStatement: "ALTER ROLE app LOGIN;" }));
      const again = await inputs.nextPick();
      assert.deepEqual(shownMessages, [
        {
          level: "error",
          message: FAILED,
          options: { modal: true, detail: "ALTER ROLE app LOGIN;" },
          items: ["Test Again", "Back to Review"],
        },
      ]);
      assert.equal(again.placeholder, "Testing PostgreSQL connection");
      assert.equal(client.tests.length, 2);
      inputs.escape();
      client.tested(PASS);
      assert.equal(await running, undefined);
    });

    it("shows a stopped backend in the same dialog, and Back to Review shows Review", async () => {
      const { deps, client } = setup();
      answerMessages(() => "Back to Review");
      const running = addConnection(deps);
      const test = await toTest();
      client.tested(new BackendExitedError({ exitCode: null, signal: "SIGKILL" }));
      const review = await inputs.nextPick();
      assert.equal(test.disposed, true);
      assert.deepEqual(shownMessages, [
        {
          level: "error",
          message: "The LibreDB backend stopped (exit code none, signal SIGKILL).",
          options: { modal: true },
          items: ["Test Again", "Back to Review"],
        },
      ]);
      assert.equal(review.title, "Add PostgreSQL Connection: Review");
      inputs.escape();
      assert.equal(await running, undefined);
    });

    it("shows a pass with warnings in a modal warning, and Save Anyway names it", async () => {
      const { deps, client, store } = setup();
      answerMessages(() => "Save Anyway");
      const running = addConnection(deps);
      await toTest();
      client.tested({ ...PASS, warnings: [{ message: "a" }, { message: "b" }] });
      const name = await inputs.nextBox();
      assert.deepEqual(shownMessages, [
        {
          level: "warning",
          message: "Connection successful",
          options: { modal: true, detail: "a\nb" },
          items: ["Save Anyway", "Back to Review"],
        },
      ]);
      assert.equal(name.prompt, "Connected in 12 ms. Name this connection.");
      inputs.accept("shop");
      assert.equal(await running, "1kq2v7x93j0ab");
      assert.equal(store.added.length, 1);
    });

    it("ends the flow and shows nothing more when the backend is unavailable at the test", async () => {
      const { deps, client } = setup();
      const running = addConnection(deps);
      const test = await toTest();
      client.tested(
        new BackendUnavailableError("The LibreDB backend stopped 4 times in a row and was not restarted.", "failed"),
      );
      assert.equal(await running, undefined);
      assert.deepEqual([shownMessages, test.disposed], [[], true]);
    });

    it("rejects with any other error of the test, and closes the quick input", async () => {
      const { deps, client } = setup();
      const running = addConnection(deps);
      const test = await toTest();
      client.tested(new TypeError("bug"));
      await assert.rejects(running, { name: "TypeError", message: "bug" });
      assert.equal(test.disposed, true);
    });
  });

  describe("the catalogue", () => {
    it("closes the pick and shows nothing more when the backend is unavailable (builder's call 11)", async () => {
      const { deps } = setup({
        catalog: () => Promise.reject(new BackendUnavailableError("The LibreDB backend is stopping.", "stopping")),
      });
      const running = addConnection(deps);
      const engines = await inputs.nextPick();
      assert.equal(await running, undefined);
      assert.deepEqual([engines.visible, engines.disposed, shownMessages], [false, true, []]);
    });

    it("closes the pick and shows any other failure with Show Log", async () => {
      const { deps, ran } = setup({
        catalog: () => Promise.reject(new BackendError(500, "INTERNAL_ERROR", "boom")),
      });
      answerMessages(() => SHOW_LOG);
      const running = addConnection(deps);
      const engines = await inputs.nextPick();
      assert.equal(await running, undefined);
      await tick();
      assert.equal(engines.disposed, true);
      assert.deepEqual(shownMessages, [
        { level: "error", message: "LibreDB could not list the database engines: boom", items: ["Show Log"] },
      ]);
      assert.equal(ran.showLog, 1);
    });

    it("runs nothing when the failure is dismissed", async () => {
      const { deps, ran } = setup({ catalog: () => Promise.reject(new BackendError(500, "INTERNAL_ERROR", "boom")) });
      assert.equal(await addConnection(deps), undefined);
      await tick();
      assert.equal(ran.showLog, 0);
    });
  });

  describe("the save", () => {
    async function saveFailing(failure: Error) {
      const { deps, client, store, ran } = setup();
      store.failure = failure;
      const running = addConnection(deps);
      await toTest();
      client.tested(PASS);
      const name = await inputs.nextBox();
      inputs.accept("shop");
      return { running, ran, name };
    }

    it("shows a secret storage failure alone, and saves and reveals nothing", async () => {
      const { running, name, ran } = await saveFailing(new SecretStoreError("S"));
      assert.equal(await running, undefined);
      assert.deepEqual(ran.revealed, []);
      await tick();
      assert.deepEqual(shownMessages, [{ level: "error", message: "S", items: [] }]);
      assert.equal(name.disposed, true);
    });

    it("shows a setting write failure with Open User Settings, which opens them", async () => {
      answerMessages(() => OPEN_USER_SETTINGS);
      const { running, ran } = await saveFailing(new SettingWriteError("W"));
      assert.equal(await running, undefined);
      await tick();
      assert.deepEqual(shownMessages, [{ level: "error", message: "W", items: ["Open User Settings"] }]);
      assert.equal(ran.openUserSettings, 1);
    });

    it("opens nothing when the setting failure is dismissed", async () => {
      const { running, ran } = await saveFailing(new SettingWriteError("W"));
      assert.equal(await running, undefined);
      await tick();
      assert.equal(ran.openUserSettings, 0);
    });

    it("rejects with any other failure", async () => {
      const { running } = await saveFailing(new Error("A connection with id 1kq2v7x93j0ab is already saved."));
      await assert.rejects(running, { message: "A connection with id 1kq2v7x93j0ab is already saved." });
    });
  });

  it("tests with no external file access in Restricted Mode", async () => {
    workspace.isTrusted = false;
    const { deps, client } = setup();
    const running = addConnection(deps);
    await toTest();
    assert.deepEqual(client.tests[0].params.posture, { allowExternalFileAccess: false });
    inputs.escape();
    assert.equal(await running, undefined);
  });
});

describe("cachedCatalog", () => {
  it("loads once, and loads again after a failed load", async () => {
    let loads = 0;
    const failing = cachedCatalog(async () => {
      loads += 1;
      if (loads === 1) throw new Error("down");
      return CATALOG;
    });
    await assert.rejects(failing(), { message: "down" });
    assert.equal(await failing(), CATALOG);
    assert.equal(await failing(), CATALOG);
    assert.equal(loads, 2);
  });
});
