// The Connections tree's data provider (part 3, "The Connections tree", "Levels", "Lazy loading, caching and refresh",
// "Empty, failed and refused reads"). Every engine fact comes from the ProviderDescription the connection's open
// answered, kept in OpenConnections and read through src/lib/db/object-kinds.ts, so no line here names an engine.
import * as vscode from "vscode";
import {
  applicableKinds,
  containerDepth,
  declaredLevels,
  enumerableKinds,
  findKind,
  kindGroup,
  kindHasColumns,
} from "@/lib/db/object-kinds";
import type { Container, KindCount, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";
import { type BackendClient, BackendError, BackendExitedError } from "../backend-client";
import type { BackendSupervisor } from "../backend-supervisor";
import { CredentialsNotGivenError } from "../connections/connection-source";
import { type ConnectionStore, type ConnectionsChange, UnknownConnectionError } from "../connections/connection-store";
import type { ProfileItem } from "../connections/profile";
import { CONNECTIONS_VIEW } from "../names";
import { isConnected, type OpenConnections } from "../open-connections";
import type { EngineIcons } from "./icons";
import { nodeId, type TreeNode } from "./nodes";
import { treeItemOf } from "./tree-items";

export interface TreeDeps {
  readonly store: Pick<ConnectionStore, "list" | "onDidChange">;
  readonly client: Pick<
    BackendClient,
    "ensureOpen" | "listContainers" | "countObjects" | "listObjects" | "describeObject"
  >;
  readonly opened: Pick<OpenConnections, "get" | "onDidChange">;
  readonly link: Pick<BackendSupervisor, "generation" | "state" | "onDidCrash">;
  readonly icons: EngineIcons;
  readonly window: Pick<typeof vscode.window, "withProgress">;
}

export const BACKEND_STOPPED_DURING_READ = "The LibreDB backend stopped while this was read.";
const NO_COLUMNS_REPORTED = "No columns reported";

type Node<T extends TreeNode["node"]> = Extract<TreeNode, { node: T }>;
interface CacheEntry {
  readonly children: Promise<TreeNode[]>;
  /** The children, once the read settled at its node's current epoch. */
  settled?: TreeNode[];
}

/** A node that has a parent and a connection: every node below a connection. */
type Parent = Exclude<TreeNode, { node: "invalid" }>;

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this.changes.event;
  /** The message of each connection's last failed open, until a refresh or a store change clears it. */
  private readonly failures = new Map<string, string>();
  /** One read per node id, shared by concurrent calls, with the children it answered once it settled current. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Each node id's epoch, raised by every drop: an answer read at an older epoch is never shown. */
  private readonly epochs = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[];
  private view: Pick<vscode.TreeView<TreeNode>, "reveal"> | undefined;

  constructor(private readonly deps: TreeDeps) {
    this.subscriptions = [
      deps.store.onDidChange((change) => this.storeChanged(change)),
      // A crash and an open change move connected, which is derived; no subtree is dropped and nothing is read.
      deps.link.onDidCrash(() => this.changes.fire(undefined)),
      deps.opened.onDidChange(() => this.changes.fire(undefined)),
    ];
  }

  /**
   * The root reads the store, uncached; every other node's children are one cached read inside the view's progress.
   * An answer read before a drop of its node resolves to what the node answers now.
   */
  getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node === undefined) return Promise.resolve(this.deps.store.list().map(rootNode));
    const cached = this.cache.get(node.id);
    if (cached !== undefined) return cached.children;
    const epoch = this.epochOf(node.id);
    const entry: CacheEntry = {
      children: this.load(node).then((children) => {
        if (this.epochOf(node.id) !== epoch) return this.getChildren(node);
        entry.settled = children;
        return children;
      }),
    };
    this.cache.set(node.id, entry);
    return entry.children;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.node !== "connection") return treeItemOf(node, this.deps.icons, undefined);
    const failure = this.failures.get(node.connectionId);
    return treeItemOf(node, this.deps.icons, {
      connected: isConnected(this.deps.opened.get(node.connectionId), this.deps.link),
      ...(failure === undefined ? {} : { failure }),
    });
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.node === "invalid" ? undefined : node.parent;
  }

  /**
   * With a node, drops its cache and its descendants' and clears a connection's failure mark, then fires the node;
   * with none, drops every cache and every mark and fires undefined. Sends nothing and closes nothing.
   */
  refresh(node?: TreeNode): void {
    if (node === undefined) {
      for (const id of this.cache.keys()) this.epochs.set(id, this.epochOf(id) + 1);
      this.cache.clear();
      this.failures.clear();
      this.changes.fire(undefined);
      return;
    }
    this.drop(node.id);
    if (node.node === "connection") this.failures.delete(node.connectionId);
    this.changes.fire(node);
  }

  attach(view: Pick<vscode.TreeView<TreeNode>, "reveal">): void {
    this.view = view;
  }

  /** Selects the connection's node, collapsed and without focus (part 2 criterion 14). */
  async revealConnection(connectionId: string): Promise<void> {
    if (this.view === undefined) throw new Error("The Connections view is not created yet.");
    const items = this.deps.store.list();
    const position = items.findIndex((item) => item.kind === "valid" && item.entry.id === connectionId);
    if (position < 0) throw new UnknownConnectionError(connectionId);
    await this.view.reveal(rootNode(items[position], position), { select: true, focus: false, expand: false });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changes.dispose();
  }

  private epochOf(id: string): number {
    return this.epochs.get(id) ?? 0;
  }

  /** Drops the node's cache entry and raises its epoch, then does the same for every child the entry holds. */
  private drop(id: string): void {
    const entry = this.cache.get(id);
    this.cache.delete(id);
    this.epochs.set(id, this.epochOf(id) + 1);
    for (const child of entry?.settled ?? []) this.drop(child.id);
  }

  /**
   * A changed or removed connection loses its subtree and its failure mark; releaseOnChange closes it, so the next
   * request opens it with the new fields and secrets. The root is read again for an added or a removed one.
   */
  private storeChanged(change: ConnectionsChange): void {
    for (const id of [...change.changed, ...change.removed]) {
      this.drop(nodeId("c", [id]));
      this.failures.delete(id);
    }
    this.changes.fire(undefined);
  }

  /** The children of one node, uncached. */
  private load(node: TreeNode): Promise<TreeNode[]> {
    switch (node.node) {
      case "connection":
        return this.read(node, () => this.connectionChildren(node));
      case "container":
        return this.read(node, () => this.containerChildren(node));
      case "group":
        return Promise.resolve(this.folders(node, node.kinds, node.containerPath, node.counts));
      case "folder":
        return this.read(node, () => this.folderChildren(node));
      case "object":
        return this.read(node, () => this.objectChildren(node));
      default:
        return Promise.resolve([]);
    }
  }

  /** Runs one read inside the view's progress, with no token and no host deadline; a rejection becomes one error node. */
  private async read(node: Parent, work: () => Promise<TreeNode[]>): Promise<TreeNode[]> {
    return await this.deps.window.withProgress({ location: { viewId: CONNECTIONS_VIEW } }, async () => {
      try {
        return await work();
      } catch (error) {
        return [errorNode(node, error)];
      }
    });
  }

  /** The capabilities of the connection's last open, which its parent's read made. */
  private capabilities(connectionId: string): ProviderCapabilities {
    const opened = this.deps.opened.get(connectionId);
    if (opened === undefined) throw new Error(`${connectionId} has no recorded provider description.`);
    return opened.description.capabilities;
  }

  private async connectionChildren(node: Node<"connection">): Promise<TreeNode[]> {
    let capabilities: ProviderCapabilities;
    try {
      capabilities = (await this.deps.client.ensureOpen(node.connectionId)).capabilities;
    } catch (caught) {
      // A declined prompt answers nothing and marks nothing: the person chose not to open it. A decline of Enter
      // Credentials still shows the error the open answered (criterion 7), since that open did fail.
      if (caught instanceof CredentialsNotGivenError && caught.refusal === undefined) return [];
      const error = caught instanceof CredentialsNotGivenError ? caught.refusal : caught;
      // A failed open records nothing in OpenConnections, so no other event redraws the node: fire it here. A refetch
      // this fire asks for is answered by the cache entry this read already holds, so it sends nothing again.
      this.failures.set(node.connectionId, messageOf(error));
      this.changes.fire(node);
      throw error;
    }
    this.failures.delete(node.connectionId);
    if (containerDepth(capabilities) > 0) return await this.containers(node, capabilities, 0, undefined);
    return await this.containerFolders(node, capabilities, [], undefined);
  }

  private async containerChildren(node: Node<"container">): Promise<TreeNode[]> {
    const capabilities = this.capabilities(node.connectionId);
    const { container } = node;
    if (container.level + 1 < containerDepth(capabilities)) {
      return await this.containers(node, capabilities, container.level + 1, container.path);
    }
    return await this.containerFolders(node, capabilities, container.path, container.kinds);
  }

  /** The containers of one level under a connection or a container, or the level's empty node. */
  private async containers(
    parent: Node<"connection"> | Node<"container">,
    capabilities: ProviderCapabilities,
    level: number,
    parentPath: readonly string[] | undefined,
  ): Promise<TreeNode[]> {
    const listed: Container[] = await this.deps.client.listContainers({
      connectionId: parent.connectionId,
      ...(parentPath === undefined ? {} : { parent: parentPath }),
    });
    const levels = declaredLevels(capabilities);
    if (listed.length === 0) return [emptyNode(parent, `No ${levels[level].labelPlural}`)];
    return listed.map((container) => ({
      id: nodeId("k", [parent.connectionId, ...container.path]),
      node: "container",
      connectionId: parent.connectionId,
      parent,
      container,
      levelLabel: levels[container.level].label,
    }));
  }

  /** A container's folders with its counts; a refused count puts one error node above folders with no counts. */
  private async containerFolders(
    parent: Node<"connection"> | Node<"container">,
    capabilities: ProviderCapabilities,
    path: readonly string[],
    containerKinds: readonly string[] | undefined,
  ): Promise<TreeNode[]> {
    const kinds = applicableKinds(enumerableKinds(capabilities), containerKinds);
    try {
      const counts = await this.deps.client.countObjects({ connectionId: parent.connectionId, container: path });
      return this.folders(parent, kinds, path, counts);
    } catch (error) {
      return [errorNode(parent, error), ...this.folders(parent, kinds, path, undefined)];
    }
  }

  /**
   * One folder per kind in declaration order, except that a group shared by at least two of the kinds draws one group
   * node at its first member's place, holding those kinds and the counts.
   */
  private folders(
    parent: Node<"connection"> | Node<"container"> | Node<"group">,
    kinds: readonly ObjectKindSpec[],
    path: readonly string[],
    counts: Readonly<Record<string, KindCount>> | undefined,
  ): TreeNode[] {
    const grouped = new Map<string, ObjectKindSpec[]>();
    if (parent.node !== "group") {
      for (const kind of kinds) {
        const group = kindGroup(kind);
        if (group !== undefined) grouped.set(group.id, [...(grouped.get(group.id) ?? []), kind]);
      }
    }
    const nodes: TreeNode[] = [];
    for (const kind of kinds) {
      const group = parent.node === "group" ? undefined : kindGroup(kind);
      const members = group === undefined ? [] : (grouped.get(group.id) as ObjectKindSpec[]);
      if (group === undefined || members.length < 2) {
        const count = counts?.[kind.id];
        nodes.push({
          id: nodeId("f", [parent.connectionId, ...path, kind.id]),
          node: "folder",
          connectionId: parent.connectionId,
          parent,
          containerPath: path,
          kind,
          ...(count === undefined ? {} : { count }),
        });
      } else if (members[0] === kind) {
        nodes.push({
          id: nodeId("g", [parent.connectionId, ...path, group.id]),
          node: "group",
          connectionId: parent.connectionId,
          parent,
          containerPath: path,
          group,
          kinds: members,
          counts,
        });
      }
    }
    return nodes;
  }

  private async folderChildren(node: Node<"folder">): Promise<TreeNode[]> {
    const capabilities = this.capabilities(node.connectionId);
    const objects = await this.deps.client.listObjects({
      connectionId: node.connectionId,
      container: node.containerPath,
      kind: node.kind.id,
    });
    if (objects.length === 0) return [emptyNode(node, `No ${node.kind.labelPlural}`)];
    return objects.map((object) => {
      const spec = findKind(capabilities, object.kind);
      return {
        id: nodeId("o", [node.connectionId, ...object.path, object.kind]),
        node: "object",
        connectionId: node.connectionId,
        parent: node,
        object,
        kindLabel: spec?.label ?? object.kind,
        role: spec?.role,
        hasColumns: kindHasColumns(node.kind) && node.kind.id === object.kind,
      };
    });
  }

  private async objectChildren(node: Node<"object">): Promise<TreeNode[]> {
    const { object } = node;
    const detail = await this.deps.client.describeObject({
      connectionId: node.connectionId,
      path: object.path,
      kind: object.kind,
    });
    if (detail.columns.length === 0) return [emptyNode(node, NO_COLUMNS_REPORTED)];
    return detail.columns.map((column) => ({
      id: nodeId("l", [node.connectionId, ...object.path, object.kind, column.name]),
      node: "column",
      connectionId: node.connectionId,
      parent: node,
      object,
      column,
    }));
  }
}

/** The node of one profile item at its position in the setting. */
function rootNode(item: ProfileItem, position: number): TreeNode {
  if (item.kind === "valid") {
    return { id: nodeId("c", [item.entry.id]), node: "connection", connectionId: item.entry.id, entry: item.entry };
  }
  return {
    id: nodeId("i", [String(position)]),
    node: "invalid",
    ...(item.id === undefined ? {} : { connectionId: item.id }),
    ...(item.name === undefined ? {} : { name: item.name }),
    reason: item.reason,
  };
}

/** The message an error node shows for a rejected read. */
function messageOf(error: unknown): string {
  if (error instanceof BackendExitedError) return BACKEND_STOPPED_DURING_READ;
  return error instanceof Error ? error.message : String(error);
}

function errorNode(parent: Parent, error: unknown): Node<"error"> {
  const code = error instanceof BackendError && error.code !== null ? { code: error.code } : {};
  return {
    id: nodeId("x", [parent.id]),
    node: "error",
    connectionId: parent.connectionId,
    parent,
    message: messageOf(error),
    ...code,
  };
}

function emptyNode(parent: Parent, label: string): Node<"empty"> {
  return { id: nodeId("n", [parent.id]), node: "empty", connectionId: parent.connectionId, parent, label };
}
