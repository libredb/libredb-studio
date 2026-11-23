/**
 * One engine declaration per shipped type-id, generated from today's per-engine tables, and the census that reads
 * each declaration back to every table it came from (docs/providers/CONTRACT.md, clauses M-9 and M-15).
 *
 * `scripts/generate-engine-declarations.ts` writes `src/lib/db/engine-declarations/<type-id>.json`, one
 * `#/$defs/engineDeclaration` of the provider manifest schema each. The census below does not call the generator: its
 * read-back functions are written here, from the tables, so a slip in the generator cannot certify itself. Each test
 * loops over every shipped id and fails with the list of ids whose declaration and table differ.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentCredentialForm,
  compileManifestValidator,
  type EngineDeclaration,
  type FieldName,
  type HostPathField as ManifestHostPathField,
  type MaintenanceOperation as ManifestMaintenanceOperation,
  type StatementLanguage,
} from "@libredb/provider-sdk/manifest";
import {
  buildEngineDeclaration,
  declarationDirectoryProblems,
  ENGINE_DECLARATIONS_DIRECTORY,
  renderEngineDeclaration,
} from "../../../scripts/generate-engine-declarations";
import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import {
  CONNECTION_FORM_URI_MODE,
  CONNECTION_STRING_ACCEPTED,
  EXTERNAL_DATABASE_TYPES,
  HOST_PATH_FIELDS,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  SHIPPED_DATABASE_TYPES,
  SSH_TUNNEL_REFUSAL,
} from "@/lib/db/compatibility";
import {
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELDS,
  type ConnectionField,
  REFUSED_CONNECTION_FIELDS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELD_NAMES,
  SEED_ONLY_FIELDS,
  type SeedAgentCredential,
  type SeedOnlyField,
} from "@/lib/db/connection-fields";
import { CONNECTION_FORM, offersSslPanel } from "@/lib/db/connection-form";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import { CURATED_OPERATION_KINDS } from "@/lib/db/operations/descriptors";
import type { MaintenanceOperation } from "@/lib/db/types";
import { CONNECTION_FIELDS as FIELD_CLASSES } from "@/lib/storage/secret-fields";
import type { DatabaseType, HostPathField } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts/generate-engine-declarations.ts");
const DIRECTORY = path.join(ROOT, ENGINE_DECLARATIONS_DIRECTORY);
const SCHEMA_FILE = path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
  $defs: Record<string, { enum?: unknown[]; properties?: Record<string, unknown>; required?: string[] }>;
};

/** The committed declaration of one type-id, parsed. */
function declared(type: DatabaseType): EngineDeclaration {
  return JSON.parse(readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8")) as EngineDeclaration;
}

/** The shipped ids for which `matches` answers false: the census's failure list. */
function differing(matches: (type: DatabaseType, declaration: EngineDeclaration) => boolean): DatabaseType[] {
  return SHIPPED_DATABASE_TYPES.filter((type) => !matches(type, declared(type)));
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sorted(values: readonly unknown[]): string[] {
  return values.map(String).sort();
}

describe("the committed declarations", () => {
  test("the directory holds exactly one declaration per shipped type-id", () => {
    expect(declarationDirectoryProblems(readdirSync(DIRECTORY), SHIPPED_DATABASE_TYPES)).toEqual([]);
    expect(readdirSync(DIRECTORY).length).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  test("a stray file and a missing one each fail by name", () => {
    const entries = [...SHIPPED_DATABASE_TYPES.filter((type) => type !== "redis").map((type) => `${type}.json`)];

    expect(declarationDirectoryProblems([...entries, "acmedb.json", "notes.txt"], SHIPPED_DATABASE_TYPES)).toEqual([
      "redis.json is missing",
      "acmedb.json declares no shipped type-id",
      "notes.txt is not a declaration",
    ]);
  });

  test("each declaration is what the generator builds from the tables", () => {
    const stale = SHIPPED_DATABASE_TYPES.filter(
      (type) =>
        readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8") !==
        renderEngineDeclaration(buildEngineDeclaration(type)),
    ).map((type) => `${ENGINE_DECLARATIONS_DIRECTORY}/${type}.json differs: run bun run engines:generate`);

    expect(stale).toEqual([]);
  });

  test("each declaration is admitted by the schema's engine declaration and its rules", () => {
    const validator = compileManifestValidator(readFileSync(SCHEMA_FILE));
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => !validator.validateEngine(declared(type)).admitted);

    expect(refused).toEqual([]);
  });

  test("--check names a differing, missing or extra file, and --write writes every declaration and removes a stray one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-declarations-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--check").exitCode).toBe(0);

      const out = path.join(dir, "declarations");
      mkdirSync(out);
      writeFileSync(path.join(out, "retireddb.json"), "{}\n");
      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readdirSync(out).sort()).toEqual(SHIPPED_DATABASE_TYPES.map((type) => `${type}.json`).sort());
      for (const type of SHIPPED_DATABASE_TYPES) {
        expect(readFileSync(path.join(out, `${type}.json`), "utf8")).toBe(
          readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8"),
        );
      }
      expect(run("--check", "--out", out).exitCode).toBe(0);

      writeFileSync(path.join(out, "postgres.json"), "{}\n");
      rmSync(path.join(out, "mysql.json"));
      writeFileSync(path.join(out, "acmedb.json"), "{}\n");
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      const report = stale.stderr.toString();
      expect(report).toContain("postgres.json differs");
      expect(report).toContain("mysql.json is missing");
      expect(report).toContain("acmedb.json declares no shipped type-id");
      expect(report).toContain("bun run engines:generate");

      writeFileSync(path.join(out, "notes.txt"), "kept\n");
      const foreign = run("--write", "--out", out);
      expect(foreign.exitCode).toBe(1);
      expect(foreign.stderr.toString()).toContain("notes.txt is not a declaration");

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the census", () => {
  test("displayName is the connection form's label", () => {
    expect(differing((type, d) => d.displayName === CONNECTION_FORM[type].label)).toEqual([]);
  });

  test("location is external exactly for the external engines", () => {
    expect(differing((type, d) => (d.location === "external") === EXTERNAL_DATABASE_TYPES.includes(type))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).location === "embedded")).toEqual(["libredb"]);
  });

  test("connection.fields is the engine's CONNECTION_FIELDS row, in order", () => {
    expect(differing((type, d) => sameList(d.connection.fields, CONNECTION_FIELDS[type]))).toEqual([]);
  });

  test("connection.defaults reads back as the form's default port and host", () => {
    const portText = (d: EngineDeclaration) =>
      d.connection.defaults.port === undefined ? "" : String(d.connection.defaults.port);

    expect(differing((type, d) => portText(d) === CONNECTION_FORM[type].defaultPort)).toEqual([]);
    expect(differing((type, d) => d.connection.defaults.host === CONNECTION_FORM[type].defaultHost)).toEqual([]);
  });

  test("connection.seedOnly renders every refusal the table's functions give", () => {
    const samples: readonly [string, string][] = [
      ["seed-one", "opensearch"],
      ["warehouse_2", "postgres"],
    ];
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = SEED_ONLY_FIELDS[type];
      const seedOnly = d.connection.seedOnly;
      if (row === null || seedOnly === null) return row === seedOnly;
      const projection = seedOnly.projectionRefusal;
      const projectionMatches =
        row.projectionRefusal === null
          ? projection === null
          : projection !== null &&
            samples.every(
              ([id, other]) =>
                projection.replaceAll("{id}", id).replaceAll("{type}", other) === row.projectionRefusal?.(id, other),
            );
      return (
        sameList(seedOnly.fields, row.fields) &&
        seedOnly.scope === row.kind &&
        row.fields.every((field) => seedOnly.refusal.replaceAll("{field}", field) === row.refusal(field)) &&
        projectionMatches
      );
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.seedOnly !== null).length).toBe(4);
  });

  test("connection.refused is the engine's REFUSED_CONNECTION_FIELDS row", () => {
    expect(differing((type, d) => sameList(d.connection.refused, REFUSED_CONNECTION_FIELDS[type]))).toEqual([]);
  });

  test("connection.hostPathFields is the engine's HOST_PATH_FIELDS row", () => {
    expect(differing((type, d) => sameList(d.connection.hostPathFields, HOST_PATH_FIELDS[type]))).toEqual([]);
  });

  test("connection.agentCredential is the engine's SEED_AGENT_CREDENTIAL row", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = SEED_AGENT_CREDENTIAL[type];
      const credential = d.connection.agentCredential;
      if (row === null || credential === null) return row === credential;
      return credential.form === row.form && sameList(credential.supersededBy, row.supersededBy);
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.connectionString is what the provider accepts and what the dialog offers", () => {
    expect(differing((type, d) => d.connection.connectionString.accepted === CONNECTION_STRING_ACCEPTED[type])).toEqual(
      [],
    );
    expect(
      differing((type, d) => d.connection.connectionString.dialogOffersUri === CONNECTION_FORM_URI_MODE[type]),
    ).toEqual([]);
  });

  test("connection.sshTunnel is offered exactly where no SSH_TUNNEL_REFUSAL sentence is, and carries that sentence", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const sentence = SSH_TUNNEL_REFUSAL[type];
      const tunnel = d.connection.sshTunnel;
      return tunnel.offered ? sentence === null : tunnel.refusal === sentence;
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.tls is offered exactly where the dialog offers the SSL panel", () => {
    expect(differing((type, d) => (d.connection.tls === "offered") === offersSslPanel(type))).toEqual([]);
  });

  test("connection.opensLocalFile and serverLevelWithoutDatabase are their records", () => {
    expect(differing((type, d) => d.connection.opensLocalFile === OPENS_LOCAL_FILE[type])).toEqual([]);
    expect(
      differing((type, d) => d.connection.serverLevelWithoutDatabase === OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type]),
    ).toEqual([]);
  });

  test("facets are the engine's ENGINE_FACETS row", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = ENGINE_FACETS[type];
      return (
        MONITORING_PANELS.every((panel) => d.facets.monitoring[panel] === row.monitoring[panel]) &&
        Object.keys(d.facets.monitoring).length === MONITORING_PANELS.length &&
        sameList(d.facets.maintenance, row.maintenance) &&
        sameList(d.facets.agentReadings, row.agentReadings)
      );
    };

    expect(differing(matches)).toEqual([]);
  });

  test("agent.statementLanguage is the engine's AGENT_STATEMENT_LANGUAGE row", () => {
    expect(differing((type, d) => d.agent.statementLanguage === AGENT_STATEMENT_LANGUAGE[type])).toEqual([]);
  });

  test("id is the file's type-id", () => {
    expect(differing((type, d) => d.id === type)).toEqual([]);
  });
});

/** Whether two types are the same type, checked by the compiler. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the vocabularies", () => {
  const enumOf = (name: string): unknown[] => SCHEMA.$defs[name]?.enum ?? [];
  const contractFields = [...Object.keys(CONNECTION_FIELD_DESCRIPTORS), ...SEED_ONLY_FIELD_NAMES];

  test("the schema's field names are the connection fields and the seed-only fields", () => {
    expect(sorted(enumOf("fieldName"))).toEqual(sorted(contractFields));
    expect(sorted(enumOf("seedOnlyFieldName"))).toEqual(sorted(SEED_ONLY_FIELD_NAMES));
  });

  test("the schema's secret, identity and public lists are the storage layer's classes of those fields", () => {
    for (const fieldClass of ["secret", "identity", "public"] as const) {
      const expected = contractFields.filter((field) => FIELD_CLASSES[field as ConnectionField] === fieldClass);

      expect(sorted(enumOf(`${fieldClass}FieldName`))).toEqual(sorted(expected));
    }
    expect(
      sorted([...enumOf("secretFieldName"), ...enumOf("identityFieldName"), ...enumOf("publicFieldName")]),
    ).toEqual(sorted(contractFields));
  });

  test("the monitoring panels are MONITORING_PANELS and the agent readings CURATED_OPERATION_KINDS", () => {
    const panels = SCHEMA.$defs.monitoringPanels;

    expect(Object.keys(panels?.properties ?? {})).toEqual([...MONITORING_PANELS]);
    expect(panels?.required).toEqual([...MONITORING_PANELS]);
    expect(enumOf("agentReading")).toEqual([...CURATED_OPERATION_KINDS]);
  });

  test("the generated unions are Studio's own types", () => {
    const parity: [
      Equal<ManifestMaintenanceOperation, MaintenanceOperation>,
      Equal<Exclude<StatementLanguage, null>, AgentStatementLanguageId>,
      Equal<FieldName, ConnectionField | SeedOnlyField>,
      Equal<AgentCredentialForm, SeedAgentCredential["form"]>,
      Equal<ManifestHostPathField, HostPathField>,
    ] = [true, true, true, true, true];

    expect(parity).toEqual([true, true, true, true, true]);
  });
});
