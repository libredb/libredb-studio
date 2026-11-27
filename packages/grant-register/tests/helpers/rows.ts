/**
 * Register rows built in code for the package's tests, under synthetic engine ids, with every digest generated at run
 * time.
 */
import { createHash, randomUUID } from "node:crypto";

/** Two synthetic engine ids, never an engine Studio serves. */
export const ENGINE_A = "enginea";
export const ENGINE_B = "engineb";

/** A digest in the lock's form, new on every call. */
export function digest(): string {
  return `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
}

/** A complete grants object, every member at a value in its vocabulary, with `overrides` laid over it. */
export function grants(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    writeReach: "open",
    readsFileAccessPosture: false,
    deniedFileAccessRefusal: null,
    singleWriterFile: false,
    readRootsRequired: false,
    agentCredentialForm: null,
    maskingExemptColumns: null,
    exposable: true,
    statementRead: false,
    metadataReadChangesState: false,
    agentCredentialRequired: false,
    opensLocalFile: false,
    hostPathFields: [],
    serverLevelWithoutDatabase: false,
    sshTunnel: null,
    agentCredential: null,
    statementLanguage: null,
    agentReadings: [],
    catalogReadCommandShaped: false,
    servesOneSession: null,
    agentExecution: false,
    ownWords: "scrubbed",
    redaction: { kind: "none" },
    readsSqlText: true,
    confirmExemptForms: [],
    decidesAlone: false,
    grammarSha256: null,
    languageSha256: null,
    ...overrides,
  };
}

/** A SHA-256 in lower-case hex, the form of a row's grammar and language digests, new on every call. */
export function hexDigest(): string {
  return digest().slice("sha256:".length);
}

/** A copy of `record` without its member `key`. */
export function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** A valid legacy row of `engine`. */
export function legacyRow(engine = ENGINE_A, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { legacy: "@libredb/studio", engine, grants: grants(), ...overrides };
}

/** A valid package row of `engine`, with a fresh digest unless `key` gives one. */
export function packageRow(
  engine = ENGINE_B,
  key: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    package: { name: "@planted/provider-b", version: "1.2.3", digest: digest(), ...key },
    engine,
    grants: grants(),
    ...overrides,
  };
}
