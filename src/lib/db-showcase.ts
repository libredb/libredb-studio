import { DB_UI_CONFIG, type DBIcon } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * Display rank for the marketing surfaces (the login hero's "Supported Databases"
 * block, issue #425). Typed `Record<DatabaseType, number>`, so a further member of the
 * union fails `bun run typecheck` on the missing key instead of quietly never being
 * shown - the same compile-time-exhaustive trick the connection picker's coverage map
 * uses in tests/hooks/use-connection-form.test.ts.
 *
 * The order is recognisability-first: an evaluator scanning the login page should meet
 * the names they already know before the ones they do not. It is deliberately NOT the
 * connection picker's order (`selectableTypes`, src/hooks/use-connection-form.ts),
 * which groups by connect-form affordance instead. The two lists answer different
 * questions, so they are not unified; keep both when adding a provider.
 */
export const SHOWCASE_RANK: Record<DatabaseType, number> = {
  postgres: 0,
  mysql: 1,
  sqlite: 2,
  mongodb: 3,
  redis: 4,
  oracle: 5,
  mssql: 6,
  // The two search engines sit here, ahead of the analytical stores: Elasticsearch is
  // one of the best-known names on this page, and OpenSearch reads as its sibling to
  // anyone who knows it - which is also what the code says, since the two type-ids
  // share one HTTP SQL transport (#424).
  elasticsearch: 7,
  opensearch: 8,
  couchbase: 9,
  clickhouse: 10,
  druid: 11,
  // Last on purpose: the embedded store is the least recognisable name here. It is
  // still shown - it is a shipped provider with a doc (docs/providers/libredb.md), an
  // icon and a slot in the connection picker, so omitting it would make the login page
  // contradict the app (issue #425, step 2).
  libredb: 12,
};

/**
 * Every configured engine, in showcase order. Derived from `DB_UI_CONFIG`'s own keys
 * rather than written out a second time, so an engine cannot be dropped from the page
 * by being forgotten in a literal array - only by being removed from the config.
 */
export const SHOWCASE_DATABASE_ORDER: readonly DatabaseType[] = (Object.keys(DB_UI_CONFIG) as DatabaseType[]).sort(
  (a, b) => SHOWCASE_RANK[a] - SHOWCASE_RANK[b],
);

export interface ShowcaseDatabase {
  type: DatabaseType;
  label: string;
  icon: DBIcon;
  color: string;
}

/**
 * The engine list a marketing surface renders: brand icon, label and accent colour
 * taken straight from `DB_UI_CONFIG`, so no engine name is ever typed into JSX.
 * Returns a fresh array so a caller cannot mutate the shared order.
 */
export function listShowcaseDatabases(): ShowcaseDatabase[] {
  return SHOWCASE_DATABASE_ORDER.map((type) => ({
    type,
    label: DB_UI_CONFIG[type].label,
    icon: DB_UI_CONFIG[type].icon,
    color: DB_UI_CONFIG[type].color,
  }));
}
