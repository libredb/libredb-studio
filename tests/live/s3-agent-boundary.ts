/**
 * Seeds the S3 server an agent-boundary/<set>/run.sh started, runs the agent's own reads and every agent-mode surface
 * through the provider, sends every call the agent's closed table refuses raw, and writes what the server answered,
 * with a fingerprint of the server's objects before and after, into that run.sh's directory.
 *
 *   bun tests/live/s3-agent-boundary.ts
 *
 * The environment names the server: S3_AGENT_SERVER (silo, rustfs or garage), S3_AGENT_IMAGE (the image with its digest),
 * S3_AGENT_PORT (its S3 port on 127.0.0.1), S3_AGENT_OUT (the directory to write) and S3_AGENT_ROOT_KEY,
 * S3_AGENT_ROOT_SECRET, S3_AGENT_READER_KEY and S3_AGENT_READER_SECRET, the root key the server was started with and
 * the reader run.sh created, each made for the run by run.sh. The reader holds the read policy beside run.sh: it may
 * list buckets and objects and versions and read objects, tags, locations and versioning, and write nothing; on Garage,
 * which has no policies, run.sh creates the two buckets and grants the reader read alone and root read, write and
 * owner on each. Garage keeps no object versions, so its snapshot is the object listing.
 *
 * The refused calls are signed here and sent with node:http, never through the provider: no Studio check stands in
 * front of them, which is the point, since what is measured is what the server does on its own with each one. Each is
 * sent as the reader and then as root, the writable positive control. A refused call is recorded by its HTTP status
 * and, for an answer that could carry a stored value, by whether it carried the seeded marker, never by its body.
 *
 * Nothing written holds a credential: no access key id or secret, not even as a placeholder, and the script refuses to
 * write a capture that holds any of the four values.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  createNodeByteTransport,
  type NodeByteTransport,
  type NodeByteTransportOptions,
} from "@/lib/db/http/node-transport";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { amzDateOf, canonicalQueryOf, signatureV4 } from "@/lib/db/providers/objectstore/s3/sigv4";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const SERVER = env("S3_AGENT_SERVER");
if (SERVER !== "silo" && SERVER !== "rustfs" && SERVER !== "garage")
  throw new Error("S3_AGENT_SERVER is silo, rustfs or garage");
const GARAGE = SERVER === "garage";
const IMAGE = env("S3_AGENT_IMAGE");
const PORT = Number(env("S3_AGENT_PORT"));
const OUT = env("S3_AGENT_OUT");
const ROOT = { accessKeyId: env("S3_AGENT_ROOT_KEY"), secretAccessKey: env("S3_AGENT_ROOT_SECRET") };
const READER = { accessKeyId: env("S3_AGENT_READER_KEY"), secretAccessKey: env("S3_AGENT_READER_SECRET") };
const CREDENTIAL_VALUES = [ROOT.accessKeyId, ROOT.secretAccessKey, READER.accessKeyId, READER.secretAccessKey];
const REGION = GARAGE ? "garage" : "us-east-1";
const HOST = "127.0.0.1";
const DATE = new Date().toISOString().slice(0, 10);

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

/** What the seeded objects carry: none may reach an agent answer. */
const MARKERS = {
  body: "agent-marker-body",
  metadata: "agent-marker-metadata",
  tag: "agent-marker-tag",
  /** A key no agent command names: its path must never reach an answer. */
  unnamedKey: "agent-marker-tenant",
} as const;
const BUCKETS = { demo: "agent-demo", versions: "agent-versions", missing: "agent-missing" } as const;
/** The one key the agent's commands name, and the objects no command names. */
const NAMED_KEY = "named/report.csv";
const UNNAMED_KEYS = [`${MARKERS.unnamedKey}/payroll.csv`, `${MARKERS.unnamedKey}/notes.txt`, "raw/delete-me.txt"];

interface RawAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** One request signed for `who` with an unsigned payload and sent with node:http, past every Studio check. */
function raw(
  who: typeof ROOT,
  method: string,
  pathname: string,
  query = "",
  body: Buffer = Buffer.alloc(0),
  extra: Readonly<Record<string, string>> = {},
): Promise<RawAnswer> {
  const amzDate = amzDateOf(new Date());
  const host = `${HOST}:${PORT}`;
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    ...extra,
  };
  const authorization = signatureV4(
    {
      method,
      canonicalUri: pathname,
      canonicalQuery: canonicalQueryOf(query),
      headers,
      payloadHash: "UNSIGNED-PAYLOAD",
    },
    who,
    { region: REGION, service: "s3", amzDate },
  );
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      {
        host: HOST,
        port: PORT,
        method,
        path: query === "" ? pathname : `${pathname}?${query}`,
        headers: { ...headers, authorization, "content-length": String(body.length) },
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () =>
          resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks) }),
        );
        answer.on("error", reject);
      },
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

async function must(answer: Promise<RawAnswer>, what: string): Promise<RawAnswer> {
  const settled = await answer;
  if (settled.status < 200 || settled.status >= 300) throw new Error(`${what} answered HTTP ${settled.status}`);
  return settled;
}

/** The seeded buckets and objects; the ETags and version ids the server gave are collected, never written. */
async function seed(): Promise<{ readonly etags: string[]; readonly versionIds: string[]; readonly tagged: boolean }> {
  const etags: string[] = [];
  const versionIds: string[] = [];
  let tagged = true;
  // Garage's buckets are run.sh's, made through its admin API, and Garage keeps no versions.
  if (!GARAGE) {
    for (const bucket of [BUCKETS.demo, BUCKETS.versions])
      await must(raw(ROOT, "PUT", `/${bucket}`), `create ${bucket}`);
    await must(
      raw(
        ROOT,
        "PUT",
        `/${BUCKETS.versions}`,
        "versioning=",
        Buffer.from(
          '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
        ),
      ),
      "enable versioning",
    );
  }
  const put = async (bucket: string, key: string, body: string) => {
    const headers = { "x-amz-meta-owner": MARKERS.metadata, "content-type": "text/csv" };
    const pathname = `/${bucket}/${encodeKey(key)}`;
    let answer = await raw(ROOT, "PUT", pathname, "", Buffer.from(body), {
      ...headers,
      "x-amz-tagging": `owner=${MARKERS.tag}`,
    });
    // A server that refuses a tag on a PUT stores the object untagged, and the capture says so.
    if (answer.status >= 300) {
      tagged = false;
      answer = await raw(ROOT, "PUT", pathname, "", Buffer.from(body), headers);
    }
    if (answer.status >= 300) throw new Error(`put ${key} answered HTTP ${answer.status}`);
    const etag = answer.headers.etag;
    if (typeof etag === "string") etags.push(etag.replaceAll('"', ""));
    const version = answer.headers["x-amz-version-id"];
    if (typeof version === "string" && version !== "null") versionIds.push(version);
  };
  for (const key of [NAMED_KEY, ...UNNAMED_KEYS]) await put(BUCKETS.demo, key, `id,${MARKERS.body}\n1,${key.length}\n`);
  // Two versions of the named key, so a version id exists to leak.
  for (const round of [1, 2]) await put(BUCKETS.versions, NAMED_KEY, `round ${round},${MARKERS.body}\n`);
  return { etags, versionIds, tagged };
}

/** Every bucket's object versions and versioning status, as root lists them: a digest and counts, never the names. */
async function snapshot(): Promise<{ readonly digest: string; readonly objects: number }> {
  const parts: string[] = [];
  let objects = 0;
  for (const bucket of [BUCKETS.demo, BUCKETS.versions]) {
    const versions = await must(
      raw(ROOT, "GET", `/${bucket}`, GARAGE ? "list-type=2" : "versions="),
      `list versions of ${bucket}`,
    );
    const text = versions.body.toString("utf8");
    const entries = [...text.matchAll(/<(Version|DeleteMarker|Contents)>([\s\S]*?)<\/\1>/g)].map((match) =>
      [
        match[1],
        ...["Key", "VersionId", "Size", "ETag"].map(
          (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(match[2])?.[1] ?? "",
        ),
      ].join("|"),
    );
    objects += entries.length;
    const versioning = await raw(ROOT, "GET", `/${bucket}`, "versioning=");
    parts.push(bucket, ...entries.sort(), `${versioning.status}`, versioning.body.toString("utf8").replace(/\s+/g, ""));
  }
  return { digest: createHash("sha256").update(parts.join("\n")).digest("hex"), objects };
}

/** The provider over the production transport, with every request it sends recorded as "METHOD path?query". */
function studio(who: typeof ROOT, execution: ProviderExecutionContext, pin?: string) {
  const lines: string[] = [];
  const createTransport = (options: NodeByteTransportOptions): NodeByteTransport => {
    const transport = createNodeByteTransport(options);
    return {
      request(request) {
        const { path: target, query } = request.target;
        lines.push(`${request.method} ${target}${query === "" ? "" : `?${query}`}`);
        return transport.request(request);
      },
      close: () => transport.close(),
    };
  };
  const connection = {
    id: `s3-agent-${SERVER}`,
    name: `S3 agent ${SERVER}`,
    type: "s3",
    host: HOST,
    port: PORT,
    user: who.accessKeyId,
    password: who.secretAccessKey,
    region: REGION,
    ...(pin === undefined ? {} : { database: pin }),
    createdAt: new Date(0),
  } as DatabaseConnection;
  return { provider: new S3Provider(connection, {}, execution, { createTransport }), lines };
}

interface AgentRecord {
  readonly statement: string;
  readonly as: "reader" | "root";
  readonly pinned?: string;
  readonly requests: readonly string[];
  readonly fields?: readonly string[];
  readonly rows?: readonly unknown[];
  readonly warnings?: readonly string[];
  readonly refused?: string;
}

const AGENT_READS: readonly string[] = [
  "aws s3api list-buckets",
  `aws s3api head-bucket --bucket ${BUCKETS.demo}`,
  `aws s3api head-bucket --bucket ${BUCKETS.missing}`,
  `aws s3api get-bucket-location --bucket ${BUCKETS.demo}`,
  `aws s3api get-bucket-versioning --bucket ${BUCKETS.demo}`,
  `aws s3api get-bucket-versioning --bucket ${BUCKETS.versions}`,
  `aws s3 ls s3://${BUCKETS.demo} --recursive --summarize`,
  `aws s3 ls s3://${BUCKETS.versions}/ --recursive --summarize`,
  `aws s3 ls s3://${BUCKETS.missing} --recursive --summarize`,
  `aws s3api head-object --bucket ${BUCKETS.demo} --key ${NAMED_KEY}`,
  `aws s3api head-object --bucket ${BUCKETS.versions} --key ${NAMED_KEY}`,
  `aws s3api head-object --bucket ${BUCKETS.demo} --key named/absent.csv`,
  `aws s3api head-object --bucket ${BUCKETS.missing} --key ${NAMED_KEY}`,
];

/** Commands the closed table refuses: each must send nothing. */
const REFUSED_COMMANDS: readonly string[] = [
  `aws s3api list-objects-v2 --bucket ${BUCKETS.demo}`,
  `aws s3api list-objects-v2 --bucket ${BUCKETS.demo} --prefix agent`,
  `aws s3api list-object-versions --bucket ${BUCKETS.versions}`,
  `aws s3api get-object-tagging --bucket ${BUCKETS.demo} --key ${NAMED_KEY}`,
  `preview s3://${BUCKETS.demo}/${NAMED_KEY}`,
  `aws s3api get-object --bucket ${BUCKETS.demo} --key ${NAMED_KEY} out.csv`,
  `aws s3 ls s3://${BUCKETS.demo}/agent --recursive --summarize`,
  `aws s3api put-object --bucket ${BUCKETS.demo} --key raw/agent.txt`,
  `aws s3api delete-object --bucket ${BUCKETS.demo} --key ${NAMED_KEY}`,
  `aws s3api head-object --bucket ${BUCKETS.demo} --key ${NAMED_KEY} --endpoint-url http://${HOST}:${PORT}`,
];

async function agentRecord(
  who: "reader" | "root",
  statement: string,
  budget: ReadOnlyStatementBudget = BUDGET,
  pin?: string,
): Promise<AgentRecord> {
  const { provider, lines } = studio(who === "reader" ? READER : ROOT, READ_ONLY, pin);
  await provider.connect();
  const before = lines.length;
  const base = { statement, as: who, ...(pin === undefined ? {} : { pinned: pin }) };
  try {
    const result = await provider.queryReadOnly(statement, budget);
    return {
      ...base,
      requests: lines.slice(before),
      fields: result.fields,
      rows: result.rows,
      ...(result.warnings === undefined ? {} : { warnings: result.warnings.map((warning) => warning.message) }),
    };
  } catch (error) {
    return { ...base, requests: lines.slice(before), refused: (error as Error).message };
  } finally {
    await provider.disconnect();
  }
}

interface SurfaceRecord {
  readonly surface: string;
  readonly requests: readonly string[];
  readonly answer?: unknown;
  readonly refused?: string;
}

/** Every surface of an operations-profile handle, as the grounding walk and the operations workflow read them. */
async function surfaces(): Promise<SurfaceRecord[]> {
  const { provider, lines } = studio(READER, OPERATIONS);
  const records: SurfaceRecord[] = [];
  const step = async (surface: string, work: () => Promise<unknown>) => {
    const before = lines.length;
    try {
      const answer = await work();
      records.push({ surface, requests: lines.slice(before), answer });
    } catch (error) {
      records.push({ surface, requests: lines.slice(before), refused: (error as Error).message });
    }
  };
  await step("connect", () => provider.connect());
  await step("countObjects", () => provider.countObjects([]));
  await step("listObjects bucket", () => provider.listObjects([], "bucket"));
  await step("listObjects object", () => provider.listObjects([], "object"));
  await step("readObjectSource bucket", () => provider.readObjectSource([BUCKETS.demo], "bucket"));
  await step("readObjectSource object", () => provider.readObjectSource([`${BUCKETS.demo}/${NAMED_KEY}`], "object"));
  await step("scanKeysPage", () => provider.scanKeysPage({ cursor: "0", count: 10, pattern: "", level: true }));
  await step("query", () => provider.query(`aws s3 ls s3://${BUCKETS.demo}/`));
  await step("getHealth", () => provider.getHealth());
  await step("getOverview", () => provider.getOverview());
  await step("getStorageStats", () => provider.getStorageStats());
  await step("getTableStats", () => provider.getTableStats());
  await step("getSlowQueries", () => provider.getSlowQueries());
  await step("getActiveSessions", () => provider.getActiveSessions());
  await provider.disconnect();
  return records;
}

interface RawRecord {
  readonly call: string;
  readonly as: "reader" | "root";
  readonly status: number;
  /**
   * What of the seeded values the answer carried, by kind and never by value: a body, metadata, tag or unnamed-key
   * marker, an ETag or a version id the server gave the seed.
   */
  readonly carried?: readonly string[];
}

/** Every call the closed table refuses, sent raw: reads first, then the writes, each as the reader and as root. */
async function rawCalls(seeded: { readonly etags: string[]; readonly versionIds: string[] }): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const named = `/${BUCKETS.demo}/${encodeKey(NAMED_KEY)}`;
  const carries = (answer: RawAnswer): string[] => {
    const text = `${answer.body.toString("utf8")}${JSON.stringify(answer.headers)}`;
    return [
      ...Object.entries(MARKERS)
        .filter(([, marker]) => text.includes(marker))
        .map(([name]) => `marker ${name}`),
      ...(seeded.etags.some((etag) => text.includes(etag)) ? ["an ETag"] : []),
      ...(seeded.versionIds.some((version) => text.includes(version)) ? ["a version id"] : []),
    ];
  };
  for (const as of ["reader", "root"] as const) {
    const who = as === "reader" ? READER : ROOT;
    const reads: readonly [string, () => Promise<RawAnswer>][] = [
      ["GetObject", () => raw(who, "GET", named)],
      ["GetObject ranged bytes=0-3", () => raw(who, "GET", named, "", Buffer.alloc(0), { range: "bytes=0-3" })],
      ["HeadObject (all headers)", () => raw(who, "HEAD", named)],
      ["ListObjectsV2", () => raw(who, "GET", `/${BUCKETS.demo}`, "list-type=2")],
      ["ListObjectsV2 prefix", () => raw(who, "GET", `/${BUCKETS.demo}`, "list-type=2&prefix=agent")],
      ["ListObjectsV2 start-after", () => raw(who, "GET", `/${BUCKETS.demo}`, "list-type=2&start-after=a")],
      ["ListObjectVersions", () => raw(who, "GET", `/${BUCKETS.versions}`, "versions=")],
      ["GetObjectTagging", () => raw(who, "GET", named, "tagging=")],
      ["GetBucketPolicy", () => raw(who, "GET", `/${BUCKETS.demo}`, "policy=")],
      ["GetBucketAcl", () => raw(who, "GET", `/${BUCKETS.demo}`, "acl=")],
    ];
    for (const [call, send] of reads) {
      const answer = await send();
      records.push({ call, as, status: answer.status, carried: carries(answer) });
    }
    const writes: readonly [string, () => Promise<RawAnswer>][] = [
      ["PutObject", () => raw(who, "PUT", `/${BUCKETS.demo}/raw/put-by-${as}.txt`, "", Buffer.from("x"))],
      ["DeleteObject", () => raw(who, "DELETE", `/${BUCKETS.demo}/raw/delete-me.txt`)],
      [
        "PutObjectTagging",
        () => raw(who, "PUT", named, "tagging=", Buffer.from("<Tagging><TagSet></TagSet></Tagging>")),
      ],
      ["CreateBucket", () => raw(who, "PUT", `/agent-created-by-${as}`)],
    ];
    for (const [call, send] of writes) records.push({ call, as, status: (await send()).status });
  }
  return records;
}

async function main(): Promise<void> {
  const seeded = await seed();
  const seededSnapshot = await snapshot();

  const agent: AgentRecord[] = [];
  for (const statement of AGENT_READS) agent.push(await agentRecord("reader", statement));
  // Root reads through the same table: the closed table, not the key, is what keeps every other call off.
  for (const statement of AGENT_READS.slice(0, 2)) agent.push(await agentRecord("root", statement));
  agent.push(await agentRecord("reader", AGENT_READS[6], { ...BUDGET, maxResultRows: 2 }));
  agent.push(await agentRecord("reader", AGENT_READS[6], { ...BUDGET, maxResultRows: 5 }));
  agent.push(await agentRecord("reader", "aws s3api list-buckets", BUDGET, BUCKETS.demo));
  agent.push(await agentRecord("reader", `aws s3api head-bucket --bucket ${BUCKETS.versions}`, BUDGET, BUCKETS.demo));
  for (const statement of REFUSED_COMMANDS) {
    agent.push(await agentRecord("reader", statement));
    agent.push(await agentRecord("root", statement));
  }
  const surfaceRecords = await surfaces();
  const afterAgent = await snapshot();

  const rawRecords = await rawCalls(seeded);
  const afterRaw = await snapshot();

  // Every answer, refusal and request line, without the commands themselves: the one refused command that names the
  // endpoint writes it, and no answer may.
  const answersText = JSON.stringify({
    agent: agent.map((record) => ({ ...record, statement: undefined })),
    surfaceRecords,
  });
  const leaks = [
    ...Object.entries(MARKERS)
      .filter(([, marker]) => answersText.includes(marker))
      .map(([name]) => `marker ${name}`),
    ...seeded.etags.filter((etag) => answersText.includes(etag)).map(() => "an ETag"),
    ...seeded.versionIds.filter((version) => answersText.includes(version)).map(() => "a version id"),
    ...(answersText.includes(`${PORT}`) ? ["the endpoint's port"] : []),
  ];

  const capture = {
    server: SERVER,
    image: IMAGE,
    date: DATE,
    region: REGION,
    reader: "a key made for the run, holding the read policy beside run.sh",
    root: "the root key the server was started with, made for the run",
    seeded: {
      buckets: [BUCKETS.demo, BUCKETS.versions],
      namedKey: NAMED_KEY,
      unnamedKeys: UNNAMED_KEYS.length,
      tagged: seeded.tagged,
      markers: Object.keys(MARKERS),
      etags: seeded.etags.length,
      versionIds: seeded.versionIds.length,
    },
    snapshot: {
      seeded: seededSnapshot.objects,
      agentLeftUnchanged: afterAgent.digest === seededSnapshot.digest,
      rawCallsChangedIt: afterRaw.digest !== afterAgent.digest,
      objectsAfterRaw: afterRaw.objects,
    },
    agent,
    surfaces: surfaceRecords,
    raw: rawRecords,
    leaks,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  for (const value of CREDENTIAL_VALUES) {
    if (text.includes(value)) throw new Error("the capture holds a credential value, so it was not written");
  }
  writeFileSync(path.join(OUT, "boundary.json"), text);
  console.log(
    `${SERVER}: ${agent.length} agent records, ${surfaceRecords.length} surfaces, ${rawRecords.length} raw calls, leaks ${leaks.length}, agent left the objects unchanged: ${capture.snapshot.agentLeftUnchanged}`,
  );
  if (leaks.length > 0 || !capture.snapshot.agentLeftUnchanged) process.exitCode = 1;
}

await main();
