/**
 * The S3 provider's labels. Pure, and shipped to the browser: `getLabels()` answers before
 * connect, through `POST /api/db/provider-meta`. `statementLanguage` is the console part's sentence, built from its
 * command table, so a command the parser takes is named in it too. `vacuumActionOperation` and the three
 * `reindexGlobal*` members are not declared, because maintenance is off.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { s3StatementLanguage } from "./console/statement-language";

export const S3_LABELS: ProviderLabels = Object.freeze({
  entityName: "Bucket",
  entityNamePlural: "Buckets",
  rowName: "Object",
  rowNamePlural: "Objects",
  selectAction: "List Objects",
  generateAction: "Generate Command",
  // Never rendered (`supportsMaintenance: false`); worded true anyway.
  analyzeAction: "Statistics",
  vacuumAction: "Maintenance",
  searchPlaceholder: "Search buckets...",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "An S3 server keeps no statistics for Studio to update.",
  vacuumGlobalLabel: "Maintenance",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio sends an S3 server no maintenance: this version only reads.",
  statementLanguage: s3StatementLanguage(),
  slowQueriesEmptyState: "S3 keeps no query log",
  sessionsEmptyState: "S3 does not list client sessions",
  tableStatsCaption:
    "S3 has no tables: buckets are listed under Buckets, and objects in the Keys panel and with aws s3 ls in the console.",
});
