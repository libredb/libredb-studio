// For the typecheck only: the child bundles root modules written against Bun's types.
// loadBunDriver in src/lib/db/providers/sql/sqlite-driver.ts imports "bun:sqlite" on a branch only Bun takes,
// and resolveSQLiteDriverName there, like runtimeReportsTlsCause in the etcd, Oxia and Milvus connection options, reads typeof Bun.
// Declaring the two here, rather than loading Bun's types, keeps Bun's globals out of extension code.
declare module "bun:sqlite";
declare const Bun: unknown;
