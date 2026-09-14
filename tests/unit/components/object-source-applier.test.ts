import { afterEach, describe, expect, test } from "bun:test";
import {
  httpSourceApplier,
  ObjectEditRequestError,
  type ObjectSourceApplier,
} from "@/components/object-source/source-applier";
import {
  httpSourceApplier as barrelApplier,
  ObjectEditRequestError as BarrelRequestError,
  type ObjectSourceApplier as BarrelApplier,
} from "@/components/object-source";
import type { ObjectEditPlan, ObjectEditRequest, ObjectEditStep } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The applier seam: what this application's own routes are sent, and what comes back (#789
 * Phase 3, discussion #778).
 *
 * The two methods are asserted on their REQUEST and on their FAILURE, and never on a narrowed
 * answer, because narrowing is the caller's: `build` and `apply` both answer `unknown` and the
 * dialog narrows with the predicates in `src/lib/api/object-edit-wire.ts`. A seam that narrowed
 * here would be a second copy of those predicates on the standalone path and no copy at all on
 * the embedded one, where a HOST supplies the applier and this module never runs.
 */

const STEP: ObjectEditStep = {
  text: "CREATE OR REPLACE FUNCTION app.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
  language: "sql",
  segments: [{ from: "user", start: 0, end: 79 }],
};

const PLAN: ObjectEditPlan = {
  planVersion: 1,
  planId: "plan-one",
  issuedAt: "2026-09-14T09:00:00.000Z",
  connectionFingerprint: "fingerprint-one",
  type: "postgres",
  path: ["app", "f()"],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: { medium: "statement", steps: [STEP] },
  session: [{ mode: "pinned", setting: "search_path", value: '"app", pg_catalog' }],
  revision: { check: "guarded", token: "md5:9f1", basis: "md5(prosrc)", scope: "server" },
  consequences: [],
};

const REQUEST: ObjectEditRequest = {
  path: ["app", "f()"],
  kind: "function",
  partId: "definition",
  text: "CREATE OR REPLACE FUNCTION app.f() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;",
};

const connection: DatabaseConnection = {
  id: "pg-1",
  name: "conn",
  type: "postgres",
  createdAt: new Date("2026-01-01"),
};

const BUILT = { built: true, plan: PLAN, preimage: { text: "SELECT 1", language: "sql" }, planToken: "jws.one" };

interface Seen {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

let seen: Seen | undefined;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  seen = undefined;
});

/** One recorder for both methods, so a request assertion reads the same way on either. */
function answering(response: () => Response): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = {
      url: String(url),
      method: init.method,
      contentType: new Headers(init.headers).get("Content-Type") ?? undefined,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return response();
  }) as unknown as typeof fetch;
}

function json(body: unknown, status: number): () => Response {
  return () => new Response(JSON.stringify(body), { status });
}

describe("httpSourceApplier.build", () => {
  test("posts the connection payload beside the address, the part and the reader's text", async () => {
    answering(json(BUILT, 200));

    const answered = await httpSourceApplier.build(connection, REQUEST);

    expect(seen?.url.endsWith("/api/db/objects/edit-plan")).toBe(true);
    expect(seen?.method).toBe("POST");
    expect(seen?.contentType).toBe("application/json");
    expect(seen?.body).toEqual({
      connection: { ...connection, createdAt: connection.createdAt.toISOString() },
      path: ["app", "f()"],
      kind: "function",
      partId: "definition",
      text: REQUEST.text,
    });
    // Returned UNTOUCHED and unnarrowed: the caller is what decides whether this is a shape it
    // can act on, with `isObjectEditBuildResponseShape`.
    expect(answered).toEqual(BUILT);
  });

  test("sends a managed connection by its seed id and never its credentials", async () => {
    answering(json(BUILT, 200));

    await httpSourceApplier.build({ ...connection, managed: true, seedId: "demo", password: "hunter2" }, REQUEST);

    expect(seen?.body.connectionId).toBe("seed:demo");
    expect(seen?.body.connection).toBeUndefined();
  });

  test("raises the route's own sentence and its CODE when the build is refused", async () => {
    answering(json({ error: "That plan is no longer valid.", code: "EDIT_PLAN_INVALID" }, 400));

    const raised = await httpSourceApplier.build(connection, REQUEST).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ObjectEditRequestError);
    expect((raised as ObjectEditRequestError).message).toBe("That plan is no longer valid.");
    expect((raised as ObjectEditRequestError).code).toBe("EDIT_PLAN_INVALID");
  });

  test("stands the status in for a sentence when the route answered no body at all", async () => {
    answering(() => new Response("<html>502</html>", { status: 502 }));

    const raised = await httpSourceApplier.build(connection, REQUEST).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ObjectEditRequestError);
    expect((raised as ObjectEditRequestError).message).toBe("The apply preview could not be built: HTTP 502.");
    expect((raised as ObjectEditRequestError).code).toBeUndefined();
  });
});

describe("httpSourceApplier.apply", () => {
  test("posts the plan, the token and the acknowledged classes beside the connection payload", async () => {
    answering(json({ outcome: "applied", sentence: "Done.", duration: 4 }, 200));

    const answered = await httpSourceApplier.apply(connection, PLAN, "jws.one", ["destroys-overloads"]);

    expect(seen?.url.endsWith("/api/db/objects/edit-apply")).toBe(true);
    expect(seen?.method).toBe("POST");
    expect(seen?.body).toEqual({
      connection: { ...connection, createdAt: connection.createdAt.toISOString() },
      plan: JSON.parse(JSON.stringify(PLAN)) as Record<string, unknown>,
      planToken: "jws.one",
      acknowledged: ["destroys-overloads"],
    });
    expect(answered).toEqual({ outcome: "applied", sentence: "Done.", duration: 4 });
  });

  test("sends no token at all when there is none, which is every HOST-built plan", async () => {
    // `planToken` is `string | undefined` because a HOST has no key: the binding between a host's
    // preview and a host's apply is the host's own. The client never reads the token and never
    // constructs one, it posts back the string it was given, and an absent one is absent on the
    // wire rather than a `null` the route would have to classify.
    answering(json({ outcome: "applied", sentence: "Done.", duration: 4 }, 200));

    await httpSourceApplier.apply(connection, PLAN, undefined, []);

    expect(Object.hasOwn(seen?.body ?? {}, "planToken")).toBe(false);
    expect(seen?.body.acknowledged).toEqual([]);
  });

  test("raises the route's own sentence and its CODE when the apply is refused", async () => {
    answering(json({ error: "This plan has expired.", code: "EDIT_PLAN_INVALID" }, 409));

    const raised = await httpSourceApplier.apply(connection, PLAN, "jws.one", []).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ObjectEditRequestError);
    expect((raised as ObjectEditRequestError).message).toBe("This plan has expired.");
    expect((raised as ObjectEditRequestError).code).toBe("EDIT_PLAN_INVALID");
  });

  test("stands the status in for a sentence when the route answered no body at all", async () => {
    answering(() => new Response("", { status: 504 }));

    const raised = await httpSourceApplier.apply(connection, PLAN, "jws.one", []).catch((error: unknown) => error);

    expect((raised as ObjectEditRequestError).message).toBe("The apply failed: HTTP 504.");
  });

  test("carries no code when the route's failure body has none, and never a non-string one", async () => {
    // The population is an INTERMEDIARY and not our own route: a proxy or a gateway can answer
    // JSON of its own shape on a 502, and `{ error: { message } }` is a common one. A message
    // built from a non-string would print `[object Object]` in the dialog's failure region, and a
    // `code` that is not a string would be rendered as data beside it.
    answering(json({ error: { message: "upstream refused" }, code: 502 }, 502));

    const raised = await httpSourceApplier.apply(connection, PLAN, "jws.one", []).catch((error: unknown) => error);

    expect((raised as ObjectEditRequestError).message).toBe("The apply failed: HTTP 502.");
    expect((raised as ObjectEditRequestError).code).toBeUndefined();
  });

  test("a 200 answering a REFUSAL is returned untouched, because a refusal is not an HTTP error", async () => {
    // The route answers 200 for every outcome the provider produced, including the ones that
    // changed nothing: `refused`, `conflict` and `interrupted` are answers and not failures, and a
    // seam that threw on them would take the sentence the engine wrote away from the dialog.
    const refusal = { outcome: "refused", refusal: { refused: "privilege", sentence: "must be owner", code: "42501" } };
    answering(json(refusal, 200));

    expect(await httpSourceApplier.apply(connection, PLAN, "jws.one", [])).toEqual(refusal);
  });
});

describe("the seam's own type", () => {
  test("`httpSourceApplier` satisfies `ObjectSourceApplier`, which is what a HOST implements", () => {
    // The type is the shell's contract: the embedded adapter builds its own applier from the
    // host's `objectEditor`, so this module is one implementation of it and not the definition of
    // the seam.
    const applier: ObjectSourceApplier = httpSourceApplier;
    expect(typeof applier.build).toBe("function");
    expect(typeof applier.apply).toBe("function");
  });

  test("all three names reach a consumer OUTSIDE this folder through the barrel", () => {
    /*
     * The barrel is the shells' import surface and both of them name these three: the standalone
     * shell builds its `onApply` from `httpSourceApplier`, the embedded adapter declares its
     * host-built applier as an `ObjectSourceApplier`, and both read `ObjectEditRequestError`'s
     * `code` to tell an expired plan apart from a failure.
     *
     * Asserted here rather than left to those shells, because they land in later waves of this
     * phase and until they do NOTHING outside this folder imports the three names: `knip` names an
     * unreferenced re-export by line, measured on this exact commit, and the file's own docblock
     * says a re-export earns its place only by having a consumer outside the directory. This test
     * is that consumer, and it is the only thing standing between a dropped barrel line and two
     * shells that stop compiling in a wave nobody is looking at this file.
     */
    const applier: BarrelApplier = barrelApplier;
    expect(applier).toBe(httpSourceApplier);
    expect(BarrelRequestError).toBe(ObjectEditRequestError);
  });
});
