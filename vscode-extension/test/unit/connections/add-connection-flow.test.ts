import assert from "node:assert/strict";
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import type { ConnectionField } from "@/lib/db/connection-fields";
import { engineCatalog } from "../../../src/backend/engine-catalog";
import {
  AddConnectionFlow,
  BACK_TO_REVIEW,
  type FlowInput,
  type FlowStep,
  MORE_OPTIONS_TOOLTIP,
  NAME_BLANK,
  nameTaken,
  notOffered,
  PORT_REFUSAL,
  pasteCautions,
  SAVE_ANYWAY,
  TEST_AGAIN,
  type TestOutcome,
  UNREADABLE_PASTE,
} from "../../../src/host/connections/add-connection-flow";
import type {
  EngineCatalog,
  EngineField,
  EngineForm,
  PastedConnection,
  TestConnectionResult,
} from "../../../src/protocol";
import { TEST_PASSWORD } from "../../fakes/credentials";

const field = (name: ConnectionField): EngineField => ({
  name,
  label: null,
  hint: null,
  placeholder: null,
  placement: "open",
});
/** An engine with no paste scheme and a field v0 never asks (part 2 Tests: "one row with a none field and no scheme"). */
const FIXTURE: EngineForm = {
  type: "db2",
  label: "Fixture DB",
  defaultHost: "fixture.local",
  defaultPort: "50000",
  pasteScheme: null,
  keepsPastedString: false,
  offersSsl: false,
  fields: (["host", "port", "user", "password", "allowInsecureAuth"] as const).map(field),
};
const CATALOG: EngineCatalog = {
  engines: [...engineCatalog(["postgres", "mssql", "mysql", "mongodb"]).engines, FIXTURE],
};
const NOW = new Date("2026-10-20T10:14:03.512Z");
const CREATED = "2026-10-20T10:14:03.512Z";
const ID = "1kq2v7x93j0ab";
const SRV = `mongodb+srv://app:${TEST_PASSWORD}@cluster0.example.net/orders`;
/** The child's reading of SRV. */
const MONGO_SRV: NonNullable<PastedConnection["parsed"]> = {
  type: "mongodb",
  connectionString: SRV,
  host: "cluster0.example.net",
  user: "app",
  password: TEST_PASSWORD,
  database: "orders",
  sslMode: "verify-system",
};
const flowOf = (savedNames: string[] = []) =>
  new AddConnectionFlow({ catalog: CATALOG, id: ID, savedNames, now: () => NOW });
const OK: FlowInput = {
  kind: "tested",
  outcome: { kind: "answered", answer: { success: true, message: "Connection successful", latency: 12 } },
};

/** Feeds the inputs in order and returns every step the flow showed, the first included. */
function walk(flow: AddConnectionFlow, inputs: FlowInput[]): FlowStep[] {
  const steps = [flow.step];
  for (const input of inputs) steps.push(flow.advance(input));
  return steps;
}
const pick = (id: string): FlowInput => ({ kind: "pick", id });
const accept = (value: string): FlowInput => ({ kind: "accept", value });
const parsed = (answer: PastedConnection): FlowInput => ({ kind: "parsed", answer });
const BACK: FlowInput = { kind: "back" };
const MORE: FlowInput = { kind: "moreOptions" };
const tested = (outcome: TestOutcome): FlowInput => ({ kind: "tested", outcome });
const choose = (choice: string | undefined): FlowInput => ({ kind: "dialog", choice });

/** The step, which must be of this kind, typed as it. */
function as<K extends FlowStep["kind"]>(step: FlowStep, kind: K): Extract<FlowStep, { kind: K }> {
  assert.equal(step.kind, kind);
  return step as Extract<FlowStep, { kind: K }>;
}

/** [kind, title, step, totalSteps] of a step that has a title. */
function heading(step: FlowStep): [string, string, number | undefined, number | undefined] {
  assert.ok("title" in step, `a ${step.kind} step has no title`);
  return [step.kind, step.title, step.step, step.totalSteps];
}

/** The part of an input's title after the engine's prefix. */
const suffix = (title: string) => title.slice(title.indexOf(": ") + 2);

/** A pick's items as [id, label, description], a separator as "---" and its label. */
function rows(step: FlowStep): (string | [string, string, string | undefined])[] {
  return as(step, "pick").items.map((item) =>
    item.separator ? `---${item.label === "" ? "" : ` ${item.label}`}` : [item.id, item.label, item.description],
  );
}

const V0: [type: string, label: string, port: string][] = [
  ["postgres", "PostgreSQL", "5432"],
  ["mysql", "MySQL", "3306"],
  ["mssql", "SQL Server", "1433"],
  ["mongodb", "MongoDB", "27017"],
];

function engineOf(type: string): EngineForm {
  const engine = CATALOG.engines.find((each) => each.type === type);
  assert.ok(engine);
  return engine;
}

describe("AddConnectionFlow", () => {
  it("walks PostgreSQL by details to a save, and shows no other step (criterion 4)", () => {
    const steps = walk(flowOf(), [
      pick("postgres"),
      pick("details"),
      accept("localhost"),
      accept("5432"),
      accept("app"),
      accept(TEST_PASSWORD),
      accept("shop"),
      OK,
      accept("shop"),
    ]);
    assert.equal(steps.length, 10);
    assert.deepEqual(steps.slice(0, 9).map(heading), [
      ["pick", "Add Connection", 1, undefined],
      ["pick", "Add PostgreSQL Connection", 2, 9],
      ["input", "Add PostgreSQL Connection: Host", 3, 9],
      ["input", "Add PostgreSQL Connection: Port", 4, 9],
      ["input", "Add PostgreSQL Connection: User", 5, 9],
      ["input", "Add PostgreSQL Connection: Password", 6, 9],
      ["input", "Add PostgreSQL Connection: Database", 7, 9],
      ["test", "Add PostgreSQL Connection", 8, 9],
      ["input", "Add PostgreSQL Connection", 9, 9],
    ]);
    const test = as(steps[7], "test");
    assert.deepEqual(test.connection, {
      id: ID,
      name: "shop",
      type: "postgres",
      createdAt: CREATED,
      host: "localhost",
      port: 5432,
      user: "app",
      password: TEST_PASSWORD,
      database: "shop",
    });
    assert.equal(test.placeholder, "Testing PostgreSQL connection");
    const name = as(steps[8], "input");
    assert.equal(name.value, "shop");
    assert.equal(name.prompt, "Connected in 12 ms. Name this connection.");
    assert.equal(name.password, false);
    assert.deepEqual(steps[9], {
      kind: "save",
      entry: {
        id: ID,
        name: "shop",
        type: "postgres",
        createdAt: CREATED,
        host: "localhost",
        port: 5432,
        user: "app",
        database: "shop",
        secretFields: ["password"],
      },
      secrets: { password: TEST_PASSWORD },
    });
  });

  it("offers the catalogue's engines in its order, with no Back and no More Options", () => {
    const engine = as(flowOf().step, "pick");
    assert.deepEqual(
      engine.items,
      CATALOG.engines.map(({ type, label }) => ({ id: type, label })),
    );
    assert.equal(engine.placeholder, "Choose a database engine");
    assert.deepEqual([engine.back, engine.moreOptions], [false, false]);
  });

  for (const [type, label, port] of V0) {
    it(`asks ${label}'s linear fields in order, with their defaults, and checks the port (criterion 5)`, () => {
      const flow = flowOf();
      flow.advance(pick(type));
      let step = flow.advance(pick("details"));
      const boxes: [string, string, boolean][] = [];
      while (step.kind === "input") {
        boxes.push([suffix(step.title), step.value, step.password]);
        assert.deepEqual([step.back, step.moreOptions], [true, true]);
        if (suffix(step.title) === "Port") {
          for (const refused of ["0", "65536", "54x2"]) assert.equal(flow.validate(refused), PORT_REFUSAL, refused);
          for (const passed of ["5432", ""]) assert.equal(flow.validate(passed), undefined, passed);
          const again = as(flow.advance(accept("54x2")), "input");
          assert.deepEqual([again.title, again.value, again.validationMessage], [step.title, "54x2", PORT_REFUSAL]);
        } else {
          assert.equal(flow.validate("anything"), undefined);
        }
        step = flow.advance(accept(step.value));
      }
      const expected: [string, string, boolean][] = [
        ["Host", "localhost", false],
        ["Port", port, false],
        ["User", "", false],
        ["Password", "", true],
        ["Database", "", false],
      ];
      if (type === "mongodb") expected.push(["Authentication database", "", false]);
      assert.deepEqual(boxes, expected);
      assert.equal(step.kind, "test");
    });
  }

  it("prompts MongoDB's authentication database with the engine's hint", () => {
    const flow = flowOf();
    const steps = walk(flow, [pick("mongodb"), pick("details"), ...["localhost", "27017", "", "", ""].map(accept)]);
    const box = as(steps.at(-1) as FlowStep, "input");
    assert.equal(suffix(box.title), "Authentication database");
    const hint = engineOf("mongodb").fields.find((each) => each.name === "authSource")?.hint;
    assert.ok(hint);
    assert.equal(box.prompt, hint);
  });

  describe("the method step (criterion 6)", () => {
    for (const [type, label] of V0) {
      it(`asks ${label} for a paste or the details`, () => {
        const flow = flowOf();
        const method = as(flow.advance(pick(type)), "pick");
        assert.deepEqual(
          method.items.map((item) => item.id),
          ["paste", "details"],
        );
        assert.equal(method.placeholder, "Choose how to enter the connection");
        assert.deepEqual([method.back, method.moreOptions], [true, true]);
      });
    }

    it("describes the details item with the linear fields' labels", () => {
      const method = as(flowOf().advance(pick("postgres")), "pick");
      assert.deepEqual(method.items, [
        { id: "paste", label: "Paste a connection string" },
        { id: "details", label: "Enter connection details", detail: "Host, Port, User, Password, Database" },
      ]);
    });

    it("skips the method where the engine has no paste scheme, and never asks a none field", () => {
      const flow = flowOf();
      const steps = walk(flow, [pick("db2"), accept("fixture.local"), accept("50000"), accept("u"), accept("p")]);
      const boxes = steps.slice(1, 5).map((step) => as(step, "input"));
      assert.deepEqual(
        boxes.map((box) => [suffix(box.title), box.step, box.totalSteps]),
        [
          ["Host", 2, 7],
          ["Port", 3, 7],
          ["User", 4, 7],
          ["Password", 5, 7],
        ],
      );
      assert.equal(boxes[0].title, "Add Fixture DB Connection: Host");
      assert.equal(boxes[0].value, "fixture.local");
      assert.deepEqual(heading(steps[5]), ["test", "Add Fixture DB Connection", 6, 7]);
      assert.equal(JSON.stringify(steps).includes("paste"), false);
      assert.equal(JSON.stringify(steps).includes("allowInsecureAuth"), false);
    });
  });

  describe("pastes (criteria 7, 8 and 9)", () => {
    const PG_TEXT = `postgresql://app:${TEST_PASSWORD}@db.example:6543/shop?sslmode=require`;

    it("reads a PostgreSQL string into the fields, and saves no string (criterion 7)", () => {
      const flow = flowOf();
      const steps = walk(flow, [pick("postgres"), pick("paste")]);
      const box = as(steps[2], "input");
      assert.deepEqual(heading(box), ["input", "Add PostgreSQL Connection: Connection string", 3, 5]);
      assert.deepEqual([box.password, box.placeholder, box.value], [true, "postgres://...", ""]);
      assert.deepEqual([box.back, box.moreOptions], [true, true]);
      assert.deepEqual(flow.advance(accept(PG_TEXT)), { kind: "parse", text: PG_TEXT });
      const test = as(
        flow.advance(
          parsed({
            parsed: {
              type: "postgres",
              host: "db.example",
              port: "6543",
              user: "app",
              password: TEST_PASSWORD,
              database: "shop",
              sslMode: "require",
            },
            label: "PostgreSQL",
          }),
        ),
        "test",
      );
      assert.deepEqual(heading(test), ["test", "Add PostgreSQL Connection", 4, 5]);
      assert.deepEqual(test.connection, {
        id: ID,
        name: "shop",
        type: "postgres",
        createdAt: CREATED,
        host: "db.example",
        port: 6543,
        user: "app",
        password: TEST_PASSWORD,
        database: "shop",
        ssl: { mode: "require" },
      });
      assert.deepEqual(heading(flow.advance(OK)), ["input", "Add PostgreSQL Connection", 5, 5]);
      const save = as(flow.advance(accept("shop")), "save");
      assert.equal("connectionString" in save.entry, false);
      assert.deepEqual(save.entry.ssl, { mode: "require" });
      assert.deepEqual(save.entry.secretFields, ["password"]);
    });

    it("keeps a MongoDB string verbatim as the one secret, with no address fields (criterion 8)", () => {
      const flow = flowOf();
      const steps = walk(flow, [pick("mongodb"), pick("paste"), accept(SRV)]);
      assert.equal(as(steps[2], "input").placeholder, "mongodb://localhost:27017/mydb  or  mongodb+srv://...");
      const test = as(
        flow.advance(
          parsed({
            parsed: {
              type: "mongodb",
              connectionString: SRV,
              host: "cluster0.example.net",
              user: "app",
              password: TEST_PASSWORD,
              database: "orders",
              sslMode: "verify-system",
            },
            label: "MongoDB",
          }),
        ),
        "test",
      );
      assert.deepEqual(test.connection, {
        id: ID,
        name: "orders",
        type: "mongodb",
        createdAt: CREATED,
        database: "orders",
        connectionString: SRV,
        ssl: { mode: "verify-system" },
      });
      assert.equal(as(flow.advance(OK), "input").value, "orders");
      assert.deepEqual(flow.advance(accept("orders")), {
        kind: "save",
        entry: {
          id: ID,
          name: "orders",
          type: "mongodb",
          createdAt: CREATED,
          database: "orders",
          ssl: { mode: "verify-system" },
          secretFields: ["connectionString"],
        },
        secrets: { connectionString: SRV },
      });
    });

    it("takes a MongoDB reading with no string into the fields, the default port where it names none", () => {
      const flow = flowOf();
      walk(flow, [pick("mongodb"), pick("paste"), accept("mongodb://db.example/orders")]);
      const test = as(
        flow.advance(parsed({ parsed: { type: "mongodb", host: "db.example", database: "orders" }, label: "MongoDB" })),
        "test",
      );
      assert.deepEqual(test.connection, {
        id: ID,
        name: "orders",
        type: "mongodb",
        createdAt: CREATED,
        host: "db.example",
        port: 27017,
        user: "",
        database: "orders",
      });
    });

    it("switches to the engine a string names when the catalogue offers it (criterion 9)", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste"), accept(`mysql://app:${TEST_PASSWORD}@db.example:3306/shop`)]);
      const test = as(
        flow.advance(
          parsed({
            parsed: {
              type: "mysql",
              host: "db.example",
              port: "3306",
              user: "app",
              password: TEST_PASSWORD,
              database: "shop",
            },
            label: "MySQL",
          }),
        ),
        "test",
      );
      assert.deepEqual(heading(test), ["test", "Add MySQL Connection", 4, 5]);
      assert.equal(test.connection.type, "mysql");
      assert.equal(test.connection.port, 3306);
      assert.equal(test.placeholder, "Testing MySQL connection");
    });

    /** The paste box again after an answer to PostgreSQL's paste of text. */
    function pasteAgain(text: string, answer: PastedConnection) {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste"), accept(text)]);
      return as(flow.advance(parsed(answer)), "input");
    }

    it("keeps the box with its text for an engine the catalogue does not offer (criterion 9)", () => {
      const text = "oracle://db.example:1521/ORCL";
      const box = pasteAgain(text, { parsed: { type: "oracle", host: "db.example", port: "1521" }, label: "Oracle" });
      assert.deepEqual(
        [box.title, box.value, box.validationMessage],
        [
          "Add PostgreSQL Connection: Connection string",
          text,
          "Oracle is not available in LibreDB Studio for VS Code.",
        ],
      );
    });

    it("keeps the box with its text for a string LibreDB cannot read", () => {
      const box = pasteAgain("nonsense", { parsed: null, label: null });
      assert.deepEqual([box.value, box.validationMessage], ["nonsense", UNREADABLE_PASTE]);
      assert.equal(
        UNREADABLE_PASTE,
        `LibreDB could not read this connection string. Supported formats: ${PASTE_FORMATS_TEXT}`,
      );
    });

    it("shows a refusal, emptying the box only when the reading says to discard the paste", () => {
      const discarded = pasteAgain("databend://x", {
        parsed: { type: "databend", refusal: "R", discardPaste: true },
        label: "Databend",
      });
      assert.deepEqual([discarded.value, discarded.validationMessage], ["", "R"]);
      const kept = pasteAgain("databend://x", { parsed: { type: "databend", refusal: "R" }, label: "Databend" });
      assert.deepEqual([kept.value, kept.validationMessage], ["databend://x", "R"]);
    });

    it("parses a text accepted again after a refusal", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste"), accept("nonsense"), parsed({ parsed: null, label: null })]);
      assert.deepEqual(flow.advance(accept(PG_TEXT)), { kind: "parse", text: PG_TEXT });
    });

    it("says why an engine is not offered and a name is taken", () => {
      assert.equal(notOffered("Oracle"), "Oracle is not available in LibreDB Studio for VS Code.");
      assert.equal(nameTaken("shop"), "A connection named shop already exists.");
    });
  });

  describe("the name", () => {
    /** PostgreSQL by details, with database shop, at its Name step. */
    function atName(savedNames: string[]) {
      const flow = flowOf(savedNames);
      walk(flow, [
        pick("postgres"),
        pick("details"),
        ...["localhost", "5432", "app", TEST_PASSWORD, "shop"].map(accept),
        OK,
      ]);
      return flow;
    }

    it("is made unique against the saved names, ignoring case", () => {
      assert.equal(as(atName(["shop"]).step, "input").value, "shop (2)");
      assert.equal(as(atName(["shop", " SHOP (2) "]).step, "input").value, "shop (3)");
    });

    it("refuses a blank name and a saved one, and saves a name trimmed", () => {
      const flow = atName(["shop"]);
      assert.equal(flow.validate("  "), NAME_BLANK);
      assert.equal(flow.validate(" Shop "), "A connection named Shop already exists.");
      assert.equal(flow.validate("shop2"), undefined);
      const refused = as(flow.advance(accept("  ")), "input");
      assert.deepEqual([refused.value, refused.validationMessage], ["  ", NAME_BLANK]);
      assert.equal(as(flow.advance(accept(" shop2 ")), "save").entry.name, "shop2");
    });

    it("suggests the host where there is no database, else the engine's label", () => {
      const named = (host: string) => {
        const flow = flowOf();
        walk(flow, [pick("db2"), accept(host), accept(""), accept(""), accept(""), OK]);
        return as(flow.step, "input").value;
      };
      assert.equal(named("fixture.local"), "fixture.local");
      assert.equal(named(""), "Fixture DB");
    });
  });

  describe("Back", () => {
    it("walks back field by field, with the values typed, to the method and the engine", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), accept("db.internal")]);
      const host = as(flow.advance(BACK), "input");
      assert.deepEqual([host.title, host.value], ["Add PostgreSQL Connection: Host", "db.internal"]);
      assert.deepEqual(heading(flow.advance(BACK)), ["pick", "Add PostgreSQL Connection", 2, 9]);
      const engine = as(flow.advance(BACK), "pick");
      assert.deepEqual([engine.title, engine.back, engine.moreOptions], ["Add Connection", false, false]);
      assert.throws(() => flow.advance(BACK), { message: "back does not answer a step without Back" });
    });

    it("goes from the paste box to the method, which counts the details again", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste")]);
      assert.deepEqual(heading(flow.advance(BACK)), ["pick", "Add PostgreSQL Connection", 2, 9]);
    });

    it("goes from the first field to the engine where there is no method", () => {
      const flow = flowOf();
      walk(flow, [pick("db2")]);
      assert.deepEqual(heading(flow.advance(BACK)), ["pick", "Add Connection", 1, undefined]);
    });

    it("keeps the draft when the same engine is picked again, and starts a new one for another", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), accept("db.internal"), BACK, BACK, BACK]);
      walk(flow, [pick("postgres"), pick("details")]);
      assert.equal(as(flow.step, "input").value, "db.internal");
      walk(flow, [BACK, BACK, pick("mysql"), pick("details")]);
      assert.equal(as(flow.step, "input").value, "localhost");
    });
  });

  it("saves an empty draft with host, user and database, and no port and no secret (criterion 13)", () => {
    const flow = flowOf();
    const steps = walk(flow, [
      pick("postgres"),
      pick("details"),
      accept("localhost"),
      accept(""),
      accept(""),
      accept(""),
      accept(""),
      OK,
    ]);
    assert.deepEqual(as(steps.at(-2) as FlowStep, "test").connection, {
      id: ID,
      name: "localhost",
      type: "postgres",
      createdAt: CREATED,
      host: "localhost",
      user: "",
      database: "",
    });
    assert.equal(as(flow.step, "input").value, "localhost");
    assert.deepEqual(flow.advance(accept("localhost")), {
      kind: "save",
      entry: {
        id: ID,
        name: "localhost",
        type: "postgres",
        createdAt: CREATED,
        host: "localhost",
        user: "",
        database: "",
      },
      secrets: {},
    });
  });

  describe("Review and More Options", () => {
    const PG_REVIEW = [
      ["test", "Test and Continue", undefined],
      "---",
      ["field:host", "Host", "localhost"],
      ["field:port", "Port", "5432"],
      ["field:user", "User", ""],
      ["field:password", "Password", "not set"],
      ["field:database", "Database", ""],
      ["ssl", "SSL mode", "disable"],
    ];

    it("names the More Options button's tooltip and the dialogs' buttons", () => {
      assert.deepEqual(
        [MORE_OPTIONS_TOOLTIP, SAVE_ANYWAY, BACK_TO_REVIEW, TEST_AGAIN],
        ["SSL and optional fields", "Save Anyway", "Back to Review", "Test Again"],
      );
    });

    it("opens Review from a field with More Options, and Back returns to that field (builder's call 7)", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), accept("localhost")]);
      const review = as(flow.advance(MORE), "pick");
      assert.deepEqual(
        [review.title, review.placeholder, review.step, review.totalSteps, review.back, review.moreOptions],
        [
          "Add PostgreSQL Connection: Review",
          "Change a value, or test the connection",
          undefined,
          undefined,
          true,
          false,
        ],
      );
      assert.deepEqual(rows(review), PG_REVIEW);
      const port = as(flow.advance(BACK), "input");
      assert.deepEqual(heading(port), ["input", "Add PostgreSQL Connection: Port", 4, 9]);
      assert.deepEqual([port.value, port.back, port.moreOptions], ["5432", true, true]);
    });

    it("returns to the method pick and to the paste box it was opened from, the paste's text kept", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), MORE]);
      assert.deepEqual(heading(flow.advance(BACK)), ["pick", "Add PostgreSQL Connection", 2, 9]);
      walk(flow, [pick("paste"), accept("nonsense"), parsed({ parsed: null, label: null })]);
      assert.equal(as(flow.advance(MORE), "pick").back, true);
      const box = as(flow.advance(BACK), "input");
      assert.deepEqual(heading(box), ["input", "Add PostgreSQL Connection: Connection string", 3, 5]);
      assert.deepEqual([box.value, box.validationMessage, box.moreOptions], ["nonsense", undefined, true]);
    });

    it("keeps the value typed into a field's box when More Options opens Review, as Enter would", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), ...["localhost", "5432", "app", TEST_PASSWORD].map(accept)]);
      const review = flow.advance({ kind: "moreOptions", value: "shop" });
      assert.deepEqual(rows(review)[6], ["field:database", "Database", "shop"]);
      const box = as(flow.advance(BACK), "input");
      assert.deepEqual([suffix(box.title), box.value], ["Database", "shop"]);
      assert.equal(as(flow.advance(accept("shop")), "test").connection.database, "shop");
    });

    it("keeps no value Enter would refuse: the box stays, with the check's sentence", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), accept("localhost")]);
      const port = as(flow.advance({ kind: "moreOptions", value: "54x2" }), "input");
      assert.deepEqual([suffix(port.title), port.value, port.validationMessage], ["Port", "54x2", PORT_REFUSAL]);
      const review = flow.advance({ kind: "moreOptions", value: "6543" });
      assert.deepEqual(rows(review)[3], ["field:port", "Port", "6543"]);
    });

    it("keeps the text typed into the paste box for Review's Back, unread until Enter", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste")]);
      assert.equal(flow.advance({ kind: "moreOptions", value: "postgres://db.example/shop" }).kind, "pick");
      const box = as(flow.advance(BACK), "input");
      assert.deepEqual([suffix(box.title), box.value], ["Connection string", "postgres://db.example/shop"]);
    });

    it("keeps the name typed at Name for the Name after the next test, and refuses a taken one", () => {
      const flow = flowOf(["Orders"]);
      walk(flow, [
        pick("postgres"),
        pick("details"),
        ...["localhost", "5432", "app", TEST_PASSWORD, "shop"].map(accept),
        OK,
      ]);
      const taken = as(flow.advance({ kind: "moreOptions", value: "orders" }), "input");
      assert.equal(taken.validationMessage, nameTaken("orders"));
      assert.equal(flow.advance({ kind: "moreOptions", value: "Shop on staging" }).kind, "pick");
      walk(flow, [pick("test")]);
      assert.equal(as(flow.advance(OK), "input").value, "Shop on staging");
    });

    it("lists an advanced field as optional and edits it in its own box (SQL Server's Instance name)", () => {
      const flow = flowOf();
      walk(flow, [pick("mssql"), pick("details"), MORE]);
      assert.deepEqual(rows(flow.step).slice(6, 8), [
        ["field:database", "Database", ""],
        ["field:instanceName", "Instance name (optional)", ""],
      ]);
      const box = as(flow.advance(pick("field:instanceName")), "input");
      const hint = engineOf("mssql").fields.find((each) => each.name === "instanceName")?.hint;
      assert.ok(hint);
      assert.deepEqual(
        [box.title, box.prompt, box.value, box.password, box.step, box.totalSteps, box.back, box.moreOptions],
        ["Add SQL Server Connection: Instance name", hint, "", false, undefined, undefined, true, false],
      );
      assert.equal(flow.validate("54x2"), undefined);
      assert.deepEqual(rows(flow.advance(accept("SQLEXPRESS")))[7], [
        "field:instanceName",
        "Instance name (optional)",
        "SQLEXPRESS",
      ]);
      const test = as(flow.advance(pick("test")), "test");
      assert.equal(test.connection.instanceName, "SQLEXPRESS");
      assert.equal(as(flow.advance(OK), "input").value, "localhost");
      assert.equal(as(flow.advance(accept("local")), "save").entry.instanceName, "SQLEXPRESS");
    });

    it("returns to Review from a field's box with Back, keeping the value, and checks a port there", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), MORE, pick("field:host")]);
      assert.deepEqual(rows(flow.advance(BACK)), PG_REVIEW);
      as(flow.advance(pick("field:port")), "input");
      assert.equal(flow.validate("65536"), PORT_REFUSAL);
      const refused = as(flow.advance(accept("65536")), "input");
      assert.deepEqual([refused.title, refused.validationMessage], ["Add PostgreSQL Connection: Port", PORT_REFUSAL]);
      assert.deepEqual(rows(flow.advance(accept("6543")))[3], ["field:port", "Port", "6543"]);
      assert.equal(as(flow.advance(BACK), "input").value, "localhost");
    });

    it("describes a masked field as set or not set, never its value", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), ...["localhost", "5432", "app", TEST_PASSWORD].map(accept)]);
      const review = flow.advance(MORE);
      assert.deepEqual(rows(review)[5], ["field:password", "Password", "set"]);
      assert.equal(JSON.stringify(review).includes(TEST_PASSWORD), false);
      const box = as(flow.advance(pick("field:password")), "input");
      assert.deepEqual([box.password, box.value], [true, TEST_PASSWORD]);
    });

    it("stands a kept string where the fields it clears stood, and edits it in the paste box", () => {
      const flow = flowOf();
      const steps = walk(flow, [
        pick("mongodb"),
        pick("paste"),
        accept(SRV),
        parsed({ parsed: { ...MONGO_SRV, tlsFileParam: "tlsCAFile=/etc/ssl/ca.pem" }, label: "MongoDB" }),
      ]);
      const review = as(steps[4], "pick");
      assert.deepEqual(review.items, [
        { id: "test", label: "Test and Continue" },
        { id: "separator:0", label: "", separator: true },
        { id: "connectionString", label: "Connection string", description: "set" },
        { id: "field:database", label: "Database", description: "orders" },
        { id: "field:authSource", label: "Authentication database", description: "" },
        { id: "ssl", label: "SSL mode", description: "verify-system" },
        { id: "separator:1", label: "Check before testing", separator: true },
        {
          id: "caution:0",
          label:
            "tlsCAFile=/etc/ssl/ca.pem names a file, which is read on the machine running the extension when it connects.",
        },
      ]);
      assert.deepEqual([review.title, review.back], ["Add MongoDB Connection: Review", false]);
      assert.equal(JSON.stringify(review).includes(TEST_PASSWORD), false);
      const box = as(flow.advance(pick("connectionString")), "input");
      assert.deepEqual(
        [box.title, box.password, box.value, box.step, box.back, box.moreOptions],
        ["Add MongoDB Connection: Connection string", true, SRV, undefined, true, false],
      );
      assert.deepEqual(flow.advance(BACK), review);
    });

    it("returns to Review after a paste opened from it, and keeps that box after a refusal", () => {
      const flow = flowOf();
      walk(flow, [pick("mongodb"), pick("paste"), accept(SRV), parsed({ parsed: MONGO_SRV, label: "MongoDB" }), OK]);
      walk(flow, [BACK, pick("connectionString"), accept("x")]);
      const box = as(flow.advance(parsed({ parsed: null, label: null })), "input");
      assert.deepEqual(
        [box.value, box.validationMessage, box.step, box.back],
        ["x", UNREADABLE_PASTE, undefined, true],
      );
      const other = "mongodb://db.example/stock";
      assert.deepEqual(flow.advance(accept(other)), { kind: "parse", text: other });
      const review = flow.advance(parsed({ parsed: { type: "mongodb", connectionString: other }, label: "MongoDB" }));
      assert.deepEqual(rows(review).slice(2, 4), [
        ["connectionString", "Connection string", "set"],
        ["field:database", "Database", ""],
      ]);
      assert.equal(as(flow.advance(pick("test")), "test").connection.connectionString, other);
    });

    it("switches the engine for a paste from Review that names another one", () => {
      const flow = flowOf();
      walk(flow, [pick("mongodb"), pick("paste"), accept(SRV), parsed({ parsed: MONGO_SRV, label: "MongoDB" }), OK]);
      walk(flow, [BACK, pick("connectionString"), accept("postgres://db.example/shop")]);
      const review = as(
        flow.advance(
          parsed({ parsed: { type: "postgres", host: "db.example", database: "shop" }, label: "PostgreSQL" }),
        ),
        "pick",
      );
      assert.equal(review.title, "Add PostgreSQL Connection: Review");
      assert.deepEqual(rows(review).slice(2, 5), [
        ["field:host", "Host", "db.example"],
        ["field:port", "Port", "5432"],
        ["field:user", "User", ""],
      ]);
    });
  });

  describe("SSL mode", () => {
    const SSL_ITEMS = [
      { id: "disable", label: "disable", description: "No TLS" },
      { id: "require", label: "require", description: "Encrypt, verify nothing" },
      {
        id: "verify-system",
        label: "verify-system",
        description: "Encrypt, and verify against the system's trusted roots",
      },
    ];

    it("offers the three modes, and the chosen one reaches the test connection", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), MORE]);
      const ssl = as(flow.advance(pick("ssl")), "pick");
      assert.deepEqual(
        [ssl.title, ssl.step, ssl.back, ssl.moreOptions],
        ["Add PostgreSQL Connection: SSL mode", undefined, true, false],
      );
      assert.deepEqual(ssl.items, SSL_ITEMS);
      assert.deepEqual(rows(flow.advance(BACK)).at(-1), ["ssl", "SSL mode", "disable"]);
      walk(flow, [pick("ssl")]);
      assert.deepEqual(rows(flow.advance(pick("require"))).at(-1), ["ssl", "SSL mode", "require"]);
      assert.deepEqual(as(flow.advance(pick("test")), "test").connection.ssl, { mode: "require" });
    });

    it("writes no ssl key for disable", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("details"), MORE, pick("ssl"), pick("require"), pick("ssl"), pick("disable")]);
      assert.equal("ssl" in as(flow.advance(pick("test")), "test").connection, false);
    });

    it("adds the mode a pasted string set when it is not one of the three", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste"), accept("postgres://db.example/shop?sslmode=verify-full")]);
      walk(flow, [
        parsed({
          parsed: { type: "postgres", host: "db.example", database: "shop", sslMode: "verify-full" },
          label: "PostgreSQL",
        }),
        OK,
        BACK,
      ]);
      assert.deepEqual(as(flow.advance(pick("ssl")), "pick").items, [
        ...SSL_ITEMS,
        { id: "verify-full", label: "verify-full", description: "Set by the pasted string" },
      ]);
    });

    it("has no item and writes no ssl key where the engine offers no SSL", () => {
      const flow = flowOf();
      flow.advance(pick("db2"));
      const review = flow.advance(MORE);
      assert.deepEqual(rows(review), [
        ["test", "Test and Continue", undefined],
        "---",
        ["field:host", "Host", "fixture.local"],
        ["field:port", "Port", "50000"],
        ["field:user", "User", ""],
        ["field:password", "Password", "not set"],
      ]);
      assert.equal("ssl" in as(flow.advance(pick("test")), "test").connection, false);
    });
  });

  describe("paste cautions (criterion 10)", () => {
    /** The Review a paste of text answered with reading shows, after checking that no test came first. */
    function cautionsOf(type: string, text: string, reading: NonNullable<PastedConnection["parsed"]>, label: string) {
      const flow = flowOf();
      const steps = walk(flow, [pick(type), pick("paste"), accept(text), parsed({ parsed: reading, label })]);
      assert.deepEqual(
        steps.slice(3).map((step) => step.kind),
        ["parse", "pick"],
      );
      const review = as(steps[4], "pick");
      assert.equal(review.back, false);
      assert.deepEqual(flow.advance(pick("caution:0")), review);
      const at = rows(review).indexOf("--- Check before testing");
      assert.ok(at > 0);
      return rows(review)
        .slice(at + 1)
        .map((row) => row[1]);
    }

    it("shows each caution in Review before any test", () => {
      assert.deepEqual(
        cautionsOf(
          "postgres",
          "postgres://db.example/shop?sslmode=prefer",
          { type: "postgres", host: "db.example", database: "shop", unmappedTLSParam: "sslmode=prefer" },
          "PostgreSQL",
        ),
        [
          "TLS setting not applied: sslmode=prefer has no equivalent among the SSL modes. SSL mode stays disable; change it in SSL mode before testing.",
        ],
      );
      assert.deepEqual(
        cautionsOf(
          "mongodb",
          "mongodb://app:p@ss@db.example/orders",
          { type: "mongodb", connectionString: "mongodb://app:p@ss@db.example/orders", credentialsAmbiguous: true },
          "MongoDB",
        ),
        [
          "User and password could not be read: the string holds more than one unescaped @. Percent-encode it as %40 and paste it again.",
        ],
      );
      assert.deepEqual(
        cautionsOf(
          "mongodb",
          `${SRV}?tlsCAFile=/etc/ssl/ca.pem`,
          { ...MONGO_SRV, tlsFileParam: "tlsCAFile=/etc/ssl/ca.pem" },
          "MongoDB",
        ),
        [
          "tlsCAFile=/etc/ssl/ca.pem names a file, which is read on the machine running the extension when it connects.",
        ],
      );
      assert.deepEqual(
        cautionsOf(
          "mssql",
          "Server=np:myserver;Database=shop",
          { type: "mssql", database: "shop", unsupportedServerProtocol: "np" },
          "SQL Server",
        ),
        [
          "Server not applied: np: is a SQL Server protocol this connection cannot use, because it connects over TCP only.",
        ],
      );
    });

    it("words the four cautions in their order, with the SSL mode after the paste", () => {
      assert.deepEqual(
        pasteCautions(
          {
            type: "postgres",
            unsupportedServerProtocol: "lpc",
            tlsFileParam: "tlsCAFile=/x",
            credentialsAmbiguous: true,
            unmappedTLSParam: "ssl-mode=PREFERRED",
          },
          "require",
        ),
        [
          "TLS setting not applied: ssl-mode=PREFERRED has no equivalent among the SSL modes. SSL mode stays require; change it in SSL mode before testing.",
          "User and password could not be read: the string holds more than one unescaped @. Percent-encode it as %40 and paste it again.",
          "tlsCAFile=/x names a file, which is read on the machine running the extension when it connects.",
          "Server not applied: lpc: is a SQL Server protocol this connection cannot use, because it connects over TCP only.",
        ],
      );
      assert.deepEqual(pasteCautions({ type: "postgres", credentialsAmbiguous: false }, "disable"), []);
    });
  });

  describe("the test outcomes (criteria 11 and 12)", () => {
    /** PostgreSQL by details at its test step, every step shown so far kept in steps. */
    function atTest() {
      const flow = flowOf();
      const steps = walk(flow, [
        pick("postgres"),
        pick("details"),
        ...["localhost", "5432", "app", "wrong", "shop"].map(accept),
      ]);
      return { flow, steps };
    }
    const FAILED = 'password authentication failed for user "app"';

    it("shows a failure in an error dialog, tests again, and fixes it in Review (criterion 11)", () => {
      const { flow, steps } = atTest();
      const test = as(flow.step, "test");
      const failed = flow.advance(tested({ kind: "failed", message: FAILED }));
      assert.deepEqual(failed, {
        kind: "dialog",
        severity: "error",
        message: FAILED,
        buttons: ["Test Again", "Back to Review"],
      });
      assert.deepEqual(flow.advance(choose(TEST_AGAIN)), test);
      steps.push(failed, test);
      const fix = flow.advance(tested({ kind: "failed", message: FAILED, fixStatement: "ALTER ROLE app LOGIN;" }));
      assert.equal(as(fix, "dialog").detail, "ALTER ROLE app LOGIN;");
      steps.push(fix, ...walk(flow, [choose(BACK_TO_REVIEW), pick("field:password"), accept("right")]));
      assert.equal(as(steps.at(-1) as FlowStep, "pick").back, false);
      const again = as(flow.advance(pick("test")), "test");
      assert.deepEqual(heading(again), ["test", "Add PostgreSQL Connection", 8, 9]);
      assert.equal(again.connection.password, "right");
      steps.push(again, flow.advance(OK));
      assert.deepEqual(heading(flow.step), ["input", "Add PostgreSQL Connection", 9, 9]);
      assert.equal(
        steps.some((step) => step.kind === "save"),
        false,
      );
      assert.deepEqual(as(flow.advance(accept("shop")), "save").secrets, { password: "right" });
    });

    it("shows a degraded pass in a warning dialog, and Save Anyway names it (criterion 12)", () => {
      const { flow } = atTest();
      const message = "Connected, but this server answered no health data: x";
      const warned = flow.advance(tested({ kind: "answered", answer: { success: true, degraded: true, message } }));
      assert.deepEqual(warned, {
        kind: "dialog",
        severity: "warning",
        message,
        buttons: ["Save Anyway", "Back to Review"],
      });
      const name = as(flow.advance(choose(SAVE_ANYWAY)), "input");
      assert.deepEqual([name.prompt, name.value], ["Name this connection.", "shop"]);
    });

    it("lists the warnings of a pass one per line, and Save Anyway names it with the latency", () => {
      const { flow } = atTest();
      const answer: TestConnectionResult = {
        success: true,
        message: "Connection successful",
        latency: 9,
        warnings: [{ message: "a" }, { message: "b" }],
      };
      const warned = as(flow.advance(tested({ kind: "answered", answer })), "dialog");
      assert.deepEqual([warned.severity, warned.message, warned.detail], ["warning", "Connection successful", "a\nb"]);
      assert.equal(as(flow.advance(choose(SAVE_ANYWAY)), "input").prompt, "Connected in 9 ms. Name this connection.");
    });

    it("returns to Review from a dialog with Back to Review or when it is dismissed (builder's call 6)", () => {
      for (const choice of [BACK_TO_REVIEW, undefined]) {
        const { flow } = atTest();
        flow.advance(tested({ kind: "answered", answer: { success: true, degraded: true, message: "m" } }));
        const review = as(flow.advance(choose(choice)), "pick");
        assert.deepEqual([review.title, review.back], ["Add PostgreSQL Connection: Review", false]);
      }
    });

    it("refuses a choice the dialog does not offer", () => {
      const { flow } = atTest();
      flow.advance(tested({ kind: "failed", message: FAILED }));
      assert.throws(() => flow.advance(choose(SAVE_ANYWAY)), {
        message: '"Save Anyway" is not a button of this dialog',
      });
    });

    it("names a pass with an empty warnings list at once", () => {
      const { flow } = atTest();
      const answer: TestConnectionResult = {
        success: true,
        message: "Connection successful",
        latency: 3,
        warnings: [],
      };
      assert.equal(
        as(flow.advance(tested({ kind: "answered", answer })), "input").prompt,
        "Connected in 3 ms. Name this connection.",
      );
    });
  });

  describe("Name and Review", () => {
    it("goes back from Name to Review, which has no Back and tests again", () => {
      const flow = flowOf();
      walk(flow, [
        pick("postgres"),
        pick("details"),
        ...["localhost", "5432", "app", TEST_PASSWORD, "shop"].map(accept),
        OK,
      ]);
      assert.equal(as(flow.step, "input").back, true);
      const review = as(flow.advance(BACK), "pick");
      assert.deepEqual([review.title, review.back], ["Add PostgreSQL Connection: Review", false]);
      assert.equal(flow.advance(pick("test")).kind, "test");
    });

    it("opens Review from Name with More Options, and an edit there is tested before the name", () => {
      const flow = flowOf();
      walk(flow, [
        pick("postgres"),
        pick("details"),
        ...["localhost", "5432", "app", TEST_PASSWORD, "shop"].map(accept),
        OK,
      ]);
      assert.equal(as(flow.advance(MORE), "pick").back, false);
      walk(flow, [pick("field:host"), accept("db.internal")]);
      const test = as(flow.advance(pick("test")), "test");
      assert.equal(test.connection.host, "db.internal");
    });
  });

  describe("out of turn", () => {
    it("throws for an input of the wrong kind, and for an item the step does not offer", () => {
      assert.throws(() => flowOf().advance(accept("x")), { message: "accept does not answer a pick step" });
      assert.throws(() => flowOf().advance(pick("oracle")), { message: '"oracle" is not an item of this step' });
      assert.throws(() => flowOf().advance(MORE), {
        message: "moreOptions does not answer a step without More Options",
      });
      const method = flowOf();
      method.advance(pick("postgres"));
      assert.throws(() => method.advance({ kind: "moreOptions", value: "x" }), {
        message: "moreOptions carries a value only from an input step",
      });
      const flow = flowOf();
      flow.advance(pick("postgres"));
      assert.throws(() => flow.advance(pick("postgres")), { message: '"postgres" is not an item of this step' });
      flow.advance(pick("details"));
      assert.throws(() => flow.advance({ kind: "dialog", choice: undefined }), {
        message: "dialog does not answer an input step",
      });
      assert.throws(() => flow.advance(OK), { message: "tested does not answer an input step" });
      assert.throws(() => flow.advance(parsed({ parsed: null, label: null })), {
        message: "parsed does not answer an input step",
      });
    });

    it("answers nothing after the save, and checks no value at a step that is not a box", () => {
      const flow = flowOf();
      walk(flow, [pick("db2"), ...["h", "", "", ""].map(accept), OK, accept("n")]);
      assert.equal(flow.step.kind, "save");
      assert.equal(flow.validate(""), undefined);
      assert.throws(() => flow.advance(BACK), { message: "back does not answer a save step" });
    });

    it("takes no More Options while the child reads a paste", () => {
      const flow = flowOf();
      walk(flow, [pick("postgres"), pick("paste"), accept("x")]);
      assert.throws(() => flow.advance(MORE), { message: "moreOptions does not answer a parse step" });
    });
  });
});
