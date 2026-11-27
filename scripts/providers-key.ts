#!/usr/bin/env bun
/**
 * Prints the keys a grant register row names a provider package and its engines by (docs/providers/CONTRACT.md,
 * clauses M-84 and C-93): the package's name, version and digest, and each engine's `grammarSha256` and
 * `languageSha256`. It is a repository command for whoever writes a register row, so nobody hashes a package, a grammar
 * or statement language data by hand; it is not shipped to operators (the published package holds `dist` and `bin`
 * only, and no image runs it).
 *
 * It reads one package's built directory, as the lock reads a package under the providers directory: its package.json
 * and its manifest, libredb-provider.json, at its root. In this order, each refusal one sentence on stderr, exit 1,
 * nothing on stdout:
 * - the directory as typed must exist and be a directory (its real path, `fs.realpathSync.native`, is read from here
 *   on; a sentence names the directory as typed);
 * - its identity is read with the lock's own function, and refused in the lock's own words, after the directory and
 *   the code;
 * - package.json's `name` and `version` must be strings in the lock's forms, the register schema's too;
 * - the artifact is walked, checked and its imports recorded by the lock command's own sequence over one directory
 *   (`artifactEntry` in scripts/providers-lock.ts), and refused with its sentence, so the command refuses exactly what
 *   the lock refuses and the digest it prints is the one the lock writes;
 * - the manifest is read again and validated by the SDK's validator compiled from the SDK's schema text, as boot
 *   compiles it for admission, and refused with admission's sentence for the validator's first refusal.
 * Admission's check of the names an engine binds through Studio's function tables is not run: those tables import the
 * engine catalog, which this command does not. A manifest this command keys can still be refused at admission for a
 * name Studio holds no table row for. Admission also names another contract before it validates the envelope, so a
 * manifest of another contract whose envelope the validator refuses is named here by its schema refusal instead.
 * The directory must not change while the command runs: it is read once for the walk and again for the manifest.
 *
 * Otherwise it prints, exit 0, one JSON document in the register row's own member names, so a row author pastes it
 * with no transcription: `package` (name, version, digest) into each row of the package unchanged, and each item of
 * `engines`, by its `engine`, into that engine's row, its `grammarSha256` and `languageSha256` into the row's grants.
 * The engines are in code-unit order of their ids. An engine's `grammarSha256` is the digest of its
 * `sqlText.grammar` (src/lib/db/grammar-digest.ts), null where its `sqlText` is null; its `languageSha256` the digest
 * of its `statementLanguageData` (src/lib/db/language-digest.ts), null where that is null: the functions the server
 * catalog's composer calls, over the manifest as validated.
 *
 * The directory must be absolute, as the lock command's: `bun run` runs the script from the repository root. Any other
 * argument prints the usage; exit 2.
 *
 * Run: bun run providers:key -- --dir <absolute artifact directory>
 */
import * as fs from "node:fs";
import path from "node:path";
import { PROVIDER_CONTRACT } from "@libredb/provider-sdk/calls";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";
import { MANIFEST_SCHEMA_TEXT } from "@libredb/provider-sdk/manifest-schema";
import { grammarSha256 } from "../src/lib/db/grammar-digest";
import { languageDataSha256 } from "../src/lib/db/language-digest";
import {
  decodeJson,
  MANIFEST_BYTE_CAP,
  MANIFEST_FILE_NAME,
  readArtifactIdentity,
  readBoundedFile,
} from "../src/lib/provider-host/provider-artifact";
import {
  artifactFaultReason,
  contractRefusal,
  type PackageName,
  schemaRefusal,
} from "../src/lib/provider-host/provider-refusals";
import {
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
  type StringForm,
} from "../src/lib/provider-host/providers-lock-format";
import { artifactEntry, directoryArgument } from "./providers-lock";

const USAGE = "Usage: bun run providers:key -- --dir <absolute artifact directory>";
const PREFIX = "providers:key";

/** The keys of one engine, in the register row's member names. */
interface EngineKeys {
  readonly engine: string;
  readonly grammarSha256: string | null;
  readonly languageSha256: string | null;
}

/** What the command prints. */
interface PackageKeys {
  readonly package: { readonly name: string; readonly version: string; readonly digest: string };
  readonly engines: readonly EngineKeys[];
}

/** Whether `value` is a string of `form`. */
function inForm(value: unknown, form: StringForm): value is string {
  return typeof value === "string" && value.length <= form.maxLength && form.pattern.test(value);
}

/** The manifest's validator, compiled from the SDK's schema text as boot compiles it. */
function manifestValidator() {
  return compileManifestValidator(new TextEncoder().encode(MANIFEST_SCHEMA_TEXT));
}

/** The keys of the artifact at `directory`, as typed, or the sentence of its refusal. */
function packageKeys(directory: string): PackageKeys | string {
  let root: string;
  try {
    root = fs.realpathSync.native(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `${PREFIX}: ${directory}: the artifact directory does not exist`;
  }
  if (!fs.statSync(root).isDirectory()) return `${PREFIX}: ${directory}: the artifact directory is not a directory`;
  const read = readArtifactIdentity(root);
  if (!read.ok) return `${PREFIX}: ${directory}: ${read.fault.code}: ${artifactFaultReason(read.fault)}`;
  const { name, version } = read.identity;
  if (!inForm(name, PACKAGE_NAME_FORM) || !inForm(version, PACKAGE_VERSION_FORM)) {
    return `${PREFIX}: ${directory}: its package.json names no package name and version in the lock's forms`;
  }
  const pkg: PackageName = { name, version };
  const entry = artifactEntry(root, pkg, PREFIX);
  if (typeof entry === "string") return entry;

  // The identity read above read the manifest as a JSON object within its cap, so a failure here is a changed file.
  const manifestRead = readBoundedFile(path.join(root, MANIFEST_FILE_NAME), MANIFEST_BYTE_CAP);
  const value = manifestRead.ok ? decodeJson(manifestRead.bytes)?.value : undefined;
  if (value === undefined) return `${PREFIX}: ${directory}: its ${MANIFEST_FILE_NAME} changed while the command ran`;
  const verdict = manifestValidator().validate(value);
  if (!verdict.admitted) {
    const [first] = verdict.refusals;
    if (first === undefined) throw new Error(`${PREFIX}: the manifest validator refused a manifest without a refusal`);
    if (first.code === "PROVIDER_CONTRACT_UNSUPPORTED") return contractRefusal(pkg, PROVIDER_CONTRACT).sentence;
    return schemaRefusal(pkg, first.rule, first.pointer, verdict.refusals.length - 1).sentence;
  }
  const engines = verdict.manifest.engines
    .map(
      (engine): EngineKeys => ({
        engine: engine.id,
        grammarSha256: engine.sqlText === null ? null : grammarSha256(engine.sqlText.grammar),
        languageSha256: engine.statementLanguageData === null ? null : languageDataSha256(engine.statementLanguageData),
      }),
    )
    .sort((a, b) => (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0));
  return { package: { name, version, digest: entry.digest }, engines };
}

function main(argv: readonly string[]): number {
  const directory = directoryArgument(argv);
  if (directory === null) {
    console.error(USAGE);
    return 2;
  }
  const keys = packageKeys(directory);
  if (typeof keys === "string") {
    console.error(keys);
    return 1;
  }
  console.log(JSON.stringify(keys, null, 2));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
