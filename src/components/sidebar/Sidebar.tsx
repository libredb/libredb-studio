"use client";

import React from "react";
import { DatabaseConnection } from "@/lib/types";
import { keyScanShape, offersSchemaDiagram, type DatabaseObject } from "@/lib/db/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { connectionPulseTitle, type ConnectionPulse } from "@/hooks/use-connection-pulse";
import { Plus, Zap, Layers, LoaderCircle, CircleAlert } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ObjectTree, type ObjectSource, type TreeRowActionHandlers } from "@/components/object-tree";
import { KeyBrowser, type KeyPatternRequest } from "@/components/key-browser";
import { prefixPattern } from "@/components/key-browser/tree";
import { containerDepth } from "@/lib/db/object-kinds";
import { GitHubRepoLink } from "@/components/github-repo-link";
import { getAppVersion } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { ConnectionsList } from "./ConnectionsList";
import { CatalogSelect } from "@/components/catalog-select";
import type { ConnectionGroup } from "@/lib/storage/types";

/** One array, so a default prop is a stable reference. */
const NO_CATALOGS: readonly string[] = [];

const ACTIVE_CATALOG_LOCKED_REASON = "The open transaction runs in this database; commit or roll it back first.";

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onDuplicateConnection?: (conn: DatabaseConnection) => void;
  /** Connection ids the user has starred. Renders as a "Favorites" group above the rest. */
  favoriteConnectionIds?: Set<string>;
  onToggleFavoriteConnection?: (id: string) => void;
  /** The user's saved custom order (#748). Absent means reordering is not wired up. */
  connectionOrder?: string[];
  onReorderConnections?: (order: string[]) => void;
  /** The user's own connection groups (#1170) and the callbacks that manage them; see `ConnectionsList`. */
  connectionGroups?: ConnectionGroup[];
  onCreateGroup?: (name: string) => string | null;
  onRenameGroup?: (id: string, name: string) => void;
  onDeleteGroup?: (id: string) => void;
  onToggleGroupCollapsed?: (id: string) => void;
  onMoveConnectionToGroup?: (connectionId: string, groupId: string | null) => void;
  /**
   * Opens the connection dialog. Absent means the shell offers no new connection, and neither
   * the header's New connection nor the empty list's Add Connection is drawn: the standalone shell
   * withholds it while the server refuses custom connections (`ALLOW_CUSTOM_CONNECTIONS`).
   */
  onAddConnection?: () => void;
  /** A row the reader activated, handed over whole: path, kind and the fields the tree loaded. */
  onObjectClick?: (object: DatabaseObject) => void;
  onShowDiagram?: () => void;
  /**
   * What the provider declares about this connection. The object tree is DRIVEN by the
   * declaration - the container levels decide what it reads first, and the kinds decide
   * which folders exist - so there is nothing to draw until it arrives.
   */
  metadata?: ProviderMetadata | null;
  /**
   * Why the declaration could not be read, in the route's own words (#789).
   *
   * Absence and failure are two different facts and the pending spinner below answers only
   * one of them: with no error the panel is waiting, with one it has nothing more to wait
   * for. The embedded workspace passes neither this nor the retry, because its host DECLARES
   * the capabilities rather than reading them, so there is no read to fail or to re-issue.
   */
  metadataError?: string | null;
  /** Read the declaration again. Absent means the shell has no way to, so none is offered. */
  onRetryMetadata?: () => void;
  /** The active connection reads no catalog until asked (#765). */
  objectScanDeferred?: boolean;
  /**
   * Why, when it is not the connection's own `skipObjectScan`: the shell holds a connection the page opened by
   * itself whose every request can resume billed compute, until the person uses it (CL-CORE-2). Handed to the tree,
   * which says so in its deferred panel.
   */
  deferredForBilledCompute?: boolean;
  /** Perform the read the active connection deferred. */
  onLoadObjects?: () => void;
  /**
   * What the tree's row menu may offer (U22, #789), handed straight through.
   *
   * The shell decides what it CAN do and the tree decides what the declaration ALLOWS, and
   * the sidebar joins neither question: the standalone app passes all six, the embedded
   * workspace passes the four it mounts a modal for.
   */
  objectActions?: TreeRowActionHandlers;
  /**
   * Who answers the object tree's reads, handed straight through (#789, B76).
   *
   * Absent is the standalone shell: the tree posts to this application's own object routes.
   * The embedded workspace supplies one, because the published package carries no routes and the
   * host is the only party that can reach the database.
   */
  objectSource?: ObjectSource;
  /**
   * Whether that source can answer a describe read, handed straight through (#789).
   *
   * Absent is the standalone shell, which passes no source either: its own route always exists,
   * and `ObjectTree` resolves the pair rather than defaulting this one. The embedded workspace
   * declares it, because only its host knows whether it implemented `describeObject`, and an
   * object row offered a twisty over a read the host cannot serve is B76 again.
   */
  objectReadsColumns?: boolean;
  /**
   * Bumped by the shell when a statement it ran changed the catalog (#789), handed straight
   * through. The standalone shell drives it from the same DDL detection that re-reads the flat
   * inventory; the embedded workspace does not, because its host runs the statements.
   */
  objectRefreshToken?: number;
  /** A server-level connection's databases and its active one (#1530); nothing is drawn otherwise. */
  catalogs?: readonly string[];
  activeCatalog?: string;
  onActiveCatalogChange?: (catalog: string) => void;
  activeCatalogLocked?: boolean;
  /**
   * The active connection's pulse, the same state the header reads, handed through by the standalone shell.
   *
   * `not-checked` draws the footer still and neutral, as the header draws it: Studio sends that connection no health
   * check, so a pulsing "Connected" under it claimed what nothing measured (CL-CORE-4). Every other state, and its
   * absence in the embedded workspace, which has no pulse, keeps the footer as it was.
   */
  connectionPulse?: ConnectionPulse | null;
  /**
   * A key the reader activated in the key browser, with the type the panel already knows for it.
   *
   * Handed through rather than acted on here: the sidebar mounts the panel and joins neither
   * question — what to open, and what a key's type means — exactly as it joins neither for the
   * object tree's own row handlers.
   */
  onOpenKey?: (key: string, type: string | null, database: number | null) => void;
}

export const Sidebar = React.memo(function Sidebar({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  favoriteConnectionIds,
  onToggleFavoriteConnection,
  connectionOrder,
  onReorderConnections,
  connectionGroups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onToggleGroupCollapsed,
  onMoveConnectionToGroup,
  onAddConnection,
  onObjectClick,
  onShowDiagram,
  metadata,
  metadataError = null,
  onRetryMetadata,
  objectScanDeferred = false,
  deferredForBilledCompute,
  onLoadObjects,
  objectActions,
  objectSource,
  objectReadsColumns,
  objectRefreshToken,
  connectionPulse,
  catalogs = NO_CATALOGS,
  activeCatalog,
  onActiveCatalogChange,
  activeCatalogLocked = false,
  onOpenKey,
}: SidebarProps) {
  const appVersion = getAppVersion();
  const notChecked = connectionPulse === "not-checked";
  /**
   * Which reading of the active connection the panel below shows.
   *
   * `objects` is the default and stays the default for every engine: the key browser is an ADDITION
   * to the sidebar rather than a replacement for the object tree, so an engine that gains the
   * capability gains a tab and the other sixteen shipped type ids are untouched by it.
   *
   * Deliberately not reset when the connection changes. A reader who chose Keys and then switched
   * between two Redis servers meant to keep looking at keys, and the capability check below is what
   * keeps the choice honest: on an engine without the walk, `keys` renders the object tree anyway
   * and the tabs are not drawn at all.
   */
  const [view, setView] = React.useState<"objects" | "keys">("objects");
  /**
   * The connection whose key panel is being kept mounted, or null while none is.
   *
   * A WALK IS EXPENSIVE TO REPEAT, so the panel is HIDDEN rather than unmounted when the reader looks
   * at the object tree: `SCAN` has no index and no natural end, so coming back to Keys would otherwise
   * take the sample from cursor `"0"` again — the reader's place in a several-thousand-key walk lost
   * to a glance at something else.
   *
   * It is dropped when the CONNECTION changes, and that is not tidiness: a hidden panel still walks,
   * and the connection this id no longer matches is one nobody is looking at. The id is cleared on the
   * render that sees the new connection rather than in an effect, for the reason `useProviderMetadata`
   * gives about its own reset — an effect commits one render late, which is exactly one render of a
   * walk of the new server that nobody asked for.
   */
  const [keysPanelFor, setKeysPanelFor] = React.useState<string | null>(null);
  const connectionId = activeConnection?.id ?? null;
  if (keysPanelFor !== null && keysPanelFor !== connectionId) setKeysPanelFor(null);

  /**
   * Whether THIS shell can show a key walk, which is a question about the shell and not the engine.
   *
   * THE EMBEDDED WORKSPACE CANNOT, and this is the one place that knows it. The published package
   * ships no API routes at all, so `/api/db/keys/scan` belongs to whatever server mounted the
   * workspace - and a host that declares `keyScan` (which is about the ENGINE) would be handed a tab
   * whose first page answers HTTP 404. `objectSource` is the same fact `ObjectTree` reads for
   * `readsColumns`: a shell that answers the tree's reads itself is a shell with no routes of its own.
   */
  const keyScan = objectSource === undefined ? metadata?.capabilities.keyScan : undefined;
  const showingKeys = keyScan !== undefined && view === "keys";
  /**
   * The walk's shape, read once through `keyScanShape`, so the handover below builds the pattern the
   * engine's walk reads (spec 3.4, 4.6). Undefined where no walk is shown, which is also where no row
   * offers Browse Keys.
   */
  const keyShape = React.useMemo(() => (keyScan === undefined ? undefined : keyScanShape(keyScan)), [keyScan]);
  /**
   * The container level the walk is pointed at, when the engine declares one.
   *
   * The FIRST declared level is the one a key space belongs to — on Redis that is its numbered
   * database — and an engine with no level declares nothing here, so its keys are walked as a whole.
   */
  const databaseLevel = metadata?.capabilities.containerLevels?.[0];

  /**
   * A key pattern the reader asked to see, handed to the panel when it next renders.
   *
   * A REQUEST AND NOT A VALUE, which is why it is an object: the same pattern asked for twice is a
   * second request, and a bare string would be indistinguishable from the one the panel already has.
   * The panel applies it once and then owns the pattern — the reader can edit it, clear it, or walk
   * something else — so nothing here re-imposes it on a later render.
   */
  const [keyPatternRequest, setKeyPatternRequest] = React.useState<KeyPatternRequest | undefined>(undefined);

  /**
   * Show one row's key pattern in the panel built to walk it.
   *
   * THE SIDEBAR OWNS THIS ONE because it owns both readings: the tree the row was clicked in and the
   * key browser the pattern belongs to. Whether the row may offer the item at all is the declaration's
   * answer, decided in `rowActions`; what the item DOES is this component's, so the shell above is
   * handed back its own handlers untouched apart from this one.
   */
  const browseKeys = React.useCallback(
    (object: DatabaseObject) => {
      /*
       * THE ROW'S OWN DATABASE TRAVELS WITH IT. This item is offered on the key-pattern rows of EVERY
       * database the object tree lists, so a request carrying the pattern alone would walk whichever
       * database the panel happened to be in and answer about a key space nobody pointed at - the
       * reader clicked a row under `Database 2` and got the session's keys.
       *
       * An object's path STARTS with its container's path, so the outermost segment names the
       * container the panel's own choice is made of. Read only where the engine declares a level to
       * name - an engine with none has no container to point at, and its keys are walked as a whole.
       */
      const capabilities = metadata?.capabilities;
      const database = capabilities !== undefined && containerDepth(capabilities) > 0 ? object.path[0] : undefined;
      setKeyPatternRequest({
        // IN THE WALK'S OWN SHAPE, from `prefixPattern`, which reads the row's NAME. The scoped walk
        // holds a path and asks `pathPattern`, which is this helper under `glob`, so the two cannot
        // drift there (#427), and the same rule with no name to read under `prefix`. Under `glob` it is
        // ESCAPED, and only in its prefix half: a key prefix is data that may itself contain a glob
        // metacharacter, while the `*` the row is advertised with is the one the pattern exists for.
        // Under `prefix` it is the bare prefix and its separator, unescaped, so `/apisix/routes/*` hands
        // over `/apisix/routes/` (spec 4.6).
        pattern: prefixPattern(object.name, keyShape),
        ...(database === undefined ? {} : { database }),
      });
      setView("keys");
      setKeysPanelFor(connectionId);
    },
    [connectionId, keyShape, metadata],
  );
  const actions = React.useMemo<TreeRowActionHandlers>(
    // The panel's own item is offered only where the panel exists: the row menu's gate asks the
    // DECLARATION whether a row may be walked, and this asks whether this shell can show the walk.
    () => (keyScan === undefined ? { ...objectActions } : { ...objectActions, onBrowseKeys: browseKeys }),
    [objectActions, browseKeys, keyScan],
  );

  return (
    <div className="flex w-full h-full border-r border-border flex-col bg-background select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-brand-solid rounded flex items-center justify-center">
            <Zap strokeWidth={1.5} className="w-3 h-3 text-white fill-current" />
          </div>
          <span className="font-medium text-xs tracking-tight bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            LibreDB Studio
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Not on a Cypher connection: its relationship types are no tables (SR20). */}
          {activeConnection && offersSchemaDiagram(metadata?.capabilities) && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={onShowDiagram}
              title="Show ERD Diagram"
            >
              <Layers strokeWidth={1.5} className="w-3.5 h-3.5" />
            </button>
          )}
          {onAddConnection && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              aria-label="New connection"
              title="New connection"
              onClick={onAddConnection}
            >
              <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/*
        The connection list scrolls with the sidebar; the tree does NOT, and the split is
        load-bearing rather than cosmetic. The tree windows its rows against the height of
        its own scroll box, so nesting it in this ScrollArea would make it measure a box
        with no bottom and mount rows against the wrong height - and the fixed height that
        hid that is what left it unable to use the panel it is in.
      */}
      <ScrollArea className={cn("min-h-0 px-2 py-4", activeConnection ? "shrink-0 max-h-[45%]" : "flex-1")}>
        <ConnectionsList
          connections={connections}
          activeConnection={activeConnection}
          onSelectConnection={onSelectConnection}
          onDeleteConnection={onDeleteConnection}
          onEditConnection={onEditConnection}
          onDuplicateConnection={onDuplicateConnection}
          favoriteConnectionIds={favoriteConnectionIds}
          onToggleFavoriteConnection={onToggleFavoriteConnection}
          connectionOrder={connectionOrder}
          onReorderConnections={onReorderConnections}
          connectionGroups={connectionGroups}
          onCreateGroup={onCreateGroup}
          onRenameGroup={onRenameGroup}
          onDeleteGroup={onDeleteGroup}
          onToggleGroupCollapsed={onToggleGroupCollapsed}
          onMoveConnectionToGroup={onMoveConnectionToGroup}
          onAddConnection={onAddConnection}
        />
      </ScrollArea>

      {/*
        The object tree replaces the flat table list (#789). It reads the catalog itself,
        lazily, so the sidebar hands it the connection and the declaration and keeps no copy
        of what it found.

        Nothing is drawn while the declaration is missing, and that is not caution: an
        absent `containerLevels` reads as depth 0, which is a REAL answer for five engines,
        so a placeholder declaration would make a one-level engine read the counts of a
        container that does not exist instead of listing its schemas.

        THE PANEL IS A COLUMN, AND EACH READING OF IT IS ONE FLEX CHILD. Only one of them occupies
        it: the key panel is `display:none` whenever the tree is the reading on screen, so the tree
        still measures the whole box. `ObjectTree` measures its own scroll box against `h-full`, so a
        tree left as a direct child of this box would be as tall as the box INCLUDING the toggle, and
        overflow by exactly the toggle's height. `flex-1 min-h-0` on the wrapper is what keeps that
        measurement answering the height the tree actually has, which is the same reason the
        sidebar's own comment above refuses to nest it in a ScrollArea. The key panel keeps its
        wrapper while it is hidden, so a walk it already took survives a look at the tree.
      */}
      {activeConnection && (
        <div className="flex-1 min-h-0 px-2 pb-4 flex flex-col">
          {metadata ? (
            <>
              {keyScan !== undefined && (
                <div className="flex items-center gap-1 pb-2" role="tablist" aria-label="Sidebar view">
                  {(["objects", "keys"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="tab"
                      aria-selected={view === option}
                      onClick={() => {
                        setView(option);
                        // Choosing Keys is what mounts the panel; the id recorded here is what keeps its
                        // walk alive while the reader looks at something else.
                        if (option === "keys") setKeysPanelFor(connectionId);
                      }}
                      className={cn(
                        "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                        view === option
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {option === "objects" ? "Objects" : "Keys"}
                    </button>
                  ))}
                </div>
              )}
              {/*
                THE KEY PANEL IS HIDDEN RATHER THAN UNMOUNTED, and the tree is drawn beside it while it
                is: a sample that took a walk of the key space to build is not something to throw away
                because somebody looked at the object tree for a moment.
              */}
              {keyScan !== undefined && (showingKeys || keysPanelFor === connectionId) && (
                <div className={cn("flex-1 min-h-0", !showingKeys && "hidden")} data-testid="key-browser-panel">
                  <KeyBrowser
                    connection={activeConnection}
                    capability={keyScan}
                    databaseLevel={databaseLevel}
                    request={keyPatternRequest}
                    onOpenKey={onOpenKey}
                  />
                </div>
              )}
              {/* Anything other than "this engine declares a walk and the reader chose it" is the object
                  tree: the panel is an addition to the sidebar and never a replacement for it. */}
              {!showingKeys && onActiveCatalogChange !== undefined && (
                <div className="px-2 pb-2" data-testid="sidebar-active-catalog">
                  <CatalogSelect
                    catalogs={catalogs}
                    value={activeCatalog}
                    onChange={onActiveCatalogChange}
                    disabled={activeCatalogLocked}
                    disabledReason={ACTIVE_CATALOG_LOCKED_REASON}
                    className="w-full"
                  />
                </div>
              )}
              {!showingKeys && (
                <div className="flex-1 min-h-0">
                  <ObjectTree
                    connection={activeConnection}
                    capabilities={metadata.capabilities}
                    labels={metadata.labels}
                    deferred={objectScanDeferred}
                    deferredForBilledCompute={deferredForBilledCompute}
                    onLoad={onLoadObjects}
                    onObjectClick={onObjectClick}
                    actions={actions}
                    source={objectSource}
                    readsColumns={objectReadsColumns}
                    refreshToken={objectRefreshToken}
                  />
                </div>
              )}
            </>
          ) : metadataError !== null ? (
            <div
              data-testid="sidebar-provider-failure"
              className="flex flex-col items-center justify-center py-12 px-4 text-center"
            >
              <CircleAlert strokeWidth={1.5} className="w-6 h-6 text-warning" />
              <h3 className="mt-3 text-foreground text-xs font-medium mb-1">This connection could not be read</h3>
              <p className="text-xs text-muted-foreground leading-relaxed break-words">{metadataError}</p>
              {onRetryMetadata !== undefined && (
                <button
                  type="button"
                  data-testid="sidebar-provider-retry"
                  onClick={onRetryMetadata}
                  className="mt-3 rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  Try again
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="sidebar-provider-pending"
              className="flex flex-col items-center justify-center py-12 text-muted-foreground"
            >
              <LoaderCircle strokeWidth={1.5} className="w-6 h-6 animate-spin text-brand/40" />
              <span className="mt-3 text-xs font-medium">Reading the connection...</span>
            </div>
          )}
        </div>
      )}

      <div className="p-3 border-t border-border bg-card/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/30 border border-border/50">
          <div
            className="flex items-center gap-2"
            data-testid="sidebar-connection-status"
            title={notChecked ? connectionPulseTitle("not-checked") : undefined}
          >
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                notChecked ? "bg-fg-subtle" : "bg-hue-green-tint animate-pulse",
              )}
            />
            <span className="text-xs font-medium text-muted-foreground">
              {notChecked ? "Not checked" : "Connected"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/*
              The sidebar is the one piece of chrome BOTH modes render - the
              standalone app and the embedded workspace, which supplies its own
              header - so the invitation to the repository lives here to reach
              every user rather than only the standalone ones.
            */}
            <GitHubRepoLink className="text-muted-foreground/70 hover:text-foreground" />
            {appVersion && <span className="text-xs font-mono text-muted-foreground/70">v{appVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  );
});
