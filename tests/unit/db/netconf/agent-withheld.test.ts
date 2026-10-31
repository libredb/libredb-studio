/**
 * The withheld policy, compiled from module texts shaped like the RFC modules the fixture serves: which chains each
 * kind withholds, which paths are refused before anything is sent (oracles included), and how an answer is pruned so
 * no withheld value, child or key reaches it.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_TYPE_DERIVATION,
  NETCONF_METADATA_ONLY,
  NETCONF_SCHEMA_BUDGET,
  NETCONF_WITHHELD_MODULES,
  NETCONF_WITHHELD_REASONS,
  NETCONF_WITHHELD_TEXT,
  NetconfSchemaBudgetError,
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
      container elsewhere { leaf name { type string; } }
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

describe("leafrefs, resolved to a fixed point", () => {
  const SYS = `module ietf-system {
    prefix sys;
    import iana-crypt-hash { prefix ianach; }
    container system { container authentication { list user { key name; leaf name { type string; } leaf password { type ianach:crypt-hash; } } } }
  }`;
  // RFC 9642's own shapes: the keystore's key list and the typedef other modules point at it with.
  const KEYSTORE = `module ietf-keystore {
    prefix ks;
    typedef asymmetric-key-ref { type leafref { path "/ks:keystore/ks:asymmetric-keys/ks:asymmetric-key/ks:name"; } }
    container keystore { container asymmetric-keys { list asymmetric-key { key name; leaf name { type string; } } } }
  }`;
  const ACME = `module acme {
    prefix a;
    import ietf-system { prefix sys; }
    import iana-crypt-hash { prefix ianach; }
    import ietf-keystore { prefix ks; }
    typedef password-ref { type leafref { path "/sys:system/sys:authentication/sys:user/sys:password"; } }
    typedef plain-ref { type leafref { path "/a:box/a:plain"; } }
    container box {
      leaf plain { type string; }
      leaf absolute { type leafref { path "../../sys:system/sys:authentication/sys:user/sys:password"; } }
      list r { key n; leaf n { type string; } leaf sibling { type leafref { path "../hp"; } } leaf hp { type ianach:crypt-hash; } }
      leaf chained { type leafref { path "../absolute"; } }
      leaf chained-twice { type leafref { path "../chained"; } }
      leaf through-typedef { type a:password-ref; }
      leaf through-union { type union { type a:password-ref; type string; } }
      leaf into-keystore { type leafref { path "/ks:keystore/ks:asymmetric-keys/ks:asymmetric-key/ks:name"; } }
      container host-key { container public-key { leaf central-keystore-reference { type ks:asymmetric-key-ref; } } }
      leaf to-plain { type a:plain-ref; }
      leaf to-nowhere { type leafref { path "/a:box/a:absent"; } }
      leaf no-path { type leafref; }
      leaf unreadable-path { type leafref { path "deref(../plain)/../x"; } }
      leaf not-relative { type leafref { path "box/plain"; } }
      leaf bare-up { type leafref { path "../.."; } }
      leaf to-acm { type leafref { path "/nacm:nacm/nacm:groups/nacm:group/nacm:name"; } }
    }
    import ietf-netconf-acm { prefix nacm; }
  }`;
  const leafrefs = NetconfWithheldPolicy.compile(
    [],
    [
      { name: "iana-crypt-hash", text: CRYPT_HASH },
      { name: "ietf-system", text: SYS },
      { name: "ietf-keystore", text: KEYSTORE },
      { name: "acme", text: ACME },
    ],
  );

  test("an absolute path, a relative path anchored at the leaf, a chain of leafrefs, a typedef and a union", () => {
    for (const leaf of ["absolute", "chained", "chained-twice", "through-typedef", "through-union"]) {
      expect(leafrefs.chainMatch(["box", leaf])).toEqual({ kind: "crypt-hash" });
    }
    // `../hp` pops the leaf itself, so it is its sibling crypt-hash leaf in the same entry.
    expect(leafrefs.chainMatch(["box", "r", "sibling"])).toEqual({ kind: "crypt-hash" });
  });

  test("a leafref into a module withheld whole takes that module's kind, through RFC 9642's asymmetric-key-ref typedef too", () => {
    expect(leafrefs.chainMatch(["box", "into-keystore"])).toEqual({ kind: "ietf-keystore" });
    expect(
      leafrefs.chainMatch([
        "netconf-server",
        "listen",
        "endpoints",
        "endpoint",
        "ssh",
        "ssh-server-parameters",
        "server-identity",
        "box",
        "host-key",
        "public-key",
        "central-keystore-reference",
      ]),
    ).toEqual({ kind: "ietf-keystore" });
    expect(leafrefs.chainMatch(["box", "to-acm"])).toEqual({ kind: "ietf-netconf-acm" });
  });

  test("a leafref whose target no module declares, or whose path cannot be read, is withheld as unresolved", () => {
    for (const leaf of ["to-nowhere", "no-path", "unreadable-path", "not-relative", "bare-up"]) {
      expect(leafrefs.chainMatch(["box", leaf])).toEqual({ kind: "unresolved leafref" });
    }
    // A leafref through a typedef to a plain leaf is read like the leaf.
    expect(leafrefs.chainMatch(["box", "to-plain"])).toBeUndefined();
    expect(leafrefs.chainMatch(["box", "plain"])).toBeUndefined();
  });

  test("a leaf whose type names a typedef no served module declares is withheld as unresolved, never read as plain", () => {
    const typed = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; import absent-types { prefix at; }
            typedef local-plain { type string; }
            typedef via-missing { type at:gone; }
            typedef via-union { type union { type uint8; type at:gone; } }
            container c {
              leaf prefixed { type at:gone; }
              leaf bare { type nowhere; }
              leaf in-union { type union { type string; type at:gone; } }
              leaf through-typedef { type via-missing; }
              leaf through-union-typedef { type via-union; }
              leaf unbound-prefix { type zz:gone; }
              leaf builtin { type string; }
              leaf builtin-union { type union { type uint8; type enumeration { enum a; } } }
              leaf local { type local-plain; }
              leaf ident { type identityref { base m:b; } }
              leaf deviated { type string; }
            }
            deviation "/m:c/m:deviated" { deviate replace { type at:gone; } }
          }`,
        },
      ],
    );
    for (const leaf of [
      "prefixed",
      "bare",
      "in-union",
      "through-typedef",
      "through-union-typedef",
      "unbound-prefix",
      "deviated",
    ]) {
      expect({ leaf, match: typed.chainMatch(["c", leaf]) }).toEqual({ leaf, match: { kind: "unresolved leafref" } });
    }
    for (const leaf of ["builtin", "builtin-union", "local", "ident"]) {
      expect({ leaf, match: typed.chainMatch(["c", leaf]) }).toEqual({ leaf, match: undefined });
    }
    expect(NETCONF_WITHHELD_REASONS["unresolved leafref"]).toContain("a typedef");
    expect(NETCONF_WITHHELD_TEXT).toContain(
      "every leaf whose type names a typedef no module the device serves declares",
    );
  });

  test("every built-in type of RFC 7950 section 4.2.4 is read as a type, never as a missing typedef", () => {
    const builtIns = [
      "binary",
      "bits",
      "boolean",
      "decimal64",
      "empty",
      "enumeration",
      "identityref",
      "instance-identifier",
      "int8",
      "int16",
      "int32",
      "int64",
      "string",
      "uint8",
      "uint16",
      "uint32",
      "uint64",
    ];
    const leaves = builtIns.map((type) => `leaf l-${type} { type ${type}; }`).join(" ");
    const plain = NetconfWithheldPolicy.compile(
      [],
      [{ name: "m", text: `module m { prefix m; container c { ${leaves} } }` }],
    );
    for (const type of builtIns) {
      expect({ type, match: plain.chainMatch(["c", `l-${type}`]) }).toEqual({ type, match: undefined });
    }
  });

  test("a chain of leafrefs declared before what it points at, whatever the order, reaches the fixed point", () => {
    const backwards = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; import iana-crypt-hash { prefix h; }
            container c { leaf a { type leafref { path "../b"; } } leaf b { type leafref { path "../d"; } } leaf d { type h:crypt-hash; } }
          }`,
        },
        { name: "iana-crypt-hash", text: CRYPT_HASH },
      ],
    );
    expect(backwards.chainMatch(["c", "a"])).toEqual({ kind: "crypt-hash" });
    expect(backwards.chainMatch(["c", "b"])).toEqual({ kind: "crypt-hash" });
  });

  test("a waiting leafref is reached whichever way a later withheld chain meets its target: longer or shorter", () => {
    const policyOf = (body: string) =>
      NetconfWithheldPolicy.compile(
        [],
        [
          { name: "iana-crypt-hash", text: CRYPT_HASH },
          { name: "m", text: `module m { prefix m; import iana-crypt-hash { prefix h; } ${body} }` },
        ],
      );
    // long waits on [top, b], which ends with the grouping's [b], withheld after it.
    const down = policyOf(`
      container top { leaf long { type leafref { path "/m:top/m:b"; } } }
      grouping g { leaf b { type leafref { path "../d"; } } leaf d { type h:crypt-hash; } }`);
    expect(down.chainMatch(["top", "long"])).toEqual({ kind: "crypt-hash" });
    // short waits on [b], the end of top's [top, b], withheld after it.
    const up = policyOf(`
      grouping early { leaf short { type leafref { path "../../b"; } } }
      container top { leaf b { type leafref { path "../d"; } } leaf d { type h:crypt-hash; } }`);
    expect(up.chainMatch(["x", "short"])).toEqual({ kind: "crypt-hash" });
  });

  test("a relative path above a grouping's root keeps the names it can, so it matches by their end", () => {
    const grouped = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; import iana-crypt-hash { prefix h; }
            grouping g { leaf ref { type leafref { path "../../secret/hash"; } } }
            container secret { leaf hash { type h:crypt-hash; } }
          }`,
        },
        { name: "iana-crypt-hash", text: CRYPT_HASH },
      ],
    );
    expect(grouped.chainMatch(["anywhere", "ref"])).toEqual({ kind: "crypt-hash" });
  });

  test("a type holding more leafrefs than Studio follows is withheld as unresolved", () => {
    const members = Array.from({ length: 33 }, () => 'type leafref { path "../plain"; }').join(" ");
    const wide = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; container c { leaf plain { type string; } leaf u { type union { ${members} } } } }`,
        },
      ],
    );
    expect(wide.chainMatch(["c", "u"])).toEqual({ kind: "unresolved leafref" });
    const narrow = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; container c { leaf plain { type string; } leaf u { type union { ${members.slice(0, members.lastIndexOf(" type"))} } } } }`,
        },
      ],
    );
    expect(narrow.chainMatch(["c", "u"])).toBeUndefined();
  });
});

describe("which kind a chain meets", () => {
  test("of two withheld chains an element's chain ends with, the one withheld first names it", () => {
    const both = NetconfWithheldPolicy.compile(
      [],
      [
        { name: "iana-crypt-hash", text: CRYPT_HASH },
        {
          name: "m",
          text: `module m { prefix m; import iana-crypt-hash { prefix h; } import ietf-netconf-acm { prefix n; }
            container x { leaf y { type string; n:default-deny-all; } }
            grouping g { leaf y { type h:crypt-hash; } }
          }`,
        },
      ],
    );
    expect(both.chainMatch(["x", "y"])).toEqual({ kind: "nacm:default-deny-all" });
    expect(both.chainMatch(["z", "y"])).toEqual({ kind: "crypt-hash" });
  });
});

describe("typedefs", () => {
  test("a typedef deriving from a crypt-hash typedef declared after it is a password hash", () => {
    const later = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; import iana-crypt-hash { prefix h; }
            typedef first { type m:second; }
            typedef second { type h:crypt-hash; }
            container c { leaf p { type first; } }
          }`,
        },
      ],
    );
    expect(later.chainMatch(["c", "p"])).toEqual({ kind: "crypt-hash" });
  });

  test("a typedef that derives from itself, or deeper than Studio follows, refuses the whole policy", () => {
    expect(() =>
      NetconfWithheldPolicy.compile(
        [],
        [{ name: "m", text: "module m { prefix m; typedef a { type b; } typedef b { type a; } leaf l { type a; } }" }],
      ),
    ).toThrow(YangTextError);
    // `length` typedefs, each deriving from the next, the last from string.
    const chain = (length: number): string =>
      `module m { prefix m; ${Array.from({ length: length - 1 }, (_, index) => `typedef t${index} { type t${index + 1}; }`).join(" ")} typedef t${length - 1} { type string; } leaf l { type t0; } }`;
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "m", text: chain(MAX_TYPE_DERIVATION) }])).not.toThrow();
    expect(() => NetconfWithheldPolicy.compile([], [{ name: "m", text: chain(MAX_TYPE_DERIVATION + 1) }])).toThrow(
      YangTextError,
    );
  });
});

describe("the check's total budget", () => {
  const text = (name: string): NetconfModuleText => ({
    name,
    text: `module ${name} { prefix p; leaf l { type string; } }`,
  });
  // Each of these texts holds four statements: module, prefix, leaf and type.
  const one = text("a").text.length;

  test("texts, bytes and statements: exactly the budget is compiled, one more is refused", () => {
    const budget = { maxTexts: 2, maxBytes: 2 * one, maxStatements: 8 };
    expect(() => NetconfWithheldPolicy.compile([], [text("a"), text("b")], budget)).not.toThrow();
    expect(() => NetconfWithheldPolicy.compile([], [text("a"), text("b"), text("c")], budget)).toThrow(
      new NetconfSchemaBudgetError("the device serves more than 2 module texts"),
    );
    expect(() => NetconfWithheldPolicy.compile([], [text("a"), text("bb")], { ...budget, maxBytes: 2 * one })).toThrow(
      new NetconfSchemaBudgetError(`the device's module texts hold more than ${2 * one} bytes`),
    );
    expect(() => NetconfWithheldPolicy.compile([], [text("a"), text("b")], { ...budget, maxStatements: 7 })).toThrow(
      new NetconfSchemaBudgetError("the device's module texts hold more than 7 statements"),
    );
    expect(NETCONF_SCHEMA_BUDGET).toEqual({ maxTexts: 1_000, maxBytes: 16 * 1024 * 1024, maxStatements: 400_000 });
  });

  test("a chain deeper than any answer nests is kept by its end, so it still withholds", () => {
    const deep = Array.from({ length: 70 }, (_, index) => `n${index}`);
    const policy = NetconfWithheldPolicy.compile(
      [],
      [
        {
          name: "m",
          text: `module m { prefix m; import ietf-netconf-acm { prefix n; } augment "/${deep.join("/")}" { leaf s { type string; n:default-deny-all; } } }`,
        },
      ],
    );
    expect(policy.chainMatch([...deep.slice(-63), "s"])).toEqual({ kind: "nacm:default-deny-all" });
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
      "leafref that may point at a withheld node",
      "unresolved leafref",
    ]) {
      expect(NETCONF_WITHHELD_TEXT).toContain(identifier);
    }
  });
});
