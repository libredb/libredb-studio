import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { DEFAULT_DATABASE_ID } from "@/lib/db/providers/document/firestore/constants";
import {
  FIRESTORE_CREDENTIAL_SENTENCES,
  resolveFirestoreAuth,
} from "@/lib/db/providers/document/firestore/credential-policy";
import { type ErrorContext, mapGoogleError, readGoogleError } from "@/lib/db/providers/document/firestore/errors";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import type { FirestoreRequest } from "@/lib/db/providers/document/firestore/requests";
import { createFirestoreClient } from "@/lib/db/providers/document/firestore/transport";
import { FIXED_NOW, fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";

const target: FirestoreTarget = { projectId: "demo-p", databaseId: DEFAULT_DATABASE_ID };
const signal = new AbortController().signal;
const context: ErrorContext = { phase: "listing", credential: "emulator", target, surface: "tree" };
const listing: FirestoreRequest = { kind: "listCollectionIds", parent: [], pageSize: 1 };
const query: FirestoreRequest = {
  kind: "runQuery",
  parent: [],
  body: { structuredQuery: { from: [{ collectionId: "users" }], limit: 100 } },
};
const keyFile = JSON.stringify({
  type: "service_account",
  client_email: "reader@demo-p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n",
});
// The shared egress guard reads this flag from process.env itself, as tests/unit/db/http/egress-policy-transport.test.ts sets it.
const BLOCK_FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalBlockFlag = process.env[BLOCK_FLAG];

afterEach(() => {
  if (originalBlockFlag === undefined) delete process.env[BLOCK_FLAG];
  else process.env[BLOCK_FLAG] = originalBlockFlag;
});

describe("firestore emulator lane", () => {
  test("no credential is read, no token or metadata lane exists, and every request says Bearer owner over HTTP", async () => {
    const seams = fakeSeams({
      env: {
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIRESTORE_SERVER_CREDENTIALS: "true",
        GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json",
        GCE_METADATA_HOST: "meta.internal",
      },
      files: { "/srv/key.json": keyFile },
      answer: () => jsonAnswer({ collectionIds: ["users"] }),
    });
    const client = createFirestoreClient(target, resolveFirestoreAuth({ password: "", managed: true }, seams), seams);
    expect(client.mode).toBe("emulator");
    await client.send(listing, { signal, context });
    seams.setClock(FIXED_NOW + 2 * 3_600_000);
    await client.send(query, { signal, context });
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["emulator"]);
    expect(seams.lanes[0].options).toEqual({
      origin: { scheme: "http", host: "127.0.0.1", port: 8080 },
      tls: null,
      maxSockets: 8,
      headers: { authorization: "Bearer owner" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    expect(seams.lanes[0].requests).toHaveLength(2);
    for (const request of seams.lanes[0].requests) {
      expect(request.url).toStartWith("http://127.0.0.1:8080/v1/projects/demo-p/databases/");
    }
    expect(new Set(seams.envReads)).toEqual(new Set(["FIRESTORE_EMULATOR_HOST"]));
    expect(seams.fileReads).toEqual([]);
  });

  test("an IPv6 emulator address is dialled in brackets", async () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "[::1]:9000" }, answer: () => jsonAnswer({}) });
    const client = createFirestoreClient(target, resolveFirestoreAuth({ password: "" }, seams), seams);
    await client.send(listing, { signal, context });
    expect(seams.lanes[0].options.origin).toEqual({ scheme: "http", host: "[::1]", port: 9000 });
    expect(seams.lanes[0].requests[0].url).toStartWith("http://[::1]:9000/v1/projects/demo-p/");
  });

  test("a pasted credential never reaches a lane: the policy refuses it first", () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" } });
    expect(() => resolveFirestoreAuth({ password: keyFile, managed: false }, seams)).toThrow(
      FIRESTORE_CREDENTIAL_SENTENCES.emulatorCredential("127.0.0.1:8080"),
    );
    expect(seams.lanes).toEqual([]);
  });

  test("an emulator error answer is mapped with the emulator context", async () => {
    const text = JSON.stringify({
      error: { code: 400, status: "FAILED_PRECONDITION", message: "Database mode not set to Firestore Mode." },
    });
    const seams = fakeSeams({
      env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      answer: () => ({ status: 400, contentType: "application/json", retryAfter: null, text }),
    });
    const client = createFirestoreClient(target, resolveFirestoreAuth({ password: "" }, seams), seams);
    const error = (await client.send(listing, { signal, context }).catch((caught: unknown) => caught)) as Error;
    const expected = mapGoogleError(readGoogleError(400, text), context);
    expect(error.constructor).toBe(expected.constructor);
    expect(error.message).toBe(expected.message);
  });

  test("DB_HTTP_BLOCK_PRIVATE_HOSTS=true refuses a loopback emulator when the client is built, before any lane", () => {
    process.env[BLOCK_FLAG] = "true";
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, answer: () => jsonAnswer({}) });
    const auth = resolveFirestoreAuth({ password: "" }, seams);
    let caught: unknown;
    try {
      createFirestoreClient(target, auth, seams);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseConfigError);
    expect((caught as Error).message).toContain("DB_HTTP_BLOCK_PRIVATE_HOSTS");
    expect(seams.lanes).toEqual([]);
  });

  test("close closes the one emulator lane", async () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, answer: () => jsonAnswer({}) });
    const client = createFirestoreClient(target, resolveFirestoreAuth({ password: "" }, seams), seams);
    await client.send(listing, { signal, context });
    client.close();
    expect(seams.lanes.map((lane) => [lane.lane, lane.closed])).toEqual([["emulator", 1]]);
  });
});
