import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_FIELDS, type ConnectionField } from "@/lib/db/connection-fields";
import { CONNECTION_FIELDS as SECRET_CLASS } from "@/lib/storage/secret-fields";
import {
  FIELD_PROMPTS,
  FORM_DEFAULTS,
  fieldLabel,
  isMaskedField,
  pathLabel,
} from "../../../src/host/connections/field-prompts";

const FIELDS = Object.keys(FIELD_PROMPTS) as ConnectionField[];
const ROOT = join(__dirname, "..", "..", "..", "..");

describe("FIELD_PROMPTS", () => {
  it("has a prompt for every field any engine declares", () => {
    for (const [type, fields] of Object.entries(CONNECTION_FIELDS)) {
      for (const field of fields) assert.ok(Object.hasOwn(FIELD_PROMPTS, field), `${type} declares ${field}`);
    }
  });

  it("gives each field the extension's word for it", () => {
    assert.deepEqual(Object.fromEntries(FIELDS.map((field) => [field, FIELD_PROMPTS[field].label])), {
      host: "Host",
      port: "Port",
      user: "User",
      password: "Password",
      database: "Database",
      schema: "Schema",
      connectionString: "Connection string",
      serviceName: "Service name",
      instanceName: "Instance name",
      localDataCenter: "Local data center",
      authSource: "Authentication database",
      apiKeyId: "API key ID",
      apiKeySecret: "API key secret",
      saslMechanism: "SASL mechanism",
      allowInsecureAuth: "Allow credentials without TLS",
      dataServers: "Data servers",
      warehouse: "Warehouse",
      location: "Location",
      region: "Region",
      apiPath: "API path",
      namespaces: "Namespaces",
      tlsServerName: "TLS server name",
      amqpPort: "AMQP port",
      authMethod: "Sign-in method",
      privateKey: "Private key",
      privateKeyPassphrase: "Private key passphrase",
      role: "Role",
      securityMode: "Security mode",
      serverCertificateThumbprint: "Server certificate thumbprint",
      registerMap: "Register map",
      hostKeyFingerprint: "Host key fingerprint",
    });
  });

  it("asks port as a port, never asks four fields in a box, and every other field as text", () => {
    assert.deepEqual(
      Object.entries(FIELD_PROMPTS)
        .filter(([, prompt]) => prompt.input !== "text")
        .map(([field, prompt]) => [field, prompt.input]),
      [
        ["port", "port"],
        ["connectionString", "none"],
        ["allowInsecureAuth", "none"],
        ["privateKey", "none"],
        ["registerMap", "none"],
      ],
    );
  });

  it("cannot be changed at run time", () => {
    assert.equal(Object.isFrozen(FIELD_PROMPTS), true);
  });
});

describe("isMaskedField", () => {
  it("masks a field exactly when the classification calls it secret", () => {
    for (const field of FIELDS) assert.equal(isMaskedField(field), SECRET_CLASS[field] === "secret", field);
  });

  it("masks the credentials and nothing else, whatever the input kind", () => {
    const masked: ConnectionField[] = [
      "password",
      "connectionString",
      "apiKeyId",
      "apiKeySecret",
      "privateKey",
      "privateKeyPassphrase",
    ];
    for (const field of masked) assert.equal(isMaskedField(field), true, field);
    for (const field of ["host", "user", "authSource", "registerMap"] as const) {
      assert.equal(isMaskedField(field), false, field);
    }
  });
});

describe("fieldLabel", () => {
  it("takes FIELD_PROMPTS' word where the engine gives no label", () => {
    assert.equal(
      fieldLabel({ name: "authSource", label: null, hint: null, placeholder: null, placement: "open" }),
      "Authentication database",
    );
  });

  it("takes the engine's label where it gives one", () => {
    assert.equal(
      fieldLabel({ name: "password", label: "Auth Token", hint: null, placeholder: null, placement: "open" }),
      "Auth Token",
    );
  });
});

describe("pathLabel", () => {
  it("labels a root path with FIELD_PROMPTS and any other path as written", () => {
    assert.equal(pathLabel("password"), "Password");
    assert.equal(pathLabel("connectionString"), "Connection string");
    assert.equal(pathLabel("ssl.clientKey"), "ssl.clientKey");
  });

  it("writes a secret root path no form asks as it is", () => {
    assert.equal(pathLabel("agentPassword"), "agentPassword");
  });
});

describe("FORM_DEFAULTS", () => {
  it("repeats the web form's host and SSL mode, and fails when either changes there", () => {
    assert.deepEqual(FORM_DEFAULTS, { host: "localhost", sslMode: "disable" });
    const lines = readFileSync(join(ROOT, "src", "hooks", "use-connection-form.ts"), "utf8").split("\n");
    const start = lines.indexOf("export const CONNECTION_FORM_DEFAULTS = {");
    assert.notEqual(start, -1, "CONNECTION_FORM_DEFAULTS is not declared where this guard reads it");
    const end = lines.indexOf("};", start);
    assert.notEqual(end, -1);
    const body = lines.slice(start + 1, end);
    assert.ok(body.includes('  host: "localhost",'), "the web form's default host changed");
    assert.ok(body.includes('  sslMode: "disable" as SSLMode,'), "the web form's default SSL mode changed");
  });
});
