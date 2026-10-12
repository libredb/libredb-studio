/**
 * The Firestore connection fields (spec 4.1): `database` is the Google Cloud Project ID and is required; `schema` is
 * the Database ID, where empty means "(default)". The credential field is read by the credential policy, not here.
 * A null or an empty string reads as absent; any other string is read as typed, so spaces are refused by the rule,
 * never trimmed. Browser-safe.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { DEFAULT_DATABASE_ID, FIRESTORE_TYPE, type FirestoreTarget } from "./constants";
import { databaseIdRefusal, projectIdRefusal } from "./names";

type FirestoreFields = Pick<DatabaseConnection, "database" | "schema">;

export const CONNECTION_SENTENCES = Object.freeze({
  projectMissing: "Project ID is required: the Google Cloud project that holds the Firestore database",
  wrongType: (field: string): string => `The connection's ${field} must be a string`,
});

/** Every refusal sentence, Project ID first; [] when the fields are valid. */
export function validateFirestoreConnection(config: FirestoreFields): string[] {
  const refusals: string[] = [];
  const project: unknown = config.database;
  if (project === undefined || project === null || project === "") refusals.push(CONNECTION_SENTENCES.projectMissing);
  else if (typeof project !== "string") refusals.push(CONNECTION_SENTENCES.wrongType("database"));
  else pushRefusal(refusals, projectIdRefusal(project));
  const database: unknown = config.schema;
  if (database !== undefined && database !== null && database !== "") {
    if (typeof database !== "string") refusals.push(CONNECTION_SENTENCES.wrongType("schema"));
    else pushRefusal(refusals, databaseIdRefusal(database));
  }
  return refusals;
}

/** The connection's target; throws DatabaseConfigError with the first refusal. */
export function firestoreTargetOf(config: FirestoreFields): FirestoreTarget {
  const [first] = validateFirestoreConnection(config);
  if (first !== undefined) throw new DatabaseConfigError(first, FIRESTORE_TYPE);
  const schema: unknown = config.schema;
  return {
    projectId: String(config.database),
    databaseId: typeof schema === "string" && schema !== "" ? schema : DEFAULT_DATABASE_ID,
  };
}

function pushRefusal(refusals: string[], refusal: string | null): void {
  if (refusal !== null) refusals.push(refusal);
}
