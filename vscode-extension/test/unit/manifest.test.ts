import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_FORM, CONNECTION_PICKER_ORDER } from "@/lib/db/connection-form";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { ICON_OUTPUT } from "../../scripts/marketplace-icon.mjs";
import { ENABLED_PROVIDERS, HELD_BACK } from "../../src/host/channel";
import { CONNECTIONS_VIEW, RESULTS_CONTAINER, RESULTS_VIEW, VIEW_CONTAINER } from "../../src/host/names";
import { FLOOR_NODE, STABLE_RUNTIME } from "../vscode-floor";

const root = join(__dirname, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = read("package.json");
const nls = read("package.nls.json");
const versions = read("test/vscode-versions.json");
const rootManifest = read("../package.json");

/** Part 2's manifest entry for the setting, written out. */
const CONNECTIONS_SCHEMA = {
  type: "array",
  scope: "application",
  default: [],
  markdownDescription:
    "Database connections, without passwords or connection strings: LibreDB keeps those in VS Code's secret storage on each machine. Add one with **LibreDB: Add Connection**.",
  items: {
    type: "object",
    required: ["id", "name", "type", "createdAt"],
    properties: {
      id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
      name: { type: "string", minLength: 1 },
      type: { type: "string" },
      host: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      user: { type: "string" },
      database: { type: "string" },
      instanceName: { type: "string" },
      authSource: { type: "string" },
      ssl: { type: "object", required: ["mode"], properties: { mode: { type: "string" } } },
      createdAt: { type: "string" },
      secretFields: { type: "array", uniqueItems: true, items: { type: "string" } },
    },
  },
};

/** Part 5's manifest entry for the row limit, written out. */
const ROW_LIMIT_SCHEMA = {
  type: "integer",
  default: 500,
  minimum: 1,
  maximum: 10000,
  scope: "application",
  description: "The number of rows each page of query results holds.",
};

const exact = /^\d+\.\d+\.\d+$/;
const triple = (version: string): number[] => version.split(".").map(Number);
const atLeast = (a: number[], b: number[]): boolean =>
  a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));

describe("the manifest", () => {
  it("asks for VS Code ^1.123.0, the minor of the pinned floor build", () => {
    assert.equal(manifest.engines.vscode, "^1.123.0");
    assert.deepEqual(versions, { floor: "1.123.2", stable: "1.142.0" });
    assert.equal(versions.floor.split(".").slice(0, 2).join("."), "1.123");
  });

  it("rests on a floor whose Node satisfies the root's engines.node", () => {
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(rootManifest.engines.node);
    assert.ok(floor, `engines.node is ${rootManifest.engines.node}, not a >= floor this test can read`);
    assert.ok(atLeast(triple(FLOOR_NODE), triple(floor[1])), `${FLOOR_NODE} is below ${floor[1]}`);
  });

  it("pins the stable build that STABLE_RUNTIME in test/vscode-floor.ts describes, whose Node meets engines.node", () => {
    // The integration leg's vscode run checks the child's runtime against STABLE_RUNTIME, so a bump of the pin
    // updates both.
    assert.equal(versions.stable, "1.142.0");
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(rootManifest.engines.node);
    assert.ok(floor, `engines.node is ${rootManifest.engines.node}, not a >= floor this test can read`);
    assert.ok(atLeast(triple(STABLE_RUNTIME.node), triple(floor[1])), `${STABLE_RUNTIME.node} is below ${floor[1]}`);
  });

  it("types against @types/vscode 1.120.0, no newer than the floor", () => {
    assert.equal(manifest.devDependencies["@types/vscode"], "1.120.0");
    assert.ok(atLeast(triple(versions.floor), triple(manifest.devDependencies["@types/vscode"])));
  });

  it("declares no activationEvents, extensionKind or browser entry, and depends on vscode.sql", () => {
    for (const key of ["activationEvents", "extensionKind", "browser"]) assert.equal(key in manifest, false, key);
    assert.deepEqual(manifest.extensionDependencies, ["vscode.sql"]);
  });

  it("has a major.minor.patch version and pins every dev tool exactly", () => {
    assert.match(manifest.version, exact);
    assert.deepEqual(
      Object.entries(manifest.devDependencies).filter(([, v]) => !exact.test(String(v))),
      [],
    );
  });

  it("keeps the lockfile on the manifest's version, as npm version writes both", () => {
    const lock = read("package-lock.json");
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[""].version, manifest.version);
  });

  it("is on the release line: 0.4.x, an even minor, the release that opens every pure-JS engine", () => {
    const [major, minor] = triple(manifest.version);
    assert.equal(major, 0);
    assert.equal(minor, 4);
  });

  it("pins vscode-jsonrpc exactly, as the bundles' one runtime package", () => {
    assert.deepEqual(manifest.dependencies, { "vscode-jsonrpc": "10.0.0" });
  });

  it("contributes the nine commands in category LibreDB", () => {
    assert.deepEqual(manifest.contributes.commands, [
      { command: "libredb.showLog", title: "Show Log", category: "LibreDB" },
      { command: "libredb.addConnection", title: "Add Connection", category: "LibreDB", icon: "$(add)" },
      { command: "libredb.removeConnection", title: "Remove Connection", category: "LibreDB" },
      { command: "libredb.refresh", title: "Refresh", category: "LibreDB", icon: "$(refresh)" },
      { command: "libredb.newQuery", title: "New Query", category: "LibreDB", icon: "$(file-code)" },
      { command: "libredb.selectRows", title: "Select Rows", category: "LibreDB", icon: "$(play)" },
      { command: "libredb.runQuery", title: "Run Query", category: "LibreDB", icon: "$(play)" },
      { command: "libredb.cancelQuery", title: "Cancel Query", category: "LibreDB", icon: "$(debug-stop)" },
      { command: "libredb.changeConnection", title: "Change Connection", category: "LibreDB" },
    ]);
    assert.deepEqual(Object.keys(manifest.contributes), [
      "commands",
      "configuration",
      "viewsContainers",
      "views",
      "viewsWelcome",
      "menus",
    ]);
  });

  it("contributes the LibreDB view container, the Connections view, the LibreDB Results panel and its one Results view", () => {
    assert.deepEqual(manifest.contributes.viewsContainers, {
      activitybar: [{ id: VIEW_CONTAINER, title: "LibreDB", icon: "media/libredb.svg" }],
      panel: [{ id: RESULTS_CONTAINER, title: "LibreDB Results", icon: "media/libredb.svg" }],
    });
    assert.deepEqual(manifest.contributes.views, {
      [VIEW_CONTAINER]: [{ id: CONNECTIONS_VIEW, name: "Connections" }],
      [RESULTS_CONTAINER]: [{ id: RESULTS_VIEW, name: "Results", type: "webview" }],
    });
    assert.deepEqual(manifest.contributes.viewsWelcome, [
      { view: "libredb.connections", contents: "No connections yet.\n[Add Connection](command:libredb.addConnection)" },
    ]);
    assert.ok(existsSync(join(root, "media", "libredb.svg")));
  });

  it("describes itself on the Marketplace card by engines it ships and no engine it holds back, in category Other", () => {
    assert.equal(
      manifest.description,
      "Browse and query PostgreSQL, MySQL, SQL Server, MongoDB, Redis, ClickHouse, Elasticsearch, Kafka and many more databases with LibreDB Studio.",
    );
    for (const type of Object.keys(HELD_BACK)) {
      const label = CONNECTION_FORM[type as keyof typeof HELD_BACK].label;
      assert.ok(!manifest.description.includes(label), label);
    }
    assert.deepEqual(manifest.categories, ["Other"]);
  });

  it("lists the first 29 enabled engines' labels in picker order as keywords, then SQL: the Marketplace takes at most 30", () => {
    const labels = CONNECTION_PICKER_ORDER.filter((type) => ENABLED_PROVIDERS.includes(type)).map(
      (type) => CONNECTION_FORM[type].label,
    );
    assert.deepEqual(manifest.keywords, [...labels.slice(0, 29), "SQL"]);
  });

  it("names the 128x128 Marketplace icon the build writes, and lets it into the VSIX", () => {
    assert.equal(manifest.icon, ICON_OUTPUT);
    const ignore = readFileSync(join(root, ".vscodeignore"), "utf8").split("\n");
    assert.ok(ignore.includes(`!${ICON_OUTPUT}`));
  });

  it("keeps no webview context while it is hidden: no file under src/ names retainContextWhenHidden (criterion 1)", () => {
    const src = join(root, "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" })
      .map((path) => join(src, path))
      .filter((path) => /\.tsx?$/.test(path));
    assert.ok(files.length > 0);
    assert.deepEqual(
      files.filter((path) => readFileSync(path, "utf8").includes("retainContextWhenHidden")),
      [],
    );
  });

  it("declares libredb.connections as part 2 writes it, synced and never read from a workspace", () => {
    assert.deepEqual(manifest.contributes.configuration, {
      title: "LibreDB",
      properties: { "libredb.connections": CONNECTIONS_SCHEMA, "libredb.query.rowLimit": ROW_LIMIT_SCHEMA },
    });
    assert.equal("ignoreSync" in manifest.contributes.configuration.properties["libredb.connections"], false);
    assert.equal("restrictedConfigurations" in manifest.capabilities.untrustedWorkspaces, false);
  });

  it("declares libredb.query.rowLimit from 1 to 10000, application-scoped, defaulting to DEFAULT_QUERY_LIMIT", () => {
    assert.deepEqual(manifest.contributes.configuration.properties["libredb.query.rowLimit"], ROW_LIMIT_SCHEMA);
    assert.equal(ROW_LIMIT_SCHEMA.default, DEFAULT_QUERY_LIMIT);
  });

  it("is limited in untrusted workspaces, with no restricted configuration", () => {
    assert.deepEqual(manifest.capabilities, {
      untrustedWorkspaces: { supported: "limited", description: "%untrustedWorkspaces.description%" },
    });
    assert.deepEqual(nls, {
      "untrustedWorkspaces.description":
        "In Restricted Mode, LibreDB opens every connection with external file access denied.",
    });
  });

  it("pins @tailwindcss/cli to the root's tailwindcss", () => {
    const rootTailwind = /"tailwindcss@(\d+\.\d+\.\d+)"/.exec(readFileSync(join(root, "../bun.lock"), "utf8"));
    assert.ok(rootTailwind, "the root bun.lock resolves no tailwindcss");
    assert.equal(manifest.devDependencies["@tailwindcss/cli"], rootTailwind[1]);
  });

  it("pins @playwright/test to the root's, so the browser leg shares the root's Chromium", () => {
    const rootPlaywright = /"@playwright\/test@(\d+\.\d+\.\d+)"/.exec(readFileSync(join(root, "../bun.lock"), "utf8"));
    assert.ok(rootPlaywright, "the root bun.lock resolves no @playwright/test");
    assert.equal(manifest.devDependencies["@playwright/test"], rootPlaywright[1]);
  });

  it("runs the browser leg through its own Playwright config", () => {
    assert.equal(manifest.scripts["test:browser"], "playwright test -c playwright.config.mjs");
  });

  it("pins @happy-dom/global-registrator to the major of the root's happy-dom", () => {
    const rootHappyDom = /"happy-dom@(\d+)\.\d+\.\d+"/.exec(readFileSync(join(root, "../bun.lock"), "utf8"));
    assert.ok(rootHappyDom, "the root bun.lock resolves no happy-dom");
    assert.equal(manifest.devDependencies["@happy-dom/global-registrator"].split(".")[0], rootHappyDom[1]);
  });

  it("is private, MIT, and loads dist/extension.js", () => {
    assert.equal(manifest.private, true);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.main, "./dist/extension.js");
  });
});
