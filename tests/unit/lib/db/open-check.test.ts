/**
 * The one ordered open check (src/lib/db/open-check.ts): every session of every engine is checked by its engine's
 * record before anything is read from the host, keyed or opened, a legacy record and a package record told apart only
 * by their offers and grants, each refusal with the sentence, the class and the `provider` its source answered before
 * the check was one, and not-sent.
 *
 * Records are read by data: the legacy record is a record of `LEGACY_ENGINES` that enforces no read-only mode and
 * takes an SSH tunnel, and the package record is composed in memory (tests/helpers/package-catalog.ts). A crafted
 * record is a frozen spread with one member changed, so the answer can only be the record's. Every fabricated secret is
 * generated at run time.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { forgetEgressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import {
  assertClaimsGranted,
  assertOpenable,
  assertOwnerPoolHonoured,
  assertProviderEnabled,
  assertReadOnlyHonoured,
} from "@/lib/db/open-check";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import * as typeId from "@/lib/db/type-id";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import { TUNNEL_FAR_END } from "@/lib/types";
import { admittedFor, admittedManifest } from "../../../helpers/package-catalog";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");

/** A legacy record that enforces no read-only mode and takes an SSH tunnel, chosen by its data. */
const LEGACY = [...LEGACY_ENGINES.values()].find(
  (engine) =>
    !engine.grants.readOnlyEnforced &&
    engine.grants.sshTunnel === null &&
    engine.grants.deniedFileAccessRefusal === null &&
    engine.grants.ungrantedRefusals === null,
) as EngineRecord;

/** Another legacy engine's id, for a `LIBREDB_ENABLED_PROVIDERS` that leaves `LEGACY` out. */
const OTHER_LEGACY_ID = [...LEGACY_ENGINES.keys()].find((id) => id !== LEGACY.id) as string;

/** A package record, composed in memory: it offers no legacy provider, tunnel or host file. */
const PACKAGE = composeServerCatalog(
  [admittedFor("acme-open-check", admittedManifest("acmeopencheck"))],
  [],
  STUDIO_GRANT_REGISTER,
).engines.get("acmeopencheck") as EngineRecord;

/** The two records every row runs against. */
const SOURCES: readonly (readonly ["legacy" | "package", EngineRecord])[] = [
  ["legacy", LEGACY],
  ["package", PACKAGE],
];

/** `engine` with `change` applied: a crafted, frozen record. */
function crafted(engine: EngineRecord, change: Partial<Record<keyof EngineRecord, unknown>>): EngineRecord {
  return Object.freeze({ ...engine, ...change }) as EngineRecord;
}

/** `engine` with its grants changed by `grants`. */
function granted(engine: EngineRecord, grants: Record<string, unknown>): EngineRecord {
  return crafted(engine, { grants: Object.freeze({ ...engine.grants, ...grants }) });
}

/** `engine` with its offers changed by `offers`. */
function offering(engine: EngineRecord, offers: Record<string, unknown>): EngineRecord {
  return crafted(engine, { offers: Object.freeze({ ...engine.offers, ...offers }) });
}

/** A connection of `engine` that passes every check, with `fields`. */
function connectionOf(engine: EngineRecord, fields: Record<string | symbol, unknown> = {}): EngineConnection {
  return { id: `open-${randomUUID()}`, name: "open", type: engine.id, ...fields } as unknown as EngineConnection;
}

/** A tunnel that is on and well formed. */
function tunnelOn(): Record<string, unknown> {
  return {
    enabled: true,
    host: "bastion.internal",
    port: 22,
    username: "jump",
    authMethod: "password",
    password: randomUUID(),
  };
}

/** The error `run` throws, or a failure when it throws nothing. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

/** What a refusal answers: its class, sentence, provider and outcome. */
function answerOf(error: unknown): { kind: string; message: string; provider: unknown; outcome: string } {
  const refusal = error as DatabaseConfigError;
  return {
    kind: refusal.constructor.name,
    message: refusal.message,
    provider: refusal.provider,
    outcome: errorOutcome(error),
  };
}

/** What `assertOpenable` refuses `connection` of `engine` with, under `execution`, to connect. */
function openRefusal(
  engine: EngineRecord,
  connection: EngineConnection,
  execution: Record<string, unknown> = {},
  purpose: "connect" | "declarations" = "connect",
): ReturnType<typeof answerOf> {
  return answerOf(thrownBy(() => assertOpenable(engine, connection, execution, purpose)));
}

/** The answer a refusal of `engine` with `message` gives: the legacy record's type as its provider, none for a package. */
function refusal(engine: EngineRecord, message: string): ReturnType<typeof answerOf> {
  return {
    kind: "DatabaseConfigError",
    message,
    provider: engine.offers.legacyProvider ? engine.id : undefined,
    outcome: "not-sent",
  };
}

/** The same answer with no provider: the plain-data refusals name none for either source. */
function unnamed(message: string): ReturnType<typeof answerOf> {
  return { kind: "DatabaseConfigError", message, provider: undefined, outcome: "not-sent" };
}

class NotPlain {
  readonly id = "not-plain";
}

const NO_TUNNEL =
  "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.";
const NOT_OPENED =
  "This connection's SSH tunnel is on and no tunnel was opened for it, so no provider was built and nothing was sent: build the provider inside withOneShotTunnel, or get it from getOrCreateProvider, which open the tunnel first.";
const TUNNEL_TEXT = "The connection's sshTunnel.host and sshTunnel.username must be text; nothing was sent.";

afterEach(() => {
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  forgetEgressDecision();
});

describe("the one ordered open check", () => {
  test("each check reads the record and answers today's sentence for each source", () => {
    for (const [source, engine] of SOURCES) {
      const id = engine.id;
      // 1. A set LIBREDB_ENABLED_PROVIDERS that leaves the record's id out; one that names it passes this check.
      process.env.LIBREDB_ENABLED_PROVIDERS = OTHER_LEGACY_ID;
      expect(openRefusal(engine, connectionOf(engine))).toEqual(
        refusal(engine, `The ${id} provider is not available in this distribution of LibreDB Studio.`),
      );
      // The list names only legacy ids, so it can name only the legacy record's.
      if (source === "legacy") {
        process.env.LIBREDB_ENABLED_PROVIDERS = id;
        expect(() => assertOpenable(engine, connectionOf(engine), {}, "connect")).not.toThrow();
      }
      delete process.env.LIBREDB_ENABLED_PROVIDERS;

      // 2. A read-only mode that is not a boolean, and one the record does not enforce; a record that enforces it passes.
      expect(openRefusal(engine, connectionOf(engine, { readOnly: "yes" }))).toEqual(
        refusal(engine, "readOnly must be true or false."),
      );
      expect(openRefusal(engine, connectionOf(engine, { readOnly: true }))).toEqual(
        refusal(
          engine,
          source === "legacy"
            ? `readOnly: true is refused for ${id}: its provider does not enforce a read-only mode, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`
            : `readOnly: true is refused for ${id}: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
        ),
      );
      expect(() =>
        assertOpenable(
          granted(engine, { readOnlyEnforced: true }),
          connectionOf(engine, { readOnly: true }),
          {},
          "connect",
        ),
      ).not.toThrow();

      // 3. A claim the record's grants leave refused.
      expect(
        openRefusal(granted(engine, { ungrantedRefusals: "Refused by its grants." }), connectionOf(engine)),
      ).toEqual(refusal(engine, "Refused by its grants."));

      // 4. and 5. A connection, then an execution context, that is not plain data.
      expect(openRefusal(engine, new NotPlain() as unknown as EngineConnection)).toEqual(
        unnamed("A connection must be a plain object of data fields; no provider was built."),
      );
      expect(openRefusal(engine, connectionOf(engine), Object.create({ allowExternalFileAccess: true }))).toEqual(
        unnamed("The execution context must be a plain object of data fields; no provider was built."),
      );

      // 6. An owner without a whole pool size.
      expect(openRefusal(engine, connectionOf(engine), { owner: "o" })).toEqual(
        refusal(
          engine,
          `ownerPoolMax must be a whole number from 1 when an owner is given: it is the most connections the owner's ${source === "legacy" ? "provider" : "session"} may open.`,
        ),
      );

      // 7. A denied file-access posture where the record's grant refuses one; a record with no such grant passes.
      const denied = { allowExternalFileAccess: false };
      expect(
        openRefusal(
          granted(engine, { deniedFileAccessRefusal: "Denied by its grants." }),
          connectionOf(engine),
          denied,
        ),
      ).toEqual(refusal(engine, "Denied by its grants."));
      expect(() =>
        assertOpenable(granted(engine, { deniedFileAccessRefusal: null }), connectionOf(engine), denied, "connect"),
      ).not.toThrow();

      // 9. A host path field the grants name, set, is refused only for a record that offers no host file.
      const hostFiles = granted(engine, { hostPathFields: Object.freeze(["clientCertificatePath"]) });
      const withPath = connectionOf(engine, { clientCertificatePath: "/etc/client.pem" });
      if (source === "legacy") {
        expect(() => assertOpenable(hostFiles, withPath, {}, "connect")).not.toThrow();
      } else {
        expect(openRefusal(hostFiles, withPath)).toEqual(
          refusal(
            engine,
            "This LibreDB Studio admits no host file for an engine of a provider package, so it does not hand on clientCertificatePath.",
          ),
        );
      }

      // 10. The process's egress decision: an invalid setting is refused, as the decision refuses it.
      process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "maybe";
      forgetEgressDecision();
      const egress = answerOf(thrownBy(() => assertOpenable(engine, connectionOf(engine), {}, "connect")));
      delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
      forgetEgressDecision();
      expect(egress.kind).toBe("DatabaseConfigError");
      expect(egress.message).toContain("DB_HTTP_BLOCK_PRIVATE_HOSTS");
      expect(egress.outcome).toBe("not-sent");

      // 12. A field the record refuses by name, set.
      const refusing = crafted(engine, {
        connection: Object.freeze({
          ...engine.connection,
          refused: Object.freeze({ database: "This engine takes no database." }),
        }),
      });
      expect(openRefusal(refusing, connectionOf(engine, { database: "d" }))).toEqual(
        refusal(engine, "This engine takes no database."),
      );
      for (const value of [undefined, null, ""]) {
        expect(() => assertOpenable(refusing, connectionOf(engine, { database: value }), {}, "connect")).not.toThrow();
      }

      // 13. A required secret the record's field rules declare, left blank.
      const secret = crafted(engine, {
        fieldRules: Object.freeze({
          connectionFields: ["password"],
          fieldRules: { password: { required: "Enter the password. Nothing was sent." } },
        }),
      });
      expect(openRefusal(secret, connectionOf(engine, { password: " " }))).toEqual(
        refusal(engine, "Enter the password. Nothing was sent."),
      );
      expect(() =>
        assertOpenable(secret, connectionOf(engine, { password: randomUUID() }), {}, "connect"),
      ).not.toThrow();
    }
  });

  test("a tunnel that is on is refused for a record that offers no tunnel with NO_TUNNEL's sentence, and opened by core for one that offers it", () => {
    const on = (engine: EngineRecord, fields: Record<string | symbol, unknown> = {}) =>
      connectionOf(engine, { host: "db.internal", port: 5432, sshTunnel: tunnelOn(), ...fields });
    const farEnd = { [TUNNEL_FAR_END]: { remoteHost: "db.internal", remotePort: 5432 } };

    // A record that offers a tunnel: core decides it, and an opened tunnel is required to connect.
    expect(openRefusal(LEGACY, on(LEGACY))).toEqual(refusal(LEGACY, NOT_OPENED));
    expect(() => assertOpenable(LEGACY, on(LEGACY, farEnd), {}, "connect")).not.toThrow();
    expect(() => assertOpenable(LEGACY, on(LEGACY), {}, "declarations")).not.toThrow();
    expect(openRefusal(granted(LEGACY, { sshTunnel: "This engine takes no tunnel." }), on(LEGACY))).toEqual(
      refusal(LEGACY, "This engine takes no tunnel."),
    );
    expect(openRefusal(LEGACY, on(LEGACY, { sshTunnel: { ...tunnelOn(), enabled: "yes" } }))).toEqual(
      refusal(LEGACY, "The connection's sshTunnel.enabled must be true or false; nothing was sent."),
    );

    // A record that offers none: a tunnel that is on is refused with NO_TUNNEL, one that is off must frame its route.
    expect(openRefusal(PACKAGE, on(PACKAGE))).toEqual(refusal(PACKAGE, NO_TUNNEL));
    expect(openRefusal(PACKAGE, on(PACKAGE, farEnd))).toEqual(refusal(PACKAGE, NO_TUNNEL));
    expect(openRefusal(PACKAGE, connectionOf(PACKAGE, { sshTunnel: { enabled: false } }))).toEqual(
      refusal(PACKAGE, TUNNEL_TEXT),
    );
    expect(() =>
      assertOpenable(PACKAGE, connectionOf(PACKAGE, { sshTunnel: { ...tunnelOn(), enabled: false } }), {}, "connect"),
    ).not.toThrow();

    // The crafted cross cases: the offer decides, never the source. A package record offering a tunnel, with a grant
    // that takes one, is decided by core as a legacy one is.
    const tunnelledPackage = granted(offering(PACKAGE, { sshTunnel: true }), { sshTunnel: null });
    expect(openRefusal(tunnelledPackage, on(PACKAGE))).toEqual(refusal(PACKAGE, NOT_OPENED));
    expect(() => assertOpenable(tunnelledPackage, on(PACKAGE, farEnd), {}, "connect")).not.toThrow();
    const untunnelledLegacy = offering(LEGACY, { sshTunnel: false });
    expect(openRefusal(untunnelledLegacy, on(LEGACY, farEnd))).toEqual(refusal(LEGACY, NO_TUNNEL));
  });

  test("a check never reads typeIdRow", () => {
    const spy = spyOn(typeId, "typeIdRow");
    try {
      for (const engine of LEGACY_ENGINES.values()) {
        // Every field the engine's rules declare required holds a value, so the required secret check passes.
        const required = Object.fromEntries(
          engine.fieldRules.connectionFields
            .filter((field) => engine.fieldRules.fieldRules?.[field]?.required !== undefined)
            .map((field) => [field, randomUUID()]),
        );
        expect(() => assertOpenable(engine, connectionOf(engine, required), {}, "connect")).not.toThrow();
        const tunnelled = connectionOf(engine, {
          ...required,
          host: "db.internal",
          port: 5432,
          sshTunnel: tunnelOn(),
          [TUNNEL_FAR_END]: { remoteHost: "db.internal", remotePort: 5432 },
        });
        // An engine whose grant refuses a tunnel is refused with the grant's sentence; every other one passes.
        const grant = engine.grants.sshTunnel;
        if (grant === null) expect(() => assertOpenable(engine, tunnelled, {}, "connect")).not.toThrow();
        else expect(() => assertOpenable(engine, tunnelled, {}, "connect")).toThrow(grant);
      }
      expect(() => assertOpenable(PACKAGE, connectionOf(PACKAGE), {}, "connect")).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    // The module imports no type id reader and no legacy adapter module, and reads no record's source.
    const file = path.join(ROOT, "src/lib/db/open-check.ts");
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const specifiers = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    expect(specifiers.filter((specifier) => /type-id|legacy-adapter/.test(specifier))).toEqual([]);
    expect(text).not.toMatch(/\.source\b/);
  });

  test("the checks run in one order: a connection two checks refuse answers the earlier one", () => {
    // Read-only, then the tunnel.
    const malformedTunnel = { sshTunnel: { ...tunnelOn(), enabled: "yes" } };
    expect(openRefusal(LEGACY, connectionOf(LEGACY, { readOnly: "yes", ...malformedTunnel }))).toEqual(
      refusal(LEGACY, "readOnly must be true or false."),
    );
    // The connection's plain data, then the owner's pool.
    for (const [, engine] of SOURCES) {
      expect(openRefusal(engine, new NotPlain() as unknown as EngineConnection, { owner: "o" })).toEqual(
        unnamed("A connection must be a plain object of data fields; no provider was built."),
      );
    }
    // A host path field, then a refused field, for a record that offers no host file.
    const both = crafted(granted(PACKAGE, { hostPathFields: Object.freeze(["clientCertificatePath"]) }), {
      connection: Object.freeze({ ...PACKAGE.connection, refused: Object.freeze({ database: "No database." }) }),
    });
    expect(openRefusal(both, connectionOf(PACKAGE, { clientCertificatePath: "/etc/c.pem", database: "d" }))).toEqual(
      refusal(
        PACKAGE,
        "This LibreDB Studio admits no host file for an engine of a provider package, so it does not hand on clientCertificatePath.",
      ),
    );
    // A refused field, then a required secret.
    const refusedAndSecret = crafted(LEGACY, {
      connection: Object.freeze({ ...LEGACY.connection, refused: Object.freeze({ database: "No database." }) }),
      fieldRules: Object.freeze({
        connectionFields: ["password"],
        fieldRules: { password: { required: "Enter the password. Nothing was sent." } },
      }),
    });
    expect(openRefusal(refusedAndSecret, connectionOf(LEGACY, { database: "d", password: "" }))).toEqual(
      refusal(LEGACY, "No database."),
    );
  });

  test("a connection built only to read its declarations is not refused for a refused field, a blank required secret or a tunnel core did not open", () => {
    const engine = crafted(LEGACY, {
      connection: Object.freeze({ ...LEGACY.connection, refused: Object.freeze({ database: "No database." }) }),
      fieldRules: Object.freeze({
        connectionFields: ["password"],
        fieldRules: { password: { required: "Enter the password. Nothing was sent." } },
      }),
    });
    const connection = connectionOf(LEGACY, {
      database: "d",
      password: "",
      host: "db.internal",
      port: 5432,
      sshTunnel: tunnelOn(),
    });
    expect(() => assertOpenable(engine, connection, {}, "declarations")).not.toThrow();
    expect(openRefusal(engine, connection)).toEqual(refusal(LEGACY, NOT_OPENED));
  });

  test("the steps the factory runs ahead of its key mark nothing, and assertOpenable marks every refusal not-sent", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = OTHER_LEGACY_ID;
    const steps: unknown[] = [
      thrownBy(() => assertProviderEnabled(LEGACY)),
      thrownBy(() => assertReadOnlyHonoured(LEGACY, connectionOf(LEGACY, { readOnly: "yes" }))),
      thrownBy(() => assertClaimsGranted(granted(LEGACY, { ungrantedRefusals: "Refused." }))),
      thrownBy(() => assertOwnerPoolHonoured(LEGACY, { owner: "o" })),
    ];
    for (const error of steps) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(errorOutcome(error)).toBe("unknown");
    }
    expect(openRefusal(LEGACY, connectionOf(LEGACY)).outcome).toBe("not-sent");
  });
});

describe("a connection that sets a field its engine refuses is refused, to connect, with the sentence its record states (FND-2 slice 6c)", () => {
  const RABBITMQ = LEGACY_ENGINES.get("rabbitmq") as EngineRecord;
  const POSTGRES = LEGACY_ENGINES.get("postgres") as EngineRecord;
  const refused: Readonly<Record<string, string>> = RABBITMQ.connection.refused;

  /** The sentence the open check refuses `fields` of `engine` with, to connect, or undefined when it opens. */
  function refusedWith(engine: EngineRecord, fields: Record<string, unknown>): string | undefined {
    try {
      assertOpenable(engine, connectionOf(engine, fields), {}, "connect");
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  test("the first set field in the row's order answers its sentence", () => {
    expect(refusedWith(RABBITMQ, { tlsServerName: "a", database: "b" })).toBe(refused.database);
    expect(refusedWith(RABBITMQ, { tlsServerName: "a", namespaces: "b" })).toBe(refused.namespaces);
    expect(refusedWith(RABBITMQ, { tlsServerName: "a" })).toBe(refused.tlsServerName);
  });

  test("undefined, null and empty text are not set", () => {
    for (const value of [undefined, null, ""]) {
      expect(refusedWith(RABBITMQ, { database: value, namespaces: value, tlsServerName: value })).toBeUndefined();
    }
    expect(refusedWith(RABBITMQ, {})).toBeUndefined();
  });

  test("whitespace, zero, false and an object are set", () => {
    for (const value of [" ", 0, false, {}]) expect(refusedWith(RABBITMQ, { database: value })).toBe(refused.database);
  });

  test("an engine whose row is empty answers undefined, whatever the connection holds", () => {
    expect(Object.keys(POSTGRES.connection.refused)).toEqual([]);
    expect(refusedWith(POSTGRES, { user: "u", database: "d", apiKeyId: "k" })).toBeUndefined();
  });
});
