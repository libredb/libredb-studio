/**
 * The Firestore provider's fixed names, limits and shared sentences, pinned to the spec's numbers (8.2, 4.5) so a
 * changed number is a deliberate, reviewed change.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DATABASE_ID,
  ENV,
  FIRESTORE_API_ORIGIN,
  FIRESTORE_TYPE,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
  LIMITS,
  SENTENCES,
} from "@/lib/db/providers/document/firestore/constants";

describe("Firestore constants", () => {
  test("the type id, the fixed origins, the scope and the default database id", () => {
    expect(FIRESTORE_TYPE).toBe("firestore");
    expect(FIRESTORE_API_ORIGIN).toBe("https://firestore.googleapis.com");
    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
    expect(FIRESTORE_SCOPE).toBe("https://www.googleapis.com/auth/datastore");
    expect(DEFAULT_DATABASE_ID).toBe("(default)");
  });

  test("the server environment variables this provider reads", () => {
    expect(ENV).toEqual({
      emulatorHost: "FIRESTORE_EMULATOR_HOST",
      serverCredentials: "FIRESTORE_SERVER_CREDENTIALS",
      credentialsFile: "GOOGLE_APPLICATION_CREDENTIALS",
      metadataHost: "GCE_METADATA_HOST",
    });
    expect(Object.isFrozen(ENV)).toBe(true);
  });

  test("every limit of spec 8.2, by name", () => {
    expect(LIMITS).toEqual({
      defaultQueryLimit: 100,
      maxQueryLimit: 1_000,
      maxOffset: 1_000,
      maxGetAllRefs: 1_000,
      minAggregations: 1,
      maxAggregations: 5,
      maxAggregationInnerLimit: 2_147_483_647,
      minNearestLimit: 1,
      maxNearestLimit: 1_000,
      maxVectorDimensions: 2_048,
      sampleDocuments: 20,
      sampleDepth: 3,
      sampleFields: 200,
      maxResultColumns: 500,
      consoleListDocumentsRows: 100,
      maxConsoleBytes: 65_536,
      maxConsoleDepth: 32,
      maxConsoleTokens: 10_000,
      keysPageMin: 1,
      keysPageMax: 1_000,
      keysPageDefault: 100,
      collectionPageSizeMax: 500,
      collectionPageSizeUnmasked: 50,
      idListingRequests: 10,
      idListingPageSize: 1_000,
      cursorMaxChars: 2_048,
      cursorMaxDecodedBytes: 1_536,
      largeResponseBytes: 67_108_864,
      smallResponseBytes: 4_194_304,
      tokenResponseBytes: 65_536,
      deadlineGraceMs: 5_000,
      maxIdBytes: 1_500,
      aggregationServerSeconds: 60,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });

  test("the sentences more than one module raises", () => {
    expect(SENTENCES.readOnly).toBe("Studio is read-only for Firestore in this version");
    expect(SENTENCES.emulatorExplain).toBe(
      "The Firestore emulator does not run Query Explain; run Explain against a Google project",
    );
    expect(SENTENCES.keysTooLarge).toBe(
      "These documents are too large to list this many at a time; list the level with a smaller count",
    );
    expect(SENTENCES.answerTooLarge).toBe(
      "Firestore's answer passed Studio's size cap for this request; ask for fewer documents with a smaller .limit(n), or for fewer fields with .select(...)",
    );
    expect(SENTENCES.colonSubcollections("users/a:b")).toBe(
      'Studio cannot list the subcollections of a document whose id contains a colon; query them with db.collection("users/a:b/<subcollection>")',
    );
    expect(SENTENCES.colonSubcollections('q"x/a\\:b')).toBe(
      'Studio cannot list the subcollections of a document whose id contains a colon; query them with db.collection("q\\"x/a\\\\:b/<subcollection>")',
    );
    const control = SENTENCES.colonSubcollections("c/a\nb\u2028:c");
    expect(control).toContain("c/a\\u000ab\\u2028:c/<subcollection>");
    expect(control).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
    expect(SENTENCES.colonVerbParent("users/a:b")).toBe(
      'Studio cannot query under the document "users/a:b", because its id contains a colon, which Firestore reads as the start of a method name; nothing was sent',
    );
    const verbControl = SENTENCES.colonVerbParent("c/a\nb:c");
    expect(verbControl).toContain('"c/a\\nb:c"');
    expect(verbControl).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
    expect(Object.isFrozen(SENTENCES)).toBe(true);
    const texts = [
      SENTENCES.readOnly,
      SENTENCES.emulatorExplain,
      SENTENCES.keysTooLarge,
      SENTENCES.answerTooLarge,
      SENTENCES.colonSubcollections("a/b"),
      SENTENCES.colonVerbParent("a/b"),
    ];
    for (const text of texts) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
