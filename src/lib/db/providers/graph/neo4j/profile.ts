/**
 * The Neo4j read policy's lists (Neo4j provider spec 5.2; revisions SR7, SR9).
 *
 * Pure, and shipped to the browser: the read policy and the editor read Neo4j only through this
 * profile. Every list is a decision about Neo4j 5.26, measured on the compose server:
 *
 * - the denied words name every clause that writes, reaches outside the database (`LOAD CSV`),
 *   changes the session's database (`USE`), or administers the server, and `IN TRANSACTIONS`,
 *   which commits batches of its own;
 * - `apoc.` and `gds.` are refused as namespaces, since their procedures and functions can reach
 *   the network or the file system;
 * - the procedures are the schema and server reads the tree and the health probe use;
 * - the qualified functions are exactly the built-in dotted functions `SHOW FUNCTIONS` lists on
 *   5.26.31 (`tests/unit/db/neo4j/profile.test.ts` pins the list to that capture);
 * - the SHOW forms list indexes, constraints, databases, procedures and functions; `SHOW
 *   TRANSACTIONS` is not one (SR9), because its `YIELD *` returns other sessions' query text and
 *   parameters, and the monitoring panel reads transactions with its own fixed column list.
 */
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";

/** Each form as typed after `SHOW`, split into words; `*` matches one name. */
const SHOW_FORMS = [
  "INDEXES",
  "INDEX",
  "ALL INDEXES",
  "RANGE INDEXES",
  "TEXT INDEXES",
  "POINT INDEXES",
  "LOOKUP INDEXES",
  "FULLTEXT INDEXES",
  "VECTOR INDEXES",
  "CONSTRAINTS",
  "CONSTRAINT",
  "ALL CONSTRAINTS",
  "UNIQUE CONSTRAINTS",
  "NODE UNIQUENESS CONSTRAINTS",
  "RELATIONSHIP UNIQUENESS CONSTRAINTS",
  "EXISTENCE CONSTRAINTS",
  "KEY CONSTRAINTS",
  "PROPERTY TYPE CONSTRAINTS",
  "DATABASES",
  "DATABASE *",
  "DEFAULT DATABASE",
  "HOME DATABASE",
  "PROCEDURES",
  "FUNCTIONS",
  "ALL FUNCTIONS",
  "BUILT IN FUNCTIONS",
  "USER DEFINED FUNCTIONS",
];

const DENIED_WORDS = [
  "CREATE",
  "MERGE",
  "SET",
  "DELETE",
  "DETACH",
  "REMOVE",
  "DROP",
  "FOREACH",
  "LOAD",
  "ALTER",
  "RENAME",
  "GRANT",
  "DENY",
  "REVOKE",
  "START",
  "STOP",
  "ENABLE",
  "TERMINATE",
  "USE",
  // GQL's spelling of CREATE, accepted since Neo4j 5.18.
  "INSERT",
  "IN TRANSACTIONS",
];

export const NEO4J_POLICY_PROFILE: GraphPolicyProfile = {
  engineLabel: "Neo4j",
  readPolicy: {
    deniedWords: DENIED_WORDS.map((words) => words.split(" ")),
    deniedNamespaces: ["apoc.", "gds."],
    allowedProcedures: [
      "db.labels",
      "db.relationshipTypes",
      "db.propertyKeys",
      "db.schema.visualization",
      "db.schema.nodeTypeProperties",
      "db.schema.relTypeProperties",
      "db.ping",
      "dbms.components",
    ],
    // SHOW FUNCTIONS YIELD name, isBuiltIn WHERE isBuiltIn AND name CONTAINS '.' on 5.26.31, lowercased.
    allowedQualifiedFunctions: [
      "date.realtime",
      "date.statement",
      "date.transaction",
      "date.truncate",
      "datetime.fromepoch",
      "datetime.fromepochmillis",
      "datetime.realtime",
      "datetime.statement",
      "datetime.transaction",
      "datetime.truncate",
      "duration.between",
      "duration.indays",
      "duration.inmonths",
      "duration.inseconds",
      "graph.byelementid",
      "graph.byname",
      "localdatetime.realtime",
      "localdatetime.statement",
      "localdatetime.transaction",
      "localdatetime.truncate",
      "localtime.realtime",
      "localtime.statement",
      "localtime.transaction",
      "localtime.truncate",
      "point.distance",
      "point.withinbbox",
      "time.realtime",
      "time.statement",
      "time.transaction",
      "time.truncate",
      "vector.similarity.cosine",
      "vector.similarity.euclidean",
    ],
    allowedShowForms: SHOW_FORMS.map((form) => form.split(" ")),
    refusedPrefixes: ["EXPLAIN", "PROFILE"],
  },
  dialect: { supportsVersionPrefix: true, offsetKeyword: "SKIP" },
};
