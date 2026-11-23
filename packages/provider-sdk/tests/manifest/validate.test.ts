/**
 * Every failure of a manifest is a named refusal, and no refusal carries a value of the manifest
 * (docs/providers/CONTRACT.md, clauses M-4, M-5, M-7, M-11 and M-14).
 *
 * Each case starts from the minimal fixture, changes one thing, and asserts the exact refusal list, so a change in how
 * ajv reports an error fails here rather than reaching a host as a different refusal.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compileManifestValidator,
  type ManifestRefusal,
  refusalSentence,
  type SchemaRefusal,
  SCHEMA_REFUSAL_RULES,
  type SchemaRefusalRule,
} from "@libredb/provider-sdk/manifest";
import { errorsOf, refusalsOf } from "../../src/manifest/validate";

const SCHEMA_BYTES = readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"));
const validator = compileManifestValidator(SCHEMA_BYTES);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft manifest each case bends into a shape the schema refuses.
type Json = Record<string, any>;

/** A fresh copy of the minimal fixture, changed by `change`. */
function manifest(change: (draft: Json) => void = () => {}): Json {
  const draft = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  change(draft);
  return draft;
}

function refusal(rule: SchemaRefusalRule, pointer: string, key?: string): SchemaRefusal {
  return key === undefined
    ? { code: "PROVIDER_SCHEMA_INVALID", rule, pointer }
    : { code: "PROVIDER_SCHEMA_INVALID", rule, pointer, key };
}

function refusalsFor(value: unknown): readonly ManifestRefusal[] {
  const verdict = validator.validate(value);
  return verdict.admitted ? [] : verdict.refusals;
}

const SEED_ONLY = {
  fields: ["database"],
  scope: "each",
  refusal: "{field} is ExampleDB only.",
  projectionRefusal: null,
};
const NATIVE = {
  package: "exampledb-native-linux-x64",
  version: "1.2.3",
  targets: [{ os: "linux", cpu: "x64", libc: "glibc" }],
  nodeApi: 8,
};

/** The connection of the fixture's one engine. */
const connectionOf = (m: Json): Json => m.engines[0].connection;

/** The connection string of the fixture's one engine. */
const connectionStringOf = (m: Json): Json => m.engines[0].connection.connectionString;

/** A paste reader named `pasteReader`, not a catch-all, naming `formats`. */
function paste(formats: unknown[] = ["exampledb://"]): Json {
  return { reader: "pasteReader", catchAll: false, formats };
}

/** A field rule for `field` that states only what `members` gives, every other member null. */
function fieldRule(field: string, members: Json = {}): Json {
  return { field, required: null, format: null, charRange: null, check: null, ...members };
}

/** A format whose pattern is `source` with `flags`, refused with a generated sentence. */
function format(source: string, flags = ""): Json {
  return { pattern: { source, flags }, sentence: randomUUID() };
}

/**
 * The fixture's engine shaped like Snowflake's sign-in: a select, `authMethod`, whose choices are `keypair` and `pat`,
 * a private key shown only on `keypair`, a password shown only on `pat`, and `keypair` as the absent value.
 */
function signInShaped(m: Json): void {
  const connection = connectionOf(m);
  connection.fields = ["host", "user", "authMethod", "privateKey", "password", "warehouse"];
  connection.dialog.options = [
    {
      field: "authMethod",
      choices: [
        { value: "keypair", label: "Key pair" },
        { value: "pat", label: "Programmatic access token" },
      ],
    },
  ];
  connection.dialog.shownWhen = [
    { field: "privateKey", when: { field: "authMethod", equals: "keypair" } },
    { field: "password", when: { field: "authMethod", equals: "pat" } },
  ];
  connection.dialog.absentValues = [{ field: "authMethod", value: "keypair" }];
}

describe("schema refusals", () => {
  test.each([
    ["at the top level", (m: Json) => (m.bogus = 1), ""],
    ["in an engine", (m: Json) => (m.engines[0].bogus = 1), "/engines/0"],
    ["in a connection", (m: Json) => (m.engines[0].connection.bogus = 1), "/engines/0/connection"],
    ["in a native package", (m: Json) => (m.runtime.native = [{ ...NATIVE, bogus: 1 }]), "/runtime/native/0"],
  ])("an unknown key %s is refused as unknown-key at its pointer", (_where, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("unknown-key", pointer, "bogus")]);
  });

  test.each([
    ["contract", (m: Json) => delete m.contract, "", "contract"],
    ["engines", (m: Json) => delete m.engines, "", "engines"],
    ["connection.refused", (m: Json) => delete m.engines[0].connection.refused, "/engines/0/connection", "refused"],
    ["connection.dialog", (m: Json) => delete m.engines[0].connection.dialog, "/engines/0/connection", "dialog"],
    [
      "connection.fieldRules",
      (m: Json) => delete m.engines[0].connection.fieldRules,
      "/engines/0/connection",
      "fieldRules",
    ],
    ["connection.hostHint", (m: Json) => delete m.engines[0].connection.hostHint, "/engines/0/connection", "hostHint"],
    [
      "connection.hostIdentity",
      (m: Json) => delete m.engines[0].connection.hostIdentity,
      "/engines/0/connection",
      "hostIdentity",
    ],
    ["connection.import", (m: Json) => delete m.engines[0].connection.import, "/engines/0/connection", "import"],
    [
      "connection.connectionString.scheme",
      (m: Json) => delete m.engines[0].connection.connectionString.scheme,
      "/engines/0/connection/connectionString",
      "scheme",
    ],
    [
      "connection.connectionString.urlTls",
      (m: Json) => delete m.engines[0].connection.connectionString.urlTls,
      "/engines/0/connection/connectionString",
      "urlTls",
    ],
    [
      "connection.connectionString.paste",
      (m: Json) => delete m.engines[0].connection.connectionString.paste,
      "/engines/0/connection/connectionString",
      "paste",
    ],
    [
      "connection.connectionString.seedCheck",
      (m: Json) => delete m.engines[0].connection.connectionString.seedCheck,
      "/engines/0/connection/connectionString",
      "seedCheck",
    ],
    [
      "connection.dialog.absentValues",
      (m: Json) => delete m.engines[0].connection.dialog.absentValues,
      "/engines/0/connection/dialog",
      "absentValues",
    ],
    [
      "facets.monitoring.storage",
      (m: Json) => delete m.engines[0].facets.monitoring.storage,
      "/engines/0/facets/monitoring",
      "storage",
    ],
  ])("a missing %s is refused as missing-key", (_name, change, pointer, key) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("missing-key", pointer, key)]);
  });

  test.each([
    ["a location outside the vocabulary", (m: Json) => (m.engines[0].location = "remote"), "/engines/0/location"],
    [
      "a TLS offer outside the vocabulary",
      (m: Json) => (m.engines[0].connection.tls = "maybe"),
      "/engines/0/connection/tls",
    ],
    [
      "a field name outside the vocabulary",
      (m: Json) => m.engines[0].connection.fields.push("colour"),
      "/engines/0/connection/fields/5",
    ],
    [
      "a monitoring offer outside the vocabulary",
      (m: Json) => (m.engines[0].facets.monitoring.overview = "stub"),
      "/engines/0/facets/monitoring/overview",
    ],
  ])("%s is refused as value-not-allowed", (_name, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("value-not-allowed", pointer)]);
  });

  test.each([
    ["an upper-case engine id", (m: Json) => (m.engines[0].id = "Foo"), "/engines/0/id"],
    ["a contract with no minor", (m: Json) => (m.contract = "1"), "/contract"],
    ["an entry that climbs out of the package", (m: Json) => (m.runtime.entry = "../escape.mjs"), "/runtime/entry"],
    [
      "an image without a full sha256 digest",
      (m: Json) =>
        (m.compatibility[0].tested[0].image = { repository: "docker.io/exampledb/server", digest: "sha256:abc" }),
      "/compatibility/0/tested/0/image/digest",
    ],
    [
      "a refusal template naming {value}",
      (m: Json) => (m.engines[0].connection.seedOnly = { ...SEED_ONLY, refusal: "{value} is ExampleDB only." }),
      "/engines/0/connection/seedOnly/refusal",
    ],
  ])("%s is refused as pattern-mismatch", (_name, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("pattern-mismatch", pointer)]);
  });

  test("an empty engine list is refused as too-few", () => {
    expect(refusalsFor(manifest((m) => (m.engines = [])))).toEqual([refusal("too-few", "/engines")]);
  });

  test("a list longer than its maxItems is refused as too-many", () => {
    const changed = manifest((m) => {
      m.engines = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(m.engines[0]), id: `db${index}` }));
    });

    expect(refusalsFor(changed)).toEqual([refusal("too-many", "/engines")]);
  });

  test("a field listed twice is refused as duplicate at the second", () => {
    const changed = manifest((m) => m.engines[0].connection.fields.push("host"));

    expect(refusalsFor(changed)).toEqual([refusal("duplicate", "/engines/0/connection/fields/5")]);
  });

  test.each([0, 70000])("port %d is refused as out-of-range", (port) => {
    const changed = manifest((m) => (m.engines[0].connection.defaults.port = port));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/connection/defaults/port")]);
  });

  test("a display name longer than 64 characters is refused as out-of-range", () => {
    const changed = manifest((m) => (m.engines[0].displayName = "x".repeat(65)));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/displayName")]);
  });

  test("a string where a list belongs is refused as wrong-type", () => {
    const changed = manifest((m) => (m.engines[0].connection.fields = "host"));

    expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/fields")]);
  });

  test("a value that is not an object is refused as wrong-type at the top level", () => {
    expect(refusalsFor("manifest")).toEqual([refusal("wrong-type", "")]);
  });

  test("a failed variant is one no-variant refusal and nothing under it", () => {
    const changed = manifest((m) => (m.engines[0].connection.sshTunnel = { offered: false }));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/sshTunnel")]);
  });

  test("a version claim of no known kind is one no-variant refusal", () => {
    const changed = manifest((m) => (m.compatibility[0].versions = { kind: "rnage", from: "1", to: "2" }));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/compatibility/0/versions")]);
  });

  test.each([
    ["a label longer than 128 characters", "labels", "x".repeat(129)],
    ["an empty label", "labels", ""],
    ["a hint longer than 2000 characters", "hints", "x".repeat(2001)],
    ["an empty hint", "hints", ""],
    ["a placeholder longer than 256 characters", "placeholders", "x".repeat(257)],
  ])("%s is refused as out-of-range", (_name, list, text) => {
    const changed = manifest((m) => (connectionOf(m).dialog[list] = [{ field: "user", text }]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", `/engines/0/connection/dialog/${list}/0/text`)]);
  });

  test("an empty placeholder is admitted: it means the field shows no example", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.placeholders = [{ field: "user", text: "" }]));

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a placement for a field that is not placeable is refused as value-not-allowed", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.placement = [{ field: "host", where: "open" }]));

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/placement/0/field"),
    ]);
  });

  test("a placement other than open or advanced is refused as value-not-allowed", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("serviceName");
      connectionOf(m).dialog.placement = [{ field: "serviceName", where: "hidden" }];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/placement/0/where"),
    ]);
  });

  test("choices for a field that is not a select are refused as value-not-allowed", () => {
    const changed = manifest(
      (m) => (connectionOf(m).dialog.options = [{ field: "database", choices: [{ value: "a", label: "A" }] }]),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/options/0/field"),
    ]);
  });

  test("an options entry with no choice is refused as too-few", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("saslMechanism");
      connectionOf(m).dialog.options = [{ field: "saslMechanism", choices: [] }];
    });

    expect(refusalsFor(changed)).toEqual([refusal("too-few", "/engines/0/connection/dialog/options/0/choices")]);
  });

  test("a dialog order naming a field twice is refused as duplicate at the second", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.order = ["user", "host", "user"]));

    expect(refusalsFor(changed)).toEqual([refusal("duplicate", "/engines/0/connection/dialog/order/2")]);
  });

  test("a condition with a second key is refused as unknown-key", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[0].when.in = ["keypair", "pat"];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("unknown-key", "/engines/0/connection/dialog/shownWhen/0/when", "in"),
    ]);
  });

  test("a URI scheme other than http or https is refused as value-not-allowed", () => {
    const changed = manifest((m) => (connectionOf(m).hostUriSchemes = ["https", "ftp"]));

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/0/connection/hostUriSchemes/1")]);
  });

  test("the three credential warning kinds are admitted, a pair with an empty password among them", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).credentialWarnings = [
          { kind: "pair", user: "root", password: "", message: randomUUID() },
          { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
          { kind: "jwt", noExp: true, access: ["m", "absent"], message: randomUUID() },
          { kind: "jwt", noExp: true, access: [], message: randomUUID() },
          { kind: "no-secret", message: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([]);
  });

  test.each([
    ["of no known kind", { kind: "default", message: "m" }],
    ["of the jwt kind with noExp false", { kind: "jwt", noExp: false, access: [], message: "m" }],
    ["of the jwt kind naming one access claim twice", { kind: "jwt", noExp: true, access: ["m", "m"], message: "m" }],
    ["of the pair kind with no user", { kind: "pair", password: "", message: "m" }],
  ])("a credential warning %s is one no-variant refusal", (_name, warning) => {
    const changed = manifest((m) => (connectionOf(m).credentialWarnings = [warning]));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/credentialWarnings/0")]);
  });

  test("refused entries, each a field with its sentence, are admitted", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).refused = [
          { field: "apiKeyId", refusal: randomUUID() },
          { field: "apiKeySecret", refusal: "x".repeat(2000) },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a refused entry without its sentence is refused as missing-key", () => {
    const changed = manifest((m) => (connectionOf(m).refused = [{ field: "region" }]));

    expect(refusalsFor(changed)).toEqual([refusal("missing-key", "/engines/0/connection/refused/0", "refusal")]);
  });

  test.each([
    ["an empty sentence", ""],
    ["a sentence longer than 2000 characters", "x".repeat(2001)],
  ])("a refused entry with %s is refused as out-of-range", (_name, sentence) => {
    const changed = manifest((m) => (connectionOf(m).refused = [{ field: "region", refusal: sentence }]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/connection/refused/0/refusal")]);
  });

  test("a refused entry with a third key is refused as unknown-key", () => {
    const changed = manifest(
      (m) => (connectionOf(m).refused = [{ field: "region", refusal: randomUUID(), value: randomUUID() }]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("unknown-key", "/engines/0/connection/refused/0", "value")]);
  });

  test("a field rule with a pattern, a range and a named check, both host readers and an import are admitted", () => {
    const changed = manifest((m) => {
      connectionOf(m).fieldRules = [
        fieldRule("host", {
          required: randomUUID(),
          format: format("^[a-z]+$"),
          charRange: { min: 3, max: 512, sentence: randomUUID() },
          check: "hostCheck",
        }),
        fieldRule("database", { format: format("^\\p{L}+$", "u") }),
        fieldRule("user", { required: randomUUID() }),
      ];
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
      connectionOf(m).import = { label: "Import kubeconfig", importer: "importer" };
    });

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a field rule's pattern longer than 512 characters is refused as out-of-range", () => {
    const long = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("a".repeat(513)) })]),
    );
    const empty = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("") })]));
    const longest = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("a".repeat(512)) })]),
    );

    expect(refusalsFor(long)).toEqual([
      refusal("out-of-range", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(empty)).toEqual([
      refusal("out-of-range", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a field rule's pattern with a flag other than u is refused as value-not-allowed", () => {
    for (const flags of ["g", "y", "ui", "i"]) {
      const changed = manifest(
        (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^a$", flags) })]),
      );

      expect(refusalsFor(changed)).toEqual([
        refusal("value-not-allowed", "/engines/0/connection/fieldRules/0/format/pattern/flags"),
      ]);
    }
  });

  test.each([
    ["an empty required sentence", { required: "" }, "/required"],
    ["a required sentence longer than 2000 characters", { required: "x".repeat(2001) }, "/required"],
    [
      "an empty format sentence",
      { format: { pattern: { source: "^a$", flags: "" }, sentence: "" } },
      "/format/sentence",
    ],
    ["a range minimum below 0", { charRange: { min: -1, max: 3, sentence: "s" } }, "/charRange/min"],
    ["a range maximum of 0", { charRange: { min: 0, max: 0, sentence: "s" } }, "/charRange/max"],
    ["a range maximum above 65535", { charRange: { min: 0, max: 65536, sentence: "s" } }, "/charRange/max"],
  ])("a field rule with %s is refused as out-of-range", (_name, members, under) => {
    const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", members)]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", `/engines/0/connection/fieldRules/0${under}`)]);
  });

  test("a fractional range minimum is refused as wrong-type", () => {
    const changed = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { charRange: { min: 1.5, max: 3, sentence: "s" } })]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/fieldRules/0/charRange/min")]);
  });

  test("a field rule with a fifth key, or without its check, is refused by key", () => {
    const fifth = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { required: "r", message: randomUUID() })]),
    );
    const noCheck = manifest((m) => {
      const rule = fieldRule("host", { required: "r" });
      delete rule.check;
      connectionOf(m).fieldRules = [rule];
    });

    expect(refusalsFor(fifth)).toEqual([refusal("unknown-key", "/engines/0/connection/fieldRules/0", "message")]);
    expect(refusalsFor(noCheck)).toEqual([refusal("missing-key", "/engines/0/connection/fieldRules/0", "check")]);
  });

  test("a field rule check named in another form is one no-variant refusal", () => {
    for (const check of ["Host-check", "", "1check", "x".repeat(65), 7]) {
      const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { check })]));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/fieldRules/0/check")]);
    }
  });

  test("a host hint named in another form is one no-variant refusal", () => {
    const hint = manifest((m) => (connectionOf(m).hostHint = "host hint"));
    const identity = manifest((m) => (connectionOf(m).hostIdentity = "HostIdentity"));

    expect(refusalsFor(hint)).toEqual([refusal("no-variant", "/engines/0/connection/hostHint")]);
    expect(refusalsFor(identity)).toEqual([refusal("no-variant", "/engines/0/connection/hostIdentity")]);
  });

  test("an importer named in another form is refused as pattern-mismatch", () => {
    const changed = manifest((m) => (connectionOf(m).import = { label: "Import", importer: "import-kubeconfig" }));

    expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/engines/0/connection/import/importer")]);
  });

  test("an import without its importer is refused as missing-key, and a label longer than 128 characters as out-of-range", () => {
    const noImporter = manifest((m) => (connectionOf(m).import = { label: "Import" }));
    const longLabel = manifest((m) => (connectionOf(m).import = { label: "x".repeat(129), importer: "importer" }));

    expect(refusalsFor(noImporter)).toEqual([refusal("missing-key", "/engines/0/connection/import", "importer")]);
    expect(refusalsFor(longLabel)).toEqual([refusal("out-of-range", "/engines/0/connection/import/label")]);
  });

  test("a connection string with a scheme, a URL TLS reader, a paste reader and a seed check is admitted", () => {
    const full = manifest((m) => {
      Object.assign(connectionStringOf(m), {
        scheme: "exampledb",
        urlTls: "urlTls",
        paste: paste(["exampledb://", "Server=\u2026 (ADO.NET)", "x".repeat(128)]),
        seedCheck: "seedCheck",
      });
    });
    const catchAll = manifest((m) => {
      Object.assign(connectionStringOf(m), { scheme: "exampledb+srv", paste: { ...paste(), catchAll: true } });
    });

    expect(refusalsFor(manifest())).toEqual([]);
    expect(refusalsFor(full)).toEqual([]);
    expect(refusalsFor(catchAll)).toEqual([]);
  });

  test("a connection string scheme that is not a lower-case URI scheme is refused as pattern-mismatch", () => {
    for (const scheme of ["Postgres", "pg sql", "1db", "", "a".repeat(33), "postgres://"]) {
      const changed = manifest((m) => Object.assign(connectionStringOf(m), { scheme, paste: paste() }));

      expect(refusalsFor(changed)).toEqual([
        refusal("pattern-mismatch", "/engines/0/connection/connectionString/scheme"),
      ]);
    }
    const longest = manifest((m) => Object.assign(connectionStringOf(m), { scheme: "a".repeat(32), paste: paste() }));

    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a URL TLS reader or a seed check named in another form is one no-variant refusal", () => {
    const urlTls = manifest((m) => Object.assign(connectionStringOf(m), { urlTls: "url-tls", paste: paste() }));
    const seedCheck = manifest((m) => (connectionStringOf(m).seedCheck = "Seed"));

    expect(refusalsFor(urlTls)).toEqual([refusal("no-variant", "/engines/0/connection/connectionString/urlTls")]);
    expect(refusalsFor(seedCheck)).toEqual([refusal("no-variant", "/engines/0/connection/connectionString/seedCheck")]);
  });

  test("a paste reader named in another form is refused as pattern-mismatch", () => {
    const changed = manifest((m) => (connectionStringOf(m).paste = { ...paste(), reader: "paste-reader" }));

    expect(refusalsFor(changed)).toEqual([
      refusal("pattern-mismatch", "/engines/0/connection/connectionString/paste/reader"),
    ]);
  });

  test("a paste with no format is refused as too-few, and one naming a format twice as duplicate", () => {
    const none = manifest((m) => (connectionStringOf(m).paste = paste([])));
    const twice = manifest((m) => (connectionStringOf(m).paste = paste(["exampledb://", "exampledb://"])));
    const many = manifest(
      (m) => (connectionStringOf(m).paste = paste(Array.from({ length: 17 }, (_, index) => `f${index}://`))),
    );

    expect(refusalsFor(none)).toEqual([refusal("too-few", "/engines/0/connection/connectionString/paste/formats")]);
    expect(refusalsFor(twice)).toEqual([
      refusal("duplicate", "/engines/0/connection/connectionString/paste/formats/1"),
    ]);
    expect(refusalsFor(many)).toEqual([refusal("too-many", "/engines/0/connection/connectionString/paste/formats")]);
  });

  test("a paste format longer than 128 characters is refused as out-of-range", () => {
    for (const format of ["x".repeat(129), ""]) {
      const changed = manifest((m) => (connectionStringOf(m).paste = paste([format])));

      expect(refusalsFor(changed)).toEqual([
        refusal("out-of-range", "/engines/0/connection/connectionString/paste/formats/0"),
      ]);
    }
  });

  test("a paste without its catch-all flag is refused as missing-key", () => {
    const noFlag = manifest((m) => {
      const reader = paste();
      delete reader.catchAll;
      connectionStringOf(m).paste = reader;
    });
    const fourth = manifest((m) => (connectionStringOf(m).paste = { ...paste(), order: 1 }));

    expect(refusalsFor(noFlag)).toEqual([
      refusal("missing-key", "/engines/0/connection/connectionString/paste", "catchAll"),
    ]);
    expect(refusalsFor(fourth)).toEqual([
      refusal("unknown-key", "/engines/0/connection/connectionString/paste", "order"),
    ]);
  });

  test("several failures are each refused, ordered by pointer", () => {
    const changed = manifest((m) => {
      m.bogus = true;
      m.engines[0].location = "remote";
      m.engines[0].connection.tls = "maybe";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("unknown-key", "", "bogus"),
      refusal("value-not-allowed", "/engines/0/connection/tls"),
      refusal("value-not-allowed", "/engines/0/location"),
    ]);
  });
});

describe("rules the schema cannot state", () => {
  const second = (m: Json) => ({ ...structuredClone(m.engines[0]), id: "otherdb" });

  test("two engines with one id are refused as engine-id-duplicate at the second", () => {
    const changed = manifest((m) => m.engines.push(structuredClone(m.engines[0])));

    expect(refusalsFor(changed)).toEqual([refusal("engine-id-duplicate", "/engines/1/id")]);
  });

  test("an engine with no compatibility entry is refused as compatibility-engine-missing", () => {
    const changed = manifest((m) => m.engines.push(second(m)));

    expect(refusalsFor(changed)).toEqual([refusal("compatibility-engine-missing", "/engines/1/id")]);
  });

  test("a compatibility entry for an undeclared engine is refused as compatibility-engine-undeclared", () => {
    const changed = manifest((m) =>
      m.compatibility.push({ ...structuredClone(m.compatibility[0]), engine: "ghostdb" }),
    );

    expect(refusalsFor(changed)).toEqual([refusal("compatibility-engine-undeclared", "/compatibility/1/engine")]);
  });

  test("a range endpoint missing from the tested versions is refused as compatibility-endpoint-untested", () => {
    const fromUntested = manifest((m) => (m.compatibility[0].versions = { kind: "range", from: "2.0", to: "2.4" }));
    const toUntested = manifest((m) => (m.compatibility[0].versions = { kind: "range", from: "2.4", to: "2.9" }));
    const bothTested = manifest((m) => {
      m.compatibility[0].versions = { kind: "range", from: "2.0", to: "2.4" };
      m.compatibility[0].tested.unshift({ version: "2.0" });
    });

    expect(refusalsFor(fromUntested)).toEqual([
      refusal("compatibility-endpoint-untested", "/compatibility/0/versions/from"),
    ]);
    expect(refusalsFor(toUntested)).toEqual([
      refusal("compatibility-endpoint-untested", "/compatibility/0/versions/to"),
    ]);
    expect(refusalsFor(bothTested)).toEqual([]);
  });

  test("a refused field that is also declared is refused as refused-field-declared", () => {
    const changed = manifest(
      (m) =>
        (m.engines[0].connection.refused = [
          { field: "region", refusal: randomUUID() },
          { field: "user", refusal: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("refused-field-declared", "/engines/0/connection/refused/1")]);
  });

  test("two refused entries naming one field are refused as refused-field-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (m.engines[0].connection.refused = [
          { field: "region", refusal: randomUUID() },
          { field: "apiKeyId", refusal: randomUUID() },
          { field: "region", refusal: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("refused-field-duplicate", "/engines/0/connection/refused/2")]);
  });

  test("a seed-only field neither declared nor a seed-only name is refused as seed-only-field-undeclared", () => {
    const changed = manifest(
      (m) => (m.engines[0].connection.seedOnly = { ...SEED_ONLY, fields: ["database", "agentReadRoots", "region"] }),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("seed-only-field-undeclared", "/engines/0/connection/seedOnly/fields/2"),
    ]);
  });

  test("a host path field that is not a seed-only field of its engine is refused as host-path-field-undeclared", () => {
    const changed = manifest((m) => {
      m.engines[0].connection.seedOnly = { ...SEED_ONLY, fields: ["clientCertificatePath"] };
      m.engines[0].connection.hostPathFields = ["clientCertificatePath", "clientPrivateKeyPath"];
    });
    const withoutSeedOnly = manifest((m) => (m.engines[0].connection.hostPathFields = ["clientPrivateKeyPath"]));

    expect(refusalsFor(changed)).toEqual([
      refusal("host-path-field-undeclared", "/engines/0/connection/hostPathFields/1"),
    ]);
    expect(refusalsFor(withoutSeedOnly)).toEqual([
      refusal("host-path-field-undeclared", "/engines/0/connection/hostPathFields/0"),
    ]);
  });

  test.each([
    ["a label", "labels", { field: "warehouse", text: "Warehouse" }],
    ["a hint", "hints", { field: "warehouse", text: "w" }],
    ["a placeholder", "placeholders", { field: "warehouse", text: "" }],
    ["a placement", "placement", { field: "serviceName", where: "open" }],
    ["an options entry", "options", { field: "saslMechanism", choices: [{ value: "PLAIN", label: "PLAIN" }] }],
  ])("%s for a field the engine does not take is refused as field-undeclared", (_name, list, entry) => {
    const changed = manifest((m) => (connectionOf(m).dialog[list] = [entry]));

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", `/engines/0/connection/dialog/${list}/0/field`)]);
  });

  test("an order item naming a field the engine does not take is refused as field-undeclared", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.order = ["host", "warehouse"]));

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", "/engines/0/connection/dialog/order/1")]);
  });

  test("a condition on, or reading, a field the engine does not take is refused as field-undeclared", () => {
    const shown = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "region", when: { field: "authMethod", equals: "pat" } });
    });
    const read = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[1].when.field = "region";
    });

    expect(refusalsFor(shown)).toEqual([refusal("field-undeclared", "/engines/0/connection/dialog/shownWhen/2/field")]);
    expect(refusalsFor(read)).toEqual([
      refusal("field-undeclared", "/engines/0/connection/dialog/shownWhen/1/when/field"),
    ]);
  });

  test("two entries of one list naming one field are refused as dialog-entry-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).dialog.labels = [
          { field: "password", text: "Token" },
          { field: "user", text: "Login" },
          { field: "password", text: "Secret" },
        ]),
    );
    const across = manifest((m) => {
      connectionOf(m).dialog.labels = [{ field: "password", text: "Token" }];
      connectionOf(m).dialog.hints = [{ field: "password", text: "A token." }];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("dialog-entry-duplicate", "/engines/0/connection/dialog/labels/2/field"),
    ]);
    expect(refusalsFor(across)).toEqual([]);
  });

  test("a placeable field the engine takes with no placement is refused as placement-missing", () => {
    const changed = manifest((m) => connectionOf(m).fields.push("serviceName"));
    const placed = manifest((m) => {
      connectionOf(m).fields.push("serviceName");
      connectionOf(m).dialog.placement = [{ field: "serviceName", where: "advanced" }];
    });

    expect(refusalsFor(changed)).toEqual([refusal("placement-missing", "/engines/0/connection/fields/5")]);
    expect(refusalsFor(placed)).toEqual([]);
  });

  test("a select field the engine takes with no options is refused as options-missing", () => {
    const changed = manifest((m) => connectionOf(m).fields.push("saslMechanism"));

    expect(refusalsFor(changed)).toEqual([refusal("options-missing", "/engines/0/connection/fields/5")]);
  });

  test("two choices of one field with one value are refused as option-value-duplicate at the second", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("saslMechanism");
      connectionOf(m).dialog.options = [
        {
          field: "saslMechanism",
          choices: [
            { value: "PLAIN", label: "PLAIN" },
            { value: "SCRAM-SHA-256", label: "SCRAM" },
            { value: "PLAIN", label: "Plain text" },
          ],
        },
      ];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("option-value-duplicate", "/engines/0/connection/dialog/options/0/choices/2/value"),
    ]);
  });

  test("a condition reading a field that has a condition of its own is refused as shown-when-chained", () => {
    const chained = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "privateKey", equals: "x" } });
    });
    const itself = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "warehouse", equals: "x" } });
    });

    expect(refusalsFor(chained)).toEqual([
      refusal("shown-when-chained", "/engines/0/connection/dialog/shownWhen/2/when/field"),
    ]);
    expect(refusalsFor(itself)).toEqual([
      refusal("shown-when-chained", "/engines/0/connection/dialog/shownWhen/2/when/field"),
    ]);
  });

  test("a condition on a select naming a value none of its choices is refused as shown-when-value-not-an-option", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[1].when.equals = "oauth";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("shown-when-value-not-an-option", "/engines/0/connection/dialog/shownWhen/1/when/equals"),
    ]);
  });

  test("an absent value that is none of its field's choices is refused as absent-value-not-an-option", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues[0].value = "oauth";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-not-an-option", "/engines/0/connection/dialog/absentValues/0/value"),
    ]);
  });

  test("an absent value for a field no condition reads is refused as absent-value-unread", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues.push({ field: "warehouse", value: "compute" });
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-unread", "/engines/0/connection/dialog/absentValues/1/field"),
    ]);
  });

  test("a select field a condition reads with no absent value is refused as absent-value-missing", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues = [];
    });
    const textField = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "user", equals: "admin" } });
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-missing", "/engines/0/connection/dialog/shownWhen/0/when/field"),
      refusal("absent-value-missing", "/engines/0/connection/dialog/shownWhen/1/when/field"),
    ]);
    expect(refusalsFor(textField)).toEqual([]);
  });

  test("URI schemes on an engine without a host field are refused as host-uri-schemes-without-host", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["user", "password", "database"];
      connectionOf(m).hostUriSchemes = ["https"];
    });
    const withHost = manifest((m) => (connectionOf(m).hostUriSchemes = ["https", "http"]));

    expect(refusalsFor(changed)).toEqual([
      refusal("host-uri-schemes-without-host", "/engines/0/connection/hostUriSchemes"),
    ]);
    expect(refusalsFor(withHost)).toEqual([]);
  });

  test("a credential warning on a field the engine does not take is refused as credential-warning-field-undeclared", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["host", "port", "password"];
      connectionOf(m).credentialWarnings = [
        { kind: "no-secret", message: randomUUID() },
        { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
      ];
    });
    const noPassword = manifest((m) => {
      connectionOf(m).fields = ["host", "port", "user"];
      connectionOf(m).credentialWarnings = [
        { kind: "jwt", noExp: true, access: [], message: randomUUID() },
        { kind: "no-secret", message: randomUUID() },
        { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
      ];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/1"),
    ]);
    expect(refusalsFor(noPassword)).toEqual([
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/0"),
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/1"),
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/2"),
    ]);
  });

  test("a second no-secret warning is refused as no-secret-warning-duplicate", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).credentialWarnings = [
          { kind: "no-secret", message: randomUUID() },
          { kind: "jwt", noExp: true, access: ["m"], message: randomUUID() },
          { kind: "no-secret", message: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("no-secret-warning-duplicate", "/engines/0/connection/credentialWarnings/2"),
    ]);
  });

  test("a field rule for a field the engine does not take is refused as field-undeclared", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).fieldRules = [
          fieldRule("host", { required: randomUUID() }),
          fieldRule("warehouse", { format: format("^[a-z]+$") }),
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", "/engines/0/connection/fieldRules/1/field")]);
  });

  test("two field rules naming one field are refused as field-rule-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).fieldRules = [
          fieldRule("host", { required: randomUUID() }),
          fieldRule("user", { required: randomUUID() }),
          fieldRule("host", { format: format("^[a-z]+$") }),
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-rule-duplicate", "/engines/0/connection/fieldRules/2/field")]);
  });

  test("a field rule that states nothing is refused as field-rule-empty", () => {
    const changed = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { required: randomUUID() }), fieldRule("host")]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-rule-empty", "/engines/0/connection/fieldRules/1")]);
  });

  test("a pattern that does not compile is refused as pattern-invalid", () => {
    const source = `^(${randomUUID()}`;
    const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format(source) })]));
    const notUnicode = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^\\p{L$", "u") })]),
    );
    const plain = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^\\p{L$") })]));

    const refusals = refusalsFor(changed);
    expect(refusals).toEqual([refusal("pattern-invalid", "/engines/0/connection/fieldRules/0/format/pattern/source")]);
    expect(refusalsFor(notUnicode)).toEqual([
      refusal("pattern-invalid", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(plain)).toEqual([]);
    const sentence = refusalSentence(refusals[0] as ManifestRefusal);
    expect(sentence).not.toContain(source);
    expect(sentence).not.toContain("Unterminated");
    expect(sentence).not.toContain("Invalid regular expression");
  });

  test("a character range whose minimum exceeds its maximum is refused as char-range-inverted", () => {
    const inverted = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { charRange: { min: 9, max: 3, sentence: "s" } })]),
    );
    const single = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { charRange: { min: 3, max: 3, sentence: "s" } })]),
    );

    expect(refusalsFor(inverted)).toEqual([
      refusal("char-range-inverted", "/engines/0/connection/fieldRules/0/charRange"),
    ]);
    expect(refusalsFor(single)).toEqual([]);
  });

  test("a host reader on an engine without a host field is refused as host-reader-without-host", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["user", "password", "database"];
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
    });
    const withHost = manifest((m) => {
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("host-reader-without-host", "/engines/0/connection/hostHint"),
      refusal("host-reader-without-host", "/engines/0/connection/hostIdentity"),
    ]);
    expect(refusalsFor(withHost)).toEqual([]);
  });

  test("a scheme on an engine whose connection string names no paste reader is refused as scheme-without-paste", () => {
    const changed = manifest((m) => (connectionStringOf(m).scheme = "kafka"));
    const withPaste = manifest((m) => Object.assign(connectionStringOf(m), { scheme: "kafka", paste: paste() }));

    expect(refusalsFor(changed)).toEqual([
      refusal("scheme-without-paste", "/engines/0/connection/connectionString/scheme"),
    ]);
    expect(refusalsFor(withPaste)).toEqual([]);
  });

  test("a URL TLS reader on an engine whose connection string names no paste reader is refused as url-tls-without-paste", () => {
    const changed = manifest((m) => (connectionStringOf(m).urlTls = "urlTls"));
    const withPaste = manifest((m) => Object.assign(connectionStringOf(m), { urlTls: "urlTls", paste: paste() }));

    expect(refusalsFor(changed)).toEqual([
      refusal("url-tls-without-paste", "/engines/0/connection/connectionString/urlTls"),
    ]);
    expect(refusalsFor(withPaste)).toEqual([]);
  });

  test("a sign-in shaped like Snowflake's is admitted", () => {
    expect(refusalsFor(manifest(signInShaped))).toEqual([]);
  });

  test("the rules run only on a manifest the schema admits", () => {
    const changed = manifest((m) => {
      m.engines.push(structuredClone(m.engines[0]));
      m.engines[1].location = "remote";
    });

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/1/location")]);
  });
});

describe("the calls segment", () => {
  test("a manifest without its calls is refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls))).toEqual([refusal("missing-key", "", "calls")]);
    expect(refusalsFor(manifest((m) => delete m.calls.console.cancel))).toEqual([
      refusal("missing-key", "/calls/console", "cancel"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.console.execute.honours))).toEqual([
      refusal("missing-key", "/calls/console/execute", "honours"),
    ]);
  });

  test("a request field execute does not know, or one listed twice, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "params"])))).toEqual([
      refusal("duplicate", "/calls/console/execute/honours/1"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["rows"])))).toEqual([
      refusal("value-not-allowed", "/calls/console/execute/honours/0"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "offset"])))).toEqual([]);
  });

  test("a console facet offer outside the vocabulary, or a key the calls segment does not define, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.cancel = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/console/cancel"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.objects = {})))).toEqual([refusal("unknown-key", "/calls", "objects")]);
    expect(refusalsFor(manifest((m) => (m.calls.console.explain = "offered")))).toEqual([
      refusal("unknown-key", "/calls/console", "explain"),
    ]);
  });
});

describe("proxy variables", () => {
  const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  const purpose = `purpose-${randomUUID()}`;
  const declared = (name: string) => ({ name, purpose });

  test("a proxy variable declared in runtime.env is refused as env-proxy-variable", () => {
    for (const name of PROXY_VARIABLES) {
      const changed = manifest((m) => (m.runtime.env = [declared("EXAMPLEDB_HOME"), declared(name)]));

      const refusals = refusalsFor(changed);

      expect(refusals).toEqual([refusal("env-proxy-variable", "/runtime/env/1/name")]);
      expect(JSON.stringify(refusals)).not.toContain(purpose);
      expect(refusalSentence(refusals[0] as ManifestRefusal)).not.toContain(name);
    }
    expect(refusalsFor(manifest((m) => (m.runtime.env = [declared("EXAMPLEDB_PROXY_HOME")])))).toEqual([]);
  });

  test("a lower-case proxy variable is refused by the name pattern", () => {
    for (const name of PROXY_VARIABLES.map((item) => item.toLowerCase())) {
      const changed = manifest((m) => (m.runtime.env = [declared(name)]));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/runtime/env/0/name")]);
    }
  });
});

describe("the contract a manifest was built against", () => {
  test("a manifest built against another contract is refused as PROVIDER_CONTRACT_UNSUPPORTED without schema refusals", () => {
    const changed = manifest((m) => {
      m.contract = "0.2";
      m.engines = "not a list";
      m.bogus = true;
    });

    expect(validator.validate(changed)).toEqual({
      admitted: false,
      refusals: [{ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: "0.2" }],
    });
  });

  test("the envelope is read first: a missing contract is the only refusal", () => {
    const changed = manifest((m) => {
      delete m.contract;
      m.bogus = true;
    });

    expect(refusalsFor(changed)).toEqual([refusal("missing-key", "", "contract")]);
  });
});

describe("one engine declaration", () => {
  const engine = () => manifest().engines[0] as Json;

  test("an engine declaration is admitted on its own", () => {
    const declaration = engine();

    expect<unknown>(validator.validateEngine(declaration)).toEqual({ admitted: true, engine: declaration });
  });

  test("an engine declaration's refusals point into the declaration", () => {
    const declaration = { ...engine(), bogus: 1 };

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("unknown-key", "", "bogus")],
    });
  });

  test("an engine declaration is held to the rules of its own connection", () => {
    const declaration = engine();
    declaration.connection.refused = [{ field: "password", refusal: randomUUID() }];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("refused-field-declared", "/connection/refused/0")],
    });
  });
  test("an engine declaration's field rules and host readers are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.connection.fields = ["user", "password", "database"];
    declaration.connection.fieldRules = [
      fieldRule("user", { format: format("^(a"), charRange: { min: 2, max: 1, sentence: "s" } }),
      fieldRule("user", { required: "r" }),
      fieldRule("warehouse"),
    ];
    declaration.connection.hostIdentity = "hostIdentity";

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("char-range-inverted", "/connection/fieldRules/0/charRange"),
        refusal("pattern-invalid", "/connection/fieldRules/0/format/pattern/source"),
        refusal("field-rule-duplicate", "/connection/fieldRules/1/field"),
        refusal("field-rule-empty", "/connection/fieldRules/2"),
        refusal("field-undeclared", "/connection/fieldRules/2/field"),
        refusal("host-reader-without-host", "/connection/hostIdentity"),
      ],
    });
  });

  test("an engine declaration's connection string is held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    Object.assign(declaration.connection.connectionString, { scheme: "exampledb", urlTls: "urlTls" });

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("scheme-without-paste", "/connection/connectionString/scheme"),
        refusal("url-tls-without-paste", "/connection/connectionString/urlTls"),
      ],
    });
  });

  test("an engine declaration's dialog is held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.connection.fields.push("serviceName");
    declaration.connection.dialog.hints = [{ field: "warehouse", text: "w" }];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("field-undeclared", "/connection/dialog/hints/0/field"),
        refusal("placement-missing", "/connection/fields/5"),
      ],
    });
  });
});

describe("refusals carry no value", () => {
  /** Every string value replaced by `planted`, keys kept, so every pattern and vocabulary check fails on it. */
  function plant(value: unknown, planted: string): unknown {
    if (typeof value === "string") return planted;
    if (Array.isArray(value)) return value.map((item) => plant(item, planted));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plant(item, planted)]));
    }
    return value;
  }

  test("no refusal carries a value of the manifest", () => {
    const planted = `planted-${randomUUID()}`;
    const changed = plant(
      manifest((m) => {
        signInShaped(m);
        connectionOf(m).dialog.labels = [{ field: "user", text: "Login" }];
        connectionOf(m).dialog.hints = [{ field: "user", text: "The login name." }];
        connectionOf(m).dialog.placeholders = [{ field: "user", text: "admin" }];
        connectionOf(m).credentialWarnings = [{ kind: "no-secret", message: "Set a password." }];
        connectionOf(m).fieldRules = [
          fieldRule("host", {
            required: "Host is required.",
            format: { pattern: { source: "^[a-z]+$", flags: "u" }, sentence: "Host must be letters." },
            charRange: { min: 1, max: 9, sentence: "Host is too long." },
            check: "hostCheck",
          }),
        ];
        connectionOf(m).hostHint = "hostHint";
        connectionOf(m).hostIdentity = "hostIdentity";
        connectionOf(m).import = { label: "Import kubeconfig", importer: "importer" };
        connectionOf(m).refused = [{ field: "region", refusal: "Region is refused." }];
        Object.assign(connectionStringOf(m), {
          scheme: "exampledb",
          urlTls: "urlTls",
          paste: { reader: "pasteReader", catchAll: true, formats: ["exampledb://"] },
          seedCheck: "seedCheck",
        });
      }),
      planted,
    ) as Json;
    changed.contract = "0.1";
    changed.engines[0].connection.defaults.port = planted;
    changed.engines[0].connection.seedOnly = plant(SEED_ONLY, planted);
    changed.runtime.env = [{ name: "HTTPS_PROXY", purpose: planted }];

    const refusals = refusalsFor(changed);
    const engineVerdict = validator.validateEngine(changed.engines[0]);

    expect(refusals.length).toBeGreaterThan(10);
    expect(engineVerdict.admitted).toBe(false);
    expect(JSON.stringify(refusals)).not.toContain(planted);
    expect(JSON.stringify(engineVerdict)).not.toContain(planted);
    for (const item of refusals) expect(refusalSentence(item)).not.toContain(planted);
  });
});

describe("refusalSentence", () => {
  test("words each rule in one sentence naming the pointer, and the key where there is one", () => {
    for (const rule of SCHEMA_REFUSAL_RULES) {
      const sentence = refusalSentence(refusal(rule, "/engines/0/connection", "refused"));

      expect(sentence).toMatch(/^[A-Z][^]*\.$/);
      expect(sentence).not.toMatch(/\. [A-Z]/);
      expect(sentence).toContain("/engines/0/connection");
      if (rule === "unknown-key" || rule === "missing-key") expect(sentence).toContain('"refused"');
    }
  });

  test("names the top level for an empty pointer", () => {
    expect(refusalSentence(refusal("unknown-key", "", "bogus"))).toBe(
      'The manifest has the key "bogus" at the top level, which the provider contract does not define there.',
    );
  });

  test("quotes an unknown key as a JSON string, so a key with a line break stays on one line", () => {
    expect(refusalSentence(refusal("unknown-key", "", "a\nb"))).toBe(
      'The manifest has the key "a\\nb" at the top level, which the provider contract does not define there.',
    );
    expect(refusalSentence(refusal("missing-key", "/engines/0", 'say "hi"'))).toBe(
      'The manifest lacks the key "say \\"hi\\"" at /engines/0, which the provider contract requires there.',
    );
  });

  test("names the contract a manifest declares that the host does not serve", () => {
    expect(refusalSentence({ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: "0.2" })).toBe(
      "The manifest was built against provider contract 0.2, which this SDK does not serve.",
    );
  });
});

describe("errorsOf", () => {
  test("raises when a validation failed without reporting why, rather than answer no refusal", () => {
    const silent = Object.assign(() => false, { errors: null }) as unknown as Parameters<typeof errorsOf>[0];

    expect(() => errorsOf(silent)).toThrow("The manifest validator failed a value without reporting why.");
  });
});

describe("how ajv's errors become refusals", () => {
  const error = (keyword: string, instancePath: string, params: Record<string, unknown> = {}) => ({
    keyword,
    instancePath,
    schemaPath: `#/${keyword}`,
    params,
  });

  test("a keyword no rule maps is thrown by name rather than dropped", () => {
    expect(() => refusalsOf([error("multipleOf", "/x")])).toThrow('"multipleOf"');
  });

  test("nested failed variants at one pointer give one no-variant refusal and drop every error under it", () => {
    const refusals = refusalsOf([
      error("required", "/a", { missingProperty: "b" }),
      error("pattern", "/a/c"),
      error("oneOf", "/a"),
      error("oneOf", "/a"),
      error("oneOf", "/a/d"),
      error("type", "/ab"),
    ]);

    expect(refusals).toEqual([refusal("no-variant", "/a"), refusal("wrong-type", "/ab")]);
  });

  test("a repeated item is refused at the later of the two indices ajv names, in either order", () => {
    expect(refusalsOf([error("uniqueItems", "/a", { i: 0, j: 2 })])).toEqual([refusal("duplicate", "/a/2")]);
    expect(refusalsOf([error("uniqueItems", "/b", { i: 3, j: 1 })])).toEqual([refusal("duplicate", "/b/3")]);
  });
});
