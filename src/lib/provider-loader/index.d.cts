// The declaration of the provider loader, written by hand beside index.cjs, which has no build step
// (docs/providers/CONTRACT.md, clauses C-87 to C-89; docs/TOOLCHAIN.md, "The provider loader").

/** Why the loader refused a package: a closed set. */
export type LoadRefusalReason =
  | "import-threw"
  | "deadline-passed"
  | "default-missing"
  | "interop-wrapper"
  | "not-a-record";

/** A package whose entry's default is a plain record, answered as the package exported it. */
export interface PackageLoaded {
  readonly loaded: true;
  readonly entry: string;
  readonly record: object;
}

/** A package the loader refused; `cause` is the thrown value on `import-threw` only, for the host's log. */
export interface PackageLoadRefused {
  readonly loaded: false;
  readonly code: "PROVIDER_LOAD_FAILED";
  readonly reason: LoadRefusalReason;
  readonly entry: string;
  readonly cause?: unknown;
}

export type PackageLoadAnswer = PackageLoaded | PackageLoadRefused;

/** An import that settled after its refusal: its outcome, never a success's value. */
export type LateSettle =
  | { readonly entry: string; readonly outcome: "fulfilled" }
  | { readonly entry: string; readonly outcome: "rejected"; readonly cause: unknown };

export interface LoadOptions {
  /** How long the import may take, a whole number of milliseconds from 1 to 2147483647. */
  readonly deadlineMs: number;
  /** Called once for an import that settles after its deadline; a port that throws is a host defect. */
  readonly onLateSettle: (settle: LateSettle) => void;
}

/**
 * Imports the entry at the absolute path `entry` under `options.deadlineMs` and reads only its default.
 * A host defect in the arguments rejects with a TypeError and imports nothing.
 */
export function loadPackage(entry: string, options: LoadOptions): Promise<PackageLoadAnswer>;
