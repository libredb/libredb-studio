// Per-provider configuration for the basic-e2e lanes (see SKILL.md).
// One entry per provider: the database the lane starts, the data it seeds, the connection it types
// into the UI, the agent's seed connection, the queries it runs and what each step must observe.
// Every engine gets the same shop data, so the expected answers are the same everywhere.

export const CUSTOMERS = [
  [1, "Ayse Kaya", "ayse@example.test", "Istanbul"],
  [2, "Mehmet Demir", "mehmet@example.test", "Istanbul"],
  [3, "Elif Sahin", "elif@example.test", "Istanbul"],
  [4, "Hans Muller", "hans@example.test", "Istanbul"],
  [5, "Marie Dubois", "marie@example.test", "Ankara"],
  [6, "John Smith", "john@example.test", "Ankara"],
  [7, "Lucia Garcia", "lucia@example.test", "Ankara"],
  [8, "Marco Rossi", "marco@example.test", "Izmir"],
  [9, "Anna Weber", "anna@example.test", "Izmir"],
  [10, "Petr Novak", "petr@example.test", "Bursa"],
];

// Five shipped orders total 4321, a number no other figure in the data produces.
export const ORDERS = [
  [1, 1, "shipped", 100],
  [2, 2, "shipped", 250],
  [3, 5, "shipped", 400],
  [4, 8, "shipped", 571],
  [5, 10, "shipped", 3000],
  [6, 3, "pending", 50],
  [7, 4, "pending", 60],
  [8, 6, "pending", 70],
  [9, 9, "pending", 80],
  [10, 7, "cancelled", 90],
  [11, 1, "cancelled", 95],
  [12, 2, "cancelled", 99],
];

// What the agent steps ask, and what a correct run must show.
// Istanbul has four customers and no other city ties it; the shipped orders total 4321.
export const AGENT = {
  planObjective: "Which city has the most customers, and how many customers live there?",
  agentObjective: "What is the combined total value of all orders whose status is shipped?",
  agentAnswer: /4321/,
  // SQLite only: a primary-key lookup, whose plan is a SEARCH, so the auto-execute gate can pass.
  probeObjective: "What are the name and city of the customer whose id is 8?",
  probeAnswer: /Marco Rossi/,
};

const sqlRows = (rows) =>
  rows.map((r) => `(${r.map((v) => (typeof v === "number" ? String(v) : `'${v}'`)).join(", ")})`).join(",\n  ");

const insertCustomers = (table) => `INSERT INTO ${table} (id, name, email, city) VALUES\n  ${sqlRows(CUSTOMERS)};`;
const insertOrders = (table) => `INSERT INTO ${table} (id, customer_id, status, total) VALUES\n  ${sqlRows(ORDERS)};`;

// The four steps-2 statements, in each engine's own syntax. The write touches only customer 11.
const sqlQueries = (prefix = "") => ({
  read: { text: `SELECT id, name, city FROM ${prefix}customers ORDER BY id;`, rows: 10 },
  insert: {
    text: `INSERT INTO ${prefix}customers (id, name, email, city) VALUES (11, 'E2E Probe', 'probe@example.test', 'Eskisehir');`,
  },
  update: { text: `UPDATE ${prefix}customers SET city = 'Trabzon' WHERE id = 11;` },
  readBack: { text: `SELECT id, name, city FROM ${prefix}customers WHERE id = 11;`, expect: ["E2E Probe", "Trabzon"] },
});

export const PROVIDERS = {
  postgres: {
    engineButton: "PostgreSQL",
    composeService: "postgres",
    studioPort: 3201,
    dbPort: 55432,
    containerPort: 5432,
    containerEnv: (s) => ({ POSTGRES_PASSWORD: s.root, POSTGRES_DB: "shop" }),
    readyLog: "PostgreSQL init process complete",
    readyCmd: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "shop"],
    setupCmd: ["psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "postgres", "-d", "shop"],
    setupEnv: (s) => ({ PGPASSWORD: s.root }),
    setupScript: (s) => `
CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, city text NOT NULL);
CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id), status text NOT NULL, total numeric(10,2) NOT NULL);
${insertCustomers("customers")}
${insertOrders("orders")}
-- docs/providers/postgres.md section 12.3: the agent refuses a superuser, so it gets its own SELECT-only role.
CREATE ROLE libredb_agent LOGIN PASSWORD '${s.agent}';
GRANT CONNECT ON DATABASE shop TO libredb_agent;
GRANT USAGE ON SCHEMA public TO libredb_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO libredb_agent;
`,
    uiFields: (s) => ({ host: "127.0.0.1", port: "55432", user: "postgres", password: s.root, database: "shop" }),
    seed: { type: "postgres", host: "127.0.0.1", port: 55432, database: "shop", user: "libredb_agent" },
    treePath: ["public", "Tables"],
    objects: { customers: "city", orders: "status" },
    queries: sqlQueries(),
    // The gate weighs PostgreSQL plans, but a 10-row table always plans a sequential scan, so the run
    // places the answer unrun with the gate's warning. Either outcome is accepted; the lane records which.
    autoExecute: { offered: true, handover: ["applied", "auto-executed"] },
  },

  mysql: {
    engineButton: "MySQL",
    composeService: "mysql",
    studioPort: 3203,
    dbPort: 53306,
    containerPort: 3306,
    containerEnv: (s) => ({ MYSQL_ROOT_PASSWORD: s.root, MYSQL_DATABASE: "shop" }),
    readyLog: "MySQL init process done",
    readyCmd: ["mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "--silent"],
    readyEnv: (s) => ({ MYSQL_PWD: s.root }),
    setupCmd: ["mysql", "-h", "127.0.0.1", "-uroot", "shop"],
    setupEnv: (s) => ({ MYSQL_PWD: s.root }),
    setupScript: (s) => `
CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, email VARCHAR(120) NOT NULL UNIQUE, city VARCHAR(60) NOT NULL);
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, status VARCHAR(20) NOT NULL, total DECIMAL(10,2) NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id));
${insertCustomers("customers")}
${insertOrders("orders")}
-- docs/providers/mysql.md section 12.1: the agent refuses an owner account.
CREATE USER 'libredb_agent'@'%' IDENTIFIED BY '${s.agent}';
GRANT SELECT, SHOW VIEW ON shop.* TO 'libredb_agent'@'%';
`,
    uiFields: (s) => ({ host: "127.0.0.1", port: "53306", user: "root", password: s.root, database: "shop" }),
    seed: { type: "mysql", host: "127.0.0.1", port: 53306, database: "shop", user: "libredb_agent" },
    treePath: ["shop", "Tables"],
    objects: { customers: "city", orders: "status" },
    queries: sqlQueries(),
    // Documented: on MySQL the gate never fires (docs/AGENT.md), so a ticked run is always `applied`.
    autoExecute: { offered: true, handover: ["applied"] },
  },

  mssql: {
    engineButton: "SQL Server",
    composeService: "mssql",
    studioPort: 3204,
    dbPort: 51433,
    containerPort: 1433,
    // The compose file's own limits: 2025 asserts on NUMA topology, and the engine needs about 2 GiB.
    dockerArgs: ["--cpus", "4", "--memory", "4g"],
    containerEnv: (s) => ({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: s.root }),
    readyLog: "SQL Server is now ready for client connections",
    readyCmd: ["/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "127.0.0.1", "-U", "sa", "-b", "-Q", "SELECT 1"],
    readyEnv: (s) => ({ SQLCMDPASSWORD: s.root }),
    setupCmd: ["/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "127.0.0.1", "-U", "sa", "-b", "-i", "/dev/stdin"],
    setupEnv: (s) => ({ SQLCMDPASSWORD: s.root }),
    setupScript: (s) => `
CREATE DATABASE shopdb;
GO
USE shopdb;
GO
CREATE TABLE dbo.customers (id INT PRIMARY KEY, name NVARCHAR(80) NOT NULL, email NVARCHAR(120) NOT NULL UNIQUE, city NVARCHAR(60) NOT NULL);
CREATE TABLE dbo.orders (id INT PRIMARY KEY, customer_id INT NOT NULL REFERENCES dbo.customers(id), status NVARCHAR(20) NOT NULL, total DECIMAL(10,2) NOT NULL);
GO
${insertCustomers("dbo.customers")}
${insertOrders("dbo.orders")}
GO
-- docs/providers/mssql.md section 12.1: a db_owner login ends the run PROFILE_PRIVILEGES_TOO_BROAD.
CREATE LOGIN libredb_agent WITH PASSWORD = '${s.agent}';
CREATE USER libredb_agent FOR LOGIN libredb_agent;
ALTER ROLE db_datareader ADD MEMBER libredb_agent;
GRANT VIEW DEFINITION TO libredb_agent;
GRANT VIEW DATABASE STATE TO libredb_agent;
GRANT SHOWPLAN TO libredb_agent;
GO
`,
    uiFields: (s) => ({ host: "127.0.0.1", port: "51433", user: "sa", password: s.root, database: "shopdb" }),
    seed: { type: "mssql", host: "127.0.0.1", port: 51433, database: "shopdb", user: "libredb_agent" },
    treePath: ["shopdb", "dbo", "Tables"],
    objects: { customers: "city", orders: "status" },
    queries: sqlQueries("dbo."),
    // Documented: on SQL Server the gate never fires (docs/AGENT.md, BACKLOG A6).
    autoExecute: { offered: true, handover: ["applied"] },
  },

  mongodb: {
    engineButton: "MongoDB",
    composeService: "mongodb",
    studioPort: 3205,
    dbPort: 57017,
    containerPort: 27017,
    // The root user name is generated with the password (lane.mjs SECRETS), never a literal.
    containerEnv: (s) => ({ MONGO_INITDB_ROOT_USERNAME: s.rootUser, MONGO_INITDB_ROOT_PASSWORD: s.root }),
    readyLog: "MongoDB init process complete",
    readyCmd: ["mongosh", "--quiet", "--host", "127.0.0.1", "--eval", "db.runCommand({ ping: 1 }).ok"],
    // The setup script connects with the root credential from its own text, read over stdin.
    setupCmd: ["mongosh", "--quiet", "--nodb", "--file", "/dev/stdin"],
    setupScript: (s) => `
const admin = connect("mongodb://127.0.0.1:27017/admin");
admin.auth(${JSON.stringify(s.rootUser)}, ${JSON.stringify(s.root)});
const shop = admin.getSiblingDB("shop");
shop.customers.insertMany(${JSON.stringify(CUSTOMERS.map(([id, name, email, city]) => ({ _id: id, name, email, city })))});
shop.orders.insertMany(${JSON.stringify(ORDERS.map(([id, customerId, status, total]) => ({ _id: id, customerId, status, total })))});
// docs/providers/mongodb.md "Setting up the agent's user": read on the one database, nothing else.
shop.createUser({ user: "libredb_agent", pwd: "${s.agent}", roles: [{ role: "read", db: "shop" }] });
print("customers=" + shop.customers.countDocuments() + " orders=" + shop.orders.countDocuments());
`,
    uiFields: (s) => ({
      host: "127.0.0.1",
      port: "57017",
      user: s.rootUser,
      password: s.root,
      database: "shop",
      authSource: "admin",
    }),
    seed: {
      type: "mongodb",
      host: "127.0.0.1",
      port: 57017,
      database: "shop",
      user: "libredb_agent",
      authSource: "shop",
    },
    treePath: ["shop", "Collections"],
    objects: { customers: "city", orders: "status" },
    queries: {
      read: {
        text: '{ "collection": "customers", "operation": "find", "filter": {}, "options": { "sort": { "_id": 1 } } }',
        rows: 10,
      },
      insert: {
        text: '{ "collection": "customers", "operation": "insertOne", "documents": [{ "_id": 11, "name": "E2E Probe", "email": "probe@example.test", "city": "Eskisehir" }] }',
      },
      update: {
        text: '{ "collection": "customers", "operation": "updateOne", "filter": { "_id": 11 }, "update": { "$set": { "city": "Trabzon" } } }',
      },
      readBack: {
        text: '{ "collection": "customers", "operation": "find", "filter": { "_id": 11 } }',
        expect: ["E2E Probe", "Trabzon"],
      },
    },
    // Documented: auto-execute is not offered on MongoDB (docs/AGENT.md B118), so the control is absent.
    autoExecute: { offered: false, handover: ["none"] },
  },

  sqlite: {
    engineButton: "SQLite",
    composeService: null,
    studioPort: 3202,
    // The lane writes the file itself with node:sqlite, so there is no container.
    sqliteScript: () => `
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, city TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), status TEXT NOT NULL, total REAL NOT NULL);
${insertCustomers("customers")}
${insertOrders("orders")}
`,
    uiFields: (_s, dbFile) => ({ database: dbFile }),
    seed: { type: "sqlite" },
    treePath: ["Tables"],
    objects: { customers: "city", orders: "status" },
    queries: sqlQueries(),
    // SQLite's gate needs every plan step to be a SEARCH: the aggregate is placed unrun, and the
    // primary-key probe must actually run in the editor. This is the one lane that proves the hand-over.
    autoExecute: { offered: true, handover: ["applied", "auto-executed"], probe: true },
  },
};

export const DEFAULT_PROVIDERS = ["postgres", "mysql", "mssql", "mongodb", "sqlite"];
