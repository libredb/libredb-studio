/**
 * The S3 provider's labels, pinned whole: the shared UI reads every member before connect,
 * through `POST /api/db/provider-meta`, and `statementLanguage` is the console part's sentence, built from its own
 * command table.
 */
import { expect, test } from "bun:test";
import { s3StatementLanguage } from "@/lib/db/providers/objectstore/s3/console/statement-language";
import { S3_LABELS } from "@/lib/db/providers/objectstore/s3/labels";

test("every member, written out", () => {
  expect(S3_LABELS).toEqual({
    entityName: "Bucket",
    entityNamePlural: "Buckets",
    rowName: "Object",
    rowNamePlural: "Objects",
    selectAction: "List Objects",
    generateAction: "Generate Command",
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
  expect(Object.isFrozen(S3_LABELS)).toBe(true);
});

test("no reindex or vacuum-operation member is declared, because maintenance is off", () => {
  for (const member of ["vacuumActionOperation", "reindexGlobalLabel", "reindexGlobalTitle", "reindexGlobalDesc"])
    expect(Object.hasOwn(S3_LABELS, member)).toBe(false);
});
