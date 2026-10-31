/**
 * The withheld policy, compiled from module texts shaped like the RFC modules the fixture serves: which chains each
 * kind withholds, which paths are refused before anything is sent (oracles included), and how an answer is pruned so
 * no withheld value, child or key reaches it.
 */
import { describe, expect, test } from "bun:test";
import {
  NETCONF_METADATA_ONLY,
  NETCONF_WITHHELD_MODULES,
  NETCONF_WITHHELD_REASONS,
  NETCONF_WITHHELD_TEXT,
  NetconfWithheldPolicy,
  WITHHELD_CELL,
  withheldRows,
  withheldWarning,
  type NetconfLibraryModule,
  type NetconfModuleText,
} from "@/lib/db/providers/network/netconf/agent-withheld";
import type { XmlElement } from "@/lib/db/providers/network/netconf/reader-port";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import { READER_LIMITS } from "@/lib/db/providers/network/netconf/reader-port";
import { YangTextError } from "@/lib/db/providers/network/netconf/yangtree";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";

const CRYPT_HASH = `module iana-crypt-hash { prefix ianach; typedef crypt-hash { type string; } }`;
const CRYPTO_TYPES = `module ietf-crypto-types {
  prefix ct;
  import ietf-netconf-acm { prefix nacm; }
  grouping password-grouping {
    choice password-type {
      case cleartext-password { leaf cleartext-password { type string; nacm:default-deny-all; } }
      case encrypted-password { container encrypted-password { leaf encrypted-value { type binary; } } }
    }
  }
  grouping private-key-grouping {
    leaf private-key-format { type string; }
    choice private-key-type {
      case cleartext-private-key { leaf cleartext-private-key { type binary; } }
      case hidden-private-key { leaf hidden-private-key { type empty; } }
    }
  }
}`;
const SSH_SERVER = `module ietf-ssh-server {
  prefix sshs;
  import iana-crypt-hash { prefix ianach; }
  typedef my-hash { type union { type uint8; type ianach:crypt-hash; } }
  grouping ssh-server-grouping {
    container users {
      list user {
        key name;
        leaf name { type string; }
        container password { leaf hashed-password { type ianach:crypt-hash; } leaf last-modified { type string; } }
        leaf other-hash { type my-hash; }
        leaf copy { type leafref { path "../password/hashed-password"; } }
        leaf absolute-copy { type leafref { path "/sshs:users/sshs:user[sshs:name = current()/../name]/sshs:password/sshs:hashed-password"; } }
        leaf same-last-name { type leafref { path "../../elsewhere/name"; } }
        leaf one-step { type leafref { path "../name"; } }
      }
    }
  }
}`;
const SYSTEM = `module vendor-sys {
  prefix vs;
  import ietf-netconf-acm { prefix acl; }
  include vendor-sys-sub;
  container sys {
    leaf hostname { type string; }
    container radius { leaf shared-secret { type string; acl:default-deny-all; } leaf server { type string; } }
    container other { leaf name { type string; acl:default-deny-all; } }
    list secret-keyed { key token; leaf token { type string; acl:default-deny-all; } leaf note { type string; } }
    uses sys-group { refine "inner/refined" { acl:default-deny-all; } augment "inner" { leaf added { type string; acl:default-deny-all; } } }
    choice c { acl:default-deny-all; case a { leaf under-choice { type string; } } }
    rpc reset { acl:default-deny-all; input { leaf in-rpc { type string; } } }
  }
  augment "/vs:sys/vs:radius" { leaf aug-secret { type string; acl:default-deny-all; } }
  deviation "/vs:sys/vs:hostname-dev" { deviate add { acl:default-deny-all; } }
  deviation "/vs:sys/vs:hash-dev" { deviate replace { type vs:my-sub-hash; } }
  deviation "/vs:sys/vs:plain-dev" { deviate add { must "true()"; } }
}`;
const SYSTEM_SUB = `submodule vendor-sys-sub {
  belongs-to vendor-sys { prefix vs; }
  import iana-crypt-hash { prefix h; }
  typedef my-sub-hash { type h:crypt-hash; }
  container stray { leaf sub-hash { type my-sub-hash; } leaf extension-elsewhere { type string; other:default-deny-all; } }
}`;

const TEXTS: NetconfModuleText[] = [
  { name: "iana-crypt-hash", text: CRYPT_HASH },
  { name: "ietf-crypto-types", text: CRYPTO_TYPES },
  { name: "ietf-ssh-server", text: SSH_SERVER },
  { name: "vendor-sys", text: SYSTEM },
  { name: "vendor-sys-sub", text: SYSTEM_SUB },
];
const LIBRARY: NetconfLibraryModule[] = [
  { name: "ietf-keystore", namespace: "urn:example:keystore-served", submodules: [] },
  { name: "vendor-sys", namespace: "urn:example:vs", submodules: [{ name: "vendor-sys-sub" }] },
];
const policy = NetconfWithheldPolicy.compile(LIBRARY, TEXTS);

describe("which chains each kind withholds", () => {
  test("crypt-hash: the typedef, a union holding it, a typedef chain through a submodule, a deviation and a leafref", () => {
    for (const chain of [
      ["users", "user", "password", "hashed-password"],
      ["netconf-server", "listen", "users", "user", "password", "hashed-password"],
      ["users", "user", "other-hash"],
      ["users", "user", "copy"],
      ["users", "user", "absolute-copy"],
      ["stray", "sub-hash"],
      ["sys", "hash-dev"],
    ]) {
      expect(policy.chainMatch(chain)).toEqual({ kind: "crypt-hash" });
    }
    expect(policy.chainMatch(["users", "user", "password", "last-modified"])).toBeUndefined();
    expect(policy.chainMatch(["users", "user", "name"])).toBeUndefined();
    // A leafref is withheld only when its target's steps meet a withheld chain, never for sharing a last name.
    expect(policy.chainMatch(["users", "user", "same-last-name"])).toBeUndefined();
    expect(policy.chainMatch(["users", "user", "one-step"])).toBeUndefined();
  });

  test("nacm:default-deny-all: a leaf, a list key, a refine, an augment inside uses and at the top, a deviation and a choice", () => {
    for (const chain of [
      ["sys", "radius", "shared-secret"],
      ["sys", "secret-keyed", "token"],
      ["sys", "inner", "refined"],
      ["sys", "inner", "added"],
      ["sys", "radius", "aug-secret"],
      ["sys", "hostname-dev"],
      ["sys", "under-choice"],
      ["stray", "extension-elsewhere"],
    ]) {
      expect(policy.chainMatch(chain)).toEqual({ kind: "nacm:default-deny-all" });
    }
    expect(policy.chainMatch(["sys", "radius", "server"])).toBeUndefined();
    expect(policy.chainMatch(["sys", "plain-dev"])).toBeUndefined();
    expect(policy.chainMatch(["sys", "reset", "in-rpc"])).toBeUndefined();
  });

  test("ietf-crypto-types secret: every node of the three secret choices, and nothing beside them", () => {
    // cleartext-password also carries its own default-deny-all mark; the choice it sits in names it first.
    for (const chain of [
      ["cleartext-private-key"],
      ["hidden-private-key"],
      ["cleartext-password"],
      ["encrypted-password"],
      ["a", "encrypted-password", "encrypted-value"],
    ]) {
      expect(policy.chainMatch(chain)).toEqual({ kind: "ietf-crypto-types secret" });
    }
    expect(policy.chainMatch(["private-key-format"])).toBeUndefined();
  });

  test("the two modules withheld whole, by the namespace the library serves and by the registered one", () => {
    expect(policy.moduleOf("urn:example:keystore-served")).toEqual({ kind: "ietf-keystore" });
    expect(policy.moduleOf(NETCONF_WITHHELD_MODULES["ietf-netconf-acm"])).toEqual({ kind: "ietf-netconf-acm" });
    expect(policy.moduleOf(undefined, "ietf-netconf-acm")).toEqual({ kind: "ietf-netconf-acm" });
    expect(policy.moduleOf("urn:example:vs", "vendor-sys")).toBeUndefined();
  });

  test("a module text that cannot be read refuses the whole policy", () => {
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "x", text: "module x {" }])).toThrow(YangTextError);
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "x", text: "container x;" }])).toThrow(YangTextError);
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "x", text: "module a; module b;" }])).toThrow(
      YangTextError,
    );
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "x", text: "submodule x { }" }])).toThrow(YangTextError);
  });
});

describe("pathRefusal: refused before anything is sent", () => {
  const namespaceOf = (module: string) => LIBRARY.find((entry) => entry.name === module)?.namespace;
  test("a path into a withheld module, by name or by the namespace the library gives it", () => {
    expect(policy.pathRefusal([{ module: "ietf-keystore", name: "keystore" }], namespaceOf)).toEqual({
      kind: "ietf-keystore",
      at: "keystore",
    });
    const aliased = NetconfWithheldPolicy.compile(
      [{ name: "alias", namespace: NETCONF_WITHHELD_MODULES["ietf-netconf-acm"], submodules: [] }],
      [],
    );
    expect(
      aliased.pathRefusal([{ module: "alias", name: "nacm" }], () => NETCONF_WITHHELD_MODULES["ietf-netconf-acm"]),
    ).toEqual({
      kind: "ietf-netconf-acm",
      at: "nacm",
    });
  });

  test("a path that names a withheld node or a node under it", () => {
    expect(
      policy.pathRefusal(
        [{ module: "vendor-sys", name: "sys" }, { name: "radius" }, { name: "shared-secret" }],
        namespaceOf,
      ),
    ).toEqual({
      kind: "nacm:default-deny-all",
      at: "sys/radius/shared-secret",
    });
    expect(
      policy.pathRefusal([{ module: "vendor-sys", name: "sys" }, { name: "radius" }], namespaceOf),
    ).toBeUndefined();
  });

  test("a key filter on a withheld leaf is refused, whether the builder writes it as name or the module declares it", () => {
    expect(
      policy.pathRefusal(
        [
          { module: "vendor-sys", name: "sys" },
          { name: "secret-keyed", keys: ["guess"] },
        ],
        namespaceOf,
      ),
    ).toEqual({
      kind: "keyed by a withheld leaf",
      at: "sys/secret-keyed",
    });
    const byName = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: "module m { prefix m; import ietf-netconf-acm { prefix n; } list l { key k; leaf k { type string; } leaf name { type string; n:default-deny-all; } } }",
        },
      ],
    );
    expect(byName.pathRefusal([{ name: "l", keys: ["guess"] }], () => undefined)).toEqual({
      kind: "keyed by a withheld leaf",
      at: "l",
    });
    // Written as k, the filter never compares the withheld name leaf, so it is no oracle on it.
    expect(byName.pathRefusal([{ name: "l", keys: ["guess"], keyNames: ["k"] }], () => undefined)).toBeUndefined();
    expect(
      policy.pathRefusal(
        [
          { module: "ietf-ssh-server", name: "users" },
          { name: "user", keys: ["admin"] },
        ],
        () => undefined,
      ),
    ).toBeUndefined();
  });
});

describe("prune: what an answer may carry", () => {
  const parse = (xml: string): XmlElement => netconfXmlPort.parse(xml, READER_LIMITS);
  const top = (namespace: string | undefined) => (namespace === "urn:example:vs" ? "vendor-sys" : undefined);
  const SECRET = "not-a-real-secret";

  test("replaces a withheld leaf and a withheld container with the marker, drops an entry keyed by one, and names each path", () => {
    const data = parse(
      `<data><sys xmlns="urn:example:vs"><hostname>h</hostname><radius><server>s</server><shared-secret>${SECRET}</shared-secret></radius>` +
        `<secret-keyed><token>${SECRET}</token><note>n</note></secret-keyed><secret-keyed><token>${SECRET}2</token></secret-keyed>` +
        `<encrypted-password><encrypted-value>${SECRET}</encrypted-value></encrypted-password></sys>` +
        `<keystore xmlns="urn:example:keystore-served"><k>${SECRET}</k></keystore></data>`,
    );
    const { data: pruned, withheld } = policy.prune(data, top);
    const text = JSON.stringify(pruned, (_, value) => (value instanceof Map ? [...value] : value));
    expect(text).not.toContain(SECRET);
    expect(text).toContain(WITHHELD_CELL);
    expect(text).toContain('"hostname"');
    expect(withheld).toEqual([
      { path: "vendor-sys:sys/radius/shared-secret", kind: "nacm:default-deny-all" },
      { path: "vendor-sys:sys/secret-keyed", kind: "keyed by a withheld leaf" },
      { path: "vendor-sys:sys/secret-keyed", kind: "keyed by a withheld leaf" },
      { path: "vendor-sys:sys/encrypted-password", kind: "ietf-crypto-types secret" },
      { path: "keystore", kind: "ietf-keystore" },
    ]);
    const marker = pruned.children[0]?.children.find((child) => child.name === "encrypted-password");
    expect(marker).toEqual({
      name: "encrypted-password",
      namespace: "urn:example:vs",
      attributes: new Map(),
      children: [],
      text: WITHHELD_CELL,
      bindings: new Map(),
    });
  });

  test("a top-level element that is a list keyed by a withheld leaf is never answered", () => {
    const keyed = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: "module m { prefix m; import ietf-netconf-acm { prefix n; } list l { key k; leaf k { type string; n:default-deny-all; } } }",
        },
      ],
    );
    const { data, withheld } = keyed.prune(parse(`<data><l><k>${SECRET}</k></l></data>`), () => undefined);
    expect(JSON.stringify(data, (_, value) => (value instanceof Map ? [...value] : value))).not.toContain(SECRET);
    expect(withheld).toEqual([{ path: "l", kind: "keyed by a withheld leaf" }]);
  });
});

describe("the withheld report", () => {
  test("rows count each path and kind once, through the metadata-only projection, and warn with the reason", () => {
    const rows = withheldRows([
      { path: "m:a/b", kind: "crypt-hash" },
      { path: "m:a/b", kind: "crypt-hash" },
      { path: "keystore", kind: "ietf-keystore" },
    ]);
    expect(rows).toEqual([
      { path: "m:a/b", kind: "crypt-hash", nodes: 2 },
      { path: "keystore", kind: "ietf-keystore", nodes: 1 },
    ]);
    expect(withheldWarning(rows[0] as never)).toBe(
      `m:a/b (2 nodes) are withheld from agent mode (crypt-hash): ${NETCONF_WITHHELD_REASONS["crypt-hash"]}, so its value is not answered.`,
    );
    expect(withheldWarning(rows[1] as never)).toStartWith("keystore is withheld from agent mode (ietf-keystore):");
    expect(() => withheldRows([{ path: "x".repeat(513), kind: "crypt-hash" }])).toThrow(MetadataProjectionError);
    expect(NETCONF_METADATA_ONLY).toEqual({
      withheld: [
        { column: "path", kind: "name" },
        { column: "withheld", kind: "name" },
        { column: "nodes", kind: "count" },
      ],
    });
  });

  test("the shared sentence names every kind by its own identifier", () => {
    for (const identifier of [
      "ietf-keystore",
      "ietf-netconf-acm",
      "nacm:default-deny-all",
      "crypt-hash",
      "private-key-type",
      "key-type",
      "password-type",
      "ietf-crypto-types",
      "keyed by a withheld leaf",
    ]) {
      expect(NETCONF_WITHHELD_TEXT).toContain(identifier);
    }
  });
});
