/**
 * The fixture DDL of tests/helpers/governance/fixture-ddl.ts: the governance source Studio's live checks build from
 * the published manifest (spec 7.10), so that the live loader reads views of exactly the shape a control plane
 * must publish.
 *
 * The expected texts below are built from the manifest JSON in this file, not from the helper, so a slip in the
 * helper cannot certify itself: every object is declared with its columns, defaults, CHECKs and grants, and every
 * source table behind a read view notifies `libredb_bridge` with the view's kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildFixtureDdl,
  FIXTURE_NOTIFY_FUNCTION,
  FIXTURE_OWNER,
  type FixtureColumn,
  type FixtureManifest,
  readFixtureManifest,
  sourceTableOf,
} from "../helpers/governance/fixture-ddl";

const ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8"),
) as FixtureManifest;
const SCHEMA = `"${MANIFEST.schema}"`;
const PASSWORD = "0123456789abcdef0123456789abcdef";
const DDL = buildFixtureDdl(MANIFEST, { studioPassword: PASSWORD });

/** One column as a CREATE TABLE line declares it: name, type, NOT NULL, default and CHECK. */
function columnLine(column: FixtureColumn, withDefault: boolean): string {
  const notNull = column.nullable ? "" : " NOT NULL";
  const fallback = withDefault && column.default !== null ? ` DEFAULT ${column.default}` : "";
  const check = column.check === null ? "" : ` CHECK (${column.check.sql})`;
  return `${column.name} ${column.type}${notNull}${fallback}${check}`;
}

/** The body lines of the CREATE TABLE statement for `table`, without the trailing commas. */
function tableLines(table: string): string[] {
  const head = `CREATE TABLE ${SCHEMA}.${table} (`;
  const statements = DDL.objects.filter((statement) => statement.startsWith(head));
  expect(statements).toHaveLength(1);
  return statements[0]
    .slice(head.length, statements[0].lastIndexOf(")"))
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line !== "");
}

describe("buildFixtureDdl", () => {
  test("the fixture DDL declares every manifest object with exactly its columns, defaults, CHECKs and grants", () => {
    const expectedGrants = new Set<string>();
    for (const [role, privileges] of Object.entries(MANIFEST.schemaGrants)) {
      expectedGrants.add(`GRANT ${privileges.join(", ")} ON SCHEMA ${SCHEMA} TO ${role}`);
    }
    for (const object of MANIFEST.objects) {
      let target = `TABLE ${SCHEMA}.${object.name}`;
      if (object.kind === "table") {
        expect(tableLines(object.name)).toEqual([
          ...object.columns.map((column) => columnLine(column, true)),
          `PRIMARY KEY (${object.primaryKey.join(", ")})`,
          ...object.constraints.map((constraint) => `CONSTRAINT ${constraint.name} CHECK (${constraint.check})`),
        ]);
      } else if (object.kind === "view") {
        const source = object.over ?? `${object.name}_source`;
        expect(sourceTableOf(object)).toBe(source);
        // A view over a private table: the fixture's own source table carries exactly the view's columns.
        if (object.over === null) {
          expect(tableLines(source)).toEqual(object.columns.map((column) => columnLine(column, false)));
        }
        const where = object.where === null ? "" : ` WHERE ${object.where}`;
        const checkOption = object.checkOption === null ? "" : ` WITH ${object.checkOption.toUpperCase()} CHECK OPTION`;
        expect(DDL.objects).toContain(
          `CREATE VIEW ${SCHEMA}.${object.name} WITH (security_barrier = ${MANIFEST.viewOptions.security_barrier}, security_invoker = ${MANIFEST.viewOptions.security_invoker}) AS SELECT ${object.columns.map((column) => column.name).join(", ")} FROM ${SCHEMA}.${source}${where}${checkOption}`,
        );
        const defaults = DDL.objects.filter((statement) =>
          statement.startsWith(`ALTER VIEW ${SCHEMA}.${object.name} `),
        );
        expect(defaults).toEqual(
          object.columns
            .filter((column) => column.default !== null)
            .map(
              (column) =>
                `ALTER VIEW ${SCHEMA}.${object.name} ALTER COLUMN ${column.name} SET DEFAULT ${column.default}`,
            ),
        );
      } else {
        const signature = `${SCHEMA}.${object.name}(${object.arguments.map((argument) => argument.type).join(", ")})`;
        target = `FUNCTION ${signature}`;
        const declared = object.arguments
          .map(
            (argument) =>
              `${argument.name} ${argument.type}${argument.default === null ? "" : ` DEFAULT ${argument.default}`}`,
          )
          .join(", ");
        const created = DDL.objects.filter((statement) =>
          statement.startsWith(`CREATE FUNCTION ${SCHEMA}.${object.name}(${declared}) RETURNS ${object.returns} `),
        );
        expect(created).toHaveLength(1);
        expect(created[0].includes(" SECURITY DEFINER ")).toBe(object.securityDefiner);
        expect(DDL.objects).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      }
      for (const [role, privileges] of Object.entries(object.grants)) {
        if (privileges.length > 0) expectedGrants.add(`GRANT ${privileges.join(", ")} ON ${target} TO ${role}`);
      }
    }
    expect(new Set(DDL.objects.filter((statement) => statement.startsWith("GRANT ")))).toEqual(expectedGrants);
    // Non-vacuity: two schema grants, twelve on the read views, one on query_events_v1, one on studio_instances_v1,
    // two on the tables and one on the function.
    expect(expectedGrants.size).toBe(19);

    // PUBLIC holds nothing on the schema, and every object is created by the fixture owner, so the views read their
    // sources with the owner's rights (security_invoker = false), as a control plane's do.
    expect(DDL.objects).toContain(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC`);
    expect(DDL.objects).toContain(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${FIXTURE_OWNER}`);
    const setRole = DDL.objects.indexOf(`SET ROLE ${FIXTURE_OWNER}`);
    const firstCreate = DDL.objects.findIndex((statement) => /^CREATE (TABLE|VIEW|FUNCTION) /.test(statement));
    expect(setRole).toBeGreaterThan(-1);
    expect(setRole).toBeLessThan(firstCreate);
    expect(DDL.objects.at(-1)).toBe("RESET ROLE");
  });

  test("every source table gets a statement-level trigger that notifies libredb_bridge with its kind", () => {
    const { channel, payloadVersion, kinds } = MANIFEST.notification;
    const notify = DDL.objects.filter((statement) =>
      statement.startsWith(`CREATE FUNCTION ${FIXTURE_NOTIFY_FUNCTION}()`),
    );
    expect(notify).toHaveLength(1);
    expect(notify[0]).toContain(
      `PERFORM pg_notify('${channel}', json_build_object('v', ${payloadVersion}, 'kind', TG_ARGV[0])::text);`,
    );

    const triggers = DDL.objects.filter((statement) => statement.startsWith("CREATE TRIGGER "));
    const expected = MANIFEST.objects.flatMap((object) =>
      object.kind === "view" && object.notifyKind !== null
        ? [
            `CREATE TRIGGER ${object.name}_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${SCHEMA}.${sourceTableOf(object)} FOR EACH STATEMENT EXECUTE FUNCTION ${FIXTURE_NOTIFY_FUNCTION}('${object.notifyKind}')`,
          ]
        : [],
    );
    expect(triggers).toEqual(expected);
    // Every kind the manifest publishes has a source table that sends it.
    expect(new Set(expected.map((trigger) => /\('([a-z]+)'\)$/.exec(trigger)?.[1]))).toEqual(new Set(kinds));
    // The trigger function is created before the first trigger that runs it.
    expect(DDL.objects.indexOf(notify[0])).toBeLessThan(DDL.objects.indexOf(triggers[0]));
  });

  test("it creates the two runtime roles and the fixture owner, with a login only for libredb_studio", () => {
    expect(DDL.roles).toEqual([
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${FIXTURE_OWNER}') THEN CREATE ROLE ${FIXTURE_OWNER} NOLOGIN; END IF; END $$`,
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'libredb_platform') THEN CREATE ROLE libredb_platform NOLOGIN; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'libredb_studio') THEN CREATE ROLE libredb_studio NOLOGIN; END IF; END $$",
      `ALTER ROLE libredb_studio LOGIN PASSWORD '${PASSWORD}'`,
    ]);
  });

  test("the published manifest is the default", () => {
    expect(readFixtureManifest()).toEqual(MANIFEST);
    expect(buildFixtureDdl(undefined, { studioPassword: PASSWORD })).toEqual(DDL);
  });

  test("a password that is not plain hex is refused, so it can never end the quoted literal", () => {
    expect(() => buildFixtureDdl(MANIFEST, { studioPassword: "it's" })).toThrow(
      "The fixture password of libredb_studio must be 32 to 128 lowercase hex characters",
    );
  });

  test("a function the fixture has no body for is refused", () => {
    const manifest: FixtureManifest = {
      ...MANIFEST,
      objects: [
        {
          kind: "function",
          name: "unknown_fn",
          arguments: [],
          returns: "bigint",
          securityDefiner: false,
          grants: { libredb_studio: [], libredb_platform: [] },
        },
      ],
    };
    expect(() => buildFixtureDdl(manifest, { studioPassword: PASSWORD })).toThrow(
      "The fixture has no body for function unknown_fn: add one to tests/helpers/governance/fixture-ddl.ts",
    );
  });
});
