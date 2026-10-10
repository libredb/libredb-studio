/**
 * Read-only, whatever the flag says. Through `createDatabaseProvider`,
 * with the connection's read-only flag off and on and with an execution profile's, every surface of the provider and
 * every console read reaches the server with GET or HEAD only, and every console write is refused with the parser's
 * sentence before any request. The recorder is a loopback listener answering as an S3 server, because a provider the
 * factory builds takes no test dependency.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { QueryError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { parseS3Command } from "@/lib/db/providers/objectstore/s3/console/commands";
import type { DatabaseProvider } from "@/lib/db/types";
import { s3Connection } from "../../../helpers/s3-connection";
import { bucketsXml, errorXml, objectsXml } from "../../../helpers/s3-fake-transport";

const CSV = "id,name\n1,alpha\n2,beta\n";
const methods: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    methods.push(request.method ?? "");
    const url = new URL(request.url ?? "/", "http://listener");
    const query = url.search.slice(1);
    const xml = (body: string, status = 200) => {
      response.writeHead(status, { "content-type": "application/xml", "content-length": Buffer.byteLength(body) });
      response.end(body);
    };
    if (url.pathname === "/") return xml(bucketsXml(["sales"]));
    if (url.pathname === "/sales") {
      if (request.method === "HEAD") {
        response.writeHead(200);
        return response.end();
      }
      if (query.includes("list-type=2"))
        return xml(objectsXml({ keys: [{ key: "a.csv", size: CSV.length }], prefixes: ["dir/"] }));
      if (query === "location=") return xml("<LocationConstraint/>");
      if (query === "versioning=") return xml("<VersioningConfiguration/>");
      if (query.includes("versions="))
        return xml("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
    }
    if (url.pathname === "/sales/a.csv") {
      if (query === "tagging=")
        return xml("<Tagging><TagSet><Tag><Key>env</Key><Value>probe</Value></Tag></TagSet></Tagging>");
      const headers = { "content-type": "text/csv", etag: '"e1"', "x-amz-tagging-count": "1" };
      if (request.method === "HEAD") {
        response.writeHead(200, { ...headers, "content-length": CSV.length });
        return response.end();
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      if (range === null) {
        response.writeHead(200, { ...headers, "content-length": CSV.length });
        return response.end(CSV);
      }
      const start = range[1] === "" ? CSV.length - Number(range[2]) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? CSV.length - 1 : Math.min(Number(range[2]), CSV.length - 1);
      response.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${CSV.length}`,
        "content-length": end - start + 1,
      });
      return response.end(CSV.slice(start, end + 1));
    }
    xml(errorXml("NoSuchKey", "The specified key does not exist."), 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

/** Every console read the command table admits, plus Studio's own preview. */
const READS = [
  "aws s3api list-buckets",
  "aws s3 ls",
  "aws s3 ls s3://sales/",
  "aws s3api list-objects-v2 --bucket sales",
  "aws s3api head-bucket --bucket sales",
  "aws s3api head-object --bucket sales --key a.csv",
  "aws s3api get-object-tagging --bucket sales --key a.csv",
  "aws s3api get-bucket-location --bucket sales",
  "aws s3api get-bucket-versioning --bucket sales",
  "aws s3api list-object-versions --bucket sales",
  "preview s3://sales/a.csv",
];

/** Write-shaped commands of both services: every one is refused before any request. */
const WRITES = [
  "aws s3 cp ./a.csv s3://sales/a.csv",
  "aws s3 rm s3://sales/a.csv",
  "aws s3 mb s3://new-bucket",
  "aws s3api put-object --bucket sales --key a.csv",
  "aws s3api delete-object --bucket sales --key a.csv",
  "aws s3api create-bucket --bucket new-bucket",
  "aws s3api put-bucket-versioning --bucket sales --versioning-configuration Status=Enabled",
];

describe.each([
  ["the read-only flag off", false, false],
  ["the connection's read-only flag on", true, false],
  ["an execution profile's read-only flag on", false, true],
])("with %s", (_name, readOnly, executionReadOnly) => {
  test("every surface and every console read sends GET or HEAD only; every write is refused before any request", async () => {
    methods.length = 0;
    const provider: DatabaseProvider = await createDatabaseProvider(
      s3Connection({ host: "127.0.0.1", port, readOnly }),
      {},
      { readOnly: executionReadOnly },
    );
    await provider.connect();
    const scanKeysPage = provider.scanKeysPage?.bind(provider);
    const readObjectSource = provider.readObjectSource?.bind(provider);
    expect(typeof scanKeysPage).toBe("function");
    expect(typeof readObjectSource).toBe("function");
    if (scanKeysPage === undefined || readObjectSource === undefined) return;
    /** Runs one surface call alone and proves it reached the server. */
    const sends = async (call: () => Promise<unknown>): Promise<void> => {
      const sent = methods.length;
      await call();
      expect(methods.length).toBeGreaterThan(sent);
    };
    // The listing runs before the count: a listing after a count takes the count's bucket list and sends nothing.
    await sends(() => provider.listObjects([], "bucket"));
    await sends(() => provider.countObjects([]));
    await sends(() => scanKeysPage({ cursor: "0", count: 10, pattern: "", level: true }));
    await sends(() => scanKeysPage({ cursor: "0", count: 10, pattern: "sales/", level: true }));
    await sends(() => readObjectSource(["sales"], "bucket"));
    await sends(() => readObjectSource(["sales/a.csv"], "object"));
    await sends(() => provider.getHealth());
    await sends(() => provider.getOverview());
    for (const text of READS) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, so every request is one command's.
      await sends(async () => {
        const result = await provider.query(text);
        expect(Array.isArray(result.rows)).toBe(true);
      });
    }
    const context = {
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      readOnly: readOnly || executionReadOnly,
    };
    for (const text of WRITES) {
      const parsed = parseS3Command(text, context);
      expect(parsed.ok).toBe(false);
      const sent = methods.length;
      // oxlint-disable-next-line no-await-in-loop -- the request count is read before and after each write alone.
      const error = await provider.query(text).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(parsed.ok ? "" : parsed.refusal.message);
      expect(methods.length).toBe(sent);
    }
    await provider.disconnect();
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(["GET", "HEAD"]));
  });
});
