// The Connections tree against the four v0 engines (part 3, "Tests", the integration leg): the real store, source,
// client, OpenConnections, EngineIcons and ConnectionsTree over one forked dist/backend.js, with the fake vscode, so
// every expand opens through the profile setting and SecretStorage as it does in the host. PR 11 adds the editor cases.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applicableKinds, declaredLevels, enumerableKinds } from "@/lib/db/object-kinds";
import type { KindCount } from "@/lib/db/types";
import { BackendClient } from "../../src/host/backend-client";
import type { BackendCrash, BackendLink } from "../../src/host/backend-supervisor";
import { ENTER_CREDENTIALS, ProfileConnectionSource } from "../../src/host/connections/connection-source";
import { ConnectionStore } from "../../src/host/connections/connection-store";
import type { ProfileEntry } from "../../src/host/connections/profile";
import { OpenConnections } from "../../src/host/open-connections";
import { ConnectionsTree } from "../../src/host/tree/connections-tree";
import { EngineIcons, readEngineIndex } from "../../src/host/tree/icons";
import { nodeId, type TreeNode } from "../../src/host/tree/nodes";
import { countPresentation } from "../../src/host/tree/tree-items";
import {
  EXIT_NOTIFICATION,
  type InitializeResult,
  METHODS,
  type OpenResult,
  type TestConnectionResult,
  type WireConnection,
} from "../../src/protocol";
import { type BackendSession, openSession } from "../backend-session";
import { FakeSetting } from "../fakes/connections-setting";
import { MemorySecretStorage } from "../fakes/secret-storage";
import {
  shownInputBoxes,
  shownMessages,
  ThemeIcon,
  TreeItemCollapsibleState,
  Uri,
  window,
  workspace,
} from "../fakes/vscode";
import { type EngineService, psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "./containers";
import { ENGINES, type EngineFixture, engineFixture } from "./engines";
import { backendRuntime, forkBackend } from "./runtime";

const EXTENSION_ROOT = join(__dirname, "..", "..");
const POSTURE = { allowExternalFileAccess: false };

/** Tables whose names need quoting in PostgreSQL's public schema (Review Focus 3's tree half). */
const QUOTED_NAMES = ["a/b", "p%q", "a.b", "order", 'a"b', "çay"];
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Statements beside each fixture's setup, run on its main connection before the tree is built. */
const TREE_SETUP: Readonly<Record<EngineService, readonly string[]>> = {
  postgres: [
    "create table it_tree_pk (id int primary key, label varchar(20))",
    "create schema it_tree_empty",
    ...QUOTED_NAMES.map((name) => `create table ${quoted(name)} (n int)`),
  ],
  mssql: ["create table dbo.it_tree_pk (id int primary key, label varchar(20))"],
  mysql: ["create table libredb_it.it_tree_pk (id int primary key, label varchar(20))"],
  mongodb: [],
};

/** The profile id of each fixture's connection, and of PostgreSQL at server level. */
const profileId = (service: EngineService) => `it-tree-${service}`;
const PG_SERVER = "it-tree-pg-server";
const PG_LATER = "it-tree-pg-later";
const HANGING = "it-tree-hanging";

/** A wire connection as the setting keeps it: its password moved to secretFields and returned as its one secret. */
function profileOf(wire: WireConnection): { entry: ProfileEntry; secrets: Record<string, string> } {
  const { password, ...rest } = wire;
  if (password === undefined) return { entry: rest, secrets: {} };
  return { entry: { ...rest, secretFields: ["password"] }, secrets: { password } };
}

/** The wire connection without its database, PostgreSQL's server-level form. */
function withoutDatabase(wire: WireConnection): WireConnection {
  const copy = { ...wire };
  delete copy.database;
  return copy;
}

/** An event that never fires. */
const never =
  <T>(): ((listener: (event: T) => unknown) => { dispose(): void }) =>
  () => ({ dispose: () => {} });

type Node<T extends TreeNode["node"]> = Extract<TreeNode, { node: T }>;

describe("the Connections tree against PostgreSQL, SQL Server, MySQL and MongoDB", () => {
  let session: BackendSession | undefined;
  const engines = new Map<EngineService, RunningEngine>();
  let tree: ConnectionsTree;
  let client: BackendClient;
  let opened: OpenConnections;
  let store: ConnectionStore;

  const engineOf = (service: EngineService): RunningEngine => {
    const engine = engines.get(service);
    assert.ok(engine, `${service} is not running`);
    return engine;
  };
  const child = (): BackendSession => {
    assert.ok(session, "the child did not start");
    return session;
  };
  const running = (each: BackendSession): boolean => each.child.exitCode === null && each.child.signalCode === null;

  /** connection/test once a second until one succeeds within START_DEADLINE_MS. */
  async function waitForLogin(fixture: EngineFixture): Promise<void> {
    const started = Date.now();
    const connection = fixture.connection(engineOf(fixture.service), `${fixture.service}-ready`);
    for (;;) {
      try {
        await child().connection.sendRequest<TestConnectionResult>(METHODS.testConnection, {
          connection,
          posture: POSTURE,
        });
        return;
      } catch (error) {
        if (Date.now() - started > START_DEADLINE_MS) {
          throw new Error(`${fixture.service} refused every login for ${START_DEADLINE_MS} ms: ${error}`, {
            cause: error,
          });
        }
      }
      await delay(1000);
    }
  }

  /** Runs the fixture's setup and the tree's statements on a connection the test opens itself, outside the tree. */
  async function setUp(fixture: EngineFixture): Promise<void> {
    const id = `${fixture.service}-setup`;
    const connection = fixture.connection(engineOf(fixture.service), id);
    await child().connection.sendRequest<OpenResult>(METHODS.openConnection, { connection, posture: POSTURE });
    for (const statement of [...fixture.setup, ...TREE_SETUP[fixture.service]]) {
      await child().connection.sendRequest(METHODS.runQuery, {
        connectionId: id,
        queryId: randomUUID(),
        statement,
        limit: 500,
        offset: 0,
      });
    }
  }

  async function add(wire: WireConnection): Promise<void> {
    const { entry, secrets } = profileOf(wire);
    await store.add(entry, secrets);
  }

  const labelOf = (node: TreeNode): string => String(tree.getTreeItem(node).label);
  const labels = (nodes: readonly TreeNode[]): string => JSON.stringify(nodes.map(labelOf));

  async function connectionNode(id: string): Promise<Node<"connection">> {
    const found = (await tree.getChildren()).find((node) => node.id === nodeId("c", [id]));
    assert.ok(found?.node === "connection", `no connection node for ${id}`);
    return found;
  }

  /** The container reached by its names from a node, expanding each level on the way. */
  async function containerAt(from: TreeNode, path: readonly string[]): Promise<Node<"container">> {
    let node: TreeNode = from;
    for (const name of path) {
      const children = await tree.getChildren(node);
      const found = children.find((each) => each.node === "container" && each.container.name === name);
      assert.ok(found?.node === "container", `no container ${name} under ${node.id}: ${labels(children)}`);
      node = found;
    }
    assert.equal(node.node, "container");
    return node as Node<"container">;
  }

  /** A container's folders, with each group's folders in its place; a group holds at least two. */
  async function foldersOf(container: TreeNode): Promise<Node<"folder">[]> {
    const folders: Node<"folder">[] = [];
    for (const node of await tree.getChildren(container)) {
      if (node.node === "folder") {
        folders.push(node);
      } else if (node.node === "group") {
        const members = await tree.getChildren(node);
        assert.ok(members.length >= 2, `the group ${node.group.label} holds ${labels(members)}`);
        for (const member of members) {
          assert.equal(member.node, "folder");
          folders.push(member as Node<"folder">);
        }
      } else {
        assert.fail(`${container.id} holds a ${node.node} node: ${labelOf(node)}`);
      }
    }
    return folders;
  }

  /** The object of the name in one of the container's folders, with that folder. */
  async function objectIn(
    container: TreeNode,
    name: string,
  ): Promise<{ folder: Node<"folder">; object: Node<"object"> }> {
    for (const folder of await foldersOf(container)) {
      const found = (await tree.getChildren(folder)).find(
        (node) => node.node === "object" && node.object.name === name,
      );
      if (found?.node === "object") return { folder, object: found };
    }
    assert.fail(`no folder of ${container.id} lists ${name}`);
  }

  const capabilitiesOf = (connectionId: string) => {
    const recorded = opened.get(connectionId);
    assert.ok(recorded, `${connectionId} has no recorded description`);
    return recorded.description.capabilities;
  };

  const iconId = (node: TreeNode): string | undefined => {
    const icon = tree.getTreeItem(node).iconPath;
    return icon instanceof ThemeIcon ? icon.id : undefined;
  };

  before(async function () {
    this.timeout(900_000);
    const runtime = await backendRuntime();
    console.log(`runtime ${runtime.name}: ${runtime.execPath}`);
    const runId = `${process.pid}-${Date.now()}`;
    const outcomes = await Promise.allSettled(
      ENGINES.map((fixture) => startEngine(fixture.service, runId, EXTENSION_ROOT)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") engines.set(outcome.value.service, outcome.value);
    }
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    session = openSession(forkBackend(runtime));
    const initialized: InitializeResult = await session.initialize();
    await Promise.all(ENGINES.map((fixture) => waitForLogin(fixture)));
    for (const fixture of ENGINES) await setUp(fixture);

    const connection = session.connection;
    const link: BackendLink & { onDidCrash: (listener: (crash: BackendCrash) => unknown) => { dispose(): void } } = {
      connection: async () => ({ connection, generation: 1, initialized }),
      generation: 1,
      state: "ready",
      lastExit: undefined,
      onWillStop: never<void>(),
      onDidCrash: never<BackendCrash>(),
      stop: async () => {},
    };
    store = new ConnectionStore({
      setting: new FakeSetting([]),
      secrets: new MemorySecretStorage(),
      log: window.createOutputChannel("LibreDB tree test", { log: true }),
    });
    opened = new OpenConnections();
    client = new BackendClient(link, new ProfileConnectionSource({ store, window, workspace }), opened);
    const index = readEngineIndex(readFileSync(join(EXTENSION_ROOT, "media", "engines", "index.json"), "utf8"));
    tree = new ConnectionsTree({
      store,
      client,
      opened,
      link,
      icons: new EngineIcons(Uri.file(EXTENSION_ROOT), index),
      window,
    });
    for (const fixture of ENGINES) {
      await add(fixture.connection(engineOf(fixture.service), profileId(fixture.service)));
    }
    await add(withoutDatabase(engineFixture("postgres").connection(engineOf("postgres"), PG_SERVER)));
  });

  after(async function () {
    this.timeout(120_000);
    try {
      tree?.dispose();
      store?.dispose();
      opened?.dispose();
      if (session !== undefined && running(session)) {
        const exited = once(session.child, "exit");
        await session.connection.sendRequest(METHODS.shutdown);
        await session.connection.sendNotification(EXIT_NOTIFICATION);
        await exited;
        session.connection.dispose();
      }
    } finally {
      await Promise.all([...engines.values()].map((engine) => stopEngine(engine)));
      engines.clear();
    }
  });

  /** Each fixture's profile, and PostgreSQL at server level, with the container path that holds it_four. */
  const LEVEL_CASES: readonly { title: string; service: EngineService; id: string; path: () => readonly string[] }[] = [
    ...ENGINES.map((fixture) => ({
      title: fixture.service,
      service: fixture.service,
      id: profileId(fixture.service),
      path: () => fixture.tableContainer,
    })),
    {
      title: "postgres at server level",
      service: "postgres",
      id: PG_SERVER,
      path: () => [engineOf("postgres").environment.POSTGRES_DB, "public"],
    },
  ];

  for (const { title, service, id, path } of LEVEL_CASES) {
    it(`draws ${title}'s declared levels, folders and it_four's count (criteria 3 and 4)`, async () => {
      const fixture = engineFixture(service);
      const connection = await connectionNode(id);
      const top = await tree.getChildren(connection);
      const capabilities = capabilitiesOf(id);
      const levels = declaredLevels(capabilities);
      console.log(`${title}: levels ${JSON.stringify(levels.map((level) => level.label))}, top ${labels(top)}`);
      assert.equal(tree.getTreeItem(connection).description, "connected");
      for (const node of top) {
        assert.equal(node.node, "container", `${title}'s top level holds a ${node.node}: ${labelOf(node)}`);
        assert.equal(tree.getTreeItem(node).description, levels[0].label);
      }

      // The levels written out, as part 3's table names them for these five connections.
      const env = engineOf(service).environment;
      const described = (nodes: readonly TreeNode[]) => nodes.map((node) => tree.getTreeItem(node).description);
      const names = (nodes: readonly TreeNode[]) =>
        nodes.flatMap((node) => (node.node === "container" ? [node.container.name] : []));
      if (id === PG_SERVER) {
        assert.ok(described(top).every((word) => word === "Database"));
        assert.ok(names(top).includes(env.POSTGRES_DB), names(top).join());
        const schemas = await tree.getChildren(await containerAt(connection, [env.POSTGRES_DB]));
        assert.ok(
          described(schemas).every((word) => word === "Schema"),
          labels(schemas),
        );
        assert.ok(names(schemas).includes("public"));
      } else if (service === "postgres") {
        assert.ok(described(top).every((word) => word === "Schema"));
        const publicNode = await containerAt(connection, ["public"]);
        assert.equal(tree.getTreeItem(publicNode).collapsibleState, TreeItemCollapsibleState.Expanded);
      } else if (service === "mysql") {
        // The compose file's MYSQL_DATABASE is mysql, a system schema the provider does not list, so the fixture's
        // own database stands for it.
        assert.ok(described(top).every((word) => word === "Database"));
        assert.ok(!names(top).includes(env.MYSQL_DATABASE), names(top).join());
        assert.ok(names(top).includes(fixture.tableContainer[0]), names(top).join());
      } else if (service === "mssql") {
        assert.ok(described(top).every((word) => word === "Database"));
        const schemas = await tree.getChildren(await containerAt(connection, [fixture.tableContainer[0]]));
        assert.ok(
          described(schemas).every((word) => word === "Schema"),
          labels(schemas),
        );
        assert.ok(names(schemas).includes("dbo"));
      } else {
        assert.ok(described(top).every((word) => word === "Database"));
        const folders = await foldersOf(await containerAt(connection, fixture.tableContainer));
        assert.deepEqual(folders.map(labelOf).sort(), ["Collections", "Views"]);
      }

      const container = await containerAt(connection, path());
      for (const [level, segment] of path().entries()) {
        const node = await containerAt(connection, path().slice(0, level + 1));
        assert.equal(tree.getTreeItem(node).description, levels[level].label, segment);
      }
      const folders = await foldersOf(container);
      const expected = applicableKinds(enumerableKinds(capabilities), container.container.kinds).map(
        (kind) => kind.labelPlural,
      );
      assert.deepEqual(folders.map(labelOf).sort(), [...expected].sort());

      const { folder } = await objectIn(container, fixture.tableName);
      const counts: Record<string, KindCount> = await client.countObjects({
        connectionId: id,
        container: container.container.path,
      });
      console.log(`${title}: ${folder.kind.id} counted ${JSON.stringify(counts[folder.kind.id])}`);
      assert.equal(tree.getTreeItem(folder).description, countPresentation(counts[folder.kind.id]).description);
      assert.deepEqual(shownInputBoxes, [], "the secrets the profile stored were read without a prompt");
    });
  }

  for (const service of ["postgres", "mssql", "mysql"] as const) {
    it(`draws ${service}'s it_tree_pk with its columns, the key one with the key icon (criterion 5)`, async () => {
      const fixture = engineFixture(service);
      const connection = await connectionNode(profileId(service));
      const { object } = await objectIn(await containerAt(connection, fixture.tableContainer), "it_tree_pk");
      assert.equal(tree.getTreeItem(object).collapsibleState, TreeItemCollapsibleState.Collapsed);
      const columns = await tree.getChildren(object);
      assert.deepEqual(columns.map(labelOf), ["id", "label"]);
      assert.deepEqual(columns.map(iconId), ["key", "symbol-field"]);
      for (const column of columns) {
        assert.equal(column.node, "column");
        const { type } = (column as Node<"column">).column;
        assert.ok(type.length > 0);
        assert.equal(tree.getTreeItem(column).description, type);
      }
      console.log(
        `${service}: it_tree_pk's column types ${JSON.stringify(columns.map((c) => tree.getTreeItem(c).description))}`,
      );
    });
  }

  it("draws a MongoDB collection's sampled fields as its columns (criterion 5)", async () => {
    const fixture = engineFixture("mongodb");
    const connection = await connectionNode(profileId("mongodb"));
    const { object } = await objectIn(await containerAt(connection, fixture.tableContainer), fixture.tableName);
    assert.equal(tree.getTreeItem(object).collapsibleState, TreeItemCollapsibleState.Collapsed);
    const fields = await tree.getChildren(object);
    assert.ok(
      fields.every((node) => node.node === "column"),
      labels(fields),
    );
    const names = fields.map(labelOf);
    assert.ok(names.includes("_id") && names.includes("n"), names.join());
    const id = fields.find((node) => labelOf(node) === "_id") as Node<"column">;
    console.log(`mongodb: it_four's fields ${JSON.stringify(fields.map((node) => (node as Node<"column">).column))}`);
    console.log(`mongodb: _id isPrimary is ${id.column.isPrimary}, so its icon is ${iconId(id)}`);
  });

  it("shows No <labelPlural> under an empty schema's table folder (criterion 6)", async () => {
    const connection = await connectionNode(profileId("postgres"));
    const { folder } = await objectIn(await containerAt(connection, ["public"]), "it_four");
    const empty = await containerAt(connection, ["it_tree_empty"]);
    const tables = (await foldersOf(empty)).find((each) => each.kind.id === folder.kind.id);
    assert.ok(tables, `it_tree_empty has no ${folder.kind.labelPlural} folder`);
    const children = await tree.getChildren(tables);
    assert.equal(children.length, 1);
    assert.equal(children[0].node, "empty");
    assert.equal(labelOf(children[0]), `No ${folder.kind.labelPlural}`);
  });

  it("gives names that need quoting distinct ids, labelled by name and stable across a refresh (criterion 9)", async () => {
    const read = async (): Promise<Map<string, string>> => {
      const connection = await connectionNode(profileId("postgres"));
      const { folder } = await objectIn(await containerAt(connection, ["public"]), "it_four");
      const objects = (await tree.getChildren(folder)).filter(
        (node): node is Node<"object"> => node.node === "object" && QUOTED_NAMES.includes(node.object.name),
      );
      return new Map(objects.map((node) => [labelOf(node), node.id]));
    };
    const first = await read();
    assert.deepEqual([...first.keys()].sort(), [...QUOTED_NAMES].sort());
    assert.equal(new Set(first.values()).size, QUOTED_NAMES.length);
    console.log(`postgres: quoted names' ids ${JSON.stringify([...first.values()])}`);
    tree.refresh();
    assert.deepEqual(await read(), first);
  });

  it("shows a failed open as one error node, and lists after the cause is fixed and the node refreshed (criterion 7)", async () => {
    const pg = engineOf("postgres");
    await add(engineFixture("postgres").connection(pg, PG_LATER, { database: "it_tree_later" }));
    const connection = await connectionNode(PG_LATER);
    const offered = shownMessages.length;
    const children = await tree.getChildren(connection);
    assert.equal(children.length, 1, labels(children));
    const [error] = children;
    assert.equal(error.node, "error");
    const { message, code } = error as Node<"error">;
    console.log(`postgres: the open of a missing database answered ${code}: ${message}`);
    // D387: the CONNECTION_ERROR offered Enter Credentials, which the fake window declines, and the node still shows why.
    assert.deepEqual(
      shownMessages.slice(offered).map((shown) => shown.items),
      [[ENTER_CREDENTIALS]],
    );
    assert.equal(labelOf(error), message.split("\n")[0]);
    assert.equal(tree.getTreeItem(connection).description, "connection failed");

    await psql(pg, "create database it_tree_later");
    tree.refresh(connection);
    const schemas = await tree.getChildren(connection);
    assert.ok(schemas.length > 0 && schemas.every((node) => node.node === "container"), labels(schemas));
    assert.ok(
      schemas.some((node) => labelOf(node) === "public"),
      labels(schemas),
    );
    assert.equal(tree.getTreeItem(connection).description, "connected");
  });

  it("stays responsive while an open never answers, then shows the engine's error (the controller's ruling)", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      await add({
        id: HANGING,
        name: "it hanging",
        type: "mysql",
        host: "127.0.0.1",
        port,
        user: "root",
        database: "libredb_it",
        createdAt: new Date(0).toISOString(),
      });
      const hanging = await connectionNode(HANGING);
      const started = Date.now();
      let settled: TreeNode[] | undefined;
      const pending = tree.getChildren(hanging).then((children) => {
        settled = children;
        return children;
      });

      await delay(500);
      assert.equal(settled, undefined, `the open answered at once: ${labels(settled ?? [])}`);
      const rootStarted = Date.now();
      await tree.getChildren();
      const rootMs = Date.now() - rootStarted;
      assert.ok(rootMs < 100, `the root took ${rootMs} ms`);
      const pg = await connectionNode(profileId("postgres"));
      tree.refresh(pg);
      const containers = await tree.getChildren(pg);
      assert.ok(containers.length > 0 && containers.every((node) => node.node === "container"), labels(containers));
      assert.equal(settled, undefined, "the hanging open settled before the PostgreSQL expand");

      const answer = await Promise.race([pending, delay(30_000).then(() => "timeout" as const)]);
      const elapsed = Date.now() - started;
      assert.notEqual(answer, "timeout", "the hanging open did not settle within 30 s");
      const children = answer as TreeNode[];
      assert.equal(children.length, 1, labels(children));
      assert.equal(children[0].node, "error");
      const { message, code } = children[0] as Node<"error">;
      console.log(`mysql: the never-answering open settled after ${elapsed} ms with ${code}: ${message}`);
      assert.ok(code !== undefined, "the error is not a BackendError's");
      assert.equal(labelOf(children[0]), message.split("\n")[0]);
      assert.equal(tree.getTreeItem(hanging).description, "connection failed");
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    }
  });
});
