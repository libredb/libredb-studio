/**
 * A package's declared environment (docs/providers/CONTRACT.md, clause M-22).
 *
 * A package reads an environment variable only through `ctx.env.get`, and only one its manifest declares in
 * `runtime.env`, so every setting a package reads is listable before its code runs. There is no denylist and no
 * grant: a package reads what Studio's own process reads, through the function the host passes, because the SDK never
 * reads `process` itself. A name the manifest does not declare is refused by name, and the host's function is never
 * called for it.
 */
import type { EnvDeclaration } from "../manifest/manifest-types.generated";

/** The reader a call is given as `ctx.env`. */
export interface EnvReader {
  /**
   * The value of a declared variable, or `undefined` when the environment does not set it.
   *
   * @throws {UndeclaredEnvironmentError} For a name the manifest does not declare, which is never read.
   */
  get(name: string): string | undefined;
}

/** Thrown when a package asks for an environment variable its manifest does not declare. */
export class UndeclaredEnvironmentError extends Error {
  /** The name asked for. */
  readonly variable: string;

  constructor(variable: string) {
    super(
      `The provider asked for the environment variable ${JSON.stringify(variable)}, which its manifest does not declare in runtime.env, so it was not read.`,
    );
    this.name = "UndeclaredEnvironmentError";
    this.variable = variable;
  }
}

/**
 * A reader over the names `declared` lists, which reads each through `read`. The caller builds one for each call it
 * makes; the reader holds a frozen copy of the declared names and nothing else.
 */
export function envReader(
  declared: readonly EnvDeclaration[] | undefined,
  read: (name: string) => string | undefined,
): EnvReader {
  const names: readonly string[] = Object.freeze((declared ?? []).map((declaration) => declaration.name));
  return Object.freeze({
    get(name: string): string | undefined {
      if (!names.includes(name)) throw new UndeclaredEnvironmentError(name);
      return read(name);
    },
  });
}
