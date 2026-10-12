/**
 * Every number and fixed name of the Firestore provider, in one pure, browser-safe module.
 *
 * The other modules import their limits from here and restate none. A sentence lives here only when more than one
 * module raises it; a sentence one module raises lives in that module. The module imports nothing.
 */

/** The provider's type id. */
export const FIRESTORE_TYPE = "firestore" as const;

/** One connection's database: `databaseId` is "(default)" or a named database id. */
export interface FirestoreTarget {
  readonly projectId: string;
  readonly databaseId: string;
}

/** The only API origin; regional endpoints are later work and would come from a closed list. */
export const FIRESTORE_API_ORIGIN = "https://firestore.googleapis.com";
/** The only token URL; a credential's own `token_uri` is never read. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

/** The server environment variables this provider reads, each only through the seams. */
export const ENV = Object.freeze({
  emulatorHost: "FIRESTORE_EMULATOR_HOST",
  serverCredentials: "FIRESTORE_SERVER_CREDENTIALS",
  credentialsFile: "GOOGLE_APPLICATION_CREDENTIALS",
  metadataHost: "GCE_METADATA_HOST",
} as const);

export const DEFAULT_DATABASE_ID = "(default)";

/** Spec 8.2, plus the id byte bound of 4.1, the console listDocuments() row bound of 5.6 and Firestore's own aggregation stop. */
export const LIMITS = Object.freeze({
  /** Sent when a `runQuery` statement has no `limit` and no `findNearest`. */
  defaultQueryLimit: 100,
  maxQueryLimit: 1_000,
  maxOffset: 1_000,
  maxGetAllRefs: 1_000,
  minAggregations: 1,
  maxAggregations: 5,
  /** An aggregation's inner `limit`: any non-negative 32-bit integer. */
  maxAggregationInnerLimit: 2_147_483_647,
  minNearestLimit: 1,
  maxNearestLimit: 1_000,
  maxVectorDimensions: 2_048,
  sampleDocuments: 20,
  sampleDepth: 3,
  sampleFields: 200,
  maxResultColumns: 500,
  consoleListDocumentsRows: 100,
  /** Console text in UTF-8 bytes. */
  maxConsoleBytes: 65_536,
  maxConsoleDepth: 32,
  maxConsoleTokens: 10_000,
  keysPageMin: 1,
  keysPageMax: 1_000,
  keysPageDefault: 100,
  /** A collection-level `listDocuments` page with a field mask. */
  collectionPageSizeMax: 500,
  /** The same page without a field mask. */
  collectionPageSizeUnmasked: 50,
  /** `listCollectionIds` requests per level. */
  idListingRequests: 10,
  /** The `pageSize` each id listing asks for. */
  idListingPageSize: 1_000,
  cursorMaxChars: 2_048,
  cursorMaxDecodedBytes: 1_536,
  /** `runQuery`, `batchGet`, `listDocuments`. */
  largeResponseBytes: 64 * 1024 * 1024,
  /** `get`, `listCollectionIds`, `runAggregationQuery`, the database resource. */
  smallResponseBytes: 4 * 1024 * 1024,
  /** Token and metadata answers. */
  tokenResponseBytes: 64 * 1024,
  /** Added to the connection's query timeout to give the request deadline. */
  deadlineGraceMs: 5_000,
  /** A collection or document id in UTF-8 bytes. */
  maxIdBytes: 1_500,
  /** Firestore stops an aggregation after this many seconds whatever the client's deadline. */
  aggregationServerSeconds: 60,
});

/**
 * A path inside a suggested `db.collection("...")`: `\` and `"` take a backslash, and every character below U+0020
 * plus U+2028 and U+2029 is written `\uXXXX`, the rule the console's `jsString` follows, so the console lexer reads the
 * suggestion back as the same path.
 */
function quoted(path: string): string {
  return path
    .replace(/[\\"]/g, "\\$&")
    .replace(/[\u0000-\u001f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The sentences more than one module raises. */
export const SENTENCES = Object.freeze({
  readOnly: "Studio is read-only for Firestore in this version",
  emulatorExplain: "The Firestore emulator does not run Query Explain; run Explain against a Google project",
  keysTooLarge: "These documents are too large to list this many at a time; list the level with a smaller count",
  answerTooLarge:
    "Firestore's answer passed Studio's size cap for this request; ask for fewer documents with a smaller .limit(n), or for fewer fields with .select(...)",
  colonSubcollections: (documentPath: string): string =>
    `Studio cannot list the subcollections of a document whose id contains a colon; query them with db.collection("${quoted(documentPath)}/<subcollection>")`,
  colonVerbParent: (documentPath: string): string =>
    `Studio cannot query under the document ${JSON.stringify(documentPath)}, because its id contains a colon, which Firestore reads as the start of a method name; nothing was sent`,
}) satisfies Readonly<Record<string, string | ((...args: never[]) => string)>>;
