/**
 * Boot admission (docs/providers/CONTRACT.md, clause C-105): the standalone server's `register()`
 * (src/instrumentation.ts) calls `admitProvidersAtBoot()` once, after it installs the host core and before governance,
 * the banner and the samples, so the server's engine catalog is installed before any request is served.
 *
 * `admitProvidersAtBoot()`:
 * 1. reads nothing when a server catalog is installed already, from another `register()` call or another bundle of the
 *    process, and answers true;
 * 2. with no providers directory set (`providersDirectory`, ./providers-dir), reads no lock, compiles no validator,
 *    installs the bundled catalog and answers true;
 * 3. otherwise runs `bootAdmission` under `PROVIDER_IMPORT_DEADLINE_MS`; a lock refused as a whole, a set directory that
 *    does not exist among them, prints the boot banner the other boot checks print, naming the lock and the rule, exits
 *    with 1 and answers false, installing no catalog;
 * 4. installs the catalog `composeServerCatalog` composes from the packages admitted and refused, and answers true.
 *
 * `bootAdmission(directory, deadlineMs)` reads the lock (`readProvidersLock`), logs each package the lock refused, and,
 * when at least one package passed it, records the directory of each such package for the uncaught-exception line
 * (./package-directories, clause C-108), compiles the manifest validator once from the SDK's schema text, whose digest
 * the validator checks, then admits each verified package in the lock's order, one at a time, each import under
 * `deadlineMs` (`admitPackage`, ./admission). The catalog's set rules (`catalogConflicts`) then run over every admitted
 * package, each package they refuse is logged with `PROVIDER_CATALOG_CONFLICT`, and only the packages they keep are
 * registered (`registerAdmission`), so the loader's registry and the server's catalog name the same packages.
 *
 * Every refused package is logged once, by its refusal's one-line sentence: at warn, or at error with the value the
 * entry threw as the logged error for `import-threw`, so the thrown value is never in the sentence. An admitted package
 * is logged at info with its name, version and engine ids. An import that settles after its deadline is logged at warn
 * by its package and stays refused. A synchronous hang at import blocks the boot (C-37).
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ManifestValidator } from "@libredb/provider-sdk/manifest";
import { MANIFEST_SCHEMA_TEXT } from "@libredb/provider-sdk/manifest-schema";
import { installServerCatalog, serverCatalogInstalled } from "@/lib/db/server-catalog";
import {
  type AdmittedForCatalog,
  catalogConflicts,
  composeServerCatalog,
  type RefusedForCatalog,
} from "@/lib/db/server-catalog-compose";
import { logger } from "@/lib/logger";
import * as admission from "./admission";
import { recordPackageDirectories } from "./package-directories";
import { catalogConflictRefusal, type LockRefusal, type PackageRefusal } from "./provider-refusals";
import { providersDirectory } from "./providers-dir";
import * as providersLock from "./providers-lock";

/** How long the import of one package's entry may take, in milliseconds. */
export const PROVIDER_IMPORT_DEADLINE_MS = 10_000;

/** The route every boot admission log line names. */
const ROUTE = "provider-boot";

/** What boot admission read: the lock's refusal, or the packages admitted and kept, and the packages refused. */
export type BootAdmission =
  | { readonly read: false; readonly refusal: LockRefusal }
  | {
      readonly read: true;
      readonly admitted: readonly AdmittedForCatalog[];
      readonly refused: readonly RefusedForCatalog[];
    };

/** The settle the loader reports for an import that settled after its deadline. */
type LateSettle = Parameters<admission.AdmissionOptions["onLateSettle"]>[0];

/** Logs a refused package once, by its sentence; the value its entry threw, when there is one, as the logged error. */
function logRefusal(refusal: PackageRefusal, cause?: unknown): void {
  if (cause === undefined) logger.warn(refusal.sentence, { route: ROUTE });
  else logger.error(refusal.sentence, cause, { route: ROUTE });
}

/** Logs an import of `pkg` that settled after its deadline: the package stays refused and is never registered. */
function logLateSettle(pkg: providersLock.VerifiedPackage, settle: LateSettle): void {
  const context = { route: ROUTE, package: `${pkg.name} ${pkg.version}`, outcome: settle.outcome };
  const line = "A provider package's entry settled after its import deadline; the package stays refused";
  if (settle.outcome === "rejected") logger.error(line, settle.cause, context);
  else logger.warn(line, context);
}

/** The package a refusal names, as the composer reads it, with the engine ids its lock entry names. */
function refusedOf(refusal: PackageRefusal, engines: readonly string[]): RefusedForCatalog {
  return Object.freeze({ name: refusal.name, version: refusal.version, engines, code: refusal.code });
}

/**
 * Reads the lock of the providers directory `directory`, admits each package it verified with each import under
 * `deadlineMs`, runs the catalog's set rules and registers the packages they keep; see the module's docblock.
 */
export async function bootAdmission(directory: string, deadlineMs: number): Promise<BootAdmission> {
  const lock = providersLock.readProvidersLock(directory);
  if (!lock.read) return Object.freeze({ read: false, refusal: lock.refusal });
  const refused: RefusedForCatalog[] = [];
  const verified: providersLock.VerifiedPackage[] = [];
  for (const pkg of lock.packages) {
    if (pkg.verified) {
      verified.push(pkg);
      continue;
    }
    logRefusal(pkg.refusal);
    refused.push(refusedOf(pkg.refusal, pkg.engines));
  }
  const admittedPackages: {
    readonly pkg: providersLock.VerifiedPackage;
    readonly answer: admission.AdmittedPackage;
  }[] = [];
  if (verified.length > 0) {
    // Before any import: a package refused after its import has run its top level, which may have left a timer.
    recordPackageDirectories(
      verified.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        prefixes: [`${pkg.directory}${path.sep}`, `${pathToFileURL(pkg.directory).href}/`],
      })),
    );
    const validator: ManifestValidator = admission.hostManifestValidator(
      new TextEncoder().encode(MANIFEST_SCHEMA_TEXT),
    );
    for (const pkg of verified) {
      // One at a time, in the lock's order: each deadline is its own package's, and the log follows the lock.
      // oxlint-disable-next-line no-await-in-loop -- each import runs after the one before, on purpose (C-105).
      const answer = await admission.admitPackage(pkg, {
        validator,
        deadlineMs,
        onLateSettle: (settle) => logLateSettle(pkg, settle),
      });
      if (answer.admitted) {
        admittedPackages.push({ pkg, answer });
        continue;
      }
      logRefusal(answer.refusal, answer.cause);
      refused.push(refusedOf(answer.refusal, pkg.engines));
    }
  }
  const forCatalog = (pkg: providersLock.VerifiedPackage, answer: admission.AdmittedPackage): AdmittedForCatalog =>
    Object.freeze({
      name: answer.name,
      version: answer.version,
      directory: pkg.directory,
      manifest: answer.manifest,
      record: answer.record,
    });
  const conflicts = catalogConflicts(admittedPackages.map(({ pkg, answer }) => forCatalog(pkg, answer)));
  const kept: AdmittedForCatalog[] = [];
  for (const { pkg, answer } of admittedPackages) {
    // The first rule a package breaks names its refusal; conflicts are sorted by name, then by rule.
    const conflict = conflicts.find(({ name }) => name === answer.name);
    const refusal =
      conflict === undefined ? admission.registerAdmission(answer) : catalogConflictRefusal(answer, conflict.rule);
    if (refusal !== undefined) {
      logRefusal(refusal);
      refused.push(refusedOf(refusal, pkg.engines));
      continue;
    }
    logger.info("A provider package was admitted", {
      route: ROUTE,
      package: `${answer.name} ${answer.version}`,
      engines: answer.engines.join(","),
    });
    kept.push(forCatalog(pkg, answer));
  }
  return Object.freeze({ read: true, admitted: Object.freeze(kept), refused: Object.freeze(refused) });
}

/** Prints the boot banner of a lock refused as a whole, and stops the boot with exit 1. */
function refuseBoot(refusal: LockRefusal): false {
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: its providers lock is invalid",
      ` ${refusal.sentence}`,
      " Write the lock with bun run providers:lock -- --dir <absolute directory>, or unset LIBREDB_PROVIDERS_DIR.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/**
 * Admits the providers directory's packages once per process and installs the server's engine catalog; answers false
 * after exiting with 1 when the lock is refused as a whole. See the module's docblock.
 */
export async function admitProvidersAtBoot(): Promise<boolean> {
  if (serverCatalogInstalled()) return true;
  const directory = providersDirectory();
  if (directory === null) {
    installServerCatalog(composeServerCatalog([], []));
    return true;
  }
  const answer = await bootAdmission(directory, PROVIDER_IMPORT_DEADLINE_MS);
  if (!answer.read) return refuseBoot(answer.refusal);
  installServerCatalog(composeServerCatalog(answer.admitted, answer.refused));
  return true;
}
