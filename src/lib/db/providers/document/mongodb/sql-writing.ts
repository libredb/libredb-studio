import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/**
 * The test data generator's insert for MongoDB: the provider's own request, one `insertMany` at the collection's
 * address. Studio's SQL writing function table binds it to the `insertDocuments` the engine's declaration names
 * (src/lib/db/sql-writing/index.ts, `SQL_WRITING_FUNCTIONS`).
 */
export const MONGODB_INSERT_DOCUMENTS: NonNullable<SqlWritingSpec["insertDocuments"]> = (address, documents) =>
  JSON.stringify({ ...address, operation: "insertMany", documents }, null, 2);
