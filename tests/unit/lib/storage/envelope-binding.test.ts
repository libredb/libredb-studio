/**
 * The binding of a version 2 envelope (docs/STORAGE.md, "Where a sealed value opens"): the additional authenticated
 * data every sealed value carries, so it opens only for the owner, record, field and identity fields it was sealed for.
 *
 * The expected bytes below are written out by hand from the documented form, never derived from the module, so a change
 * to the format fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  accountBinding,
  bindingAad,
  connectionBinding,
  connectionBindingProblem,
  type EnvelopeBinding,
  MAX_BINDING_DEPTH,
} from "@/lib/storage/envelope-binding";
import {
  CONNECTION_FIELDS,
  type FieldClass,
  identityFields,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  type SecretFieldRecord,
  walkSecretFields,
} from "@/lib/storage/secret-fields";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64url");
const aadText = (binding: EnvelopeBinding): string => new TextDecoder().decode(bindingAad(binding));
const aadOf = (binding: EnvelopeBinding): Record<string, unknown> => JSON.parse(aadText(binding));

function connection(overrides: Record<string, unknown> = {}): SecretFieldRecord {
  return {
    id: "c1",
    name: "Orders",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "app",
    password: randomUUID(),
    database: "orders",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as SecretFieldRecord;
}

/** Every readable field of the three maps set to a value of its own, so a change to any one shows. */
function everyField(): SecretFieldRecord {
  const record: Record<string, unknown> = {};
  const fill = (target: Record<string, unknown>, map: Record<string, FieldClass>, prefix: string) => {
    for (const [key, fieldClass] of Object.entries(map)) {
      if (fieldClass !== "nested") target[key] = `value of ${prefix}${key}`;
    }
  };
  fill(record, CONNECTION_FIELDS, "");
  record.ssl = {};
  record.sshTunnel = {};
  fill(record.ssl as Record<string, unknown>, SSL_FIELDS, "ssl.");
  fill(record.sshTunnel as Record<string, unknown>, SSH_TUNNEL_FIELDS, "sshTunnel.");
  return record as unknown as SecretFieldRecord;
}

/** The record as the store holds it: walked, then through JSON. */
function asStored(record: SecretFieldRecord): SecretFieldRecord {
  return JSON.parse(JSON.stringify(walkSecretFields(record, (value) => value).connection));
}

describe("the binding of a version 2 envelope", () => {
  test("the binding of a connection field is the canonical JSON of the format, the table, the owner, the record, the field and the identity digest", () => {
    const identity =
      '{"database":"orders","host":"db.internal","port":5432,"ssl":{"mode":"require"},"type":"postgres","user":"app"}';
    const binding = connectionBinding("alice", connection({ ssl: { mode: "require", clientKey: randomUUID() } })).field(
      "ssl.clientKey",
    );

    expect(aadText(binding)).toBe(
      `{"d":"${sha256(identity)}","f":"ssl.clientKey","o":"alice","r":"c1","s":"v2","t":"connections"}`,
    );
  });

  test("the identity digest is the SHA-256 of the canonical JSON of the identity fields the record holds", () => {
    const record = connection({ sshTunnel: { enabled: true, host: "bastion", port: 22, authMethod: "password" } });

    expect(identityFields(record)).toEqual({
      type: "postgres",
      host: "db.internal",
      port: 5432,
      user: "app",
      database: "orders",
      sshTunnel: { enabled: true, host: "bastion", port: 22 },
    });
    expect(aadOf(connectionBinding("alice", record).field("password")).d).toBe(
      sha256(
        '{"database":"orders","host":"db.internal","port":5432,"sshTunnel":{"enabled":true,"host":"bastion","port":22},"type":"postgres","user":"app"}',
      ),
    );
  });

  test("every field the classification calls identity changes the digest, and no other field does", () => {
    const base = everyField();
    const digest = (record: SecretFieldRecord) => aadOf(connectionBinding("alice", record).field("password")).d;
    const plain = digest(base);
    const outcomes: Record<string, boolean> = {};
    const expected: Record<string, boolean> = {};
    const visit = (map: Record<string, FieldClass>, container: "ssl" | "sshTunnel" | "") => {
      for (const [key, fieldClass] of Object.entries(map)) {
        if (fieldClass === "nested" || fieldClass === "secret" || key === "id") continue;
        const path = container === "" ? key : `${container}.${key}`;
        const changed = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
        const target = container === "" ? (changed as unknown as Record<string, unknown>) : changed[container];
        target[key] = `changed ${path}`;
        outcomes[path] = digest(changed as unknown as SecretFieldRecord) !== plain;
        expected[path] = fieldClass === "identity";
      }
    };
    visit(CONNECTION_FIELDS, "");
    visit(SSL_FIELDS, "ssl");
    visit(SSH_TUNNEL_FIELDS, "sshTunnel");

    expect(Object.values(expected).filter(Boolean)).toHaveLength(30);
    expect(outcomes).toEqual(expected);
  });

  test("a record digests the same as written and as the store reads it back", () => {
    const written = connection({
      ssl: { mode: "verify-full", caCert: "ca", clientKey: randomUUID(), rejectUnauthorized: undefined },
      sshTunnel: { enabled: false, host: undefined, password: randomUUID() },
      schema: undefined,
    });

    expect(aadText(connectionBinding("alice", asStored(written)).field("password"))).toBe(
      aadText(connectionBinding("alice", written).field("password")),
    );
  });

  test("a container that is not an object digests as the walk stores it", () => {
    for (const [ssl, sshTunnel] of [
      [null, ""],
      ["text", 0],
      [false, null],
      [["array"], "tunnel"],
    ] as const) {
      const written = connection({ ssl, sshTunnel });
      const stored = asStored(written);

      expect(identityFields(written)).toEqual(identityFields(stored));
      expect(aadText(connectionBinding("alice", stored).field("password"))).toBe(
        aadText(connectionBinding("alice", written).field("password")),
      );
    }
    expect(identityFields(connection({ ssl: null, sshTunnel: "" }))).toMatchObject({ ssl: null, sshTunnel: "" });
    expect(identityFields(connection({ ssl: "text" }))).toMatchObject({ ssl: {} });
  });

  test("a record without an id binds to null, and records with different ids bind apart", () => {
    const withoutId = connection();
    delete (withoutId as { id?: string }).id;

    expect(aadOf(connectionBinding("alice", withoutId).field("password")).r).toBeNull();
    expect(aadOf(connectionBinding("alice", connection({ id: 7 })).field("password")).r).toBe(7);
    expect(aadText(connectionBinding("alice", connection({ id: "c2" })).field("password"))).not.toBe(
      aadText(connectionBinding("alice", connection()).field("password")),
    );
  });

  test("an account binding names the email and the factor field over no identity fields", () => {
    const email = `${randomUUID()}@example.test`;

    expect(aadText(accountBinding(email).field("totpPending"))).toBe(
      `{"d":"${sha256("{}")}","f":"totpPending","o":${JSON.stringify(email)},"r":${JSON.stringify(email)},"s":"v2","t":"accounts"}`,
    );
  });

  test("a binding cannot be built outside the binding module", () => {
    // @ts-expect-error: EnvelopeBinding carries a brand only envelope-binding.ts can attach.
    const outsideBinding: EnvelopeBinding = { aad: new Uint8Array([1]) };

    expect(outsideBinding).toBeDefined();
  });

  test("a binding the module did not build is refused at run time, a type assertion and an empty one included", () => {
    const refusal = "A binding not built by connectionBinding or accountBinding was passed to a seal or an open.";
    for (const outsideBinding of [
      { aad: new Uint8Array(0) } as unknown as EnvelopeBinding,
      { ...connectionBinding("alice", connection()).field("password") },
    ]) {
      expect(() => bindingAad(outsideBinding)).toThrow(refusal);
    }
    expect(bindingAad(accountBinding("ada@example.com").field("totpSecret")).length).toBeGreaterThan(0);
  });

  test("a connection whose id or identity fields nest deeper than the limit has no binding, and says so by name", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "x";
      for (let level = 0; level < depth; level++) value = level % 2 === 0 ? [value] : { inner: value };
      return value;
    };
    const problem = `The connection's id or identity fields nest deeper than ${MAX_BINDING_DEPTH} levels, which no connection does, so it has no binding.`;

    // Far deeper than the limit, which the check must name without building the binding.
    for (const deep of [
      connection({ host: nested(3000) }),
      connection({ id: nested(3000) }),
      connection({ ssl: { caCert: nested(MAX_BINDING_DEPTH) } }),
    ]) {
      expect(connectionBindingProblem(deep)).toBe(problem);
      expect(() => connectionBinding("alice", deep)).toThrow(problem);
    }
    const deepest = connection({ host: nested(MAX_BINDING_DEPTH - 1), ssl: { caCert: nested(MAX_BINDING_DEPTH - 2) } });
    expect(connectionBindingProblem(deepest)).toBeNull();
    expect(bindingAad(connectionBinding("alice", deepest).field("password")).length).toBeGreaterThan(0);
  });

  test("a connection deeper than JSON.stringify can write is named too, because the check never serializes it", () => {
    // JSON.parse builds such a value without limit, so a store row edited outside Studio can hold one.
    const depth = 200_000;
    const nested = (open: string, close: string): unknown =>
      JSON.parse(`${open.repeat(depth)}"x"${close.repeat(depth)}`);
    const problem = `The connection's id or identity fields nest deeper than ${MAX_BINDING_DEPTH} levels, which no connection does, so it has no binding.`;

    for (const deep of [
      connection({ id: nested("[", "]") }),
      connection({ host: nested('{"a":', "}") }),
      connection({ sshTunnel: { host: nested("[", "]") } }),
    ]) {
      expect(() => JSON.stringify(deep)).toThrow(RangeError);
      expect(connectionBindingProblem(deep)).toBe(problem);
      expect(() => connectionBinding("alice", deep)).toThrow(problem);
    }
  });
});
