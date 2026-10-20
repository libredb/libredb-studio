// One fixture per v0 engine for the integration and e2e legs: how to connect to its container, the table it_four
// holding n = 1..4, and where the object surface finds that table.
import type { WireConnection } from "../../src/protocol";
import type { EngineService, RunningEngine } from "./containers";

export interface EngineFixture {
  readonly service: EngineService;
  connection(engine: RunningEngine, id: string, over?: Partial<WireConnection>): WireConnection;
  /** Run one by one with query/run: a table it_four holding n = 1..4. */
  readonly setup: readonly string[];
  /** it_four's rows in order. */
  readonly selectFour: string;
  /** The container path whose objects/counts includes the table's kind. */
  readonly tableContainer: readonly string[];
  /** What objects/list names the table. */
  readonly tableName: string;
}

const CREATED_AT = new Date(0).toISOString();

/** The fields every fixture's connection shares: its id, a name the factory's log line carries, and the address. */
const base = (engine: RunningEngine, id: string) => ({
  id,
  name: `it ${id}`,
  host: engine.host,
  port: engine.port,
  createdAt: CREATED_AT,
});

const postgres: EngineFixture = {
  service: "postgres",
  connection: (engine, id, over = {}) => ({
    ...base(engine, id),
    type: "postgres",
    user: engine.environment.POSTGRES_USER,
    password: engine.environment.POSTGRES_PASSWORD,
    database: engine.environment.POSTGRES_DB,
    ...over,
  }),
  // libredb_it_lifecycle is the database the lifecycle cases count the child's sessions in.
  setup: [
    "create table it_four (n int)",
    "insert into it_four (n) values (1), (2), (3), (4)",
    "create database libredb_it_lifecycle",
  ],
  selectFour: "select n from it_four order by n",
  tableContainer: ["public"],
  tableName: "it_four",
};

const mssql: EngineFixture = {
  service: "mssql",
  // docs/providers/mssql.md section 4.3: require encrypts and skips the validation a self-signed local server fails.
  connection: (engine, id, over = {}) => ({
    ...base(engine, id),
    type: "mssql",
    user: "sa",
    password: engine.environment.MSSQL_SA_PASSWORD,
    database: "master",
    ssl: { mode: "require" },
    ...over,
  }),
  setup: ["create table dbo.it_four (n int)", "insert into dbo.it_four (n) values (1), (2), (3), (4)"],
  selectFour: "select n from dbo.it_four order by n",
  tableContainer: ["master", "dbo"],
  tableName: "it_four",
};

// The compose file's MYSQL_DATABASE is mysql, the system schema, so the table lives in a database of its own.
const mysql: EngineFixture = {
  service: "mysql",
  connection: (engine, id, over = {}) => ({
    ...base(engine, id),
    type: "mysql",
    user: "root",
    password: engine.environment.MYSQL_ROOT_PASSWORD,
    database: engine.environment.MYSQL_DATABASE,
    ...over,
  }),
  setup: [
    "create database if not exists libredb_it",
    "create table libredb_it.it_four (n int)",
    "insert into libredb_it.it_four (n) values (1), (2), (3), (4)",
  ],
  selectFour: "select n from libredb_it.it_four order by n",
  tableContainer: ["libredb_it"],
  tableName: "it_four",
};

// The JSON command format of docs/providers/mongodb.md section 3.1.
const mongodb: EngineFixture = {
  service: "mongodb",
  connection: (engine, id, over = {}) => ({
    ...base(engine, id),
    type: "mongodb",
    user: engine.environment.MONGO_INITDB_ROOT_USERNAME,
    password: engine.environment.MONGO_INITDB_ROOT_PASSWORD,
    authSource: "admin",
    database: "libredb_it",
    ...over,
  }),
  setup: [
    JSON.stringify({
      collection: "it_four",
      operation: "insertMany",
      documents: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
    }),
  ],
  selectFour: JSON.stringify({
    collection: "it_four",
    operation: "aggregate",
    pipeline: [{ $sort: { n: 1 } }, { $project: { _id: 0, n: 1 } }],
  }),
  tableContainer: ["libredb_it"],
  tableName: "it_four",
};

export const ENGINES: readonly EngineFixture[] = [postgres, mssql, mysql, mongodb];

/** The fixture of one engine. */
export function engineFixture(service: EngineService): EngineFixture {
  const fixture = ENGINES.find((candidate) => candidate.service === service);
  if (fixture === undefined) throw new Error(`No integration fixture for ${service}.`);
  return fixture;
}
