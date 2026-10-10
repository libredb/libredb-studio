/**
 * The client on the wire: a raw `node:net` listener reads the bytes PR 1's real transport writes, as PR 1's own wire
 * test does. For every operation of the client the request line is exactly `objectPath` plus `s3Query`;
 * the Host sent is the Host signed; the Authorization signature verifies when recomputed from the received bytes, with
 * the canonical query rebuilt by sorting the received query and found equal to it; and `x-amz-date` is read at send
 * time, after a queue wait.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createNodeByteTransport } from "@/lib/db/http/node-transport";
import { createS3Client, type S3Client } from "@/lib/db/providers/objectstore/s3/client";
import { objectPath, s3Query } from "@/lib/db/providers/objectstore/s3/encoding";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { canonicalQueryOf, s3Signer, signatureV4 } from "@/lib/db/providers/objectstore/s3/sigv4";
import { bucketsXml, objectsXml } from "../../../helpers/s3-fake-transport";

interface Received {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
}

const CREDENTIALS = { accessKeyId: "AKIDTESTKEY", secretAccessKey: "test-secret-key" };
const received: Received[] = [];
const sockets = new Set<Socket>();
let server: Server;
let port = 0;
/** While set, the listener holds its answer to the request at index `holdAt` of `received` for this long. */
let holdFirstMs = 0;
let holdAt = 0;

function answerFor(request: Received): string {
  const xml = (body: string) =>
    `HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  if (request.method === "HEAD") return 'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nETag: "abc"\r\n\r\n';
  if (request.path === "/") return xml(bucketsXml(["sales"]));
  // One key under the prefix sent, so a level page stays inside its level.
  if (request.query.includes("list-type=2"))
    return xml(objectsXml({ keys: [`${new URLSearchParams(request.query).get("prefix") ?? ""}a.csv`] }));
  if (request.query === "location=") return xml("<LocationConstraint/>");
  if (request.query === "versioning=") return xml("<VersioningConfiguration/>");
  if (request.query.includes("versions="))
    return xml("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
  if (request.query === "tagging=") return xml("<Tagging><TagSet/></Tagging>");
  return 'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-2/3\r\nContent-Length: 3\r\nETag: "abc"\r\n\r\nabc';
}

function serve(socket: Socket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    for (let end = buffer.indexOf("\r\n\r\n"); end >= 0; end = buffer.indexOf("\r\n\r\n")) {
      const [line, ...headerLines] = buffer.slice(0, end).split("\r\n");
      buffer = buffer.slice(end + 4);
      const [method, target] = line.split(" ");
      const at = target.indexOf("?");
      const headers: Record<string, string> = {};
      for (const header of headerLines) {
        const colon = header.indexOf(":");
        headers[header.slice(0, colon).toLowerCase()] = header.slice(colon + 1).trim();
      }
      const request = {
        method,
        path: at < 0 ? target : target.slice(0, at),
        query: at < 0 ? "" : target.slice(at + 1),
        headers,
      };
      received.push(request);
      const hold = received.length === holdAt + 1 ? holdFirstMs : 0;
      setTimeout(() => socket.write(answerFor(request)), hold);
    }
  });
}

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  for (const socket of sockets) socket.destroy();
  server.close();
});

function clientWith(maxSockets: number): S3Client {
  return createS3Client(
    createNodeByteTransport({
      origin: { scheme: "http", host: "127.0.0.1", port },
      tls: null,
      maxSockets,
      headers: {},
      requestHeaderNames: ["range"],
      responseHeaders: S3_RESPONSE_HEADERS,
      signer: s3Signer(CREDENTIALS, "us-east-1", () => new Date()),
    }),
  );
}

const CALL = () => ({ signal: AbortSignal.timeout(10_000), deadline: Date.now() + 10_000 });

/** Recomputes the signature from what the listener received, and checks the Host and query rules. */
function verify(request: Received): void {
  const authorization = request.headers.authorization;
  const match =
    /^AWS4-HMAC-SHA256 Credential=AKIDTESTKEY\/(\d{8})\/us-east-1\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  expect(match).not.toBeNull();
  const [, day, signedList, signature] = match as RegExpExecArray;
  const signed = signedList.split(";");
  expect(signed).toContain("host");
  expect(signed).not.toContain("accept-encoding");
  expect(signed).not.toContain("connection");
  for (const name of Object.keys(request.headers)) if (name.startsWith("x-amz-")) expect(signed).toContain(name);
  expect(request.headers.host).toBe(`127.0.0.1:${port}`);
  expect(request.headers["x-amz-date"].slice(0, 8)).toBe(day);
  expect(canonicalQueryOf(request.query)).toBe(request.query);
  const recomputed = signatureV4(
    {
      method: request.method,
      canonicalUri: request.path,
      canonicalQuery: canonicalQueryOf(request.query),
      headers: Object.fromEntries(signed.map((name) => [name, request.headers[name]])),
      payloadHash: request.headers["x-amz-content-sha256"],
    },
    CREDENTIALS,
    { region: "us-east-1", service: "s3", amzDate: request.headers["x-amz-date"] },
  );
  expect(recomputed.split("Signature=")[1]).toBe(signature);
}

describe("every operation on the wire", () => {
  test.each([
    ["ListBuckets", (c: S3Client) => c.listBuckets(CALL()), "GET", "/", s3Query([["max-buckets", "10000"]])],
    ["HeadBucket", (c: S3Client) => c.headBucket("sales", CALL()), "HEAD", objectPath("sales"), ""],
    [
      "GetBucketLocation",
      (c: S3Client) => c.getBucketLocation("sales", CALL()),
      "GET",
      objectPath("sales"),
      "location=",
    ],
    [
      "GetBucketVersioning",
      (c: S3Client) => c.getBucketVersioning("sales", CALL()),
      "GET",
      objectPath("sales"),
      "versioning=",
    ],
    [
      "ListObjectsV2",
      (c: S3Client) =>
        c.listObjectsV2(
          { bucket: "sales", prefix: "sp/with space+plus/", delimiter: "/", maxKeys: 5, continuationToken: "a/b=c" },
          CALL(),
        ),
      "GET",
      objectPath("sales"),
      s3Query([
        ["list-type", "2"],
        ["prefix", "sp/with space+plus/"],
        ["delimiter", "/"],
        ["max-keys", "5"],
        ["encoding-type", "url"],
        ["continuation-token", "a/b=c"],
      ]),
    ],
    [
      "ListObjectVersions",
      (c: S3Client) => c.listObjectVersions({ bucket: "sales", prefix: "ver/", maxKeys: 10 }, CALL()),
      "GET",
      objectPath("sales"),
      s3Query([
        ["versions", ""],
        ["prefix", "ver/"],
        ["max-keys", "10"],
        ["encoding-type", "url"],
      ]),
    ],
    [
      "HeadObject",
      (c: S3Client) => c.headObject("sales", "keys/plus+sign.txt", CALL()),
      "HEAD",
      "/sales/keys/plus%2Bsign.txt",
      "",
    ],
    [
      "GetObject",
      (c: S3Client) =>
        c.getObjectRange(
          { bucket: "sales", key: "sp/./dot ü.txt", range: { first: 0, last: 2 }, maxBytes: 10, truncateAt: 10 },
          CALL(),
        ),
      "GET",
      "/sales/sp/./dot%20%C3%BC.txt",
      "",
    ],
    [
      "GetObjectTagging",
      (c: S3Client) => c.getObjectTagging("sales", "lit%2Fname.txt", CALL()),
      "GET",
      "/sales/lit%252Fname.txt",
      "tagging=",
    ],
  ])("%s", async (_name, run, method, path, query) => {
    received.length = 0;
    await run(clientWith(4));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method, path, query });
    verify(received[0]);
  });

  test("a ranged GET signs its range", async () => {
    received.length = 0;
    await clientWith(4).getObjectRange(
      { bucket: "sales", key: "a.csv", range: { first: 0, last: 2 }, maxBytes: 10 },
      CALL(),
    );
    expect(received[0].headers.range).toBe("bytes=0-2");
    expect(received[0].headers.authorization).toContain("SignedHeaders=host;range;");
    verify(received[0]);
  });
});

test("x-amz-date is read when a queued request leaves the queue", async () => {
  received.length = 0;
  holdFirstMs = 1_500;
  try {
    const client = clientWith(1);
    await Promise.all([client.listBuckets(CALL()), client.getBucketLocation("sales", CALL())]);
  } finally {
    holdFirstMs = 0;
  }
  const dates = received.map((request) => request.headers["x-amz-date"]);
  expect(dates[1] > dates[0]).toBe(true);
  for (const request of received) verify(request);
});

// -- the same requests from a Node child (on Node and Bun) ---------------------------------------------------------

/** What the child is handed: the modules it bundles, because Node loads neither TypeScript with `@/` imports nor this file. */
interface WireDeps {
  readonly createNodeByteTransport: typeof createNodeByteTransport;
  readonly createS3Client: typeof createS3Client;
  readonly S3_RESPONSE_HEADERS: typeof S3_RESPONSE_HEADERS;
  readonly s3Signer: typeof s3Signer;
}

interface WirePlan {
  readonly port: number;
  readonly credentials: typeof CREDENTIALS;
}

/**
 * Sent by the child, in this order: the nine operations of the table above, the ranged GET, then the queued pair. Its
 * text is bundled into the child, so it reads nothing outside its two arguments.
 */
async function runWire(deps: WireDeps, plan: WirePlan): Promise<{ readonly runtime: string }> {
  const call = () => ({ signal: AbortSignal.timeout(10_000), deadline: Date.now() + 10_000 });
  const clientWith = (maxSockets: number) =>
    deps.createS3Client(
      deps.createNodeByteTransport({
        origin: { scheme: "http", host: "127.0.0.1", port: plan.port },
        tls: null,
        maxSockets,
        headers: {},
        requestHeaderNames: ["range"],
        responseHeaders: deps.S3_RESPONSE_HEADERS,
        signer: deps.s3Signer(plan.credentials, "us-east-1", () => new Date()),
      }),
    );
  const client = clientWith(4);
  await client.listBuckets(call());
  await client.headBucket("sales", call());
  await client.getBucketLocation("sales", call());
  await client.getBucketVersioning("sales", call());
  await client.listObjectsV2(
    { bucket: "sales", prefix: "sp/with space+plus/", delimiter: "/", maxKeys: 5, continuationToken: "a/b=c" },
    call(),
  );
  await client.listObjectVersions({ bucket: "sales", prefix: "ver/", maxKeys: 10 }, call());
  await client.headObject("sales", "keys/plus+sign.txt", call());
  await client.getObjectRange(
    { bucket: "sales", key: "sp/./dot ü.txt", range: { first: 0, last: 2 }, maxBytes: 10, truncateAt: 10 },
    call(),
  );
  await client.getObjectTagging("sales", "lit%2Fname.txt", call());
  await client.getObjectRange({ bucket: "sales", key: "a.csv", range: { first: 0, last: 2 }, maxBytes: 10 }, call());
  const queued = clientWith(1);
  await Promise.all([queued.listBuckets(call()), queued.getBucketLocation("sales", call())]);
  client.close();
  queued.close();
  return { runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}` };
}

/** What the listener must receive from `runWire`, request by request, the same targets the Bun table pins. */
const NODE_EXPECTED = [
  { method: "GET", path: "/", query: s3Query([["max-buckets", "10000"]]) },
  { method: "HEAD", path: objectPath("sales"), query: "" },
  { method: "GET", path: objectPath("sales"), query: "location=" },
  { method: "GET", path: objectPath("sales"), query: "versioning=" },
  {
    method: "GET",
    path: objectPath("sales"),
    query: s3Query([
      ["list-type", "2"],
      ["prefix", "sp/with space+plus/"],
      ["delimiter", "/"],
      ["max-keys", "5"],
      ["encoding-type", "url"],
      ["continuation-token", "a/b=c"],
    ]),
  },
  {
    method: "GET",
    path: objectPath("sales"),
    query: s3Query([
      ["versions", ""],
      ["prefix", "ver/"],
      ["max-keys", "10"],
      ["encoding-type", "url"],
    ]),
  },
  { method: "HEAD", path: "/sales/keys/plus%2Bsign.txt", query: "" },
  { method: "GET", path: "/sales/sp/./dot%20%C3%BC.txt", query: "" },
  { method: "GET", path: "/sales/lit%252Fname.txt", query: "tagging=" },
  { method: "GET", path: "/sales/a.csv", query: "" },
  { method: "GET", path: "/", query: s3Query([["max-buckets", "10000"]]) },
  { method: "GET", path: objectPath("sales"), query: "location=" },
];

/** The index in NODE_EXPECTED of the queued pair's first request, which the listener holds. */
const QUEUED_FIRST = 10;

const SOURCES = join(import.meta.dir, "../../../../src/lib/db");
const dir = mkdtempSync(join(tmpdir(), "s3-client-wire-"));
const at = (file: string) => join(dir, file);

beforeAll(async () => {
  writeFileSync(
    at("child.ts"),
    [
      'import { readFileSync } from "node:fs";',
      `import { createNodeByteTransport } from ${JSON.stringify(join(SOURCES, "http/node-transport.ts"))};`,
      `import { createS3Client } from ${JSON.stringify(join(SOURCES, "providers/objectstore/s3/client.ts"))};`,
      `import { S3_RESPONSE_HEADERS } from ${JSON.stringify(join(SOURCES, "providers/objectstore/s3/headers.ts"))};`,
      `import { s3Signer } from ${JSON.stringify(join(SOURCES, "providers/objectstore/s3/sigv4.ts"))};`,
      `const runWire = ${runWire.toString()};`,
      'const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      "const report = await runWire({ createNodeByteTransport, createS3Client, S3_RESPONSE_HEADERS, s3Signer }, plan);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The runtime string a child of `binary` must report: what the Node binary prints. */
function expectedRuntime(binary: string): string {
  const printed = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (printed.exitCode !== 0) throw new Error(`${binary} --version exited ${printed.exitCode}`);
  return `node ${printed.stdout.toString().trim()}`;
}

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; an empty list or no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  if (listed !== undefined) {
    const binaries = listed.split(delimiter).filter((entry) => entry !== "");
    if (binaries.length === 0) throw new Error("NODE_TRANSPORT_NODES is set and lists no Node binary");
    return binaries;
  }
  const onPath = Bun.which("node");
  if (onPath === null) {
    throw new Error(
      "No node on PATH: this file runs the client under Node, the production runtime; install Node 24 or later",
    );
  }
  return [onPath];
}

for (const binary of nodeBinaries()) {
  describe(`the same requests from a Node child, ${binary}`, () => {
    let sent: Received[] = [];
    let runtime = "";

    beforeAll(async () => {
      const from = received.length;
      holdAt = from + QUEUED_FIRST;
      holdFirstMs = 1_500;
      try {
        writeFileSync(at("plan.json"), JSON.stringify({ port, credentials: CREDENTIALS } satisfies WirePlan));
        const child = Bun.spawn([binary, at("child.js"), at("plan.json")], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
        const line = stdout.trim().split("\n").at(-1);
        if (line === undefined || line === "") throw new Error(`The child ${binary} printed nothing: ${stderr}`);
        runtime = (JSON.parse(line) as { runtime: string }).runtime;
      } finally {
        holdAt = 0;
        holdFirstMs = 0;
      }
      sent = received.slice(from);
      console.log(`s3 client wire: ${binary} ran as ${runtime}`);
    }, 120_000);

    test("the child ran on the runtime it was asked for", () => {
      expect(runtime).toBe(expectedRuntime(binary));
    });

    test("every request arrived as on Bun, and every signature verifies", () => {
      expect(sent.map(({ method, path, query }) => ({ method, path, query }))).toEqual(NODE_EXPECTED);
      for (const request of sent) verify(request);
    });

    test("the ranged GET signed its range", () => {
      expect(sent[QUEUED_FIRST - 1].headers.range).toBe("bytes=0-2");
      expect(sent[QUEUED_FIRST - 1].headers.authorization).toContain("SignedHeaders=host;range;");
    });

    test("x-amz-date is read when a queued request leaves the queue", () => {
      expect(sent[QUEUED_FIRST + 1].headers["x-amz-date"] > sent[QUEUED_FIRST].headers["x-amz-date"]).toBe(true);
    });
  });
}
