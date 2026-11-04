/**
 * The keys agent mode compares OPC UA node ids by, and the facts the read roots walk prunes a node on.
 *
 * NODE IDS ARE COMPARED AS ONE KEY (`canonicalNodeId`): namespace 0 written with or without `ns=0;`, a GUID in lower
 * case, an opaque ByteString re-encoded as padded base64 (a decoder takes it unpadded and with stray trailing bits, so
 * `b=AQ`, `b=AR==` and `b=AQ==` are one node), and an `nsu=` namespace URI turned into its index through the server's
 * own NamespaceArray (i=2255), read on the read's session. An id that cannot be put in that form (an identifier that
 * does not decode) has no key.
 *
 * WHAT IS PRUNED INSIDE A ROOT, as defence in depth: a node whose type definition is one of the namespace-0 types that
 * hold sessions, security configuration, roles or PubSub key management (`OPCUA_PRUNED_TYPE_DEFINITIONS`), a Variable
 * of one of the namespace-0 data types that hold the same (`OPCUA_PRUNED_DATA_TYPES`), and a node whose name names a
 * credential (`namesCredential`). A vendor type, data type or name these miss inside a declared root is answered,
 * because the operator declared that subtree readable; the boundary is the read roots themselves (`agent-roots.ts`).
 */
import type { OpcuaNodeId } from "./client";
import { OPCUA_FOUNDATION_NAMESPACE } from "./constants";

const MAX_UINT16 = 65_535;
const MAX_UINT32 = 4_294_967_295;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One identifier in its one spelling, or undefined when it is not one of Part 6 5.1.12's four forms. */
function canonicalIdentifier(identifier: string): string | undefined {
  if (identifier.startsWith("i=")) {
    const digits = identifier.slice(2);
    if (!/^\d{1,10}$/.test(digits) || Number(digits) > MAX_UINT32) return undefined;
    return `i=${Number(digits)}`;
  }
  if (identifier.startsWith("s=")) return identifier.length > 2 ? identifier : undefined;
  if (identifier.startsWith("g=")) {
    const guid = identifier.slice(2).toLowerCase();
    return GUID.test(guid) ? `g=${guid}` : undefined;
  }
  if (identifier.startsWith("b=")) {
    // Decoded and encoded again: a decoder takes base64 unpadded and ignores trailing bits, so one ByteString has
    // several spellings, and only the bytes name the node.
    try {
      return `b=${btoa(atob(identifier.slice(2)))}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * One node id as the one key the agent path compares and sends, or undefined for an id that has none.
 *
 * Namespace 0 is written with no prefix and every other namespace as `ns=<index>;`. An `nsu=` URI is namespace 0 when
 * it is the OPC Foundation's, its index in `namespaces` (the server's NamespaceArray) when that is given, and left
 * as `nsu=<uri>;<identifier>` for the session to decide when it is not; a URI the table does not hold has no key.
 * A server answers ids as `ns=0;i=2254` (measured on OPC PLC 2.15.10), so its answers go through this as well.
 */
export function canonicalNodeId(nodeId: OpcuaNodeId, namespaces?: readonly string[]): OpcuaNodeId | undefined {
  let index: number | undefined;
  let uri: string | undefined;
  let rest = nodeId;
  const indexed = /^ns=(\d{1,5});/.exec(rest);
  const named = /^nsu=([^;]+);/.exec(rest);
  if (indexed !== null) {
    index = Number(indexed[1]);
    if (index > MAX_UINT16) return undefined;
    rest = rest.slice(indexed[0].length);
  } else if (named !== null) {
    uri = named[1];
    rest = rest.slice(named[0].length);
  } else {
    index = 0;
  }
  const identifier = canonicalIdentifier(rest);
  if (identifier === undefined) return undefined;
  if (uri !== undefined) {
    if (uri === OPCUA_FOUNDATION_NAMESPACE) index = 0;
    else if (namespaces === undefined) return `nsu=${uri};${identifier}`;
    else {
      const found = namespaces.indexOf(uri);
      if (found < 0) return undefined;
      index = found;
    }
  }
  return index === 0 ? identifier : `ns=${index};${identifier}`;
}

/** Whether a key still names its namespace by URI, so the server's NamespaceArray decides it. */
export const namesNamespaceUri = (key: OpcuaNodeId): boolean => key.startsWith("nsu=");

/** Whether a key is in namespace 0. Keys only: `canonicalNodeId` writes namespace 0 with no prefix. */
export const inNamespace0 = (key: OpcuaNodeId): boolean => !key.startsWith("ns=") && !namesNamespaceUri(key);

/**
 * The namespace-0 type definitions the read roots walk prunes, with everything beneath a node of one: the session and
 * subscription diagnostics, the security configuration (certificate groups, trust lists, key credentials,
 * authorization services, user management, configuration files), the roles, and the PubSub key management. Defence in
 * depth inside a root, never the boundary: a vendor type that holds the same is not on it, and a node of one inside a
 * declared root is answered, since the operator declared that subtree readable. The table is not extended here.
 */
export const OPCUA_PRUNED_TYPE_DEFINITIONS: ReadonlyMap<OpcuaNodeId, string> = new Map([
  ["i=2026", "SessionsDiagnosticsSummaryType"],
  ["i=2029", "SessionDiagnosticsObjectType"],
  ["i=2196", "SessionDiagnosticsArrayType"],
  ["i=2197", "SessionDiagnosticsVariableType"],
  ["i=2243", "SessionSecurityDiagnosticsArrayType"],
  ["i=2244", "SessionSecurityDiagnosticsType"],
  ["i=2171", "SubscriptionDiagnosticsArrayType"],
  ["i=2172", "SubscriptionDiagnosticsType"],
  ["i=12581", "ServerConfigurationType"],
  ["i=13813", "CertificateGroupFolderType"],
  ["i=12555", "CertificateGroupType"],
  ["i=12522", "TrustListType"],
  ["i=17496", "KeyCredentialConfigurationFolderType"],
  ["i=18001", "KeyCredentialConfigurationType"],
  ["i=23556", "AuthorizationServicesConfigurationFolderType"],
  ["i=17852", "AuthorizationServiceConfigurationType"],
  ["i=24264", "UserManagementType"],
  ["i=25731", "ApplicationConfigurationType"],
  ["i=16662", "ApplicationConfigurationFolderType"],
  ["i=15437", "ConfigurationFileType"],
  ["i=15550", "ApplicationConfigurationFileType"],
  ["i=26871", "ProvisionableDeviceType"],
  ["i=15607", "RoleSetType"],
  ["i=15620", "RoleType"],
  ["i=15452", "SecurityGroupFolderType"],
  ["i=15471", "SecurityGroupType"],
  ["i=25346", "PubSubKeyPushTargetFolderType"],
  ["i=25337", "PubSubKeyPushTargetType"],
  ["i=15906", "PubSubKeyServiceType"],
]);

/**
 * The namespace-0 data types a value of which the read roots walk never answers: a session's or subscription's
 * diagnostics, a client application's description, a user identity token, an identity mapping rule, a user account, a
 * trust list, and the PubSub key management objects. A Variable of one is pruned, and an answer whose Read returns one
 * is answered as an id outside the roots. Defence in depth for the same reason as the type definitions, except where
 * the answer-time check reads it.
 */
export const OPCUA_PRUNED_DATA_TYPES: ReadonlyMap<OpcuaNodeId, string> = new Map([
  ["i=865", "SessionDiagnosticsDataType"],
  ["i=868", "SessionSecurityDiagnosticsDataType"],
  ["i=874", "SubscriptionDiagnosticsDataType"],
  ["i=308", "ApplicationDescription"],
  ["i=316", "UserIdentityToken"],
  ["i=319", "AnonymousIdentityToken"],
  ["i=322", "UserNameIdentityToken"],
  ["i=325", "X509IdentityToken"],
  ["i=938", "IssuedIdentityToken"],
  ["i=15634", "IdentityMappingRuleType"],
  ["i=24281", "UserManagementDataType"],
  ["i=12554", "TrustListDataType"],
  ["i=23601", "SecurityGroupDataType"],
  ["i=25270", "PubSubKeyPushTargetDataType"],
]);

/** Words that name a credential wherever they sit inside a word of a name. */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "credential",
  "privatekey",
  "apikey",
  "accesskey",
  "token",
  "jwt",
  "psk",
  "connectionstring",
  "connstr",
  "passwort",
  "kennwort",
  "passcode",
  "pincode",
  "keystore",
]);

/**
 * Words that name a credential only as the whole last word of a name: a key, a pass, a PIN or an SNMP community ends
 * a credential's name (EncryptionKey, MqttPass, DevicePIN, ReadCommunity), not when it starts one (KeyPressure,
 * PassCount, PinCount) or is part of a word (Keyboard, Bypass, Spindle).
 */
const CREDENTIAL_LAST_WORDS: ReadonlySet<string> = new Set(["key", "pass", "pin", "community"]);

/** A data source name is a connection string as a word of its own (DSN, Db_DSN), never inside a word. */
const CREDENTIAL_WHOLE_WORDS: ReadonlySet<string> = new Set(["dsn"]);

/** A word with and without a trailing plural `s`, so `Passwords` and `ApiKeys` are held to `password` and `key`. */
const forms = (word: string): readonly string[] => (word.endsWith("s") ? [word, word.slice(0, -1)] : [word]);

/**
 * Whether a name names a credential, failing closed: its words, split at every character that is not a letter or a
 * digit, at every change from lower to upper case and at every boundary between a letter and a digit, each in lower
 * case with and without a trailing plural `s`, and every two adjacent words joined. A name is named when any word, or
 * any two adjacent words joined, holds one of the any-word words anywhere inside it, since a one-case compound
 * (`devicepassword`, `DEVICEPASSWORD`, `adminpwd2`) has no boundary to split at; when its last word that is not a
 * number is a key, a pass, a PIN or a community; and when any word is a DSN. So `DB_Password`, `Passwords`,
 * `password1`, `ApiKeys`, `Secret_2`, `EncryptionKey2`, `MqttPass`, `Passwort`, `Passcode`, `DevicePIN`, `DbConnStr`
 * and `DSN` are named, and so are `Tokenizer` and `Secretary`, which hold `token` and `secret`; `KeyPressure`,
 * `Keyboard`, `PassCount`, `PinCount`, `Bypass` and `Passage` are not. The read roots walk prunes a node so named, as
 * defence in depth: the words are frozen, and a credential name they miss inside a declared root is answered. The
 * server writes the name, and a reply may carry one of hundreds of thousands of characters, so every pattern here is
 * linear in its length and none backtracks over a run of capitals.
 */
export function namesCredential(name: string): boolean {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  const holds = (word: string): boolean =>
    forms(word).some((form) => [...CREDENTIAL_WORDS].some((named) => form.includes(named)));
  const last = words.filter((word) => !/^\d+$/.test(word)).at(-1) ?? "";
  if (forms(last).some((form) => CREDENTIAL_LAST_WORDS.has(form))) return true;
  if (words.some((word) => forms(word).some((form) => CREDENTIAL_WHOLE_WORDS.has(form)))) return true;
  return words.some((word, at) => holds(word) || (at > 0 && holds(`${words[at - 1]}${word}`)));
}
