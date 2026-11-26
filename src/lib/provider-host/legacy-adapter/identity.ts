/**
 * The legacy adapter's identity: the source every engine Studio still serves through its own legacy providers is
 * served under, beside the provider packages boot admits (docs/providers/CONTRACT.md, clause C-100).
 *
 * The name is the npm package this Studio is published as, `@libredb/studio`, and the version is the root
 * package.json's `version`, read by a plain JSON import, so the standalone app, the published library and the VS Code
 * backend child all name the same version with no build-time define (`getAppVersion()` in src/lib/app-version.ts
 * answers null in the library, which declares none). Only `version` is imported: a bundler that tree-shakes a JSON
 * module's named exports carries no other key of the file.
 *
 * The ids are the committed declarations' (`SHIPPED_DATABASE_TYPES` of src/lib/db/compatibility.ts, the engine
 * catalog's keys). Admission imports this module alone of the adapter: it reads the ids and the name to refuse a
 * package that would share either, and no record (./records), so it reaches no table of Studio's keyed by engine id.
 */
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { version } from "../../../../package.json";

/** The name every legacy engine is served under: the npm package this Studio is published as. */
export const LEGACY_SOURCE_NAME = "@libredb/studio";

/** The version every legacy engine is served at: the root package.json's. */
export const LEGACY_SOURCE_VERSION: string = version;

/** The ids of the engines the legacy adapter serves, the committed declarations', in the engine catalog's order. */
export const LEGACY_ENGINE_IDS: readonly string[] = SHIPPED_DATABASE_TYPES;
