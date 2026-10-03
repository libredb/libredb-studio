/**
 * The Neo4j catalog reads (spec 4.1 to 4.3; revisions SR4, SR16) over the 5.26.31 captures of the seeded
 * graph, and over fake answers for the shapes the seed does not hold: a node with two labels, a cut answer
 * and rows a server should never send.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { GraphClient, GraphRunOptions, GraphRunResult } from "@/lib/db/graph/bolt/client";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { CATALOG_ROW_BOUND, NEO4J_CATALOG_STATEMENTS, neo4jCatalog } from "@/lib/db/providers/graph/neo4j/catalog";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const DATABASE = "neo4j";

/** A client answering every run with the given rows, recording the runs. */
function answering(rows: readonly Record<string, unknown>[], truncated = false) {
  const calls: { statement: string; options: GraphRunOptions }[] = [];
  const client: Pick<GraphClient, "run"> = {
    async run(statement, options): Promise<GraphRunResult> {
      calls.push({ statement, options });
      return { fields: Object.keys(rows[0] ?? {}), rows, truncated };
    },
  };
  return { client, calls };
}

describe("NEO4J_CATALOG_STATEMENTS", () => {
  test("every statement passes the read policy", () => {
    for (const statement of Object.values(NEO4J_CATALOG_STATEMENTS)) {
      const verdict = checkCypherRead(statement, NEO4J_POLICY_PROFILE);
      if (!verdict.allowed) throw new Error(`${statement}: ${verdict.refusal.message}`);
    }
  });
});

describe("neo4jCatalog over the 5.26.31 captures", () => {
  test("homeDatabase reads the user's home database without naming one", async () => {
    const client = recordedGraphClient();
    expect(await neo4jCatalog.homeDatabase(client)).toBe("neo4j");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].statement).toBe("SHOW HOME DATABASE YIELD name");
    expect(client.calls[0].options.database).toBeUndefined();
  });

  test("lists the labels in order, with the bound and the database", async () => {
    const client = recordedGraphClient();
    const { entries, truncated } = await neo4jCatalog.listKind(client, DATABASE, "label");
    expect(entries.map((entry) => entry.name)).toEqual([
      "Back`tick",
      "Marker",
      "Person",
      "Service",
      "Shared",
      "Team",
      "Weird Label",
    ]);
    expect(truncated).toBe(false);
    expect(client.calls[0].options).toMatchObject({ database: DATABASE, maxRows: CATALOG_ROW_BOUND });
    expect(client.calls[0].options.timeoutMs).toBeGreaterThan(0);
  });

  test("lists the relationship types", async () => {
    const { entries } = await neo4jCatalog.listKind(recordedGraphClient(), DATABASE, "relationship_type");
    expect(entries.map((entry) => entry.name)).toEqual(["DEPENDS_ON", "MEMBER_OF", "OWNS", "Shared"]);
  });

  test("lists the indexes without the two LOOKUP indexes", async () => {
    const { entries } = await neo4jCatalog.listKind(recordedGraphClient(), DATABASE, "index");
    expect(entries).toEqual([
      {
        name: "person_name",
        detail: { type: "RANGE", entityType: "NODE", labelsOrTypes: ["Person"], properties: ["name"], state: "ONLINE" },
      },
      {
        name: "service_id",
        detail: {
          type: "RANGE",
          entityType: "NODE",
          labelsOrTypes: ["Service"],
          properties: ["id"],
          state: "ONLINE",
          owningConstraint: "service_id",
        },
      },
    ]);
  });

  test("lists the constraints", async () => {
    const { entries } = await neo4jCatalog.listKind(recordedGraphClient(), DATABASE, "constraint");
    expect(entries).toEqual([
      {
        name: "service_id",
        detail: { type: "UNIQUENESS", entityType: "NODE", labelsOrTypes: ["Service"], properties: ["id"] },
      },
    ]);
  });

  test("reads node properties per label; a label with no property gives no row", async () => {
    const { rows, truncated } = await neo4jCatalog.propertyRows(recordedGraphClient(), DATABASE, "label");
    expect(truncated).toBe(false);
    expect(rows.some((row) => row.owner === "Marker")).toBe(false);
    expect(rows.filter((row) => row.owner === "Back`tick")).toEqual([
      { owner: "Back`tick", property: "name", types: ["String"], mandatory: true },
    ]);
    expect(rows.find((row) => row.owner === "Person" && row.property === "skills")).toEqual({
      owner: "Person",
      property: "skills",
      types: ["StringArray"],
      mandatory: true,
    });
    expect(rows).toHaveLength(29);
  });

  test("reads relationship properties under the plain type name", async () => {
    const { rows } = await neo4jCatalog.propertyRows(recordedGraphClient(), DATABASE, "relationship_type");
    expect(rows).toEqual([
      { owner: "MEMBER_OF", property: "role", types: ["String"], mandatory: false },
      { owner: "MEMBER_OF", property: "since", types: ["Date"], mandatory: false },
      { owner: "DEPENDS_ON", property: "critical", types: ["Boolean"], mandatory: true },
    ]);
  });

  test("reads the index rows, unique when a constraint owns the index", async () => {
    const { rows, truncated } = await neo4jCatalog.indexRows(recordedGraphClient(), DATABASE);
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        name: "person_name",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Person"],
        properties: ["name"],
        state: "ONLINE",
        unique: false,
      },
      {
        name: "service_id",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Service"],
        properties: ["id"],
        state: "ONLINE",
        unique: true,
      },
    ]);
  });
});

describe("neo4jCatalog over other answers", () => {
  test("splits a row of a node with two labels into one row per label", async () => {
    const { client } = answering([
      { nodeLabels: ["A", "B"], propertyName: "p", propertyTypes: ["String"], mandatory: false },
    ]);
    const { rows } = await neo4jCatalog.propertyRows(client, DATABASE, "label");
    expect(rows).toEqual([
      { owner: "A", property: "p", types: ["String"], mandatory: false },
      { owner: "B", property: "p", types: ["String"], mandatory: false },
    ]);
  });

  test("reads a relationship type written as a word or with a doubled backtick", async () => {
    const { client } = answering([
      { relType: ":plain", propertyName: "p", propertyTypes: ["Long"], mandatory: true },
      { relType: ":`Back``tick`", propertyName: "q", propertyTypes: ["Long"], mandatory: false },
    ]);
    const { rows } = await neo4jCatalog.propertyRows(client, DATABASE, "relationship_type");
    expect(rows.map((row) => row.owner)).toEqual(["plain", "Back`tick"]);
  });

  test("refuses a relationship type that is not a colon and one name", async () => {
    for (const relType of ["`T`", ":`A`:`B`", ":", ":`open"]) {
      const { client } = answering([{ relType, propertyName: "p", propertyTypes: ["Long"], mandatory: true }]);
      // oxlint-disable-next-line no-await-in-loop -- one wrong shape at a time, so a pass names its input.
      await expect(neo4jCatalog.propertyRows(client, DATABASE, "relationship_type")).rejects.toThrow(QueryError);
    }
  });

  test("reports a cut answer as truncated, never throwing", async () => {
    const label = answering([{ label: "A" }], true);
    expect(await neo4jCatalog.listKind(label.client, DATABASE, "label")).toEqual({
      entries: [{ name: "A" }],
      truncated: true,
    });
    const properties = answering(
      [{ nodeLabels: ["A"], propertyName: "p", propertyTypes: ["String"], mandatory: true }],
      true,
    );
    expect((await neo4jCatalog.propertyRows(properties.client, DATABASE, "label")).truncated).toBe(true);
    const indexes = answering(
      [
        {
          name: "i",
          type: "TEXT",
          entityType: "RELATIONSHIP",
          labelsOrTypes: ["T"],
          properties: ["p"],
          state: "POPULATING",
          owningConstraint: null,
        },
      ],
      true,
    );
    const read = await neo4jCatalog.indexRows(indexes.client, DATABASE);
    expect(read.truncated).toBe(true);
    expect(read.rows[0]).toMatchObject({ name: "i", entityType: "RELATIONSHIP", unique: false });
  });

  test("refuses a home database answer that is not one name", async () => {
    await expect(neo4jCatalog.homeDatabase(answering([]).client)).rejects.toThrow(
      "Neo4j reported no home database for this user",
    );
    await expect(neo4jCatalog.homeDatabase(answering([{ name: null }]).client)).rejects.toThrow(QueryError);
  });

  test("refuses a row whose field has the wrong shape", async () => {
    await expect(neo4jCatalog.listKind(answering([{ label: 7 }]).client, DATABASE, "label")).rejects.toThrow(
      'The catalog answer of "CALL db.labels() YIELD label RETURN label ORDER BY label" holds a label that is not a string',
    );
    await expect(
      neo4jCatalog.propertyRows(
        answering([{ nodeLabels: "A", propertyName: "p", propertyTypes: [], mandatory: true }]).client,
        DATABASE,
        "label",
      ),
    ).rejects.toThrow(QueryError);
    await expect(
      neo4jCatalog.propertyRows(
        answering([{ nodeLabels: ["A"], propertyName: "p", propertyTypes: [], mandatory: "yes" }]).client,
        DATABASE,
        "label",
      ),
    ).rejects.toThrow(QueryError);
    await expect(
      neo4jCatalog.indexRows(
        answering([
          { name: "i", type: "RANGE", entityType: "EDGE", labelsOrTypes: [], properties: [], state: "ONLINE" },
        ]).client,
        DATABASE,
      ),
    ).rejects.toThrow(QueryError);
  });

  test("reads owningConstraint the same way for the listing and the index rows: null, a string, or refused", async () => {
    const index = {
      name: "i",
      type: "RANGE",
      entityType: "NODE",
      labelsOrTypes: ["A"],
      properties: ["p"],
      state: "ONLINE",
    };
    const refusal =
      'The catalog answer of "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, owningConstraint" holds a owningConstraint that is not a string or null';
    const refused = [index, { ...index, owningConstraint: 7 }].flatMap((row) => [
      expect(neo4jCatalog.indexRows(answering([row]).client, DATABASE)).rejects.toThrow(refusal),
      expect(neo4jCatalog.listKind(answering([row]).client, DATABASE, "index")).rejects.toThrow(refusal),
    ]);
    await Promise.all(refused);
    const owned = answering([{ ...index, owningConstraint: "c" }]).client;
    expect((await neo4jCatalog.indexRows(owned, DATABASE)).rows[0].unique).toBe(true);
    expect((await neo4jCatalog.listKind(owned, DATABASE, "index")).entries[0].detail).toMatchObject({
      owningConstraint: "c",
    });
  });
});
