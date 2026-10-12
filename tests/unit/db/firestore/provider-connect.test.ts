/**
 * The Firestore provider's declarations and lifecycle (spec 3.3, 3.4, 4.3, 4.4): capabilities with no Explain on an
 * emulator server, labels, prepareQuery leaving the text alone, validation, the database-resource probe and its
 * Datastore-mode, disabled-access and unreadable refusals, the emulator's one id page with Bearer owner and its
 * warnings, a pasted token's warning, the query timeout handed to the transport, the credential's forms on every
 * context, disconnect, and the members that answer with no request. The real transport runs over the fake seams.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  FIRESTORE_PROVIDER_SENTENCES as S,
  FirestoreProvider,
  sessionBase,
} from "@/lib/db/providers/document/firestore";
import { validateFirestoreConnection } from "@/lib/db/providers/document/firestore/connection-options";
import { ERROR_SENTENCES } from "@/lib/db/providers/document/firestore/errors";
import { FIRESTORE_KEY_SCAN } from "@/lib/db/providers/document/firestore/key-scan";
import { FIRESTORE_LABELS } from "@/lib/db/providers/document/firestore/labels";
import { FIRESTORE_OBJECT_KINDS } from "@/lib/db/providers/document/firestore/objects";
import { buildRequest } from "@/lib/db/providers/document/firestore/requests";
import type { DatabaseProvider } from "@/lib/db/types";
import { secretForms } from "@/lib/db/utils/server-text";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeFirestoreSeams, fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";
import {
  DATABASE,
  firestoreConnection,
  googleServer,
  isProbe,
  PASTED_TOKEN,
  PROVIDER_DOCS,
  PROVIDER_TARGET,
  requestsOf,
  type WireHandler,
  wire,
} from "../../../helpers/firestore-provider";

const EMULATOR = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
const TIME = "2026-10-12T00:00:00.000000Z";

function seamsOf(handler: WireHandler, env: Record<string, string> = {}): FakeFirestoreSeams {
  return fakeSeams({ env, answer: wire(handler) });
}

function provider(seams: FakeFirestoreSeams, overrides: Partial<DatabaseConnection> = {}): FirestoreProvider {
  return new FirestoreProvider(firestoreConnection(overrides), { queryTimeout: 1000 }, seams);
}

describe("declarations", () => {
  test("capabilities against Google, every member written out", () => {
    const seams = seamsOf(googleServer());
    const capabilities = provider(seams).getCapabilities();
    expect(capabilities).toEqual({
      queryLanguage: "json",
      queryDialect: "firestore",
      supportsExplain: true,
      explainFormat: "firestore-explain",
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      containerLevels: [],
      objectKinds: FIRESTORE_OBJECT_KINDS,
      keyScan: FIRESTORE_KEY_SCAN,
      schemaRefreshPattern: "(?!)",
    });
    expect(new RegExp(capabilities.schemaRefreshPattern).test('db.collection("users").limit(1)')).toBe(false);
    expect(seams.lanes).toHaveLength(0);
  });

  test("an emulator server declares no Explain", () => {
    const capabilities = provider(seamsOf(googleServer(), EMULATOR), { password: "" }).getCapabilities();
    expect(capabilities.supportsExplain).toBe(false);
    expect("explainFormat" in capabilities).toBe(false);
  });

  test("an emulator host of any other shape is refused at construction", () => {
    const seams = seamsOf(googleServer(), { FIRESTORE_EMULATOR_HOST: "http://127.0.0.1:8080" });
    expect(() => provider(seams)).toThrow(DatabaseConfigError);
  });

  test("labels are a copy of the provider's labels", () => {
    const labels = provider(seamsOf(googleServer())).getLabels();
    expect(labels).toEqual(FIRESTORE_LABELS);
    expect(labels).not.toBe(FIRESTORE_LABELS);
  });

  test("prepareQuery leaves the statement untouched and never pages, whatever the options", () => {
    const text = 'db.collection("users").where("age", ">", 3)';
    // Called through the interface, as the query route does, so the options the override ignores still type-check.
    const typed: DatabaseProvider = provider(seamsOf(googleServer()));
    expect(typed.prepareQuery(text, { limit: 5, offset: 200 })).toEqual({
      query: text,
      wasLimited: false,
      limit: 100,
      offset: 0,
    });
  });

  test("validation refuses the connection's field rules before any transport exists", async () => {
    const seams = seamsOf(googleServer());
    const bad = firestoreConnection({ database: "" });
    const refused = provider(seams, { database: "" });
    await expect(refused.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(refused.connect()).rejects.toThrow(validateFirestoreConnection(bad).join(" "));
    expect(seams.lanes).toHaveLength(0);
    expect(() => refused.validate()).toThrow(DatabaseConfigError);
  });
});

describe("connect against Google", () => {
  test("one database-resource probe, no token lane for a pasted token, and the token's warning", async () => {
    const seams = seamsOf(googleServer());
    const firestore = provider(seams);
    await firestore.connect();
    expect(firestore.isConnected()).toBe(true);
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["api"]);
    const requests = requestsOf(seams);
    expect(requests).toHaveLength(1);
    expect(isProbe(requests[0])).toBe(true);
    expect(requests[0].authorization).toBe(`Bearer ${PASTED_TOKEN}`);
    expect(firestore.connectWarnings()).toEqual([{ message: S.pastedToken }]);
    expect(seams.fileReads).toEqual([]);
  });

  test("the connection's query timeout reaches the transport's deadline (spec 8.2)", async () => {
    const seams = seamsOf(googleServer());
    await provider(seams).connect();
    expect(seams.deadlines.map((deadline) => deadline.ms)).toContain(1000 + 5000);
  });

  test("a Datastore-mode database is refused with its own sentence and the transport closed", async () => {
    const seams = seamsOf(googleServer({ ...DATABASE, type: "DATASTORE_MODE" }));
    const firestore = provider(seams);
    await expect(firestore.connect()).rejects.toThrow(`${ERROR_SENTENCES.datastoreMode}.`);
    expect(firestore.isConnected()).toBe(false);
    expect(seams.lanesOf("api").map((lane) => lane.closed)).toEqual([1]);
  });

  test("a database with Firestore API access off is refused with its own sentence", async () => {
    const seams = seamsOf(googleServer({ ...DATABASE, firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED" }));
    const connecting = provider(seams).connect();
    await expect(connecting).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(connecting).rejects.toThrow(`${ERROR_SENTENCES.dataAccessDisabled}.`);
  });

  test("a probe answer it cannot read is refused", async () => {
    await expect(provider(seamsOf(googleServer([1]))).connect()).rejects.toThrow(`${ERROR_SENTENCES.probeUnreadable}.`);
  });

  test("the overview names the edition and sends no request", async () => {
    const seams = seamsOf(googleServer());
    const firestore = provider(seams);
    await firestore.connect();
    expect((await firestore.getOverview()).version).toBe("Cloud Firestore, Standard edition");
    const plain = provider(seamsOf(googleServer({ ...DATABASE, databaseEdition: undefined })));
    await plain.connect();
    expect((await plain.getOverview()).version).toBe("Cloud Firestore");
    expect(requestsOf(seams)).toHaveLength(1);
  });
});

describe("connect against the emulator", () => {
  const env = { ...EMULATOR, FIRESTORE_SERVER_CREDENTIALS: "true", GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" };

  test("one id page with Bearer owner, no credential read, and the emulator's warnings", async () => {
    const seams = seamsOf(() => jsonAnswer({}), env);
    const firestore = provider(seams, { password: "" });
    await firestore.connect();
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["emulator"]);
    expect(seams.fileReads).toEqual([]);
    const requests = requestsOf(seams);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", body: { pageSize: 1 } });
    expect(
      requests[0].path.endsWith(
        buildRequest(PROVIDER_TARGET, { kind: "listCollectionIds", parent: [], pageSize: 1 }).path,
      ),
    ).toBe(true);
    for (const request of requests) expect(request.authorization).toBe("Bearer owner");
    expect(firestore.connectWarnings()).toEqual([
      { message: S.emulator("127.0.0.1:8080") },
      { message: S.emptyEmulator },
    ]);
    expect(S.emulator("127.0.0.1:8080")).toBe(
      "Connected to the Firestore emulator at 127.0.0.1:8080, not to Google; FIRESTORE_EMULATOR_HOST is set on this server",
    );
    expect((await firestore.getOverview()).version).toBe("Firestore emulator at 127.0.0.1:8080");
  });

  test("an emulator that lists a collection gets no empty-project hint", async () => {
    const firestore = provider(
      seamsOf(() => jsonAnswer({ collectionIds: ["users"] }), env),
      { password: "" },
    );
    await firestore.connect();
    expect(firestore.connectWarnings()).toEqual([{ message: S.emulator("127.0.0.1:8080") }]);
  });

  test("a credential in the connection is refused before any transport exists", async () => {
    const seams = seamsOf(() => jsonAnswer({}), env);
    await expect(provider(seams).connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(seams.lanes).toHaveLength(0);
  });

  test("an emulator answer it cannot read is refused", async () => {
    await expect(
      provider(
        seamsOf(() => jsonAnswer([]), env),
        { password: "" },
      ).connect(),
    ).rejects.toThrow(`${ERROR_SENTENCES.probeUnreadable}.`);
  });
});

describe("lifecycle and the members that send no request", () => {
  test("disconnect closes the transport, clears the warnings, and a second connect replaces the session", async () => {
    const seams = seamsOf(googleServer());
    const firestore = provider(seams);
    await firestore.connect();
    await firestore.connect();
    expect(seams.lanesOf("api").map((lane) => lane.closed)).toEqual([1, 0]);
    await firestore.disconnect();
    expect(seams.lanesOf("api").map((lane) => lane.closed)).toEqual([1, 1]);
    expect(firestore.isConnected()).toBe(false);
    expect(firestore.connectWarnings()).toEqual([]);
  });

  test("health, monitoring and containers answer with no request; maintenance is refused", async () => {
    const seams = seamsOf(googleServer());
    const firestore = provider(seams);
    await expect(firestore.getHealth()).rejects.toThrow("Provider is not connected");
    await firestore.connect();
    expect(await firestore.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(await firestore.getPerformanceMetrics()).toEqual({});
    expect(await firestore.getSlowQueries()).toEqual([]);
    expect(await firestore.getActiveSessions()).toEqual([]);
    expect(await firestore.getTableStats()).toEqual([]);
    expect(await firestore.getIndexStats()).toEqual([]);
    expect(await firestore.getStorageStats()).toEqual([]);
    expect(await firestore.listContainers()).toEqual([]);
    expect((await firestore.getMonitoringData()).overview?.tableCount).toBe(0);
    await expect(firestore.runMaintenance()).rejects.toBeInstanceOf(QueryError);
    await expect(firestore.runMaintenance()).rejects.toThrow(S.maintenance);
    expect(requestsOf(seams)).toHaveLength(1);
  });

  test("statements take no parameters, and every surface needs a connection", async () => {
    const firestore = provider(seamsOf(googleServer()));
    await expect(firestore.query('db.collection("users")')).rejects.toThrow("Provider is not connected");
    await firestore.connect();
    await expect(firestore.query('db.collection("users")', [1])).rejects.toThrow(S.parameters);
  });
});

describe("the surfaces are wired to their modules", () => {
  const ids: WireHandler = (request) =>
    request.path.endsWith(":listCollectionIds")
      ? jsonAnswer({ collectionIds: ["users", "orders"] })
      : request.path.endsWith(":runQuery")
        ? jsonAnswer([
            {
              document: {
                name: `${PROVIDER_DOCS}/users/alice`,
                fields: { age: { integerValue: "3" } },
                createTime: TIME,
              },
              readTime: TIME,
            },
            { readTime: TIME, done: true },
          ])
        : jsonAnswer({ name: `${PROVIDER_DOCS}/users/alice`, fields: {}, createTime: TIME, updateTime: TIME });

  test("tree, Keys panel, Source tab and console each reach Firestore through the session", async () => {
    const seams = seamsOf(googleServer(DATABASE, ids));
    const firestore = provider(seams);
    await firestore.connect();
    expect(await firestore.countObjects([])).toEqual({ collection: { count: 2 } });
    expect((await firestore.listObjects([], "collection")).map((object) => object.name)).toEqual(["orders", "users"]);
    expect((await firestore.describeObject(["users"], "collection")).columns.map((column) => column.name)).toEqual([
      "__name__",
      "age",
    ]);
    expect((await firestore.describeObjects([], "collection", 1)).details).toHaveLength(1);
    expect((await firestore.scanKeysPage({ cursor: "0", count: 10, level: true })).prefixes).toEqual([
      "orders/",
      "users/",
    ]);
    expect((await firestore.readObjectSource(["users/alice"], "document")).parts).toHaveLength(3);
    expect((await firestore.query('db.collection("users").limit(1)')).rowCount).toBe(1);
    expect(requestsOf(seams).every((request) => request.lane === "api")).toBe(true);
  });
});

describe("the credential's forms reach every context (S7)", () => {
  test("sessionBase names the credential kind and the forms of its secrets", () => {
    const emulator = { host: "127.0.0.1", port: 8080, origin: "http://127.0.0.1:8080", display: "127.0.0.1:8080" };
    expect(sessionBase({ mode: "emulator", emulator })).toEqual({ credential: "emulator", secretForms: [] });
    expect(sessionBase({ mode: "google", credentials: { type: "access_token", token: PASTED_TOKEN } })).toEqual({
      credential: "access_token",
      secretForms: secretForms([PASTED_TOKEN]),
    });
    const key = {
      type: "service_account",
      clientEmail: "a@p.iam.gserviceaccount.com",
      privateKey: "-----BEGIN KEY-----x",
    } as const;
    expect(sessionBase({ mode: "google", credentials: key })).toEqual({
      credential: "service_account",
      secretForms: secretForms([key.privateKey]),
    });
    expect(sessionBase({ mode: "google", credentials: { ...key, privateKeyId: "kid-1" } }).secretForms).toEqual(
      secretForms([key.privateKey, "kid-1"]),
    );
    const user = { type: "authorized_user", clientId: "c", clientSecret: "s3cret", refreshToken: "1//r" } as const;
    expect(sessionBase({ mode: "google", credentials: user })).toEqual({
      credential: "authorized_user",
      secretForms: secretForms(["s3cret", "1//r"]),
    });
    expect(
      sessionBase({ mode: "google", credentials: { type: "metadata", host: "metadata.google.internal" } }),
    ).toEqual({
      credential: "metadata",
      secretForms: [],
    });
  });

  test("a Google message quoting the pasted token is withheld on a Keys page", async () => {
    const denied: WireHandler = () =>
      jsonAnswer(
        { error: { code: 403, status: "PERMISSION_DENIED", message: `token ${PASTED_TOKEN} is not allowed` } },
        403,
      );
    const firestore = provider(seamsOf(googleServer(DATABASE, denied)));
    await firestore.connect();
    const failure = (await firestore.scanKeysPage({ cursor: "0", count: 10, level: true }).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;
    expect(failure.message).not.toContain(PASTED_TOKEN);
    expect(failure.message).toContain(ERROR_SENTENCES.withheld);
  });
});
