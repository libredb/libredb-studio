import { describe, expect, test } from "bun:test";
import { TransportError } from "@/lib/db/http/node-transport";
import { DEFAULT_DATABASE_ID, LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { type ErrorContext, mapTransportFailure } from "@/lib/db/providers/document/firestore/errors";
import type { GoogleCredentials } from "@/lib/db/providers/document/firestore/google-credentials";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import type { LaneKind } from "@/lib/db/providers/document/firestore/seams";
import {
  createFirestoreClient,
  FIRESTORE_TRANSPORT_SENTENCES as S,
} from "@/lib/db/providers/document/firestore/transport";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import { type FirestoreAnswer, fakeSeams, held, jsonAnswer, tokenAnswer } from "../../../helpers/firestore-seams";

const target: FirestoreTarget = { projectId: "demo-p", databaseId: DEFAULT_DATABASE_ID };
const context: ErrorContext = { phase: "statement", credential: "authorized_user", target, surface: "console" };
const TOKEN = "ya29.a0AfB_byC-test-token_value.123";
const pasted: GoogleCredentials = { type: "access_token", token: TOKEN };
const user: GoogleCredentials = {
  type: "authorized_user",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "user-secret-value",
  refreshToken: "1//refresh-token-value",
};
const never = () => new Promise<never>(() => {});

async function settle(): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- each turn must wait for the one before it.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error("expected a rejection");
  return error;
}

function expectMapped(error: Error, thrown: unknown) {
  const expected = mapTransportFailure(thrown, context);
  expect(error.constructor).toBe(expected.constructor);
  expect(error.message).toBe(expected.message);
}

describe("firestore transport deadline", () => {
  test("every request runs under the query timeout plus 5 seconds, the default timeout when none is given", async () => {
    const seams = fakeSeams({ answer: () => jsonAnswer({}) });
    await createFirestoreClient(target, { mode: "google", credentials: pasted }, seams, {
      queryTimeoutMs: 30_000,
    }).send({ kind: "database" }, { signal: new AbortController().signal, context });
    await createFirestoreClient(target, { mode: "google", credentials: pasted }, seams).send(
      { kind: "database" },
      { signal: new AbortController().signal, context },
    );
    expect(seams.deadlines.map((deadline) => deadline.ms)).toEqual([
      30_000 + LIMITS.deadlineGraceMs,
      DEFAULT_QUERY_TIMEOUT + LIMITS.deadlineGraceMs,
    ]);
  });

  test("a deadline that fires mid-request is mapped as the transport's timeout", async () => {
    const seams = fakeSeams({ answer: never });
    const client = createFirestoreClient(target, { mode: "google", credentials: pasted }, seams, {
      queryTimeoutMs: 1000,
    });
    const caller = new AbortController();
    const pending = failureOf(client.send({ kind: "database" }, { signal: caller.signal, context }));
    await settle();
    const request = seams.lanes[0].requests[0];
    expect(request.signal).not.toBe(caller.signal);
    seams.fireDeadline(0);
    const error = await pending;
    const thrown = seams.lanes[0].failures[0];
    expect(thrown).toMatchObject({ kind: "timeout" });
    expectMapped(error, thrown);
  });

  test("a deadline that fires while the token is being fetched fails this call and leaves the refresh running", async () => {
    const token = held<ReturnType<typeof tokenAnswer>>();
    const answer: FirestoreAnswer = (_request, lane: LaneKind) =>
      lane === "token" ? token.promise : jsonAnswer({ ok: true });
    const seams = fakeSeams({ answer });
    const client = createFirestoreClient(target, { mode: "google", credentials: user }, seams);
    const first = failureOf(client.send({ kind: "database" }, { signal: new AbortController().signal, context }));
    await settle();
    expect(seams.deadlines.map((deadline) => deadline.ms)).toEqual([
      DEFAULT_QUERY_TIMEOUT + LIMITS.deadlineGraceMs,
      30_000,
    ]);
    seams.fireDeadline(0);
    const error = await first;
    expectMapped(error, new TransportError("timeout", "The request did not finish within its time limit"));
    expect(seams.lanesOf("token")[0].requests[0].signal.aborted).toBe(false);
    token.resolve(tokenAnswer("t1"));
    expect(await client.send({ kind: "database" }, { signal: new AbortController().signal, context })).toEqual({
      ok: true,
    });
    expect(seams.lanesOf("token")[0].requests).toHaveLength(1);
  });
});

describe("firestore transport cancel", () => {
  test("a caller's cancel aborts its request, is mapped as aborted, and leaves the lane serving", async () => {
    let calls = 0;
    const seams = fakeSeams({ answer: () => (++calls === 1 ? never() : jsonAnswer({ n: calls })) });
    const client = createFirestoreClient(target, { mode: "google", credentials: pasted }, seams);
    const caller = new AbortController();
    const pending = failureOf(client.send({ kind: "database" }, { signal: caller.signal, context }));
    await settle();
    caller.abort();
    const error = await pending;
    const thrown = seams.lanes[0].failures[0];
    expect(thrown).toMatchObject({ kind: "aborted" });
    expectMapped(error, thrown);
    expect(await client.send({ kind: "database" }, { signal: new AbortController().signal, context })).toEqual({
      n: 2,
    });
    expect(seams.lanes).toHaveLength(1);
    expect(seams.lanes[0].closed).toBe(0);
  });

  test("a signal already aborted fails the request as aborted", async () => {
    const seams = fakeSeams({ answer: () => jsonAnswer({}) });
    const client = createFirestoreClient(target, { mode: "google", credentials: pasted }, seams);
    const error = await failureOf(client.send({ kind: "database" }, { signal: AbortSignal.abort(), context }));
    expectMapped(error, seams.lanes[0].failures[0]);
    expect(seams.lanes[0].failures[0]).toMatchObject({ kind: "aborted" });
  });
});

describe("firestore transport close", () => {
  test("close fails the request in flight as aborted and closes every lane once", async () => {
    const seams = fakeSeams({ answer: (_request, lane) => (lane === "token" ? tokenAnswer("t1") : never()) });
    const client = createFirestoreClient(target, { mode: "google", credentials: user }, seams);
    const pending = failureOf(client.send({ kind: "database" }, { signal: new AbortController().signal, context }));
    await settle();
    client.close();
    client.close();
    const error = await pending;
    const thrown = seams.lanesOf("api")[0].failures[0];
    expect(thrown).toMatchObject({ kind: "aborted" });
    expectMapped(error, thrown);
    expect(seams.lanes.map((lane) => [lane.lane, lane.closed])).toEqual([
      ["token", 1],
      ["api", 1],
    ]);
  });

  test("close while the token is being fetched fails the call and aborts the refresh", async () => {
    const seams = fakeSeams({ answer: never });
    const client = createFirestoreClient(target, { mode: "google", credentials: user }, seams);
    const pending = failureOf(client.send({ kind: "database" }, { signal: new AbortController().signal, context }));
    await settle();
    client.close();
    expectMapped(await pending, new TransportError("aborted", "The request was cancelled"));
    expect(seams.lanesOf("token")[0].requests[0].signal.aborted).toBe(true);
    expect(seams.lanesOf("api")).toEqual([]);
  });

  test("close landing while a pasted token resolves opens no lane", async () => {
    const seams = fakeSeams({ answer: () => jsonAnswer({}) });
    const client = createFirestoreClient(target, { mode: "google", credentials: pasted }, seams);
    const pending = failureOf(client.send({ kind: "database" }, { signal: new AbortController().signal, context }));
    client.close();
    expectMapped(await pending, new TransportError("aborted", S.closed));
    expect(seams.lanes).toEqual([]);
  });

  test("a send after close is refused without a lane, a token or a deadline", async () => {
    const seams = fakeSeams({ answer: () => jsonAnswer({}) });
    const client = createFirestoreClient(target, { mode: "google", credentials: user }, seams);
    client.close();
    const error = await failureOf(client.send({ kind: "database" }, { signal: new AbortController().signal, context }));
    expectMapped(error, new TransportError("aborted", S.closed));
    expect(seams.lanes).toEqual([]);
    expect(seams.deadlines).toEqual([]);
  });
});
