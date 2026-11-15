/**
 * Google OAuth2 access tokens with no Google SDK: the grants, the metadata server, the cache and its one shared
 * refresh, the refusal reasons and the lanes, over neutral fakes.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import {
  type GoogleCredentials,
  googleCredentialSecrets,
  parseGoogleCredentialText,
} from "@/lib/db/auth/google/credentials";
import {
  createGoogleTokenSource,
  GOOGLE_TOKEN_SOURCE_SENTENCES as S,
  GOOGLE_TOKEN_URL,
  type GoogleAuthLane,
  type GoogleTokenSourceDeps,
} from "@/lib/db/auth/google/token-source";
import { AuthenticationError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type FakeAnswer,
  FIXED_NOW,
  fakeClock,
  fakeTransports,
  held,
  jsonAnswer,
  tokenAnswer,
} from "../../../../helpers/auth-fakes";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_RESPONSE_BYTES = 64 * 1024;
const signal = new AbortController().signal;
const serviceAccount: GoogleCredentials = {
  type: "service_account",
  clientEmail: "reader@demo-p.iam.gserviceaccount.com",
  privateKey,
  privateKeyId: "kid-123",
};
const user: GoogleCredentials = {
  type: "authorized_user",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "user-secret-value",
  refreshToken: "1//refresh-token-value",
};
const metadata: GoogleCredentials = { type: "metadata", host: "meta.internal:8080" };
const METADATA_URL =
  "http://meta.internal:8080/computeMetadata/v1/instance/service-accounts/default/token?scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdatastore";

/** The clock, its deadlines and the recorded lanes of one source. */
function fakeSeams(answer: FakeAnswer<GoogleAuthLane>) {
  return { ...fakeClock(), ...fakeTransports(answer) };
}
type FakeSeams = ReturnType<typeof fakeSeams>;

function depsOf(seams: FakeSeams): GoogleTokenSourceDeps {
  return {
    scope: SCOPE,
    provider: "firestore",
    maxResponseBytes: TOKEN_RESPONSE_BYTES,
    now: () => seams.now(),
    timeoutSignal: (ms) => seams.timeoutSignal(ms),
    createTransport: seams.createTransport,
  };
}

function sourceOf(credentials: GoogleCredentials, answer: FakeAnswer<GoogleAuthLane>) {
  const seams = fakeSeams(answer);
  return { seams, source: createGoogleTokenSource(credentials, depsOf(seams)) };
}

/** Lets queued microtasks run, so a refresh that awaits key import or a grant reaches its transport. */
async function settle(): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- each turn must drain before the next is queued.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("google token source grants", () => {
  test("the token endpoint is Google's OAuth 2.0 token URL", () => {
    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
  });

  test("a service account posts one JWT-bearer grant to the token constant, signed RS256 with its key", async () => {
    const { seams, source } = sourceOf(serviceAccount, () => tokenAnswer("sa-token"));
    expect(await source.token(signal)).toBe("sa-token");
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["token"]);
    const request = seams.lanes[0].requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe(GOOGLE_TOKEN_URL);
    expect(request.body).toBeUndefined();
    expect(request.maxResponseBytes).toBe(TOKEN_RESPONSE_BYTES);
    expect(Object.keys(request.form ?? {}).sort()).toEqual(["assertion", "grant_type"]);
    expect(request.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = request.form?.assertion ?? "";
    expect(decodeProtectedHeader(assertion)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    const { payload } = await jwtVerify(assertion, await importSPKI(publicKey, "RS256"), {
      issuer: "reader@demo-p.iam.gserviceaccount.com",
      audience: GOOGLE_TOKEN_URL,
      currentDate: new Date(FIXED_NOW),
    });
    expect(payload).toEqual({
      iss: "reader@demo-p.iam.gserviceaccount.com",
      aud: GOOGLE_TOKEN_URL,
      scope: SCOPE,
      iat: FIXED_NOW / 1000,
      exp: FIXED_NOW / 1000 + 3600,
    });
  });

  test("a key without a key id signs with no kid header", async () => {
    const withoutKid: GoogleCredentials = {
      type: "service_account",
      clientEmail: "reader@demo-p.iam.gserviceaccount.com",
      privateKey,
    };
    const { seams, source } = sourceOf(withoutKid, () => tokenAnswer("sa-token"));
    await source.token(signal);
    expect(decodeProtectedHeader(seams.lanes[0].requests[0].form?.assertion ?? "")).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
  });

  test("an authorized user posts a refresh grant with no scope", async () => {
    const { seams, source } = sourceOf(user, () => tokenAnswer("user-token"));
    expect(await source.token(signal)).toBe("user-token");
    expect(seams.lanes[0].requests[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(seams.lanes[0].requests[0].form).toEqual({
      grant_type: "refresh_token",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "user-secret-value",
      refresh_token: "1//refresh-token-value",
    });
  });

  test("the metadata server is asked with a GET for the scope, on the metadata lane", async () => {
    const { seams, source } = sourceOf(metadata, () => tokenAnswer("meta-token"));
    expect(await source.token(signal)).toBe("meta-token");
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["metadata"]);
    expect(seams.lanes[0].options.origin).toEqual({ scheme: "http", host: "meta.internal", port: 8080 });
    const request = seams.lanes[0].requests[0];
    expect(request.method).toBe("GET");
    expect(request.url).toBe(METADATA_URL);
    expect(request.form).toBeUndefined();
    expect(request.maxResponseBytes).toBe(TOKEN_RESPONSE_BYTES);
    const fallback = sourceOf({ type: "metadata", host: "metadata.google.internal" }, () => tokenAnswer("m"));
    await fallback.source.token(signal);
    expect(fallback.seams.lanes[0].requests[0].url).toStartWith(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=",
    );
  });

  test("a pasted token is handed back as is, and no transport is ever built", async () => {
    const { seams, source } = sourceOf({ type: "access_token", token: "ya29.pasted-token-value-123" }, () =>
      tokenAnswer("x"),
    );
    expect(await source.token(signal)).toBe("ya29.pasted-token-value-123");
    seams.setClock(FIXED_NOW + 24 * 3_600_000);
    expect(await source.token(signal)).toBe("ya29.pasted-token-value-123");
    source.close();
    expect(seams.lanes).toEqual([]);
    expect(seams.deadlines).toEqual([]);
  });

  test("a credential file's token_uri is never dialled", async () => {
    const hostile = parseGoogleCredentialText(
      JSON.stringify({
        type: "service_account",
        client_email: "reader@demo-p.iam.gserviceaccount.com",
        private_key: privateKey,
        token_uri: "https://evil.example/token",
        universe_domain: "evil.example",
      }),
      {
        provider: "firestore",
        accepts: ["service_account"],
        quotaProjectRefusal: () => null,
        serverIdentity: {
          optIn: "SAMPLE_SERVER_CREDENTIALS",
          unmanaged: "unmanaged",
          withoutOptIn: "without opt-in",
          literalSeedFile: "literal seed file",
        },
      },
    );
    const { seams, source } = sourceOf(hostile, () => tokenAnswer("sa-token"));
    await source.token(signal);
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["token"]);
    expect(seams.lanes[0].requests.map((request) => request.url)).toEqual([GOOGLE_TOKEN_URL]);
  });
});

describe("google token source cache", () => {
  test("a token is reused until 60 seconds before it expires", async () => {
    let issued = 0;
    const { seams, source } = sourceOf(user, () => tokenAnswer(`t${++issued}`, 3600));
    expect(await source.token(signal)).toBe("t1");
    seams.setClock(FIXED_NOW + 3_540_000 - 1);
    expect(await source.token(signal)).toBe("t1");
    seams.setClock(FIXED_NOW + 3_540_000);
    expect(await source.token(signal)).toBe("t2");
    expect(seams.lanes[0].requests).toHaveLength(2);
    expect(seams.lanes).toHaveLength(1);
  });

  test("an answer without a usable expires_in lives an hour", async () => {
    for (const expires of [undefined, "3600", -5, Number.POSITIVE_INFINITY]) {
      let issued = 0;
      const { seams, source } = sourceOf(user, () => jsonAnswer({ access_token: `t${++issued}`, expires_in: expires }));
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time, each read against the clock it set.
      await source.token(signal);
      seams.setClock(FIXED_NOW + 3_540_000 - 1);
      // oxlint-disable-next-line no-await-in-loop -- the same source, after the first token is cached.
      expect(await source.token(signal)).toBe("t1");
      seams.setClock(FIXED_NOW + 3_540_000);
      // oxlint-disable-next-line no-await-in-loop -- the same source, once the clock passes the refresh point.
      expect(await source.token(signal)).toBe("t2");
    }
  });

  test("concurrent callers share one refresh", async () => {
    const answer = held<ReturnType<typeof tokenAnswer>>();
    const { seams, source } = sourceOf(user, () => answer.promise);
    const calls = Promise.all([source.token(signal), source.token(signal), source.token(signal)]);
    await settle();
    answer.resolve(tokenAnswer("shared"));
    expect(await calls).toEqual(["shared", "shared", "shared"]);
    expect(seams.lanes[0].requests).toHaveLength(1);
  });

  test("the shared refresh runs on its own 30-second deadline, not on a caller's signal", async () => {
    const { seams, source } = sourceOf(user, () => new Promise(() => {}));
    const caller = new AbortController();
    const call = source.token(caller.signal).catch((error: unknown) => error);
    await settle();
    expect(seams.deadlines.map((deadline) => deadline.ms)).toEqual([30_000]);
    const request = seams.lanes[0].requests[0];
    expect(request.signal).not.toBe(caller.signal);
    seams.fireDeadline(0);
    expect(request.signal.aborted).toBe(true);
    expect(await call).toMatchObject({ kind: "timeout" });
  });

  test("a failed refresh caches nothing, so the next call asks again", async () => {
    const answers = [jsonAnswer({}, 500), tokenAnswer("t2")];
    const { seams, source } = sourceOf(user, () => answers.shift() ?? jsonAnswer({}, 500));
    await expect(Promise.all([source.token(signal), source.token(signal)])).rejects.toBeInstanceOf(AuthenticationError);
    expect(await source.token(signal)).toBe("t2");
    expect(seams.lanes[0].requests).toHaveLength(2);
  });
});

describe("google token source errors", () => {
  test("a refusal reports error_description, then error, then the status, and never a secret", async () => {
    const cases: readonly (readonly [ReturnType<typeof jsonAnswer>, string])[] = [
      [
        jsonAnswer({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
        S.refused("Invalid JWT Signature."),
      ],
      [jsonAnswer({ error: "invalid_grant" }, 400), S.refused("invalid_grant")],
      [{ status: 502, contentType: "text/html", retryAfter: null, text: "<html>" }, S.refused("HTTP 502")],
      [jsonAnswer({ expires_in: 3600 }), S.refused("HTTP 200")],
      [jsonAnswer({ access_token: "" }), S.refused("HTTP 200")],
      [jsonAnswer(["not", "an", "object"]), S.refused("HTTP 200")],
    ];
    for (const credentials of [serviceAccount, user]) {
      for (const [answer, sentence] of cases) {
        const { seams, source } = sourceOf(credentials, () => answer);
        // oxlint-disable-next-line no-await-in-loop -- one case at a time, so a failure names its answer.
        const error = await source.token(signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AuthenticationError);
        const message = (error as Error).message;
        expect(message).toBe(sentence);
        expect((error as AuthenticationError).provider).toBe("firestore");
        const sent = seams.lanes[0].requests[0].form ?? {};
        for (const secret of [
          sent.assertion,
          "user-secret-value",
          "1//refresh-token-value",
          "kid-123",
          "PRIVATE KEY",
        ]) {
          if (secret !== undefined) expect(message).not.toContain(secret);
        }
      }
    }
  });

  test("a long error_description is cut to 300 characters", async () => {
    const { source } = sourceOf(user, () => jsonAnswer({ error_description: "x".repeat(1000) }, 400));
    const error = await source.token(signal).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(S.refused("x".repeat(300)));
  });

  test("a key jose cannot import is refused before any request, without the key", async () => {
    const broken: GoogleCredentials = {
      type: "service_account",
      clientEmail: "reader@demo-p.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nAAAAnot-a-key\n-----END PRIVATE KEY-----\n",
    };
    const { seams, source } = sourceOf(broken, () => tokenAnswer("never"));
    const error = await source.token(signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe(S.keyUnreadable);
    expect((error as Error).message).not.toContain("AAAAnot-a-key");
    expect(seams.lanes).toEqual([]);
  });
});

describe("google token source callers and close", () => {
  test("a caller that aborts is rejected at once and does not fail a longer caller", async () => {
    const answer = held<ReturnType<typeof tokenAnswer>>();
    const { seams, source } = sourceOf(metadata, () => answer.promise);
    const short = new AbortController();
    const shortCall = source.token(short.signal).catch((error: unknown) => error);
    const longCall = source.token(signal);
    await settle();
    short.abort();
    const error = await shortCall;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "aborted", message: "The request was cancelled" });
    expect(seams.lanes[0].requests).toHaveLength(1);
    answer.resolve(tokenAnswer("shared"));
    expect(await longCall).toBe("shared");
  });

  test("a caller already past its deadline is rejected as a timeout", async () => {
    const answer = held<ReturnType<typeof tokenAnswer>>();
    const { source } = sourceOf(metadata, () => answer.promise);
    const error = await source
      .token(AbortSignal.abort(new DOMException("late", "TimeoutError")))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "timeout", message: "The request did not finish within its time limit" });
    answer.resolve(tokenAnswer("later"));
    expect(await source.token(signal)).toBe("later");
  });

  test("a settled wait removes its abort listener", async () => {
    const { source } = sourceOf(metadata, () => tokenAnswer("t"));
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    expect(await source.token(controller.signal)).toBe("t");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("close aborts the refresh in flight, closes the token lane, and refuses every later call", async () => {
    const { seams, source } = sourceOf(user, () => new Promise(() => {}));
    const call = source.token(signal).catch((error: unknown) => error);
    await settle();
    source.close();
    expect(await call).toMatchObject({ kind: "aborted" });
    expect(seams.lanes[0].closed).toBe(1);
    const later = await source.token(signal).catch((error: unknown) => error);
    expect(later).toBeInstanceOf(TransportError);
    expect(later).toMatchObject({ kind: "aborted", message: S.closed });
    expect(seams.lanes[0].requests).toHaveLength(1);
  });

  test("close during a service account's key import opens no lane and refuses the call as closed", async () => {
    const { seams, source } = sourceOf(serviceAccount, () => tokenAnswer("never"));
    const call = source.token(signal).catch((error: unknown) => error);
    source.close();
    const refused = await call;
    expect(refused).toBeInstanceOf(TransportError);
    expect(refused).toMatchObject({ kind: "aborted", message: S.closed });
    expect(seams.lanes).toEqual([]);
  });

  test("close discards a cached token", async () => {
    const { source } = sourceOf(user, () => tokenAnswer("cached"));
    expect(await source.token(signal)).toBe("cached");
    source.close();
    await expect(source.token(signal)).rejects.toThrow(S.closed);
  });
});

describe("google token source refusal reasons (the credential's forms withheld)", () => {
  test("a reason that holds the refresh token, or the base64 of the client secret, is withheld whole", async () => {
    const forms = [
      "invalid_grant for 1//refresh-token-value",
      `bad client ${Buffer.from("user-secret-value").toString("base64")}`,
      `bad client ${encodeURIComponent("user-secret-value")}`,
    ];
    for (const reason of forms) {
      const { source } = sourceOf(user, () => jsonAnswer({ error: "invalid_grant", error_description: reason }, 400));
      // oxlint-disable-next-line no-await-in-loop -- one reason at a time, so a failure names it.
      const error = await source.token(signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthenticationError);
      const message = (error as Error).message;
      expect(message).toBe(
        S.refused("(the server's text was withheld because it contained the configured credential)"),
      );
      expect(message).not.toContain("refresh-token-value");
      expect(message).not.toContain("user-secret-value");
    }
  });

  test("a service account's key id in an error is withheld too, and the forms are the credential's own", async () => {
    const { source } = sourceOf(serviceAccount, () =>
      jsonAnswer({ error: "invalid_grant", error_description: "kid kid-123 unknown" }, 400),
    );
    expect(((await source.token(signal).catch((caught: unknown) => caught)) as Error).message).not.toContain("kid-123");
    expect(secretForms(googleCredentialSecrets(serviceAccount))).toContain("kid-123");
  });

  test("a reason that holds no form is unchanged, and a long one is cut to 300 characters after the check", async () => {
    const { source } = sourceOf(user, () =>
      jsonAnswer({ error_description: "Token has been expired or revoked." }, 400),
    );
    const plain = await source.token(signal).catch((caught: unknown) => caught);
    expect((plain as Error).message).toBe(S.refused("Token has been expired or revoked."));
    const long = sourceOf(user, () => jsonAnswer({ error_description: `${"y".repeat(400)}z` }, 400));
    const cut = await long.source.token(signal).catch((caught: unknown) => caught);
    expect((cut as Error).message).toBe(S.refused("y".repeat(300)));
    const secretAtTheEnd = `${"x".repeat(400)}1//refresh-token-value`;
    const late = sourceOf(user, () => jsonAnswer({ error_description: secretAtTheEnd }, 400));
    await expect(late.source.token(signal)).rejects.toThrow(
      S.refused("(the server's text was withheld because it contained the configured credential)"),
    );
  });
});

describe("google token source deadlines while signing", () => {
  test("a deadline that fires while the key is signed reports a timeout, never the closed sentence", async () => {
    const { seams, source } = sourceOf(serviceAccount, () => new Promise(() => {}));
    const call = source.token(signal).catch((error: unknown) => error);
    seams.fireDeadline(0);
    const error = await call;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).not.toBe(S.closed);
  });

  test("a close() while the key is signed reports the closed sentence", async () => {
    const { seams, source } = sourceOf(serviceAccount, () => tokenAnswer("never"));
    const call = source.token(signal).catch((error: unknown) => error);
    source.close();
    expect(await call).toMatchObject({ kind: "aborted", message: S.closed });
    expect(seams.lanes).toEqual([]);
  });
});

describe("google token source lanes", () => {
  test("the token lane and the metadata lane equal the options the shared transport is given today, key for key", async () => {
    const token = sourceOf(user, () => tokenAnswer("t"));
    await token.source.token(signal);
    expect(token.seams.lanes.map((lane) => lane.lane)).toEqual(["token"]);
    expect(token.seams.lanes[0].options).toEqual({
      origin: { scheme: "https", host: "oauth2.googleapis.com", port: 443 },
      tls: { rejectUnauthorized: true, identity: "oauth2.googleapis.com" },
      maxSockets: 1,
      headers: {},
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    const meta = sourceOf(metadata, () => tokenAnswer("m"));
    await meta.source.token(signal);
    expect(meta.seams.lanes[0].options).toEqual({
      origin: { scheme: "http", host: "meta.internal", port: 8080 },
      tls: null,
      maxSockets: 1,
      headers: { "metadata-flavor": "Google" },
      refusesUpgrade: true,
    });
    expect("refusesLinkLocal" in meta.seams.lanes[0].options).toBe(false);
  });

  test("close closes every lane the source built", async () => {
    const { seams, source } = sourceOf(metadata, () => tokenAnswer("m"));
    await source.token(signal);
    source.close();
    expect(seams.lanes.map((lane) => lane.closed)).toEqual([1]);
  });

  test("two sources from two credentials over one factory never return each other's token", async () => {
    const seams = fakeSeams((request) =>
      tokenAnswer(request.form?.client_id === "first" ? "first-token" : "second-token"),
    );
    const first = createGoogleTokenSource({ ...user, clientId: "first" } as GoogleCredentials, depsOf(seams));
    const second = createGoogleTokenSource({ ...user, clientId: "second" } as GoogleCredentials, depsOf(seams));
    expect(await Promise.all([first.token(signal), second.token(signal), first.token(signal)])).toEqual([
      "first-token",
      "second-token",
      "first-token",
    ]);
    first.close();
    expect(await second.token(signal)).toBe("second-token");
    expect(seams.lanes).toHaveLength(2);
    expect(FIXED_NOW).toBe(seams.now());
  });
});
