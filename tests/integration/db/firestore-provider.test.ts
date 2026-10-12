/**
 * Firestore provider, end to end, on what the pinned emulator answered and on answers built for what it cannot give.
 *
 * The real provider runs whole: the connection rules, the credential policy, the token source, the closed request
 * table, the transport lanes, the console, the Keys panel levels, the Source tab and the error mapping. Only the
 * network is replaced, at the provider's `createTransport` seam: tests/helpers/firestore-replay.ts answers each request
 * from tests/fixtures/firestore/1.22.0/ (recorded by tests/live/firestore-evidence.ts from cloud-firestore-emulator
 * 1.22.0, jar SHA-256 9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c), or from a script for the
 * answers listed in BUILT below. `mock.module()` is not used. The clock is fixed and the RSA key is generated here,
 * so the service-account assertion is verified with the key that signed it.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { importSPKI, jwtVerify } from "jose";
import { AuthenticationError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { type NodeRequest, type NodeResponse, TransportError } from "@/lib/db/http/node-transport";
import {
  FIRESTORE_API_ORIGIN,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
} from "@/lib/db/providers/document/firestore/constants";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import type { LaneKind } from "@/lib/db/providers/document/firestore/seams";
import { FIRESTORE_EXPLAIN_MARKER } from "@/lib/explain/firestore-explain";
import type { DatabaseConnection } from "@/lib/types";
import {
  jsonAnswer,
  readCapture,
  type ReplayTransport,
  replayTransport,
  scriptedTransport,
  UNRECORDED_ANSWER,
} from "../../helpers/firestore-replay";
import { runAsTheQueryRoute, runStep } from "../../live/firestore-evidence";
import { FIRESTORE_EMULATOR, FIRESTORE_SCENARIOS } from "../../live/firestore-evidence-plan";

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/firestore/1.22.0");
const FIXED_NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
const QUIET = { now: () => FIXED_NOW, sleep: async () => {} };

// ============================================================================
// The emulator, replayed
// ============================================================================

function emulatorProvider(createTransport: ReplayTransport["createTransport"]): FirestoreProvider {
  const connection: DatabaseConnection = {
    id: "firestore-it-emulator",
    name: "Firestore emulator",
    type: "firestore",
    database: FIRESTORE_EMULATOR.project,
    createdAt: new Date(0),
  };
  return new FirestoreProvider(
    connection,
    { queryTimeout: 30_000 },
    { createTransport, env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, ...QUIET },
  );
}

function replayed(scenario: string) {
  const capture = readCapture(path.join(FIXTURES, `${scenario}.json`));
  const replay = replayTransport(capture.exchanges);
  return { capture, replay, provider: emulatorProvider(replay.createTransport) };
}

describe("the captures", () => {
  test("the manifest names emulator 1.22.0, the pinned jar, Java 21 or later and every scenario of the plan", () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as {
      emulator: string;
      jarSha256: string;
      java: string;
      studioCommit: string;
      scenarios: { name: string }[];
    };
    expect(manifest.emulator).toContain("1.22.0");
    expect(manifest.jarSha256).toBe(FIRESTORE_EMULATOR.jarSha256);
    expect(Number(/version "(\d+)/.exec(manifest.java)?.[1])).toBeGreaterThanOrEqual(21);
    expect(manifest.studioCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.scenarios.map((scenario) => scenario.name)).toEqual(FIRESTORE_SCENARIOS.map((s) => s.name));
  });

  test("the fixtures stay under 1 MB", () => {
    const total = readdirSync(FIXTURES).reduce((sum, name) => sum + statSync(path.join(FIXTURES, name)).size, 0);
    expect(total).toBeLessThan(1_000_000);
  });

  test("every lane a capture recorded is the emulator lane, authorized as Bearer owner, refusing link-local", () => {
    for (const scenario of FIRESTORE_SCENARIOS) {
      const capture = readCapture(path.join(FIXTURES, `${scenario.name}.json`));
      expect(capture.lanes.length).toBeGreaterThan(0);
      for (const lane of capture.lanes) {
        expect({
          scenario: scenario.name,
          lane: lane.lane,
          authorization: lane.authorization,
          refuses: lane.refusesLinkLocal,
        }).toEqual({
          scenario: scenario.name,
          lane: "emulator",
          authorization: "Bearer owner",
          refuses: true,
        });
      }
    }
  });

  test("every recorded request is a GET or POST under /v1/projects/, with no write, transaction or listen verb", () => {
    for (const scenario of FIRESTORE_SCENARIOS) {
      for (const { request } of readCapture(path.join(FIXTURES, `${scenario.name}.json`)).exchanges) {
        expect(["GET", "POST"]).toContain(request.method);
        expect(request.path.startsWith(`/v1/projects/${FIRESTORE_EMULATOR.project}/databases/`)).toBe(true);
        expect(request.path).not.toMatch(
          /:(commit|batchWrite|beginTransaction|rollback|executePipeline|listen|write|partitionQuery)\b/,
        );
        expect(request.body ?? "").not.toMatch(/"(transaction|newTransaction|readTime|recursive|requestOptions)"/);
      }
    }
  });
});

describe("each scenario, replayed through the plan's own steps", () => {
  test.each(FIRESTORE_SCENARIOS.map((scenario) => scenario.name))(
    "%s answers every step, nothing unrecorded",
    async (name) => {
      const scenario = FIRESTORE_SCENARIOS.find((candidate) => candidate.name === name)!;
      const { provider, replay } = replayed(name);
      try {
        // oxlint-disable-next-line no-await-in-loop -- the plan's steps run in order on one provider.
        for (const step of scenario.steps) await runStep(provider, step);
      } finally {
        await provider.disconnect();
      }
      expect(replay.missed).toEqual([]);
    },
  );
});

describe("emulator mode on the replay (spec 4.3, S2)", () => {
  test("creates only emulator lanes, each with the literal Bearer owner, and offers no Explain", async () => {
    const { provider, replay } = replayed("browse");
    await provider.connect();
    await provider.listObjects([], "collection");
    expect(replay.lanes.map((lane) => [lane.lane, lane.authorization, lane.refusesLinkLocal])).toEqual(
      replay.lanes.map(() => ["emulator", "Bearer owner", true]),
    );
    expect(replay.lanes.length).toBeGreaterThan(0);
    expect(provider.getCapabilities().supportsExplain).not.toBe(true);
    expect(provider.getCapabilities().explainFormat).toBeUndefined();
    await provider.disconnect();
  });

  test("a refused statement sends no request", async () => {
    const { provider, replay } = replayed("console");
    await provider.connect();
    const before = replay.sent.length;
    await expect(runAsTheQueryRoute(provider, 'db.collection("users").explain()')).rejects.toThrow(
      "The Firestore emulator does not run Query Explain; run Explain against a Google project",
    );
    await expect(runAsTheQueryRoute(provider, 'db.collection("users").doc("alice").set({})')).rejects.toThrow(
      QueryError,
    );
    expect(replay.sent.length).toBe(before);
    await provider.disconnect();
  });
});

// ============================================================================
// Google, built
// ============================================================================

/** Every answer the emulator cannot give, built here; spec 9 lists them and the first test below holds this list to it. */
const BUILT = Object.freeze({
  serviceAccountGrant: "token endpoint: the service-account JWT-bearer grant",
  refreshGrant: "token endpoint: the authorized-user refresh grant, with x-goog-user-project",
  tokenRefusal: "token endpoint: a refused grant",
  metadataToken: "metadata server: the server identity's token",
  probeNative: "database resource probe: Native mode",
  probeDatastore: "database resource probe: Datastore mode",
  probeDisabled: "database resource probe: Firestore API access disabled",
  pasted401: "401 with a pasted access token",
  refused401: "401 with a service-account credential",
  serviceDisabled: "403 SERVICE_DISABLED",
  userProjectDenied: "403 USER_PROJECT_DENIED",
  forbiddenOnConnect: "403 on connect",
  forbiddenAfterConnect: "403 on a statement after connect",
  databaseNotFound: "404 database",
  missingIndex: "400 FAILED_PRECONDITION asking for an index",
  exhausted: "429 RESOURCE_EXHAUSTED",
  serverError: "5xx",
  deadline: "DEADLINE_EXCEEDED on an aggregation",
  tooLarge: "transport too-large",
  timeout: "transport timeout",
  explainMetrics: "explain metrics",
  foreignDocument: "a response naming a document outside the connection's database",
  idPageCap: "the 10-page id cap",
});
type BuiltKey = keyof typeof BUILT;

/**
 * Spec 9's sentence "Built in the test and listed as built: ...", item by item, each with the BUILT entries that build
 * it; spec 8.1's "401 otherwise" and "403 after connect" rows sit under "401" and "403 by reason".
 */
const SPEC_9_BUILT: Readonly<Record<string, readonly BuiltKey[]>> = Object.freeze({
  "every token-endpoint and metadata answer": ["serviceAccountGrant", "refreshGrant", "tokenRefusal", "metadataToken"],
  "`x-goog-user-project` from an authorized-user file": ["refreshGrant"],
  "the database resource probe and its Datastore-mode and disabled-access answers": [
    "probeNative",
    "probeDatastore",
    "probeDisabled",
  ],
  "401": ["pasted401", "refused401"],
  "403 by reason": ["serviceDisabled", "userProjectDenied", "forbiddenOnConnect", "forbiddenAfterConnect"],
  "404 database": ["databaseNotFound"],
  "index `FAILED_PRECONDITION`": ["missingIndex"],
  "429": ["exhausted"],
  "5xx": ["serverError"],
  "`DEADLINE_EXCEEDED`": ["deadline"],
  "transport `too-large` and timeout": ["tooLarge", "timeout"],
  "explain metrics": ["explainMetrics"],
  "a response naming a document outside the connection's database": ["foreignDocument"],
  "the 10-page id cap": ["idPageCap"],
});

/** The BUILT entries that registered a test, filled while the file's tests are collected, before any of them runs. */
const REGISTERED = new Set<BuiltKey>();

/** One built answer's test, titled by its BUILT entry and recorded, so the first test can see every entry has one. */
function built(key: BuiltKey, run: () => Promise<void>): void {
  REGISTERED.add(key);
  test(BUILT[key], run);
}

const PROJECT = "demo-firestore";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CLIENT_EMAIL = `studio-reader@${PROJECT}.iam.gserviceaccount.com`;
/** A key whose token_uri points elsewhere: the provider must dial the token constant anyway (spec 4.2). */
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: PROJECT,
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: privateKey,
  client_email: CLIENT_EMAIL,
  token_uri: "https://token.attacker.invalid/token",
});
const AUTHORIZED_USER = JSON.stringify({
  type: "authorized_user",
  client_id: "built-client-id.apps.googleusercontent.com",
  client_secret: "built-client-secret",
  refresh_token: "1//0built-refresh-token",
  quota_project_id: "demo-billing",
});
const DATABASE_RESOURCE = {
  name: `projects/${PROJECT}/databases/(default)`,
  type: "FIRESTORE_NATIVE",
  databaseEdition: "STANDARD",
  firestoreDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
};
const TOKEN_ANSWER = jsonAnswer({ access_token: "ya29.built-access-token", expires_in: 3600, token_type: "Bearer" });

type Shape = "probe" | "runQuery" | "runAggregationQuery" | "listCollectionIds" | "listDocuments" | "get" | "batchGet";

/** What a request asks, read from its method and verb, never from how its path is encoded. */
function shapeOf(request: NodeRequest): Shape {
  const pathname = new URL(request.url).pathname;
  if (request.method === "POST") {
    for (const verb of ["runQuery", "runAggregationQuery", "listCollectionIds", "batchGet"] as const) {
      if (pathname.endsWith(`:${verb}`)) return verb;
    }
    throw new Error(`an unexpected POST ${pathname}`);
  }
  if (!pathname.includes("/documents")) return "probe";
  const segments =
    pathname
      .split("/documents")[1]
      ?.split("/")
      .filter((segment) => segment !== "") ?? [];
  return segments.length % 2 === 0 ? "get" : "listDocuments";
}

function googleError(status: number, code: string, message: string, details: unknown[] = []): NodeResponse {
  return jsonAnswer({ error: { code: status, status: code, message, details } }, status);
}

const errorInfo = (reason: string) => ({
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason,
  domain: "googleapis.com",
});

interface Google {
  readonly provider: FirestoreProvider;
  readonly script: ReplayTransport;
  readonly sent: (lane: LaneKind, shape?: Shape) => NodeRequest[];
}

/**
 * A Google project behind scripted answers: `route` answers what it knows, the token endpoint answers a token, the
 * probe answers a Native-mode database, and anything else is unrecorded.
 */
function google(
  route: (shape: Shape, request: NodeRequest) => NodeResponse | Promise<NodeResponse> | undefined = () => undefined,
  options: {
    readonly password?: string;
    readonly managed?: boolean;
    readonly env?: Readonly<Record<string, string>>;
    readonly token?: NodeResponse;
    readonly metadata?: NodeResponse;
  } = {},
): Google {
  const script = scriptedTransport(async (lane, request) => {
    if (lane === "token") return options.token ?? TOKEN_ANSWER;
    if (lane === "metadata") return options.metadata ?? UNRECORDED_ANSWER;
    const shape = shapeOf(request);
    const answered = await route(shape, request);
    if (answered !== undefined) return answered;
    if (shape === "probe") return jsonAnswer(DATABASE_RESOURCE);
    return UNRECORDED_ANSWER;
  });
  const connection: DatabaseConnection = {
    id: "firestore-it-google",
    name: "Firestore",
    type: "firestore",
    database: PROJECT,
    password: options.password ?? SERVICE_ACCOUNT,
    ...(options.managed === undefined ? {} : { managed: options.managed }),
    createdAt: new Date(0),
  };
  const provider = new FirestoreProvider(
    connection,
    { queryTimeout: 30_000 },
    {
      createTransport: script.createTransport,
      env: options.env ?? {},
      // Thrown the way readFileSync throws an absent file: the errno is on `code`, which is what the chain reads.
      readFile: (file: string) => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
      },
      homeDir: () => "/nonexistent-home",
      platform: "linux",
      ...QUIET,
    },
  );
  const sent = (lane: LaneKind, shape?: Shape) =>
    script.sent
      .filter((entry) => entry.lane === lane && (shape === undefined || shapeOf(entry.request) === shape))
      .map((entry) => entry.request);
  return { provider, script, sent };
}

const bodyOf = (request: NodeRequest) => JSON.parse(request.body ?? "{}") as Record<string, unknown>;
const USERS = 'db.collection("users").where("age", ">", 30)';
const queryDocument = (name: string) => ({
  document: {
    name,
    fields: { name: { stringValue: "Alice" } },
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-01T00:00:00Z",
  },
  readTime: "2026-10-12T09:00:00Z",
});

describe("built answers (spec 9)", () => {
  test("the list of built answers is spec 9's, and each entry has its test", () => {
    expect(Object.keys(SPEC_9_BUILT)).toHaveLength(14);
    for (const [item, keys] of Object.entries(SPEC_9_BUILT))
      expect({ item, built: keys.length > 0 }).toEqual({ item, built: true });
    const builtKeys = (Object.keys(BUILT) as BuiltKey[]).sort();
    const covered = new Set(Object.values(SPEC_9_BUILT).flat());
    expect([...covered].sort()).toEqual(builtKeys);
    expect([...REGISTERED].sort()).toEqual(builtKeys);
    expect(Object.values(BUILT)).toEqual([...new Set(Object.values(BUILT))]);
  });

  built("serviceAccountGrant", async () => {
    const { provider, script, sent } = google();
    await provider.connect();
    const [grant] = sent("token");
    expect(grant?.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { payload, protectedHeader } = await jwtVerify(
      grant?.form?.assertion ?? "",
      await importSPKI(publicKey, "RS256"),
      {
        issuer: CLIENT_EMAIL,
        audience: GOOGLE_TOKEN_URL,
        currentDate: new Date(FIXED_NOW),
      },
    );
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.scope).toBe(FIRESTORE_SCOPE);
    expect(payload.iat).toBe(FIXED_NOW / 1000);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(3600);
    const token = script.lanes.find((lane) => lane.lane === "token");
    expect(token?.origin).toBe("https://oauth2.googleapis.com:443");
    expect(token?.refusesLinkLocal).toBe(true);
    expect(script.lanes.some((lane) => lane.origin.includes("attacker"))).toBe(false);
    const api = script.lanes.find((lane) => lane.lane === "api");
    expect(api?.origin).toBe(`${FIRESTORE_API_ORIGIN}:443`);
    expect(api?.authorization).toBe("Bearer <token>");
    expect(api?.refusesLinkLocal).toBe(true);
    expect(api?.headerNames).toEqual(expect.arrayContaining(["x-goog-request-params", "google-cloud-resource-prefix"]));
    await provider.disconnect();
  });

  built("refreshGrant", async () => {
    const { provider, script, sent } = google(undefined, { password: AUTHORIZED_USER });
    await provider.connect();
    const [grant] = sent("token");
    expect(grant?.form?.grant_type).toBe("refresh_token");
    expect(grant?.form?.scope).toBeUndefined();
    const api = script.lanes.find((lane) => lane.lane === "api");
    const requestHeaders = sent("api").flatMap((request) =>
      Object.keys(request.headers ?? {}).map((name) => name.toLowerCase()),
    );
    expect([...(api?.headerNames ?? []), ...requestHeaders]).toContain("x-goog-user-project");
    await provider.disconnect();
  });

  built("tokenRefusal", async () => {
    const { provider } = google(undefined, {
      token: jsonAnswer({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
    });
    const refused = await provider.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect((refused as Error).message).toContain("Invalid JWT Signature.");
    expect((refused as Error).message).not.toContain("eyJ");
  });

  built("metadataToken", async () => {
    const { provider, script, sent } = google(undefined, {
      password: "",
      managed: true,
      env: { FIRESTORE_SERVER_CREDENTIALS: "true", GCE_METADATA_HOST: "metadata.test.invalid" },
      metadata: jsonAnswer({ access_token: "ya29.metadata-token", expires_in: 3599, token_type: "Bearer" }),
    });
    await provider.connect();
    const [token] = sent("metadata");
    const url = new URL(token?.url ?? "http://invalid/");
    expect(url.pathname).toBe("/computeMetadata/v1/instance/service-accounts/default/token");
    expect(url.searchParams.get("scopes")).toBe(FIRESTORE_SCOPE);
    const metadata = script.lanes.find((lane) => lane.lane === "metadata");
    expect(metadata?.origin).toStartWith("http://metadata.test.invalid");
    expect(metadata?.refusesLinkLocal).toBe(false);
    const headers = [
      ...(metadata?.headerNames ?? []),
      ...Object.keys(token?.headers ?? {}).map((name) => name.toLowerCase()),
    ];
    expect(headers).toContain("metadata-flavor");
    expect(script.lanes.some((lane) => lane.lane === "token")).toBe(false);
    await provider.disconnect();
  });

  built("probeNative", async () => {
    const { provider, sent } = google();
    await provider.connect();
    expect(sent("api").map(shapeOf)).toEqual(["probe"]);
    await provider.disconnect();
  });

  built("probeDatastore", async () => {
    const { provider } = google((shape) =>
      shape === "probe" ? jsonAnswer({ ...DATABASE_RESOURCE, type: "DATASTORE_MODE" }) : undefined,
    );
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    await expect(provider.connect()).rejects.toThrow(
      "This database is in Datastore mode, which the Firestore API does not serve",
    );
  });

  built("probeDisabled", async () => {
    const { provider } = google((shape) =>
      shape === "probe"
        ? jsonAnswer({ ...DATABASE_RESOURCE, firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED" })
        : undefined,
    );
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    await expect(provider.connect()).rejects.toThrow("Firestore API access is off on this database");
  });

  built("pasted401", async () => {
    const { provider, script } = google(
      (shape) =>
        shape === "probe"
          ? googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
          : undefined,
      {
        password: "Bearer ya29.pasted-access-token-value",
      },
    );
    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    await expect(provider.connect()).rejects.toThrow("tokens from gcloud auth print-access-token last about an hour");
    expect(script.lanes.some((lane) => lane.lane === "token")).toBe(false);
  });

  built("refused401", async () => {
    const { provider, script } = google((shape) =>
      shape === "probe"
        ? googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
        : undefined,
    );
    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    await expect(provider.connect()).rejects.toThrow("Google refused the credential");
    expect(script.lanes.some((lane) => lane.lane === "token")).toBe(true);
  });

  built("serviceDisabled", async () => {
    const link = `https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=${PROJECT}`;
    const { provider } = google((shape) =>
      shape === "probe"
        ? googleError(
            403,
            "PERMISSION_DENIED",
            "Cloud Firestore API has not been used in project before or it is disabled.",
            [
              errorInfo("SERVICE_DISABLED"),
              {
                "@type": "type.googleapis.com/google.rpc.Help",
                links: [{ description: "Google developers console API activation", url: link }],
              },
            ],
          )
        : undefined,
    );
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    await expect(provider.connect()).rejects.toThrow(link);
  });

  built("userProjectDenied", async () => {
    const { provider } = google(
      (shape) =>
        shape === "probe"
          ? googleError(403, "PERMISSION_DENIED", "Caller does not have required permission to use project.", [
              errorInfo("USER_PROJECT_DENIED"),
            ])
          : undefined,
      { password: AUTHORIZED_USER },
    );
    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    await expect(provider.connect()).rejects.toThrow("run gcloud auth application-default set-quota-project");
  });

  built("forbiddenOnConnect", async () => {
    const { provider } = google((shape) =>
      shape === "probe"
        ? googleError(403, "PERMISSION_DENIED", "Missing or insufficient permissions.", [
            errorInfo("IAM_PERMISSION_DENIED"),
          ])
        : undefined,
    );
    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    await expect(provider.connect()).rejects.toThrow("roles/datastore.viewer");
  });

  built("forbiddenAfterConnect", async () => {
    const { provider } = google((shape) =>
      shape === "runQuery"
        ? googleError(403, "PERMISSION_DENIED", "Missing or insufficient permissions.", [
            errorInfo("IAM_PERMISSION_DENIED"),
          ])
        : undefined,
    );
    await provider.connect();
    const refused = await runAsTheQueryRoute(provider, USERS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as Error).message).toContain("Missing or insufficient permissions (IAM_PERMISSION_DENIED)");
    expect((refused as Error).message).toContain("roles/datastore.viewer");
    await provider.disconnect();
  });

  built("databaseNotFound", async () => {
    const { provider } = google((shape) =>
      shape === "probe"
        ? googleError(404, "NOT_FOUND", `Database '(default)' not found in project '${PROJECT}'.`)
        : undefined,
    );
    const refused = await provider.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toContain(PROJECT);
    expect((refused as Error).message).toContain("(default)");
  });

  built("missingIndex", async () => {
    const link = `https://console.firebase.google.com/v1/r/project/${PROJECT}/firestore/indexes?create_composite=ClBwcm9qZWN0cw`;
    const { provider } = google((shape) =>
      shape === "runQuery"
        ? googleError(400, "FAILED_PRECONDITION", `The query requires an index. You can create it here: ${link}`)
        : undefined,
    );
    await provider.connect();
    await expect(runAsTheQueryRoute(provider, `${USERS}.orderBy("name")`)).rejects.toThrow(QueryError);
    await expect(runAsTheQueryRoute(provider, `${USERS}.orderBy("name")`)).rejects.toThrow(link);
    await provider.disconnect();
  });

  built("exhausted", async () => {
    const { provider } = google((shape) =>
      shape === "runQuery"
        ? { ...googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded."), retryAfter: "30" }
        : undefined,
    );
    await provider.connect();
    const refused = await runAsTheQueryRoute(provider, USERS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as Error).message).toContain("Quota exceeded (RESOURCE_EXHAUSTED)");
    expect((refused as Error).message).toContain("30");
    await provider.disconnect();
  });

  built("serverError", async () => {
    const { provider } = google((shape) =>
      shape === "runQuery" ? googleError(503, "UNAVAILABLE", "The service is currently unavailable.") : undefined,
    );
    await provider.connect();
    const refused = await runAsTheQueryRoute(provider, USERS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as Error).message).toContain("503");
    expect((refused as Error).message).toContain("The service is currently unavailable (UNAVAILABLE)");
    await provider.disconnect();
  });

  built("deadline", async () => {
    const { provider } = google((shape) =>
      shape === "runAggregationQuery" ? googleError(504, "DEADLINE_EXCEEDED", "Deadline exceeded.") : undefined,
    );
    await provider.connect();
    await expect(runAsTheQueryRoute(provider, 'db.collection("users").count()')).rejects.toThrow(TimeoutError);
    await expect(runAsTheQueryRoute(provider, 'db.collection("users").count()')).rejects.toThrow("60 seconds");
    await provider.disconnect();
  });

  built("tooLarge", async () => {
    const tooLarge = () => {
      throw new TransportError("too-large", "The response passed its byte cap");
    };
    const { provider } = google((shape) =>
      shape === "runQuery" || shape === "listDocuments" ? tooLarge() : undefined,
    );
    await provider.connect();
    const refused = await runAsTheQueryRoute(provider, USERS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as Error).message).toMatch(/limit/);
    expect((refused as Error).message).toMatch(/select/);
    await expect(provider.scanKeysPage({ cursor: "0", pattern: "users/", count: 100, level: true })).rejects.toThrow(
      "These documents are too large to list this many at a time; list the level with a smaller count",
    );
    await provider.disconnect();
  });

  built("timeout", async () => {
    const { provider } = google((shape) => {
      if (shape === "runQuery") throw new TransportError("timeout", "The request passed its deadline");
      return undefined;
    });
    await provider.connect();
    await expect(runAsTheQueryRoute(provider, USERS)).rejects.toThrow(TimeoutError);
    await provider.disconnect();
  });

  built("explainMetrics", async () => {
    const metrics = {
      planSummary: { indexesUsed: [{ query_scope: "Collection", properties: "(age ASC, __name__ ASC)" }] },
    };
    const analyzed = {
      ...metrics,
      executionStats: { resultsReturned: "1", executionDuration: "0.012s", readOperations: "2", debugStats: {} },
    };
    let answer: unknown[] = [{ explainMetrics: metrics }];
    const { provider, sent } = google((shape) => (shape === "runQuery" ? jsonAnswer(answer) : undefined));
    await provider.connect();
    const plan = await provider.query(`${FIRESTORE_EXPLAIN_MARKER}${USERS}`);
    expect(bodyOf(sent("api", "runQuery").at(-1)!).explainOptions).toEqual({ analyze: false });
    expect(plan.rows).toHaveLength(1);
    expect(JSON.stringify(plan.rows[0])).toContain("(age ASC, __name__ ASC)");
    expect(plan.rows[0]?.executionStats).toBeNull();
    answer = [
      queryDocument(`projects/${PROJECT}/databases/(default)/documents/users/alice`),
      { explainMetrics: analyzed },
    ];
    const run = await provider.query(`${USERS}.explain({ analyze: true })`);
    expect(bodyOf(sent("api", "runQuery").at(-1)!).explainOptions).toEqual({ analyze: true });
    expect(JSON.stringify(run.rows[0])).toContain("0.012s");
    answer = [queryDocument(`projects/${PROJECT}/databases/(default)/documents/users/alice`)];
    await expect(provider.query(`${FIRESTORE_EXPLAIN_MARKER}${USERS}`)).rejects.toThrow(QueryError);
    await provider.disconnect();
  });

  built("foreignDocument", async () => {
    const { provider } = google((shape) =>
      shape === "runQuery"
        ? jsonAnswer([queryDocument("projects/other-project/databases/(default)/documents/users/x")])
        : undefined,
    );
    await provider.connect();
    await expect(runAsTheQueryRoute(provider, USERS)).rejects.toThrow(QueryError);
    await provider.disconnect();
  });

  built("idPageCap", async () => {
    let page = 0;
    const { provider, sent } = google((shape) => {
      if (shape !== "listCollectionIds") return undefined;
      page += 1;
      const ids = Array.from({ length: 1000 }, (_, index) => `c${String((page - 1) * 1000 + index).padStart(5, "0")}`);
      return jsonAnswer({ collectionIds: ids, nextPageToken: `page-${page + 1}` });
    });
    await provider.connect();
    const level = await provider.scanKeysPage({ cursor: "0", pattern: "", count: 100, level: true });
    expect(level.readOutcome?.scope).toBe("incomplete");
    expect(sent("api", "listCollectionIds")).toHaveLength(10);
    await provider.disconnect();
  });
});
