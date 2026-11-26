/**
 * Admitted provider packages for the tests of the server's engine catalog (src/lib/db/server-catalog.ts and
 * src/lib/db/server-catalog-compose.ts), built in memory: a manifest is the SDK's minimal valid manifest, read by path
 * and never copied, with its engine id replaced and any member a case changes, admitted by the SDK's validator and
 * deep-frozen as admission freezes it. No file is written and no package is imported.
 *
 * Engine ids here are fixture ids of the form `acme<case>`, never one the bundled catalog serves.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderImpl } from "@libredb/provider-sdk/calls";
import type { ProviderManifest } from "@libredb/provider-sdk/manifest";
import { hostManifestValidator } from "@/lib/provider-host/admission";
import type { ServerCatalog } from "@/lib/db/server-catalog";
import type { AdmittedForCatalog } from "@/lib/db/server-catalog-compose";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..");
const SCHEMA_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const MINIMAL_MANIFEST_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/tests/fixtures/minimal-manifest.json");

/** The host's validator, compiled once for the file. */
export const VALIDATOR = hostManifestValidator(readFileSync(SCHEMA_FILE));

/** A manifest's engine declaration as a case edits it, every member loosely typed. */
export type EditableEngine = Record<string, Record<string, unknown>> & { id: string };

/** The SDK's minimal manifest as JSON, with one engine of id `id`, before validation. */
export function rawManifest(id: string): { engines: EditableEngine[] } & Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(MINIMAL_MANIFEST_FILE, "utf8")) as {
    engines: EditableEngine[];
    compatibility: Record<string, unknown>[];
  } & Record<string, unknown>;
  (manifest.engines[0] as EditableEngine).id = id;
  (manifest.compatibility[0] as Record<string, unknown>).engine = id;
  return manifest;
}

/** `value` frozen with every object and array it holds. */
function deepFrozen<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next !== "object" || next === null || Object.isFrozen(next)) continue;
    Object.freeze(next);
    pending.push(...Object.values(next));
  }
  return value;
}

/**
 * The minimal manifest for engine `id`, changed by `edit`, admitted by the SDK's validator and deep-frozen.
 *
 * @throws {Error} Naming the first refusal, for a manifest the validator refuses.
 */
export function admittedManifest(
  id: string,
  edit: (engine: EditableEngine) => void = () => undefined,
): ProviderManifest {
  const raw = rawManifest(id);
  edit(raw.engines[0] as EditableEngine);
  const verdict = VALIDATOR.validate(raw);
  if (!verdict.admitted) {
    throw new Error(`the fixture manifest of ${id} is refused: ${JSON.stringify(verdict.refusals.slice(0, 3))}`);
  }
  return deepFrozen(verdict.manifest);
}

/** An admitted package named `name` serving `manifest`'s engines, as boot hands it to the composer. */
export function admittedFor(name: string, manifest: ProviderManifest): AdmittedForCatalog {
  return Object.freeze({
    name,
    version: "1.0.0",
    directory: path.join(REPOSITORY_ROOT, "never-read", name),
    manifest,
    record: Object.freeze({ contract: "0.1", manifest, impl: Object.freeze({}) as ProviderImpl<unknown> }),
  });
}

/**
 * Field rules on four fields of the minimal manifest's: a required host of a pattern, a user of 3 to 16 characters, a
 * password read by a named check, and a required database shown only while the user is `reader`, which an absent user
 * reads as.
 */
export function withFieldRules(engine: EditableEngine): void {
  engine.connection.fieldRules = [
    {
      field: "host",
      required: "Enter the host. Nothing was sent.",
      format: {
        pattern: { source: "^[a-z0-9.-]+$", flags: "" },
        sentence: "Host is letters, digits, dots and hyphens.",
      },
      charRange: null,
      check: null,
    },
    {
      field: "user",
      required: null,
      format: null,
      charRange: { min: 3, max: 16, sentence: "User is 3 to 16 characters." },
      check: null,
    },
    { field: "password", required: null, format: null, charRange: null, check: "acmepasswordcheck" },
    {
      field: "database",
      required: "Enter the database. Nothing was sent.",
      format: null,
      charRange: null,
      check: null,
    },
  ];
  (engine.connection.dialog as Record<string, unknown>).shownWhen = [
    { field: "database", when: { field: "user", equals: "reader" } },
  ];
  (engine.connection.dialog as Record<string, unknown>).absentValues = [{ field: "user", value: "reader" }];
}

/**
 * `catalog` with the record of each engine `legacyProvider` names replaced by a frozen copy whose offer of the legacy
 * provider surface is the value given: a crafted catalog, which no composition answers, for the tests that hold every
 * check to read the record's offer and never the id's membership.
 *
 * @throws {Error} Naming the engine, for an engine `catalog` holds no record of.
 */
export function withLegacyProviderOffers(
  catalog: ServerCatalog,
  legacyProvider: Readonly<Record<string, boolean>>,
): ServerCatalog {
  const engines = new Map(catalog.engines);
  for (const [id, offered] of Object.entries(legacyProvider)) {
    const engine = engines.get(id);
    if (engine === undefined) throw new Error(`the catalog holds no record of ${id}`);
    engines.set(id, Object.freeze({ ...engine, offers: Object.freeze({ ...engine.offers, legacyProvider: offered }) }));
  }
  return Object.freeze({ engines, unavailable: catalog.unavailable });
}
