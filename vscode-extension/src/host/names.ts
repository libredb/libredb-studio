// The view and command ids a menu, a when clause or activate names (part 3, "Tests": one constants module).

/** Every command id a menu, a when clause or activate names; manifest-menus.test.ts holds it to the manifest both ways. */
export const COMMANDS = {
  showLog: "libredb.showLog",
  addConnection: "libredb.addConnection",
  removeConnection: "libredb.removeConnection",
  refresh: "libredb.refresh",
} as const;

/** The LibreDB view container in the activity bar. */
export const VIEW_CONTAINER = "libredb";

/** The Connections view, in the LibreDB view container. */
export const CONNECTIONS_VIEW = "libredb.connections";
