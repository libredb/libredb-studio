/**
 * The mutation-target wrapper of the vector live harnesses (tests/live/support/mutation-guard.ts; vector-family
 * spec 4.2): a mutating call outside the harness prefix throws before the wire, and so does every
 * call the rules cannot place.
 */
import { describe, expect, test } from "bun:test";
import {
  guardMutations,
  MutationOutsidePrefixError,
  type MutationRules,
  UndeclaredMethodError,
} from "../../live/support/mutation-guard";

class FakeAdminClient {
  readonly wire: string[] = [];

  async listCollections(): Promise<string[]> {
    this.wire.push("listCollections");
    return ["docs"];
  }

  async createCollection(name: string): Promise<void> {
    this.wire.push(`createCollection ${name}`);
  }

  async createAlias(alias: string, collection: string): Promise<void> {
    this.wire.push(`createAlias ${alias} ${collection}`);
  }

  async compact(): Promise<void> {
    this.wire.push("compact");
  }
}

const PREFIX = "libredb_live_";

function guarded(client = new FakeAdminClient()): { client: FakeAdminClient; guard: FakeAdminClient } {
  const rules: MutationRules<FakeAdminClient> = {
    prefix: PREFIX,
    reads: ["listCollections"],
    mutating: ["createCollection", "createAlias"],
    targetsOf: (_method, args) => args.filter((arg): arg is string => typeof arg === "string"),
  };
  return { client, guard: guardMutations(client, rules) };
}

describe("guardMutations", () => {
  test("a read passes through and reaches the wire", async () => {
    const { client, guard } = guarded();
    expect(await guard.listCollections()).toEqual(["docs"]);
    expect(client.wire).toEqual(["listCollections"]);
  });

  test("a mutation whose every target is under the prefix reaches the wire", async () => {
    const { client, guard } = guarded();
    await guard.createCollection(`${PREFIX}copy`);
    await guard.createAlias(`${PREFIX}alias`, `${PREFIX}copy`);
    expect(client.wire).toEqual([`createCollection ${PREFIX}copy`, `createAlias ${PREFIX}alias ${PREFIX}copy`]);
  });

  test("a mutation of a seeded collection throws before the wire", () => {
    const { client, guard } = guarded();
    expect(() => guard.createCollection("docs")).toThrow(MutationOutsidePrefixError);
    expect(() => guard.createCollection("docs")).toThrow(
      "createCollection would write docs, outside libredb_live_: refused before the wire",
    );
    expect(client.wire).toEqual([]);
  });

  test("one target outside the prefix is enough to refuse the whole call", () => {
    const { client, guard } = guarded();
    expect(() => guard.createAlias(`${PREFIX}alias`, "docs")).toThrow(
      "createAlias would write docs, outside libredb_live_: refused before the wire",
    );
    expect(client.wire).toEqual([]);
  });

  test("a mutation whose targets cannot be named throws before the wire", () => {
    const client = new FakeAdminClient();
    const guard = guardMutations(client, {
      prefix: PREFIX,
      reads: [],
      mutating: ["createCollection"],
      targetsOf: () => [],
    });
    expect(() => guard.createCollection(`${PREFIX}copy`)).toThrow(
      "createCollection names no target, so it cannot be proved to stay under libredb_live_: refused before the wire",
    );
    expect(client.wire).toEqual([]);
  });

  test("a method declared neither a read nor a mutation throws when it is reached for", () => {
    const { client, guard } = guarded();
    expect(() => guard.compact()).toThrow(UndeclaredMethodError);
    expect(() => guard.compact()).toThrow("compact is declared neither a read nor a mutation of the harness client");
    expect(client.wire).toEqual([]);
  });

  test("a property that is not a method is read as it is", () => {
    const { client, guard } = guarded();
    expect(guard.wire).toBe(client.wire);
  });

  test("an empty prefix and a method declared twice are refused when the wrapper is built", () => {
    const client = new FakeAdminClient();
    expect(() => guardMutations(client, { prefix: "", reads: [], mutating: [], targetsOf: () => [] })).toThrow(
      "the harness prefix must not be empty",
    );
    expect(() =>
      guardMutations(client, {
        prefix: PREFIX,
        reads: ["createCollection"],
        mutating: ["createCollection"],
        targetsOf: () => [],
      }),
    ).toThrow("declared both a read and a mutation: createCollection");
  });
  test("a call a wrapped method makes through this is guarded too", () => {
    const wire: string[] = [];
    const client = {
      drop(name: string): void {
        wire.push(`drop ${name}`);
      },
      setup(name: string): void {
        wire.push(`setup ${name}`);
        this.drop("production");
      },
      describe(name: string): void {
        this.drop(name);
      },
    };
    const guard = guardMutations(client, {
      prefix: PREFIX,
      reads: ["describe"],
      mutating: ["drop", "setup"],
      targetsOf: (_method, args) => args.filter((arg): arg is string => typeof arg === "string"),
    });
    expect(() => guard.describe("docs")).toThrow(
      "drop would write docs, outside libredb_live_: refused before the wire",
    );
    expect(wire).toEqual([]);
    expect(() => guard.setup(`${PREFIX}a`)).toThrow(
      "drop would write production, outside libredb_live_: refused before the wire",
    );
    expect(wire).toEqual([`setup ${PREFIX}a`]);
  });

  test("a method keyed by a symbol is undeclared and throws when it is reached for", () => {
    const wire: string[] = [];
    const key = Symbol("drop");
    const client = {
      [key](name: string): void {
        wire.push(`symbol ${name}`);
      },
    };
    const guard = guardMutations(client, { prefix: PREFIX, reads: [], mutating: [], targetsOf: () => [] });
    expect(() => guard[key]("docs")).toThrow(UndeclaredMethodError);
    expect(() => guard[key]("docs")).toThrow(
      "Symbol(drop) is declared neither a read nor a mutation of the harness client",
    );
    expect(wire).toEqual([]);
  });

  test("a target that is not a string is refused with the guard's own error, before the wire", () => {
    const client = new FakeAdminClient();
    const guard = guardMutations(client, {
      prefix: PREFIX,
      reads: [],
      mutating: ["createCollection"],
      targetsOf: () => [undefined as unknown as string],
    });
    expect(() => guard.createCollection(`${PREFIX}copy`)).toThrow(MutationOutsidePrefixError);
    expect(() => guard.createCollection(`${PREFIX}copy`)).toThrow(
      "createCollection would write undefined, outside libredb_live_: refused before the wire",
    );
    expect(client.wire).toEqual([]);
  });

  test("the methods every object inherits, such as toString, stay usable on a guarded client", () => {
    const { guard } = guarded();
    expect(String(guard)).toBe("[object Object]");
    expect(Object.prototype.hasOwnProperty.call(guard, "wire")).toBe(true);
    expect(guard.hasOwnProperty("wire")).toBe(true);
  });
});
