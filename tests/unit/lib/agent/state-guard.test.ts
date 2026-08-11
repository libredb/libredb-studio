import { describe, expect, test } from "bun:test";
import { AgentStateError, assertPersistableState } from "@/lib/agent/state-guard";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import * as connectionSecrets from "@/lib/storage/connection-secrets";
import { type FieldClass, SECRET_FIELD_MAPS } from "@/lib/storage/connection-secrets";

function captureRefusal(value: unknown, label?: string): AgentStateError {
  try {
    if (label === undefined) assertPersistableState(value);
    else assertPersistableState(value, label);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentStateError);
    return error as AgentStateError;
  }
  throw new Error("expected the value to be refused as unpersistable");
}

/**
 * The field names this repository itself classifies as stored secrets. Read from
 * the same exported map list the guard reads (`connection-secrets.ts`), not from
 * a second hand-written list of maps: a fourth secret-bearing map added there has
 * to be covered by the guard or this test fails.
 */
const STORED_SECRET_FIELDS: string[] = SECRET_FIELD_MAPS.flatMap((map) =>
  Object.entries(map as Record<string, FieldClass>)
    .filter(([, classification]) => classification === "secret")
    .map(([key]) => key),
);

// ─── what persisted run state may contain ───────────────────────────────────

describe("assertPersistableState — accepted values", () => {
  test("accepts primitives, null and an absent value", () => {
    for (const value of ["a string", 0, 42, -1.5, true, false, null, undefined]) {
      expect(() => assertPersistableState(value)).not.toThrow();
    }
  });

  test("accepts an empty object and an empty array", () => {
    expect(() => assertPersistableState({})).not.toThrow();
    expect(() => assertPersistableState([])).not.toThrow();
  });

  test("accepts nested plain objects, arrays and identifier/summary fields", () => {
    const state = {
      runId: "run_1",
      events: [{ kind: "tool-completed", atMs: 12, artifact: { correlationId: "c1", summary: { rowCount: 3 } } }],
      tables: [{ name: "orders", columns: [{ name: "id", nullable: false }] }],
    };
    expect(() => assertPersistableState(state, "run")).not.toThrow();
  });

  test("accepts a null-prototype object, which serializes exactly like a plain one", () => {
    const bag = Object.create(null) as Record<string, unknown>;
    bag.fingerprint = "sha256-abc";
    expect(() => assertPersistableState(bag)).not.toThrow();
  });

  test("accepts a value referenced twice — a shared reference is not a cycle", () => {
    // JSON.stringify duplicates a shared reference rather than failing on it, so
    // refusing this would refuse state that round-trips perfectly well.
    const shared = { fingerprint: "sha256-abc" };
    expect(() => assertPersistableState({ before: shared, after: shared })).not.toThrow();
    expect(() => assertPersistableState([shared, shared])).not.toThrow();
  });

  test("accepts a deeply shared subgraph without re-walking it once per path", () => {
    // 26 stacked diamonds: 2^26 visits if a cleared node is walked again for
    // every path that reaches it, and 27 if it is not. This case is the reason
    // the walk memoizes — without it the suite times out here rather than
    // returning a wrong answer.
    let node: Record<string, unknown> = { fingerprint: "sha256-abc" };
    for (let depth = 0; depth < 26; depth++) node = { left: node, right: node };
    expect(() => assertPersistableState(node, "snapshot")).not.toThrow();
  });

  test("accepts an optional PROPERTY explicitly set to undefined", () => {
    // JSON drops it, so the round trip is lossless in the only direction that
    // matters: the field is absent either way. This holds for a property; an
    // undefined ARRAY slot serializes as null instead, which the module's
    // HONEST LIMITS records as an accepted asymmetry rather than a guarantee.
    expect(() => assertPersistableState({ locator: undefined })).not.toThrow();
    expect(JSON.stringify({ locator: undefined })).toBe("{}");
    expect(JSON.stringify({ slots: [undefined] })).toBe('{"slots":[null]}');
  });
});

// ─── functions ──────────────────────────────────────────────────────────────

describe("assertPersistableState — FUNCTION_VALUE", () => {
  test("refuses a function at the root", () => {
    const error = captureRefusal(() => "not state");
    expect(error.reasonCode).toBe("FUNCTION_VALUE");
    expect(error.path).toBe("state");
  });

  test("refuses a method hiding on a nested object, naming where it is", () => {
    const error = captureRefusal({ artifact: { correlationId: "c1", readAll: () => [] } }, "run");
    expect(error.reasonCode).toBe("FUNCTION_VALUE");
    expect(error.path).toBe("run.artifact.readAll");
    expect(error.message).toContain("FUNCTION_VALUE");
    expect(error.message).toContain("run.artifact.readAll");
  });

  test("refuses a function inside an array, naming its index", () => {
    const error = captureRefusal({ events: [{ atMs: 1 }, { resume: () => undefined }] }, "run");
    expect(error.reasonCode).toBe("FUNCTION_VALUE");
    expect(error.path).toBe("run.events[1].resume");
  });

  test("refuses an accessor property without invoking it", () => {
    // A getter is not inert data, and reading one to inspect it would both run
    // whatever it does and let its own throw escape instead of a typed refusal.
    let reads = 0;
    const state = {
      get rowsOnDemand(): unknown {
        reads += 1;
        throw new TypeError("driver detached");
      },
    };
    const error = captureRefusal(state, "run");
    expect(error.reasonCode).toBe("FUNCTION_VALUE");
    expect(error.path).toBe("run.rowsOnDemand");
    expect(reads).toBe(0);
  });

  test("refuses a setter-only property too", () => {
    const state = Object.defineProperty({}, "sink", { set: () => undefined, enumerable: true });
    expect(captureRefusal(state).reasonCode).toBe("FUNCTION_VALUE");
  });
});

// ─── an array's own properties ──────────────────────────────────────────────

describe("assertPersistableState — arrays are walked like every other container", () => {
  /**
   * An array is not only its elements: `mssql` hands back a `recordset` that is
   * an array carrying its own `columns` property, so "the elements are clean"
   * cannot be where the walk stops.
   */
  function arrayWith(property: string, value: unknown): unknown[] {
    const array: unknown[] = [{ atMs: 1 }];
    Object.defineProperty(array, property, { value, enumerable: true, configurable: true, writable: true });
    return array;
  }

  test("refuses a credential-shaped own property on an array", () => {
    const error = captureRefusal({ events: arrayWith("password", "s3cret") }, "run");
    expect(error.reasonCode).toBe("CREDENTIAL_KEY");
    expect(error.path).toBe("run.events.password");
  });

  test("refuses a result payload smuggled as an array's own property", () => {
    const error = captureRefusal({ events: arrayWith("rows", [{ id: 1 }]) }, "run");
    expect(error.reasonCode).toBe("RAW_RESULT_SET");
    expect(error.path).toBe("run.events.rows");
  });

  test("refuses a function held on an array", () => {
    const error = captureRefusal({ events: arrayWith("close", () => undefined) }, "run");
    expect(error.reasonCode).toBe("FUNCTION_VALUE");
    expect(error.path).toBe("run.events.close");
  });

  test("refuses a client instance held on an array", () => {
    const error = captureRefusal({ events: arrayWith("pool", new Map()) }, "run");
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.path).toBe("run.events.pool");
  });

  test("refuses a symbol-keyed property on an array", () => {
    const array: unknown[] = [];
    (array as unknown as Record<symbol, unknown>)[Symbol("client")] = "hidden";
    const error = captureRefusal({ events: array }, "run");
    expect(error.reasonCode).toBe("NON_SERIALIZABLE_VALUE");
    expect(error.path).toBe("run.events");
  });

  test("refuses an Array subclass, which is a class instance like any other", () => {
    class RecordSet extends Array {}
    const error = captureRefusal({ events: new RecordSet() }, "run");
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.message).toContain("RecordSet");
  });

  test("still reports an element by index, not by key", () => {
    expect(captureRefusal({ events: [{ atMs: 1 }, { rows: [] }] }, "run").path).toBe("run.events[1].rows");
  });
});

// ─── driver / provider / client instances ───────────────────────────────────

describe("assertPersistableState — CLASS_INSTANCE", () => {
  /**
   * The rule is categorical — anything whose prototype is neither
   * `Object.prototype` nor null is refused — so the cases below mix real
   * platform classes with the two in-repo run-state classes a run loop could
   * plausibly be tempted to persist.
   *
   * The real `pg` Pool and PostgreSQLProvider are deliberately NOT imported
   * here: `mock.module` is process-wide and two unit suites already mock `pg`
   * (the coverage-isolation rule in CLAUDE.md), so importing the driver into
   * this file would make it load-order dependent. Locally declared classes
   * carrying those names are the same input to a prototype check.
   */
  class Pool {
    readonly totalCount = 0;
  }
  class PostgreSQLProvider {
    readonly type = "postgres";
  }

  test("refuses every driver, provider, client and run-state instance", () => {
    const instances: Array<[string, object]> = [
      ["Pool", new Pool()],
      ["PostgreSQLProvider", new PostgreSQLProvider()],
      ["ExecutionArtifactStore", new ExecutionArtifactStore({ ttlMs: 1000, maxArtifacts: 1 })],
      ["ExecutionBudgetTracker", new ExecutionBudgetTracker()],
      ["Map", new Map<string, string>()],
      ["Set", new Set<string>()],
      ["Date", new Date(0)],
      ["Error", new Error("driver said no")],
      ["Uint8Array", new Uint8Array(1)],
    ];
    for (const [name, instance] of instances) {
      const error = captureRefusal({ client: instance }, "run");
      expect(error.reasonCode).toBe("CLASS_INSTANCE");
      expect(error.path).toBe("run.client");
      expect(error.message).toContain(name);
    }
  });

  test("refuses an instance whose prototype carries no constructor", () => {
    const exotic = Object.create(Object.create(null)) as object;
    const error = captureRefusal(exotic);
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.message).toContain("unknown class");
  });

  test("refuses the instance rather than inspecting its fields", () => {
    // A Date has no forbidden key, so a walker that recursed into it would
    // report nothing at all — the prototype is what makes it unpersistable.
    expect(captureRefusal(new Date(0)).reasonCode).toBe("CLASS_INSTANCE");
  });
});

// ─── objects that fight back ────────────────────────────────────────────────

describe("assertPersistableState — a hostile object still refuses IN TYPE", () => {
  /**
   * The refusal contract is "a typed error naming which rule fired". An object
   * that throws while being inspected must therefore still leave through
   * `AgentStateError`, not through the driver's own error: a caller that catches
   * `AgentStateError` to report "this cannot be persisted" would otherwise see an
   * unrelated `TypeError` escape and treat it as a bug in the run store.
   *
   * All three inputs below are fail-closed either way — nothing is persisted —
   * so what these pin is the TYPE of the refusal, not whether it happens.
   */
  test("refuses an object whose constructor getter throws, without letting it escape", () => {
    const hostile = Object.create({
      get constructor(): never {
        throw new TypeError("driver detached while being named");
      },
    }) as object;
    const error = captureRefusal({ client: hostile }, "run");
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.path).toBe("run.client");
    expect(error.message).toContain("unknown class");
  });

  test("refuses a revoked proxy instead of dying inside reflection", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const error = captureRefusal({ client: proxy }, "run");
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.path).toBe("run.client");
  });

  test("refuses a proxy whose key traps throw", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("connection closed");
        },
      },
    );
    const error = captureRefusal({ client: hostile }, "run");
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.path).toBe("run.client");
  });

  test("lets a RangeError through instead of reporting it as a class instance", () => {
    // Stack exhaustion inside the walk raises a RangeError from whichever call
    // happened to be running - and reflection is where the deepest frames are, so
    // it lands inside `reflect`'s try more often than anywhere else. Reporting
    // CLASS_INSTANCE there would name a rule that did not fire, about a value
    // that may be perfectly inert: the reason code would be a false statement
    // rather than a degraded label. The guard fails closed either way (nothing is
    // persisted), so what this pins is the HONESTY of the refusal, not whether it
    // happens. A hostile proxy can therefore choose to escape as a RangeError -
    // recorded in the module's HONEST LIMITS, and it buys the caller nothing.
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new RangeError("Maximum call stack size exceeded");
        },
      },
    );
    expect(() => assertPersistableState({ client: hostile }, "run")).toThrow(RangeError);
    try {
      assertPersistableState({ client: hostile }, "run");
    } catch (error) {
      expect(error).not.toBeInstanceOf(AgentStateError);
    }
  });

  test("refuses a proxy whose property reads throw", () => {
    const hostile = new Proxy(
      { handle: 1 },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error("connection closed");
        },
      },
    );
    expect(captureRefusal({ client: hostile }, "run").reasonCode).toBe("CLASS_INSTANCE");
  });
});

// ─── credentials ────────────────────────────────────────────────────────────

describe("assertPersistableState — CREDENTIAL_KEY", () => {
  test("the derived secret-field set is what this repository actually classifies", () => {
    // Pinned literally, because the loop below derives its expectations from the
    // same aggregate the guard derives from: without this, a map DROPPED from
    // `SECRET_FIELD_MAPS` would silently un-cover its fields on both sides and
    // every assertion would still pass. `clientKey` is the one that proves it
    // matters - no credential stem matches it, so the derivation is its only
    // cover.
    expect(new Set(STORED_SECRET_FIELDS)).toEqual(
      new Set(["password", "connectionString", "agentPassword", "clientKey", "privateKey", "passphrase"]),
    );
  });

  test("every classification map the storage module exports is registered in SECRET_FIELD_MAPS", () => {
    // The pin above fails when a map is REMOVED from the aggregate. This is the
    // other direction, which is the one that actually loses coverage silently: a
    // FOURTH classification map added to connection-secrets.ts and wired into the
    // encrypt/decrypt walk, but never registered in `SECRET_FIELD_MAPS`, leaves
    // the storage layer encrypting a field this guard would happily persist. The
    // aggregate is a hand-maintained array with no type-level guarantee (the
    // module's own docblock says so), so this is where that gap is closed.
    //
    // A classification map is recognised structurally rather than by name: a
    // non-empty plain object whose every value is a `FieldClass`.
    const isClassificationMap = (value: unknown): value is Record<string, FieldClass> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const values = Object.values(value);
      return (
        values.length > 0 && values.every((entry) => entry === "secret" || entry === "public" || entry === "nested")
      );
    };

    const exported = Object.entries(connectionSecrets).filter(([, value]) => isClassificationMap(value));
    expect(exported.length).toBeGreaterThan(0);

    const registered = new Set<unknown>(SECRET_FIELD_MAPS);
    const unregistered = exported.filter(([, map]) => !registered.has(map)).map(([name]) => name);
    expect(unregistered).toEqual([]);
    expect(exported).toHaveLength(SECRET_FIELD_MAPS.length);
  });

  test("covers every field this repository classifies as a stored secret", () => {
    expect(STORED_SECRET_FIELDS.length).toBeGreaterThan(0);
    for (const field of STORED_SECRET_FIELDS) {
      const error = captureRefusal({ connection: { [field]: "s3cret" } }, "run");
      expect(error.reasonCode).toBe("CREDENTIAL_KEY");
      expect(error.path).toBe(`run.connection.${field}`);
    }
  });

  test("refuses the LLM provider key, the credential the agent path itself holds", () => {
    expect(captureRefusal({ apiKey: "sk-live-000" }).reasonCode).toBe("CREDENTIAL_KEY");
  });

  test.each(["Password", "PASSWORD", "api_key", "API-KEY", "connection_string"])(
    "refuses the spelling variant %p",
    (key) => {
      expect(captureRefusal({ [key]: "s3cret" }).reasonCode).toBe("CREDENTIAL_KEY");
    },
  );

  test.each([
    "dbPassword",
    "adminPassword",
    "userPasswd",
    "pwd",
    "secret",
    "clientSecret",
    "jwtSecret",
    "accessToken",
    "idToken",
    "refreshToken",
    "bearerToken",
    "authToken",
    "privateKeyPem",
    "credentials",
    "authorization",
    "cookie",
    "jwt",
  ])("refuses the credential-shaped name %p, which no storage map spells", (key) => {
    // The classification maps cover what this product STORES; a run's own state
    // can hold a session token or a provider secret under a name they never
    // spell, so the derived names are widened by stem.
    expect(captureRefusal({ [key]: "s3cret" }).reasonCode).toBe("CREDENTIAL_KEY");
  });

  test.each(["tokenCount", "totalTokens", "passthrough", "keyColumns", "publicKeyFingerprint"])(
    "accepts %p — a bare token/pass/key stem would refuse legitimate run state",
    (key) => {
      expect(() => assertPersistableState({ [key]: 12 })).not.toThrow();
    },
  );

  test("refuses on the key alone, whatever the value is", () => {
    // A credential-shaped key with a placeholder value is code on its way to
    // persisting the real thing; it is refused before it gets there.
    expect(captureRefusal({ password: undefined }).reasonCode).toBe("CREDENTIAL_KEY");
    expect(captureRefusal({ password: null }).reasonCode).toBe("CREDENTIAL_KEY");
  });

  test("accepts the fields the same maps classify as public", () => {
    // `authMethod` is the reason the stem is `authorization` and not a bare
    // `auth`: this map classifies it public, so a wider stem would refuse it.
    const publicFields = {
      host: "db.internal",
      user: "reader",
      database: "shop",
      enabled: true,
      mode: "require",
      authMethod: "agent",
    };
    expect(() => assertPersistableState(publicFields, "run")).not.toThrow();
  });

  test("a credential key wins over a function nested under it", () => {
    // Key rules are evaluated before the walk descends, so the reported rule is
    // the one about the field that must not exist at all.
    const error = captureRefusal({ password: { open: () => "s3cret" } });
    expect(error.reasonCode).toBe("CREDENTIAL_KEY");
    expect(error.path).toBe("state.password");
  });
});

// ─── raw result sets ────────────────────────────────────────────────────────

describe("assertPersistableState — RAW_RESULT_SET", () => {
  test("refuses a rows array", () => {
    const error = captureRefusal({ artifact: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } }, "run");
    expect(error.reasonCode).toBe("RAW_RESULT_SET");
    expect(error.path).toBe("run.artifact.rows");
  });

  test.each(["rows", "explainPlan", "allRows", "Rows"])("refuses the result-payload field %p", (key) => {
    expect(captureRefusal({ [key]: [] }).reasonCode).toBe("RAW_RESULT_SET");
  });

  test.each(["resultRows", "sampleRows", "dataRows"])(
    "does NOT refuse %p — rule 6 matches its derived names exactly, and says so",
    (key) => {
      // Pins the documented limit rather than leaving it to prose: rule 6 is not
      // stem-widened the way the credential rule is, because a rows array under
      // an arbitrary name is indistinguishable from a legitimate summary. The
      // real boundary is that `AgentRunRecord` has no field accepting a result
      // set. If this ever starts throwing, the module docblock is now wrong.
      expect(() => assertPersistableState({ [key]: [{ id: 1 }] })).not.toThrow();
    },
  );

  test("accepts the summary fields of the same result type", () => {
    const summary = {
      fields: ["id", "total"],
      rowCount: 2,
      executionTime: 11,
      columnTypes: { id: "integer" },
      pagination: { limit: 100, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
      warnings: [{ message: "sequential scan" }],
    };
    expect(() => assertPersistableState(summary, "run")).not.toThrow();
  });
});

// ─── values JSON cannot carry ───────────────────────────────────────────────

describe("assertPersistableState — NON_SERIALIZABLE_VALUE", () => {
  test("refuses a symbol, a bigint and every non-finite number", () => {
    for (const value of [Symbol("tool"), BigInt(10), Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const error = captureRefusal({ budget: value }, "run");
      expect(error.reasonCode).toBe("NON_SERIALIZABLE_VALUE");
      expect(error.path).toBe("run.budget");
    }
  });

  test("refuses a symbol-keyed property, which JSON drops silently", () => {
    const state: Record<string | symbol, unknown> = { runId: "run_1" };
    state[Symbol("client")] = "hidden";
    const error = captureRefusal(state);
    expect(error.reasonCode).toBe("NON_SERIALIZABLE_VALUE");
    expect(error.path).toBe("state");
  });
});

// ─── cycles ─────────────────────────────────────────────────────────────────

describe("assertPersistableState — CYCLIC_REFERENCE", () => {
  test("refuses a self-referencing object instead of throwing from JSON.stringify", () => {
    const state: Record<string, unknown> = { runId: "run_1" };
    state.self = state;
    const error = captureRefusal(state, "run");
    expect(error.reasonCode).toBe("CYCLIC_REFERENCE");
    expect(error.path).toBe("run.self");
  });

  test("refuses a cycle closed through an array", () => {
    const events: unknown[] = [];
    events.push({ events });
    const error = captureRefusal({ events }, "run");
    expect(error.reasonCode).toBe("CYCLIC_REFERENCE");
    expect(error.path).toBe("run.events[0].events");
  });
});

// ─── the error itself ───────────────────────────────────────────────────────

describe("AgentStateError", () => {
  test("is a typed error naming the rule that fired and where", () => {
    const error = captureRefusal({ pool: new Map() }, "run");
    expect(error.name).toBe("AgentStateError");
    expect(error instanceof AgentStateError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.reasonCode).toBe("CLASS_INSTANCE");
    expect(error.path).toBe("run.pool");
  });

  test("roots the path at a caller-supplied label, defaulting to state", () => {
    expect(captureRefusal({ rows: [] }).path).toBe("state.rows");
    expect(captureRefusal({ rows: [] }, "snapshot").path).toBe("snapshot.rows");
  });
});
