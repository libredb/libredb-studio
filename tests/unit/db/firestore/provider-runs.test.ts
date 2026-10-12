/**
 * The Firestore provider's runs (spec 3.4, 8.1, 8.2): a statement under the run registry, so `cancelQuery` stops it by
 * its id and the run answers the registry's cancel; the transport's deadline, the query timeout plus 5 seconds, over
 * the connect probe, every statement and every surface read, fired through the fake seams and answered with
 * the timeout sentence; and the emulator's Explain sentence on the console path.
 */
import { describe, expect, test } from "bun:test";
import { QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore";
import { SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import { ERROR_SENTENCES } from "@/lib/db/providers/document/firestore/errors";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeFirestoreSeams, fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";
import {
  fireRequestDeadline,
  firestoreConnection,
  googleServer,
  HANG,
  PROVIDER_DOCS,
  requestsOf,
  type WireHandler,
  wire,
} from "../../../helpers/firestore-provider";

const TIME = "2026-10-12T00:00:00.000000Z";
const STATEMENT = 'db.collection("users").limit(1)';
const DEADLINE_MS = 1000 + 5000;
const TIMEOUT = `${ERROR_SENTENCES.timeout}.`;

function seamsOf(handler: WireHandler, env: Record<string, string> = {}): FakeFirestoreSeams {
  return fakeSeams({ env, answer: wire(handler) });
}

async function until(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- polls one turn at a time until the condition holds.
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

async function connected(
  seams: FakeFirestoreSeams,
  overrides: Partial<DatabaseConnection> = {},
): Promise<FirestoreProvider> {
  const firestore = new FirestoreProvider(firestoreConnection(overrides), { queryTimeout: 1000 }, seams);
  await firestore.connect();
  return firestore;
}

describe("cancel", () => {
  test("cancelQuery stops a running statement by its id and the run answers the cancel", async () => {
    const seams = seamsOf(googleServer(undefined, HANG));
    const firestore = await connected(seams);
    const running = firestore.query(STATEMENT, undefined, "q-1");
    await until(() => requestsOf(seams).length === 2);
    expect(await firestore.cancelQuery("q-1")).toBe(true);
    await expect(running).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(running).rejects.toThrow("The query was cancelled.");
    expect(await firestore.cancelQuery("q-1")).toBe(false);
  });

  test("an id that names no run answers false", async () => {
    const firestore = await connected(seamsOf(googleServer(undefined, () => jsonAnswer([]))));
    expect(await firestore.cancelQuery("nothing-running")).toBe(false);
  });

  test("a finished run frees its id", async () => {
    const answer = [
      { document: { name: `${PROVIDER_DOCS}/users/a`, createTime: TIME }, readTime: TIME },
      { readTime: TIME, done: true },
    ];
    const firestore = await connected(seamsOf(googleServer(undefined, () => jsonAnswer(answer))));
    expect((await firestore.query(STATEMENT, undefined, "q-2")).rowCount).toBe(1);
    expect((await firestore.query(STATEMENT, undefined, "q-2")).rowCount).toBe(1);
  });
});

describe("the transport's deadline", () => {
  test("every request is bounded by the query timeout plus 5 seconds", async () => {
    const seams = seamsOf(googleServer(undefined, () => jsonAnswer({ collectionIds: ["users"] })));
    const firestore = await connected(seams);
    await firestore.countObjects([]);
    expect(seams.deadlines.filter((deadline) => deadline.ms === DEADLINE_MS)).toHaveLength(requestsOf(seams).length);
  });

  test("a statement past the deadline answers the provider's TimeoutError", async () => {
    const seams = seamsOf(googleServer(undefined, HANG));
    const firestore = await connected(seams);
    const running = firestore.query(STATEMENT, undefined, "q-3");
    await until(() => requestsOf(seams).length === 2);
    fireRequestDeadline(seams, DEADLINE_MS);
    await expect(running).rejects.toBeInstanceOf(TimeoutError);
    await expect(running).rejects.toThrow(TIMEOUT);
    // The run ended, so its id is free again.
    expect(await firestore.cancelQuery("q-3")).toBe(false);
  });

  test("the Keys panel and the Source tab answer the deadline too", async () => {
    const seams = seamsOf(googleServer(undefined, HANG));
    const firestore = await connected(seams);
    const page = firestore.scanKeysPage({ cursor: "0", count: 10, level: true });
    await until(() => requestsOf(seams).length === 2);
    fireRequestDeadline(seams, DEADLINE_MS);
    await expect(page).rejects.toBeInstanceOf(TimeoutError);
    const source = firestore.readObjectSource(["users/alice"], "document");
    await until(() => requestsOf(seams).length === 3);
    fireRequestDeadline(seams, DEADLINE_MS);
    await expect(source).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a connect probe past the deadline fails, closes its transport and keeps no session", async () => {
    const seams = seamsOf(HANG);
    const firestore = new FirestoreProvider(firestoreConnection(), { queryTimeout: 1000 }, seams);
    const connecting = firestore.connect();
    await until(() => requestsOf(seams).length === 1);
    fireRequestDeadline(seams, DEADLINE_MS);
    await expect(connecting).rejects.toBeInstanceOf(TimeoutError);
    await expect(connecting).rejects.toThrow(TIMEOUT);
    expect(firestore.isConnected()).toBe(false);
    expect(seams.lanesOf("api").map((lane) => lane.closed)).toEqual([1]);
  });

  test("a failure that is neither the deadline nor a cancel stays the transport's", async () => {
    const denied: WireHandler = () =>
      jsonAnswer({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, 403);
    const firestore = await connected(seamsOf(googleServer(undefined, denied)));
    const failure = await firestore.query(STATEMENT, undefined, "q-4").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(TimeoutError);
    expect(failure).not.toBeInstanceOf(QueryCancelledError);
    expect((failure as Error).message).toContain("denied");
  });
});

describe("the emulator on the console path", () => {
  test(".explain() answers the emulator sentence before any query request (spec 4.3)", async () => {
    // The connect probe's id page answers an object; a query request, if one were sent, would answer a stream.
    const emulator: WireHandler = (request) =>
      request.path.endsWith(":runQuery") ? jsonAnswer([{ readTime: TIME }]) : jsonAnswer({});
    const seams = seamsOf(emulator, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" });
    const firestore = await connected(seams, { password: "" });
    const before = requestsOf(seams).length;
    const explain = firestore.query('db.collection("users").explain()');
    await expect(explain).rejects.toBeInstanceOf(QueryError);
    await expect(explain).rejects.toThrow(SENTENCES.emulatorExplain);
    expect(requestsOf(seams)).toHaveLength(before);
    expect(requestsOf(seams).every((request) => request.lane === "emulator")).toBe(true);
  });
});
