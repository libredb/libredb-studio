/**
 * The Neo4j catalog reads (Neo4j provider spec 4.1 to 4.3; revisions SR4, SR16).
 *
 * Each read is one fixed statement, exported for the tests and the evidence harness, run through the
 * client in a READ session on the connection's database and bounded by `CATALOG_ROW_BOUND` rows. A cut
 * answer is returned with `truncated` set, never cut silently and never thrown, so the tree can say it
 * shows a floor. A row of the wrong shape is a `QueryError` naming the statement: the captures of
 * 5.26.31 fix every shape read here, and a server that answers otherwise is not one this provider knows.
 *
 * Shapes the captures show: the default `LOOKUP` indexes have no labels and no properties and are not
 * listed; `db.schema.nodeTypeProperties()` answers a label with no property as one row whose
 * `propertyName` is null, and a node with several labels as one row naming them all, which is split into
 * one row per label; `db.schema.relTypeProperties()` writes the type as ``:`TYPE` ``, which the lexer reads
 * back, so a backtick inside the name is undoubled exactly as Cypher reads it.
 */
import { QueryError } from "@/lib/db/errors";
import type { GraphClient, GraphRunResult } from "@/lib/db/graph/bolt/client";
import { CypherLexError, lexCypher } from "@/lib/db/graph/cypher/lexer";
import type { GraphCatalog } from "@/lib/db/graph/graph-base-provider";
import type { GraphCatalogEntry, GraphIndexRow, GraphKindId, GraphPropertyRow } from "@/lib/db/graph/objects";
import { PROVIDER } from "./errors";

/** The most rows one catalog read takes; a longer answer is reported as cut, never silently. */
export const CATALOG_ROW_BOUND = 10_000;

/** The Bolt transaction timeout of one catalog read. */
const CATALOG_TIMEOUT_MS = 30_000;

/** Every statement the catalog runs, exported for the tests and the evidence harness. */
export const NEO4J_CATALOG_STATEMENTS = {
  homeDatabase: "SHOW HOME DATABASE YIELD name",
  label: "CALL db.labels() YIELD label RETURN label ORDER BY label",
  relationship_type:
    "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType",
  index: "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, owningConstraint",
  constraint: "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties",
  nodeProperties: "CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory",
  relationshipProperties: "CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory",
} as const;

type Row = Readonly<Record<string, unknown>>;
type Runner = Pick<GraphClient, "run">;

/** Reads the fields of the rows one statement answered, refusing a field of the wrong shape. */
class RowReader {
  constructor(private readonly statement: string) {}

  private wrong(field: string, shape: string): QueryError {
    return new QueryError(
      `The catalog answer of ${JSON.stringify(this.statement)} holds a ${field} that is not ${shape}`,
      PROVIDER,
      this.statement,
    );
  }

  string(row: Row, field: string): string {
    const value = row[field];
    if (typeof value !== "string") throw this.wrong(field, "a string");
    return value;
  }

  strings(row: Row, field: string): string[] {
    const value = row[field];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw this.wrong(field, "a list of strings");
    }
    return value;
  }

  boolean(row: Row, field: string): boolean {
    const value = row[field];
    if (typeof value !== "boolean") throw this.wrong(field, "a boolean");
    return value;
  }

  entity(row: Row): "NODE" | "RELATIONSHIP" {
    const value = row.entityType;
    if (value !== "NODE" && value !== "RELATIONSHIP") throw this.wrong("entityType", "NODE or RELATIONSHIP");
    return value;
  }

  /** ``:`TYPE` `` (or `:TYPE`) to the type's name, read by the lexer. */
  relationshipType(row: Row): string {
    const written = this.string(row, "relType");
    let tokens: ReturnType<typeof lexCypher> = [];
    try {
      tokens = lexCypher(written).filter((token) => token.kind !== "whitespace" && token.kind !== "comment");
    } catch (error) {
      // Text that does not lex is refused below with every other wrong shape.
      if (!(error instanceof CypherLexError)) throw error;
    }
    const [colon, name] = tokens;
    if (tokens.length !== 2 || colon.text !== ":" || (name.kind !== "backtick" && name.kind !== "word")) {
      throw this.wrong("relType", "a colon and one relationship type");
    }
    return name.kind === "backtick" ? name.value : name.text;
  }
}

function read(client: Runner, statement: string, database: string | undefined): Promise<GraphRunResult> {
  return client.run(statement, { database, timeoutMs: CATALOG_TIMEOUT_MS, maxRows: CATALOG_ROW_BOUND });
}

/** The rows of `SHOW INDEXES` a user created: every index but the default `LOOKUP` ones. */
async function createdIndexes(client: Runner, database: string) {
  const statement = NEO4J_CATALOG_STATEMENTS.index;
  const result = await read(client, statement, database);
  return { reader: new RowReader(statement), rows: result.rows.filter((row) => row.type !== "LOOKUP"), result };
}

async function listKind(
  client: Runner,
  database: string,
  kind: GraphKindId,
): Promise<{ entries: readonly GraphCatalogEntry[]; truncated: boolean }> {
  if (kind === "index") {
    const { reader, rows, result } = await createdIndexes(client, database);
    const entries = rows.map((row) => ({
      name: reader.string(row, "name"),
      detail: {
        type: reader.string(row, "type"),
        entityType: reader.entity(row),
        labelsOrTypes: reader.strings(row, "labelsOrTypes"),
        properties: reader.strings(row, "properties"),
        state: reader.string(row, "state"),
        ...(row.owningConstraint === null ? {} : { owningConstraint: reader.string(row, "owningConstraint") }),
      },
    }));
    return { entries, truncated: result.truncated };
  }
  const statement = NEO4J_CATALOG_STATEMENTS[kind];
  const reader = new RowReader(statement);
  const result = await read(client, statement, database);
  if (kind === "constraint") {
    const entries = result.rows.map((row) => ({
      name: reader.string(row, "name"),
      detail: {
        type: reader.string(row, "type"),
        entityType: reader.entity(row),
        labelsOrTypes: reader.strings(row, "labelsOrTypes"),
        properties: reader.strings(row, "properties"),
      },
    }));
    return { entries, truncated: result.truncated };
  }
  const field = kind === "label" ? "label" : "relationshipType";
  return { entries: result.rows.map((row) => ({ name: reader.string(row, field) })), truncated: result.truncated };
}

async function propertyRows(
  client: Runner,
  database: string,
  kind: "label" | "relationship_type",
): Promise<{ rows: readonly GraphPropertyRow[]; truncated: boolean }> {
  const statement =
    kind === "label" ? NEO4J_CATALOG_STATEMENTS.nodeProperties : NEO4J_CATALOG_STATEMENTS.relationshipProperties;
  const reader = new RowReader(statement);
  const result = await read(client, statement, database);
  const rows = result.rows.flatMap((row) => {
    // A label or a type with no property at all.
    if (row.propertyName === null) return [];
    const owners = kind === "label" ? reader.strings(row, "nodeLabels") : [reader.relationshipType(row)];
    const property = reader.string(row, "propertyName");
    const types = reader.strings(row, "propertyTypes");
    const mandatory = reader.boolean(row, "mandatory");
    return owners.map((owner) => ({ owner, property, types, mandatory }));
  });
  return { rows, truncated: result.truncated };
}

async function indexRows(
  client: Runner,
  database: string,
): Promise<{ rows: readonly GraphIndexRow[]; truncated: boolean }> {
  const { reader, rows, result } = await createdIndexes(client, database);
  return {
    rows: rows.map((row) => ({
      name: reader.string(row, "name"),
      type: reader.string(row, "type"),
      entityType: reader.entity(row),
      labelsOrTypes: reader.strings(row, "labelsOrTypes"),
      properties: reader.strings(row, "properties"),
      state: reader.string(row, "state"),
      unique: row.owningConstraint !== null,
    })),
    truncated: result.truncated,
  };
}

async function homeDatabase(client: Runner): Promise<string> {
  const statement = NEO4J_CATALOG_STATEMENTS.homeDatabase;
  const { rows } = await read(client, statement, undefined);
  if (rows.length !== 1) {
    throw new QueryError("Neo4j reported no home database for this user", PROVIDER, statement);
  }
  return new RowReader(statement).string(rows[0], "name");
}

export const neo4jCatalog: GraphCatalog = { homeDatabase, listKind, propertyRows, indexRows };
