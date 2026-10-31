/**
 * The structural closed table of S3's agent path: the agent modules reach the server only through `S3AgentClient`,
 * whose members are the six reads, and every request an agent-mode handle sends, on any surface and for any command,
 * is one of the closed table's request shapes, each a GET or a HEAD with no prefix, delimiter, Range or object GET.
 *
 * Both directions are proven: the real sources and the real handle pass, and a planted call, import or request fails
 * by name.
 */
// oxlint-disable no-await-in-loop -- each command runs after the one before, so each request is one command's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { S3_AGENT_CLIENT_MEMBERS } from "@/lib/db/providers/objectstore/s3/client";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import type { ProviderExecutionContext } from "@/lib/db/types";
import { s3Connection } from "../../../helpers/s3-connection";
import {
  bucketsXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const ROOT = posix.join(import.meta.dir.replaceAll("\\", "/"), "..", "..", "..", "..");
const S3 = "src/lib/db/providers/objectstore/s3";
const AGENT_MODULES = ["agent-metadata-read.ts", "agent-surface.ts", "agent-statement.ts"] as const;

/** What the agent modules may import from the client module: the agent client's type and the shapes it answers. */
const CLIENT_IMPORTS: ReadonlySet<string> = new Set([
  "S3AgentClient",
  "S3CallOptions",
  "ObjectHead",
  "VersioningState",
]);

/** Each import of `./client` an agent module names, and every `client.<member>(` call it makes. */
function findings(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']\.\/client["']/g)) {
    for (const name of match[1].split(",").map((part) => part.replace(/^\s*type\s+/, "").trim())) {
      if (name !== "" && !CLIENT_IMPORTS.has(name)) found.push(`${file} imports ${name} from the client module`);
    }
  }
  for (const match of source.matchAll(/\bclient\.(\w+)\s*\(/g)) {
    if (!(S3_AGENT_CLIENT_MEMBERS as readonly string[]).includes(match[1]))
      found.push(`${file} calls client.${match[1]}, which the agent client does not hold`);
  }
  for (const name of ["createS3Client", "limitedS3Client", "getObjectRange", "previewObject", "scanS3KeysPage"]) {
    if (new RegExp(`\\b${name}\\b`).test(source)) found.push(`${file} names ${name}`);
  }
  return found;
}

/** The request shapes of the closed table, each anchored at both ends: a whole bucket's page carries an empty prefix. */
const TABLE: readonly RegExp[] = [
  /^GET \/\?max-buckets=10000$/,
  /^HEAD \/[A-Za-z0-9._-]+$/,
  /^GET \/[A-Za-z0-9._-]+\?location=$/,
  /^GET \/[A-Za-z0-9._-]+\?versioning=$/,
  /^GET \/[A-Za-z0-9._-]+\?(?:continuation-token=[^&]+&)?encoding-type=url&list-type=2&max-keys=\d+&prefix=$/,
  /^HEAD \/[A-Za-z0-9._-]+\/[^?]+$/,
];

const outsideTheTable = (lines: readonly string[]) => lines.filter((line) => !TABLE.some((shape) => shape.test(line)));

describe("the agent modules' reach", () => {
  test.each(AGENT_MODULES)("%s reaches the server only through the agent client's members", (file) => {
    expect(findings(file, readFileSync(posix.join(ROOT, S3, file), "utf8"))).toEqual([]);
  });

  test.each([
    ['import { createS3Client } from "./client";', "agent-surface.ts imports createS3Client from the client module"],
    ['import type { S3Client } from "./client";', "agent-surface.ts imports S3Client from the client module"],
    [
      "await client.getObjectRange(request, call);",
      "agent-surface.ts calls client.getObjectRange, which the agent client does not hold",
    ],
    [
      "await client.listObjectsV2(request, call);",
      "agent-surface.ts calls client.listObjectsV2, which the agent client does not hold",
    ],
    [
      "await client.getObjectTagging(b, k, call);",
      "agent-surface.ts calls client.getObjectTagging, which the agent client does not hold",
    ],
  ])("a planted %p fails by name", (planted, finding) => {
    expect(findings("agent-surface.ts", planted)).toContain(finding);
  });

  test("the provider hands the agent's reads the agent client alone", () => {
    const index = readFileSync(posix.join(ROOT, S3, "index.ts"), "utf8");
    for (const call of index.matchAll(
      /\b(runS3AgentRead|agentCountObjects|agentListObjects|agentHealth|agentProbe)\(([^,]+),/g,
    )) {
      expect(["session.agentClient", "client"], call[0]).toContain(call[2].trim());
    }
    expect(index).toContain("agentClient: createS3AgentClient(transport, this.limiter)");
  });
});

/** A server that answers every request shape, so a surface that sent anything outside the table would be seen. */
const SERVER: FakeS3Handler = (request) => {
  const { path, query } = request.target;
  if (path === "/") return xmlAnswer(bucketsXml(["sales"]));
  if (request.method === "HEAD") return { status: 200, headers: [["content-length", "1"]] };
  if (query.includes("location")) return xmlAnswer("<LocationConstraint/>");
  if (query.includes("versioning")) return xmlAnswer("<VersioningConfiguration/>");
  return xmlAnswer(objectsXml({ keys: ["a"] }));
};

/** Commands an attacker would write, every one of which must send nothing or only a request of the table. */
const COMMANDS = [
  "aws s3api list-buckets",
  "aws s3api head-bucket --bucket sales",
  "aws s3api get-bucket-location --bucket sales",
  "aws s3api get-bucket-versioning --bucket sales",
  "aws s3 ls s3://sales --recursive --summarize",
  "aws s3api head-object --bucket sales --key 'a/b c.txt'",
  "aws s3api head-object --bucket sales --key %2e%2e/x",
  "aws s3api head-object --bucket sales --key ..%2Fx",
  "aws s3api get-object --bucket sales --key a out",
  "aws s3api get-object --bucket sales --key a --range bytes=0-9 out",
  "aws s3api head-object --bucket sales --key a --range bytes=0-9",
  "aws s3api head-object --bucket sales --key a --part-number 1",
  "aws s3api head-object --bucket sales --key a --checksum-mode ENABLED",
  "aws s3api list-objects-v2 --bucket sales",
  "aws s3api list-objects-v2 --bucket sales --prefix a",
  "aws s3api list-objects-v2 --bucket sales --start-after a",
  "aws s3api list-object-versions --bucket sales",
  "aws s3api get-object-tagging --bucket sales --key a",
  "aws s3api get-bucket-policy --bucket sales",
  "aws s3api get-bucket-acl --bucket sales",
  "preview s3://sales/a",
  "aws s3 ls s3://sales/a --recursive --summarize",
  "aws s3 cp s3://sales/a -",
  "aws s3api put-object --bucket sales --key a",
  "aws s3api delete-object --bucket sales --key a",
  "aws s3api head-bucket --bucket sales --endpoint-url http://other.example:9000",
  "aws s3api head-bucket --bucket sales --region eu-west-1",
  "aws s3 presign s3://sales/a",
];

describe("every request an agent-mode handle sends", () => {
  test.each([
    ["the agent read-only profile", { readOnly: true, sendsStatements: true }],
    ["the agent operations profile", { readOnly: true, sendsStatements: false }],
  ] as const)("on %s is a request of the closed table", async (_name, execution: ProviderExecutionContext) => {
    for (const overrides of [{}, { database: "sales" }]) {
      const fake = fakeS3Transport(SERVER);
      const s3 = new S3Provider(s3Connection(overrides), {}, execution, { createTransport: fake.createTransport });
      await s3.connect();
      const budget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 1_000_000 };
      for (const command of COMMANDS) {
        await s3.queryReadOnly(command, budget).catch(() => undefined);
        await s3.query(command).catch(() => undefined);
      }
      await s3.countObjects([]).catch(() => undefined);
      await s3.listObjects([], "bucket").catch(() => undefined);
      await s3.listObjects([], "object").catch(() => undefined);
      await s3.readObjectSource(["sales"], "bucket").catch(() => undefined);
      await s3.readObjectSource(["sales/a"], "object").catch(() => undefined);
      await s3.scanKeysPage({ cursor: "0", count: 10, pattern: "", level: true }).catch(() => undefined);
      await s3.getHealth().catch(() => undefined);
      await s3.getOverview().catch(() => undefined);
      expect(fake.lines().length).toBeGreaterThan(0);
      expect(outsideTheTable(fake.lines())).toEqual([]);
      expect(fake.exchanges.every(({ request }) => request.headers?.range === undefined)).toBe(true);
    }
  });

  test("a request outside the table is seen", () => {
    expect(
      outsideTheTable([
        "GET /sales/a",
        "GET /sales?encoding-type=url&list-type=2&max-keys=1&prefix=a",
        "GET /sales?delimiter=%2F&encoding-type=url&list-type=2&max-keys=1&prefix=",
        "GET /sales/a?tagging=",
        "GET /sales?encoding-type=url&max-keys=1&prefix=&versions=",
        "PUT /sales/a",
        "GET /sales?policy=",
      ]),
    ).toHaveLength(7);
  });
});
