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
    const changed = manifest((m) => (m.engines[0].connection.refused = ["region", "user"]));

    expect(refusalsFor(changed)).toEqual([refusal("refused-field-declared", "/engines/0/connection/refused/1")]);
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

  test("the rules run only on a manifest the schema admits", () => {
    const changed = manifest((m) => {
      m.engines.push(structuredClone(m.engines[0]));
      m.engines[1].location = "remote";
    });

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/1/location")]);
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
    declaration.connection.refused = ["password"];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("refused-field-declared", "/connection/refused/0")],
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
    const changed = plant(manifest(), planted) as Json;
    changed.contract = "0.1";
    changed.engines[0].connection.defaults.port = planted;
    changed.engines[0].connection.seedOnly = plant(SEED_ONLY, planted);

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
});
