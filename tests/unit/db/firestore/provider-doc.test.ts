/**
 * `docs/providers/firestore.md` quotes sentences, limits, endpoints, statements and declarations the provider's own
 * modules own, the shape of the Kubernetes and S3 doc tests: a value copied into prose is true only until the code
 * moves, so each is read back here, raised through the provider's own functions where the code raises it by
 * behaviour, and every console example the doc shows is parsed and compiled.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { QueryError } from "@/lib/db/errors";
import { compileStatement } from "@/lib/db/providers/document/firestore/console/compile";
import { countStatement, previewStatement } from "@/lib/db/providers/document/firestore/console/generators";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import {
  ENV,
  FIRESTORE_API_ORIGIN,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
  LIMITS,
  SENTENCES,
} from "@/lib/db/providers/document/firestore/constants";
import { resolveFirestoreAuth } from "@/lib/db/providers/document/firestore/credential-policy";
import { FIRESTORE_CURSOR_SENTENCES } from "@/lib/db/providers/document/firestore/cursor";
import { ERROR_SENTENCES, mapGoogleError } from "@/lib/db/providers/document/firestore/errors";
import { FIRESTORE_PROVIDER_SENTENCES, FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import { FIRESTORE_KEY_SCAN_SENTENCES } from "@/lib/db/providers/document/firestore/key-scan";
import { resolveSeams } from "@/lib/db/providers/document/firestore/seams";
import { jsonAnswer, scriptedTransport, UNRECORDED_ANSWER } from "../../../helpers/firestore-replay";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/providers/firestore.md"), "utf8");
const TARGET = { projectId: "demo-libredb", databaseId: "(default)" };
const EMULATOR = "127.0.0.1:8080";

/** A quoted sentence: a blockquote line that holds it whole. */
const quoted = (sentence: string) => DOC.split("\n").includes(`> ${sentence}`);

function sectionOf(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const end = DOC.indexOf("\n## ", start + heading.length + 2);
  return DOC.slice(start, end === -1 ? undefined : end);
}

/** A `###` subsection, up to the next heading of level 2 or 3. */
function subsectionOf(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no subsection ${heading}`);
  const rest = DOC.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

async function emulatorProvider(): Promise<FirestoreProvider> {
  const script = scriptedTransport((_lane, request) =>
    request.url.endsWith(":listCollectionIds") ? jsonAnswer({}) : UNRECORDED_ANSWER,
  );
  const provider = new FirestoreProvider(
    { id: "doc", name: "doc", type: "firestore", database: "demo-libredb", createdAt: new Date(0) },
    { queryTimeout: 30_000 },
    { createTransport: script.createTransport, env: { [ENV.emulatorHost]: EMULATOR } },
  );
  await provider.connect();
  return provider;
}

const count = (value: number) => value.toLocaleString("en-US");
const bytes = (value: number) => (value >= 1024 * 1024 ? `${value / (1024 * 1024)} MiB` : `${value / 1024} KiB`);

describe("the sentences the doc quotes are the code's", () => {
  test("the two empty-credential refusals", () => {
    const seams = resolveSeams({ env: {} });
    expect(quoted(refusal(() => resolveFirestoreAuth({ password: "", managed: false }, seams)))).toBe(true);
    expect(quoted(refusal(() => resolveFirestoreAuth({ password: "", managed: true }, seams)))).toBe(true);
  });

  test("the credential refusal on an emulator server, for the documented host", () => {
    const seams = resolveSeams({ env: { [ENV.emulatorHost]: EMULATOR } });
    expect(
      quoted(refusal(() => resolveFirestoreAuth({ password: "ya29.any-token-value", managed: false }, seams))),
    ).toBe(true);
  });

  test("the emulator warning and the empty-project hint", async () => {
    const provider = await emulatorProvider();
    const messages = provider.connectWarnings().map((warning) => warning.message);
    expect(messages).toEqual([
      FIRESTORE_PROVIDER_SENTENCES.emulator(EMULATOR),
      FIRESTORE_PROVIDER_SENTENCES.emptyEmulator,
    ]);
    for (const message of messages) expect({ message, quoted: quoted(message) }).toEqual({ message, quoted: true });
    await provider.disconnect();
  });

  test("the emulator's Explain refusal, both ways", async () => {
    const sentence = "The Firestore emulator does not run Query Explain; run Explain against a Google project";
    const provider = await emulatorProvider();
    await expect(provider.query('db.collection("users").explain()')).rejects.toThrow(sentence);
    expect(quoted(sentence)).toBe(true);
    await provider.disconnect();
  });

  test("the pasted-token 401, both ways", () => {
    const sentence =
      "The pasted access token was refused; tokens from gcloud auth print-access-token last about an hour: paste a new one, or use a service-account key";
    const error = mapGoogleError(
      { httpStatus: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." },
      { phase: "connect", credential: "access_token", target: TARGET },
    );
    expect(error.message).toContain(sentence);
    expect(quoted(sentence)).toBe(true);
  });

  test.each([
    ["ERROR_SENTENCES.datastoreMode", ERROR_SENTENCES.datastoreMode],
    ["ERROR_SENTENCES.dataAccessDisabled", ERROR_SENTENCES.dataAccessDisabled],
    ["SENTENCES.keysTooLarge", SENTENCES.keysTooLarge],
    ["FIRESTORE_CURSOR_SENTENCES.expired", FIRESTORE_CURSOR_SENTENCES.expired],
    ["FIRESTORE_KEY_SCAN_SENTENCES.partialUnknown", FIRESTORE_KEY_SCAN_SENTENCES.partialUnknown],
  ])("the exported sentence %s is quoted whole", (_name, sentence) => {
    expect(typeof sentence).toBe("string");
    expect(quoted(sentence as string)).toBe(true);
  });
});

describe("the console section", () => {
  const query = sectionOf("## 5. Query interface");

  test("every example parses and compiles to one request", () => {
    const blocks = [...query.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
    const examples = blocks.flatMap((block) =>
      block.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//")),
    );
    expect(examples.length).toBeGreaterThanOrEqual(20);
    for (const text of examples) {
      const compiled = compileStatement(parseStatement(text), text, { target: TARGET, explainButton: false });
      expect({ text, request: typeof compiled.request.kind }).toEqual({ text, request: "string" });
    }
  });

  test("every near miss is refused with the sentence the table gives", () => {
    const rows = [...subsectionOf("### 5.3 Near misses").matchAll(/^\| `(.+)` \| (.+) \|$/gm)];
    expect(rows.length).toBe(5);
    for (const [, text, sentence] of rows) {
      let caught: unknown;
      try {
        parseStatement(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QueryError);
      expect({ text, message: (caught as Error).message.includes(sentence) }).toEqual({ text, message: true });
    }
  });

  test("the generated preview and count are the generators' own text", () => {
    expect(DOC).toContain(previewStatement(["users"]));
    expect(DOC).toContain(countStatement(["users"]));
  });
});

describe("the limits table is LIMITS", () => {
  test.each([
    ["Default `runQuery` limit", count(LIMITS.defaultQueryLimit)],
    ["Largest `runQuery` limit", count(LIMITS.maxQueryLimit)],
    ["Largest `offset`", count(LIMITS.maxOffset)],
    ["References per `getAll`", count(LIMITS.maxGetAllRefs)],
    ["Aggregations per statement", `${count(LIMITS.minAggregations)} to ${count(LIMITS.maxAggregations)}`],
    ["`findNearest` limit", `${count(LIMITS.minNearestLimit)} to ${count(LIMITS.maxNearestLimit)}`],
    ["Query vector dimensions", count(LIMITS.maxVectorDimensions)],
    ["Documents a field expand samples", count(LIMITS.sampleDocuments)],
    ["Depth a sampled field path reaches", count(LIMITS.sampleDepth)],
    ["Fields a sample keeps", count(LIMITS.sampleFields)],
    ["Result columns", count(LIMITS.maxResultColumns)],
    ["Console text", bytes(LIMITS.maxConsoleBytes)],
    ["Console nesting depth", count(LIMITS.maxConsoleDepth)],
    ["Console tokens", count(LIMITS.maxConsoleTokens)],
    ["Keys page, default", count(LIMITS.keysPageDefault)],
    ["Keys page, largest", count(LIMITS.keysPageMax)],
    ["Documents per collection-level listing", count(LIMITS.collectionPageSizeMax)],
    ["Documents per collection-level listing without a names-only mask", count(LIMITS.collectionPageSizeUnmasked)],
    ["Id listing requests per level", count(LIMITS.idListingRequests)],
    ["Ids asked for per id listing request", count(LIMITS.idListingPageSize)],
    ["Rows `listDocuments()` answers", count(LIMITS.consoleListDocumentsRows)],
    ["Cursor envelope characters", count(LIMITS.cursorMaxChars)],
    ["Cursor envelope decoded bytes", count(LIMITS.cursorMaxDecodedBytes)],
    ["Answer cap for queries, `batchGet` and `listDocuments`", bytes(LIMITS.largeResponseBytes)],
    ["Answer cap for `get`, id listings, aggregations and the database resource", bytes(LIMITS.smallResponseBytes)],
    ["Answer cap for token and metadata answers", bytes(LIMITS.tokenResponseBytes)],
    ["Grace past the query timeout", `${LIMITS.deadlineGraceMs / 1000} s`],
  ])("%s", (label, value) => {
    expect(sectionOf("## 11. Limits")).toContain(`| ${label} | ${value} |`);
  });
});

describe("names, endpoints and declarations", () => {
  test("every environment variable the provider reads, and the fixed endpoints and scope", () => {
    for (const name of Object.values(ENV)) expect(DOC).toContain(`\`${name}\``);
    for (const value of [FIRESTORE_API_ORIGIN, GOOGLE_TOKEN_URL, FIRESTORE_SCOPE])
      expect(DOC).toContain(`\`${value}\``);
  });

  test("read-only and no MCP, as the records say", () => {
    expect(READ_ONLY_ENFORCED.firestore).toBe(true);
    expect(MCP_EXPOSABLE.firestore).toBe(false);
    expect(DOC).toContain("`READ_ONLY_ENFORCED.firestore` is true");
    expect(DOC).toContain("`MCP_EXPOSABLE.firestore` is false");
  });

  test("the Object edit (#789) heading and the endOpenQueryTransaction absence", () => {
    expect(DOC).toMatch(/^#{1,6} .*Object edit \(#789\)/m);
    expect(DOC).toContain("`endOpenQueryTransaction()`");
  });

  test("the three emulator recipes and the egress sentence", () => {
    expect(DOC).toContain("FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx @libredb/studio");
    expect(DOC).toContain("--add-host=host.docker.internal:host-gateway");
    expect(DOC).toContain("FIRESTORE_EMULATOR_HOST=firestore:8080");
    expect(DOC).toContain("`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` refuses a loopback emulator");
  });

  test("the billing table names every surface of spec 6 S6", () => {
    const billing = sectionOf("## 8. Billing");
    for (const surface of [
      "Connect, Test Connection, health, pulse, fleet health",
      "Tree root listing and count",
      "Field expand",
      "Bulk describe (inventory, plan-mode walk)",
      "Collection preview",
      "Keys panel, List more",
      "Keys panel, List all of this level",
      "Source tab",
      "Console statement",
      "Explain button",
      "Ordinary run",
      "Completions, generators, health, overview, monitoring",
    ])
      expect(billing).toContain(`| ${surface} |`);
  });
});
