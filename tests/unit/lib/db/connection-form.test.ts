/**
 * The connection dialog's form data, declared in src/lib/db/connection-form.ts: a module with no React, icon or
 * component in its run-time graph, so a bundle without React (the VS Code extension's child, which serves
 * `engines/list`) can load it, and the table `DB_UI_CONFIG` is built from, entry by entry, with only an icon and a
 * colour added.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import * as uiConfig from "@/lib/db-ui-config";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import * as form from "@/lib/db/connection-form";
import * as fieldRules from "@/lib/db/connection-field-rules";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";
import type { TlsMode } from "@libredb/provider-sdk/manifest";
import { admittedDeclarations, type BundledDeclaration } from "../../../../scripts/generate-engine-catalog";
import { CONNECTION_FORM_URI_MODE } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS } from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  CONNECTION_FORM_FUNCTIONS,
  CONNECTION_PICKER_ORDER,
  type ConnectionFieldRule,
  type ConnectionFormFunctions,
  composeConnectionForm,
  connectionFieldHint,
  connectionFieldPlaceholder,
  connectionFieldPlacement,
  offersSslPanel,
} from "@/lib/db/connection-form";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { type ConnectionFormEntry, projectConnectionForms } from "@/lib/db/engine-catalog/projection";
import {
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import type { DatabaseType } from "@/lib/types";
import { fixtureEngineDeclaration } from "../../../helpers/fixture-engine-declaration";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MODULE = join(ROOT, "src/lib/db/connection-form.ts");
const EVERY_TYPE = [...EXTERNAL_DATABASE_TYPES, "libredb"] as DatabaseType[];
const MOVED_READERS = [
  "offersSslPanel",
  "connectionFieldLabel",
  "connectionFieldPlaceholder",
  "connectionFieldHint",
  "connectionFieldPlacement",
] as const;
/** The dialog's two field rule evaluators, which db-ui-config re-exports from the shared rule module. */
const RULE_READERS = ["connectionFieldShown", "connectionFieldRefusal"] as const;

// The picker order must cover the whole DatabaseType union, because this form is also the EDIT
// form: a type missing here renders the edit dialog with no tile selected. Keyed by
// DatabaseType, so adding a provider to the union fails `typecheck` on the missing key
// instead of silently dropping it from the UI. Set an entry to false only to hide a type
// on purpose, and say why.
const PICKER_COVERAGE: Record<DatabaseType, boolean> = {
  postgres: true,
  mysql: true,
  sqlite: true,
  oracle: true,
  db2: true,
  mssql: true,
  mongodb: true,
  redis: true,
  libredb: true,
  couchbase: true,
  clickhouse: true,
  druid: true,
  // Both search ids are selectable: the same form EDITS an existing connection, so
  // an omitted type leaves the picker with nothing selected for a connection the
  // product can otherwise open (issue #424 Phase 1).
  elasticsearch: true,
  opensearch: true,
  trino: true,
  cassandra: true,
  libsql: true,
  duckdb: true,
  prometheus: true,
  kafka: true,
  etcd: true,
  neo4j: true,
  milvus: true,
  qdrant: true,
  weaviate: true,
  influxdb: true,
  influxdb3: true,
  oxia: true,
  databend: true,
  bigquery: true,
  s3: true,
  kubernetes: true,
  mqtt: true,
  firestore: true,
  rabbitmq: true,
  snowflake: true,
  spark: true,
  opcua: true,
  mtconnect: true,
  modbus: true,
  netconf: true,
  snmp: true,
  sparkplug: true,
};

/**
 * Every specifier a file loads at run time: value imports and re-exports, never a type-only one, and every
 * `import("<literal>")` call anywhere in it, because a bundler bundles a dynamic import as well.
 * With `withTypes`, the type-only imports and every `import("<literal>")` type are kept too: the files a
 * typecheck of the module has to read.
 */
function runTimeSpecifiers(path: string, withTypes = false): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (withTypes) {
      found.push(specifier.text);
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypes) continue;
    } else if (statement.isTypeOnly) continue;
    found.push(specifier.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    if (withTypes && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The repository file a specifier names, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier}, imported by ${from}, resolves to no file`);
}

/**
 * Every specifier and repository file the module's run-time import graph reaches, dynamic imports included, or with
 * `withTypes` its whole type-level graph.
 */
function reached(entry: string, withTypes = false): { specifiers: string[]; files: string[] } {
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of runTimeSpecifiers(path, withTypes)) {
      specifiers.add(specifier);
      const local = resolveLocal(path, specifier);
      if (local !== null) queue.push(local);
    }
  }
  return { specifiers: [...specifiers], files: [...seen] };
}

describe("src/lib/db/connection-form.ts", () => {
  test("its run-time graph reaches no React, icon, component or dialog-table module", () => {
    const { specifiers, files } = reached(MODULE);
    expect(
      specifiers.filter(
        (s) =>
          s === "react" ||
          s.startsWith("react/") ||
          s === "react-dom" ||
          s.startsWith("react-dom/") ||
          s === "lucide-react" ||
          s.startsWith("lucide-react/") ||
          s.startsWith("@/components/") ||
          s === "@/lib/db-ui-config",
      ),
    ).toEqual([]);
    expect(files.filter((f) => f.startsWith(join(ROOT, "src/components")))).toEqual([]);
    expect(specifiers).toContain("@/lib/db/connection-fields");
    expect(specifiers).toContain("@/lib/kubernetes/kubeconfig-import");
  });

  test("its type graph reaches no React, icon, component or dialog-table module either", () => {
    // The extension typechecks its child with jsx on, so a type-only import of the dialog table would make that
    // typecheck read every icon component to check one import of CONNECTION_FORM.
    const { specifiers, files } = reached(MODULE, true);
    expect(
      specifiers.filter(
        (s) =>
          s === "react" ||
          s.startsWith("react/") ||
          s === "lucide-react" ||
          s.startsWith("lucide-react/") ||
          s.startsWith("@/components/") ||
          s === "@/lib/db-ui-config",
      ),
    ).toEqual([]);
    expect(files.filter((f) => f.startsWith(join(ROOT, "src/components")))).toEqual([]);
    expect(specifiers).toContain("@/lib/connection-import");
  });

  test("a fresh process loads it on its own", () => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(MODULE)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("DB_UI_CONFIG is CONNECTION_FORM plus an icon and a colour, for every type", () => {
    expect(Object.keys(CONNECTION_FORM).sort()).toEqual([...EVERY_TYPE].sort());
    for (const type of EVERY_TYPE) {
      const { icon, color, ...rest } = DB_UI_CONFIG[type];
      expect({ type, rest }).toEqual({ type, rest: { ...CONNECTION_FORM[type] } });
      expect({ type, keys: Object.keys(DB_UI_CONFIG[type]) }).toEqual({
        type,
        keys: ["icon", "color", ...Object.keys(CONNECTION_FORM[type])],
      });
      expect({ type, icon: icon !== undefined, color: typeof color }).toEqual({ type, icon: true, color: "string" });
      expect({ type, branded: "icon" in CONNECTION_FORM[type] || "color" in CONNECTION_FORM[type] }).toEqual({
        type,
        branded: false,
      });
    }
  });

  test("credentialWarnings stays a getter on both tables", () => {
    for (const type of EVERY_TYPE) {
      for (const [name, table] of [
        ["CONNECTION_FORM", CONNECTION_FORM],
        ["DB_UI_CONFIG", DB_UI_CONFIG],
      ] as const) {
        expect({
          type,
          name,
          getter: typeof Object.getOwnPropertyDescriptor(table[type], "credentialWarnings")?.get,
        }).toEqual({ type, name, getter: "function" });
      }
    }
  });

  test("db-ui-config re-exports the moved readers rather than copies", () => {
    const uiExports: Record<string, unknown> = { ...uiConfig };
    const formExports: Record<string, unknown> = { ...form };
    for (const name of MOVED_READERS) {
      expect({ name, same: typeof formExports[name] === "function" && uiExports[name] === formExports[name] }).toEqual({
        name,
        same: true,
      });
    }
    // The two field rule evaluators are the shared rule module's own, which the test-connection path reads too, and
    // the form table no longer holds them.
    const ruleExports: Record<string, unknown> = { ...fieldRules };
    for (const name of RULE_READERS) {
      expect({
        name,
        same: typeof ruleExports[name] === "function" && uiExports[name] === ruleExports[name],
        inForm: name in formExports,
      }).toEqual({ name, same: true, inForm: false });
    }
    // The read-only control's two sentences are re-exported the same way: one string, never a copy.
    expect([uiConfig.READ_ONLY_TOGGLE_HINT, uiConfig.READ_ONLY_FIXED_HINT]).toEqual([
      form.READ_ONLY_TOGGLE_HINT,
      form.READ_ONLY_FIXED_HINT,
    ]);
  });

  test("offersSslPanel reads CONNECTION_FORM", () => {
    for (const type of EVERY_TYPE) {
      expect({ type, offered: offersSslPanel(type) }).toEqual({
        type,
        offered: CONNECTION_FORM[type].showSslPanel !== false,
      });
    }
  });

  test.each(OUTSIDE_THE_UNION)("offersSslPanel refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => offersSslPanel(value as DatabaseType))).toEqual(refusalOf(value));
  });

  test("the four v0 rows hold the values part 2's table derives", () => {
    expect(CONNECTION_FORM.postgres).toMatchObject({ label: "PostgreSQL", defaultPort: "5432" });
    expect(CONNECTION_FORM.mysql).toMatchObject({ label: "MySQL", defaultPort: "3306" });
    expect(CONNECTION_FORM.mssql).toMatchObject({ label: "SQL Server", defaultPort: "1433" });
    expect(CONNECTION_FORM.mongodb).toMatchObject({ label: "MongoDB", defaultPort: "27017" });
    for (const type of ["postgres", "mysql", "mssql", "mongodb"] as const) {
      expect({ type, defaultHost: CONNECTION_FORM[type].defaultHost, ssl: offersSslPanel(type) }).toEqual({
        type,
        defaultHost: undefined,
        ssl: true,
      });
    }
    expect(connectionFieldPlacement(CONNECTION_FORM.mssql, "instanceName")).toBe("advanced");
    expect(connectionFieldHint(CONNECTION_FORM.mssql, "instanceName")).toBe(
      "For named instances (e.g. SQLEXPRESS). Leave empty for default instance.",
    );
    expect(connectionFieldPlacement(CONNECTION_FORM.mongodb, "authSource")).toBe("open");
    expect(connectionFieldHint(CONNECTION_FORM.mongodb, "authSource")).toBe(
      "The database the user was created in, usually admin. Leave empty when the credentials live in the database above.",
    );
    expect(connectionFieldPlaceholder(CONNECTION_FORM.mongodb, "connectionString", "")).toBe(
      "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
    );
  });
});

describe("CONNECTION_PICKER_ORDER", () => {
  test("starts with the product's default connection type, the one constant every no-connection reader names", () => {
    expect(form.DEFAULT_CONNECTION_TYPE).toBe(DEFAULT_CONNECTION_TYPE);
    expect(CONNECTION_PICKER_ORDER[0]).toBe(DEFAULT_CONNECTION_TYPE);
  });

  test("offers every database type a connection can carry, each once", () => {
    const expected = Object.entries(PICKER_COVERAGE)
      .filter(([, selectable]) => selectable)
      .map(([type]) => type)
      .sort();
    const offered: string[] = [...CONNECTION_PICKER_ORDER].sort();
    expect(offered).toEqual(expected);
    expect(new Set(CONNECTION_PICKER_ORDER).size).toBe(CONNECTION_PICKER_ORDER.length);
    expect(Object.isFrozen(CONNECTION_PICKER_ORDER)).toBe(true);
  });

  test("keeps the picker's shipped order", () => {
    expect(CONNECTION_PICKER_ORDER).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "oracle",
      "mssql",
      "mongodb",
      "couchbase",
      "redis",
      "libredb",
      "clickhouse",
      "druid",
      "elasticsearch",
      "opensearch",
      "trino",
      "cassandra",
      "libsql",
      "duckdb",
      "prometheus",
      "kafka",
      "etcd",
      "db2",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
      "databend",
      "bigquery",
      "s3",
      "kubernetes",
      "mqtt",
      "firestore",
      "rabbitmq",
      "snowflake",
      "opcua",
      "snmp",
      "sparkplug",
      "spark",
      "mtconnect",
      "modbus",
      "netconf",
      "weaviate",
    ]);
  });

  test("puts the four v0 engines in part 2 criterion 2's order", () => {
    const v0 = ["postgres", "mssql", "mysql", "mongodb"];
    expect(CONNECTION_PICKER_ORDER.filter((type) => v0.includes(type))).toEqual([
      "postgres",
      "mysql",
      "mssql",
      "mongodb",
    ]);
  });
});

describe("CONNECTION_FORM, composed from each engine's declaration and Studio's function table", () => {
  const ADMITTED: readonly BundledDeclaration[] = admittedDeclarations();
  const FORMS = projectConnectionForms(ADMITTED);
  const declared = (type: DatabaseType): BundledDeclaration => {
    const declaration = ADMITTED.find((d) => d.id === type);
    if (declaration === undefined) throw new Error(`no declaration of ${type}`);
    return declaration;
  };
  const formOf = (type: DatabaseType): ConnectionFormEntry => FORMS[type] as ConnectionFormEntry;
  /** A dialog list as a record keyed by field in list order, or undefined where the list is empty. */
  const recordOf = <Entry extends { readonly field: string }, Value>(
    list: readonly Entry[],
    read: (entry: Entry) => Value,
  ): Record<string, Value> | undefined =>
    list.length === 0 ? undefined : Object.fromEntries(list.map((entry) => [entry.field, read(entry)]));
  const sorted = (keys: readonly string[]) => [...keys].sort();

  test("each entry is its declaration's form members composed with Studio's function table", async () => {
    const differing: string[] = [];
    for (const type of EVERY_TYPE) {
      const entry = CONNECTION_FORM[type];
      const { displayName, connection } = declared(type);
      const { dialog } = connection;
      const checks = CONNECTION_FORM_FUNCTIONS.checks[type] ?? {};
      const expected = {
        label: displayName,
        defaultPort: connection.defaults.port === undefined ? "" : String(connection.defaults.port),
        defaultHost: connection.defaults.host,
        showConnectionStringToggle: connection.connectionString.dialogOffersUri,
        dialogOrder: dialog.order ?? undefined,
        fieldLabels: recordOf(dialog.labels, ({ text }) => text),
        fieldHints: recordOf(dialog.hints, ({ text }) => text),
        fieldPlaceholders: recordOf(dialog.placeholders, ({ text }) => text),
        fieldPlacement: recordOf(dialog.placement, ({ where }) => where),
        hostHint:
          connection.hostHint === null ? undefined : CONNECTION_FORM_FUNCTIONS.hostHints[type]?.[connection.hostHint],
        hostIdentity:
          connection.hostIdentity === null
            ? undefined
            : CONNECTION_FORM_FUNCTIONS.hostIdentities[type]?.[connection.hostIdentity],
        fieldOptions: recordOf(dialog.options, ({ choices }) => choices),
        fieldShownWhen: recordOf(dialog.shownWhen, ({ when }) => when),
        fieldDefaults: recordOf(dialog.absentValues, ({ value }) => value),
        showSslPanel: connection.tls.modes.length === 0 ? false : undefined,
        hostAcceptsUri: connection.hostUriSchemes.length === 0 ? undefined : connection.hostUriSchemes,
      };
      const rules = recordOf(connection.fieldRules, (rule) => rule);
      const { connectionFields, credentialWarnings, fieldRules, connectionImport, ...rest } = entry;
      const restExpected = Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined));
      // Every member equal, each per-field record keyed in the declaration's field order, and no member beyond them.
      const same =
        JSON.stringify(Object.keys(rest)) === JSON.stringify(Object.keys(restExpected)) &&
        JSON.stringify(rest) === JSON.stringify(restExpected) &&
        rest.hostHint === expected.hostHint &&
        rest.hostIdentity === expected.hostIdentity &&
        connectionFields === CONNECTION_FIELDS[type] &&
        credentialWarnings === CREDENTIAL_WARNINGS[type] &&
        typeof Object.getOwnPropertyDescriptor(entry, "credentialWarnings")?.get === "function" &&
        entry.showConnectionStringToggle === CONNECTION_FORM_URI_MODE[type] &&
        JSON.stringify(Object.keys(fieldRules ?? {})) === JSON.stringify(Object.keys(rules ?? {})) &&
        Object.entries(rules ?? {}).every(([field, rule]) => {
          const held: ConnectionFieldRule | undefined = fieldRules?.[field as keyof typeof fieldRules];
          return (
            held !== undefined &&
            held.required === (rule.required ?? undefined) &&
            (rule.format === null
              ? held.format === undefined
              : held.format?.pattern.source === rule.format.pattern.source &&
                held.format.pattern.flags === rule.format.pattern.flags &&
                held.format.sentence === rule.format.sentence) &&
            JSON.stringify(held.charRange) === JSON.stringify(rule.charRange ?? undefined) &&
            held.check === (rule.check === null ? undefined : checks[rule.check])
          );
        }) &&
        (connection.import === null
          ? connectionImport === undefined
          : connectionImport?.label === connection.import.label &&
            connectionImport.load === CONNECTION_FORM_FUNCTIONS.importers[type]?.[connection.import.importer]);
      if (!same) differing.push(type);
    }

    expect(differing).toEqual([]);
    // Every function is Studio's own, by identity, at its slot.
    expect(CONNECTION_FORM.snowflake.fieldRules?.host?.check).toBe(snowflakeAccountRefusal);
    expect(CONNECTION_FORM.snowflake.hostHint).toBe(snowflakeHostHint);
    expect(CONNECTION_FORM.snowflake.hostIdentity).toBe(snowflakeHostIdentity);
    const load = CONNECTION_FORM.kubernetes.connectionImport?.load;
    expect(load).toBeDefined();
    expect(await load?.()).toBe((await import("@/lib/kubernetes/kubeconfig-import")).importKubeconfig);
    // A pattern is compiled once, so every read answers the same RegExp.
    expect(CONNECTION_FORM.s3.fieldRules?.user?.format?.pattern).toBe(
      CONNECTION_FORM.s3.fieldRules?.user?.format?.pattern,
    );
    expect(CONNECTION_FORM.s3.fieldRules?.user?.format?.pattern).toBeInstanceOf(RegExp);
    // The record, each entry and each of its records are frozen; the declaration's lists are not handed out.
    expect(Object.isFrozen(CONNECTION_FORM)).toBe(true);
    expect(EVERY_TYPE.every((type) => Object.isFrozen(CONNECTION_FORM[type]))).toBe(true);
    expect(Object.isFrozen(CONNECTION_FORM.snowflake.fieldShownWhen)).toBe(true);
    expect(Object.isFrozen(CONNECTION_FORM.snowflake.fieldRules?.host)).toBe(true);
  });

  test("a declaration naming a function Studio holds none for is refused by name when its form is composed", () => {
    const postgres = declared("postgres");
    const fixture = fixtureEngineDeclaration(postgres);
    const naming = { ...fixture, connection: { ...fixture.connection, hostHint: "hostHint" } };
    const fixtureForm = projectConnectionForms([naming]).acmefoo as ConnectionFormEntry;

    expect(() => composeConnectionForm("acmefoo" as DatabaseType, fixtureForm, CONNECTION_FORM_FUNCTIONS)).toThrow(
      'acmefoo names the function "hostHint", which Studio holds no function for.',
    );
    // The fixture as committed names none, so it composes.
    const plain = projectConnectionForms([fixture]).acmefoo as ConnectionFormEntry;
    expect(composeConnectionForm("acmefoo" as DatabaseType, plain, CONNECTION_FORM_FUNCTIONS).label).toBe("Acme Foo");

    // Snowflake's account check renamed: no default, no skipped slot.
    const snowflake = formOf("snowflake");
    const renamed: ConnectionFormEntry = {
      ...snowflake,
      fieldRules: snowflake.fieldRules.map((rule) => (rule.check === null ? rule : { ...rule, check: "hostCheckV2" })),
    };
    expect(() => composeConnectionForm("snowflake", renamed, CONNECTION_FORM_FUNCTIONS)).toThrow(
      'snowflake names the function "hostCheckV2", which Studio holds no function for.',
    );
    // An engine whose table holds nothing at all names the engine and the name.
    const empty: ConnectionFormFunctions = { checks: {}, hostHints: {}, hostIdentities: {}, importers: {} };
    expect(() => composeConnectionForm("kubernetes", formOf("kubernetes"), empty)).toThrow(
      'kubernetes names the function "importer", which Studio holds no function for.',
    );
    expect(() => composeConnectionForm("snowflake", snowflake, empty)).toThrow(
      'snowflake names the function "hostCheck", which Studio holds no function for.',
    );
    // A table holding only what the declarations name composes every engine.
    for (const type of EVERY_TYPE) {
      expect(() => composeConnectionForm(type, formOf(type), CONNECTION_FORM_FUNCTIONS)).not.toThrow();
    }
  });

  test("a composed form offers the SSL / TLS panel exactly where its engine lists any TLS mode, one or several", () => {
    const fixture = fixtureEngineDeclaration(declared("postgres"));
    const panelOf = (modes: readonly TlsMode[]) => {
      const listing = { ...fixture, connection: { ...fixture.connection, tls: { modes } } };
      const entry = projectConnectionForms([listing]).acmefoo as ConnectionFormEntry;
      return composeConnectionForm("acmefoo" as DatabaseType, entry, CONNECTION_FORM_FUNCTIONS).showSslPanel;
    };

    expect(panelOf([])).toBe(false);
    expect(panelOf(["verify-full"])).toBeUndefined();
    expect(panelOf(["verify-system", "verify-full"])).toBeUndefined();
    expect(panelOf(["disable", "require", "verify-system", "verify-ca", "verify-full"])).toBeUndefined();
  });

  test("a name Studio holds only for another slot is refused by name", () => {
    const snowflake = formOf("snowflake");
    const kubernetes = formOf("kubernetes");

    for (const [type, entry, name] of [
      ["snowflake", { ...snowflake, hostIdentity: "hostHint" }, "hostHint"],
      ["snowflake", { ...snowflake, hostHint: "hostIdentity" }, "hostIdentity"],
      [
        "snowflake",
        {
          ...snowflake,
          fieldRules: snowflake.fieldRules.map(({ field, required, format, charRange, check }) => ({
            field,
            required,
            format,
            charRange,
            check: check === null ? null : "hostHint",
          })),
        },
        "hostHint",
      ],
      ["kubernetes", { ...kubernetes, import: { label: "Import kubeconfig", importer: "hostCheck" } }, "hostCheck"],
      ["kubernetes", { ...kubernetes, hostHint: "importer" }, "importer"],
    ] as const satisfies readonly (readonly [DatabaseType, ConnectionFormEntry, string])[]) {
      expect(() => composeConnectionForm(type, entry, CONNECTION_FORM_FUNCTIONS)).toThrow(
        `${type} names the function "${name}", which Studio holds no function for.`,
      );
    }
  });

  test("a form entry for a field the connection dialog does not draw is refused by name when its form is composed", () => {
    const opcua = formOf("opcua");
    // A seed-only field, which the SDK's validator refuses in a dialog entry of an admitted declaration.
    const entries: readonly ConnectionFormEntry[] = [
      { ...opcua, dialog: { ...opcua.dialog, hints: [{ field: "clientCertificatePath", text: "A path." }] } },
      { ...opcua, dialog: { ...opcua.dialog, order: ["host", "clientCertificatePath"] } },
      {
        ...opcua,
        dialog: {
          ...opcua.dialog,
          shownWhen: [{ field: "host", when: { field: "clientCertificatePath", equals: "x" } }],
        },
      },
      {
        ...opcua,
        fieldRules: [
          { field: "clientCertificatePath", required: "Enter it.", format: null, charRange: null, check: null },
        ],
      },
    ];

    for (const entry of entries) {
      expect(() => composeConnectionForm("opcua", entry, CONNECTION_FORM_FUNCTIONS)).toThrow(
        "opcua declares a connection form entry for clientCertificatePath, which Studio's connection dialog does not draw.",
      );
    }
  });

  test("Studio's function table holds exactly the functions the committed declarations name, each at its own slot", () => {
    const named = (read: (d: BundledDeclaration) => readonly (string | null)[]) =>
      Object.fromEntries(
        ADMITTED.flatMap((d) => {
          const names = read(d).filter((name): name is string => name !== null);
          return names.length === 0 ? [] : [[d.id, sorted(names)]];
        }),
      );
    const held = (table: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, unknown>>>>>) =>
      Object.fromEntries(Object.entries(table).map(([type, slots]) => [type, sorted(Object.keys(slots ?? {}))]));

    expect(held(CONNECTION_FORM_FUNCTIONS.checks)).toEqual(named((d) => d.connection.fieldRules.map((r) => r.check)));
    expect(held(CONNECTION_FORM_FUNCTIONS.hostHints)).toEqual(named((d) => [d.connection.hostHint]));
    expect(held(CONNECTION_FORM_FUNCTIONS.hostIdentities)).toEqual(named((d) => [d.connection.hostIdentity]));
    expect(held(CONNECTION_FORM_FUNCTIONS.importers)).toEqual(named((d) => [d.connection.import?.importer ?? null]));
    expect(Object.isFrozen(CONNECTION_FORM_FUNCTIONS)).toBe(true);
    expect(Object.values(CONNECTION_FORM_FUNCTIONS).every((table) => Object.isFrozen(table))).toBe(true);
  });
});
