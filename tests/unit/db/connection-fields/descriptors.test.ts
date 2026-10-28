/**
 * The connection-field descriptors (src/lib/db/connection-fields.ts) and the layout the connection dialog draws from
 * them (src/lib/db/connection-field-layout.ts): every field is described once, as data, and the dialog's body is the
 * engine's declared fields mapped through those descriptors, in the engine's order, with the engine-agnostic rows
 * (the address row, the login row and the API-key pair) placed by rule rather than by engine.
 */
import { describe, expect, test } from "bun:test";
import { CONNECTION_FORM, type ConnectionFormSpec } from "@/lib/db/connection-form";
import {
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELD_GROUPS,
  CONNECTION_FIELDS,
  type ConnectionField,
} from "@/lib/db/connection-fields";
import { connectionFormLayout, type ConnectionFormSlot } from "@/lib/db/connection-field-layout";
import type { DatabaseType } from "@/lib/types";

const EVERY_DECLARED_FIELD = [...new Set(Object.values(CONNECTION_FIELDS).flat())].sort();

/** A slot as one short word, so a whole body reads as one line in a failure. */
function word(slot: ConnectionFormSlot): string {
  if (slot.kind === "address") return "address";
  if (slot.kind === "group") return `${slot.group}(${slot.fields.join(",")})`;
  return slot.field;
}

function bodyOf(type: DatabaseType, values: Partial<Record<ConnectionField, string>> = {}): string[] {
  return connectionFormLayout(CONNECTION_FORM[type], values).body.map(word);
}

/** A form entry with only the given fields, for the rules no shipped engine exercises. */
function spec(
  connectionFields: readonly ConnectionField[],
  extra: Partial<ConnectionFormSpec> = {},
): ConnectionFormSpec {
  return { label: "Probe", defaultPort: "", showConnectionStringToggle: false, connectionFields, ...extra };
}

describe("the descriptor registry", () => {
  test("describes exactly the fields some engine declares", () => {
    expect(Object.keys(CONNECTION_FIELD_DESCRIPTORS).sort()).toEqual(EVERY_DECLARED_FIELD);
  });

  test("gives every field the renderer draws a label of the dialog's own", () => {
    for (const [field, descriptor] of Object.entries(CONNECTION_FIELD_DESCRIPTORS)) {
      if (descriptor.slot !== "body") continue;
      expect({ field, label: descriptor.label.trim() !== "" }).toEqual({ field, label: true });
    }
  });

  test("puts a field in a group only where that group is declared", () => {
    for (const descriptor of Object.values(CONNECTION_FIELD_DESCRIPTORS)) {
      if (descriptor.slot !== "body" || descriptor.group === undefined) continue;
      expect(Object.keys(CONNECTION_FIELD_GROUPS)).toContain(descriptor.group);
    }
  });

  test("leaves the address, the connection string and the cleartext consent to the dialog's own layout", () => {
    expect(CONNECTION_FIELD_DESCRIPTORS.host.slot).toBe("address");
    expect(CONNECTION_FIELD_DESCRIPTORS.port.slot).toBe("address");
    expect(CONNECTION_FIELD_DESCRIPTORS.connectionString.slot).toBe("uri");
    expect(CONNECTION_FIELD_DESCRIPTORS.allowInsecureAuth.slot).toBe("consent");
  });
});

describe("the connection form layout", () => {
  test("draws a networked engine's address row, then its login row, then the rest in its own order", () => {
    expect(bodyOf("postgres")).toEqual(["address", "login(user,password)", "database"]);
    expect(bodyOf("kubernetes")).toEqual([
      "address",
      "login(password)",
      "database",
      "namespaces",
      "apiPath",
      "tlsServerName",
    ]);
  });

  test("keeps a select the engine declares before the login fields ahead of the login row", () => {
    expect(bodyOf("kafka")).toEqual(["address", "saslMechanism", "login(user,password)"]);
  });

  test("draws the login row, empty, after the address row of an engine that takes no credential", () => {
    expect(bodyOf("modbus")).toEqual(["address", "login()", "registerMap"]);
  });

  test("opens a form with no address row with the login row", () => {
    expect(bodyOf("firestore")).toEqual(["login(password)", "database", "schema"]);
  });

  test("draws an engine's fields in its declared dialog order where it has one", () => {
    expect(bodyOf("bigquery")).toEqual(["login(password)", "database", "location", "schema"]);
    // The declared list keeps the order the VS Code extension prompts in.
    expect(CONNECTION_FORM.bigquery.connectionFields).toEqual(["database", "schema", "password", "location"]);
  });

  test("holds every declared dialog order to the engine's own fields, each once", () => {
    for (const [type, entry] of Object.entries(CONNECTION_FORM)) {
      if (entry.dialogOrder === undefined) continue;
      expect({ type, order: [...entry.dialogOrder].sort() }).toEqual({
        type,
        order: [...entry.connectionFields].sort(),
      });
    }
  });

  test("draws a field a dialog order leaves out after the ones it names", () => {
    const layout = connectionFormLayout(spec(["host", "user", "database"], { dialogOrder: ["database", "host"] }), {});
    expect(layout.body.map(word)).toEqual(["database", "address", "login(user)"]);
  });

  test("draws a field the engine shows under a condition at its own place, outside the login row", () => {
    expect(bodyOf("snowflake")).toEqual([
      "address",
      "login(user)",
      "authMethod",
      "privateKey",
      "privateKeyPassphrase",
      "warehouse",
      "database",
      "schema",
      "role",
    ]);
    expect(bodyOf("snowflake", { authMethod: "pat" })).toEqual([
      "address",
      "login(user)",
      "authMethod",
      "password",
      "warehouse",
      "database",
      "schema",
      "role",
    ]);
  });

  test("draws the API-key pair as one row", () => {
    expect(bodyOf("elasticsearch")).toEqual(["address", "login(user,password)", "apiKey(apiKeyId,apiKeySecret)"]);
  });

  test("draws a placeable field where the engine places it", () => {
    expect(bodyOf("mongodb")).toEqual(["address", "login(user,password)", "database", "authSource"]);
    expect(bodyOf("cassandra")).toEqual(["address", "login(user,password)", "database", "localDataCenter"]);
    expect(connectionFormLayout(CONNECTION_FORM.oracle, {}).advanced).toEqual(["serviceName"]);
    expect(connectionFormLayout(CONNECTION_FORM.mssql, {}).advanced).toEqual(["instanceName"]);
    expect(connectionFormLayout(CONNECTION_FORM.postgres, {}).advanced).toEqual([]);
  });

  test("says whether the address row has a port and whether the cleartext consent is offered", () => {
    expect(connectionFormLayout(CONNECTION_FORM.postgres, {})).toMatchObject({
      takesPort: true,
      takesInsecureAuthConsent: false,
    });
    expect(connectionFormLayout(CONNECTION_FORM.opcua, {})).toMatchObject({ takesPort: false });
    expect(connectionFormLayout(CONNECTION_FORM.db2, {})).toMatchObject({ takesInsecureAuthConsent: true });
  });

  test("draws one address row for an entry that lists the port before the host", () => {
    expect(connectionFormLayout(spec(["port", "host", "user"]), {}).body.map(word)).toEqual(["address", "login(user)"]);
  });

  test("draws a group's members once, however the entry spreads them", () => {
    const layout = connectionFormLayout(spec(["host", "user", "database", "password"]), {});
    expect(layout.body.map(word)).toEqual(["address", "login(user,password)", "database"]);
  });

  test("draws nothing but the login row for an entry that takes nothing the renderer draws", () => {
    expect(connectionFormLayout(spec(["connectionString"]), {}).body.map(word)).toEqual(["login()"]);
  });
});
