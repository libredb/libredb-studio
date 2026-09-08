/**
 * Unit tests for the AWS Marketplace listing copy (deploy/aws/listing).
 *
 * The AWS Marketplace Management Portal is the only place these values exist -
 * a human pastes them in - so nothing here can be checked by a build. What CAN
 * be checked before the paste is what AWS rejects on submission: a field over
 * its character limit, a non-ASCII character (the portal accepts ASCII 0-126
 * plus (R), (C), (TM) and currency symbols, so an em dash or a curly quote
 * copied out of our own prose is a silent rejection), a competing cloud named
 * in the copy, and an engine list that has drifted away from the code.
 *
 * The engine count is asserted against EXTERNAL_DATABASE_TYPES, which
 * src/lib/db/compatibility.ts names as the denominator for outward-facing
 * catalog copy, so a new provider cannot land without this test noticing that
 * the marketplace copy still claims the old count. The numeral-versus-list rule
 * itself belongs to the repo-wide gate in
 * tests/unit/lib/catalog-copy-engine-count.test.ts, which these files are
 * registered with.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const LISTING = path.join(__dirname, "../../deploy/aws/listing");
const AMI = path.join(__dirname, "../../deploy/aws/ami");

const read = (file: string): string => fs.readFileSync(path.join(LISTING, file), "utf8");

const listingFields = read("listing-fields.md");
const description = read("description.md");
const usage = read("usage-instructions.md");

/** Body of a `## <heading>` section, comments and blank lines removed. */
const section = (source: string, heading: string): string => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => !line.trim().startsWith("<!--"))
    .join("\n")
    .trim();
};

const bullets = (body: string): string[] =>
  body
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => line.trim().slice(2).trim());

/** The marketplace copy is prose, not markdown - the text is what gets pasted. */
const descriptionText = description
  .split("\n")
  .filter((line) => !line.trim().startsWith("<!--") && !line.startsWith("#"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("AWS Marketplace listing fields", () => {
  test("product description fits the field limit the file itself declares", () => {
    // The marker is read rather than duplicated here: a limit kept in two places
    // is a limit that will disagree with itself.
    const limit = Number(/<!-- limit:(\d+) -->/.exec(description)?.[1]);
    expect(limit).toBe(350);
    expect(descriptionText.length).toBeGreaterThan(0);
    expect(descriptionText.length).toBeLessThanOrEqual(limit);
  });

  test("the product title fits the limit its section declares", () => {
    const body = listingFields.split("## Product title")[1] ?? "";
    const limit = Number(/<!-- limit:(\d+) -->/.exec(body)?.[1]);
    expect(limit).toBeGreaterThan(0);
    const title = body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("<!--") && !line.startsWith("#"));
    expect(title).toBe("LibreDB Studio");
    expect((title as string).length).toBeLessThanOrEqual(limit);
  });

  test("at most three highlights", () => {
    const highlights = bullets(section(listingFields, "Product highlights"));
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.length).toBeLessThanOrEqual(3);
  });

  test("at most three keywords, 250 characters in total", () => {
    const keywords = bullets(section(listingFields, "Search keywords"));
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.length).toBeLessThanOrEqual(3);
    expect(keywords.join(", ").length).toBeLessThanOrEqual(250);
  });

  test("every listing file stays inside the character set the portal accepts", () => {
    // Printable ASCII plus the whitespace this file needs, and the four symbol
    // classes AWS documents. Written with escapes rather than literal bytes: an
    // earlier revision held a raw NUL here, which made git classify this file as
    // binary and render no diff for it in review.
    const allowed = /^[\n\r\t\x20-\x7e©®™¢-¥€₺]*$/;
    for (const [name, body] of [
      ["listing-fields.md", listingFields],
      ["description.md", description],
      ["usage-instructions.md", usage],
    ] as const) {
      const offenders = [...body].filter((ch) => !allowed.test(ch));
      expect({ name, offenders: [...new Set(offenders)] }).toEqual({ name, offenders: [] });
    }
  });

  test("the engine claim is counted against the documented denominator", () => {
    // EXTERNAL_DATABASE_TYPES is what src/lib/db/compatibility.ts names as the
    // denominator for outward-facing catalog copy - the shipped ids minus the
    // embedded store. The factory's error message is a hand-kept string that the
    // repo itself documents as not type-checked, so counting against it would
    // drift silently.
    const claimed = listingFields.match(/<!-- engines:(\d+) -->/);
    expect(claimed).not.toBeNull();
    expect(Number((claimed as RegExpMatchArray)[1])).toBe(EXTERNAL_DATABASE_TYPES.length);

    // Every engine the copy names by product name must still be shipped. The
    // repo-wide gate in tests/unit/lib/catalog-copy-engine-count.test.ts owns the
    // numeral-versus-list rule; this only catches a name that left the product.
    const productNames: Record<string, string> = {
      PostgreSQL: "postgres",
      MySQL: "mysql",
      SQLite: "sqlite",
      MongoDB: "mongodb",
      Redis: "redis",
      Oracle: "oracle",
      "SQL Server": "mssql",
      Couchbase: "couchbase",
      ClickHouse: "clickhouse",
      Druid: "druid",
      Elasticsearch: "elasticsearch",
      OpenSearch: "opensearch",
      Cassandra: "cassandra",
      Trino: "trino",
      libSQL: "libsql",
      DuckDB: "duckdb",
    };
    const copy = [listingFields, description, usage].join("\n");
    for (const [product, id] of Object.entries(productNames)) {
      if (copy.includes(product)) expect(EXTERNAL_DATABASE_TYPES).toContain(id as never);
    }
  });

  test("no listing text advertises another cloud or marketplace", () => {
    // AWS policy: product metadata must not redirect buyers to other platforms.
    // The AMI's own buyer-facing strings are held to the same rule.
    const forbidden = /\b(Azure|Google Cloud|DigitalOcean|Fly\.io|Heroku|Alibaba Cloud|Oracle Cloud)\b/;
    const amiFiles = fs
      .readdirSync(path.join(AMI, "files"), { recursive: true, encoding: "utf8" })
      .map((entry) => path.join(AMI, "files", entry))
      .filter((entry) => fs.statSync(entry).isFile());
    for (const file of [
      path.join(LISTING, "listing-fields.md"),
      path.join(LISTING, "description.md"),
      path.join(LISTING, "usage-instructions.md"),
      ...amiFiles,
    ]) {
      expect({ file, hit: forbidden.exec(fs.readFileSync(file, "utf8"))?.[0] ?? null }).toEqual({
        file,
        hit: null,
      });
    }
  });
});
