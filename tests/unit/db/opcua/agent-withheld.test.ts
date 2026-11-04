/**
 * The keys OPC UA node ids are compared by, and the facts the read roots walk prunes a node on: a credential name and
 * the namespace-0 type definitions and data types that hold sessions, security configuration, roles and PubSub keys.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalNodeId,
  inNamespace0,
  namesCredential,
  namesNamespaceUri,
  OPCUA_PRUNED_DATA_TYPES,
  OPCUA_PRUNED_TYPE_DEFINITIONS,
} from "@/lib/db/providers/industrial/opcua/agent-withheld";

describe("canonicalNodeId", () => {
  test("namespace 0 is one node however it is written", () => {
    expect(canonicalNodeId("ns=0;i=2253")).toBe("i=2253");
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;s=x")).toBe("s=x");
    expect(canonicalNodeId("ns=3;s=SlowUInt1")).toBe("ns=3;s=SlowUInt1");
  });

  test("a numeric identifier and a namespace index are numbers, within their ranges", () => {
    expect(canonicalNodeId("ns=03;i=0042")).toBe("ns=3;i=42");
    expect(canonicalNodeId("i=4294967295")).toBe("i=4294967295");
    expect(canonicalNodeId("i=4294967296")).toBeUndefined();
    expect(canonicalNodeId("ns=65536;i=1")).toBeUndefined();
    expect(canonicalNodeId("i=-1")).toBeUndefined();
    expect(canonicalNodeId("i=")).toBeUndefined();
    expect(canonicalNodeId("s=")).toBeUndefined();
    expect(canonicalNodeId("x=1")).toBeUndefined();
  });

  test("a GUID is compared in lower case, and a String identifier keeps its own semicolons and case", () => {
    expect(canonicalNodeId("ns=2;g=ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
      "ns=2;g=abcdef01-2345-6789-abcd-ef0123456789",
    );
    expect(canonicalNodeId("ns=2;g=not-a-guid")).toBeUndefined();
    expect(canonicalNodeId("ns=3;s=a;g=AB")).toBe("ns=3;s=a;g=AB");
    expect(canonicalNodeId("s=A;B")).toBe("s=A;B");
  });

  test("an opaque identifier is its bytes: unpadded, padded and stray trailing bits are one node", () => {
    for (const spelling of ["ns=2;b=AQ==", "ns=2;b=AQ", "ns=2;b=AR==", "ns=2;b=AR"])
      expect(canonicalNodeId(spelling)).toBe("ns=2;b=AQ==");
    expect(canonicalNodeId("ns=2;b=A=Q=")).toBeUndefined();
    expect(canonicalNodeId("ns=2;b=A")).toBeUndefined();
  });

  test("a namespace URI is namespace 0's, an index in the server's table, or left for the session to decide", () => {
    expect(canonicalNodeId("nsu=urn:plant;s=Pump")).toBe("nsu=urn:plant;s=Pump");
    expect(namesNamespaceUri("nsu=urn:plant;s=Pump")).toBe(true);
    expect(namesNamespaceUri("ns=3;s=Pump")).toBe(false);
    expect([inNamespace0("i=2256"), inNamespace0("ns=3;s=Pump"), inNamespace0("nsu=urn:plant;s=Pump")]).toEqual([
      true,
      false,
      false,
    ]);
    const table = ["http://opcfoundation.org/UA/", "urn:host", "urn:plant"];
    expect(canonicalNodeId("nsu=urn:plant;s=Pump", table)).toBe("ns=2;s=Pump");
    expect(canonicalNodeId("nsu=urn:plant;b=AR", table)).toBe("ns=2;b=AQ==");
    expect(canonicalNodeId("nsu=urn:elsewhere;s=Pump", table)).toBeUndefined();
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;i=1", [])).toBe("i=1");
  });

  test("namespace 0's URI with an index after it, or a node on another server, has no key", () => {
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;ns=0;i=1")).toBeUndefined();
    expect(canonicalNodeId("nsu=urn:plant;ns=2;i=1")).toBeUndefined();
    // How the library spells an expanded node id with a URI and a server index.
    expect(canonicalNodeId("ns=0;i=5;namespaceUri:urn:x;serverIndex:2")).toBeUndefined();
  });
});

/**
 * Defence in depth inside a read root: a node named for a credential is pruned, failing closed. The words are frozen,
 * so a name they miss inside a root is answered, because the operator declared that subtree readable.
 */
describe("namesCredential", () => {
  test("a name names a credential by its words, and by a credential word inside one", () => {
    for (const name of ["DB_Password", "PrivateKey", "APIKey", "connection-string", "SECRET", "userPwd", "AuthToken"])
      expect(namesCredential(name)).toBe(true);
    for (const name of ["KeyPressure", "Passage", "SlowUInt1", "Boiler #1", ""])
      expect(namesCredential(name)).toBe(false);
  });

  test("plural, digit-suffixed and one-case compound forms are named, failing closed", () => {
    for (const name of [
      "Passwords",
      "password1",
      "DEVICEPASSWORD",
      "devicepassword",
      "adminpwd2",
      "ApiKeys",
      "mqttpassword",
      "Secret_2",
      "EncryptionKey2",
      "Credentials",
      "accesstokens",
      "MQTTPSK",
      "dbconnstring",
    ])
      expect(namesCredential(name)).toBe(true);
    // A credential word is matched inside a word, since a one-case compound (`authtokenvalue`, `devicesecret`) has no
    // boundary to split at; so `Tokenizer` and `Secretary`, which hold `token` and `secret`, are withheld too.
    for (const name of ["Tokenizer", "Secretary", "authtokenvalue", "devicesecret"])
      expect(namesCredential(name)).toBe(true);
  });

  test("a token is named as a word anywhere, and a key or a pass as the last word, as the class says", () => {
    for (const name of [
      "Token",
      "RefreshToken",
      "BearerToken",
      "SessionToken",
      "ApiToken",
      "Token_Expiry",
      "JWT",
      "Key",
      "EncryptionKey",
      "SharedKey",
      "PreSharedKey",
      "Site.Keys",
      "PSK",
      "ConnString",
      "Pass",
      "MqttPass",
    ])
      expect(namesCredential(name)).toBe(true);
    for (const name of ["KeyPressure", "Keyboard", "Monkey", "PassCount", "Bypass", "KeyedTank1", "Hockey"])
      expect(namesCredential(name)).toBe(false);
  });

  test("a German password, a passcode, a PIN, a short connection string, a DSN and an SNMP community are named", () => {
    for (const name of [
      "Passwort",
      "AdminPasswort",
      "Kennwort",
      "Passcode",
      "DoorPasscode",
      "DevicePIN",
      "Device_Pin",
      "PIN",
      "Pins",
      "PinCode",
      "DbConnStr",
      "connstr",
      "DSN",
      "Db_DSN",
      "OdbcDsnName",
      "ReadCommunity",
      "SnmpCommunity",
      "KeyStore",
    ])
      expect([name, namesCredential(name)]).toEqual([name, true]);
    // The pinned readable names stay readable, and a PIN or a DSN counts only as a word of its own.
    for (const name of [
      "KeyPressure",
      "Keyboard",
      "PassCount",
      "Bypass",
      "Passage",
      "PinCount",
      "Spindle",
      "Spin",
      "Pinion",
      "Opinion",
      "CommunityPage",
      "Boiler #1",
    ])
      expect([name, namesCredential(name)]).toEqual([name, false]);
  });

  test("a name the size of a whole server reply is split in linear time, since the server writes it", () => {
    // A reply may carry a name of hundreds of thousands of characters. A split that backtracks over a run of capitals
    // needs tens of seconds for these, far past the test's own timeout; a linear one needs milliseconds.
    const run = "A".repeat(200_000);
    expect(namesCredential(run)).toBe(false);
    expect(namesCredential(`${run}b`)).toBe(false);
    expect(namesCredential(`${run}Password`)).toBe(true);
    expect(namesCredential(`${"AB".repeat(100_000)}Key`)).toBe(true);
    // The capitals before a capitalised word still split from it, as before.
    for (const name of ["APIKey", "DBPassword", "HTTPToken"])
      expect([name, namesCredential(name)]).toEqual([name, true]);
    expect(namesCredential("PLCKeyPressure")).toBe(false);
  });
});

/** The namespace-0 type definitions and data types the read roots walk prunes, each by its id in the published nodeset. */
describe("the pruned type definitions and data types", () => {
  const nodeset = readFileSync(
    join(process.cwd(), "node_modules", "node-opcua-nodesets", "nodesets", "Opc.Ua.NodeSet2.xml"),
    "utf8",
  );
  const browseNameOf = (id: string): string | undefined => {
    const at = nodeset.indexOf(` NodeId="${id}" `);
    if (at < 0) return undefined;
    const from = nodeset.indexOf('BrowseName="', at) + 'BrowseName="'.length;
    return nodeset.slice(from, nodeset.indexOf('"', from));
  };

  test("every id is in namespace 0 and names its node as the nodeset does", () => {
    for (const table of [OPCUA_PRUNED_TYPE_DEFINITIONS, OPCUA_PRUNED_DATA_TYPES])
      for (const [id, name] of table) {
        expect(canonicalNodeId(id)).toBe(id);
        expect([id, browseNameOf(id)]).toEqual([id, name]);
      }
  });

  test("the sessions, security configuration, roles and PubSub key management are covered", () => {
    expect(OPCUA_PRUNED_TYPE_DEFINITIONS.get("i=2029")).toBe("SessionDiagnosticsObjectType");
    expect(OPCUA_PRUNED_TYPE_DEFINITIONS.get("i=12581")).toBe("ServerConfigurationType");
    expect(OPCUA_PRUNED_TYPE_DEFINITIONS.get("i=15620")).toBe("RoleType");
    expect(OPCUA_PRUNED_TYPE_DEFINITIONS.get("i=15471")).toBe("SecurityGroupType");
    expect(OPCUA_PRUNED_DATA_TYPES.get("i=865")).toBe("SessionDiagnosticsDataType");
    expect(OPCUA_PRUNED_DATA_TYPES.get("i=322")).toBe("UserNameIdentityToken");
  });
});
