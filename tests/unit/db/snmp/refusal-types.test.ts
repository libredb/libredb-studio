/**
 * Every refusal this provider raises has to REACH the user, and that is a question of type.
 *
 * Measured on 2026-10-13 against `origin/main`: a failed count becomes `{ unavailable:
 * error.message }` only for a `QueryError` or a `TimeoutError`
 * (`src/lib/db/providers/platform/kubernetes/objects.ts:348`), and `isQueryError`
 * (`src/lib/db/errors.ts`) is the same test. A refusal thrown as a plain `Error` passes as
 * an unexpected failure and its sentence is never shown.
 *
 * That matters more here than almost anywhere, because this provider's refusals ARE their
 * sentences: a write command refused by name, a request stopped before the socket so the user
 * can still be told what to ask instead, an SMI bound with its clause, a name explained by which
 * kind of absence it is. The first version of these modules threw plain Errors, so none of those
 * sentences would have arrived. This file holds the correction in place.
 *
 * The assertions are about TYPE and not about wording. A message may be improved; the type may
 * not change without this file failing.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { BerError } from "@/lib/db/providers/network/snmp/ber";
import { ConnectionRefused, checkConnection } from "@/lib/db/providers/network/snmp/connection-options";
import { WalkNotForward, assertMovesForward } from "@/lib/db/providers/network/snmp/objects";
import { UnresolvedName } from "@/lib/db/providers/network/snmp/read";
import { StatementError, parseStatement } from "@/lib/db/providers/network/snmp/statement";
import { IndexDecodeError, decodeIndex } from "@/lib/db/providers/network/snmp/table";
import { EgressRefusal } from "@/lib/db/providers/network/snmp/transport";
import { ValveRefusal, inspectOutbound } from "@/lib/db/providers/network/snmp/valve";

describe("every refusal class is a QueryError, so its sentence is shown", () => {
  const classes = [
    ["BerError", new BerError("x")],
    ["ValveRefusal", new ValveRefusal("x")],
    ["IndexDecodeError", new IndexDecodeError("x")],
    ["EgressRefusal", new EgressRefusal("x")],
    ["StatementError", new StatementError("x")],
    ["ConnectionRefused", new ConnectionRefused("x")],
    ["WalkNotForward", new WalkNotForward("x")],
    ["UnresolvedName", new UnresolvedName("x")],
  ] as const;

  for (const [name, instance] of classes) {
    test(`${name} is a QueryError`, () => {
      expect(instance).toBeInstanceOf(QueryError);
    });
    test(`${name} is also still itself, despite the base rewriting prototypes`, () => {
      expect(instance.constructor.name).toBe(name);
    });
  }
});

describe("the refusals thrown on real paths carry the type too", () => {
  test("a write command", () => {
    expect(() => parseStatement(["set", "sysName.0"])).toThrow(QueryError);
  });
  test("an object identifier past the SMI's bound", () => {
    expect(() => parseStatement(["get", "1.3.4294967296"])).toThrow(QueryError);
  });
  test("a datagram the valve cannot read", () => {
    expect(() => inspectOutbound(new Uint8Array([0x04, 0x02, 0x01, 0x02]))).toThrow(QueryError);
  });
  test("an index that does not fit its shape", () => {
    expect(() => decodeIndex([3, 97], [{ kind: "lengthPrefixedText" }])).toThrow(QueryError);
  });
  test("a connection that reaches past this machine in clear", () => {
    expect(() => checkConnection({ host: "10.0.0.1", port: 161, version: "v2c", community: "public" })).toThrow(
      QueryError,
    );
  });
  test("a walk that is not moving forward", () => {
    expect(() => assertMovesForward([1, 2], [1, 1])).toThrow(QueryError);
  });
});

describe("the specific type survives, so a caller can still tell them apart", () => {
  test("a statement refusal is not mistaken for a valve refusal", () => {
    try {
      parseStatement(["set", "x"]);
    } catch (error) {
      expect(error).toBeInstanceOf(StatementError);
      expect(error).not.toBeInstanceOf(ValveRefusal);
    }
  });
});
