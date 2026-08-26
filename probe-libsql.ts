/** Gate-4 harness: every surface, called separately, against a live libSQL. */
import { LibSQLProvider } from "./src/lib/db/providers/sql/libsql";
import type { DatabaseConnection } from "./src/lib/db/types";

const [, , label, host, portRaw, token] = process.argv;
const connection = {
  id: `probe-${label}`,
  name: `libSQL ${label}`,
  type: "libsql",
  host,
  ...(portRaw === "-" ? {} : { port: Number(portRaw) }),
  ...(token && token !== "-" ? { password: token } : {}),
  ...(portRaw === "-" ? { ssl: { mode: "require" } } : {}),
  createdAt: new Date(),
} as unknown as DatabaseConnection;

const provider = new LibSQLProvider(connection);
const results: Record<string, unknown> = {};

async function surface(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    results[name] = { ok: true, value: await run() };
  } catch (error) {
    results[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

await surface("connect", async () => {
  await provider.connect();
  return "connected";
});
await surface("query", () => provider.query("SELECT id, name, country FROM probe_customers ORDER BY id"));
await surface("queryParams", () => provider.query("SELECT COUNT(*) AS c FROM probe_orders WHERE customer_id = ?", [1]));
await surface("explain", () => provider.query("EXPLAIN QUERY PLAN SELECT * FROM probe_customers WHERE country = 'tr'"));
await surface("write", () => provider.query("UPDATE probe_customers SET country = 'tr' WHERE id = 1"));
await surface("schema", () => provider.getSchema());
await surface("overview", () => provider.getOverview());
await surface("health", () => provider.getHealth());
await surface("performance", () => provider.getPerformanceMetrics());
await surface("slowQueries", () => provider.getSlowQueries());
await surface("activeSessions", () => provider.getActiveSessions());
await surface("tableStats", () => provider.getTableStats());
await surface("indexStats", () => provider.getIndexStats());
await surface("storageStats", () => provider.getStorageStats());
await surface("maintenanceCheck", () => provider.runMaintenance("check"));
await surface("maintenanceReindex", () => provider.runMaintenance("reindex"));
await surface("maintenanceVacuum", () => provider.runMaintenance("vacuum"));
await surface("badStatement", () => provider.query("SELECT * FROM no_such_table"));
await surface("disconnect", async () => {
  await provider.disconnect();
  return "disconnected";
});

await Bun.write(`probe-results-${label}.json`, JSON.stringify(results, null, 2));
for (const [name, outcome] of Object.entries(results)) {
  const record = outcome as { ok: boolean; error?: string };
  console.log(record.ok ? "OK  " : "ERR ", name.padEnd(20), record.ok ? "" : record.error);
}
