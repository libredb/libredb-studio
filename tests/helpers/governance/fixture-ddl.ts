/**
 * The governance source of Studio's live checks, built from the published manifest
 * `tests/fixtures/governance/contract-v1.json` (spec 7.10): Studio's own live tests build their fixture views from the
 * same file a control plane vendors, so the loader is proven against views of exactly the published shape.
 *
 * `buildFixtureDdl()` returns SQL for a disposable database, run as a superuser:
 *
 * - `roles`, run once per server: the fixture owner, which owns every object, and the two runtime roles of the
 *   contract, `libredb_platform` and `libredb_studio`; only `libredb_studio` can log in, with the password given.
 * - `objects`, run in the fixture database: schema `bridge` owned by the fixture owner with PUBLIC's rights revoked,
 *   one source table per read view carrying exactly the view's columns, NOT NULLs and CHECKs, the manifest's tables
 *   with their primary keys and constraints, every view with the manifest's view options over its source, the view
 *   defaults, the retention function, the manifest's grants, and a statement-level trigger on each source table that
 *   sends `{"v":1,"kind":...}` on `libredb_bridge` with the view's notification kind.
 *
 * The source tables stand in for a control plane's private tables (spec appendix A.2); the live checks write the
 * rows Studio reads into them directly. The contract row of `bridge.contract` is data, not DDL, and is the checks'
 * to seed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The role that owns every fixture object, so the views read their sources with its rights. */
export const FIXTURE_OWNER = "libredb_fixture_owner";

/** The manifest's column of a table or view. */
export interface FixtureColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly check: { readonly sql: string } | null;
}

type Grants = Readonly<Record<string, readonly string[]>>;

interface FixtureView {
  readonly kind: "view";
  readonly name: string;
  readonly over: string | null;
  readonly where: string | null;
  readonly checkOption: string | null;
  readonly notifyKind: string | null;
  readonly columns: readonly FixtureColumn[];
  readonly grants: Grants;
}

interface FixtureTable {
  readonly kind: "table";
  readonly name: string;
  readonly columns: readonly FixtureColumn[];
  readonly primaryKey: readonly string[];
  readonly constraints: readonly { readonly name: string; readonly check: string }[];
  readonly grants: Grants;
}

interface FixtureFunction {
  readonly kind: "function";
  readonly name: string;
  readonly arguments: readonly { readonly name: string; readonly type: string; readonly default: string | null }[];
  readonly returns: string;
  readonly securityDefiner: boolean;
  readonly grants: Grants;
}

/** The parts of the published manifest the fixture is built from. */
export interface FixtureManifest {
  readonly contractVersion: number;
  readonly schema: string;
  readonly schemaGrants: Grants;
  readonly viewOptions: { readonly security_barrier: boolean; readonly security_invoker: boolean };
  readonly notification: {
    readonly channel: string;
    readonly payloadVersion: number;
    readonly kinds: readonly string[];
  };
  readonly objects: readonly (FixtureView | FixtureTable | FixtureFunction)[];
}

const MANIFEST_FILE = path.resolve(import.meta.dir, "../../fixtures/governance/contract-v1.json");

/** The published manifest, as checked in. */
export function readFixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as FixtureManifest;
}

/** The fixture's trigger function, which sends a change notification of the kind its trigger names. */
export const FIXTURE_NOTIFY_FUNCTION = '"bridge".fixture_notify';

/**
 * The bodies of the contract's functions. The manifest publishes a function's signature and grants but not its body,
 * so the fixture carries the body appendix A.3 gives.
 */
const FUNCTION_BODIES: Readonly<Record<string, string>> = {
  trim_query_events: `DECLARE
  v_cutoff timestamptz := now() - make_interval(days => greatest(coalesce(p_retention_days, 90), 7));
  v_batch integer := least(greatest(coalesce(p_batch, 10000), 1), 100000);
  v_deleted bigint;
BEGIN
  DELETE FROM "bridge".query_event
  WHERE event_id IN (SELECT e.event_id FROM "bridge".query_event e
                     WHERE e.started_at < v_cutoff ORDER BY e.started_at LIMIT v_batch);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END`,
};

/** The table a view reads: the manifest table it is a window on, or the fixture's source table for it. */
export function sourceTableOf(view: Pick<FixtureView, "name" | "over">): string {
  return view.over ?? `${view.name}_source`;
}

function columnLine(column: FixtureColumn, withDefault: boolean): string {
  const notNull = column.nullable ? "" : " NOT NULL";
  const fallback = withDefault && column.default !== null ? ` DEFAULT ${column.default}` : "";
  const check = column.check === null ? "" : ` CHECK (${column.check.sql})`;
  return `${column.name} ${column.type}${notNull}${fallback}${check}`;
}

function createTable(qualified: string, lines: readonly string[]): string {
  return `CREATE TABLE ${qualified} (\n${lines.map((line) => `  ${line}`).join(",\n")}\n)`;
}

function grantStatements(grants: Grants, target: string): string[] {
  return Object.entries(grants)
    .filter(([, privileges]) => privileges.length > 0)
    .map(([role, privileges]) => `GRANT ${privileges.join(", ")} ON ${target} TO ${role}`);
}

function viewStatements(manifest: FixtureManifest, schema: string, view: FixtureView): string[] {
  const source = sourceTableOf(view);
  const statements: string[] = [];
  if (view.over === null) {
    statements.push(
      createTable(
        `${schema}.${source}`,
        view.columns.map((column) => columnLine(column, false)),
      ),
    );
    if (view.notifyKind !== null) {
      statements.push(
        `CREATE TRIGGER ${view.name}_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${schema}.${source} FOR EACH STATEMENT EXECUTE FUNCTION ${FIXTURE_NOTIFY_FUNCTION}('${view.notifyKind}')`,
      );
    }
  }
  const { security_barrier: barrier, security_invoker: invoker } = manifest.viewOptions;
  const where = view.where === null ? "" : ` WHERE ${view.where}`;
  const checkOption = view.checkOption === null ? "" : ` WITH ${view.checkOption.toUpperCase()} CHECK OPTION`;
  statements.push(
    `CREATE VIEW ${schema}.${view.name} WITH (security_barrier = ${barrier}, security_invoker = ${invoker}) AS SELECT ${view.columns.map((column) => column.name).join(", ")} FROM ${schema}.${source}${where}${checkOption}`,
  );
  for (const column of view.columns) {
    if (column.default !== null) {
      statements.push(`ALTER VIEW ${schema}.${view.name} ALTER COLUMN ${column.name} SET DEFAULT ${column.default}`);
    }
  }
  return [...statements, ...grantStatements(view.grants, `TABLE ${schema}.${view.name}`)];
}

function tableStatements(schema: string, table: FixtureTable): string[] {
  return [
    createTable(`${schema}.${table.name}`, [
      ...table.columns.map((column) => columnLine(column, true)),
      `PRIMARY KEY (${table.primaryKey.join(", ")})`,
      ...table.constraints.map((constraint) => `CONSTRAINT ${constraint.name} CHECK (${constraint.check})`),
    ]),
    ...grantStatements(table.grants, `TABLE ${schema}.${table.name}`),
  ];
}

function functionStatements(schema: string, fn: FixtureFunction): string[] {
  const body = FUNCTION_BODIES[fn.name];
  if (body === undefined) {
    throw new Error(
      `The fixture has no body for function ${fn.name}: add one to tests/helpers/governance/fixture-ddl.ts`,
    );
  }
  const declared = fn.arguments
    .map(
      (argument) =>
        `${argument.name} ${argument.type}${argument.default === null ? "" : ` DEFAULT ${argument.default}`}`,
    )
    .join(", ");
  const signature = `${schema}.${fn.name}(${fn.arguments.map((argument) => argument.type).join(", ")})`;
  const definer = fn.securityDefiner ? " SECURITY DEFINER" : "";
  return [
    `CREATE FUNCTION ${schema}.${fn.name}(${declared}) RETURNS ${fn.returns} LANGUAGE plpgsql${definer} SET search_path = pg_catalog, pg_temp AS $$\n${body}\n$$`,
    `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
    ...grantStatements(fn.grants, `FUNCTION ${signature}`),
  ];
}

const PASSWORD = /^[0-9a-f]{32,128}$/;

/** A role that may already exist on a server a check ran on before, so creating it never fails on a rerun. */
const ensureRole = (role: string): string =>
  `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`;

/** The SQL of a disposable governance source: roles for the server, and objects for the fixture database. */
export interface FixtureDdl {
  readonly roles: readonly string[];
  readonly objects: readonly string[];
}

/**
 * The fixture of `manifest`, by default the published one. `studioPassword` becomes the password of
 * `libredb_studio` and must be lowercase hex, so it can never end the literal it is written into.
 */
export function buildFixtureDdl(
  manifest: FixtureManifest = readFixtureManifest(),
  options: { readonly studioPassword: string },
): FixtureDdl {
  if (!PASSWORD.test(options.studioPassword)) {
    throw new Error("The fixture password of libredb_studio must be 32 to 128 lowercase hex characters");
  }
  const schema = `"${manifest.schema}"`;
  const { channel, payloadVersion } = manifest.notification;
  const objects: string[] = [
    `CREATE SCHEMA ${schema} AUTHORIZATION ${FIXTURE_OWNER}`,
    `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`,
    ...Object.entries(manifest.schemaGrants).map(
      ([role, privileges]) => `GRANT ${privileges.join(", ")} ON SCHEMA ${schema} TO ${role}`,
    ),
    `SET ROLE ${FIXTURE_OWNER}`,
    `CREATE FUNCTION ${FIXTURE_NOTIFY_FUNCTION}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$\nBEGIN\n  PERFORM pg_notify('${channel}', json_build_object('v', ${payloadVersion}, 'kind', TG_ARGV[0])::text);\n  RETURN NULL;\nEND\n$$`,
  ];
  for (const object of manifest.objects) {
    if (object.kind === "view") objects.push(...viewStatements(manifest, schema, object));
    else if (object.kind === "table") objects.push(...tableStatements(schema, object));
    else objects.push(...functionStatements(schema, object));
  }
  objects.push("RESET ROLE");
  return {
    roles: [
      ensureRole(FIXTURE_OWNER),
      ensureRole("libredb_platform"),
      ensureRole("libredb_studio"),
      `ALTER ROLE libredb_studio LOGIN PASSWORD '${options.studioPassword}'`,
    ],
    objects,
  };
}
