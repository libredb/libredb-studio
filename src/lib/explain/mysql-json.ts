import type { ExplainStrategy } from "./types";

const SELECT_ONLY = /^\s*SELECT\b/i;

export const mysqlJsonStrategy: ExplainStrategy = {
  format: "mysql-json",
  buildSql(sql) {
    if (!SELECT_ONLY.test(sql.trim())) return null;
    return `EXPLAIN FORMAT=JSON ${sql}`;
  },
  // Legacy extraction preserved on purpose (bug B4): MySQL output has an
  // "EXPLAIN" column, not "QUERY PLAN"; the real parser lands in #194 PR-4.
  extractPlan(result) {
    return result.rows?.[0]?.["QUERY PLAN"] || result.rows;
  },
};
