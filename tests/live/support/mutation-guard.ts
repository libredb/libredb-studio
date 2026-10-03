/**
 * The wrapper a vector live harness puts around its own setup client (vector-family spec 4.2 VF10, R51 U19): a
 * mutating call whose target lies outside the harness prefix throws before the wire, so the harness can only ever
 * write what it owns. Every method the client exposes must be declared a read or a mutation; an undeclared one
 * throws when it is reached for, and a mutation whose targets cannot be named throws too, because a target that
 * cannot be proved inside the prefix is outside it.
 */

type MethodOf<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
  string;

export interface MutationRules<T extends object> {
  /** The prefix every collection, alias or database the harness writes starts with. */
  readonly prefix: string;
  readonly reads: readonly MethodOf<T>[];
  readonly mutating: readonly MethodOf<T>[];
  /** The names a mutating call writes to, read from its arguments. */
  readonly targetsOf: (method: MethodOf<T>, args: readonly unknown[]) => readonly string[];
}

export class MutationOutsidePrefixError extends Error {
  constructor(
    readonly method: string,
    readonly targets: readonly string[],
    prefix: string,
  ) {
    super(
      targets.length === 0
        ? `${method} names no target, so it cannot be proved to stay under ${prefix}: refused before the wire`
        : `${method} would write ${targets.filter((target) => !target.startsWith(prefix)).join(", ")}, outside ${prefix}: refused before the wire`,
    );
    this.name = "MutationOutsidePrefixError";
  }
}

export class UndeclaredMethodError extends Error {
  constructor(readonly method: string) {
    super(`${method} is declared neither a read nor a mutation of the harness client`);
    this.name = "UndeclaredMethodError";
  }
}

export function guardMutations<T extends object>(client: T, rules: MutationRules<T>): T {
  if (rules.prefix === "") throw new Error("the harness prefix must not be empty");
  const both = rules.reads.filter((method) => rules.mutating.includes(method));
  if (both.length > 0) throw new Error(`declared both a read and a mutation: ${both.join(", ")}`);
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      const method = property as MethodOf<T>;
      const call = value as (...args: unknown[]) => unknown;
      if (rules.reads.includes(method)) return (...args: unknown[]) => call.apply(target, args);
      if (!rules.mutating.includes(method)) throw new UndeclaredMethodError(property);
      return (...args: unknown[]) => {
        const targets = rules.targetsOf(method, args);
        if (targets.length === 0 || targets.some((name) => !name.startsWith(rules.prefix))) {
          throw new MutationOutsidePrefixError(property, targets, rules.prefix);
        }
        return call.apply(target, args);
      };
    },
  });
}
