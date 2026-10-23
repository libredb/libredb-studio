// How the add-connection flow asks each connection field (part 2, "The add-connection flow"): the extension's word for
// it and its input kind. Masking is not in the table: it follows P7's classification, so a secret field is masked
// whatever its input kind.
import type { ConnectionField } from "@/lib/db/connection-fields";
import { CONNECTION_FIELDS as SECRET_CLASS } from "@/lib/storage/secret-fields";
import type { SSLMode } from "@/lib/types";
import type { EngineField } from "../../protocol";

/** text and port are asked in a box; none is never asked in a box (connectionString only through the paste step). */
export type FieldInput = "text" | "port" | "none";

/**
 * How v0 asks each field: the extension's word for it and its input kind. Exhaustive, so a field LibreDB adds fails
 * the typecheck until someone decides how v0 asks it; keyed by field names, which the engine-branch guard does not read
 * as type ids.
 */
export const FIELD_PROMPTS: Readonly<Record<ConnectionField, { readonly label: string; readonly input: FieldInput }>> =
  Object.freeze({
    host: { label: "Host", input: "text" },
    port: { label: "Port", input: "port" },
    user: { label: "User", input: "text" },
    password: { label: "Password", input: "text" },
    database: { label: "Database", input: "text" },
    schema: { label: "Schema", input: "text" },
    // Asked only through the paste step.
    connectionString: { label: "Connection string", input: "none" },
    serviceName: { label: "Service name", input: "text" },
    instanceName: { label: "Instance name", input: "text" },
    localDataCenter: { label: "Local data center", input: "text" },
    authSource: { label: "Authentication database", input: "text" },
    apiKeyId: { label: "API key ID", input: "text" },
    apiKeySecret: { label: "API key secret", input: "text" },
    saslMechanism: { label: "SASL mechanism", input: "text" },
    // A checkbox in the web dialog.
    allowInsecureAuth: { label: "Allow credentials without TLS", input: "none" },
    dataServers: { label: "Data servers", input: "text" },
    warehouse: { label: "Warehouse", input: "text" },
    location: { label: "Location", input: "text" },
    region: { label: "Region", input: "text" },
    apiPath: { label: "API path", input: "text" },
    namespaces: { label: "Namespaces", input: "text" },
    tlsServerName: { label: "TLS server name", input: "text" },
    amqpPort: { label: "AMQP port", input: "text" },
    authMethod: { label: "Sign-in method", input: "text" },
    // A multi-line box in the web dialog.
    privateKey: { label: "Private key", input: "none" },
    privateKeyPassphrase: { label: "Private key passphrase", input: "text" },
    role: { label: "Role", input: "text" },
    securityMode: { label: "Security mode", input: "text" },
    serverCertificateThumbprint: { label: "Server certificate thumbprint", input: "text" },
    // A multi-line box in the web dialog.
    registerMap: { label: "Register map", input: "none" },
    hostKeyFingerprint: { label: "Host key fingerprint", input: "text" },
  });

/**
 * CONNECTION_FORM_DEFAULTS.host and .sslMode of src/hooks/use-connection-form.ts, repeated because that React hook
 * module stays out of both bundles (builder's call 1); a unit guard reads the hook's source and fails when either
 * value changes there.
 */
export const FORM_DEFAULTS: { readonly host: string; readonly sslMode: SSLMode } = Object.freeze({
  host: "localhost",
  sslMode: "disable",
});

/**
 * A field's input is masked exactly when P7's classification calls it secret; the input kind plays no part.
 * Indexing the classification with a ConnectionField compiles only while every form field is a connection field.
 */
export function isMaskedField(field: ConnectionField): boolean {
  return SECRET_CLASS[field] === "secret";
}

/** The engine's label for a field, else FIELD_PROMPTS'. */
export function fieldLabel(field: EngineField): string {
  return field.label ?? FIELD_PROMPTS[field.name].label;
}

/** A secret path's label for a prompt title: FIELD_PROMPTS' for a root field, else the path as written. */
export function pathLabel(path: string): string {
  return Object.hasOwn(FIELD_PROMPTS, path) ? FIELD_PROMPTS[path as ConnectionField].label : path;
}
