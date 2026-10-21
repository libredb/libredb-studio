// The view and command ids a menu, a when clause or activate names (part 3, "Tests": one constants module).

/** Every command id a menu, a when clause or activate names; manifest-menus.test.ts holds it to the manifest both ways. */
export const COMMANDS = {
  showLog: "libredb.showLog",
  addConnection: "libredb.addConnection",
  removeConnection: "libredb.removeConnection",
  refresh: "libredb.refresh",
  newQuery: "libredb.newQuery",
  selectRows: "libredb.selectRows",
  runQuery: "libredb.runQuery",
  cancelQuery: "libredb.cancelQuery",
  changeConnection: "libredb.changeConnection",
} as const;

/** The context keys of part 3's binding table: each holds `uri.toString()` values, read as `resource in <key>`. */
export const CONTEXT_KEYS = {
  boundDocuments: "libredb.boundDocuments",
  runningQueries: "libredb.runningQueries",
  cancellableQueries: "libredb.cancellableQueries",
} as const;

/** The LibreDB view container in the activity bar. */
export const VIEW_CONTAINER = "libredb";

/** The Connections view, in the LibreDB view container. */
export const CONNECTIONS_VIEW = "libredb.connections";

/** The Panel container that holds the Results view. */
export const RESULTS_CONTAINER = "libredbResults";

/** The Results webview view, in the Panel container libredbResults. */
export const RESULTS_VIEW = "libredb.results";

/** The status bar item that names the active editor's connection. */
export const STATUS_ITEM = "libredb.connection";
