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
  type CredentialWarning as ManifestCredentialWarning,
  type EngineDeclaration,
  type FieldName,
  type FieldPlacement as ManifestFieldPlacement,
  type HostPathField as ManifestHostPathField,
  type HostUriScheme as ManifestHostUriScheme,
  type JwtAccessClaim,
  type MaintenanceOperation as ManifestMaintenanceOperation,
  type PlaceableFieldName,
  type SelectFieldName,
  type StatementLanguage,
} from "@libredb/provider-sdk/manifest";
import {
  buildDialog,
  buildEngineDeclaration,
  buildFieldRules,
  declarationDirectoryProblems,
  ENGINE_DECLARATIONS_DIRECTORY,
  renderEngineDeclaration,
} from "../../../scripts/generate-engine-declarations";
import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import type { HostUriScheme } from "@/lib/connection-host-uri";
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
  type FieldPlacement,
  PLACEABLE_FIELDS,
  type PlaceableField,
  REFUSED_CONNECTION_FIELDS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELD_NAMES,
  SEED_ONLY_FIELDS,
  type SeedAgentCredential,
  type SeedOnlyField,
} from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  type ConnectionFieldRule,
  type ConnectionFormSpec,
  connectionFieldRefusal,
  connectionFieldShown,
  offersSslPanel,
} from "@/lib/db/connection-form";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import { CURATED_OPERATION_KINDS } from "@/lib/db/operations/descriptors";
import { refusedFieldRefusal } from "@/lib/db/provider-connection";
import {
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import type { MaintenanceOperation } from "@/lib/db/types";
import { importKubeconfig } from "@/lib/kubernetes/kubeconfig-import";
import { CONNECTION_FIELDS as FIELD_CLASSES } from "@/lib/storage/secret-fields";
import type { DatabaseConnection, DatabaseType, HostPathField } from "@/lib/types";

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

/** A list of entries naming their field, read as a map from field to the member `pick` reads. */
function byField<Entry extends { readonly field: string }, Value>(
  entries: readonly Entry[],
  pick: (entry: Entry) => Value,
): Record<string, Value> {
  return Object.fromEntries(entries.map((entry) => [entry.field, pick(entry)]));
}

/** A partial record of the form as a plain map, an absent record as an empty one. */
function asMap<Value>(record: Partial<Record<string, Value>> | undefined): Record<string, Value> {
  return { ...(record ?? {}) } as Record<string, Value>;
}

/** Whether two values are deeply equal, compared through their JSON with object keys in one order. */
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The census's own resolver of the functions a declaration names: per engine, each name mapped to the function Studio
 * exports, imported here from its own module. It is written apart from the generator and the inventory, so a name is
 * held to the function the connection form runs by identity, and never by a function's `name`.
 */
const NAMED_FUNCTIONS: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, unknown>>>>> = {
  snowflake: { hostCheck: snowflakeAccountRefusal, hostHint: snowflakeHostHint, hostIdentity: snowflakeHostIdentity },
  kubernetes: { importer: importKubeconfig },
};

/** The function `name` resolves to for `type` through the census's resolver, or undefined where it names none. */
function resolveNamed(type: DatabaseType, name: string): unknown {
  const table = NAMED_FUNCTIONS[type];
  return table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
}

/** Every function-shaped value under `value`, by its dotted path, a RegExp and an object already seen left unread. */
function functionPaths(value: unknown, at: string, seen = new Set<unknown>()): string[] {
  if (typeof value === "function") return [at];
  if (typeof value !== "object" || value === null || value instanceof RegExp || seen.has(value)) return [];
  seen.add(value);
  return Object.keys(value).flatMap((key) =>
    functionPaths((value as Record<string, unknown>)[key], at === "" ? key : `${at}.${key}`, seen),
  );
}

/** The slots of a connection form entry whose function the declaration names, as `functionPaths` spells them. */
function namedSlotPaths(d: EngineDeclaration): string[] {
  const { connection } = d;
  return [
    ...connection.fieldRules.filter((rule) => rule.check !== null).map((rule) => `fieldRules.${rule.field}.check`),
    ...(connection.hostHint === null ? [] : ["hostHint"]),
    ...(connection.hostIdentity === null ? [] : ["hostIdentity"]),
    ...(connection.import === null ? [] : ["connectionImport.load"]),
  ];
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

  test("the generator refuses, by name, a field rule for a field the engine does not list", () => {
    const form: ConnectionFormSpec = {
      ...CONNECTION_FORM.postgres,
      fieldRules: { warehouse: { required: crypto.randomUUID() } },
    };

    expect(() => buildFieldRules(form, CONNECTION_FIELDS.postgres, "postgres")).toThrow(
      'postgres: the fieldRules entry for "warehouse" names a field the engine does not list',
    );
  });

  test("the generator refuses, by name, a dialog entry for a field the engine does not list", () => {
    const entries: Partial<ConnectionFormSpec>[] = [
      { fieldLabels: { warehouse: "Warehouse" } },
      { fieldHints: { warehouse: "The warehouse a session uses." } },
      { fieldPlaceholders: { warehouse: "COMPUTE_WH" } },
      { fieldOptions: { warehouse: [{ value: "small", label: "Small" }] } },
      { fieldShownWhen: { warehouse: { field: "host", equals: "localhost" } } },
      { fieldDefaults: { warehouse: "COMPUTE_WH" } },
    ];

    for (const entry of entries) {
      const form: ConnectionFormSpec = { ...CONNECTION_FORM.postgres, ...entry };
      const [record] = Object.keys(entry);
      expect(() => buildDialog(form, CONNECTION_FIELDS.postgres, "postgres")).toThrow(
        `postgres: the ${record} entry for "warehouse" names a field the engine does not list`,
      );
    }
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

  test("connection.refused is the engine's REFUSED_CONNECTION_FIELDS row, each field with its sentence, in the order core checks them", () => {
    const entries = (d: EngineDeclaration) => d.connection.refused.map(({ field, refusal }) => [field, refusal]);

    expect(differing((type, d) => sameValue(entries(d), Object.entries(REFUSED_CONNECTION_FIELDS[type])))).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.refused.length > 0).length,
    ).toBeGreaterThan(0);
  });

  test("core refuses a connection that sets a refused field with the sentence its declaration states", () => {
    const connection = (type: DatabaseType, fields: readonly string[]): DatabaseConnection =>
      ({
        id: `census-${type}`,
        name: `census-${type}`,
        type,
        ...Object.fromEntries(fields.map((field) => [field, crypto.randomUUID()])),
      }) as DatabaseConnection;
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const { refused } = d.connection;
      const fields = refused.map((entry) => entry.field);
      return (
        refused.every(
          ({ field, refusal }) =>
            typeof refusal === "string" && refusedFieldRefusal(connection(type, [field])) === refusal,
        ) &&
        refusedFieldRefusal(connection(type, fields)) === refused[0]?.refusal &&
        refusedFieldRefusal(connection(type, [])) === undefined
      );
    };

    expect(differing(matches)).toEqual([]);
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

  test("connection.dialog.order is the form's dialogOrder", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const order = CONNECTION_FORM[type].dialogOrder;
      const declaredOrder = d.connection.dialog.order;
      return order === undefined ? declaredOrder === null : declaredOrder !== null && sameList(declaredOrder, order);
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.dialog.order !== null)).toEqual([
      "bigquery",
    ]);
  });

  test("connection.dialog.labels, hints and placeholders are the form's", () => {
    const text = (entry: { readonly text: string }) => entry.text;

    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.labels, text), asMap(CONNECTION_FORM[type].fieldLabels)),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.hints, text), asMap(CONNECTION_FORM[type].fieldHints)),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.placeholders, text), asMap(CONNECTION_FORM[type].fieldPlaceholders)),
      ),
    ).toEqual([]);
    const emptyPlaceholders = SHIPPED_DATABASE_TYPES.flatMap((type) =>
      declared(type)
        .connection.dialog.placeholders.filter((entry) => entry.text === "")
        .map((entry) => `${type}.${entry.field}`),
    );
    expect(emptyPlaceholders.length).toBeGreaterThan(0);
  });

  test("connection.dialog.placement is the form's fieldPlacement", () => {
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.placement, (entry) => entry.where),
          asMap(CONNECTION_FORM[type].fieldPlacement),
        ),
      ),
    ).toEqual([]);
  });

  test("connection.dialog.options are the form's fieldOptions, choices in order", () => {
    const choices = (entry: { readonly choices: readonly { readonly value: string; readonly label: string }[] }) =>
      entry.choices.map(({ value, label }) => ({ value, label }));

    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.options, choices), asMap(CONNECTION_FORM[type].fieldOptions)),
      ),
    ).toEqual([]);
  });

  test("connection.dialog.shownWhen and absentValues are the form's fieldShownWhen and fieldDefaults", () => {
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.shownWhen, ({ when }) => ({ field: when.field, equals: when.equals })),
          asMap(CONNECTION_FORM[type].fieldShownWhen),
        ),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.absentValues, (entry) => entry.value),
          asMap(CONNECTION_FORM[type].fieldDefaults),
        ),
      ),
    ).toEqual([]);
  });

  test("a form read from the declaration shows the same fields as the connection form for every value of each controlling field", () => {
    const outside = `outside-${crypto.randomUUID()}`;
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const form = CONNECTION_FORM[type];
      const fromDeclaration: ConnectionFormSpec = {
        label: form.label,
        defaultPort: form.defaultPort,
        showConnectionStringToggle: form.showConnectionStringToggle,
        connectionFields: d.connection.fields as readonly ConnectionField[],
        fieldShownWhen: byField(d.connection.dialog.shownWhen, ({ when }) => ({
          field: when.field as ConnectionField,
          equals: when.equals,
        })),
        fieldDefaults: byField(d.connection.dialog.absentValues, (entry) => entry.value),
      };
      const controllers = new Set<ConnectionField>([
        ...Object.values(form.fieldShownWhen ?? {}).map((condition) => condition.field),
        ...d.connection.dialog.shownWhen.map(({ when }) => when.field as ConnectionField),
      ]);
      return [...controllers].every((controller) => {
        const values: unknown[] = [
          ...(form.fieldOptions?.[controller] ?? []).map((choice) => choice.value),
          undefined,
          null,
          "",
          outside,
        ];
        return values.every((value) =>
          form.connectionFields.every(
            (field) =>
              connectionFieldShown(fromDeclaration, field, { [controller]: value }) ===
              connectionFieldShown(form, field, { [controller]: value }),
          ),
        );
      });
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.dialog.shownWhen.length > 0)).toEqual([
      "snowflake",
    ]);
  });

  test("connection.hostUriSchemes is the form's hostAcceptsUri, in order", () => {
    expect(
      differing((type, d) => sameList(d.connection.hostUriSchemes, CONNECTION_FORM[type].hostAcceptsUri ?? [])),
    ).toEqual([]);
  });

  test("connection.credentialWarnings is the engine's CREDENTIAL_WARNINGS row, and the form reads that same row", () => {
    expect(differing((type, d) => sameValue(d.connection.credentialWarnings, CREDENTIAL_WARNINGS[type] ?? []))).toEqual(
      [],
    );
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) =>
          CREDENTIAL_WARNINGS[type] !== undefined &&
          CONNECTION_FORM[type].credentialWarnings !== CREDENTIAL_WARNINGS[type],
      ),
    ).toEqual([]);
  });

  test("connection.fieldRules are the form's fieldRules, each pattern by its source and flags", () => {
    const fromDeclaration = (d: EngineDeclaration) =>
      byField(d.connection.fieldRules, (rule) => ({
        required: rule.required,
        format:
          rule.format === null
            ? null
            : { source: rule.format.pattern.source, flags: rule.format.pattern.flags, sentence: rule.format.sentence },
        charRange: rule.charRange,
        check: rule.check !== null,
      }));
    const fromForm = (type: DatabaseType) =>
      Object.fromEntries(
        Object.entries(asMap<ConnectionFieldRule>(CONNECTION_FORM[type].fieldRules)).map(([field, rule]) => [
          field,
          {
            required: rule.required ?? null,
            format:
              rule.format === undefined
                ? null
                : {
                    source: rule.format.pattern.source,
                    flags: rule.format.pattern.flags,
                    sentence: rule.format.sentence,
                  },
            charRange: rule.charRange === undefined ? null : { ...rule.charRange },
            check: rule.check !== undefined,
          },
        ]),
      );

    expect(differing((type, d) => sameValue(fromDeclaration(d), fromForm(type)))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.fieldRules.length > 0).length).toBe(6);
  });

  test("a form whose rules are read from the declaration refuses exactly what the connection form refuses", () => {
    const corpus: readonly unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "a",
      "x".repeat(600),
      "\u00e9t\u00e9",
      "a b",
      "default, kube-system,monitoring",
      "/k8s/clusters/c-m-12345",
      "5432",
      "70000",
      "`sales data`",
      "myorg-myaccount",
      "https://myorg-myaccount.snowflakecomputing.com",
      "xy12345.privatelink",
      crypto.randomUUID(),
    ];
    const readForm = (type: DatabaseType, d: EngineDeclaration): ConnectionFormSpec => {
      const form = CONNECTION_FORM[type];
      return {
        label: form.label,
        defaultPort: form.defaultPort,
        showConnectionStringToggle: form.showConnectionStringToggle,
        connectionFields: d.connection.fields as readonly ConnectionField[],
        fieldShownWhen: byField(d.connection.dialog.shownWhen, ({ when }) => ({
          field: when.field as ConnectionField,
          equals: when.equals,
        })),
        fieldDefaults: byField(d.connection.dialog.absentValues, (entry) => entry.value),
        fieldRules: byField(d.connection.fieldRules, (rule): ConnectionFieldRule => {
          const check = rule.check === null ? undefined : resolveNamed(type, rule.check);
          return {
            ...(rule.required === null ? {} : { required: rule.required }),
            ...(rule.format === null
              ? {}
              : {
                  format: {
                    pattern: new RegExp(rule.format.pattern.source, rule.format.pattern.flags),
                    sentence: rule.format.sentence,
                  },
                }),
            ...(rule.charRange === null ? {} : { charRange: rule.charRange }),
            ...(check === undefined ? {} : { check: check as ConnectionFieldRule["check"] }),
          };
        }),
      };
    };
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const form = CONNECTION_FORM[type];
      const fromDeclaration = readForm(type, d);
      const controllers = [...new Set(d.connection.dialog.shownWhen.map(({ when }) => when.field))];
      const states: Record<string, unknown>[] = [
        {},
        ...controllers.flatMap((controller) =>
          [...(form.fieldOptions?.[controller as ConnectionField] ?? []).map((choice) => choice.value), undefined].map(
            (value) => ({ [controller]: value }),
          ),
        ),
      ];
      const fields = d.connection.fieldRules.map((rule) => rule.field as ConnectionField);
      const connection = (values: Record<string, unknown>) =>
        ({ id: `census-${type}`, name: `census-${type}`, type, ...values }) as DatabaseConnection;
      return states.every((state) =>
        corpus.every(
          (value) =>
            // Every rule field alone, so a later field's rule is reached past an earlier field's required rule.
            fields.every(
              (field) =>
                connectionFieldRefusal(
                  { ...fromDeclaration, connectionFields: [field] },
                  connection({ ...state, [field]: value }),
                ) ===
                connectionFieldRefusal(
                  { ...form, connectionFields: [field] },
                  connection({ ...state, [field]: value }),
                ),
            ) &&
            // And the whole form, every rule field holding the value, in field order.
            connectionFieldRefusal(
              fromDeclaration,
              connection({ ...Object.fromEntries(fields.map((field) => [field, value])), ...state }),
            ) ===
              connectionFieldRefusal(
                form,
                connection({ ...Object.fromEntries(fields.map((field) => [field, value])), ...state }),
              ),
        ),
      );
    };

    expect(differing(matches)).toEqual([]);
  });

  test("every function a declaration names is, through the census's own resolver, the very function the connection form runs", async () => {
    const checks = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const form = CONNECTION_FORM[type];
      const { connection } = declared(type);
      const same = (name: string | null, held: unknown) =>
        name === null || (held !== undefined && resolveNamed(type, name) === held);
      const ruleChecks = connection.fieldRules.every((rule) =>
        same(rule.check, form.fieldRules?.[rule.field as ConnectionField]?.check),
      );
      const readers = same(connection.hostHint, form.hostHint) && same(connection.hostIdentity, form.hostIdentity);
      const imported = connection.import;
      const load = form.connectionImport?.load;
      const importer: Promise<boolean> =
        imported === null
          ? Promise.resolve(true)
          : load === undefined
            ? Promise.resolve(false)
            : load().then((loaded) => resolveNamed(type, imported.importer) === loaded);
      return [importer.then((importerMatches) => (ruleChecks && readers && importerMatches ? [] : [type]))];
    });

    expect((await Promise.all(checks)).flat()).toEqual([]);
    expect(
      resolveNamed(
        "snowflake",
        declared("snowflake").connection.fieldRules.find((r) => r.field === "host")?.check ?? "",
      ),
    ).toBe(snowflakeAccountRefusal);
    expect(CONNECTION_FORM.snowflake.fieldRules?.host?.check).toBe(snowflakeAccountRefusal);
  });

  test("every function the connection form holds is named by its engine's declaration, and the resolver names nothing else", () => {
    expect(
      differing((type, d) => sameValue(sorted(functionPaths(CONNECTION_FORM[type], "")), sorted(namedSlotPaths(d)))),
    ).toEqual([]);
    const named = (type: DatabaseType): string[] => {
      const { connection } = declared(type);
      return [
        ...connection.fieldRules.flatMap((rule) => (rule.check === null ? [] : [rule.check])),
        ...(connection.hostHint === null ? [] : [connection.hostHint]),
        ...(connection.hostIdentity === null ? [] : [connection.hostIdentity]),
        ...(connection.import === null ? [] : [connection.import.importer]),
      ];
    };
    const unnamed = Object.entries(NAMED_FUNCTIONS).flatMap(([type, table]) =>
      Object.keys(table ?? {})
        .filter((name) => !named(type as DatabaseType).includes(name))
        .map((name) => `${type}.${name}`),
    );

    expect(unnamed).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => namedSlotPaths(declared(type)).map((slot) => `${type}.${slot}`)),
    ).toEqual([
      "snowflake.fieldRules.host.check",
      "snowflake.hostHint",
      "snowflake.hostIdentity",
      "kubernetes.connectionImport.load",
    ]);
  });

  test("connection.hostHint, hostIdentity and import are the form's, the import with its label", () => {
    expect(
      differing((type, d) => (d.connection.hostHint !== null) === (CONNECTION_FORM[type].hostHint !== undefined)),
    ).toEqual([]);
    expect(
      differing(
        (type, d) => (d.connection.hostIdentity !== null) === (CONNECTION_FORM[type].hostIdentity !== undefined),
      ),
    ).toEqual([]);
    expect(
      differing(
        (type, d) => (d.connection.import?.label ?? null) === (CONNECTION_FORM[type].connectionImport?.label ?? null),
      ),
    ).toEqual([]);
  });

  test("every member of a connection form entry has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof ConnectionFormSpec, string>> = {
      label: "displayName",
      defaultPort: "connection.defaults",
      defaultHost: "connection.defaults",
      showConnectionStringToggle: "connection.connectionString",
      connectionFields: "connection.fields",
      dialogOrder: "connection.dialog.order",
      fieldLabels: "connection.dialog.labels",
      fieldHints: "connection.dialog.hints",
      fieldPlaceholders: "connection.dialog.placeholders",
      fieldPlacement: "connection.dialog.placement",
      hostHint: "connection.hostHint",
      hostIdentity: "connection.hostIdentity",
      fieldRules: "connection.fieldRules",
      fieldOptions: "connection.dialog.options",
      fieldShownWhen: "connection.dialog.shownWhen",
      fieldDefaults: "connection.dialog.absentValues",
      showSslPanel: "connection.tls",
      hostAcceptsUri: "connection.hostUriSchemes",
      credentialWarnings: "connection.credentialWarnings",
      connectionImport: "connection.import",
    };
    const at = (value: unknown, dotted: string): unknown =>
      dotted.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        Object.keys(CONNECTION_FORM[type])
          .filter((member) => !Object.hasOwn(declaredAt, member))
          .map((member) => `${type}.${member}`),
      ),
    ).toEqual([]);
    expect(differing((_type, d) => Object.values(declaredAt).every((member) => at(d, member) !== undefined))).toEqual(
      [],
    );
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

  test("the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select", () => {
    const selects = Object.entries(CONNECTION_FIELD_DESCRIPTORS)
      .filter(([, descriptor]) => descriptor.slot === "body" && descriptor.control.kind === "select")
      .map(([field]) => field);

    expect(sorted(enumOf("placeableFieldName"))).toEqual(sorted(PLACEABLE_FIELDS));
    expect(sorted(enumOf("selectFieldName"))).toEqual(sorted(selects));
  });

  test("the generated unions are Studio's own types", () => {
    const parity: [
      Equal<ManifestMaintenanceOperation, MaintenanceOperation>,
      Equal<Exclude<StatementLanguage, null>, AgentStatementLanguageId>,
      Equal<FieldName, ConnectionField | SeedOnlyField>,
      Equal<AgentCredentialForm, SeedAgentCredential["form"]>,
      Equal<ManifestHostPathField, HostPathField>,
      Equal<ManifestFieldPlacement, FieldPlacement>,
      Equal<ManifestHostUriScheme, HostUriScheme>,
      Equal<ManifestCredentialWarning["kind"], CredentialWarning["kind"]>,
      Equal<JwtAccessClaim, Extract<CredentialWarning, { kind: "jwt" }>["access"][number]>,
      Equal<PlaceableFieldName, PlaceableField>,
      Equal<SelectFieldName, "saslMechanism" | "authMethod">,
    ] = [true, true, true, true, true, true, true, true, true, true, true];

    expect(parity).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
  });
});
