import assert from "node:assert/strict";
import type { Container, DatabaseObject, KindCount, ObjectDetail } from "@/lib/db/types";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import type { BackendCrash, BackendState } from "../../../src/host/backend-supervisor";
import { CredentialsNotGivenError } from "../../../src/host/connections/connection-source";
import type { ConnectionsChange } from "../../../src/host/connections/connection-store";
import type { ProfileItem } from "../../../src/host/connections/profile";
import { OpenConnections } from "../../../src/host/open-connections";
import { BACKEND_STOPPED_DURING_READ, ConnectionsTree } from "../../../src/host/tree/connections-tree";
import { EngineIcons } from "../../../src/host/tree/icons";
import { nodeId, type TreeNode } from "../../../src/host/tree/nodes";
import type { ProviderDescription } from "../../../src/protocol";
import { CATALOG_SESSIONS, ONE_LEVEL, TWO_LEVELS, ZERO_LEVELS } from "../../fakes/descriptions";
import { MONGO, PG } from "../../fakes/profiles";
import { EventEmitter, progressRuns, shownMessages, TreeItemCollapsibleState, Uri, window } from "../../fakes/vscode";

type Method = "ensureOpen" | "listContainers" | "countObjects" | "listObjects" | "describeObject";
type Call = [Method, unknown];
/** A scripted answer: a value, or a function of the params that answers or throws. */
type Script = (params: unknown) => unknown;

const VALID_PG: ProfileItem = { kind: "valid", entry: PG };
const VALID_MONGO: ProfileItem = { kind: "valid", entry: MONGO };

const PUBLIC: Container = { path: ["public"], name: "public", level: 0, isSessionDefault: true };
const SALES: Container = { path: ["sales"], name: "sales", level: 0 };
const ORDERS: DatabaseObject = { path: ["public", "orders"], name: "orders", kind: "table" };
const V1: DatabaseObject = { path: ["public", "v1"], name: "v1", kind: "view" };
const COLUMNS = [
  { name: "id", type: "integer", nullable: false, isPrimary: true },
  { name: "label", type: "text", nullable: true, isPrimary: false },
];

/**
 * A tree over a scripted store, client and link: the fake ensureOpen records the description its script names for the
 * id at the link's generation, as BackendClient does.
 */
function setup(items: ProfileItem[] = [VALID_PG, VALID_MONGO]) {
  const store = { items, changes: new EventEmitter<ConnectionsChange>() };
  const opened = new OpenConnections();
  const link = { generation: 1, state: "ready" as BackendState, crashes: new EventEmitter<BackendCrash>() };
  const calls: Call[] = [];
  const descriptions: Record<string, ProviderDescription> = { [PG.id]: ONE_LEVEL, [MONGO.id]: ZERO_LEVELS };
  const scripts: Partial<Record<Method, Script>> = {};
  const answer = (method: Method, params: unknown): Promise<unknown> => {
    calls.push([method, params]);
    const script = scripts[method];
    if (script === undefined) return Promise.reject(new Error(`no script for ${method}`));
    return Promise.resolve().then(() => script(params));
  };
  const client = {
    ensureOpen: (connectionId: string) =>
      answer("ensureOpen", connectionId).then(() => {
        opened.record(connectionId, link.generation, descriptions[connectionId]);
        return descriptions[connectionId];
      }),
    listContainers: (params: unknown) => answer("listContainers", params) as Promise<Container[]>,
    countObjects: (params: unknown) => answer("countObjects", params) as Promise<Record<string, KindCount>>,
    listObjects: (params: unknown) => answer("listObjects", params) as Promise<DatabaseObject[]>,
    describeObject: (params: unknown) => answer("describeObject", params) as Promise<ObjectDetail>,
  };
  scripts.ensureOpen = () => undefined;
  scripts.listContainers = () => [PUBLIC, SALES];
  scripts.countObjects = () => ({});
  scripts.listObjects = () => [ORDERS];
  scripts.describeObject = () => ({ path: ORDERS.path, columns: COLUMNS, indexes: [] });
  const icons = new EngineIcons(Uri.file("/ext"), { postgres: { label: "PostgreSQL" }, mongodb: { label: "MongoDB" } });
  const tree = new ConnectionsTree({
    store: { list: () => store.items, onDidChange: store.changes.event },
    client,
    opened,
    link: {
      get generation() {
        return link.generation;
      },
      get state() {
        return link.state;
      },
      onDidCrash: link.crashes.event,
    },
    icons,
    window,
  });
  const fired: (TreeNode | undefined)[] = [];
  tree.onDidChangeTreeData((node) => fired.push(node));
  return { tree, store, opened, link, calls, descriptions, scripts, fired };
}

type Setup = ReturnType<typeof setup>;

/** The node of the id among a node's children, expanding it; throws when it is not there. */
async function child(tree: ConnectionsTree, parent: TreeNode | undefined, id: string): Promise<TreeNode> {
  const found = (await tree.getChildren(parent)).find((node) => node.id === id);
  if (found === undefined) throw new Error(`no child ${id}`);
  return found;
}

const ids = (nodes: readonly TreeNode[]) => nodes.map((node) => node.id);
const PG_NODE = nodeId("c", [PG.id]);
const MONGO_NODE = nodeId("c", [MONGO.id]);

/** PG's public schema on ONE_LEVEL, read through the root and the connection. */
async function publicSchema({ tree }: Setup): Promise<TreeNode> {
  const pg = await child(tree, undefined, PG_NODE);
  return await child(tree, pg, nodeId("k", [PG.id, "public"]));
}

/** PG's Tables folder under public on ONE_LEVEL. */
async function tablesFolder(context: Setup): Promise<TreeNode> {
  return await child(context.tree, await publicSchema(context), nodeId("f", [PG.id, "public", "table"]));
}

function only<T extends TreeNode["node"]>(nodes: readonly TreeNode[], node: T): Extract<TreeNode, { node: T }> {
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node, node);
  return nodes[0] as Extract<TreeNode, { node: T }>;
}

describe("ConnectionsTree's reads", () => {
  describe("the root", () => {
    it("lists a connection node per valid item and an invalid node per invalid one, in order, with no backend call", async () => {
      const { tree, calls } = setup([
        VALID_PG,
        { kind: "invalid", reason: "R", id: "bad1", name: "bad" },
        { kind: "invalid", reason: "S" },
        VALID_MONGO,
      ]);
      const root = await tree.getChildren();
      assert.deepEqual(ids(root), ["c/1kq2v7x93j0ab", "i/1", "i/2", "c/3f9wz0c1m2rt"]);
      assert.deepEqual(root[1], { id: "i/1", node: "invalid", connectionId: "bad1", name: "bad", reason: "R" });
      assert.deepEqual(root[2], { id: "i/2", node: "invalid", reason: "S" });
      assert.deepEqual(await tree.getChildren(root[1]), []);
      assert.deepEqual(calls, []);
      assert.deepEqual(progressRuns, []);
    });

    it("is empty with no saved connection", async () => {
      assert.deepEqual(await setup([]).tree.getChildren(), []);
    });
  });

  describe("one container level", () => {
    it("opens the connection and lists its schemas, each read inside the view's progress", async () => {
      const context = setup();
      const pg = await child(context.tree, undefined, PG_NODE);
      const schemas = await context.tree.getChildren(pg);
      assert.deepEqual(context.calls, [
        ["ensureOpen", PG.id],
        ["listContainers", { connectionId: PG.id }],
      ]);
      assert.deepEqual(ids(schemas), ["k/1kq2v7x93j0ab/public", "k/1kq2v7x93j0ab/sales"]);
      assert.deepEqual(
        schemas.map((node) => node.node === "container" && node.levelLabel),
        ["Schema", "Schema"],
      );
      assert.deepEqual(
        progressRuns.map((run) => run.options),
        [{ location: { viewId: "libredb.connections" } }],
      );
    });

    it("draws a schema's folders with their counts, a group for two kinds of one group, and no folder for a key-browser kind", async () => {
      const context = setup();
      context.scripts.countObjects = () => ({ table: { count: 3 }, function: { count: 2 } });
      const schema = await publicSchema(context);
      const folders = await context.tree.getChildren(schema);
      assert.deepEqual(context.calls.at(-1), ["countObjects", { connectionId: PG.id, container: ["public"] }]);
      assert.deepEqual(ids(folders), [
        "f/1kq2v7x93j0ab/public/table",
        "f/1kq2v7x93j0ab/public/view",
        "g/1kq2v7x93j0ab/public/programmability",
      ]);
      const [tables, views, group] = folders;
      assert.ok(tables.node === "folder" && views.node === "folder" && group.node === "group");
      assert.deepEqual(tables.count, { count: 3 });
      assert.equal(views.count, undefined);
      assert.equal(tables.parent, schema);
      const sent = context.calls.length;
      const routines = await context.tree.getChildren(group);
      assert.equal(context.calls.length, sent);
      assert.deepEqual(ids(routines), ["f/1kq2v7x93j0ab/public/function", "f/1kq2v7x93j0ab/public/procedure"]);
      assert.ok(routines[0].node === "folder" && routines[1].node === "folder");
      assert.deepEqual(routines[0].count, { count: 2 });
      assert.equal(routines[1].count, undefined);
      assert.equal(routines[0].parent, group);
    });

    it("draws no group where only one kind of it applies to the container", async () => {
      const context = setup();
      context.scripts.listContainers = () => [{ ...PUBLIC, kinds: ["table", "function"] }];
      const folders = await context.tree.getChildren(await publicSchema(context));
      assert.deepEqual(ids(folders), ["f/1kq2v7x93j0ab/public/table", "f/1kq2v7x93j0ab/public/function"]);
    });
  });

  it("draws the folders of the container [] on an engine with no container level", async () => {
    const context = setup();
    const mongo = await child(context.tree, undefined, MONGO_NODE);
    const folders = await context.tree.getChildren(mongo);
    assert.deepEqual(context.calls, [
      ["ensureOpen", MONGO.id],
      ["countObjects", { connectionId: MONGO.id, container: [] }],
    ]);
    assert.deepEqual(ids(folders), ["f/3f9wz0c1m2rt/table", "f/3f9wz0c1m2rt/view"]);
    assert.ok(folders[0].node === "folder");
    assert.deepEqual(folders[0].containerPath, []);
    assert.equal(folders[0].parent, mongo);
  });

  for (const [name, description] of [
    ["two container levels", TWO_LEVELS],
    ["two container levels with catalog sessions", CATALOG_SESSIONS],
  ] as const) {
    it(`reads ${name}: databases, then their schemas, then a schema's folders`, async () => {
      const context = setup();
      context.descriptions[PG.id] = description;
      context.scripts.listContainers = (params) =>
        (params as { parent?: string[] }).parent === undefined
          ? [{ path: ["shop"], name: "shop", level: 0 }]
          : [{ path: ["shop", "public"], name: "public", level: 1 }];
      const pg = await child(context.tree, undefined, PG_NODE);
      const shop = await child(context.tree, pg, "k/1kq2v7x93j0ab/shop");
      assert.ok(shop.node === "container");
      assert.equal(shop.levelLabel, "Database");
      const schema = await child(context.tree, shop, "k/1kq2v7x93j0ab/shop/public");
      assert.ok(schema.node === "container");
      assert.equal(schema.levelLabel, "Schema");
      assert.equal(schema.parent, shop);
      await context.tree.getChildren(schema);
      assert.deepEqual(context.calls.slice(1), [
        ["listContainers", { connectionId: PG.id }],
        ["listContainers", { connectionId: PG.id, parent: ["shop"] }],
        ["countObjects", { connectionId: PG.id, container: ["shop", "public"] }],
      ]);
    });
  }

  describe("objects and columns", () => {
    it("lists a folder's objects with their kind's role and label, and a twisty only for the folder's own kind", async () => {
      const context = setup();
      context.scripts.listObjects = () => [ORDERS, V1, { path: ["public", "q"], name: "q", kind: "queue" }];
      const folder = await tablesFolder(context);
      const objects = await context.tree.getChildren(folder);
      assert.deepEqual(context.calls.at(-1), [
        "listObjects",
        { connectionId: PG.id, container: ["public"], kind: "table" },
      ]);
      assert.deepEqual(ids(objects), [
        "o/1kq2v7x93j0ab/public/orders/table",
        "o/1kq2v7x93j0ab/public/v1/view",
        "o/1kq2v7x93j0ab/public/q/queue",
      ]);
      const [orders, v1, queue] = objects;
      assert.ok(orders.node === "object" && v1.node === "object" && queue.node === "object");
      assert.deepEqual([orders.role, orders.kindLabel, orders.hasColumns], ["relation", "Table", true]);
      assert.deepEqual([v1.role, v1.kindLabel, v1.hasColumns], ["relation", "View", false]);
      assert.deepEqual([queue.role, queue.kindLabel, queue.hasColumns], [undefined, "queue", false]);
      assert.equal(orders.parent, folder);
    });

    it("describes an object for its columns", async () => {
      const context = setup();
      const folder = await tablesFolder(context);
      const orders = await child(context.tree, folder, "o/1kq2v7x93j0ab/public/orders/table");
      const columns = await context.tree.getChildren(orders);
      assert.deepEqual(context.calls.at(-1), [
        "describeObject",
        { connectionId: PG.id, path: ["public", "orders"], kind: "table" },
      ]);
      assert.deepEqual(ids(columns), [
        "l/1kq2v7x93j0ab/public/orders/table/id",
        "l/1kq2v7x93j0ab/public/orders/table/label",
      ]);
      assert.ok(columns[0].node === "column");
      assert.deepEqual(columns[0].column, COLUMNS[0]);
      assert.equal(columns[0].parent, orders);
      assert.deepEqual(await context.tree.getChildren(columns[0]), []);
    });
  });

  describe("empty answers (criterion 6)", () => {
    it("answers No <kind plural> for an empty listing", async () => {
      const context = setup();
      context.scripts.listObjects = () => [];
      const folder = await tablesFolder(context);
      const empty = only(await context.tree.getChildren(folder), "empty");
      assert.equal(empty.id, nodeId("n", [folder.id]));
      assert.equal(empty.label, "No Tables");
      assert.deepEqual(await context.tree.getChildren(empty), []);
    });

    it("answers No <next level's plural> for an empty container listing", async () => {
      const context = setup();
      context.descriptions[PG.id] = TWO_LEVELS;
      context.scripts.listContainers = () => [];
      const pg = await child(context.tree, undefined, PG_NODE);
      assert.equal(only(await context.tree.getChildren(pg), "empty").label, "No Databases");
    });

    it("answers No columns reported for a describe with no columns", async () => {
      const context = setup();
      context.scripts.describeObject = () => ({ path: ORDERS.path, columns: [], indexes: [] });
      const orders = await child(context.tree, await tablesFolder(context), "o/1kq2v7x93j0ab/public/orders/table");
      assert.equal(only(await context.tree.getChildren(orders), "empty").label, "No columns reported");
    });
  });

  describe("failed reads (criterion 7)", () => {
    it("answers one error node with the whole message and the code of a refused listing", async () => {
      const context = setup();
      context.scripts.listObjects = () => {
        throw new BackendError(500, "QUERY_ERROR", 'relation "x" does not exist\nLINE 1');
      };
      const folder = await tablesFolder(context);
      const error = only(await context.tree.getChildren(folder), "error");
      assert.equal(error.id, nodeId("x", [folder.id]));
      assert.equal(error.message, 'relation "x" does not exist\nLINE 1');
      assert.equal(error.code, "QUERY_ERROR");
      assert.equal(error.connectionId, PG.id);
      assert.equal(error.parent, folder);
      assert.deepEqual(await context.tree.getChildren(error), []);
    });

    it("answers an error without a code for a refusal that carries none", async () => {
      const context = setup();
      context.scripts.listObjects = () => {
        throw new BackendError(400, null, "Invalid params");
      };
      const error = only(await context.tree.getChildren(await tablesFolder(context)), "error");
      assert.equal(error.message, "Invalid params");
      assert.equal(error.code, undefined);
    });

    it("puts one error node above the folders when the counts are refused, and draws the folders without counts", async () => {
      const context = setup();
      context.scripts.countObjects = () => {
        throw new BackendError(500, "QUERY_ERROR", "permission denied");
      };
      const nodes = await context.tree.getChildren(await publicSchema(context));
      assert.deepEqual(
        nodes.map((node) => node.node),
        ["error", "folder", "folder", "group"],
      );
      assert.ok(nodes[0].node === "error" && nodes[1].node === "folder" && nodes[3].node === "group");
      assert.equal(nodes[0].message, "permission denied");
      assert.equal(nodes[1].count, undefined);
      assert.equal(nodes[3].counts, undefined);
    });

    it("answers the backend-stopped sentence when the child exits during a read", async () => {
      const context = setup();
      context.scripts.describeObject = () => {
        throw new BackendExitedError({ exitCode: null, signal: "SIGKILL" });
      };
      const orders = await child(context.tree, await tablesFolder(context), "o/1kq2v7x93j0ab/public/orders/table");
      const error = only(await context.tree.getChildren(orders), "error");
      assert.equal(error.message, "The LibreDB backend stopped while this was read.");
      assert.equal(error.message, BACKEND_STOPPED_DURING_READ);
      assert.equal(error.code, undefined);
    });

    it("refuses to read below a connection that has no recorded description", async () => {
      const context = setup();
      const schema = await publicSchema(context);
      context.opened.forget(PG.id);
      const error = only(await context.tree.getChildren(schema), "error");
      assert.equal(error.message, "1kq2v7x93j0ab has no recorded provider description.");
    });
  });

  describe("opening a connection", () => {
    for (const refusal of [
      new BackendError(503, "CONNECTION_ERROR", "connect ECONNREFUSED 127.0.0.1:5432"),
      new BackendError(
        400,
        "CONFIG_ERROR",
        "The oracle provider is not available in this distribution of LibreDB Studio.",
      ),
    ]) {
      it(`marks the connection failed and answers the error of a refused open: ${refusal.code}`, async () => {
        const context = setup();
        context.scripts.ensureOpen = () => {
          throw refusal;
        };
        const pg = await child(context.tree, undefined, PG_NODE);
        const error = only(await context.tree.getChildren(pg), "error");
        assert.equal(error.message, refusal.message);
        assert.equal(error.code, refusal.code);
        assert.equal(context.tree.getTreeItem(pg).description, "connection failed");
      });
    }

    for (const failure of [
      new BackendError(503, "CONNECTION_ERROR", "connect ECONNREFUSED 127.0.0.1:5432"),
      new BackendExitedError({ exitCode: null, signal: "SIGKILL" }),
    ]) {
      it(`fires the connection's node when its open fails, so the view draws connection failed: ${failure.name}`, async () => {
        const context = setup();
        context.scripts.ensureOpen = () => {
          throw failure;
        };
        const pg = await child(context.tree, undefined, PG_NODE);
        context.fired.length = 0;
        only(await context.tree.getChildren(pg), "error");
        assert.deepEqual(context.fired, [pg]);
        assert.equal(context.tree.getTreeItem(pg).description, "connection failed");
      });
    }

    it("answers no children and marks nothing when the person declines the credentials", async () => {
      const context = setup();
      context.scripts.ensureOpen = () => {
        throw new CredentialsNotGivenError("shop");
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      assert.deepEqual(await context.tree.getChildren(pg), []);
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
      assert.deepEqual(shownMessages, []);
    });

    it("answers the refused open's error when the person declines Enter Credentials after it (criterion 7, D387)", async () => {
      const context = setup();
      const refusal = new BackendError(503, "CONNECTION_ERROR", 'database "shop" does not exist');
      context.scripts.ensureOpen = () => {
        throw new CredentialsNotGivenError("shop", refusal);
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      context.fired.length = 0;
      const error = only(await context.tree.getChildren(pg), "error");
      assert.equal(error.message, refusal.message);
      assert.equal(error.code, refusal.code);
      assert.deepEqual(context.fired, [pg]);
      assert.equal(context.tree.getTreeItem(pg).description, "connection failed");
    });

    it("shows connected while the open is in the link's current generation and the link is ready", async () => {
      const context = setup();
      const pg = await child(context.tree, undefined, PG_NODE);
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
      await context.tree.getChildren(pg);
      const item = context.tree.getTreeItem(pg);
      assert.equal(item.description, "connected");
      assert.equal(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
      context.link.state = "restarting";
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
      context.link.state = "ready";
      context.link.generation = 2;
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
    });

    it("gives every other node its item with no connection state", async () => {
      const context = setup();
      const schema = await publicSchema(context);
      assert.equal(context.tree.getTreeItem(schema).description, "Schema");
      const [, invalid] = await setup([VALID_PG, { kind: "invalid", reason: "R" }]).tree.getChildren();
      assert.equal(context.tree.getTreeItem(invalid).description, "invalid");
    });
  });

  it("answers each node's parent, so TreeView.reveal works", async () => {
    const context = setup();
    context.descriptions[PG.id] = { ...ONE_LEVEL };
    const pg = await child(context.tree, undefined, PG_NODE);
    const schema = await child(context.tree, pg, "k/1kq2v7x93j0ab/public");
    const [tables, , group] = await context.tree.getChildren(schema);
    const [functions] = await context.tree.getChildren(group);
    const orders = await child(context.tree, tables, "o/1kq2v7x93j0ab/public/orders/table");
    const [id] = await context.tree.getChildren(orders);
    assert.equal(context.tree.getParent(id), orders);
    assert.equal(context.tree.getParent(orders), tables);
    assert.equal(context.tree.getParent(functions), group);
    assert.equal(context.tree.getParent(tables), schema);
    assert.equal(context.tree.getParent(group), schema);
    assert.equal(context.tree.getParent(schema), pg);
    assert.equal(context.tree.getParent(pg), undefined);
    const [, invalid] = await setup([VALID_PG, { kind: "invalid", reason: "R" }]).tree.getChildren();
    assert.equal(context.tree.getParent(invalid), undefined);

    const two = setup();
    two.descriptions[PG.id] = TWO_LEVELS;
    two.scripts.listContainers = (params) =>
      (params as { parent?: string[] }).parent === undefined
        ? [{ path: ["shop"], name: "shop", level: 0 }]
        : [{ path: ["shop", "public"], name: "public", level: 1 }];
    const pg2 = await child(two.tree, undefined, PG_NODE);
    const shop = await child(two.tree, pg2, "k/1kq2v7x93j0ab/shop");
    const nested = await child(two.tree, shop, "k/1kq2v7x93j0ab/shop/public");
    assert.equal(two.tree.getParent(nested), shop);
    assert.equal(two.tree.getParent(shop), pg2);
  });
});

/** A promise with its settle functions, for a read a case keeps in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Lets every queued microtask and timer of the fakes run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const sent = (calls: readonly Call[], method: Method) => calls.filter(([name]) => name === method).length;

describe("ConnectionsTree's cache, refresh and events", () => {
  describe("the cache (criterion 8)", () => {
    it("shares one read between concurrent expands and answers later ones from the cache", async () => {
      const context = setup();
      const folder = await tablesFolder(context);
      const listing = deferred<DatabaseObject[]>();
      context.scripts.listObjects = () => listing.promise;
      const first = context.tree.getChildren(folder);
      const second = context.tree.getChildren(folder);
      listing.resolve([ORDERS]);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a, b);
      assert.equal(sent(context.calls, "listObjects"), 1);
      assert.equal(await context.tree.getChildren(folder), a);
      assert.equal(sent(context.calls, "listObjects"), 1);
    });

    it("never shows an answer read before a refresh: its caller gets the newer read", async () => {
      const context = setup();
      const folder = await tablesFolder(context);
      const older = deferred<DatabaseObject[]>();
      const newer = deferred<DatabaseObject[]>();
      const listings = [older, newer];
      context.scripts.listObjects = () => (listings.shift() as typeof older).promise;
      const first = context.tree.getChildren(folder);
      await settle();
      context.tree.refresh(folder);
      const second = context.tree.getChildren(folder);
      await settle();
      newer.resolve([{ ...ORDERS, name: "orders2", path: ["public", "orders2"] }]);
      assert.deepEqual(ids(await second), ["o/1kq2v7x93j0ab/public/orders2/table"]);
      older.resolve([{ ...ORDERS, name: "orders1", path: ["public", "orders1"] }]);
      assert.deepEqual(ids(await first), ["o/1kq2v7x93j0ab/public/orders2/table"]);
      assert.deepEqual(ids(await context.tree.getChildren(folder)), ["o/1kq2v7x93j0ab/public/orders2/table"]);
      assert.equal(sent(context.calls, "listObjects"), 2);
    });
  });

  describe("refresh on a node", () => {
    it("on a folder, reads its listing and its objects' columns again, and keeps the container's counts", async () => {
      const context = setup();
      const schema = await publicSchema(context);
      const folder = await child(context.tree, schema, "f/1kq2v7x93j0ab/public/table");
      const orders = await child(context.tree, folder, "o/1kq2v7x93j0ab/public/orders/table");
      await context.tree.getChildren(orders);
      context.fired.length = 0;
      context.tree.refresh(folder);
      assert.deepEqual(context.fired, [folder]);
      await context.tree.getChildren(schema);
      const again = await child(context.tree, folder, "o/1kq2v7x93j0ab/public/orders/table");
      await context.tree.getChildren(again);
      assert.equal(sent(context.calls, "countObjects"), 1);
      assert.equal(sent(context.calls, "listObjects"), 2);
      assert.equal(sent(context.calls, "describeObject"), 2);
    });

    it("on a container, reads its counts again", async () => {
      const context = setup();
      const schema = await publicSchema(context);
      await context.tree.getChildren(schema);
      context.tree.refresh(schema);
      await context.tree.getChildren(schema);
      assert.equal(sent(context.calls, "countObjects"), 2);
    });

    it("on a connection whose open failed, clears connection failed and opens it again on the next expand", async () => {
      const context = setup();
      context.scripts.ensureOpen = () => {
        throw new BackendError(503, "CONNECTION_ERROR", "connect ECONNREFUSED 127.0.0.1:5432");
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      await context.tree.getChildren(pg);
      await context.tree.getChildren(pg);
      assert.equal(sent(context.calls, "ensureOpen"), 1);
      context.tree.refresh(pg);
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
      context.scripts.ensureOpen = () => undefined;
      assert.deepEqual(ids(await context.tree.getChildren(pg)), ["k/1kq2v7x93j0ab/public", "k/1kq2v7x93j0ab/sales"]);
      assert.equal(sent(context.calls, "ensureOpen"), 2);
    });

    it("keeps a declined open's empty answer until Refresh on the node asks again", async () => {
      const context = setup();
      context.scripts.ensureOpen = () => {
        throw new CredentialsNotGivenError("shop");
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      await context.tree.getChildren(pg);
      assert.deepEqual(await context.tree.getChildren(pg), []);
      assert.equal(sent(context.calls, "ensureOpen"), 1);
      context.tree.refresh(pg);
      await context.tree.getChildren(pg);
      assert.equal(sent(context.calls, "ensureOpen"), 2);
    });

    it("on a folder whose listing failed, answers the objects the next read finds (criterion 7)", async () => {
      const context = setup();
      let refusals = 1;
      context.scripts.listObjects = () => {
        if (refusals-- > 0) throw new BackendError(500, "QUERY_ERROR", "timeout");
        return [ORDERS];
      };
      const folder = await tablesFolder(context);
      only(await context.tree.getChildren(folder), "error");
      context.tree.refresh(folder);
      assert.deepEqual(ids(await context.tree.getChildren(folder)), ["o/1kq2v7x93j0ab/public/orders/table"]);
    });
  });

  describe("refresh of the whole tree", () => {
    it("fires undefined, sends nothing, reads every level again on the next expands, with the same ids (criterion 9)", async () => {
      const context = setup();
      const before: string[] = [];
      const walk = async (into: string[]) => {
        const pg = await child(context.tree, undefined, PG_NODE);
        const schemas = await context.tree.getChildren(pg);
        const folders = await context.tree.getChildren(schemas[0]);
        const objects = await context.tree.getChildren(folders[0]);
        const columns = await context.tree.getChildren(objects[0]);
        into.push(...ids([pg, ...schemas, ...folders, ...objects, ...columns]));
      };
      await walk(before);
      const calls = context.calls.length;
      context.fired.length = 0;
      context.tree.refresh();
      assert.deepEqual(context.fired, [undefined]);
      assert.equal(context.calls.length, calls);
      const after: string[] = [];
      await walk(after);
      assert.deepEqual(after, before);
      assert.deepEqual(
        context.calls.slice(calls).map(([method]) => method),
        ["ensureOpen", "listContainers", "countObjects", "listObjects", "describeObject"],
      );
    });

    it("clears every connection failed mark", async () => {
      const context = setup();
      context.scripts.ensureOpen = () => {
        throw new BackendError(503, "CONNECTION_ERROR", "refused");
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      await context.tree.getChildren(pg);
      context.tree.refresh();
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
    });
  });

  describe("store changes (part 2 criterion 19)", () => {
    for (const label of ["a field change", "a secret change"]) {
      it(`drops a changed connection's subtree, even with a read in flight, and keeps the others: ${label}`, async () => {
        const context = setup();
        const mongo = await child(context.tree, undefined, MONGO_NODE);
        await context.tree.getChildren(mongo);
        const listing = deferred<Container[]>();
        context.scripts.listContainers = () => listing.promise;
        const pg = await child(context.tree, undefined, PG_NODE);
        const inFlight = context.tree.getChildren(pg);
        await settle();
        context.fired.length = 0;
        context.store.changes.fire({ added: [], removed: [], changed: [PG.id] });
        assert.deepEqual(context.fired, [undefined]);
        context.scripts.listContainers = () => [SALES];
        listing.resolve([PUBLIC]);
        assert.deepEqual(ids(await inFlight), ["k/1kq2v7x93j0ab/sales"]);
        assert.deepEqual(
          context.calls
            .filter(([, params]) => params === PG.id || (params as { connectionId?: string }).connectionId === PG.id)
            .map(([method]) => method),
          ["ensureOpen", "listContainers", "ensureOpen", "listContainers"],
        );
        const calls = context.calls.length;
        await context.tree.getChildren(mongo);
        assert.equal(context.calls.length, calls);
      });
    }

    it("drops a removed connection from the root, and lists an added one with no read", async () => {
      const context = setup();
      context.store.items = [VALID_MONGO];
      context.store.changes.fire({ added: [], removed: [PG.id], changed: [] });
      assert.deepEqual(ids(await context.tree.getChildren()), [MONGO_NODE]);
      const added = { ...PG, id: "n1" };
      context.store.items = [VALID_MONGO, { kind: "valid", entry: added }];
      context.store.changes.fire({ added: ["n1"], removed: [], changed: [] });
      assert.deepEqual(ids(await context.tree.getChildren()), [MONGO_NODE, "c/n1"]);
      assert.deepEqual(context.fired, [undefined, undefined]);
      assert.deepEqual(context.calls, []);
    });

    it("clears a changed connection's failure mark", async () => {
      const context = setup();
      context.scripts.ensureOpen = () => {
        throw new BackendError(503, "CONNECTION_ERROR", "refused");
      };
      const pg = await child(context.tree, undefined, PG_NODE);
      await context.tree.getChildren(pg);
      context.store.changes.fire({ added: [], removed: [], changed: [PG.id] });
      assert.equal(context.tree.getTreeItem(pg).description, undefined);
    });
  });

  it("on a crash, fires undefined and drops nothing; connected follows the generation", async () => {
    const context = setup();
    const pg = await child(context.tree, undefined, PG_NODE);
    const schemas = await context.tree.getChildren(pg);
    assert.equal(context.tree.getTreeItem(pg).description, "connected");
    const calls = context.calls.length;
    context.fired.length = 0;
    context.link.generation = 2;
    context.link.crashes.fire({ exit: { exitCode: 1, signal: null }, generation: 1 });
    assert.deepEqual(context.fired, [undefined]);
    assert.equal(await context.tree.getChildren(pg), schemas);
    assert.equal(context.calls.length, calls);
    assert.equal(context.tree.getTreeItem(pg).description, undefined);
    context.opened.record(MONGO.id, 2, ZERO_LEVELS);
    assert.deepEqual(context.fired, [undefined, undefined]);
  });

  it("stays responsive while an open never answers, then shows the engine's sentence (the controller's ruling)", async () => {
    const context = setup();
    const open = deferred<undefined>();
    context.scripts.ensureOpen = (id) => (id === PG.id ? open.promise : undefined);
    const pg = await child(context.tree, undefined, PG_NODE);
    const hanging = context.tree.getChildren(pg);
    await settle();
    assert.deepEqual(ids(await context.tree.getChildren()), [PG_NODE, MONGO_NODE]);
    const item = context.tree.getTreeItem(pg);
    assert.equal(item.description, undefined);
    assert.equal(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
    const mongo = await child(context.tree, undefined, MONGO_NODE);
    assert.deepEqual(ids(await context.tree.getChildren(mongo)), ["f/3f9wz0c1m2rt/table", "f/3f9wz0c1m2rt/view"]);
    context.tree.refresh(mongo);
    assert.equal(progressRuns[0].settled, false);
    open.reject(new BackendError(503, "CONNECTION_ERROR", "connect ETIMEDOUT 10.255.255.1:5432"));
    assert.equal(only(await hanging, "error").message, "connect ETIMEDOUT 10.255.255.1:5432");
    assert.equal(context.tree.getTreeItem(pg).description, "connection failed");
    assert.equal(progressRuns[0].settled, true);
  });

  describe("revealConnection (part 2 criterion 14)", () => {
    it("refuses before the view is attached", async () => {
      await assert.rejects(setup().tree.revealConnection(PG.id), {
        message: "The Connections view is not created yet.",
      });
    });

    it("selects the connection's node, collapsed and without focus, and refuses an id the store does not hold", async () => {
      const context = setup();
      const revealed: [TreeNode, unknown][] = [];
      context.tree.attach({
        reveal: async (node, options) => {
          revealed.push([node, options]);
        },
      });
      await context.tree.revealConnection(PG.id);
      assert.equal(revealed.length, 1);
      assert.equal(revealed[0][0].id, "c/1kq2v7x93j0ab");
      assert.deepEqual(revealed[0][1], { select: true, focus: false, expand: false });
      await assert.rejects(context.tree.revealConnection("missing"), {
        message: "The connection missing is no longer in libredb.connections.",
      });
    });
  });

  it("fires nothing once disposed", async () => {
    const context = setup();
    context.tree.dispose();
    context.store.changes.fire({ added: [], removed: [], changed: [PG.id] });
    context.link.crashes.fire({ exit: { exitCode: 1, signal: null }, generation: 1 });
    context.opened.record(PG.id, 1, ONE_LEVEL);
    assert.deepEqual(context.fired, []);
  });
});
