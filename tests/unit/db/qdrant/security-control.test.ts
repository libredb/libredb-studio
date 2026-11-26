/**
 * docs/SECURITY.md control 0.6 names the shared REST transport and the Qdrant client that rides on it (vector-family
 * spec 3.7, QE2): the repair of PR 3h left node-transport.ts and its tests out of the row until a provider used the
 * transport, and the Qdrant REST client is that provider. scripts/security-check.mjs, run by
 * tests/unit/security-check.test.ts, proves every file the row links exists and every test it links runs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const ROW = SECURITY.split("\n").find((line) => line.startsWith("| 0.6 |")) ?? "";
const [, , status, enforcedIn, verifiedBy] = ROW.split(" | ");

describe("control 0.6 names the shared transport and its first consumer", () => {
  test("is an implemented control", () => {
    expect(status).toBe("Implemented");
  });

  test.each(["src/lib/db/http/node-transport.ts", "src/lib/db/providers/vector/qdrant/rest-client.ts"])(
    "enforced in %s",
    (file) => {
      expect(enforcedIn).toContain(`[\`${file}\`](../${file})`);
    },
  );

  test.each([
    "tests/unit/db/http/node-transport.test.ts",
    "tests/unit/db/http/node-transport-tls.test.ts",
    "tests/unit/db/http/node-transport-tls-material.test.ts",
    "tests/unit/db/http/node-transport-guard.test.ts",
    "tests/unit/db/http/node-transport-guard-lookup.test.ts",
    "tests/unit/db/http/node-transport-runtimes.test.ts",
    "tests/unit/db/qdrant/rest-client.test.ts",
    "tests/unit/db/qdrant/rest-client-wire.test.ts",
  ])("verified by %s", (file) => {
    expect(verifiedBy).toContain(`[\`${file}\`](../${file})`);
  });
});

/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");
/** The public inference statement of the vector-family spec, word for word. */
const INFERENCE_STATEMENT =
  "Studio refuses every Qdrant inference object (a text, image or object input with a model) except the local BM25 model, in every release. A request with such an input makes the Qdrant server call an inference service that the operator configured, passing the input, any request header ending in -api-key and the caller's identity; some hosted models are billed; and a statement could carry a third-party API key into query history. Studio never sends these inputs, so the console cannot trigger that path.";
/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading. */
function bulletOf(text: string, head: string): string {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) throw new Error(`no bullet ${head}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}
/** One fragment per stated limit, in the order the spec lists them, and the key guidance of spec 6.2. */
const LIMIT_FRAGMENTS: readonly string[] = [
  "Vectors and payloads reach query history and saved queries",
  "Any read credential can download whole snapshots and read the server's telemetry outside Studio.",
  "A collection-scoped token with write access can delete a named vector from every point of its collection outside Studio.",
  "The Qdrant server logs every request's path and query string, so collection names appear in its log.",
  "A stopped query runs on the server until its server timeout, and an exact count runs past it until it completes.",
  "any user who knows a run's id can cancel it",
  "Studio cannot tell what an opaque key can do",
  "A Qdrant server without `service.api_key`, its default, accepts any key or none",
  "Prefer a read-only or collection-scoped key, or a JWT with an expiry.",
  "The server's own egress, its inference calls and its snapshot recovery included, is outside the HTTP egress guard.",
  "TLS mode `require` sends the API key to an unverified peer.",
  "An empty tree is what a scoped token, an alias-only token and an empty server all produce.",
  "A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.",
  "Studio withholds only the forms it lists.",
];

describe("SECURITY.md's Qdrant inference statement, bullet and plaintext rule", () => {
  test("SECURITY.md note 3.11 is the public inference statement, word for word", () => {
    const start = SECURITY.indexOf("**3.11.**");
    expect(start).toBeGreaterThan(-1);
    const note = SECURITY.slice(start, SECURITY.indexOf("\n\n", start));
    expect(flat(note)).toBe(`**3.11.** ${INFERENCE_STATEMENT}`);
  });

  const bullet = bulletOf(SECURITY, "**Qdrant is reached over a REST client of Studio's own.**");
  test.each([...LIMIT_FRAGMENTS])("the Qdrant bullet keeps: %s", (fragment) => {
    expect(flat(bullet)).toContain(fragment);
  });

  test("the plaintext rule and row 3.8 name Qdrant", () => {
    expect(bullet).toContain(
      "A Qdrant API key or JWT over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection.",
    );
    expect(SECURITY).toContain("Qdrant's runs reads only, so the mode changes nothing a request can do today");
  });
});
