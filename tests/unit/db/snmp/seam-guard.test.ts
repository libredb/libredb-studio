/**
 * The read-only seam guard (SN-S1, first layer).
 *
 * WHY A SYNTACTIC GUARD AND NOT A RUNTIME CHECK. `net-snmp` 3.29.2 is one CommonJS module that
 * also holds an agent, a notification sender and receiver, a proxy forwarder and an AgentX
 * subagent, so there is no import that leaves the write paths out: `set`, `trap`, `inform`,
 * `createAgent`, `createReceiver` and `createSubagent` are all one property access away from
 * anything that has the module. The promise that the provider cannot write therefore rests on
 * facts about the SOURCE, and those are what this guard keeps true as the provider grows.
 *
 * WHAT IT ENFORCES, and the measurement behind each:
 *   1. The library is imported by exactly one file. Anything else has to go through that file.
 *   2. Only the allowlisted members are reached on it. The list is RFC 3411 section 2.8's Read
 *      Class plus session lifecycle, and nothing that sends.
 *   3. No file assigns to a socket's `send`. Measured on 13 October 2026: a guard patched onto
 *      a socket's own `send` also sees the runtime's send queue re-entering that method when a
 *      datagram is sent before the bind completes, so a patch inspects the same datagram twice
 *      and the shapes it sees depend on a race. The guard belongs in the `dgramModule` facade,
 *      above the queue. A patch is a defect, not a style preference.
 *   4. No type assertion is applied to the library's own value, because an assertion is how a
 *      member outside the allowlist becomes reachable without naming it.
 *
 * WHAT IT DOES NOT CATCH, stated rather than chased: reflection (`Reflect.get`, computed member
 * names built at run time), a library object that leaves the one file untyped and is used
 * elsewhere, and `eval`. The live check's before and after comparison of the agent's own write
 * counter is the second check, and it is what sees the effect of code written to get past this.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The package this guard is about. */
const LIBRARY = "net-snmp";

/** Everything the provider may reach on the library or on a session it returns. */
const ALLOWED_MEMBERS: ReadonlySet<string> = new Set([
  // Construction. v2c and v3 only; there is no v1 session anywhere.
  "createSession",
  "createV3Session",
  // The Read Class (RFC 3411 section 2.8).
  "get",
  "getNext",
  "getBulk",
  // Lifecycle and error handling, which carry no PDU of their own.
  "cancelRequests",
  "close",
  "on",
  // Enumerations read for their values, never called.
  "Version2c",
  "Version3",
  "SecurityLevel",
  "AuthProtocols",
  "PrivProtocols",
  "ObjectType",
  "PduType",
]);

/**
 * Write paths reached on the LIBRARY itself.
 *
 * These are checked by name and by receiver, never by name alone. An earlier version of this
 * guard matched the names only, and it reported four findings in this provider's own source:
 * every `Map.prototype.set` call. A name without a receiver is the same mistake the valve
 * documents, checking what a thing is called instead of what it is attached to, and here it
 * produces noise rather than a hole. The receiver has to be the library or a session taken
 * from it.
 */
const LIBRARY_WRITE_MEMBERS: ReadonlySet<string> = new Set([
  "trap",
  "inform",
  "createAgent",
  "createReceiver",
  "createSubagent",
  "createModuleStore",
  "Session",
  "Receiver",
  "Agent",
  "AgentXSubagent",
  "Version1",
]);

/** Write paths reached on a SESSION the library returned. */
const SESSION_WRITE_MEMBERS: ReadonlySet<string> = new Set(["set", "trap", "inform"]);

/** The constructors whose result is a session, so its members are the library's too. */
const SESSION_FACTORIES: ReadonlySet<string> = new Set(["createSession", "createV3Session"]);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

interface SourceInput {
  readonly path: string;
  readonly text: string;
}

/** True when a module specifier reaches the library, by name or by a path into it. */
function reachesLibrary(spec: string): boolean {
  return spec === LIBRARY || spec.startsWith(`${LIBRARY}/`) || /(^|\/)node_modules\/net-snmp(\/|$)/.test(spec);
}

function auditSeam(sources: readonly SourceInput[], importerPath: string): Finding[] {
  const findings: Finding[] = [];
  const importers: string[] = [];

  for (const source of sources) {
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const add = (node: ts.Node, rule: string, detail: string) =>
      findings.push({ file: source.path, line: lineOf(node), rule, detail });

    let importsLibraryHere = false;
    /** Identifiers holding a session, collected from `const x = snmp.createSession(...)`. */
    const sessions = new Set<string>();
    const collectSessions = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        SESSION_FACTORIES.has(node.initializer.expression.name.text)
      ) {
        sessions.add(node.name.text);
      }
      ts.forEachChild(node, collectSessions);
    };
    collectSessions(file);

    const visit = (node: ts.Node): void => {
      // 1. Who imports the library.
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        reachesLibrary(node.moduleSpecifier.text)
      ) {
        importsLibraryHere = true;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && reachesLibrary(arg.text)) importsLibraryHere = true;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && reachesLibrary(arg.text)) importsLibraryHere = true;
      }

      // 2. Members reached on the library, or on a session it returned.
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        const onLibrary = isOnLibraryRoot(node);
        const onSession = ts.isIdentifier(node.expression) && sessions.has(node.expression.text);
        if (onLibrary && LIBRARY_WRITE_MEMBERS.has(name)) {
          add(
            node,
            "write-member",
            `\`${name}\` is a write or listener path on the library and is never reachable from this provider`,
          );
        } else if (onSession && SESSION_WRITE_MEMBERS.has(name)) {
          add(node, "write-member", `\`${name}\` writes through a session and is never reachable from this provider`);
        } else if ((onLibrary || onSession) && !ALLOWED_MEMBERS.has(name)) {
          add(node, "member-not-allowlisted", `\`${name}\` is not in the allowlist`);
        }
      }
      // A computed member hides the name from this guard, so it is refused outright.
      if (ts.isElementAccessExpression(node) && importsLibraryHere) {
        add(node, "computed-member", "a computed member on the library hides its name from this guard");
      }

      // 3. No patch on a socket's own send: a provider may use the socket, never rewrite it.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left;
        if (ts.isPropertyAccessExpression(left) && left.name.text === "send") {
          add(
            node,
            "send-patch",
            "assigning to `send` puts the guard inside the runtime's send queue; the guard belongs in the dgramModule facade",
          );
        }
      }

      // 4. No assertion on the library's value.
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && importsLibraryHere) {
        const text = node.expression.getText(file);
        if (/\b(snmp|netSnmp|library)\b/.test(text)) {
          add(
            node,
            "assertion-on-library",
            "a type assertion on the library's value reaches members this guard cannot name",
          );
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(file);

    if (importsLibraryHere) importers.push(source.path);
  }

  if (importers.length === 0) {
    findings.push({
      file: importerPath,
      line: 0,
      rule: "no-importer",
      detail: `no file imports ${LIBRARY}; the guard has nothing to guard`,
    });
  } else if (importers.length > 1 || importers[0] !== importerPath) {
    findings.push({
      file: importers.join(", "),
      line: 0,
      rule: "one-importer",
      detail: `${LIBRARY} must be imported by ${importerPath} alone, but it is imported by ${importers.length} file(s)`,
    });
  }

  return findings;
}

/** True when the access hangs off a plain identifier, which is how the library is held. */
function isOnLibraryRoot(node: ts.PropertyAccessExpression): boolean {
  return ts.isIdentifier(node.expression) && /^(snmp|netSnmp|library)$/.test(node.expression.text);
}

// --- the guard's own proof ---------------------------------------------------------------
//
// A guard that finds nothing is only evidence once it has been shown to find something. Each
// case below plants one defect the rules forbid and expects the matching rule to fire; the
// clean source and this provider's real source then have to come back silent.

const CLEAN = `
import snmp from "net-snmp";
export function open(host: string) {
  const session = snmp.createV3Session(host, user, { version: snmp.Version3 });
  session.on("error", onError);
  session.get(["1.3.6.1.2.1.1.1.0"], cb);
  session.getNext(["1.3.6.1.2.1.1"], cb);
  session.getBulk(["1.3.6.1.2.1.2"], 0, 10, cb);
  session.cancelRequests(err);
  session.close();
}
`;

const planted: ReadonlyArray<readonly [string, ReadonlyArray<{ path: string; text: string }>, string]> = [
  ["a Set through a session", [{ path: "client.ts", text: `${CLEAN}\nsession.set([vb], cb);\n` }], "write-member"],
  ["a trap sender", [{ path: "client.ts", text: `${CLEAN}\nsnmp.trap(oid);\n` }], "write-member"],
  [
    "an agent being constructed",
    [{ path: "client.ts", text: `${CLEAN}\nconst a = snmp.createAgent(opts, cb);\n` }],
    "write-member",
  ],
  ["SNMPv1", [{ path: "client.ts", text: `${CLEAN}\nconst v = snmp.Version1;\n` }], "write-member"],
  [
    "a second importer",
    [
      { path: "client.ts", text: CLEAN },
      { path: "read.ts", text: 'import snmp from "net-snmp";\nexport const x = 1;\n' },
    ],
    "one-importer",
  ],
  [
    "an importer using require",
    [
      { path: "client.ts", text: CLEAN },
      { path: "objects.ts", text: 'const snmp = require("net-snmp");\nexport const y = 2;\n' },
    ],
    "one-importer",
  ],
  ["a patch on a socket's send", [{ path: "client.ts", text: `${CLEAN}\nsocket.send = patched;\n` }], "send-patch"],
  [
    "a member outside the allowlist",
    [{ path: "client.ts", text: `${CLEAN}\nsnmp.somethingElse(1);\n` }],
    "member-not-allowlisted",
  ],
  ["a computed member", [{ path: "client.ts", text: `${CLEAN}\nconst f = snmp[name];\n` }], "computed-member"],
  [
    "an assertion on the library",
    [{ path: "client.ts", text: `${CLEAN}\nconst s = snmp as any;\n` }],
    "assertion-on-library",
  ],
  ["nothing importing it at all", [{ path: "read.ts", text: "export const z = 3;\n" }], "no-importer"],
];

describe("the guard fires on every defect it claims to catch", () => {
  for (const [what, sources, rule] of planted) {
    test(what, () => {
      expect(auditSeam(sources, "client.ts").map((f) => f.rule)).toContain(rule);
    });
  }
});

describe("the guard is silent where it should be", () => {
  test("on a clean provider", () => {
    expect(
      auditSeam(
        [
          { path: "client.ts", text: CLEAN },
          { path: "read.ts", text: "export const ok = 1;\n" },
        ],
        "client.ts",
      ),
    ).toEqual([]);
  });

  test("on this provider's own source, which has no client file yet", () => {
    const dir = join(import.meta.dir, "../../../../src/lib/db/providers/network/snmp");
    // `provider-surface.ts` was in this list until its two live pieces moved into `objects.ts`
    // and the draft was deleted. `objects.ts` and `v3-message.ts` take its place here.
    const files = ["ber.ts", "valve.ts", "transport.ts", "table.ts", "values.ts", "objects.ts", "v3-message.ts"];
    const sources = files.map((name) => ({ path: name, text: readFileSync(join(dir, name), "utf8") }));
    const findings = auditSeam(sources, "client.ts");
    // The only finding allowed is that `client.ts` does not exist yet: the library is not a
    // dependency until the build phase, so nothing imports it. Anything else is a real defect.
    expect(findings.filter((f) => f.rule !== "no-importer")).toEqual([]);
    expect(findings.map((f) => f.rule)).toContain("no-importer");
  });
});
