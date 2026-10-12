/**
 * The evidence scrub of the Firestore captures, on built Google answers: placeholders shaped to pass the id rules,
 * applied identically to paths, bodies and answers; the index link's protobuf rewritten with valid lengths; page tokens
 * and document names kept; and nothing written while a token, a key, an assertion, a refresh token, a client secret,
 * a key id or an original project id survives.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { databaseIdRefusal, projectIdRefusal } from "@/lib/db/providers/document/firestore/names";
import {
  FIRESTORE_EVIDENCE_LEAK_SENTENCE,
  FirestoreEvidenceLeakError,
  FirestoreEvidenceScrubber,
  redactForTerminal,
  rewriteIndexLink,
} from "../../../helpers/firestore-evidence-scrub";
import type { FirestoreExchange } from "../../../helpers/firestore-replay";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PROJECT = "acme-prod-1";
const DATABASE = "orders-db";
const PRINCIPAL = "reader@acme-prod-1.iam.gserviceaccount.com";
const TOKEN = "ya29.a0AfB_built-access-token-value";
const REFRESH = "1//0gBuiltRefreshTokenValue_abcdefghij";
const CLIENT_SECRET = "GOCSPX-builtClientSecretValue";
const KEY_ID = "0123456789abcdef0123456789abcdef01234567";

const secrets = {
  projectIds: [PROJECT, "demo-libredb"],
  databaseIds: [DATABASE, "(default)"],
  principals: [PRINCIPAL],
  secrets: [TOKEN, REFRESH, CLIENT_SECRET, KEY_ID],
  privateKeys: [privateKey],
};

/** A base64url protobuf with field 1 (the index name) and field 2 (the query scope enum). */
function indexLink(name: string): string {
  const bytes = Buffer.from(name, "utf8");
  const proto = Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes, Buffer.from([0x10, 0x01])]);
  return `https://console.firebase.google.com/v1/r/project/${PROJECT}/firestore/indexes?create_composite=${proto.toString("base64url")}`;
}

/** Field 1 of a protobuf read back, checking its length prefix against the bytes that follow. */
function nameOf(link: string): string {
  const proto = Buffer.from(new URL(link).searchParams.get("create_composite") ?? "", "base64url");
  expect(proto[0]).toBe(0x0a);
  const length = proto[1];
  expect(proto.subarray(2 + length)).toEqual(Buffer.from([0x10, 0x01]));
  return proto.subarray(2, 2 + length).toString("utf8");
}

const NAME = `projects/${PROJECT}/databases/${DATABASE}/documents/users/alice`;
const exchange: FirestoreExchange = {
  lane: "api",
  request: {
    method: "POST",
    path: `/v1/projects/${PROJECT}/databases/${DATABASE}/documents:runQuery`,
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }] } }),
    maxResponseBytes: 64 * 1024 * 1024,
  },
  response: {
    status: 200,
    contentType: "application/json",
    retryAfter: null,
    text: JSON.stringify([
      {
        document: { name: NAME, fields: { owner: { stringValue: PRINCIPAL } } },
        readTime: "2026-10-12T09:00:00Z",
      },
      { nextPageToken: "AFTER_alice_page_token" },
    ]),
  },
};

describe("placeholders", () => {
  test("project and database ids become placeholders that pass the id rules, the same one everywhere", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const scrubbed = scrubber.exchange(exchange);
    expect(scrubbed.request.path).toBe("/v1/projects/scrubbed-project-1/databases/scrubbed-db-1/documents:runQuery");
    const answer = JSON.parse(scrubbed.response.text) as [{ document: { name: string; fields: unknown } }];
    expect(answer[0].document.name).toBe("projects/scrubbed-project-1/databases/scrubbed-db-1/documents/users/alice");
    expect(projectIdRefusal("scrubbed-project-1")).toBeNull();
    expect(databaseIdRefusal("scrubbed-db-1")).toBeNull();
  });

  test("a principal becomes principal-<n>@scrubbed.invalid, raw and percent-encoded", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    expect(scrubber.text(`${PRINCIPAL} ${encodeURIComponent(PRINCIPAL)}`)).toBe(
      "principal-1@scrubbed.invalid principal-1%40scrubbed.invalid",
    );
  });

  test("a demo- project and (default) are kept, so emulator captures replay under their own names", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    expect(scrubber.text("projects/demo-libredb/databases/(default)/documents/users")).toBe(
      "projects/demo-libredb/databases/(default)/documents/users",
    );
  });

  test("an id is replaced only as a whole id, never inside a longer one", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    expect(scrubber.text(`${PROJECT}-staging x${PROJECT}`)).toBe(`${PROJECT}-staging x${PROJECT}`);
  });

  test("page tokens and document ids are kept", () => {
    const scrubbed = new FirestoreEvidenceScrubber(secrets).exchange(exchange);
    expect(scrubbed.response.text).toContain("AFTER_alice_page_token");
    expect(scrubbed.response.text).toContain("/documents/users/alice");
  });
});

describe("secrets", () => {
  test("a token answer keeps its shape and loses its values", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const token = scrubber.exchange({
      lane: "token",
      request: { method: "POST", path: "/token", grantType: "refresh_token", maxResponseBytes: 65536 },
      response: {
        status: 200,
        contentType: "application/json",
        retryAfter: null,
        text: JSON.stringify({
          access_token: TOKEN,
          refresh_token: REFRESH,
          expires_in: 3599,
          id_token: "eyJa.eyJb.c",
        }),
      },
    });
    expect(JSON.parse(token.response.text)).toEqual({
      access_token: "<scrubbed>",
      refresh_token: "<scrubbed>",
      expires_in: 3599,
      id_token: "<scrubbed>",
    });
  });

  test("tokens, refresh tokens, client secrets, JWTs and PEM keys inside free text are replaced", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const text = scrubber.text(
      `Bearer ya29.other-token-value ${REFRESH} ${CLIENT_SECRET} eyJhbGc.eyJpc3M.sig ${KEY_ID} ${privateKey}`,
    );
    expect(text).not.toContain("ya29.");
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("eyJhbGc");
    expect(text).not.toContain(KEY_ID);
    expect(text).toContain("-----BEGIN PRIVATE KEY-----\nPLACEHOLDER\n-----END PRIVATE KEY-----");
  });
});

describe("rewriteIndexLink", () => {
  test("decodes the protobuf, rewrites the index name and re-encodes a valid length prefix", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const link = indexLink(`projects/${PROJECT}/databases/${DATABASE}/collectionGroups/users/indexes/_`);
    const rewritten = rewriteIndexLink(link, (text) => scrubber.text(text));
    expect(nameOf(rewritten)).toBe(
      "projects/scrubbed-project-1/databases/scrubbed-db-1/collectionGroups/users/indexes/_",
    );
    expect(rewritten).toContain("/project/scrubbed-project-1/firestore/indexes");
  });

  test("an index link inside an error message is rewritten by the exchange scrub", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const link = indexLink(`projects/${PROJECT}/databases/(default)/collectionGroups/users/indexes/_`);
    const scrubbed = scrubber.exchange({
      ...exchange,
      response: {
        status: 400,
        contentType: "application/json",
        retryAfter: null,
        text: JSON.stringify({
          error: {
            code: 400,
            status: "FAILED_PRECONDITION",
            message: `The query requires an index. You can create it here: ${link}`,
          },
        }),
      },
    });
    const message = (JSON.parse(scrubbed.response.text) as { error: { message: string } }).error.message;
    const found = /https:\/\/\S+/.exec(message)?.[0] ?? "";
    expect(nameOf(found)).toBe("projects/scrubbed-project-1/databases/(default)/collectionGroups/users/indexes/_");
  });

  test("a name longer than 127 bytes gets a two-byte varint length", () => {
    const long = `projects/${PROJECT}/databases/(default)/collectionGroups/${"c".repeat(120)}/indexes/_`;
    const rewritten = rewriteIndexLink(indexLink(long.slice(0, 120)), (text) => `${text}${"x".repeat(20)}`);
    const proto = Buffer.from(new URL(rewritten).searchParams.get("create_composite") ?? "", "base64url");
    expect(proto[0]).toBe(0x0a);
    expect(proto[1] & 0x80).toBe(0x80);
    expect((proto[1] & 0x7f) | (proto[2] << 7)).toBe(140);
  });
});

describe("render", () => {
  test("writes indented JSON with a final newline when nothing leaks", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    const files = scrubber.render({ "browse.json": { scenario: "browse", exchanges: [scrubber.exchange(exchange)] } });
    expect(files["browse.json"]?.endsWith("}\n")).toBe(true);
  });

  test("refuses the whole set, naming the file and what it holds but never the value", () => {
    const scrubber = new FirestoreEvidenceScrubber(secrets);
    let caught: unknown;
    try {
      scrubber.render({ "clean.json": {}, "leaky.json": { note: `${TOKEN} ${PROJECT} ${KEY_ID}` } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FirestoreEvidenceLeakError);
    const leak = caught as FirestoreEvidenceLeakError;
    expect(leak.message).toBe(FIRESTORE_EVIDENCE_LEAK_SENTENCE);
    expect(leak.findings).toEqual([
      "leaky.json holds a token, a refresh token, a client secret, a key id or an assertion the run was given",
      "leaky.json holds an access token",
      "leaky.json holds the original project id or database id",
    ]);
    expect(JSON.stringify(leak.findings)).not.toContain(TOKEN);
  });

  test("a private key that is not the placeholder is refused", () => {
    const scrubber = new FirestoreEvidenceScrubber({ ...secrets, privateKeys: [] });
    expect(() => scrubber.render({ "key.json": { pem: privateKey } })).toThrow(FirestoreEvidenceLeakError);
  });
});

describe("redactForTerminal", () => {
  test("replaces every secret and key the run was given", () => {
    expect(redactForTerminal(`token ${TOKEN} key ${privateKey}`, secrets)).toBe("token <secret> key <pem>");
  });
});
