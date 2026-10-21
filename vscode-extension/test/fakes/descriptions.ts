// ProviderDescriptions for the tree's unit tests, one per container shape, written out rather than computed.
// Each holds the capabilities the tree reads (containerLevels, catalogSessions, objectKinds) and casts past the rest,
// which no tree read touches, as the backend's fakes do (test/fakes/provider.ts). None declares a queryLanguage, so
// each is in the sql editor language.
import type { ContainerLevelSpec, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";
import type { ProviderDescription } from "../../src/protocol";

const PROGRAMMABILITY = { id: "programmability", label: "Programmability" };

const TABLE: ObjectKindSpec = {
  id: "table",
  role: "relation",
  label: "Table",
  labelPlural: "Tables",
  hasColumns: true,
};
const VIEW: ObjectKindSpec = {
  id: "view",
  role: "relation",
  label: "View",
  labelPlural: "Views",
  hasColumns: true,
};
const FUNCTION: ObjectKindSpec = {
  id: "function",
  role: "routine",
  label: "Function",
  labelPlural: "Functions",
  group: PROGRAMMABILITY,
};
const PROCEDURE: ObjectKindSpec = {
  id: "procedure",
  role: "routine",
  label: "Procedure",
  labelPlural: "Procedures",
  group: PROGRAMMABILITY,
};
const KEY: ObjectKindSpec = {
  id: "key",
  role: "config",
  label: "Key",
  labelPlural: "Keys",
  enumeratedBy: "key-browser",
};

const DATABASE: ContainerLevelSpec = { id: "catalog", label: "Database", labelPlural: "Databases" };
const SCHEMA: ContainerLevelSpec = { id: "schema", label: "Schema", labelPlural: "Schemas" };

function description(capabilities: Partial<ProviderCapabilities>): ProviderDescription {
  return {
    capabilities: { supportsQueryCancel: true, ...capabilities },
    labels: {},
    editorLanguage: "sql",
  } as unknown as ProviderDescription;
}

/** No container level: the connection's children are the folders of the container []. */
export const ZERO_LEVELS = description({ objectKinds: [TABLE, VIEW] });

/** One level, Schema, with a group of two routine kinds and a kind only the Keys panel enumerates. */
export const ONE_LEVEL = description({
  containerLevels: [SCHEMA],
  objectKinds: [TABLE, VIEW, FUNCTION, PROCEDURE, KEY],
});

/** Two levels, Database then Schema. */
export const TWO_LEVELS = description({ containerLevels: [DATABASE, SCHEMA], objectKinds: [TABLE, VIEW] });

/** TWO_LEVELS on a server-level connection, whose requests run in the catalog the caller names. */
export const CATALOG_SESSIONS = description({
  containerLevels: [DATABASE, SCHEMA],
  catalogSessions: true,
  objectKinds: [TABLE, VIEW],
});
